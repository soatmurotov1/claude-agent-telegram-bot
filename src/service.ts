import fs from "node:fs";
import path from "node:path";
import { GrammyError, HttpError, type Api } from "grammy";
import type { BusinessConnection, InlineKeyboardMarkup, Message } from "grammy/types";
import { ClaudeCLI, ClaudeError, ClaudeLimitError } from "./claudeCli.js";
import type { Settings } from "./config.js";
import { detectLanguage, type Language } from "./language.js";
import { buildSystemPrompt, buildUserPrompt, SKIP_TOKEN, splitEscalation } from "./prompts.js";
import {
  appendJsonl,
  type Clock,
  ensurePrivateDir,
  type HistoryItem,
  HistoryStore,
  isRecord,
  RuntimeState,
  SeenMessages,
  UserDirectory,
} from "./store.js";

export const Outcome = {
  previewed: "previewed",
  sent: "sent",
  duplicate: "duplicate",
  ignored_bot: "ignored_bot",
  no_connection: "no_connection",
  foreign_connection: "foreign_connection",
  connection_disabled: "connection_disabled",
  unsupported: "unsupported",
  owner_message: "owner_message",
  owner_active: "owner_active",
  paused: "paused",
  limited: "limited",
  skipped: "skipped",
  permission_denied: "permission_denied",
  throttled: "throttled",
  error: "error",
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export interface Preview {
  connectionId: string;
  chatId: number;
  chatName: string;
  language: Language | null;
  incoming: string;
  reply: string;
  escalated: boolean;
  note: string;
}

export interface ReplyGenerator {
  generate(system: string, user: string): Promise<string>;
}

const MAX_MESSAGE_LENGTH = 4000;
const OWNER_ALERT_INTERVAL_SECONDS = 600;
/** Messages kept per chat for the owner's user folders. */
const TRANSCRIPT_LIMIT = 5000;
/** Users per "users" list message; Telegram allows at most 100 inline buttons per message. */
const USERS_PER_PAGE = 40;
/** A user folder longer than this many Telegram messages is sent as a .txt file instead. */
export const FOLDER_MAX_MESSAGES = 10;
/** callback_data prefix of the folder buttons in the "users" list. */
export const FOLDER_CALLBACK_PREFIX = "folder:";
/** callback_data prefix of the ✍️ "reply" button under a person's conversation. */
export const REPLY_CALLBACK_PREFIX = "reply:";
/** callback_data of the button that ends reply mode. */
export const REPLY_DONE_CALLBACK = "reply-done";
/** How long the owner's reply mode stays open after the last message sent in it. */
export const REPLY_MODE_MINUTES = 15;

/** The ✍️ button that starts writing to a person. */
export function replyKeyboard(userId: number): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: "✍️ Javob yozish", callback_data: `${REPLY_CALLBACK_PREFIX}${userId}` }]] };
}

/** The button that ends reply mode. */
export const REPLY_DONE_KEYBOARD: InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: "✖️ Tugatish", callback_data: REPLY_DONE_CALLBACK }]],
};

export interface UsersListPage {
  text: string;
  buttons: { text: string; data: string }[];
}

export type UserFolder =
  | { kind: "messages"; messages: string[] }
  | { kind: "file"; caption: string; fileName: string; content: string };

export function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

export function logError(message: string): void {
  console.error(`${new Date().toISOString()} ${message}`);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function printPreview(preview: Preview): void {
  const header = preview.escalated ? "==== PREVIEW, not sent ==== [ESCALATED]" : "==== PREVIEW, not sent ====";
  const lines = [
    header,
    `Chat:     ${preview.chatName} (${preview.chatId}) via connection ${preview.connectionId}`,
    `Language: ${preview.language ?? "unknown"}`,
    `Incoming: ${preview.incoming}`,
    `Reply:    ${preview.reply}`,
  ];
  if (preview.note) lines.push(`Note:     ${preview.note}`);
  lines.push("=".repeat(header.length));
  console.log(lines.join("\n"));
}

/** Text form of a message for the conversation, or null for service messages. */
export function describe(message: Message): string | null {
  const caption = message.caption ? ` ${message.caption}` : "";
  if (message.text !== undefined) return message.text;
  if (message.voice) return "[voice message]";
  if (message.video_note) return "[video message]";
  if (message.audio) return `[audio]${caption}`;
  if (message.photo) return `[photo]${caption}`;
  if (message.animation) return `[GIF]${caption}`;
  if (message.video) return `[video]${caption}`;
  if (message.document) {
    const name = message.document.file_name ? ` ${message.document.file_name}` : "";
    return `[document]${name}${caption}`;
  }
  if (message.sticker) return `[sticker]${message.sticker.emoji ? ` ${message.sticker.emoji}` : ""}`;
  if (message.venue) return `[location] ${message.venue.title}`;
  if (message.location) return "[location]";
  if (message.contact) return "[contact]";
  if (message.poll) return `[poll] ${message.poll.question}`;
  if (message.dice) return `[dice] ${message.dice.emoji}`;
  return null;
}

/** Whether the bot may reply in this connection (Bot API 9 rights, or the older can_reply field). */
export function canReply(connection: BusinessConnection): boolean {
  if (connection.rights) return connection.rights.can_reply === true;
  const raw: unknown = connection;
  return isRecord(raw) && raw.can_reply === true;
}

/** Reads company.md fresh for every reply, without <!-- comments -->. */
export function readProfile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  } catch {
    return "";
  }
}

