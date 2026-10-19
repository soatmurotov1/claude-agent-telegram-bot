import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAuthError, ClaudeLimitError, ClaudeTimeout } from "../src/claudeCli.js";
import { Outcome } from "../src/service.js";
import { pruneJsonl } from "../src/store.js";
import {
  cleanupHarnesses,
  CONNECTION_ID,
  CUSTOMER_ID,
  fileMode,
  isWindows,
  makeHarness,
  OWNER_ID,
  readJsonl,
} from "./helpers.js";

afterEach(() => cleanupHarnesses());

describe("preview mode", () => {
  it("shows the reply, sends nothing and keeps unsent replies out of history", async () => {
    const h = makeHarness();
    await h.connect();
    h.api.clear();
    h.generator.push("Ish vaqtimiz haqida ma'lumot tez orada beriladi.");

    await h.send(h.businessMessage("Salom, ish vaqtingiz qanday?"));

    expect(h.lastOutcome()).toBe(Outcome.previewed);
    expect(h.api.calls).toEqual([]);
    expect(h.previews).toHaveLength(1);
    expect(h.previews[0]).toMatchObject({
      connectionId: CONNECTION_ID,
      chatId: CUSTOMER_ID,
      incoming: "Salom, ish vaqtingiz qanday?",
      reply: "Ish vaqtimiz haqida ma'lumot tez orada beriladi.",
      escalated: false,
      language: "uz",
    });

    const file = path.join(h.dataDir, "previews.jsonl");
    const records = readJsonl(file);
    expect(records).toHaveLength(1);
    expect(records[0]?.reply).toBe("Ish vaqtimiz haqida ma'lumot tez orada beriladi.");
    if (!isWindows) expect(fileMode(file)).toBe(0o600);

    const history = h.assistant.history.get(CONNECTION_ID, CUSTOMER_ID);
    expect(history.map((item) => item.role)).toEqual(["other"]);
  });

  it("makes no Telegram call for a known connection and one cached lookup for an unknown one", async () => {
    const h = makeHarness();
    h.setConnection();

    await h.send(h.businessMessage("Assalomu alaykum"));
    await h.send(h.businessMessage("Hujjatlar qayerga topshiriladi?"));

    expect(h.api.calls.map((call) => call.method)).toEqual(["getBusinessConnection"]);
    expect(h.api.calls[0]?.payload.business_connection_id).toBe(CONNECTION_ID);
    expect(h.outcomes).toEqual([Outcome.previewed, Outcome.previewed]);
  });

  it("returns no_connection when the lookup fails", async () => {
    const h = makeHarness();
    await h.send(h.businessMessage("Salom", { connectionId: "unknown-conn" }));
    expect(h.lastOutcome()).toBe(Outcome.no_connection);
    expect(h.generator.calls).toHaveLength(0);
  });

  it("ignores foreign and disabled connections without calling Claude", async () => {
    const foreign = makeHarness();
    await foreign.connect({ user: { id: 777, is_bot: false, first_name: "Other" } });
    await foreign.send(foreign.businessMessage("Salom"));
    expect(foreign.lastOutcome()).toBe(Outcome.foreign_connection);
    expect(foreign.generator.calls).toHaveLength(0);

    const disabled = makeHarness();
    await disabled.connect({ is_enabled: false });
    await disabled.send(disabled.businessMessage("Salom"));
    expect(disabled.lastOutcome()).toBe(Outcome.connection_disabled);
    expect(disabled.generator.calls).toHaveLength(0);
  });

  it("answers any chat: there is no allowlist", async () => {
    const h = makeHarness();
    await h.connect();
    for (const chatId of [11, 987654321, 42]) {
      await h.send(h.businessMessage("Hello, what are your working hours?", { chatId, fromId: chatId }));
    }
    expect(h.outcomes).toEqual([Outcome.previewed, Outcome.previewed, Outcome.previewed]);
  });
});

