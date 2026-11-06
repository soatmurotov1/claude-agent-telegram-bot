import crypto from "node:crypto";
import { extractJson } from "../ai/json.js";
import type { AIProviderManager } from "../ai/providerManager.js";
import { AllProvidersDownError, type ChatResponse } from "../ai/types.js";
import type { Database, ProfileField } from "../db/database.js";
import { priceListPrompt, type PriceList } from "../knowledge/prices.js";
import { LANGUAGE_NAMES, type Language } from "../language.js";
import { knownFactsBlock, type MemoryManager } from "../memory.js";
import { buildSystemPrompt, buildUserPrompt } from "../prompts.js";
import type { HistoryItem } from "../store.js";
import {
  type Analysis,
  confidenceLevel,
  defaultAnalysis,
  parseAnalysis,
  requiredPermissions,
  selectWorkflow,
  type Workflow,
  workflowGuidance,
  workflowPath,
} from "./decisionTree.js";
import { removeBannedSentences, reviewReply } from "./validation.js";

export interface BrainInput {
  customerId: number;
  chatName: string;
  language: Language | null;
  /** The recent conversation, oldest first; the last item is the message being answered. */
  recent: HistoryItem[];
  incoming: string;
  incomingKey: string;
  companyName: string;
  profileText: string;
  now: Date;
}

export interface BrainResult {
  /** The reply with its markers ([ESCALATE], [SKIP], [SEND_TEMPLATE]). */
  raw: string;
  requestId: string;
  analysis: Analysis;
  workflow: Workflow;
  path: string[];
  provider: string | null;
  model: string | null;
  notes: string[];
}

/** Writes the reply to one customer message. */
export interface CustomerBrain {
  reply(input: BrainInput): Promise<BrainResult>;
}

/** Writes replies with a plain text generator (system + user prompt). Used by the offline tests. */
export interface ReplyGenerator {
  generate(system: string, user: string): Promise<string>;
}

/** The earlier behaviour: one prompt, no analysis, no long-term memory. */
export class SimpleBrain implements CustomerBrain {
  constructor(private readonly generator: ReplyGenerator) {}

  async reply(input: BrainInput): Promise<BrainResult> {
    const system = buildSystemPrompt(input.companyName, input.profileText, input.now);
    const raw = await this.generator.generate(system, buildUserPrompt(input.recent, input.language));
    const analysis = defaultAnalysis();
    return {
      raw,
      requestId: crypto.randomUUID(),
      analysis,
      workflow: "answer_from_knowledge",
      path: ["new_request", "answer_from_knowledge"],
      provider: null,
      model: null,
      notes: [],
    };
  }
}

export interface OrchestratorOptions {
  ai: AIProviderManager;
  db: Database | null;
  memory: MemoryManager | null;
  priceList: () => PriceList | null;
  log: (message: string) => void;
}

/**
 * AI Orchestrator for customer messages: analysis (fast model) -> decision tree -> long-term memory -> reply (main
 * model) -> review & self-check -> facts saved. Throws AllProvidersDownError when no provider can answer, so the
 * caller can queue the message.
 */
export class Orchestrator implements CustomerBrain {
  constructor(private readonly options: OrchestratorOptions) {}