/** True when company.md contains at least one filled-in field or a line of free text. */
export function profileIsFilled(profile: string): boolean {
  let section = "";
  for (const raw of profile.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      section = line;
      continue;
    }
    if (section.includes("Javob berish uslubi")) continue;
    const field = /^[-*]\s*[^:]+:\s*(.*)$/.exec(line);
    if (field) {
      if (field[1]?.trim()) return true;
      continue;
    }
    return true;
  }
  return false;
}

/** Splits text into chunks of at most `size` code points, so emoji are never cut in half. */
export function splitMessage(text: string, size = MAX_MESSAGE_LENGTH): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(""));
  return chunks;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** Per-key promise-chain lock without dependencies. */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.#tails.size;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export interface AssistantOptions {
  clock?: Clock;
  previewSink?: (preview: Preview) => void;
}

/** Where a reply goes: a chat of the connected business account, or the bot's own private chat. */
type Target = { kind: "business"; connectionId: string } | { kind: "direct" };

interface ChatContext {
  target: Target;
  historyId: string;
  chatId: number;
  chatKey: string;
  chatName: string;
  incoming: string;
  language: Language | null;
  /** Topic the person wrote in, when the bot has topics (BotFather "Threaded Mode") enabled. */
  threadId?: number;
}

interface RespondResult {
  outcome: Outcome;
  reply: string;
  escalated: boolean;
  note: string;
}

export type OwnerReplyResult = "sent" | "no_target" | "failed" | "unsupported";

/** History namespace for people who write to the bot directly. */
export const DIRECT_HISTORY_ID = "direct";
/** Claude calls allowed per person per hour in direct chats (protects the subscription limit). */
export const DIRECT_HOURLY_LIMIT = 20;

export class Assistant {
  readonly history: HistoryStore;
  /** Full conversations for the owner's user folders (history only keeps the last HISTORY_LIMIT for Claude). */
  readonly transcripts: HistoryStore;
  readonly seen: SeenMessages;
  readonly state: RuntimeState;
  readonly users: UserDirectory;
  readonly outcomes: Outcome[] = [];
  readonly previewsFile: string;
  readonly #connections = new Map<string, BusinessConnection>();
  readonly #takeoverUntil = new Map<string, number>();
  readonly #locks = new KeyedMutex();
  readonly #ownerAlerts = new Map<string, number>();
  readonly #directCalls = new Map<string, number[]>();
  /** The person the owner is writing to after pressing ✍️, until `until`. */
  #replyTo: { userId: number; until: number } | null = null;
  readonly #clock: Clock;
  readonly #previewSink: (preview: Preview) => void;

  constructor(
    readonly settings: Settings,
    private readonly generator: ReplyGenerator,
    { clock = () => Date.now() / 1000, previewSink = printPreview }: AssistantOptions = {},
  ) {
    this.#clock = clock;
    this.#previewSink = previewSink;
    const dir = settings.dataDir;
    ensurePrivateDir(dir);
    this.history = new HistoryStore(
      path.join(dir, "history.json"),
      settings.historyLimit,
      settings.historyTtlDays,
      clock,
    );
    const transcriptsFile = path.join(dir, "transcripts.json");
    // First start with transcripts: begin them with the existing history so no earlier conversation is lost.
    if (!fs.existsSync(transcriptsFile) && fs.existsSync(path.join(dir, "history.json"))) {
      fs.copyFileSync(path.join(dir, "history.json"), transcriptsFile);
      fs.chmodSync(transcriptsFile, 0o600);
    }
    this.transcripts = new HistoryStore(
      transcriptsFile,
      TRANSCRIPT_LIMIT,
      settings.historyTtlDays,
      clock,
    );
    this.seen = new SeenMessages(path.join(dir, "seen.json"));
    this.state = new RuntimeState(path.join(dir, "state.json"));
    this.users = new UserDirectory(path.join(dir, "users.json"), settings.historyTtlDays, clock);
    this.previewsFile = path.join(dir, "previews.jsonl");
  }