describe("company account and bots", () => {
  it("records the account's own messages, never answers them, and stays quiet during takeover", async () => {
    const h = makeHarness();
    await h.connect();

    await h.send(h.businessMessage("Assalomu alaykum, hozir javob beraman.", { fromId: OWNER_ID }));
    expect(h.lastOutcome()).toBe(Outcome.owner_message);
    expect(h.generator.calls).toHaveLength(0);
    expect(h.assistant.history.get(CONNECTION_ID, CUSTOMER_ID)[0]).toMatchObject({ role: "owner" });

    await h.send(h.businessMessage("Rahmat, kutaman"));
    expect(h.lastOutcome()).toBe(Outcome.owner_active);
    expect(h.generator.calls).toHaveLength(0);

    h.clock.advance(15 * 60 + 1);
    await h.send(h.businessMessage("Javob bo'ladimi?"));
    expect(h.lastOutcome()).toBe(Outcome.previewed);
    expect(h.generator.calls[0]?.user).toContain("[Company]: Assalomu alaykum, hozir javob beraman.");
  });

  it("ignores messages sent by a business bot or by bots", async () => {
    const h = makeHarness();
    await h.connect();
    await h.send(h.businessMessage("Bot reply", { fromId: OWNER_ID, viaBusinessBot: true }));
    await h.send(h.businessMessage("I am a bot", { isBot: true }));
    expect(h.outcomes).toEqual([Outcome.ignored_bot, Outcome.ignored_bot]);
    expect(h.generator.calls).toHaveLength(0);
  });
});

describe("duplicates", () => {
  it("handles the same message once, in parallel, in sequence and after a restart", async () => {
    const h = makeHarness();
    await h.connect();
    const update = h.businessMessage("Salom", { messageId: 77 });

    await Promise.all([h.send(update), h.send(update), h.send(update)]);
    await h.send(update);
    expect(h.outcomes.filter((o) => o === Outcome.previewed)).toHaveLength(1);
    expect(h.outcomes.filter((o) => o === Outcome.duplicate)).toHaveLength(3);

    h.restart();
    await h.connect();
    await h.send(update);
    expect(h.lastOutcome()).toBe(Outcome.duplicate);
    expect(h.generator.calls).toHaveLength(1);
  });
});

describe("message types", () => {
  it("marks service messages as unsupported and describes media", async () => {
    const h = makeHarness();
    await h.connect();

    await h.send(h.businessMessage(null, { extra: { new_chat_title: "x" } }));
    expect(h.lastOutcome()).toBe(Outcome.unsupported);

    await h.send(h.businessMessage(null, { extra: { sticker: { file_id: "s", emoji: "😀" } } }));
    await h.send(h.businessMessage(null, { extra: { voice: { file_id: "v", duration: 3 } } }));
    await h.send(
      h.businessMessage(null, {
        extra: { document: { file_id: "d", file_name: "ariza.pdf" }, caption: "Arizam" },
      }),
    );
    const incoming = h.previews.map((p) => p.incoming);
    expect(incoming).toEqual(["[sticker] 😀", "[voice message]", "[document] ariza.pdf Arizam"]);
  });
});

describe("history", () => {
  it("keeps history per connection and chat", async () => {
    const h = makeHarness();
    await h.connect();
    await h.send({ update_id: 9_000_001, business_connection: h.connectionPayload({ id: "conn-2" }) });
    await h.send(h.businessMessage("Birinchi chat siri", { chatId: 1, fromId: 1 }));
    await h.send(h.businessMessage("Ikkinchi chat savoli", { chatId: 2, fromId: 2 }));
    await h.send(h.businessMessage("Boshqa connection", { chatId: 1, fromId: 1, connectionId: "conn-2" }));

    const second = h.generator.calls[1]?.user ?? "";
    expect(second).toContain("Ikkinchi chat savoli");
    expect(second).not.toContain("Birinchi chat siri");
    expect(h.assistant.history.get(CONNECTION_ID, 1)).toHaveLength(1);
    expect(h.assistant.history.get("conn-2", 1)).toHaveLength(1);
  });

  it("drops history older than HISTORY_TTL_DAYS from prompts and from disk", async () => {
    const h = makeHarness({ HISTORY_TTL_DAYS: "30" });
    await h.connect();
    await h.send(h.businessMessage("Eski maxfiy xabar"));
    h.clock.advance(31 * 86400);
    await h.send(h.businessMessage("Yangi savol"));

    const prompt = h.generator.calls[1]?.user ?? "";
    expect(prompt).toContain("Yangi savol");
    expect(prompt).not.toContain("Eski maxfiy xabar");
    expect(fs.readFileSync(path.join(h.dataDir, "history.json"), "utf8")).not.toContain("Eski maxfiy xabar");
  });

  it("prunes old preview records at startup", async () => {
    const h = makeHarness();
    await h.connect();
    await h.send(h.businessMessage("Eski preview"));
    h.clock.advance(31 * 86400);
    await h.send(h.businessMessage("Yangi preview"));
    const file = path.join(h.dataDir, "previews.jsonl");
    expect(readJsonl(file)).toHaveLength(2);

    expect(pruneJsonl(file, 30, h.clock.now)).toBe(1);
    const left = readJsonl(file);
    expect(left).toHaveLength(1);
    expect(left[0]?.incoming).toBe("Yangi preview");
  });
});

