import { afterEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { DIRECT_HISTORY_ID, Outcome } from "../src/service.js";
import { cleanupHarnesses, makeHarness, OWNER_ID } from "./helpers.js";

const PERSON = 4444;
const GROUP = -1001234567890;

afterEach(() => cleanupHarnesses());

let updateId = 700_000;
let messageId = 70_000;

function groupMessage(
  text: string,
  opts: { fromId?: number; threadId?: number; isForum?: boolean } = {},
): Update {
  const command = /^\/\w+/.exec(text);
  const message: Record<string, unknown> = {
    message_id: messageId++,
    date: 1_800_000_000,
    chat: { id: GROUP, type: "supergroup", title: "Mijozlar", is_forum: opts.isForum ?? true },
    from: { id: opts.fromId ?? OWNER_ID, is_bot: false, first_name: "Admin" },
    text,
    ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    ...(opts.threadId !== undefined ? { message_thread_id: opts.threadId, is_topic_message: true } : {}),
  };
  return { update_id: updateId++, message: message as unknown as NonNullable<Update["message"]> };
}

function toGroup(h: ReturnType<typeof makeHarness>) {
  return h.api.byMethod("sendMessage").filter((call) => call.payload.chat_id === GROUP);
}

describe("admin group with a folder per person", () => {
  it("asks to turn Topics on when the group has none", async () => {
    const h = makeHarness();
    await h.send(groupMessage("/setup", { isForum: false }));
    expect(String(toGroup(h)[0]?.payload.text)).toContain("Topics");
    expect(h.assistant.topics.groupId).toBeNull();
  });

  it("ignores /setup from anyone but the owner", async () => {
    const h = makeHarness();
    await h.send(groupMessage("/setup", { fromId: PERSON }));
    expect(h.assistant.topics.groupId).toBeNull();
    expect(h.api.calls).toHaveLength(0);
  });

  it("opens a folder for every person with the conversation so far", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    h.generator.push("Oldingi javob");
    await h.send(h.directMessage("Oldingi savol", { fromId: PERSON }));
    h.api.clear();

    await h.send(groupMessage("/setup"));
    expect(h.assistant.topics.groupId).toBe(GROUP);
    const created = h.api.byMethod("createForumTopic");
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ chat_id: GROUP, name: "User @user4444" });
    const threadId = h.assistant.topics.get(PERSON)?.threadId;
    const history = toGroup(h).find((call) => call.payload.message_thread_id === threadId);
    expect(String(history?.payload.text)).toContain("Oldingi savol");
    expect(String(history?.payload.text)).toContain("Oldingi javob");
    expect(String(toGroup(h).at(-1)?.payload.text)).toContain("1 ta mijoz jildi");
  });

  it("writes new messages into the person's folder instead of the owner's chat", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.send(groupMessage("/setup"));
    h.api.clear();

    h.generator.push("Bot javobi");
    await h.send(h.directMessage("Yangi savol", { fromId: PERSON }));
    await h.send(h.directMessage("Yana bir savol", { fromId: PERSON }));
    await h.send(h.directMessage("Boshqa odam", { fromId: 5555 }));

    expect(h.api.byMethod("createForumTopic")).toHaveLength(2);
    expect(h.api.byMethod("sendMessage").some((call) => call.payload.chat_id === OWNER_ID)).toBe(false);
    const threadId = h.assistant.topics.get(PERSON)?.threadId;
    const inFolder = toGroup(h).filter((call) => call.payload.message_thread_id === threadId);
    expect(inFolder).toHaveLength(2);
    expect(String(inFolder[0]?.payload.text)).toContain("Yangi savol");
    expect(String(inFolder[0]?.payload.text)).toContain("Bot javobi");
    expect(String(inFolder[1]?.payload.text)).toContain("Yana bir savol");
  });

  it("delivers what the admin writes in a folder to that person", async () => {
    const h = makeHarness({ AUTO_SEND: "true" });
    await h.send(groupMessage("/setup"));
    await h.send(h.directMessage("Savol", { fromId: PERSON }));
    const threadId = h.assistant.topics.get(PERSON)?.threadId;
    h.api.clear();

    await h.send(groupMessage("Assalomu alaykum, men xodimman", { threadId }));
    const copy = h.api.byMethod("copyMessage")[0];
    expect(copy?.payload).toMatchObject({ chat_id: PERSON, from_chat_id: GROUP });
    expect(h.api.byMethod("setMessageReaction")).toHaveLength(1);
    const last = h.assistant.history.get(DIRECT_HISTORY_ID, PERSON).at(-1);
    expect(last).toMatchObject({ role: "owner", text: "Assalomu alaykum, men xodimman" });

    // The bot stays quiet while the admin is talking to the person.
    await h.send(h.directMessage("Rahmat", { fromId: PERSON }));
    expect(h.lastOutcome()).toBe(Outcome.owner_active);
  });

  it("ignores messages in the General topic and in other groups", async () => {
    const h = makeHarness();
    await h.send(groupMessage("/setup"));
    h.api.clear();
    await h.send(groupMessage("Umumiy gap"));
    expect(h.api.calls).toHaveLength(0);
  });

  it("opens the folder again when the admin deleted it", async () => {
    const h = makeHarness();
    await h.send(groupMessage("/setup"));
    await h.send(h.directMessage("Birinchi", { fromId: PERSON }));
    const first = h.assistant.topics.get(PERSON)?.threadId;
    h.api.failOnce = { method: "sendMessage", description: "Bad Request: message thread not found" };
    await h.send(h.directMessage("Ikkinchi", { fromId: PERSON }));
    const second = h.assistant.topics.get(PERSON)?.threadId;
    expect(second).not.toBe(first);
    const last = toGroup(h).at(-1);
    expect(last?.payload.message_thread_id).toBe(second);
    expect(String(last?.payload.text)).toContain("Ikkinchi");
  });

  it("the users list links to the folder", async () => {
    const h = makeHarness();
    await h.send(groupMessage("/setup"));
    await h.send(h.directMessage("Salom", { fromId: PERSON }));
    const threadId = h.assistant.topics.get(PERSON)?.threadId;
    h.api.clear();
    await h.send({
      update_id: updateId++,
      callback_query: {
        id: "cb",
        chat_instance: "ci",
        from: { id: OWNER_ID, is_bot: false, first_name: "Admin" },
        data: `folder:${PERSON}`,
      },
    } as Update);
    const text = String(h.api.byMethod("sendMessage")[0]?.payload.text);
    expect(text).toContain(`https://t.me/c/1234567890/${threadId}`);
  });
});
