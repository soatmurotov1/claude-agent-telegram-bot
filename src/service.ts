import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GrammyError, HttpError, InputFile, type Api } from "grammy";
import type { BusinessConnection, InlineKeyboardMarkup, Message, ReplyKeyboardMarkup } from "grammy/types";
import { ClaudeCLI, ClaudeError, ClaudeLimitError } from "./claudeCli.js";
import { type AcceptedFile, ClientFolders, type Progress, progress, progressText } from "./clientFolder.js";
import type { Settings } from "./config.js";
import {
  type FileVerdict,
  Inbox,
  type InboxFile,
  readLaws,
  type ReviewChat,
  type ReviewGenerator,
  reviewFile,
} from "./documentReview.js";
import { detectLanguage, type Language } from "./language.js";
import { BOT_API_DOWNLOAD_LIMIT, MtprotoDownloader } from "./largeFiles.js";
import { buildSystemPrompt, buildUserPrompt, SKIP_TOKEN, splitEscalation, splitTemplate } from "./prompts.js";
import { blankFor, loadTemplate, type Template, type TemplateDoc, type TemplatePart } from "./templates.js";
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
  review_queued: "review_queued",
  status_shown: "status_shown",
  template_sent: "template_sent",
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

/** Writes replies; `review` (Claude with read access to one folder) is needed only for PDF and image checks. */
export type ReplyGenerator = ReviewGenerator;

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
/** callback_data prefixes of the buttons under a client's folder. */
export const CHAT_TXT_CALLBACK_PREFIX = "chattxt:";
export const FILES_CALLBACK_PREFIX = "files:";
export const DELETE_CALLBACK_PREFIX = "delete:";
export const DELETE_CONFIRM_CALLBACK_PREFIX = "delete-yes:";
export const DELETE_CANCEL_CALLBACK = "delete-no";
/** Files a client sends are reviewed this long after the last one arrives, as one batch. */
export const REVIEW_BATCH_SECONDS = 15;

/** Texts of the client's keyboard buttons in the bot's own chat. */
export const CLIENT_STATUS_BUTTON = "📊 Hujjatlar holati";
export const CLIENT_TEMPLATE_BUTTON = "📄 Anketa shabloni";

/** Persistent keyboard for clients in the bot's own chat. */
export const CLIENT_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: CLIENT_STATUS_BUTTON }, { text: CLIENT_TEMPLATE_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

const STATUS_WORDS = new Set([
  "hujjatlar holati", "holat", "holati", "status", "статус", "статус документов", "ҳужжатлар ҳолати", "ҳолат",
  "document status",
]);
const TEMPLATE_WORDS = new Set([
  "anketa shabloni", "anketa", "shablon", "анкета", "шаблон", "анкета шаблони", "шаблон анкеты", "questionnaire",
  "template",
]);

/** A client's short request that is answered without Claude: their document status or the blank form. */
export function quickRequest(text: string): "status" | "template" | null {
  const normalized = text
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/[.!?,:;]+/g, "")
    .trim();
  if (STATUS_WORDS.has(normalized)) return "status";
  if (TEMPLATE_WORDS.has(normalized)) return "template";
  return null;
}

/** Buttons under a client's folder for the owner. */
export function folderKeyboard(userId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "✍️ Javob yozish", callback_data: `${REPLY_CALLBACK_PREFIX}${userId}` }],
      [
        { text: "📄 chat.txt", callback_data: `${CHAT_TXT_CALLBACK_PREFIX}${userId}` },
        { text: "📎 Qabul qilingan fayllar", callback_data: `${FILES_CALLBACK_PREFIX}${userId}` },
      ],
      [{ text: "🗑 Chatni o'chirish", callback_data: `${DELETE_CALLBACK_PREFIX}${userId}` }],
    ],
  };
}

/** The confirmation asked before a client's chat is deleted. */
export function deleteConfirmKeyboard(userId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🗑 Ha, o'chirilsin", callback_data: `${DELETE_CONFIRM_CALLBACK_PREFIX}${userId}` },
        { text: "Bekor qilish", callback_data: DELETE_CANCEL_CALLBACK },
      ],
    ],
  };
}

