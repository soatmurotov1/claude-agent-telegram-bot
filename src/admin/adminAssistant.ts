import {
  CUSTOMER_CRITERIA,
  type CustomerCriterion,
  customerMessages,
  customersBy,
  customerStats,
  findCustomers,
  overview,
  type Period,
  periodDays,
  providerStats,
  requestTypeStats,
  searchAll,
  today,
  topChats,
  unansweredQuestions,
} from "../analytics.js";
import type { AIProviderManager } from "../ai/providerManager.js";
import type { ChatMessage, ContentPart, ToolDefinition } from "../ai/types.js";
import type { Database } from "../db/database.js";
import { priceListPrompt, type PriceList } from "../knowledge/prices.js";
import { buildReport, type ReportFormat, type ReportSpec, safeFileName } from "../reports.js";

export interface AdminFile {
  name: string;
  buffer: Buffer;
  caption: string;
}

export interface AdminAnswer {
  text: string;
  files: AdminFile[];
  provider: string | null;
}

export interface AdminAssistantOptions {
  db: Database;
  ai: AIProviderManager;
  companyName: string;
  priceList: () => PriceList | null;
  /** "5/14" and the missing documents of a client, from their folder on disk. */
  documentStatus: (customerId: number) => string | null;
  reportFontPath: string;
  now?: () => number;
  log: (message: string) => void;
}

const MAX_STEPS = 10;
const HISTORY_TURNS = 16;

/**
 * Admin AI Assistant (TZ 18): the admin writes in plain Uzbek; the AI reads the real database through read-only tools,
 * analyses the result and answers with conclusions and recommendations. The conversation and the "focus" (the last
 * list shown, the customer being discussed) are kept per admin, so "birinchi mijoz" or "shu mijoz" are understood.
 */
export class AdminAssistant {
  readonly #now: () => number;

  constructor(private readonly options: AdminAssistantOptions) {
    this.#now = options.now ?? (() => Date.now() / 1000);
  }

  async handle(adminId: number, text: string): Promise<AdminAnswer> {
    const { db, ai } = this.options;
    const history = await db.adminMessages(adminId, HISTORY_TURNS);
    // The conversation must start with the admin's turn.
    while (history[0]?.role === "assistant") history.shift();
    const focus = await db.adminFocus(adminId);
    await db.addAdminMessage(adminId, "admin", text);
    const messages: ChatMessage[] = [
      ...history.map((item) => ({ role: item.role === "admin" ? ("user" as const) : ("assistant" as const), content: item.text })),
      { role: "user", content: text },
    ];
    const files: AdminFile[] = [];
    let provider: string | null = null;
    let final = "";
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await ai.chat({
        purpose: "admin",
        tier: "main",
        maxTokens: 4000,
        system: this.#system(focus),
        messages,
        tools: TOOLS,
      });
      provider = response.provider;
      if (response.toolCalls.length === 0) {
        final = response.text;
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      const results: ContentPart[] = [];
      for (const call of response.toolCalls) {
        let output: string;
        let isError = false;
        try {
          const value = await this.#runTool(adminId, call.name, call.input, files, focus);
          output = JSON.stringify(value).slice(0, 60_000);
        } catch (err) {
          isError = true;
          output = `Error: ${err instanceof Error ? err.message : String(err)}`;
          this.options.log(`Admin tool ${call.name} failed: ${output}`);
        }
        results.push({ type: "tool_result", id: call.id, name: call.name, output, isError });
      }
      messages.push({ role: "user", content: results });
      if (step === MAX_STEPS - 1) final = response.text || "Tahlil juda ko'p qadam talab qildi. Savolni aniqroq qilib bering.";
    }
    if (!final.trim()) final = files.length > 0 ? "Hisobot tayyor." : "Javob tayyorlab bo'lmadi.";
    await db.addAdminMessage(adminId, "assistant", final);
    return { text: final, files, provider };
  }

