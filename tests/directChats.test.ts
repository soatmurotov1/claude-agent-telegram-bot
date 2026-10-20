import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeTimeout } from "../src/claudeCli.js";
import { DIRECT_HISTORY_ID, DIRECT_HOURLY_LIMIT, Outcome } from "../src/service.js";
import { OWNER_KEYBOARD, USERS_BUTTON } from "../src/handlers.js";
import { cleanupHarnesses, makeHarness, OWNER_ID } from "./helpers.js";

const PERSON = 4444;

afterEach(() => cleanupHarnesses());

function ownerCopies(h: ReturnType<typeof makeHarness>) {
  return h.api.byMethod("sendMessage").filter((call) => call.payload.chat_id === OWNER_ID);
}

/** The fake API numbers sent messages from 5000; finds the owner's copy that points to this chat. */
function relayIdFor(h: ReturnType<typeof makeHarness>, chatId: number): number | undefined {
  for (let id = 5000; id < 5100; id++) if (h.assistant.relay.get(id) === chatId) return id;
  return undefined;
}

describe("people writing to the bot directly", () => {
  it("preview mode: nothing goes to the person, the owner gets the message and the draft", async () => {
    const h = makeHarness();
    h.generator.push("Murojaatingiz qabul qilindi.");
    await h.send(h.directMessage("Salom, ish vaqtingiz qanday?", { fromId: PERSON }));

    expect(h.lastOutcome()).toBe(Outcome.previewed);
    expect(h.generator.calls).toHaveLength(1);
    expect(h.generator.calls[0]?.user).toContain("Salom, ish vaqtingiz qanday?");
    const sends = h.api.byMethod("sendMessage");
    expect(sends.map((call) => call.payload.chat_id)).toEqual([OWNER_ID]);
    const text = String(sends[0]?.payload.text);
    expect(text).toContain("Salom, ish vaqtingiz qanday?");
    expect(text).toContain("@user4444");
    expect(text).toContain("PREVIEW");
    expect(text).toContain("Murojaatingiz qabul qilindi.");
    expect(text).toContain("Reply");
  });

  it("auto-send: replies to the person without business_connection_id and copies to the owner", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    h.generator.push("Assalomu alaykum! Murojaatingiz qabul qilindi.");
    await h.send(h.directMessage("Gidrogeologik xulosa kerak", { fromId: PERSON }));

    expect(h.lastOutcome()).toBe(Outcome.sent);
    const sends = h.api.byMethod("sendMessage");
    expect(sends[0]?.payload).toMatchObject({ chat_id: PERSON, text: "Assalomu alaykum! Murojaatingiz qabul qilindi." });
    expect(sends[0]?.payload.business_connection_id).toBeUndefined();
    expect(sends[1]?.payload.chat_id).toBe(OWNER_ID);
    expect(String(sends[1]?.payload.text)).toContain("yuborildi");
    expect(h.api.byMethod("getBusinessConnection")).toHaveLength(0);
    expect(h.assistant.history.get(DIRECT_HISTORY_ID, PERSON).map((item) => item.role)).toEqual(["other", "owner"]);
  });

  it("keeps the conversation history of each person", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.send(h.directMessage("Birinchi savol", { fromId: PERSON }));
    await h.send(h.directMessage("Boshqa odam", { fromId: 5555 }));
    await h.send(h.directMessage("Ikkinchi savol", { fromId: PERSON }));
    const last = h.generator.calls[2]?.user ?? "";
    expect(last).toContain("Birinchi savol");
    expect(last).toContain("Ikkinchi savol");
    expect(last).not.toContain("Boshqa odam");
  });

  it("the owner answers by replying to the copy; the bot then stays quiet in that chat", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.send(h.directMessage("Narxi qancha?", { fromId: PERSON }));
    const relayId = relayIdFor(h, PERSON);
    expect(relayId).toBeDefined();

    h.api.clear();
    await h.send(h.directMessage("Narx 1 mln so'm", { fromId: OWNER_ID, replyTo: relayId }));
    const copies = h.api.byMethod("copyMessage");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.payload).toMatchObject({ chat_id: PERSON, from_chat_id: OWNER_ID });
    expect(String(h.api.byMethod("sendMessage")[0]?.payload.text)).toContain("yuborildi");

    h.api.clear();
    await h.send(h.directMessage("Rahmat, yana savol bor", { fromId: PERSON }));
    expect(h.lastOutcome()).toBe(Outcome.owner_active);
    expect(h.api.byMethod("sendMessage").map((call) => call.payload.chat_id)).toEqual([OWNER_ID]);
    expect(h.generator.calls.at(-1)?.user).not.toContain("Rahmat, yana savol bor");

    h.clock.advance(15 * 60 + 1);
    await h.send(h.directMessage("Yana bir savol", { fromId: PERSON }));
    expect(h.lastOutcome()).toBe(Outcome.sent);
    expect(h.generator.calls.at(-1)?.user).toContain("[Company]: Narx 1 mln so'm");
  });

  it("tells the owner how to answer when the message is not a reply, and never calls Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Salom, test", { fromId: OWNER_ID }));
    await h.send(h.directMessage("Javob", { fromId: OWNER_ID, replyTo: 999_999 }));
    expect(h.generator.calls).toHaveLength(0);
    const texts = h.api.byMethod("sendMessage").map((call) => String(call.payload.text));
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text).toContain("Reply");
  });

  it("reports when the owner's reply cannot be delivered", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Salom", { fromId: PERSON }));
    const relayId = relayIdFor(h, PERSON);
    h.api.failCopy = true;
    h.api.clear();
    await h.send(h.directMessage("Javob", { fromId: OWNER_ID, replyTo: relayId }));
    expect(String(h.api.byMethod("sendMessage")[0]?.payload.text)).toContain("yuborib bo'lmadi");
  });

  it("forwards media to the owner before the summary", async () => {
    const h = makeHarness();
    await h.send(
      h.directMessage(null, {
        fromId: PERSON,
        extra: { document: { file_id: "d", file_name: "ariza.pdf" }, caption: "Arizam" },
      }),
    );
    expect(h.api.calls.map((call) => call.method)).toEqual(["forwardMessage", "sendMessage"]);
    expect(h.api.calls[0]?.payload).toMatchObject({ chat_id: OWNER_ID, from_chat_id: PERSON });
    expect(String(h.api.calls[1]?.payload.text)).toContain("[document] ariza.pdf Arizam");
  });

  it("marks escalations in the owner's copy and sends no separate alert", async () => {
    const h = makeHarness();
    h.generator.push("[ESCALATE] Darhol 104 ga qo'ng'iroq qiling.");
    await h.send(h.directMessage("Gaz hidi kelyapti!", { fromId: PERSON }));
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    const text = String(sends[0]?.payload.text);
    expect(text).toContain("🚨");
    expect(text).toContain("Darhol 104 ga qo'ng'iroq qiling.");
    expect(text).not.toContain("[ESCALATE]");
  });

  it("does not call Claude more than the hourly limit per person, but still copies to the owner", async () => {
    const h = makeHarness();
    for (let i = 0; i <= DIRECT_HOURLY_LIMIT; i++) {
      await h.send(h.directMessage(`Savol ${i}`, { fromId: PERSON }));
    }
    expect(h.generator.calls).toHaveLength(DIRECT_HOURLY_LIMIT);
    expect(h.lastOutcome()).toBe(Outcome.throttled);
    expect(String(ownerCopies(h).at(-1)?.payload.text)).toContain("ko'p xabar");
    h.clock.advance(3601);
    await h.send(h.directMessage("Yangi soat", { fromId: PERSON }));
    expect(h.lastOutcome()).toBe(Outcome.previewed);
  });

  it("handles a duplicate update once and ignores bots, groups and service messages", async () => {
    const h = makeHarness();
    const update = h.directMessage("Salom", { fromId: PERSON, messageId: 31 });
    await Promise.all([h.send(update), h.send(update)]);
    expect(h.generator.calls).toHaveLength(1);

    await h.send(h.directMessage("I am a bot", { fromId: 6666, isBot: true }));
    await h.send(h.directMessage("Group text", { fromId: PERSON, group: true }));
    await h.send(h.directMessage(null, { fromId: PERSON, extra: { pinned_message: { message_id: 1 } } }));
    expect(h.generator.calls).toHaveLength(1);
  });

  it("respects /pause and reports Claude errors only in the owner's copy", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.send(h.directMessage("/pause"));
    h.api.clear();
    await h.send(h.directMessage("Salom", { fromId: PERSON }));
    expect(h.lastOutcome()).toBe(Outcome.paused);
    expect(h.generator.calls).toHaveLength(0);
    expect(String(ownerCopies(h)[0]?.payload.text)).toContain("pauzada");

    await h.send(h.directMessage("/resume"));
    h.api.clear();
    h.generator.push(new ClaudeTimeout("Claude did not answer within 120 s"));
    await h.send(h.directMessage("Salom yana", { fromId: PERSON }));
    expect(h.lastOutcome()).toBe(Outcome.error);
    const sends = h.api.byMethod("sendMessage");
    expect(sends.map((call) => call.payload.chat_id)).toEqual([OWNER_ID]);
    expect(String(sends[0]?.payload.text)).toContain("Javob tayyorlanmadi");
  });

  it("/start greets people without calling Claude", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/start", { fromId: PERSON }));
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.chat_id).toBe(PERSON);
    expect(String(sends[0]?.payload.text)).toContain("Savolingizni");
    expect(h.generator.calls).toHaveLength(0);
  });

  it("answers inside the topic the person wrote in", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.send(
      h.directMessage("Salom", { fromId: PERSON, extra: { is_topic_message: true, message_thread_id: 77 } }),
    );
    const toPerson = h.api.byMethod("sendMessage").find((call) => call.payload.chat_id === PERSON);
    expect(toPerson?.payload.message_thread_id).toBe(77);
  });

  it("does not answer the owner twice when Telegram also sends a service message", async () => {
    const h = makeHarness();
    await h.send(h.directMessage(null, { extra: { forum_topic_created: { name: "Salom", icon_color: 1 } } }));
    await h.send(h.directMessage("Salom"));
    expect(h.api.byMethod("sendMessage")).toHaveLength(1);
    expect(h.generator.calls).toHaveLength(0);
  });
});