/** Downloads a Telegram file to `target`. Replaced in tests. */
export type FileDownloader = (api: Api, fileId: string, target: string) => Promise<void>;
/** Downloads a file over 20 MB to `target`. */
export type LargeFileDownloader = (fileId: string, target: string, size?: number) => Promise<void>;

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
  downloadFile?: FileDownloader;
  /** Downloads files over 20 MB (MTProto); null turns large files off. Built from TELEGRAM_API_ID/HASH by default. */
  downloadLargeFile?: LargeFileDownloader | null;
  /** Wait after the last file before a batch is reviewed (default REVIEW_BATCH_SECONDS). */
  reviewDelayMs?: number;
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
  /** data/clients/<id>/: chat.txt, accepted and rejected files, document status. */
  readonly folders: ClientFolders;
  /** Client files waiting for review. */
  readonly inbox: Inbox;
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
  readonly #downloadFile: FileDownloader;
  readonly #downloadLargeFile: LargeFileDownloader | null;
  /** Set when TELEGRAM_API_ID/HASH are configured, for the startup check. */
  readonly mtproto: MtprotoDownloader | null = null;
  readonly #reviewDelayMs: number;
  readonly #reviewTimers = new Map<number, NodeJS.Timeout>();
  /** Batches running now, so tests and /resume can wait for them. */
  readonly #reviewRuns = new Map<number, Promise<void>>();
  /** Times of document-check Claude calls in the last 24 hours (REVIEW_DAILY_LIMIT). */
  #reviewCalls: number[] = [];
  /** The API of the latest update, for batches that start later from a timer. */
  #api: Api | null = null;

  constructor(
    readonly settings: Settings,
    private readonly generator: ReplyGenerator,
    { clock = () => Date.now() / 1000, previewSink = printPreview, downloadFile, downloadLargeFile, reviewDelayMs }: AssistantOptions = {},
  ) {
    this.#clock = clock;
    this.#previewSink = previewSink;
    this.#downloadFile = downloadFile ?? ((api, fileId, target) => telegramDownload(api, settings.botToken, fileId, target));
    if (downloadLargeFile !== undefined) {
      this.#downloadLargeFile = downloadLargeFile;
    } else if (settings.telegramApiId && settings.telegramApiHash && settings.botToken) {
      const mtproto = new MtprotoDownloader({
        apiId: settings.telegramApiId,
        apiHash: settings.telegramApiHash,
        botToken: settings.botToken,
        sessionFile: path.join(settings.dataDir, "mtproto.session"),
      });
      this.mtproto = mtproto;
      this.#downloadLargeFile = (fileId, target, size) => mtproto.download(fileId, target, size);
    } else {
      this.#downloadLargeFile = null;
    }
    this.#reviewDelayMs = reviewDelayMs ?? REVIEW_BATCH_SECONDS * 1000;
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
    this.folders = new ClientFolders(path.join(dir, "clients"), clock);
    this.inbox = new Inbox(this.folders);
    this.previewsFile = path.join(dir, "previews.jsonl");
  }

  #record(outcome: Outcome): Outcome {
    this.outcomes.push(outcome);
    if (this.outcomes.length > 100) this.outcomes.splice(0, this.outcomes.length - 100);
    return outcome;
  }

  async onBusinessMessage(api: Api, message: Message): Promise<Outcome> {
    this.#api = api;
    return this.#record(await this.#handleBusiness(api, message));
  }

  /** A person (not the owner) wrote to the bot itself in a private chat. */
  async onDirectMessage(api: Api, message: Message): Promise<Outcome> {
    this.#api = api;
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

    const language = languageOf(message) ?? this.history.lastLanguage(connectionId, chatId);
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
    const handled = await this.#handleFileOrQuick(api, message, chat);
    if (handled) return handled;
    const result = await this.#locks.run(chatKey, () => this.#respond(api, chat));
    return result.outcome;
  }

  /**
   * Files and photos go to the review queue (the batch summary is the answer), and "status" / "anketa" requests
   * are answered without Claude. Returns null for everything else.
   */
  async #handleFileOrQuick(api: Api, message: Message, chat: ChatContext): Promise<Outcome | null> {
    if (fileOf(message)) {
      await this.#queueFile(api, message, chat);
      return Outcome.review_queued;
    }
    const quick = message.text !== undefined ? quickRequest(message.text) : null;
    if (quick === null) return null;
    const blocked = this.#blocked(chat.chatKey);
    if (blocked === Outcome.owner_active || blocked === Outcome.paused) return null;
    if (quick === "status") {
      await this.#deliver(api, chat, this.clientProgressText(chat.chatId, chat.language));
      return Outcome.status_shown;
    }
    await this.#sendTemplate(api, chat);
    return Outcome.template_sent;
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
    const language = languageOf(message) ?? this.history.lastLanguage(DIRECT_HISTORY_ID, chatId);
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
    const handled = await this.#handleFileOrQuick(api, message, chat);
    if (handled) return handled;
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

    const { escalate, text: withMarkers } = splitEscalation(raw);
    const { sendTemplate, text: reply } = splitTemplate(withMarkers);
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
      note: sendTemplate ? "the blank questionnaire is sent after this reply" : "",
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
    if (sendTemplate) await this.#sendTemplate(api, chat, false);
    return result(Outcome.sent, reply, escalate);
  }

  /** Telegram send options for a chat: business connection and topic. */
  #sendOptions(chat: Pick<ChatContext, "target" | "threadId">): { business_connection_id?: string; message_thread_id?: number } {
    const options: { business_connection_id?: string; message_thread_id?: number } = {};
    if (chat.threadId !== undefined) options.message_thread_id = chat.threadId;
    if (chat.target.kind === "business") options.business_connection_id = chat.target.connectionId;
    return options;
  }

  /**
   * Sends a text the bot wrote without Claude's reply flow (status, review summary) to the client. In PREVIEW mode,
   * or when the owner is answering this chat, it goes to the logs instead. Returns true when it was sent.
   */
  #previewOf(chat: ChatContext, text: string): Preview {
    return {
      connectionId: chat.target.kind === "business" ? chat.target.connectionId : DIRECT_HISTORY_ID,
      chatId: chat.chatId,
      chatName: chat.chatName,
      language: chat.language,
      incoming: chat.incoming,
      reply: text,
      escalated: false,
      note: "",
    };
  }

  async #deliver(api: Api, chat: ChatContext, text: string, keyboard?: InlineKeyboardMarkup | ReplyKeyboardMarkup): Promise<boolean> {
    const preview = this.#previewOf(chat, text);
    if (!this.settings.autoSend) {
      this.#showPreview(preview);
      return false;
    }
    if (chat.target.kind === "business") {
      const reason = await this.#connectionProblem(api, chat.target.connectionId);
      if (reason) {
        logError(`Not sending to chat ${chat.chatId}: ${reason}.`);
        this.#showPreview({ ...preview, note: `not sent: ${reason}` });
        return false;
      }
    }
    try {
      const chunks = splitMessage(text);
      for (const [i, chunk] of chunks.entries()) {
        const last = i === chunks.length - 1;
        await api.sendMessage(chat.chatId, chunk, {
          ...this.#sendOptions(chat),
          ...(last && keyboard ? { reply_markup: keyboard } : {}),
        });
      }
    } catch (err) {
      logError(`Sending to chat ${chat.chatId} failed: ${errorMessage(err)}`);
      return false;
    }
    this.#remember(chat.historyId, chat.chatId, {
      role: "owner",
      name: this.settings.companyName,
      text,
      lang: chat.language,
    });
    return true;
  }

  /** Sends the blank questionnaire in the client's language (Uzbek, otherwise Russian). */
  async #sendTemplate(api: Api, chat: ChatContext, withText = true): Promise<boolean> {
    let template: Template;
    try {
      template = loadTemplate(this.settings.templatesDir);
    } catch (err) {
      logError(`Cannot send the questionnaire: ${errorMessage(err)}`);
      return false;
    }
    const file = blankFor(template, chat.language);
    if (!file) {
      logError(`Cannot send the questionnaire: no blank form in ${template.dir}.`);
      return false;
    }
    const caption = TEMPLATE_CAPTION[chat.language ?? "uz"];
    if (!this.settings.autoSend) {
      this.#showPreview({
        connectionId: chat.target.kind === "business" ? chat.target.connectionId : DIRECT_HISTORY_ID,
        chatId: chat.chatId,
        chatName: chat.chatName,
        language: chat.language,
        incoming: chat.incoming,
        reply: `[file ${path.basename(file)}] ${withText ? caption : ""}`.trim(),
        escalated: false,
        note: "the blank questionnaire would be sent",
      });
      return false;
    }
    if (chat.target.kind === "business") {
      const reason = await this.#connectionProblem(api, chat.target.connectionId);
      if (reason) {
        logError(`Not sending the questionnaire to chat ${chat.chatId}: ${reason}.`);
        return false;
      }
    }
    const fileName = `${template.title[chat.language === "ru" || chat.language === "en" ? "ru" : "uz"]}${path.extname(file)}`;
    try {
      await api.sendDocument(chat.chatId, new InputFile(file, fileName), {
        ...this.#sendOptions(chat),
        ...(withText ? { caption } : {}),
      });
    } catch (err) {
      logError(`Sending the questionnaire to chat ${chat.chatId} failed: ${errorMessage(err)}`);
      return false;
    }
    this.#remember(chat.historyId, chat.chatId, {
      role: "owner",
      name: this.settings.companyName,
      text: `[document] ${fileName}${withText ? ` ${caption}` : ""}`,
      lang: chat.language,
    });
    log(`Sent the blank questionnaire to chat ${chat.chatName} (${chat.chatId}).`);
    return true;
  }

  /** The client's document status in their language, without Claude. */
  clientProgressText(userId: number, language: Language | null): string {
    try {
      const template = loadTemplate(this.settings.templatesDir);
      return progressText(progress(this.folders.status(userId), template), language);
    } catch (err) {
      logError(`Cannot build the document status: ${errorMessage(err)}`);
      return STATUS_UNAVAILABLE[language ?? "uz"];
    }
  }

  /** "60%" for the owner's users list, or null when the client has not sent anything for the template yet. */
  #readyPercent(userId: number): string | null {
    if (!this.folders.exists(userId)) return null;
    const status = this.folders.status(userId);
    if (Object.keys(status.docs).length === 0 && !status.applicant) return null;
    try {
      return `${progress(status, loadTemplate(this.settings.templatesDir)).readyPct}%`;
    } catch {
      return null;
    }
  }

  /** Downloads a client's file into their inbox and (re)starts the batch timer. */
  async #queueFile(api: Api, message: Message, chat: ChatContext): Promise<void> {
    const file = fileOf(message);
    if (!file) return;
    const lang = chat.language ?? "uz";
    const refuse = async (reason: string): Promise<void> => {
      this.folders.reject(chat.chatId, "", null, [], null, file.name, [reason]);
      await this.#deliver(api, chat, `❌ ${file.name}: ${reason}.`);
    };
    const maxBytes = this.settings.maxFileMb * 1024 * 1024;
    if (file.size !== undefined && file.size > maxBytes) {
      log(`Chat ${chat.chatName} (${chat.chatId}): ${file.name} is larger than MAX_FILE_MB (${this.settings.maxFileMb}).`);
      await refuse(TOO_LARGE_REASON[lang](this.settings.maxFileMb));
      return;
    }
    const large = file.size !== undefined && file.size > BOT_API_DOWNLOAD_LIMIT;
    if (large && !this.#downloadLargeFile) {
      logError(
        `Chat ${chat.chatId}: ${file.name} is larger than 20 MB, which the Bot API cannot download. Set ` +
          "TELEGRAM_API_ID and TELEGRAM_API_HASH (from my.telegram.org) to accept such files.",
      );
      await refuse(LARGE_DISABLED_REASON[lang]);
      return;
    }

    const workdir = path.join(this.settings.dataDir, "claude-run");
    ensurePrivateDir(workdir);
    const tmp = path.join(workdir, `download-${crypto.randomBytes(8).toString("hex")}`);
    try {
      if (large && this.#downloadLargeFile) {
        log(`Chat ${chat.chatId}: downloading ${file.name} (${Math.round((file.size ?? 0) / 1048576)} MB) over MTProto.`);
        await this.#downloadLargeFile(file.fileId, tmp, file.size);
      } else {
        try {
          await this.#downloadFile(api, file.fileId, tmp);
        } catch (err) {
          // Telegram did not say the size, and the file turned out too big for the Bot API.
          if (!this.#downloadLargeFile || !/too big|too large/i.test(errorMessage(err))) throw err;
          fs.rmSync(tmp, { force: true });
          await this.#downloadLargeFile(file.fileId, tmp, file.size);
        }
      }
      const reviewChat: ReviewChat = {
        target: chat.target,
        chatId: chat.chatId,
        chatName: chat.chatName,
        language: chat.language,
        ...(chat.threadId !== undefined ? { threadId: chat.threadId } : {}),
      };
      this.inbox.add(reviewChat, tmp, file.name, message.message_id, this.#clock(), file.fileId);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      logError(`Could not download ${file.name} from chat ${chat.chatId}: ${errorMessage(err)}`);
      await refuse(DOWNLOAD_FAILED_REASON[lang]);
      return;
    }
    log(`Chat ${chat.chatName} (${chat.chatId}): ${file.name} queued for review.`);
    this.#scheduleReview(chat.chatId, this.#reviewDelayMs);
  }

  #scheduleReview(userId: number, delayMs: number): void {
    const existing = this.#reviewTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#reviewTimers.delete(userId);
      void this.#startReview(userId);
    }, Math.max(0, delayMs));
    timer.unref();
    this.#reviewTimers.set(userId, timer);
  }

  #startReview(userId: number): Promise<void> {
    const run = this.#locks
      .run(`review:${userId}`, () => this.#reviewBatch(userId))
      .catch((err: unknown) => logError(`Document review for chat ${userId} failed: ${errorMessage(err)}`))
      .finally(() => {
        if (this.#reviewRuns.get(userId) === run) this.#reviewRuns.delete(userId);
      });
    this.#reviewRuns.set(userId, run);
    return run;
  }

  /** Reviews waiting files now instead of after the batch delay, and waits until every batch is done (tests, /resume). */
  async flushReviews(api?: Api): Promise<void> {
    if (api) this.#api = api;
    for (const [userId, timer] of this.#reviewTimers) {
      clearTimeout(timer);
      this.#reviewTimers.delete(userId);
    }
    const waiting = new Set([...this.inbox.pending(), ...this.#reviewRuns.keys()]);
    await Promise.all([...waiting].map((userId) => this.#reviewRuns.get(userId) ?? this.#startReview(userId)));
  }

  /** After a restart: files that were waiting for review are reviewed again. */
  resumePendingReviews(api: Api): void {
    this.#api = api;
    for (const userId of this.inbox.pending()) this.#scheduleReview(userId, this.#reviewDelayMs);
  }

  #allowReview(): boolean {
    const now = this.#clock();
    this.#reviewCalls = this.#reviewCalls.filter((ts) => ts > now - 86400);
    if (this.#reviewCalls.length >= this.settings.reviewDailyLimit) return false;
    this.#reviewCalls.push(now);
    return true;
  }

  /** Reviews every file in a client's inbox, saves the results and sends one summary. */
  async #reviewBatch(userId: number): Promise<void> {
    const api = this.#api;
    const data = this.inbox.read(userId);
    if (!api || !data.chat || data.files.length === 0) return;
    if (this.state.paused) return; // reviewed after /resume
    const now = this.#clock();
    if (this.state.limitUntil > now) {
      this.#scheduleReview(userId, (this.state.limitUntil - now) * 1000 + 1000);
      return;
    }

    const saved = data.chat;
    const historyId = saved.target.kind === "business" ? saved.target.connectionId : DIRECT_HISTORY_ID;
    const chat: ChatContext = {
      target: saved.target,
      historyId,
      chatId: saved.chatId,
      chatKey: HistoryStore.key(historyId, saved.chatId),
      chatName: saved.chatName,
      incoming: data.files.map((f) => `[document] ${f.name}`).join(", "),
      language: saved.language,
      ...(saved.threadId !== undefined ? { threadId: saved.threadId } : {}),
    };
    const lang = chat.language ?? "uz";

    let template: Template;
    try {
      template = loadTemplate(this.settings.templatesDir);
    } catch (err) {
      logError(`Cannot review files of chat ${userId}: ${errorMessage(err)}`);
      return;
    }
    const laws = readLaws(this.settings.lawsDir);
    log(`Chat ${chat.chatName} (${userId}): reviewing ${data.files.length} file(s).`);
    if (data.files.length >= 3) await this.#deliver(api, chat, REVIEW_STARTED[lang](data.files.length));

    const verdicts: FileVerdict[] = [];
    const accepted: { verdict: Extract<FileVerdict, { kind: "accepted" }>; file: string }[] = [];
    const retrying: InboxFile[] = [];
    let stopped: "limit" | "daily" | null = null;
    for (const file of data.files) {
      if (!this.#allowReview()) {
        stopped = "daily";
        logError(`REVIEW_DAILY_LIMIT (${this.settings.reviewDailyLimit}) reached; the remaining files wait an hour.`);
        this.#scheduleReview(userId, 3600 * 1000);
        break;
      }
      let verdict: FileVerdict;
      try {
        verdict = await reviewFile({
          generator: this.generator,
          companyName: this.settings.companyName,
          template,
          laws,
          folders: this.folders,
          inbox: this.inbox,
          userId,
          file,
          language: lang,
          workdir: path.join(this.settings.dataDir, "claude-run"),
          now: new Date(this.#clock() * 1000),
        });
      } catch (err) {
        if (err instanceof ClaudeLimitError) {
          await this.#onGenerateError(api, chat, err);
          stopped = "limit";
          this.#scheduleReview(userId, Math.max(0, this.state.limitUntil - this.#clock()) * 1000 + 1000);
          break;
        }
        verdict = { kind: "unchecked", file, reason: err instanceof ClaudeError ? err.message : errorMessage(err) };
      }
      // A failed check (CLI error, unreadable answer) is not the client's fault: try again later, and only after
      // the last attempt ask the client to send the file in another form. Nobody else looks at it in between.
      if (verdict.kind === "unchecked") {
        const attempts = this.inbox.retryLater(userId, file);
        logError(`Chat ${userId}: could not check ${file.name} (attempt ${attempts}): ${verdict.reason}`);
        if (attempts < MAX_REVIEW_ATTEMPTS) {
          retrying.push(file);
          continue;
        }
        verdict = { kind: "rejected", file, doc: null, parts: [], reasons: [UNCHECKED_REASON[lang]], summary: verdict.reason };
      }
      const saved = this.#saveVerdict(userId, template, verdict);
      if (saved && verdict.kind === "accepted") accepted.push({ verdict, file: saved });
      verdicts.push(verdict);
      // The owner deleted this chat while it was being reviewed.
      if (!this.folders.exists(userId)) return;
    }
    if (retrying.length > 0 && stopped === null) this.#scheduleReview(userId, REVIEW_RETRY_SECONDS * 1000);
    if (verdicts.length === 0 && retrying.length === 0) return;

    const left = this.inbox.read(userId).files.length - retrying.length;
    const p = progress(this.folders.status(userId), template);
    const summary = reviewSummaryText(verdicts, lang, left, stopped, retrying) + "\n\n" + progressText(p, lang);
    // While the owner is answering this client, the summary waits in the logs (previews) instead.
    const ownerActive = this.#blocked(chat.chatKey) === Outcome.owner_active;
    const sent =
      !ownerActive &&
      (await this.#deliver(api, chat, summary, chat.target.kind === "direct" ? CLIENT_KEYBOARD : undefined));
    if (!sent && ownerActive) this.#showPreview({ ...this.#previewOf(chat, summary), note: "not sent: the owner is answering" });
    log(
      `Chat ${chat.chatName} (${userId}): ${verdicts.length} file(s) reviewed, ${retrying.length} to retry, ` +
        `ready ${p.readyPct}%${sent ? "" : " (summary not sent)"}.`,
    );
    await this.#sendPackageIfComplete(api, userId, template, p, accepted);
  }

  /** Files the verdict away. Returns where an accepted file was saved, so it can be sent to the owner. */
  #saveVerdict(userId: number, template: Template, verdict: FileVerdict): string | null {
    const source = this.inbox.path(userId, verdict.file);
    let saved: string | null = null;
    try {
      if (verdict.kind === "accepted") {
        const parts = verdict.parts.map((part) => part.key);
        saved = this.folders.accept(userId, template.id, verdict.doc.key, parts, source, verdict.file.name, verdict.file.fileId);
        if (verdict.applicant) this.folders.setApplicant(userId, template.id, verdict.applicant);
      } else if (verdict.kind === "rejected") {
        const parts = verdict.parts.map((part) => part.key);
        this.folders.reject(userId, template.id, verdict.doc?.key ?? null, parts, source, verdict.file.name, verdict.reasons);
      } else {
        this.folders.reject(userId, template.id, null, [], source, verdict.file.name, [`not checked: ${verdict.reason}`]);
      }
    } catch (err) {
      logError(`Could not save the review of ${verdict.file.name} for chat ${userId}: ${errorMessage(err)}`);
    }
    this.inbox.remove(userId, verdict.file);
    return saved;
  }

  /** A short note to the owner; files that could not be checked are sent along so someone looks at them. */
  /**
   * Tells the owner how the batch went and sends them the files that were accepted in it (the ready documents),
   * then the ones that could not be checked. When the package becomes complete, the owner is told once.
   */
  /**
   * The owner hears about a client's documents only once the package is complete: every required document sent
   * and accepted. Then the whole package goes to them at once. Documents accepted after that (a newer copy) are
   * passed on as updates. Nothing is sent while the package is still incomplete.
   */
  async #sendPackageIfComplete(
    api: Api,
    userId: number,
    template: Template,
    p: Progress,
    accepted: { verdict: Extract<FileVerdict, { kind: "accepted" }>; file: string }[],
  ): Promise<void> {
    if (p.total === 0 || p.accepted < p.total) return;
    const who = this.personTitle(userId);
    const titles = new Map(template.documents.map((doc) => [doc.key, doc.title.uz]));
    try {
      if (this.folders.markComplete(userId)) {
        await api.sendMessage(
          this.settings.ownerId,
          `🎉 Yangi to'liq paket: ${who}\nBarcha ${p.total} ta hujjat topshirildi va talab darajasida (100%). ` +
            `Fayllar quyida.\n\n${this.clientProgressText(userId, "uz")}`,
          { reply_markup: folderKeyboard(userId) },
        );
        const files = this.folders.acceptedFiles(userId, template.documents.map((doc) => doc.key));
        for (const file of files) {
          await this.#sendFileToOwner(api, file, `✅ ${titles.get(file.docKey) ?? file.docKey}\n👤 ${who}`);
        }
        log(`Chat ${userId}: the package is complete; ${files.length} file(s) sent to the owner.`);
        return;
      }
      for (const { verdict, file } of accepted) {
        const fileId = verdict.file.fileId;
        await this.#sendFileToOwner(
          api,
          { docKey: verdict.doc.key, file, name: verdict.file.name, ...(fileId ? { fileId } : {}) },
          `🔄 Yangilangan hujjat: ${verdict.doc.title.uz}\n👤 ${who}`,
        );
      }
    } catch (err) {
      logError(`Could not send the package of chat ${userId} to the owner: ${errorMessage(err)}`);
    }
  }

  /** The owner's 📎 button: the client's status and every accepted file. Returns how many files were sent. */
  async sendAcceptedFilesToOwner(api: Api, userId: number): Promise<number> {
    let order: string[] = [];
    const titles = new Map<string, string>();
    try {
      const template = loadTemplate(this.settings.templatesDir);
      order = template.documents.map((doc) => doc.key);
      for (const doc of template.documents) titles.set(doc.key, doc.title.uz);
    } catch {
      // Keys are shown instead of titles.
    }
    const files = this.folders.acceptedFiles(userId, order);
    if (files.length === 0) return 0;
    await api.sendMessage(this.settings.ownerId, this.clientProgressText(userId, "uz"));
    for (const file of files) await this.#sendFileToOwner(api, file, `✅ ${titles.get(file.docKey) ?? file.docKey}`);
    return files.length;
  }

  /**
   * Sends a saved file to the owner by its Telegram file_id when known (no re-upload, works for any size),
   * otherwise uploads the saved copy (Bot API uploads are limited to 50 MB).
   */
  async #sendFileToOwner(api: Api, file: AcceptedFile, caption: string): Promise<void> {
    const options = { caption: truncate(caption, 1000) };
    if (file.fileId) {
      try {
        await api.sendDocument(this.settings.ownerId, file.fileId, options);
        return;
      } catch (err) {
        logError(`Sending ${file.name} by file_id failed (${errorMessage(err)}); uploading the saved copy.`);
      }
    }
    await api.sendDocument(this.settings.ownerId, new InputFile(file.file, file.name), options);
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
    try {
      this.folders.appendChat(chatId, item.role === "other" ? item.name : this.settings.companyName, item.text);
    } catch (err) {
      logError(`Could not update chat.txt of chat ${chatId}: ${errorMessage(err)}`);
    }
  }

  /**
   * The owner's 🗑: forgets everything about this client — history, transcripts, the users list entry and the whole
   * client folder (chat.txt, accepted and rejected files, files waiting for review). Returns their name.
   */
  deleteChat(userId: number): string {
    const name = this.personTitle(userId);
    const timer = this.#reviewTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.#reviewTimers.delete(userId);
    this.transcripts.removeChat(userId);
    this.history.removeChat(userId);
    this.users.remove(userId);
    this.folders.delete(userId);
    for (const key of [...this.#takeoverUntil.keys()]) {
      if (key.endsWith(`:${userId}`)) this.#takeoverUntil.delete(key);
    }
    if (this.#replyTo?.userId === userId) this.#replyTo = null;
    log(`The owner deleted the chat and folder of ${userId}.`);
    return name;
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
      const ready = this.#readyPercent(user.id);
      const line =
        `${i + 1}. ${name}${username}\n` +
        `    ID ${user.id} · ${user.messages} ta xabar · oxirgi: ${tashkentTime(user.lastSeen)}` +
        (ready ? ` · 📊 ${ready}` : "");
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
    const documents = this.#readyPercent(userId) !== null ? `\n${this.clientProgressText(userId, "uz")}\n` : "";
    if (items.length === 0) {
      return {
        kind: "messages",
        messages: [`📁 ${escapeHtml(title)}\n${escapeHtml(documents)}\nBu mijoz bilan yozishma topilmadi.`],
      };
    }

    const header = `📁 ${title} — ${items.length} ta xabar`;
    const entries = items.map((item) => {
      const who = item.role === "other" ? `👤 ${item.name}` : `🏢 ${this.settings.companyName}`;
      return { who: `${who} · ${tashkentTime(item.ts)}`, text: item.text };
    });

    const messages: string[] = [];
    let current = `<b>${escapeHtml(header)}</b>\n${escapeHtml(documents)}`;
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

    const content = [header, documents, ...entries.map((entry) => `${entry.who}\n${entry.text}\n`)].join("\n");
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
    // Files that waited while the bot was paused or limited.
    if (this.#api) this.resumePendingReviews(this.#api);
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
      "• Mijozlarning xabarlari sizga yuborilmaydi. Faqat 🚨 muhim murojaatlar va to'liq hujjat paketlari keladi.",
      "• Mijozdan anketa oxiridagi 5 ta hujjat so'raladi. Mijoz fayl yuborsa (bir yo'la 10–50 ta ham, 20 MB dan " +
        "kattasi ham), bot har birini shablon (templates/) bo'yicha tekshiradi: moslari mijoz papkasiga saqlanadi, " +
        "mos kelmaganlarini sababi bilan qayta so'raydi va mijozga necha foiz tayyorligini ko'rsatadi.",
      "• Sizga faqat 5 ta hujjatning hammasi topshirilib, hammasi talab darajasida bo'lganda 🎉 xabar va butun " +
        "paket (barcha fayllar) bir yo'la keladi. Undan oldin hech narsa yuborilmaydi; holatni «users» orqali " +
        "istalgan vaqtda ko'rishingiz mumkin.",
      "• «users» tugmasi mijozlar ro'yxatini (📊 tayyorlik foizi bilan) ko'rsatadi. Mijozni bossangiz, u bilan " +
        "butun yozishma va hujjatlar holati ochiladi; ostida «📄 chat.txt», «📎 Qabul qilingan fayllar» va " +
        "«🗑 Chatni o'chirish» tugmalari bor.",
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
      "• Bot mijozni anketani to'ldirish, NDA ni imzolash va hujjatlarni topshirishga olib boradi. Aniq narx, " +
        "muddat, ruxsatnoma yoki ekspertiza natijasi bo'yicha va'da bermaydi — bunday savollarni mas'ul xodimga " +
        "yo'naltiradi.",
      "• Favqulodda holat, shikoyat yoki rasmiy so'rovlar 🚨 belgisi bilan keladi.",
      `• Bir odamdan soatiga ${DIRECT_HOURLY_LIMIT} tadan ko'p xabarga bot javob bermaydi (obuna limitini tejash uchun).`,
      `• Suhbat tarixi ${s.historyTtlDays} kun saqlanadi. Mijoz papkalari (chat.txt va hujjatlar) siz «🗑» bilan ` +
        "o'chirmaguningizcha saqlanadi.",
      `• Hujjat tekshiruvi uchun sutkasiga ko'pi bilan ${s.reviewDailyLimit} ta Claude chaqiruvi (REVIEW_DAILY_LIMIT).`,
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

/**
 * Language of what the person wrote (text or caption). A file without a caption has none: its "[document] name"
 * description is not their language, so the chat's last language is used instead.
 */
function languageOf(message: Message): Language | null {
  const words = message.text ?? message.caption;
  if (!words) return null;
  // One-word requests ("holat", "статус", "status") are too short for detectLanguage.
  if (message.text !== undefined && quickRequest(message.text) !== null) {
    if (/[ўқғҳ]/i.test(words)) return "uz";
    if (/\p{Script=Cyrillic}/u.test(words)) return "ru";
    if (/holat|hujjat|anketa|shablon/i.test(words)) return "uz";
    return null;
  }
  return detectLanguage(words);
}

/** The document or photo in a message, for review. Photos are taken in their largest size. */
export function fileOf(message: Message): { fileId: string; name: string; size?: number } | null {
  if (message.document) {
    const ext = message.document.mime_type === "application/pdf" ? ".pdf" : "";
    return {
      fileId: message.document.file_id,
      name: message.document.file_name || `document-${message.message_id}${ext}`,
      size: message.document.file_size,
    };
  }
  const photo = message.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, name: `photo-${message.message_id}.jpg`, size: photo.file_size };
  return null;
}

/** Downloads a file through the Bot API. The bot token is part of the URL, so it is kept out of error messages. */
async function telegramDownload(api: Api, botToken: string, fileId: string, target: string): Promise<void> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file path");
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > BOT_API_DOWNLOAD_LIMIT) throw new Error("the file is too big for the Bot API (over 20 MB)");
    await fs.promises.writeFile(target, data, { mode: 0o600, flag: "wx" });
  } catch (err) {
    const message = errorMessage(err);
    throw new Error(botToken ? message.split(botToken).join("[REDACTED]") : message);
  }
}

/** How often a file is tried when its check fails for a reason unrelated to the file. */
export const MAX_REVIEW_ATTEMPTS = 3;
/** Wait before such a file is tried again. */
export const REVIEW_RETRY_SECONDS = 300;

/** Told to the client after the last failed attempt; nobody else looks at the file. */
const UNCHECKED_REASON: Record<Language, string> = {
  uz: "faylni avtomatik tekshirib bo'lmadi: uni PDF qilib yoki aniqroq skan qilib qayta yuboring",
  ru: "файл не удалось проверить автоматически: пришлите его в PDF или более чёткий скан",
  en: "the file could not be checked automatically: please send it as a PDF or a clearer scan",
};

const REVIEW_WORDS: Record<
  Language,
  { checked: (n: number) => string; accepted: string; rejected: string; retrying: string; left: (n: number) => string }
> = {
  uz: {
    checked: (n) => `📥 Yuborgan ${n} ta faylingiz shablon bo'yicha tekshirildi.`,
    accepted: "✅ Qabul qilindi:",
    rejected: "❌ Qayta yuboring:",
    retrying: "⏳ Hozir tekshirib bo'lmadi, bir necha daqiqadan keyin qayta tekshiriladi:",
    left: (n) => `Qolgan ${n} ta fayl birozdan keyin tekshiriladi.`,
  },
  ru: {
    checked: (n) => `📥 Отправленные Вами файлы (${n}) проверены по шаблону.`,
    accepted: "✅ Принято:",
    rejected: "❌ Отправьте заново:",
    retrying: "⏳ Сейчас проверить не удалось, повторная проверка через несколько минут:",
    left: (n) => `Остальные файлы (${n}) будут проверены чуть позже.`,
  },
  en: {
    checked: (n) => `📥 The ${n} file(s) you sent have been checked against the template.`,
    accepted: "✅ Accepted:",
    rejected: "❌ Please send again:",
    retrying: "⏳ Could not be checked right now; they will be checked again in a few minutes:",
    left: (n) => `The remaining ${n} file(s) will be checked a little later.`,
  },
};

/** What the client is told after a batch: which files were accepted, which must be sent again and why. */
export function reviewSummaryText(
  verdicts: readonly FileVerdict[],
  language: Language,
  left: number,
  stopped: "limit" | "daily" | null,
  retrying: readonly InboxFile[] = [],
): string {
  const w = REVIEW_WORDS[language];
  const lines = [w.checked(verdicts.length + retrying.length)];
  const accepted = verdicts.filter((v): v is Extract<FileVerdict, { kind: "accepted" }> => v.kind === "accepted");
  const rejected = verdicts.filter((v): v is Extract<FileVerdict, { kind: "rejected" }> => v.kind === "rejected");
  // "Charter and register extract (Register extract)" when the file holds only some parts of a document.
  const title = (v: { doc: TemplateDoc | null; parts: TemplatePart[] }): string => {
    if (!v.doc) return "";
    const some = v.doc.parts.length > 1 && v.parts.length > 0 && v.parts.length < v.doc.parts.length;
    return some ? `${v.doc.title[language]} (${v.parts.map((part) => part.title[language]).join(", ")})` : v.doc.title[language];
  };
  if (accepted.length) {
    lines.push("", w.accepted, ...accepted.map((v) => `• ${title(v)} — ${v.file.name}`));
  }
  if (rejected.length) {
    lines.push(
      "",
      w.rejected,
      ...rejected.map((v) => `• ${v.doc ? `${title(v)} (${v.file.name})` : v.file.name}: ${v.reasons.join("; ")}`),
    );
  }
  if (retrying.length) lines.push("", w.retrying, ...retrying.map((file) => `• ${file.name}`));
  if (left > 0 && stopped) lines.push("", w.left(left));
  return lines.join("\n");
}

const TEMPLATE_CAPTION: Record<Language, string> = {
  uz:
    "Anketa oxiridagi 5 ta hujjatni shu chatga fayl qilib yuboring: 1) ustav va YeGRPO dan ko'chirma; " +
    "2) ruxsatnoma (litsenziya) va litsenziya kelishuvi; 3) loyiha hujjatlari va 5-GR tasdig'i; 4) ekologik paket; " +
    "5) EPB dalolatnomalari va yer ajratmasi qarorlari. Bot har birini tekshirib, nechchi foizi tayyorligini " +
    "ko'rsatadi. Anketani to'ldirib, imzolab yuborsangiz ham bo'ladi.",
  ru:
    "Отправьте файлами в этот чат 5 документов из перечня в конце анкеты: 1) устав и выписка из ЕГРПО; " +
    "2) разрешение (лицензия) и лицензионное соглашение; 3) проектная документация и подтверждение сдачи 5-ГР; " +
    "4) экологический пакет; 5) акты ЭПБ и решения на земельный отвод. Бот проверит каждый и покажет, на сколько " +
    "процентов пакет готов. Заполненную и подписанную анкету тоже можно прислать.",
  en:
    "Please send the 5 documents listed at the end of the questionnaire (Russian version) as files in this chat: " +
    "1) charter and register extract; 2) subsoil use permit and licence agreement; 3) project documents and proof " +
    "of form 5-GR; 4) environmental package; 5) industrial safety reports and land allotment decisions. Each file " +
    "is checked and you will see how complete your package is. You may also send the filled-in, signed questionnaire.",
};

const STATUS_UNAVAILABLE: Record<Language, string> = {
  uz: "Hujjatlar holatini hozir ko'rsatib bo'lmadi, birozdan keyin qayta so'rang.",
  ru: "Статус документов сейчас недоступен, попробуйте чуть позже.",
  en: "The document status is not available right now, please try again a little later.",
};

const TOO_LARGE_REASON: Record<Language, (mb: number) => string> = {
  uz: (mb) => `fayl ${mb} MB dan katta. Uni siqib yoki qismlarga bo'lib yuboring`,
  ru: (mb) => `файл больше ${mb} МБ. Сожмите его или отправьте частями`,
  en: (mb) => `the file is larger than ${mb} MB. Please compress or split it`,
};

/** For files over 20 MB while TELEGRAM_API_ID / TELEGRAM_API_HASH are not set. */
const LARGE_DISABLED_REASON: Record<Language, string> = {
  uz: "20 MB dan katta fayllarni qabul qilish hali sozlanmagan. Hozircha faylni siqib yoki qismlarga bo'lib yuboring",
  ru: "приём файлов больше 20 МБ пока не настроен. Пока сожмите файл или отправьте его частями",
  en: "receiving files over 20 MB is not set up yet. For now, please compress or split the file",
};

const DOWNLOAD_FAILED_REASON: Record<Language, string> = {
  uz: "faylni yuklab olib bo'lmadi, uni qayta yuboring",
  ru: "файл не удалось загрузить, отправьте его ещё раз",
  en: "the file could not be downloaded, please send it again",
};

const REVIEW_STARTED: Record<Language, (n: number) => string> = {
  uz: (n) => `📥 ${n} ta fayl qabul qilindi, shablon bo'yicha tekshirilmoqda. Natijani shu yerda yozaman.`,
  ru: (n) => `📥 Получено файлов: ${n}. Проверяю их по шаблону, результат напишу здесь.`,
  en: (n) => `📥 ${n} files received. I am checking them against the template and will post the result here.`,
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