describe("language hint", () => {
  it("adds the language of the latest message and falls back to the chat's last language for emoji", async () => {
    const h = makeHarness();
    await h.connect();
    await h.send(h.businessMessage("Здравствуйте, какие документы нужны?", { chatId: 1, fromId: 1 }));
    await h.send(h.businessMessage("Hello, what are your working hours?", { chatId: 2, fromId: 2 }));
    await h.send(h.businessMessage("Ariza qayerga topshiriladi?", { chatId: 3, fromId: 3 }));
    await h.send(h.businessMessage("👍", { chatId: 1, fromId: 1 }));

    const users = h.generator.calls.map((call) => call.user);
    expect(users[0]).toContain("Their latest message is in Russian.");
    expect(users[1]).toContain("Their latest message is in English.");
    expect(users[2]).toContain("Their latest message is in Uzbek.");
    expect(users[3]).toContain("Their latest message is in Russian.");
  });
});

describe("Claude reply markers", () => {
  it("does not show [SKIP]", async () => {
    const h = makeHarness();
    await h.connect();
    h.generator.push("[SKIP]");
    await h.send(h.businessMessage("Rahmat"));
    expect(h.lastOutcome()).toBe(Outcome.skipped);
    expect(h.previews).toHaveLength(0);
  });

  it("[ESCALATE] alerts the owner once per 10 minutes and sends nothing to the chat in preview mode", async () => {
    const h = makeHarness();
    await h.connect();
    h.api.clear();
    h.generator.push(
      "[ESCALATE] Darhol 104 ga qo'ng'iroq qiling. Murojaatingiz qabul qilindi.",
      "[ESCALATE] Murojaatingiz qabul qilindi.",
    );

    await h.send(h.businessMessage("Gaz hidi kelyapti, yordam bering!"));
    await h.send(h.businessMessage("Tezroq!"));

    expect(h.outcomes).toEqual([Outcome.previewed, Outcome.previewed]);
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.chat_id).toBe(OWNER_ID);
    expect(sends[0]?.payload.business_connection_id).toBeUndefined();
    expect(String(sends[0]?.payload.text)).toContain("Gaz hidi kelyapti");
    expect(String(sends[0]?.payload.text)).toContain("darhol ko'rib chiqing");
    expect(h.previews[0]?.escalated).toBe(true);
    expect(h.previews[0]?.reply).toBe("Darhol 104 ga qo'ng'iroq qiling. Murojaatingiz qabul qilindi.");
    expect(h.previews[0]?.reply).not.toContain("[ESCALATE]");
  });
});