  async reply(input: BrainInput): Promise<BrainResult> {
    const { ai, db, memory } = this.options;
    const requestId = crypto.randomUUID();
    const notes: string[] = [];
    const priceList = this.options.priceList();

    // Long-term memory first, so the analysis knows what was said before.
    const recentTexts = new Set(input.recent.map((item) => item.text.trim()));
    let context = memory ? await this.#safe(() => memory.context(input.customerId, input.incoming, { exclude: recentTexts }), null) : null;

    // Steps 2-4: the AI analyses the message.
    let analysis = defaultAnalysis();
    try {
      const response = await ai.chat({
        purpose: "analysis",
        tier: "fast",
        maxTokens: 900,
        system: ANALYSIS_SYSTEM,
        messages: [{ role: "user", content: analysisPrompt(input, context ? knownFactsBlock(context.profile) : "", context?.summary?.summary ?? "") }],
      });
      analysis = parseAnalysis(extractJson(response.text));
      if (!analysis.fromAi) notes.push("analysis was not valid JSON; defaults used");
    } catch (err) {
      if (err instanceof AllProvidersDownError) throw err;
      notes.push(`analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const workflow = selectWorkflow(analysis);
    const path = workflowPath(analysis, workflow);

    // Investigation: the answer needs older parts of the conversation -> search deeper with the AI's own query.
    if (memory && analysis.needsHistorySearch) {
      const deeper = await this.#safe(
        () => memory.context(input.customerId, analysis.searchQuery || input.incoming, { limit: 12, exclude: recentTexts }),
        null,
      );
      if (deeper) context = deeper;
    }

    // Facts the customer just stated are saved before the reply, so the reply already treats them as known.
    if (db) {
      await this.#safe(async () => {
        const facts = Object.fromEntries(
          Object.entries(analysis.facts).filter(([, v]) => typeof v === "string" && v),
        ) as Partial<Record<ProfileField, string>>;
        const changed = await db.updateProfile(input.customerId, facts, input.now.getTime() / 1000);
        if (changed.length > 0) notes.push(`profile updated: ${changed.join(", ")}`);
        if (analysis.services.length > 0) {
          await db.addServices(input.customerId, analysis.services, analysis.requestType === "price_request" ? "price_asked" : "interested");
        }
        await db.updatePipeline(input.customerId, {
          ...(analysis.stage ? { stage: analysis.stage } : {}),
          ...(analysis.objection ? { objection: analysis.objection } : {}),
          ...(analysis.requestType === "price_request" ? { priceAsked: true } : {}),
          ...(analysis.stage === "rejected" ? { rejected: true } : {}),
          ...(analysis.requestType === "complaint" ? { complaint: true } : {}),
        });
        if (analysis.objection) await db.addMemory(input.customerId, "objection", analysis.objection, null);
      }, undefined);
      if (context) context = { ...context, profile: (await this.#safe(() => db.profile(input.customerId), null)) ?? context.profile };
    }

    const previousReplies = input.recent
      .filter((item) => item.role === "owner")
      .slice(-3)
      .map((item) => item.text);
    const blocks = [
      priceListPrompt(priceList),
      knownFactsBlock(context?.profile ?? null),
      context?.summary ? `SUMMARY of the whole conversation so far:\n${context.summary.summary}` : "",
      context && context.related.length > 0
        ? `EARLIER MESSAGES of this customer related to the question (older than the conversation below):\n${context.related
            .map((r) => `- [${new Date(r.ts * 1000).toISOString().slice(0, 10)}] ${r.text.slice(0, 600)}`)
            .join("\n")}`
        : "",
      previousReplies.length > 0 ? `YOUR LAST REPLIES (do not repeat them):\n${previousReplies.map((r) => `- ${r.slice(0, 600)}`).join("\n")}` : "",
      `THIS MESSAGE: type=${analysis.requestType}; complexity=${analysis.complexity}; context=${analysis.contextCompleteness}; ` +
        `confidence=${confidenceLevel(analysis.confidence)}${analysis.topic ? `; topic=${analysis.topic}` : ""}\n` +
        workflowGuidance(analysis, workflow, context?.profile?.mineralType ?? null),
    ].filter(Boolean);
    const system = buildSystemPrompt(input.companyName, input.profileText, input.now, blocks.join("\n\n"));
    const user = buildUserPrompt(input.recent, input.language);

    // Step 5: the reply. Step 6: review; one more attempt with the reasons when it fails.
    let response = await this.#write(system, user);
    let raw = response.text;
    const known = {
      companyName: context?.profile?.companyName ?? null,
      stir: context?.profile?.stir ?? null,
      mineralType: context?.profile?.mineralType ?? null,
      location: context?.profile?.location ?? null,
    };
    let review = reviewReply({ reply: raw, previousReplies, known, priceList });
    if (!review.ok && !raw.trim().startsWith("[SKIP]")) {
      notes.push(`self-check: ${review.problems.join(", ")}; rewriting`);
      path.push("self_check:rewrite");
      response = await this.#write(system, user, raw, review.feedback);
      raw = response.text;
      review = reviewReply({ reply: raw, previousReplies, known, priceList });
      if (review.banned.length > 0) {
        raw = removeBannedSentences(raw);
        notes.push("banned sentences removed");
      }
      if (review.invented.length > 0) {
        raw = safePriceReply(input.language, priceList);
        notes.push(`invented amounts ${review.invented.join(", ")}: replaced by the safe price reply`);
      }
    } else {
      path.push("self_check:ok");
    }
    if (!raw.trim().startsWith("[SKIP]") && workflow === "price_answer") {
      const fixed = ensurePriceDisclaimer(raw, input.language, priceList);
      if (fixed !== raw) {
        raw = fixed;
        notes.push("price disclaimer and contacts added by the code");
      }
    }
    return {
      raw,
      requestId,
      analysis,
      workflow,
      path,
      provider: response.provider,
      model: response.model,
      notes,
    };
  }

  async #write(system: string, user: string, previousDraft?: string, feedback?: string): Promise<ChatResponse> {
    const messages =
      previousDraft && feedback
        ? [
            { role: "user" as const, content: user },
            { role: "assistant" as const, content: previousDraft },
            {
              role: "user" as const,
              content: `Your draft above failed the check:\n${feedback}\nWrite the corrected message now (only the message text, with the markers if needed).`,
            },
          ]
        : [{ role: "user" as const, content: user }];
    return this.options.ai.chat({ purpose: "customer-reply", tier: "main", maxTokens: 1200, system, messages });
  }

  async #safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AllProvidersDownError) throw err;
      this.options.log(`Orchestrator step failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }
}

const CONTACTS_TAIL: Record<Language, string> = {
  uz: "Obyektingiz bo'yicha hisob-kitob uchun biz bilan bog'laning: +998 99 850 24 01, +998 97 721 26 09, sanoatgeokontexxizmat@gmail.com, Telegram @sanoatgeokontex_xizmat, https://sanoatgeokontexxizmat.uz/",
  ru: "Для расчёта по Вашему объекту свяжитесь с нами: +998 99 850 24 01, +998 97 721 26 09, sanoatgeokontexxizmat@gmail.com, Telegram @sanoatgeokontex_xizmat, https://sanoatgeokontexxizmat.uz/",
  en: "For a calculation for your site, contact us: +998 99 850 24 01, +998 97 721 26 09, sanoatgeokontexxizmat@gmail.com, Telegram @sanoatgeokontex_xizmat, https://sanoatgeokontexxizmat.uz/",
} as Record<Language, string>;

const squash = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A reply that names prices must end with the agreed price-list disclaimer (word for word) and the contacts. The model
 * is asked to write them, but it sometimes shortens, rephrases or gets cut off, so the code makes sure of it: a partial or
 * reworded disclaimer is cut away and the exact text is added.
 */
export function ensurePriceDisclaimer(reply: string, language: Language | null, list: PriceList | null): string {
  if (!list) return reply;
  const lang: Language = language === "ru" || language === "en" ? language : "uz";
  const disclaimer = list.disclaimer[lang];
  if (!disclaimer) return reply;
  let body = reply.trim();
  if (!squash(body).includes(squash(disclaimer))) {
    // Cut a started or reworded copy of the disclaimer (it starts with the same heading) together with what follows.
    const heading = disclaimer.split("\n")[0]!.replace(/\s*\(.*$/, "").trim();
    const at = body.toLowerCase().indexOf(heading.toLowerCase());
    if (at >= 0) body = body.slice(0, at).trim();
    body = `${body}\n\n${disclaimer}`;
  }
  if (!body.includes("+998 99 850 24 01")) body = `${body}\n\n${CONTACTS_TAIL[lang]}`;
  return body;
}

/** The reply used when the model kept naming amounts that are not in the price list. */
export function safePriceReply(language: Language | null, list: PriceList | null): string {
  const disclaimer = list?.disclaimer[language ?? "uz"] ?? "";
  if (language === "ru") {
    return `${disclaimer} Для расчёта по Вашему объекту свяжитесь с нами: +998 99 850 24 01, +998 97 721 26 09, sanoatgeokontexxizmat@gmail.com, Telegram @sanoatgeokontex_xizmat, https://sanoatgeokontexxizmat.uz/`.trim();
  }
  if (language === "en") {
    return `${disclaimer} For a calculation for your site, contact us: +998 99 850 24 01, +998 97 721 26 09, sanoatgeokontexxizmat@gmail.com, Telegram @sanoatgeokontex_xizmat, https://sanoatgeokontexxizmat.uz/`.trim();
  }
  return `${disclaimer} Obyektingiz bo'yicha hisob-kitob uchun biz bilan bog'laning: +998 99 850 24 01, +998 97 721 26 09, sanoatgeokontexxizmat@gmail.com, Telegram @sanoatgeokontex_xizmat, https://sanoatgeokontexxizmat.uz/`.trim();
}

const ANALYSIS_SYSTEM = `You analyse one incoming Telegram message to a subsoil-use consulting company (SANOATGEOKONTEXXIZMAT, Uzbekistan) before the reply is written. You do not write the reply.
Answer with JSON only, no other text:
{"request_type": one of greeting|thanks_or_ack|info_question|service_interest|price_request|document_question|document_submission|status_request|complaint|emergency|official_request|partnership|off_topic|unclear,
 "complexity": simple|medium|complex,
 "context_completeness": complete|partial|insufficient   (are there enough facts to answer correctly?),
 "missing_info": ["facts that are really needed and not known yet"],
 "confidence": 0..1   (how sure an answer from the company profile, price list and known facts can be correct),
 "needs_history_search": true|false   (the message refers to something said earlier that is not in the recent messages),
 "search_query": "what to look for in the older conversation",
 "already_answered": true|false   (the same question was already answered in the conversation shown),
 "facts": {"company_name","stir" (9 digits),"phone","email","activity","location","mineral_type" ("ruda" for metal ores, "noruda" for sand/gravel/stone/clay and other construction materials),"mineral","license_number","license_expiry" (YYYY-MM-DD),"preferences","decisions","next_contact_date" (YYYY-MM-DD)}   (ONLY facts the customer states in THIS message; omit the others),
 "services": ["services the customer is interested in or asks the price of, short names"],
 "stage": new|interested|price_asked|documents_in_progress|documents_sent|negotiation|rejected|closed|null,
 "objection": "the customer's objection or refusal, or null",
 "topic": "the topic in 2-5 words"}`;

function analysisPrompt(input: BrainInput, knownFacts: string, summary: string): string {
  const recent = input.recent
    .slice(-10)
    .map((item) => `${item.role === "owner" ? "[Company]" : "[Customer]"}: ${item.text.slice(0, 800)}`)
    .join("\n");
  return [
    knownFacts,
    summary ? `SUMMARY:\n${summary}` : "",
    `RECENT MESSAGES:\n${recent}`,
    `MESSAGE TO ANALYSE${input.language ? ` (${LANGUAGE_NAMES[input.language]})` : ""}:\n${input.incoming.slice(0, 3000)}`,
    `Today is ${input.now.toISOString().slice(0, 10)}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export { requiredPermissions };