  #system(focus: Record<string, unknown>): string {
    const now = new Date(this.#now() * 1000);
    const date = new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", dateStyle: "full", timeStyle: "short" }).format(now);
    return `You are the internal AI assistant of the administrators of «${this.options.companyName}» (subsoil-use consulting, Uzbekistan). The admins talk to you in plain Uzbek in a Telegram chat with the company's customer bot. Customers write to that bot; everything about them is in the database you reach through the tools.

Now in Tashkent: ${date}.

Rules:
1. Every number, name, date and quote about customers must come from a tool result in this conversation. Never invent data. If a tool returns nothing, say so.
2. Use the tools first, then analyse: do not stop at statistics — add conclusions (Xulosa) and practical recommendations (Tavsiyalar).
3. For complex analyses use this structure: Qisqacha xulosa; Asosiy ko'rsatkichlar; Batafsil ma'lumot; Mijozlar ro'yxati; Muammolar; AI xulosasi; Tavsiyalar.
4. Language: Uzbek, Latin script, unless the admin asks for another language ("ruscha qil" -> Russian).
5. Telegram plain text: no Markdown tables or ** markup; use numbered lists and "- " bullets. Keep it readable; very long lists can go into a file.
6. Context: the admin may refer to earlier results ("birinchi mijoz", "shu mijoz", "u oxirgi marta nimani so'ragan"). Resolve it from FOCUS and this conversation; do not ask which customer is meant when it is clear.
7. "Oxirgi marta nima so'ragan": find the exact message with customer_messages (role customer, newest first) and quote it with its date.
8. Files: when the admin asks for PDF, Excel or CSV (or a report "fayl qilib"), collect the data with the tools, then call create_report_file once with the full content. If no format is named for a report, make text in the chat plus an Excel file. Other formats: say which of pdf/xlsx/csv you can make.
9. Offers: when asked what to offer a customer, use their details and the PRICE LIST below (only its amounts, with its disclaimer) and write a ready offer text.
10. Periods: "bugun" = period_days 0 (today since 00:00 Tashkent), "7 kun" = 7, "oy" = 30, "hammasi" = all time (top_chats period_days -1).
11. You only read data. You cannot send messages to customers, delete or change anything; for replying to a customer the admin uses the ✍️ button.

FOCUS (from earlier in this conversation): ${JSON.stringify(focus)}

${priceListPrompt(this.options.priceList())}`;
  }

  #period(days: unknown): Period | null {
    const n = typeof days === "number" ? days : Number(days ?? 0);
    if (n < 0) return null;
    return n === 0 ? today(this.#now()) : periodDays(n, this.#now());
  }