describe("owner users button", () => {
  it("shows the users button to the owner only", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("/start"));
    await h.send(h.directMessage("/start", { fromId: PERSON }));
    const [owner, person] = h.api.byMethod("sendMessage");
    expect(owner?.payload.reply_markup).toEqual(OWNER_KEYBOARD);
    expect(person?.payload.reply_markup).toBeUndefined();
  });

  it("lists everyone who wrote, newest first, with message counts", async () => {
    const h = makeHarness();
    await h.send(h.directMessage(USERS_BUTTON));
    expect(String(h.api.byMethod("sendMessage")[0]?.payload.text)).toContain("hech kim yozmagan");

    await h.send(h.directMessage("Birinchi", { fromId: PERSON }));
    h.clock.advance(60);
    await h.send(h.directMessage("Ikkinchi", { fromId: PERSON }));
    h.clock.advance(60);
    await h.send(h.directMessage("Salom", { fromId: 5555 }));
    h.api.clear();

    await h.send(h.directMessage(USERS_BUTTON));
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.parse_mode).toBe("HTML");
    const text = String(sends[0]?.payload.text);
    expect(text).toContain("Mijozlar: 2 ta");
    expect(text.indexOf("ID 5555")).toBeLessThan(text.indexOf("ID 4444"));
    expect(text).toContain("@user4444");
    expect(text).toContain("2 ta xabar");
    expect(text).toContain('href="tg://user?id=4444"');
    expect(h.generator.calls).toHaveLength(3);

    await h.send(h.directMessage("/users"));
    expect(h.api.byMethod("sendMessage")).toHaveLength(2);
  });

  it("escapes names, survives a restart and forgets people after HISTORY_TTL_DAYS", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Salom", { fromId: PERSON, extra: { from: { id: PERSON, is_bot: false, first_name: "<b>Ali</b>" } } }));
    h.restart();
    h.api.clear();
    await h.send(h.directMessage(USERS_BUTTON));
    const text = String(h.api.byMethod("sendMessage")[0]?.payload.text);
    expect(text).toContain("&lt;b&gt;Ali&lt;/b&gt;");
    expect(text).not.toContain("<b>Ali</b>");

    h.clock.advance(31 * 86400);
    h.api.clear();
    await h.send(h.directMessage(USERS_BUTTON));
    expect(String(h.api.byMethod("sendMessage")[0]?.payload.text)).toContain("hech kim yozmagan");
  });

  it("is a normal question when someone else types users", async () => {
    const h = makeHarness();
    await h.send(h.directMessage(USERS_BUTTON, { fromId: PERSON }));
    expect(h.generator.calls).toHaveLength(1);
  });
});