describe("auto-send", () => {
  it("re-checks the connection, sends with business_connection_id and stores the reply", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.connect();
    h.api.clear();
    h.generator.push("Murojaatingiz qabul qilindi.");

    await h.send(h.businessMessage("Salom, ariza qanday topshiriladi?"));

    expect(h.lastOutcome()).toBe(Outcome.sent);
    expect(h.api.calls.map((call) => call.method)).toEqual(["getBusinessConnection", "sendMessage"]);
    expect(h.api.calls[1]?.payload).toMatchObject({
      chat_id: CUSTOMER_ID,
      text: "Murojaatingiz qabul qilindi.",
      business_connection_id: CONNECTION_ID,
    });
    const history = h.assistant.history.get(CONNECTION_ID, CUSTOMER_ID);
    expect(history.map((item) => item.role)).toEqual(["other", "owner"]);
  });

  it("splits long replies into 4000-character chunks without cutting emoji", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.connect();
    h.generator.push("😀".repeat(4500));
    await h.send(h.businessMessage("Salom"));

    const texts = h.api.byMethod("sendMessage").map((call) => String(call.payload.text));
    expect(texts.map((t) => Array.from(t).length)).toEqual([4000, 500]);
    for (const text of texts) expect(text).toMatch(/^(😀)+$/u);
  });

  it("does not send without reply rights or when the connection is disabled", async () => {
    const noRights = makeHarness({ AUTO_SEND: "true" });
    await noRights.connect();
    noRights.setConnection({ rights: {}, can_reply: false });
    await noRights.send(noRights.businessMessage("Salom"));
    expect(noRights.lastOutcome()).toBe(Outcome.permission_denied);
    expect(noRights.api.byMethod("sendMessage")).toHaveLength(0);
    expect(noRights.previews[0]?.note).toContain("permission");

    const disabled = makeHarness({ AUTO_SEND: "true" });
    await disabled.connect();
    disabled.setConnection({ is_enabled: false });
    await disabled.send(disabled.businessMessage("Salom"));
    expect(disabled.lastOutcome()).toBe(Outcome.permission_denied);
    expect(disabled.api.byMethod("sendMessage")).toHaveLength(0);
  });

  it("does not send when the account wrote while the reply was generated", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.connect();
    h.generator.hook = () => h.send(h.businessMessage("Men o'zim javob beraman", { fromId: OWNER_ID }));
    await h.send(h.businessMessage("Salom"));

    expect(h.outcomes).toEqual([Outcome.owner_message, Outcome.owner_active]);
    expect(h.api.byMethod("sendMessage")).toHaveLength(0);
    expect(h.previews[0]?.note).toContain("owner_active");
  });
});

describe("owner commands", () => {
  it("/pause and /resume work only for the owner, and pause survives a restart", async () => {
    const h = makeHarness();
    await h.connect();

    await h.send(h.directMessage("/pause", { fromId: 3333 }));
    expect(h.api.byMethod("sendMessage")).toHaveLength(0);
    expect(h.assistant.state.paused).toBe(false);

    await h.send(h.directMessage("/pause"));
    expect(h.assistant.state.paused).toBe(true);
    expect(h.api.byMethod("sendMessage")).toHaveLength(1);

    h.restart();
    await h.connect();
    await h.send(h.businessMessage("Salom"));
    expect(h.lastOutcome()).toBe(Outcome.paused);

    await h.send(h.directMessage("/resume", { fromId: 3333 }));
    expect(h.assistant.state.paused).toBe(true);
    await h.send(h.directMessage("/resume"));
    expect(h.assistant.state.paused).toBe(false);
    await h.send(h.businessMessage("Salom yana"));
    expect(h.lastOutcome()).toBe(Outcome.previewed);
  });

  it("ignores other commands and plain messages from strangers", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/status", { fromId: 3333 }));
    await h.send(h.directMessage("Salom, ish vaqtingiz?", { fromId: 3333 }));
    expect(h.api.calls).toHaveLength(0);
    expect(h.generator.calls).toHaveLength(0);
  });

  it("/status answers the owner", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/status"));
    const text = String(h.api.byMethod("sendMessage")[0]?.payload.text);
    expect(text).toContain("PREVIEW (replies are only shown in the logs)");
    expect(text).toContain("History is kept for 30 days");
  });

  it("/start gives the owner an Uzbek guide reflecting mode and state", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/start"));
    const text = String(h.api.byMethod("sendMessage")[0]?.payload.text);
    expect(text).toContain("Sanoatgeokontexxizmat");
    expect(text).toContain("PREVIEW");
    expect(text).toContain("ishlayapti");
    expect(text).toContain("Chatbots");
    expect(text).toContain("/pause");
    expect(text).toContain("/resume");
    expect(text).toContain("/status");
    expect(text).toContain("AUTO_SEND=true");

    const auto = makeHarness({ AUTO_SEND: "true", COMPANY_NAME: "Test MChJ" });
    auto.assistant.pause();
    await auto.send(auto.directMessage("/start"));
    const autoText = String(auto.api.byMethod("sendMessage")[0]?.payload.text);
    expect(autoText).toContain("AUTO-SEND");
    expect(autoText).toContain("pauzada");
    expect(autoText).toContain("Test MChJ");
    expect(autoText).not.toContain("AUTO_SEND=true");
  });

  it("/start gives strangers only a short note, without company.md facts or Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/start", { fromId: 3333 }));
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.chat_id).toBe(3333);
    const text = String(sends[0]?.payload.text);
    expect(text).toContain("Sanoatgeokontexxizmat");
    expect(text).toContain("rasmiy");
    expect(text).not.toContain("+998 71 000 00 00");
    expect(text).not.toContain("/pause");
    expect(h.generator.calls).toHaveLength(0);
  });
});