  #record(outcome: Outcome): Outcome {
    this.outcomes.push(outcome);
    if (this.outcomes.length > 100) this.outcomes.splice(0, this.outcomes.length - 100);
    return outcome;
  }

  async onBusinessMessage(api: Api, message: Message): Promise<Outcome> {
    return this.#record(await this.#handleBusiness(api, message));
  }

  /** A person (not the owner) wrote to the bot itself in a private chat. */
  async onDirectMessage(api: Api, message: Message): Promise<Outcome> {
    return this.#record(await this.#handleDirect(api, message));
  }

  onBusinessConnection(connection: BusinessConnection): void {
    this.#connections.set(connection.id, connection);
    if (connection.user.id !== this.settings.ownerId) {
      logError(
        `WARNING: business connection ${connection.id} belongs to user ${connection.user.id}, not OWNER_ID ` +
          `${this.settings.ownerId}. Its messages will be ignored.`,
      );
      return;
    }
    log(
      `Business connection ${connection.id}: user=${connection.user.id} enabled=${connection.is_enabled ? "True" : "False"} ` +
        `can_reply=${canReply(connection) ? "True" : "False"}`,
    );
  }

  async #handleBusiness(api: Api, message: Message): Promise<Outcome> {
    // Everything up to the duplicate check must stay synchronous (no await before it).
    const connectionId = message.business_connection_id;
    if (!connectionId) return Outcome.no_connection;
    const chatId = message.chat.id;
    if (!this.seen.firstTime(`${connectionId}:${chatId}:${message.message_id}`)) return Outcome.duplicate;
    if (message.sender_business_bot || message.from?.is_bot) return Outcome.ignored_bot;

    const connection = this.#connections.get(connectionId) ?? (await this.#lookupConnection(api, connectionId));
    if (!connection) return Outcome.no_connection;
    if (connection.user.id !== this.settings.ownerId) return Outcome.foreign_connection;
    if (!connection.is_enabled) return Outcome.connection_disabled;

    const text = describe(message);
    if (text === null) return Outcome.unsupported;

    const chatKey = HistoryStore.key(connectionId, chatId);
    if (message.from?.id === this.settings.ownerId) {
      this.#remember(connectionId, chatId, {
        role: "owner",
        name: this.settings.companyName,
        text,
        lang: detectLanguage(text),
      });
      this.#startTakeover(chatKey);
      return Outcome.owner_message;
    }

    const language = detectLanguage(text) ?? this.history.lastLanguage(connectionId, chatId);
    this.#remember(connectionId, chatId, { role: "other", name: senderName(message), text, lang: language });
    this.#rememberUser(message);

    const chat: ChatContext = {
      target: { kind: "business", connectionId },
      historyId: connectionId,
      chatId,
      chatKey,
      chatName: chatTitle(message),
      incoming: text,
      language,
    };
    const result = await this.#locks.run(chatKey, () => this.#respond(api, chat));
    return result.outcome;
  }

  async #handleDirect(api: Api, message: Message): Promise<Outcome> {
    // Everything up to the duplicate check must stay synchronous (no await before it).
    const chatId = message.chat.id;
    if (message.chat.type !== "private") return Outcome.unsupported;
    if (!this.seen.firstTime(`${DIRECT_HISTORY_ID}:${chatId}:${message.message_id}`)) return Outcome.duplicate;
    if (message.from?.is_bot) return Outcome.ignored_bot;
    const text = describe(message);
    if (text === null) return Outcome.unsupported;

    const chatKey = HistoryStore.key(DIRECT_HISTORY_ID, chatId);
    const language = detectLanguage(text) ?? this.history.lastLanguage(DIRECT_HISTORY_ID, chatId);
    this.#remember(DIRECT_HISTORY_ID, chatId, { role: "other", name: senderName(message), text, lang: language });
    this.#rememberUser(message);

    const chat: ChatContext = {
      target: { kind: "direct" },
      historyId: DIRECT_HISTORY_ID,
      chatId,
      chatKey,
      chatName: chatTitle(message),
      incoming: text,
      language,
      threadId: message.is_topic_message ? message.message_thread_id : undefined,
    };
    const result = await this.#locks.run(chatKey, () => {
      if (!this.#allowDirectCall(chatKey)) {
        log(`Chat ${chat.chatName} (${chatId}): more than ${DIRECT_HOURLY_LIMIT} messages this hour, not calling Claude.`);
        return Promise.resolve<RespondResult>({ outcome: Outcome.throttled, reply: "", escalated: false, note: "" });
      }
      return this.#respond(api, chat);
    });
    // Text normally stays in the person's folder. It is passed on while the bot is quiet because the owner is
    // answering (otherwise nobody would see it); a file or photo always is, as company.md promises them.
    const ownerActive = result.outcome === Outcome.owner_active;
    if (ownerActive || message.text === undefined) await this.#passToOwner(api, message, chat, ownerActive);
    return result.outcome;
  }

  /** The owner pressed ✍️ under a person: the owner's next messages go to that person. Returns their name. */
  startReply(userId: number): string {
    this.#replyTo = { userId, until: this.#clock() + REPLY_MODE_MINUTES * 60 };
    return this.personTitle(userId);
  }

  /** Ends reply mode. Returns the name of the person it was open for, or null. */
  /**
   * Ends reply mode (also after it timed out) and lets the bot answer that person again right away.
   * Returns their name, or null when the owner was not answering anyone.
   */
  endReply(): string | null {
    const userId = this.#replyTo?.userId ?? null;
    this.#replyTo = null;
    if (userId === null) return null;
    for (const key of [...this.#takeoverUntil.keys()]) {
      if (key.endsWith(`:${userId}`)) this.#takeoverUntil.delete(key);
    }
    return this.personTitle(userId);
  }

  #replyTarget(): number | null {
    if (this.#replyTo && this.#replyTo.until <= this.#clock()) this.#replyTo = null;
    return this.#replyTo?.userId ?? null;
  }

  /**
   * A message from the owner while reply mode is open: deliver it (text, photo, file, voice...) to that person
   * and keep the bot quiet in that chat for OWNER_TAKEOVER_MINUTES.
   */
  async sendOwnerReply(api: Api, message: Message): Promise<{ result: OwnerReplyResult; to: string }> {
    const userId = this.#replyTarget();
    if (userId === null) return { result: "no_target", to: "" };
    const to = this.personTitle(userId);
    // Answer where the person last wrote: the bot's own chat or the business account.
    const via = this.transcripts.latestSource(userId) ?? DIRECT_HISTORY_ID;
    try {
      if (via === DIRECT_HISTORY_ID) {
        await api.copyMessage(userId, message.chat.id, message.message_id);
      } else {
        // The business account can only be answered with text from the bot chat.
        if (message.text === undefined) return { result: "unsupported", to };
        const reason = await this.#connectionProblem(api, via);
        if (reason) {
          logError(`Not sending the owner's reply to chat ${userId}: ${reason}.`);
          return { result: "failed", to };
        }
        for (const chunk of splitMessage(message.text)) {
          await api.sendMessage(userId, chunk, { business_connection_id: via });
        }
      }
    } catch (err) {
      logError(`Could not deliver the owner's reply to chat ${userId}: ${errorMessage(err)}`);
      return { result: "failed", to };
    }
    const text = describe(message) ?? "[message]";
    this.#remember(via, userId, { role: "owner", name: this.settings.companyName, text, lang: detectLanguage(text) });
    this.#startTakeover(HistoryStore.key(via, userId));
    this.#replyTo = { userId, until: this.#clock() + REPLY_MODE_MINUTES * 60 };
    log(`Delivered the owner's reply to chat ${userId}.`);
    return { result: "sent", to };
  }

  /** "Name @username" of someone who wrote to the bot, or their ID. */
  personTitle(userId: number): string {
    const user = this.users.list().find((known) => known.id === userId);
    if (!user) return `ID ${userId}`;
    return user.username ? `${user.name} @${user.username}` : user.name;
  }

  #startTakeover(chatKey: string): void {
    if (this.settings.ownerTakeoverMinutes > 0) {
      this.#takeoverUntil.set(chatKey, this.#clock() + this.settings.ownerTakeoverMinutes * 60);
    }
  }

  #allowDirectCall(chatKey: string): boolean {
    const now = this.#clock();
    const recent = (this.#directCalls.get(chatKey) ?? []).filter((ts) => ts > now - 3600);
    if (recent.length >= DIRECT_HOURLY_LIMIT) {
      this.#directCalls.set(chatKey, recent);
      return false;
    }
    recent.push(now);
    this.#directCalls.set(chatKey, recent);
    return true;
  }

  async #lookupConnection(api: Api, connectionId: string): Promise<BusinessConnection | null> {
    try {
      const connection = await api.getBusinessConnection(connectionId);
      this.#connections.set(connectionId, connection);
      return connection;
    } catch (err) {
      logError(`Could not look up business connection ${connectionId}: ${errorMessage(err)}`);
      return null;
    }
  }

  #blocked(chatKey: string): Outcome | null {
    const now = this.#clock();
    if (this.state.paused) return Outcome.paused;
    if (this.state.limitUntil > now) return Outcome.limited;
    const takeover = this.#takeoverUntil.get(chatKey);
    if (takeover !== undefined) {
      if (takeover > now) return Outcome.owner_active;
      this.#takeoverUntil.delete(chatKey);
    }
    return null;
  }

  async #respond(api: Api, chat: ChatContext): Promise<RespondResult> {
    const result = (outcome: Outcome, reply = "", escalated = false, note = ""): RespondResult => ({
      outcome,
      reply,
      escalated,
      note,
    });

    const blocked = this.#blocked(chat.chatKey);
    if (blocked) return result(blocked);

    const system = buildSystemPrompt(
      this.settings.companyName,
      readProfile(this.settings.profilePath),
      new Date(this.#clock() * 1000),
    );
    const user = buildUserPrompt(this.#memory(chat), chat.language);

    let raw: string;
    try {
      raw = await this.generator.generate(system, user);
    } catch (err) {
      const failure = await this.#onGenerateError(api, chat, err);
      return result(failure.outcome, "", false, failure.note);
    }

    const { escalate, text: reply } = splitEscalation(raw);
    if (!reply || reply.startsWith(SKIP_TOKEN)) {
      log(`Chat ${chat.chatName} (${chat.chatId}): no reply needed ([SKIP]).`);
      return result(Outcome.skipped, "", escalate);
    }
    if (escalate) await this.#alertEscalation(api, chat);

    const preview: Preview = {
      connectionId: chat.target.kind === "business" ? chat.target.connectionId : DIRECT_HISTORY_ID,
      chatId: chat.chatId,
      chatName: chat.chatName,
      language: chat.language,
      incoming: chat.incoming,
      reply,
      escalated: escalate,
      note: "",
    };

    if (!this.settings.autoSend) {
      this.#showPreview(preview);
      return result(Outcome.previewed, reply, escalate);
    }

    // Auto-send: the owner may have written, paused, or the limit may have hit while Claude was thinking.
    const blockedNow = this.#blocked(chat.chatKey);
    if (blockedNow) {
      const note = `not sent: ${blockedNow} (state changed while the reply was generated)`;
      this.#showPreview({ ...preview, note });
      return result(blockedNow, reply, escalate, note);
    }

    const sendOptions: { business_connection_id?: string; message_thread_id?: number } = {};
    // Answer inside the topic the person wrote in, so no new topic is opened for every reply.
    if (chat.threadId !== undefined) sendOptions.message_thread_id = chat.threadId;
    if (chat.target.kind === "business") {
      // Re-check the connection with Telegram itself right before sending, never from the cache.
      const reason = await this.#connectionProblem(api, chat.target.connectionId);
      if (reason) {
        logError(`Not sending to chat ${chat.chatId}: ${reason}.`);
        this.#showPreview({ ...preview, note: `not sent: ${reason}` });
        return result(Outcome.permission_denied, reply, escalate, `not sent: ${reason}`);
      }
      sendOptions.business_connection_id = chat.target.connectionId;
    }

    try {
      for (const chunk of splitMessage(reply)) {
        await api.sendMessage(chat.chatId, chunk, sendOptions);
      }
    } catch (err) {
      if (err instanceof GrammyError || err instanceof HttpError) {
        logError(`Sending the reply to chat ${chat.chatId} failed: ${errorMessage(err)}`);
        return result(Outcome.error, reply, escalate, `sending failed: ${errorMessage(err)}`);
      }
      throw err;
    }
    this.#remember(chat.historyId, chat.chatId, {
      role: "owner",
      name: this.settings.companyName,
      text: reply,
      lang: chat.language,
    });
    log(`Sent a reply to chat ${chat.chatName} (${chat.chatId})${escalate ? " [ESCALATED]" : ""}.`);
    return result(Outcome.sent, reply, escalate);
  }

  async #connectionProblem(api: Api, connectionId: string): Promise<string> {
    try {
      const fresh = await api.getBusinessConnection(connectionId);
      this.#connections.set(connectionId, fresh);
      if (fresh.user.id !== this.settings.ownerId) return "the connection belongs to another account";
      if (!fresh.is_enabled) return "the connection is disabled";
      if (!canReply(fresh)) return "the bot has no permission to reply in this account";
      return "";
    } catch (err) {
      return `could not re-check the connection (${errorMessage(err)})`;
    }
  }

  async #onGenerateError(api: Api, chat: ChatContext, err: unknown): Promise<{ outcome: Outcome; note: string }> {
    const alertOwner = this.settings.autoSend;
    if (err instanceof ClaudeLimitError) {
      const now = this.#clock();
      const until =
        err.resetsAt !== null && err.resetsAt > now ? err.resetsAt : now + this.settings.limitCooldownMinutes * 60;
      this.state.limitUntil = until;
      const untilText = new Date(until * 1000).toISOString();
      logError(`${err.message}. No replies will be generated until ${untilText}. CLI said: ${err.detail}`);
      if (alertOwner) {
        await this.#notifyOwner(
          api,
          "limit",
          `⚠️ Claude obunasining foydalanish limiti tugadi. Bot ${tashkentTime(until)} gacha (Toshkent vaqti) ` +
            `murojaatlarga javob bermaydi. Bu vaqtda kelgan xabarlarga o'zingiz javob bering. ` +
            `Limit oldinroq tiklansa, /resume yuboring.`,
        );
      }
      return { outcome: Outcome.limited, note: `Claude limiti ${tashkentTime(until)} gacha` };
    }
    if (err instanceof ClaudeError) {
      logError(`Claude failed for chat ${chat.chatName}: ${errorMessage(err)}`);
      if (alertOwner) {
        await this.#notifyOwner(
          api,
          "error",
          `⚠️ Bot "${chat.chatName}" chatidagi murojaatga javob tayyorlay olmadi, murojaatchiga hech narsa yuborilmadi. ` +
            `Iltimos, o'zingiz javob bering.\n\nSabab: ${truncate(err.message, 500)}`,
        );
      }
      return { outcome: Outcome.error, note: truncate(err.message, 300) };
    }
    logError(`Unexpected error while generating a reply for chat ${chat.chatName}: ${errorMessage(err)}`);
    return { outcome: Outcome.error, note: "kutilmagan xato" };
  }

  async #alertEscalation(api: Api, chat: ChatContext): Promise<void> {
    log(`Chat ${chat.chatName}: the message was escalated to the owner.`);
    await this.#notifyOwner(
      api,
      `escalate:${chat.chatKey}`,
      `🚨 Muhim murojaat: "${chat.chatName}" chati\n\nMurojaatchi xabari:\n${truncate(chat.incoming, 500)}\n\n` +
        `Iltimos, darhol ko'rib chiqing.`,
      replyKeyboard(chat.chatId),
    );
  }

  /** Sends a private message from the bot to the owner, at most once per 10 minutes per key. */
  async #notifyOwner(api: Api, key: string, text: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
    const now = this.#clock();
    const last = this.#ownerAlerts.get(key);
    if (last !== undefined && now - last < OWNER_ALERT_INTERVAL_SECONDS) return;
    this.#ownerAlerts.set(key, now);
    try {
      await api.sendMessage(this.settings.ownerId, text, keyboard ? { reply_markup: keyboard } : {});
    } catch (err) {
      logError(`Could not notify the owner: ${errorMessage(err)}`);
    }
  }

  /** Passes a message someone sent to the bot on to the owner, with a ✍️ reply button. */
  async #passToOwner(api: Api, message: Message, chat: ChatContext, ownerActive: boolean): Promise<void> {
    const who = this.personTitle(chat.chatId);
    const quiet = ownerActive ? "\n(Siz javob berayotganingiz uchun bot jim turibdi. Tugatsangiz, «✖️ Tugatish» ni bosing.)" : "";
    try {
      if (message.text !== undefined) {
        await api.sendMessage(this.settings.ownerId, `💬 ${who}:\n${truncate(message.text, 3500)}${quiet}`, {
          reply_markup: replyKeyboard(chat.chatId),
        });
        return;
      }
      await api.forwardMessage(this.settings.ownerId, chat.chatId, message.message_id);
      await api.sendMessage(this.settings.ownerId, `📎 ${who} fayl yubordi.${quiet}`, {
        reply_markup: replyKeyboard(chat.chatId),
      });
    } catch (err) {
      logError(`Could not pass the message from chat ${chat.chatId} to the owner: ${errorMessage(err)}`);
    }
  }

  #showPreview(preview: Preview): void {
    this.#previewSink(preview);
    try {
      appendJsonl(this.previewsFile, { ts: this.#clock(), ...preview });
    } catch (err) {
      logError(`Could not write ${this.previewsFile}: ${errorMessage(err)}`);
    }
  }

  /**
   * What Claude sees: the last HISTORY_LIMIT messages with this person, from earlier conversations too and from
   * both the bot's own chat and the business account.
   */
  #memory(chat: ChatContext): HistoryItem[] {
    const items = this.transcripts.forChat(chat.chatId);
    // Only if the transcripts could not be written: fall back to this chat's short history.
    if (items.length === 0) return this.history.get(chat.historyId, chat.chatId);
    return items.slice(-this.settings.historyLimit);
  }

  #remember(historyId: string, chatId: number, item: Omit<HistoryItem, "ts">): void {
    this.history.add(historyId, chatId, item);
    try {
      this.transcripts.add(historyId, chatId, item);
    } catch (err) {
      logError(`Could not update the transcripts: ${errorMessage(err)}`);
    }
  }

  #rememberUser(message: Message): void {
    const from = message.from;
    if (!from || from.id === this.settings.ownerId) return;
    try {
      this.users.touch(from.id, senderName(message), from.username ?? "");
    } catch (err) {
      logError(`Could not update the users list: ${errorMessage(err)}`);
    }
  }

  /**
   * The owner's "users" list as HTML messages, each with one 📁 folder button per user
   * (under Telegram's 4096-character and 100-button limits).
   */
  usersListMessages(): UsersListPage[] {
    const users = this.users.list();
    if (users.length === 0) {
      return [{ text: `👥 Hozircha botga hech kim yozmagan (oxirgi ${this.settings.historyTtlDays} kun).`, buttons: [] }];
    }
    const header =
      `👥 Mijozlar: ${users.length} ta (oxirgi ${this.settings.historyTtlDays} kun, yangilari tepada)\n` +
      "📁 Yozishmani ko'rish uchun mijoz tugmasini bosing.\n";
    const pages: UsersListPage[] = [];
    let current: UsersListPage = { text: header, buttons: [] };
    users.forEach((user, i) => {
      const name = `<a href="tg://user?id=${user.id}">${escapeHtml(user.name)}</a>`;
      const username = user.username ? ` @${escapeHtml(user.username)}` : "";
      const line =
        `${i + 1}. ${name}${username}\n` +
        `    ID ${user.id} · ${user.messages} ta xabar · oxirgi: ${tashkentTime(user.lastSeen)}`;
      if (current.text.length + line.length + 1 > 3800 || current.buttons.length >= USERS_PER_PAGE) {
        pages.push(current);
        current = { text: "", buttons: [] };
      }
      current.text += `\n${line}`;
      current.buttons.push({ text: truncate(`📁 ${i + 1}. ${user.name}`, 60), data: `${FOLDER_CALLBACK_PREFIX}${user.id}` });
    });
    pages.push(current);
    return pages;
  }

  /** Everything this person and the bot (or the owner) wrote to each other, for the owner's 📁 folder. */
  userFolder(userId: number): UserFolder {
    const user = this.users.list().find((known) => known.id === userId);
    const title = user ? `${user.name}${user.username ? ` @${user.username}` : ""}, ID ${userId}` : `ID ${userId}`;
    const items = this.transcripts.forChat(userId);
    if (items.length === 0) {
      return { kind: "messages", messages: [`📁 ${escapeHtml(title)}\n\nBu mijoz bilan yozishma topilmadi.`] };
    }

    const header = `📁 ${title} — ${items.length} ta xabar`;
    const entries = items.map((item) => {
      const who = item.role === "other" ? `👤 ${item.name}` : `🏢 ${this.settings.companyName}`;
      return { who: `${who} · ${tashkentTime(item.ts)}`, text: item.text };
    });

    const messages: string[] = [];
    let current = `<b>${escapeHtml(header)}</b>\n`;
    for (const entry of entries) {
      const block = `\n<b>${escapeHtml(entry.who)}</b>\n${escapeHtml(truncate(entry.text, 3000))}\n`;
      if (current.length + block.length > 3800) {
        messages.push(current);
        current = "";
      }
      current += block;
    }
    messages.push(current);
    if (messages.length <= FOLDER_MAX_MESSAGES) return { kind: "messages", messages };

    const content = [header, "", ...entries.map((entry) => `${entry.who}\n${entry.text}\n`)].join("\n");
    return {
      kind: "file",
      caption: `${header}. Yozishma uzun, shuning uchun fayl qilib yuborildi.`,
      fileName: `yozishma-${userId}.txt`,
      content,
    };
  }

  pause(): void {
    this.state.paused = true;
  }

  resume(): void {
    this.state.paused = false;
    this.state.limitUntil = 0;
    this.#takeoverUntil.clear();
  }

  modeText(): string {
    return this.settings.autoSend ? "AUTO-SEND" : "PREVIEW";
  }

  statusText(): string {
    const now = this.#clock();
    const mode = this.settings.autoSend
      ? "AUTO-SEND (replies are sent to the people who wrote)"
      : "PREVIEW (replies are only shown in the logs)";
    const limit =
      this.state.limitUntil > now
        ? `reached, replies resume at ${new Date(this.state.limitUntil * 1000).toISOString()}`
        : "not reached";
    return [
      `Company: ${this.settings.companyName}`,
      `Mode: ${mode}`,
      `State: ${this.state.paused ? "paused" : "running"}`,
      `Claude usage limit: ${limit}`,
      `Chats in history: ${this.history.chatCount()}`,
      `Data directory: ${this.settings.dataDir}`,
      `History is kept for ${this.settings.historyTtlDays} days`,
    ].join("\n");
  }

  startText(): string {
    const s = this.settings;
    const mode = s.autoSend
      ? "AUTO-SEND — javoblar murojaatchilarga avtomatik yuboriladi"
      : "PREVIEW — javoblar murojaatchilarga yuborilmaydi, faqat sizga qoralama sifatida keladi";
    const state = this.state.paused ? "pauzada (/resume bilan yoqing)" : "ishlayapti";
    const lines = [
      "Assalomu alaykum!",
      "",
      `Bu bot «${s.companyName}» korxonasining Telegram yordamchisi. Botga yozgan har bir odamga u company.md ` +
        `dagi ma'lumotlar asosida korxona nomidan rasmiy va xushmuomala javob tayyorlaydi.`,
      "",
      "Hozirgi holat:",
      `• Rejim: ${mode}`,
      `• Holat: ${state}`,
      "",
      "Siz (admin) uchun:",
      "• Mijozlarning xabarlari sizga yuborilmaydi. Faqat 🚨 muhim murojaatlar va mijoz yuborgan fayl/rasmlar keladi.",
      "• «users» tugmasi mijozlar ro'yxatini ko'rsatadi. Mijozni bossangiz, u bilan butun yozishma ochiladi.",
      "• Mijozga javob berish: yozishma ostidagi «✍️ Javob yozish» ni bosing va javobni yuboring — matn, rasm, " +
        "fayl yoki ovozli xabar bo'lishi mumkin. Tugatgach «✖️ Tugatish» ni bosing.",
      `• Siz javob bergan chatda bot ${s.ownerTakeoverMinutes} daqiqa jim turadi, shu vaqtda mijozning xabarlari ` +
        "sizga keladi. «✖️ Tugatish» ni bossangiz, bot darhol yana o'zi javob beradi.",
      "• Sinab ko'rish uchun botga boshqa akkauntdan yozing: sizning o'z xabarlaringizga bot javob bermaydi.",
      "",
      "Buyruqlar:",
      "/pause — botni to'xtatish",
      "/resume — qayta yoqish (pauza va limitni tozalaydi)",
      "/status — holat",
      "",
      "Bilib qo'ying:",
      "• Bot narx, muddat, shartnoma, ruxsatnoma, ekspertiza yoki tekshiruv natijasi bo'yicha va'da bermaydi — " +
        "murojaatni qabul qilib, mas'ul xodimga yo'naltiradi.",
      "• Favqulodda holat, shikoyat yoki rasmiy so'rovlar 🚨 belgisi bilan keladi.",
      `• Bir odamdan soatiga ${DIRECT_HOURLY_LIMIT} tadan ko'p xabarga bot javob bermaydi (obuna limitini tejash uchun).`,
      `• Suhbat tarixi ${s.historyTtlDays} kun saqlanadi, keyin o'chiriladi.`,
      "• Korxona haqidagi ma'lumotlar company.md faylida turadi.",
      "• Telegram Premium bo'lsa, botni Settings → Telegram Business → Chatbots orqali korxona akkauntiga ham ulash mumkin.",
    ];
    if (!s.autoSend) {
      lines.push(
        "• Hozir PREVIEW rejimi: javoblarni tekshirib bo'lgach, avtomatik yuborish uchun AUTO_SEND=true qiling.",
      );
    }
    return lines.join("\n");
  }
}

function senderName(message: Message): string {
  const from = message.from;
  if (from) return [from.first_name, from.last_name].filter(Boolean).join(" ") || "Person";
  return chatTitle(message);
}

function chatTitle(message: Message): string {
  const chat = message.chat;
  if (chat.type === "private") {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
    return name || (chat.username ? `@${chat.username}` : String(chat.id));
  }
  return chat.title || String(chat.id);
}

function tashkentTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

export function makeClaudeCli(settings: Settings): ClaudeCLI {
  return new ClaudeCLI(settings.claudeBin, {
    workdir: path.join(settings.dataDir, "claude-run"),
    model: settings.claudeModel || undefined,
    effort: settings.claudeEffort,
    timeoutSeconds: settings.claudeTimeoutSeconds,
    oauthToken: settings.claudeOauthToken || undefined,
    authLabel: settings.claudeAuthMode,
  });
}

export function buildAssistant(
  settings: Settings,
  opts: AssistantOptions & { generator?: ReplyGenerator } = {},
): Assistant {
  return new Assistant(settings, opts.generator ?? makeClaudeCli(settings), opts);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