describe("owner user folders", () => {
  function folderClick(h: ReturnType<typeof makeHarness>, userId: number, fromId = OWNER_ID) {
    return h.send({
      update_id: 900_000 + Math.floor(Math.random() * 100_000),
      callback_query: {
        id: "cb-1",
        chat_instance: "ci",
        from: { id: fromId, is_bot: false, first_name: "User" },
        data: `folder:${userId}`,
      },
    } as never);
  }

  it("puts a folder button for each user under the users list", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Salom", { fromId: PERSON }));
    h.api.clear();
    await h.send(h.directMessage(USERS_BUTTON));
    const markup = h.api.byMethod("sendMessage")[0]?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard).toEqual([[{ text: "📁 1. User", callback_data: `folder:${PERSON}` }]]);
  });

  it("opens every message of the conversation, beyond HISTORY_LIMIT", async () => {
    const h = makeHarness({ AUTO_SEND: "true", HISTORY_LIMIT: "2" });
    h.generator.push("Javob 1", "Javob 2", "Javob <3>");
    await h.send(h.directMessage("Savol 1", { fromId: PERSON }));
    await h.send(h.directMessage("Savol 2", { fromId: PERSON }));
    await h.send(h.directMessage("Savol 3", { fromId: PERSON }));
    await h.send(h.directMessage("Boshqa odam", { fromId: 5555 }));
    h.api.clear();

    await folderClick(h, PERSON);
    expect(h.api.byMethod("answerCallbackQuery")).toHaveLength(1);
    const sends = h.api.byMethod("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.chat_id).toBe(OWNER_ID);
    const text = String(sends[0]?.payload.text);
    expect(text).toContain("6 ta xabar");
    for (const part of ["Savol 1", "Javob 1", "Savol 2", "Javob 2", "Savol 3", "Javob &lt;3&gt;"]) {
      expect(text).toContain(part);
    }
    expect(text.indexOf("Savol 1")).toBeLessThan(text.indexOf("Javob 1"));
    expect(text).not.toContain("Boshqa odam");
  });

  it("sends a long conversation as a file", async () => {
    const h = makeHarness();
    const long = "x".repeat(3000);
    for (let i = 0; i < 12; i++) await h.send(h.directMessage(`${i} ${long}`, { fromId: PERSON }));
    h.api.clear();
    await folderClick(h, PERSON);
    expect(h.api.byMethod("sendDocument")).toHaveLength(1);
    expect(h.api.byMethod("sendMessage")).toHaveLength(0);
  });

  it("ignores folder buttons pressed by anyone but the owner", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Salom", { fromId: PERSON }));
    h.api.clear();
    await folderClick(h, PERSON, PERSON);
    expect(h.api.byMethod("sendMessage")).toHaveLength(0);
  });
});

