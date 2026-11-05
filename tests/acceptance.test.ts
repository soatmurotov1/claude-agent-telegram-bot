/**
 * TZ 22 acceptance tests (and the queue, deletion and import). They need PostgreSQL: set TEST_DATABASE_URL to a server
 * where the user may create databases, e.g. postgresql://postgres@127.0.0.1:5433/postgres. Without it they are skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ChatRequest } from "../src/ai/types.js";
import { ProviderError } from "../src/ai/types.js";
import { importJsonData } from "../src/db/importJson.js";
import { bannedPhrases } from "../src/orchestrator/validation.js";
import { type Answer, dropTestDbs, FakeEmbedder, lastUserText, makeAi, makeTestDb, TEST_DATABASE_URL } from "./fakes.js";
import { CLIENT_ID, cleanupHarnesses, makeHarness, OWNER_ID } from "./harness.js";

const OTHER_ID = 3000;
const THIRD_ID = 4000;

afterEach(() => cleanupHarnesses());
afterAll(async () => {
  if (TEST_DATABASE_URL) await dropTestDbs();
});

/** The message the analysis was asked about. */
function analysed(request: ChatRequest): string {
  const text = lastUserText(request);
  return /MESSAGE TO ANALYSE[^\n]*\n([\s\S]*?)\n\nToday is/.exec(text)?.[1] ?? "";
}

type Handlers = {
  analysis?: (message: string, request: ChatRequest) => Record<string, unknown>;
  reply?: (request: ChatRequest, attempt: number) => string;
  admin?: (request: ChatRequest) => Answer;
};

let replyCounter = 0;

function scripted(handlers: Handlers) {
  return (request: ChatRequest): Answer => {
    if (request.purpose === "analysis") {
      return JSON.stringify({ request_type: "info_question", complexity: "simple", context_completeness: "complete", confidence: 0.9, ...(handlers.analysis?.(analysed(request), request) ?? {}) });
    }
    if (request.purpose === "customer-reply") {
      const attempt = request.messages.length > 1 ? 2 : 1;
      return handlers.reply?.(request, attempt) ?? `Javob raqami ${++replyCounter}.`;
    }
    if (request.purpose === "summary") {
      return JSON.stringify({ summary: "Mijoz litsenziya bo'yicha so'radi.", analysis: { topic: "Litsenziya", outcome: "Muzokara davom etmoqda", unanswered: [] } });
    }
    if (request.purpose === "admin") return handlers.admin?.(request) ?? "Admin javobi.";
    return "ok";
  };
}

async function setup(handlers: Handlers, overrides: Record<string, string> = {}) {
  const db = await makeTestDb();
  const fakes = makeAi(scripted(handlers));
  const embedder = new FakeEmbedder();
  const h = makeHarness(overrides, { extra: { db, ai: fakes.ai, embedder } });
  const say = async (text: string, fromId = CLIENT_ID): Promise<void> => {
    await h.send(h.directMessage(text, { fromId }));
    await h.assistant.idle();
  };
  const toClient = (id = CLIENT_ID): string[] => h.api.sentTo(id).map((c) => String(c.payload.text));
  return { db, h, say, toClient, ...fakes, embedder };
}