  async #runTool(
    adminId: number,
    name: string,
    input: Record<string, unknown>,
    files: AdminFile[],
    focus: Record<string, unknown>,
  ): Promise<unknown> {
    const { db } = this.options;
    const remember = async (patch: Record<string, unknown>): Promise<void> => {
      Object.assign(focus, patch);
      await db.setAdminFocus(adminId, patch);
    };
    const list = async (rows: Record<string, unknown>[], label: string): Promise<void> => {
      const items = rows
        .slice(0, 50)
        .map((row, i) => ({ n: i + 1, customer_id: row.customer_id ?? row.id, name: row.company_name || row.name }))
        .filter((item) => item.customer_id !== undefined);
      if (items.length > 0) await remember({ last_list: { label, items } });
    };
    switch (name) {
      case "get_overview": {
        const period = this.#period(input.period_days) ?? periodDays(36500, this.#now());
        return { period: describePeriod(period), ...(await overview(db, period)) };
      }
      case "top_chats": {
        const rows = await topChats(db, Number(input.limit ?? 20), this.#period(input.period_days ?? -1));
        await list(rows as unknown as Record<string, unknown>[], "top_chats");
        return rows;
      }
      case "find_customer": {
        const rows = await findCustomers(db, String(input.query ?? ""));
        await list(rows as unknown as Record<string, unknown>[], "find_customer");
        return rows;
      }
      case "customer_details": {
        const id = Number(input.customer_id);
        const profile = await db.profile(id);
        if (!profile) return { error: `customer ${id} not found` };
        const [summary, stats, recent, memories] = await Promise.all([
          db.summary(id),
          customerStats(db, id),
          customerMessages(db, id, { limit: 12 }),
          db.memories(id, 20),
        ]);
        await remember({ current_customer: { customer_id: id, name: profile.companyName || profile.name } });
        return {
          profile,
          documents: this.options.documentStatus(id),
          summary: summary?.summary ?? null,
          analysis: summary?.analysis ?? null,
          stats,
          memories,
          recent_messages: recent,
        };
      }
      case "customer_messages": {
        const id = Number(input.customer_id);
        await remember({ current_customer: { customer_id: id } });
        return customerMessages(db, id, {
          limit: Number(input.limit ?? 30),
          ...(typeof input.query === "string" ? { query: input.query } : {}),
          ...(input.role === "customer" || input.role === "bot" || input.role === "admin" ? { role: input.role } : {}),
          newestFirst: input.newest_first === true,
        });
      }
      case "customers_by": {
        const criterion = String(input.criterion) as CustomerCriterion;
        if (!(CUSTOMER_CRITERIA as readonly string[]).includes(criterion)) return { error: `unknown criterion ${criterion}` };
        const rows = await customersBy(db, criterion, {
          period: input.period_days === undefined ? null : this.#period(input.period_days),
          days: Number(input.days ?? 30),
          limit: Number(input.limit ?? 30),
        });
        await list(rows, criterion);
        return rows;
      }
      case "request_stats":
        return requestTypeStats(db, this.#period(input.period_days ?? 7) ?? periodDays(36500, this.#now()));
      case "unanswered_questions":
        return unansweredQuestions(db, this.#period(input.period_days ?? 7) ?? periodDays(36500, this.#now()));
      case "search_messages":
        return searchAll(db, String(input.query ?? ""), this.#period(input.period_days ?? -1));
      case "analyze_chats": {
        const period = this.#period(input.period_days ?? 0) ?? periodDays(36500, this.#now());
        const ids = Array.isArray(input.customer_ids) && input.customer_ids.length > 0
          ? input.customer_ids.map(Number).slice(0, 25)
          : (await customersBy(db, "active", { period, limit: 25 })).map((row) => Number(row.customer_id));
        const chats = [];
        for (const id of ids) {
          const profile = await db.profile(id);
          const summary = await db.summary(id);
          const messages = (await customerMessages(db, id, { limit: 40 })).filter(
            (m) => Date.parse(`${m.ts.replace(" ", "T")}:00+05:00`) / 1000 >= period.since,
          );
          chats.push({
            customer_id: id,
            name: profile?.name,
            company: profile?.companyName,
            stage: profile?.stage,
            services: profile?.services,
            summary: summary?.summary ?? null,
            analysis: summary?.analysis ?? null,
            messages_in_period: messages.slice(-20),
          });
        }
        await list(chats as unknown as Record<string, unknown>[], "analyze_chats");
        return { period: describePeriod(period), chats };
      }
      case "provider_stats":
        return { current: this.options.ai.status(), calls: await providerStats(db, this.#period(input.period_days ?? 1) ?? periodDays(36500, this.#now())) };
      case "create_report_file": {
        const format = (["pdf", "xlsx", "csv"] as const).find((f) => f === input.format) ?? "xlsx";
        const spec = toReportSpec(input);
        const buffer = await buildReport(spec, format as ReportFormat, this.options.reportFontPath);
        const fileName = safeFileName(spec.title, format as ReportFormat, new Date(this.#now() * 1000));
        files.push({ name: fileName, buffer, caption: `📊 ${spec.title}` });
        await db.saveReport(adminId, spec.title, format, fileName);
        await db.adminAction(adminId, "report", fileName, { format });
        return { created: fileName, bytes: buffer.length, note: "The file will be sent to the admin after your answer." };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }
}

function describePeriod(period: Period): string {
  const f = (t: number): string => new Date((t + 5 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `${f(period.since)} — ${f(period.until)} (Toshkent)`;
}

function toReportSpec(input: Record<string, unknown>): ReportSpec {
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const tables = Array.isArray(input.tables) ? input.tables : [];
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return {
    title: String(input.title ?? "Hisobot").slice(0, 150),
    ...(typeof input.subtitle === "string" ? { subtitle: input.subtitle.slice(0, 300) } : {}),
    sections: sections
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s) => ({ heading: String(s.heading ?? ""), paragraphs: strings(s.paragraphs), bullets: strings(s.bullets) })),
    tables: tables
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => ({
        title: String(t.title ?? "Jadval"),
        columns: strings(t.columns),
        rows: Array.isArray(t.rows)
          ? t.rows.filter(Array.isArray).map((row: unknown[]) => row.map((cell) => (typeof cell === "number" ? cell : cell === null || cell === undefined ? null : String(cell))))
          : [],
      })),
  };
}

const periodDaysParam = {
  type: "number",
  description: "0 = today (since 00:00 Tashkent), 7 = last 7 days, 30 = last 30 days, -1 = all time",
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_overview",
    description: "Counts for a period: customers who wrote, new customers, messages (customer/bot/admin), price requests, complaints, escalations, all customers.",
    parameters: { type: "object", properties: { period_days: periodDaysParam } },
  },
  {
    name: "top_chats",
    description: "Chats with the most messages, with message counts, first/last message time, topic, outcome, next task, sales stage and services.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "how many, default 20" }, period_days: periodDaysParam },
    },
  },
  {
    name: "find_customer",
    description: "Find customers by name, @username, company name, STIR or Telegram ID.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "customer_details",
    description: "Everything about one customer: profile facts, document status (N/14), conversation summary and analysis (questions, needs, objections, answers, outcome, next task), stats, remembered facts and the latest messages.",
    parameters: { type: "object", properties: { customer_id: { type: "number" } }, required: ["customer_id"] },
  },
  {
    name: "customer_messages",
    description: "The real messages of one customer's conversation with dates (Tashkent time). Use role 'customer' and newest_first true to find what they asked last.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "number" },
        limit: { type: "number" },
        query: { type: "string", description: "only messages containing this text" },
        role: { type: "string", enum: ["customer", "bot", "admin"] },
        newest_first: { type: "boolean" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "customers_by",
    description:
      "Customers matching a criterion: price_asked (asked the price), interested (interested in services), complaint, rejected (refused), offer_sent (commercial offer / negotiation), escalated, unanswered_chat (last message is from the customer and has no answer), license_expiring (licence ends within `days`), active (most messages), documents_sent.",
    parameters: {
      type: "object",
      properties: {
        criterion: { type: "string", enum: [...CUSTOMER_CRITERIA] },
        period_days: periodDaysParam,
        days: { type: "number", description: "for license_expiring: days ahead, default 30" },
        limit: { type: "number" },
      },
      required: ["criterion"],
    },
  },
  {
    name: "request_stats",
    description: "What customers asked in a period: counts by request type, most discussed topics, services of interest and how often their price was asked.",
    parameters: { type: "object", properties: { period_days: periodDaysParam } },
  },
  {
    name: "unanswered_questions",
    description: "Questions the bot could not answer well (low confidence, missing facts, failed or queued) and questions listed as unanswered in conversation summaries.",
    parameters: { type: "object", properties: { period_days: periodDaysParam } },
  },
  {
    name: "search_messages",
    description: "Search the messages of all chats for words (e.g. 'shikoyat', 'litsenziya', a company name).",
    parameters: { type: "object", properties: { query: { type: "string" }, period_days: periodDaysParam }, required: ["query"] },
  },
  {
    name: "analyze_chats",
    description: "Material for analysing conversations: for each customer active in the period (or the given IDs) the summary, analysis and the messages of the period. Use it for 'bugungi suhbatlarni tahlil qil', sales opportunities, complaints review.",
    parameters: {
      type: "object",
      properties: { period_days: periodDaysParam, customer_ids: { type: "array", items: { type: "number" } } },
    },
  },
  {
    name: "provider_stats",
    description: "Which AI provider is active now (Claude or Gemini), whether Claude is down, and the calls per provider in the period.",
    parameters: { type: "object", properties: { period_days: periodDaysParam } },
  },
  {
    name: "create_report_file",
    description: "Creates a PDF, Excel (xlsx) or CSV report file from the content you give; it is sent to the admin. Fill sections (summary, indicators, problems, AI conclusion, recommendations) and tables (e.g. the customer list).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        format: { type: "string", enum: ["pdf", "xlsx", "csv"] },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              paragraphs: { type: "array", items: { type: "string" } },
              bullets: { type: "array", items: { type: "string" } },
            },
          },
        },
        tables: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              columns: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
            },
          },
        },
      },
      required: ["title", "format"],
    },
  },
];