describe("the bot's memory", () => {
  it("remembers earlier conversations after a restart", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    h.generator.push("Javob 1");
    await h.send(h.directMessage("Mening ismim Aziz, quduq bo'yicha", { fromId: PERSON }));
    h.restart();
    h.clock.advance(7 * 86400);
    await h.send(h.directMessage("Yana men, holat qanday?", { fromId: PERSON }));
    const user = h.generator.calls[1]?.user ?? "";
    expect(user).toContain("Mening ismim Aziz, quduq bo'yicha");
    expect(user).toContain("Javob 1");
    expect(user).toContain("Yana men, holat qanday?");
  });

  it("sends Claude the last HISTORY_LIMIT messages", async () => {
    const h = makeHarness({ HISTORY_LIMIT: "2" });
    for (const text of ["Bir", "Ikki", "Uch"]) await h.send(h.directMessage(text, { fromId: PERSON }));
    const user = h.generator.calls[2]?.user ?? "";
    expect(user).not.toContain("Bir");
    expect(user).toContain("Ikki");
    expect(user).toContain("Uch");
  });

  it("keeps the memory from history.json written before transcripts existed", async () => {
    const h = makeHarness();
    await h.send(h.directMessage("Eski savol", { fromId: PERSON }));
    fs.rmSync(path.join(h.dataDir, "transcripts.json"));
    h.restart();
    expect(h.assistant.transcripts.forChat(PERSON).map((item) => item.text)).toContain("Eski savol");
    await h.send(h.directMessage("Yangi savol", { fromId: PERSON }));
    expect(h.generator.calls[1]?.user).toContain("Eski savol");
  });

  it("joins what a person wrote to the business account and to the bot", async () => {
    const h = makeHarness();
    await h.connect();
    await h.send(h.businessMessage("Business orqali savol", { fromId: PERSON, chatId: PERSON }));
    await h.send(h.directMessage("Botga savol", { fromId: PERSON }));
    const user = h.generator.calls[1]?.user ?? "";
    expect(user).toContain("Business orqali savol");
    expect(user).toContain("Botga savol");
  });
});