describe.skipIf(!TEST_DATABASE_URL)("TZ 22 acceptance tests", () => {
  it("Test 1 — remembers the company name and STIR days later and does not ask for them again", async () => {
    const { db, h, say, toClient, claude } = await setup({
      analysis: (message) =>
        message.includes("123456789")
          ? { request_type: "service_interest", facts: { company_name: "Ideal Shag'al MChJ", stir: "123456789", mineral_type: "noruda" } }
          : { request_type: "info_question" },
      reply: (request, attempt) =>
        lastUserText(request).includes("litsenziya kerakmi") && attempt === 1
          ? "Aniq javob berish uchun korxonangiz STIR raqamini yuboring?"
          : `Javob ${++replyCounter}: Ideal Shag'al MChJ uchun ma'lumot berildi.`,
    });
    await say("Assalomu alaykum. Korxonamiz nomi Ideal Shag'al MChJ, STIR raqami 123456789. Qum-shag'al qazib olamiz.");
    expect((await db.profile(CLIENT_ID))?.stir).toBe("123456789");

    h.clock.advance(3 * 86400);
    await say("Bizga litsenziya kerakmi?");
    const replies = claude.of("customer-reply");
    const last = replies.at(-1)!;
    expect(last.system).toContain("STIR: 123456789");
    expect(last.system).toContain("Company name: Ideal Shag'al MChJ");
    // The first draft asked for the STIR: the self-check made the model write it again.
    expect(lastUserText(last)).toContain("which the customer already gave");
    expect(toClient().at(-1)).not.toMatch(/STIR raqamini yuboring/);
  });

  it("Test 2 — returns to an earlier topic with the old conversation in view (semantic search)", async () => {
    const { say, claude, db } = await setup(
      {
        analysis: (message) =>
          message.includes("oldingi savolimga")
            ? { request_type: "info_question", needs_history_search: true, search_query: "litsenziya muddatini uzaytirish hujjatlar" }
            : {},
      },
      { HISTORY_LIMIT: "4" },
    );
    await say("Litsenziya muddatini uzaytirish uchun qanday hujjatlar kerak bo'ladi?");
    for (const text of ["Ish vaqtingiz qanday?", "Manzilingiz qayerda?", "Saytingiz bormi?"]) await say(text);
    await say("Litsenziya bo'yicha oldingi savolimga qaytsam, uzaytirish muddati qancha?");
    const system = claude.of("customer-reply").at(-1)!.system;
    expect(system).toContain("EARLIER MESSAGES");
    expect(system).toContain("Litsenziya muddatini uzaytirish uchun qanday hujjatlar kerak");
    const paths = await db.query<{ workflow_path: string[] }>("SELECT workflow_path FROM ai_requests ORDER BY created_at DESC LIMIT 1");
    expect(paths.rows[0]?.workflow_path).toContain("investigation");
  });

  it("Test 3 — does not repeat an earlier answer without reason", async () => {
    const answer = "Investitsiya uchun 14 ta hujjat kerak, ularni shu chatga har birini alohida fayl qilib yuboring.";
    const { say, toClient, claude } = await setup({
      analysis: (message) => (message.includes("yana") ? { already_answered: true } : {}),
      reply: (_req, attempt) => (attempt === 1 ? answer : "Yuqorida aytilgan ro'yxat amal qiladi; birinchi hujjatdan boshlashingiz mumkin."),
    });
    await say("Qanday hujjatlar kerak?");
    await say("Qanday hujjatlar kerak yana bir aytib bering");
    expect(toClient()[0]).toBe(answer);
    expect(toClient()[1]).not.toBe(answer);
    const second = claude.of("customer-reply").at(-1)!;
    expect(second.system).toContain("YOUR LAST REPLIES");
    expect(second.system).toContain("already answered earlier");
    expect(lastUserText(second)).toContain("repeats an earlier reply");
  });

  it("Test 4 — Gemini continues the conversation with the full context when Claude stops", async () => {
    const { say, toClient, claude, gemini, events } = await setup({
      analysis: (message) => (message.includes("STIR") ? { facts: { company_name: "Kon Invest", stir: "987654321" } } : {}),
      reply: (request) => `Javob (${request.system.includes("987654321") ? "STIR ma'lum" : "STIR noma'lum"}) ${++replyCounter}`,
    });
    await say("Korxonamiz Kon Invest, STIR 987654321.");
    claude.failure = new ProviderError("claude", "auth", "HTTP 401 subscription token revoked");
    await say("Endi qanday davom etamiz?");
    expect(events[0]?.kind).toBe("primary_down");
    expect(gemini.of("customer-reply")).toHaveLength(1);
    expect(gemini.of("customer-reply")[0]!.system).toContain("STIR: 987654321");
    expect(toClient().at(-1)).toContain("STIR ma'lum");
    // The admins were told about the switch.
    expect(toClient(OWNER_ID).some((t) => t.includes("Gemini'ga o'tdi"))).toBe(true);
  });

  it("Test 5 — the admin's 'top chats' answer comes from the real database", async () => {
    const { say, h, toClient, claude } = await setup({
      admin: (request) => {
        const last = request.messages.at(-1)!;
        if (typeof last.content === "string") return { toolCalls: [{ name: "top_chats", input: { limit: 20, period_days: -1 } }] };
        const rows = JSON.parse(lastUserText(request)) as { customer_id: number; messages: number }[];
        return { text: rows.map((r, i) => `${i + 1}. ID ${r.customer_id} — Xabarlar: ${r.messages} ta`).join("\n") };
      },
    });
    for (let i = 0; i < 3; i++) await say(`Savol ${i}`, OTHER_ID);
    await say("Bitta savol", THIRD_ID);
    for (let i = 0; i < 2; i++) await say(`Salom ${i}`);
    await say("Eng ko'p gaplashilgan 20 ta chatni chiqar", OWNER_ID);
    const answer = toClient(OWNER_ID).at(-1)!;
    expect(answer).toBe(`1. ID ${OTHER_ID} — Xabarlar: 6 ta\n2. ID ${CLIENT_ID} — Xabarlar: 4 ta\n3. ID ${THIRD_ID} — Xabarlar: 2 ta`);
    expect(claude.of("admin")[0]!.tools?.map((t) => t.name)).toContain("top_chats");
    expect(h.generator.calls).toHaveLength(0);
  });

  it("Test 6 — details about a customer show their real messages", async () => {
    const { say, toClient } = await setup({
      admin: (request) => {
        const results = request.messages.filter((m) => typeof m.content !== "string").length;
        if (results === 0) return { toolCalls: [{ name: "find_customer", input: { query: "Aziz" } }] };
        if (results === 2) {
          const found = JSON.parse(lastUserText(request)) as { id: number }[];
          return { toolCalls: [{ name: "customer_details", input: { customer_id: found[0]!.id } }] };
        }
        const details = JSON.parse(lastUserText(request)) as { recent_messages: { ts: string; role: string; text: string }[] };
        const asked = details.recent_messages.filter((m) => m.role === "customer").at(-1)!;
        return { text: `Oxirgi savol (${asked.ts}): ${asked.text}` };
      },
    });
    await say("ZVOS loyihasini qancha muddatda tayyorlaysiz?");
    await say("Aziz haqida batafsil ma'lumot ber", OWNER_ID);
    expect(toClient(OWNER_ID).at(-1)).toMatch(/^Oxirgi savol \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\): ZVOS loyihasini qancha muddatda tayyorlaysiz\?$/);
  });

  it("Test 7 — with too little information it does not answer with a guess or an invented price", async () => {
    const { say, toClient, claude } = await setup({
      analysis: (message) =>
        message.includes("narxi")
          ? { request_type: "price_request", services: ["UTER"], confidence: 0.3 }
          : { request_type: "info_question", context_completeness: "insufficient", missing_info: ["faoliyat turi"], confidence: 0.2 },
      reply: (request) => (request.system.includes("PRICE QUESTION") ? "UTER narxi taxminan 7 000 000 so'm bo'ladi." : "Korxonangiz qanday faoliyat bilan shug'ullanadi?"),
    });
    await say("Bizga litsenziya kerakmi?");
    const first = claude.of("customer-reply")[0]!.system;
    expect(first).toContain("Confidence is LOW");
    expect(first).toContain("Ask ONE precise question");
    await say("UTER narxi qancha?");
    const sent = toClient().at(-1)!;
    expect(sent).not.toContain("7 000 000");
    expect(sent).toContain("Bu narxlar taxminiy, aniq summa geologiya bo'yicha direktorimiz bilan maslahatlashganingizdan so'ng kelishiladi");
    expect(claude.of("customer-reply").at(-1)!.system).toContain("UTER | narx: 8 000 000 so'm (1 loyiha uchun) | muddat: 10 kun");
    // The admins got a price lead.
    expect(toClient(OWNER_ID).some((t) => t.startsWith("💰 Narx so'radi"))).toBe(true);
  });

  it("Test 8 — a repeated Telegram update gets one reply, also after seen.json is lost", async () => {
    const { h, toClient, db } = await setup({});
    const update = h.directMessage("Ish vaqtingiz qanday?");
    await h.send(update);
    await h.send(structuredClone(update));
    await h.assistant.idle();
    expect(toClient()).toHaveLength(1);
    fs.rmSync(path.join(h.dataDir, "seen.json"));
    h.restart();
    await h.send(structuredClone(update));
    await h.assistant.idle();
    expect(toClient()).toHaveLength(1);
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM outgoing_replies")).rows[0]?.n)).toBe(1);
  });

  it("Test 9 — the admin says 'birinchi mijoz' and the assistant knows who is meant", async () => {
    const { say, toClient, claude } = await setup({
      admin: (request) => {
        const question = lastUserText(request);
        const last = request.messages.at(-1)!;
        if (question.includes("10 ta")) {
          if (typeof last.content === "string") return { toolCalls: [{ name: "top_chats", input: { limit: 10 } }] };
          return { text: "Ro'yxat tayyor." };
        }
        if (typeof last.content === "string") {
          const focus = /FOCUS \(from earlier in this conversation\): (.*)/.exec(request.system)?.[1] ?? "{}";
          const first = (JSON.parse(focus) as { last_list?: { items: { customer_id: number }[] } }).last_list?.items[0];
          return { toolCalls: [{ name: "customer_details", input: { customer_id: first?.customer_id ?? -1 } }] };
        }
        const details = JSON.parse(lastUserText(request)) as { profile?: { id: number } };
        return { text: `Batafsil: ID ${details.profile?.id}` };
      },
    });
    for (let i = 0; i < 3; i++) await say(`Savol ${i}`, OTHER_ID);
    await say("Salom");
    await say("Eng ko'p yozishgan 10 ta mijozni chiqar", OWNER_ID);
    await say("Birinchi mijoz haqida batafsil ma'lumot ber", OWNER_ID);
    expect(toClient(OWNER_ID).at(-1)).toBe(`Batafsil: ID ${OTHER_ID}`);
    // The earlier question is part of the context.
    expect(claude.of("admin").at(-1)!.messages.some((m) => typeof m.content === "string" && m.content.includes("10 ta mijozni"))).toBe(true);
  });

  it("Test 10 — customers never read 'a responsible employee will answer'", async () => {
    const { say, toClient } = await setup({
      reply: (_req, attempt) =>
        attempt === 1 ? "Mas'ul xodim sizga javob beradi." : "UTER tayyorlash xizmatimiz bor. Mas'ul xodim sizga javob beradi. Kontaktlar: @sanoatgeokontex_xizmat",
    });
    await say("UTER tayyorlaysizmi?");
    const sent = toClient().at(-1)!;
    expect(bannedPhrases(sent)).toEqual([]);
    expect(sent).toContain("UTER tayyorlash xizmatimiz bor.");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("reports for admins", () => {
  it("makes a PDF and an Excel report from the data and sends them to the admin only", async () => {
    const { say, h } = await setup({
      admin: (request) => {
        const question = [...request.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
        const format = String(question?.content).includes("PDF") ? "pdf" : "xlsx";
        const last = request.messages.at(-1)!;
        if (typeof last.content === "string") return { toolCalls: [{ name: "get_overview", input: { period_days: 30 } }] };
        if (lastUserText(request).includes("created")) return { text: "Hisobot tayyor." };
        const stats = JSON.parse(lastUserText(request)) as Record<string, number>;
        return {
          toolCalls: [
            {
              name: "create_report_file",
              input: {
                title: "Oxirgi 30 kunlik hisobot",
                format,
                sections: [{ heading: "Qisqacha xulosa", paragraphs: [`Mijozlar: ${stats.customers_who_wrote} ta. Oʻzbekcha va русский matn.`] }],
                tables: [{ title: "Ko'rsatkichlar", columns: ["Ko'rsatkich", "Qiymat"], rows: Object.entries(stats).map(([k, v]) => [k, String(v)]) }],
              },
            },
          ],
        };
      },
    });
    await say("Salom");
    await say("Oxirgi 30 kunlik hisobotni PDF qilib ber", OWNER_ID);
    await say("Endi Excel qilib ber", OWNER_ID);
    const docs = h.api.sentTo(OWNER_ID, "sendDocument");
    const files = docs.map((d) => d.payload.document as { filename?: string; fileData?: unknown });
    expect(docs.map((d) => String(d.payload.caption))).toEqual(["📊 Oxirgi 30 kunlik hisobot", "📊 Oxirgi 30 kunlik hisobot"]);
    expect(String(files[0]?.filename)).toMatch(/\.pdf$/);
    expect(String(files[1]?.filename)).toMatch(/\.xlsx$/);
    expect(h.api.sentTo(CLIENT_ID, "sendDocument")).toHaveLength(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("queue, deletion and import", () => {
  it("queues messages while both providers are down and answers each once when one is back", async () => {
    const { say, toClient, claude, gemini, h, db } = await setup({});
    claude.failure = new ProviderError("claude", "auth", "401");
    gemini.failure = new ProviderError("gemini", "server", "500");
    await say("Ish vaqtingiz qanday?");
    expect(toClient()).toHaveLength(0);
    expect(toClient(OWNER_ID).some((t) => t.includes("Claude ham, Gemini ham javob bermayapti"))).toBe(true);
    gemini.failure = null;
    expect(await h.assistant.processPending(h.bot.api)).toBe(1);
    await h.assistant.idle();
    expect(toClient()).toHaveLength(1);
    expect(await h.assistant.processPending(h.bot.api)).toBe(0);
    expect(toClient()).toHaveLength(1);
    expect((await db.pendingReplies()).length).toBe(0);
  });

  it("the admin's 🗑 removes the customer's rows from the database too", async () => {
    const { say, h, db } = await setup({ analysis: () => ({ facts: { stir: "111222333" } }) });
    await say("STIR 111222333");
    expect(await db.messageCount(CLIENT_ID)).toBeGreaterThan(0);
    await h.send(h.callback(`delete-yes:${CLIENT_ID}`));
    await h.assistant.idle();
    expect(await db.messageCount(CLIENT_ID)).toBe(0);
    expect(await db.profile(CLIENT_ID)).toBeNull();
  });

  it("imports the JSON files once, without duplicates, and keeps live messages unique", async () => {
    const { say, h, db } = await setup({});
    await say("Salom");
    const before = await db.messageCount(CLIENT_ID);
    const again = await importJsonData(db, h.dataDir);
    expect(again.messages).toBe(0);
    expect(await db.messageCount(CLIENT_ID)).toBe(before);
  });
});