describe("usage limit", () => {
  it("waits until the reset time, then continues; state survives a restart", async () => {
    const h = makeHarness();
    await h.connect();
    const resetsAt = h.clock.t + 3600;
    h.generator.push(new ClaudeLimitError("usage limit reached", resetsAt, null));

    await h.send(h.businessMessage("Salom"));
    expect(h.lastOutcome()).toBe(Outcome.limited);
    expect(h.assistant.state.limitUntil).toBe(resetsAt);

    h.restart();
    await h.connect();
    await h.send(h.businessMessage("Salom 2"));
    expect(h.lastOutcome()).toBe(Outcome.limited);
    expect(h.generator.calls).toHaveLength(1);

    h.clock.advance(3601);
    await h.send(h.businessMessage("Salom 3"));
    expect(h.lastOutcome()).toBe(Outcome.previewed);
    expect(h.api.byMethod("sendMessage")).toHaveLength(0);
  });

  it("uses LIMIT_COOLDOWN_MINUTES when the reset time is unknown", async () => {
    const h = makeHarness({ LIMIT_COOLDOWN_MINUTES: "30" });
    await h.connect();
    h.generator.push(new ClaudeLimitError("rate limit", null, null));
    await h.send(h.businessMessage("Salom"));
    expect(h.assistant.state.limitUntil).toBe(h.clock.t + 1800);

    h.clock.advance(1799);
    await h.send(h.businessMessage("Salom 2"));
    expect(h.lastOutcome()).toBe(Outcome.limited);
    h.clock.advance(2);
    await h.send(h.businessMessage("Salom 3"));
    expect(h.lastOutcome()).toBe(Outcome.previewed);
  });

  it("notifies the owner in auto-send mode and /resume clears the limit", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.connect();
    h.api.clear();
    h.generator.push(new ClaudeLimitError("usage limit reached", h.clock.t + 7200, "5pm"));
    await h.send(h.businessMessage("Salom"));
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.chat_id).toBe(OWNER_ID);
    expect(String(sends[0]?.payload.text)).toContain("limit");

    await h.send(h.directMessage("/resume"));
    expect(h.assistant.state.limitUntil).toBe(0);
    await h.send(h.businessMessage("Salom 2"));
    expect(h.lastOutcome()).toBe(Outcome.sent);
  });
});

describe("Claude failures", () => {
  it("sends nothing to the chat on timeout or auth errors and does not repeat the owner alert", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.connect();
    h.api.clear();
    h.generator.push(
      new ClaudeTimeout("Claude did not answer within 120 s"),
      new ClaudeAuthError("Claude CLI is not logged in", "Invalid API key"),
    );

    await h.send(h.businessMessage("Salom"));
    await h.send(h.businessMessage("Salom 2"));

    expect(h.outcomes.slice(-2)).toEqual([Outcome.error, Outcome.error]);
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.chat_id).toBe(OWNER_ID);
    expect(sends.some((call) => call.payload.business_connection_id !== undefined)).toBe(false);
  });

  it("does not alert the owner about errors in preview mode", async () => {
    const h = makeHarness();
    await h.connect();
    h.generator.push(new ClaudeTimeout("timeout"));
    await h.send(h.businessMessage("Salom"));
    expect(h.lastOutcome()).toBe(Outcome.error);
    expect(h.api.calls).toHaveLength(0);
  });
});
