import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GrammyError, HttpError, InputFile, InputMediaBuilder, type Api } from "grammy";
import type { BusinessConnection, InlineKeyboardMarkup, Message, ReplyKeyboardMarkup } from "grammy/types";
import { AdminAssistant } from "./admin/adminAssistant.js";
import { ClaudeProvider } from "./ai/claudeProvider.js";
import { GeminiProvider } from "./ai/geminiProvider.js";
import { AIProviderManager, type SwitchEvent } from "./ai/providerManager.js";
import { AllProvidersDownError, type Embedder } from "./ai/types.js";
import { buildBackup } from "./backup.js";
import type { Database } from "./db/database.js";
import { messageKey } from "./db/importJson.js";
import { loadPriceList, type PriceList } from "./knowledge/prices.js";
import { MemoryManager } from "./memory.js";
import { type BrainResult, type CustomerBrain, Orchestrator, type ReplyGenerator, SimpleBrain } from "./orchestrator/orchestrator.js";
import { confidenceLevel } from "./orchestrator/decisionTree.js";
import { buildDailyReport, type ReportClient, REPORT_WINDOW_SECONDS, tashkentDate, tashkentHour } from "./dailyReport.js";
import { ClientFolders, type PackageFile, statusText } from "./clientFolder.js";
import type { Settings } from "./config.js";
import { Inbox, type InboxFile, type ReviewChat } from "./documentReview.js";
import { detectLanguage, type Language } from "./language.js";
import { BOT_API_DOWNLOAD_LIMIT, MtprotoDownloader } from "./largeFiles.js";
import { DOCUMENTS_UZ, SKIP_TOKEN, splitEscalation, splitTemplate } from "./prompts.js";
import { blankFor, loadTemplate, type Template } from "./templates.js";
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
  file_received: "file_received",
  status_shown: "status_shown",
  template_sent: "template_sent",
  missing_menu: "missing_menu",
  /** Every AI provider was down: the message waits in the queue and is answered later. */
  queued: "queued",
  /** A newer message from the same person arrived while this reply was written; the newer one is answered. */
  superseded: "superseded",
  /** A reply to this exact message was already sent (idempotency). */
  already_answered: "already_answered",
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

export type { ReplyGenerator } from "./orchestrator/orchestrator.js";

const MAX_MESSAGE_LENGTH = 4000;
const OWNER_ALERT_INTERVAL_SECONDS = 600;
/** Messages kept per chat for the admins' user folders: all of them (nothing is deleted by age or count). */
const TRANSCRIPT_LIMIT = Number.MAX_SAFE_INTEGER;
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
/** callback_data prefixes of the buttons under a client's folder. */
export const CHAT_TXT_CALLBACK_PREFIX = "chattxt:";
export const FILES_CALLBACK_PREFIX = "files:";
export const DELETE_CALLBACK_PREFIX = "delete:";
export const DELETE_CONFIRM_CALLBACK_PREFIX = "delete-yes:";
export const DELETE_CANCEL_CALLBACK = "delete-no";
/** Files a client sends are counted this long after the last one arrives, as one batch (one summary message). */
export const REVIEW_BATCH_SECONDS = 15;
/** Most files accepted from one client (a package is 14); more are refused so nobody can fill the disk. */
export const MAX_FILES_PER_CLIENT = 60;
/** Files downloaded from Telegram at the same time, to keep memory and the connection under control. */
const PARALLEL_DOWNLOADS = 3;

/** Lets at most `size` tasks run at the same time; the rest wait their turn. */
class Semaphore {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(size: number) {
    this.#free = size;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/** Files in a complete package when the template cannot be read (one per required document). */
export const DEFAULT_PACKAGE_SIZE = 14;
/** callback_data prefix of a document button in the «❌ Menda yo'q» menu, and of its "done" button. */
export const MISSING_CALLBACK_PREFIX = "miss:";
export const MISSING_DONE_CALLBACK = "miss-done";

/** Texts of the client's keyboard buttons in the bot's own chat. */
export const CLIENT_STATUS_BUTTON = "📊 Hujjatlar holati";
export const CLIENT_TEMPLATE_BUTTON = "📄 Anketa shabloni";
export const CLIENT_MISSING_BUTTON = "❌ Menda yo'q hujjatlar";

/**
 * Persistent keyboard for clients in the bot's own chat. Once the package is complete (every file received and
 * sent to the admin) the «❌ Menda yo'q hujjatlar» button is left out: there is nothing more to mark.
 */
export function clientKeyboard(complete: boolean): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: CLIENT_STATUS_BUTTON }, { text: CLIENT_TEMPLATE_BUTTON }],
      ...(complete ? [] : [[{ text: CLIENT_MISSING_BUTTON }]]),
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** The keyboard with all three buttons (a client whose package is not complete yet). */
export const CLIENT_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: CLIENT_STATUS_BUTTON }, { text: CLIENT_TEMPLATE_BUTTON }], [{ text: CLIENT_MISSING_BUTTON }]],
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

const MISSING_WORDS = new Set([
  "menda yo'q hujjatlar", "yo'q hujjatlar", "menda yo'q hujjat", "менда йўқ ҳужжатлар", "йўқ ҳужжатлар",
  "у меня нет документов", "нет документов", "отсутствующие документы", "missing documents",
]);

/**
 * A client's short request that is answered without Claude: their document status, the blank form, or the menu
 * for marking the documents they do not have.
 */
export function quickRequest(text: string): "status" | "template" | "missing" | null {
  const normalized = text
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\uFE0F\u274C]/gu, "")
    .replace(/[‘’ʼʻ`´]/g, "'")
    .replace(/[.!?,:;]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (STATUS_WORDS.has(normalized)) return "status";
  if (TEMPLATE_WORDS.has(normalized)) return "template";
  if (MISSING_WORDS.has(normalized)) return "missing";
  return null;
}

const MISSING_MENU_WORDS: Record<Language, { intro: string; done: string }> = {
  uz: {
    intro:
      "❌ Qaysi hujjatlar sizda yo'q? Ularni bosib belgilang (❌), qayta bossangiz belgi olinadi. Keyin " +
      "«✅ Tayyor» ni bosing. Belgilangan hujjatlar so'ralmaydi va kerakli fayllar soni shuncha kamayadi.",
    done: "✅ Tayyor",
  },
  ru: {
    intro:
      "❌ Каких документов у Вас нет? Отметьте их нажатием (❌), повторное нажатие снимает отметку. Затем " +
      "нажмите «✅ Готово». Отмеченные документы не запрашиваются, и нужное число файлов уменьшается.",
    done: "✅ Готово",
  },
  en: {
    intro:
      "❌ Which documents do you not have? Tap them to mark them (❌); tap again to unmark. Then press " +
      "«✅ Done». Marked documents are not asked for, and the number of files needed goes down.",
    done: "✅ Done",
  },
};

/** The «❌ Menda yo'q» menu: one button per required document (❌ when marked), then the "done" button. */
export function missingKeyboard(
  docs: readonly { key: string; title: string }[],
  missing: ReadonlySet<number>,
  language: Language | null,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...docs.map((doc, i) => [
        { text: truncate(`${missing.has(i) ? "❌" : "⬜"} ${i + 1}. ${doc.title}`, 60), callback_data: `${MISSING_CALLBACK_PREFIX}${doc.key}` },
      ]),
      [{ text: MISSING_MENU_WORDS[language ?? "uz"].done, callback_data: MISSING_DONE_CALLBACK }],
    ],
  };
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

/** Telegram puts at most 10 files into one album. */
export const ALBUM_SIZE = 10;

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
  /** PostgreSQL (long-term memory, analytics, idempotency); null runs on the JSON files only. */
  db?: Database | null;
  /** Claude + Gemini; null in the offline tests that use a scripted generator. */
  ai?: AIProviderManager | null;
  memory?: MemoryManager | null;
  admin?: AdminAssistant | null;
  previewSink?: (preview: Preview) => void;
  downloadFile?: FileDownloader;
  /** Downloads files over 20 MB (MTProto); null turns large files off. Built from TELEGRAM_API_ID/HASH by default. */
  downloadLargeFile?: LargeFileDownloader | null;
  /** Wait after the last file before a batch is handled (default REVIEW_BATCH_SECONDS). */
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
  /** "<history id>:<chat id>:<message id>": one reply per incoming message. */
  incomingKey?: string;
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
/** AI calls allowed per person per hour in direct chats (protects against flooding and API costs). */
export const DIRECT_HOURLY_LIMIT = 20;
/** How often the queue of messages that waited for an AI provider is retried. */
export const PENDING_RETRY_SECONDS = 60;

export class Assistant {
  readonly history: HistoryStore;
  /** Full conversations for the owner's user folders (history only keeps the last HISTORY_LIMIT for Claude). */
  readonly transcripts: HistoryStore;
  readonly seen: SeenMessages;
  readonly state: RuntimeState;
  readonly users: UserDirectory;
  /** data/clients/<id>/: chat.txt, received files, status. */
  readonly folders: ClientFolders;
  /** Client files waiting for the batch. */
  readonly inbox: Inbox;
  readonly outcomes: Outcome[] = [];
  readonly previewsFile: string;
  readonly #connections = new Map<string, BusinessConnection>();
  readonly #locks = new KeyedMutex();
  readonly #ownerAlerts = new Map<string, number>();
  readonly #directCalls = new Map<string, number[]>();
  readonly db: Database | null;
  readonly ai: AIProviderManager | null;
  readonly memory: MemoryManager | null;
  readonly admin: AdminAssistant | null;
  readonly #admins: Set<number>;
  /** Database writes run one after another in this chain, so the order of messages is kept. */
  #dbChain: Promise<void> = Promise.resolve();
  /** Messages waiting for an AI provider when there is no database (lost on restart). */
  readonly #pendingMemory = new Map<string, ChatContext>();
  readonly #clock: Clock;
  readonly #previewSink: (preview: Preview) => void;
  readonly #downloadFile: FileDownloader;
  readonly #downloadSlots = new Semaphore(PARALLEL_DOWNLOADS);
  readonly #downloadLargeFile: LargeFileDownloader | null;
  /** Set when TELEGRAM_API_ID/HASH are configured, for the startup check. */
  readonly mtproto: MtprotoDownloader | null = null;
  readonly #batchDelayMs: number;
  readonly #batchTimers = new Map<number, NodeJS.Timeout>();
  /** Batches running now, so tests and /resume can wait for them. */
  readonly #batchRuns = new Map<number, Promise<void>>();
  /** The API of the latest update, for batches that start later from a timer. */
  #api: Api | null = null;

  constructor(
    readonly settings: Settings,
    readonly brain: CustomerBrain,
    {
      clock = () => Date.now() / 1000,
      previewSink = printPreview,
      downloadFile,
      downloadLargeFile,
      reviewDelayMs,
      db = null,
      ai = null,
      memory = null,
      admin = null,
    }: AssistantOptions = {},
  ) {
    this.#clock = clock;
    this.db = db;
    this.ai = ai;
    this.memory = memory;
    this.admin = admin;
    this.#admins = new Set(settings.adminIds.length > 0 ? settings.adminIds : [settings.ownerId]);
    this.#previewSink = previewSink;
    const download = downloadFile ?? ((api, fileId, target) => telegramDownload(api, settings.botToken, fileId, target));
    this.#downloadFile = (api, fileId, target) => this.#downloadSlots.run(() => download(api, fileId, target));
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
    this.#batchDelayMs = reviewDelayMs ?? REVIEW_BATCH_SECONDS * 1000;
    const dir = settings.dataDir;
    ensurePrivateDir(dir);
    this.history = new HistoryStore(
      path.join(dir, "history.json"),
      settings.historyLimit,
      0,
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
      0,
      clock,
    );
    this.seen = new SeenMessages(path.join(dir, "seen.json"));
    this.state = new RuntimeState(path.join(dir, "state.json"));
    this.users = new UserDirectory(path.join(dir, "users.json"), 0, clock);
    this.folders = new ClientFolders(path.join(dir, "clients"), clock);
    this.inbox = new Inbox(this.folders);
    this.previewsFile = path.join(dir, "previews.jsonl");
  }

  /** True for every admin (OWNER_ID and ADMIN_IDS); all admins are equal. */
  isAdmin(userId: number | undefined): boolean {
    return userId !== undefined && this.#admins.has(userId);
  }

  get adminIds(): number[] {
    return [...this.#admins];
  }

  /** Runs a database write after the previous ones; a failure is logged and never stops the bot. */
  #dbWrite(label: string, fn: (db: Database) => Promise<unknown>): void {
    const db = this.db;
    if (!db) return;
    this.#dbChain = this.#dbChain.then(
      () =>
        fn(db).then(
          () => undefined,
          (err: unknown) => logError(`Database (${label}) failed: ${errorMessage(err)}`),
        ),
    );
  }

  /** Waits until every queued database write is done (before reading, and in tests). */
  async dbIdle(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.#dbChain;
      await chain;
    } while (chain !== this.#dbChain);
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
    if (!this.isAdmin(connection.user.id)) {
      logError(
        `WARNING: business connection ${connection.id} belongs to user ${connection.user.id}, which is not in ` +
          `ADMIN_IDS/OWNER_ID. Its messages will be ignored.`,
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
    const updateKey = `${connectionId}:${chatId}:${message.message_id}`;
    if (!this.seen.firstTime(updateKey)) return Outcome.duplicate;
    if (this.db && !(await this.#firstTimeInDb(updateKey))) return Outcome.duplicate;
    if (message.sender_business_bot || message.from?.is_bot) return Outcome.ignored_bot;

    const connection = this.#connections.get(connectionId) ?? (await this.#lookupConnection(api, connectionId));
    if (!connection) return Outcome.no_connection;
    if (!this.isAdmin(connection.user.id)) return Outcome.foreign_connection;
    if (!connection.is_enabled) return Outcome.connection_disabled;

    const text = describe(message);
    if (text === null) return Outcome.unsupported;

    const chatKey = HistoryStore.key(connectionId, chatId);
    if (message.from?.id === connection.user.id) {
      // An employee wrote from the company account: it is part of the conversation, the bot does not answer it.
      this.#remember(
        connectionId,
        chatId,
        { role: "owner", name: this.settings.companyName, text, lang: detectLanguage(text) },
        "admin",
      );
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
      incomingKey: `${connectionId}:${chatId}:${message.message_id}`,
      language,
    };
    const handled = await this.#handleFileOrQuick(api, message, chat);
    if (handled) return handled;
    const result = await this.#locks.run(chatKey, () => this.#respond(api, chat));
    return result.outcome;
  }

  /**
   * Files and photos go to the inbox (the batch summary is the answer), and "status" / "anketa" requests
   * are answered without Claude. Returns null for everything else.
   */
  async #handleFileOrQuick(api: Api, message: Message, chat: ChatContext): Promise<Outcome | null> {
    if (fileOf(message)) {
      await this.#queueFile(api, message, chat);
      return Outcome.file_received;
    }
    const quick = message.text !== undefined ? quickRequest(message.text) : null;
    if (quick === null) return null;
    const blocked = this.#blocked(chat.chatKey);
    if (blocked === Outcome.owner_active || blocked === Outcome.paused) return null;
    if (quick === "status") {
      const hint = chat.target.kind === "direct";
      await this.#deliver(api, chat, this.clientProgressText(chat.chatId, chat.language, { hint }));
      return Outcome.status_shown;
    }
    if (quick === "missing") {
      // The menu needs inline buttons in the bot's own chat; in business chats Claude answers instead.
      if (chat.target.kind !== "direct") return null;
      if (this.packageComplete(chat.chatId)) {
        // Nothing more to mark: show the status (the button itself is gone from the keyboard).
        await this.#deliver(api, chat, this.clientProgressText(chat.chatId, chat.language), this.clientKeyboardFor(chat.chatId));
        return Outcome.status_shown;
      }
      const menu = this.missingMenu(chat.chatId, chat.language);
      await this.#deliver(api, chat, menu.text, menu.keyboard);
      return Outcome.missing_menu;
    }
    await this.#sendTemplate(api, chat);
    return Outcome.template_sent;
  }

  async #handleDirect(api: Api, message: Message): Promise<Outcome> {
    // Everything up to the duplicate check must stay synchronous (no await before it).
    const chatId = message.chat.id;
    if (message.chat.type !== "private") return Outcome.unsupported;
    const updateKey = `${DIRECT_HISTORY_ID}:${chatId}:${message.message_id}`;
    if (!this.seen.firstTime(updateKey)) return Outcome.duplicate;
    // seen.json is the fast check; the database also catches a repeat after a lost volume.
    if (this.db && !(await this.#firstTimeInDb(updateKey))) return Outcome.duplicate;
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
      incomingKey: `${DIRECT_HISTORY_ID}:${chatId}:${message.message_id}`,
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

  /**
   * An admin pressed ✍️ under a person: that admin's next messages go to that person, and the bot is silent for the
   * person until the admin presses «✖️ Tugatish» (no timer). Kept in state.json across restarts. Returns their name.
   */
  startReply(adminId: number, userId: number): string {
    this.state.setReplyMode(adminId, userId);
    this.#dbWrite("admin action", (db) => db.adminAction(adminId, "reply_mode_start", String(userId)));
    return this.personTitle(userId);
  }

  /** Ends the admin's reply mode; the bot answers that person again at once. Returns their name, or null. */
  endReply(adminId: number): string | null {
    const userId = this.state.replyModes[String(adminId)] ?? null;
    if (userId === null) return null;
    this.state.setReplyMode(adminId, null);
    this.#dbWrite("admin action", (db) => db.adminAction(adminId, "reply_mode_end", String(userId)));
    return this.personTitle(userId);
  }

  /** The person this admin is answering with ✍️, or null. */
  replyTarget(adminId: number): number | null {
    return this.state.replyModes[String(adminId)] ?? null;
  }

  /** True while any admin has ✍️ open for this person. */
  #adminAnswering(userId: number): boolean {
    return Object.values(this.state.replyModes).includes(userId);
  }

  /**
   * A message from an admin while their reply mode is open: deliver it (text, photo, file, voice...) to that person.
   */
  async sendOwnerReply(api: Api, message: Message): Promise<{ result: OwnerReplyResult; to: string }> {
    const adminId = message.from?.id ?? 0;
    const userId = this.replyTarget(adminId);
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
          logError(`Not sending the admin's reply to chat ${userId}: ${reason}.`);
          return { result: "failed", to };
        }
        for (const chunk of splitMessage(message.text)) {
          await api.sendMessage(userId, chunk, { business_connection_id: via });
        }
      }
    } catch (err) {
      logError(`Could not deliver the admin's reply to chat ${userId}: ${errorMessage(err)}`);
      return { result: "failed", to };
    }
    const text = describe(message) ?? "[message]";
    this.#remember(via, userId, { role: "owner", name: this.settings.companyName, text, lang: detectLanguage(text) }, "admin");
    this.#dbWrite("admin action", (db) => db.adminAction(adminId, "reply", String(userId), { text: text.slice(0, 500) }));
    log(`Delivered admin ${adminId}'s reply to chat ${userId}.`);
    return { result: "sent", to };
  }

  /** "Name @username" of someone who wrote to the bot, or their ID. */
  personTitle(userId: number): string {
    const user = this.users.list().find((known) => known.id === userId);
    if (!user) return `ID ${userId}`;
    return user.username ? `${user.name} @${user.username}` : user.name;
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

  async #firstTimeInDb(key: string): Promise<boolean> {
    try {
      return await this.db!.firstTime(key);
    } catch (err) {
      logError(`Database duplicate check failed (handled as new): ${errorMessage(err)}`);
      return true;
    }
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
    const chatId = Number(chatKey.slice(chatKey.lastIndexOf(":") + 1));
    if (this.#adminAnswering(chatId)) return Outcome.owner_active;
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

    // Idempotency: never a second reply to the same incoming message (e.g. a retried queue entry).
    if (chat.incomingKey && this.db) {
      await this.dbIdle();
      const exists = await this.db.replyExists(chat.incomingKey).catch(() => false);
      if (exists) return result(Outcome.already_answered);
    }

    const before = this.#customerMessageCount(chat.chatId);
    await this.dbIdle();
    let brainResult: BrainResult;
    try {
      brainResult = await this.brain.reply({
        customerId: chat.chatId,
        chatName: chat.chatName,
        language: chat.language,
        recent: this.#memory(chat),
        incoming: chat.incoming,
        incomingKey: chat.incomingKey ?? "",
        companyName: this.settings.companyName,
        profileText: readProfile(this.settings.profilePath),
        now: new Date(this.#clock() * 1000),
      });
    } catch (err) {
      const failure = await this.#onGenerateError(api, chat, err);
      return result(failure.outcome, "", false, failure.note);
    }
    for (const note of brainResult.notes) log(`Chat ${chat.chatName} (${chat.chatId}): ${note}`);

    // The person wrote again while this reply was written: the newer message is answered with all of them in view,
    // so one reply covers both and nothing is said twice.
    if (this.#customerMessageCount(chat.chatId) > before) {
      this.#saveRequest(chat, brainResult, "superseded", null);
      log(`Chat ${chat.chatName} (${chat.chatId}): a newer message arrived; this reply is dropped in favour of it.`);
      return result(Outcome.superseded);
    }

    const raw = brainResult.raw;
    const marked = splitEscalation(raw);
    const { sendTemplate, text: reply } = splitTemplate(marked.text);
    const analysis = brainResult.analysis;
    const escalate =
      marked.escalate || (analysis.fromAi && ["complaint", "emergency", "official_request"].includes(analysis.requestType));
    if (!reply || reply.startsWith(SKIP_TOKEN)) {
      log(`Chat ${chat.chatName} (${chat.chatId}): no reply needed ([SKIP]).`);
      this.#saveRequest(chat, brainResult, "skipped", null);
      if (escalate) await this.#alertEscalation(api, chat);
      return result(Outcome.skipped, "", escalate);
    }
    if (escalate) await this.#alertEscalation(api, chat);
    if (analysis.fromAi && analysis.requestType === "price_request") await this.#alertPriceLead(api, chat, brainResult);

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
      this.#saveRequest(chat, brainResult, "previewed", reply);
      this.#afterReply(chat.chatId);
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
    const incomingKey = chat.incomingKey;
    if (incomingKey) {
      this.#dbWrite("reply", (db) => db.recordReply(incomingKey, chat.chatId, reply, brainResult.provider));
    }
    this.#saveRequest(chat, brainResult, "sent", reply);
    log(
      `Sent a reply to chat ${chat.chatName} (${chat.chatId})${escalate ? " [ESCALATED]" : ""}` +
        `${brainResult.provider ? ` via ${brainResult.provider}` : ""} [${brainResult.workflow}].`,
    );
    if (sendTemplate) await this.#sendTemplate(api, chat, false);
    this.#afterReply(chat.chatId);
    return result(Outcome.sent, reply, escalate);
  }

  /** Customer messages of this person in the transcripts (to notice a newer one while a reply is written). */
  #customerMessageCount(chatId: number): number {
    return this.transcripts.forChat(chatId).filter((item) => item.role === "other").length;
  }

  /** Step 7 of the decision tree: the request, its type, workflow, confidence and result go to ai_requests. */
  #saveRequest(chat: ChatContext, brain: BrainResult, status: string, finalResult: string | null, error: string | null = null): void {
    const analysis = brain.analysis;
    this.#dbWrite("ai request", (db) =>
      db.saveAiRequest({
        requestId: brain.requestId,
        chatId: chat.chatId,
        customerId: chat.chatId,
        adminId: null,
        incomingKey: chat.incomingKey ?? null,
        requestType: analysis.requestType,
        complexity: analysis.complexity,
        contextCompleteness: analysis.contextCompleteness,
        selectedWorkflow: brain.workflow,
        workflowPath: brain.path,
        confidenceScore: analysis.confidence,
        confidenceLevel: confidenceLevel(analysis.confidence),
        requiredPermissions: brain.workflow === "escalate" ? ["customer_reply", "admin_notify"] : brain.workflow === "price_answer" ? ["customer_reply", "price_list_read", "admin_notify"] : ["customer_reply"],
        executionStatus: status,
        finalResult,
        provider: brain.provider,
        model: brain.model,
        topic: analysis.topic || null,
        service: analysis.services[0] ?? null,
        error,
      }),
    );
  }

  /** Background work after a reply: the conversation summary is refreshed every few messages. */
  #afterReply(chatId: number): void {
    const memory = this.memory;
    if (!memory) return;
    this.#track(this.dbIdle().then(() => memory.maybeSummarize(chatId)));
  }

  readonly #background = new Set<Promise<unknown>>();

  /** Keeps a background task so tests (and shutdown) can wait for it; its errors are only logged. */
  #track(task: Promise<unknown>): void {
    const tracked = task.catch((err: unknown) => logError(`Background task failed: ${errorMessage(err)}`));
    this.#background.add(tracked);
    void tracked.finally(() => this.#background.delete(tracked));
  }

  /** Waits for database writes and background tasks (summaries, embeddings). */
  async idle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await this.dbIdle();
      if (this.#background.size === 0) return;
      await Promise.all([...this.#background]);
    }
    await this.dbIdle();
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

  /**
   * The required documents of the template (14) with their titles, which of them the client marked as missing
   * («❌ Menda yo'q», 0-based positions), and how many files make a complete package: one per required document the
   * client has.
   */
  #packageSpec(
    language: Language | null,
    userId: number | null = null,
  ): { total: number; docs: { key: string; title: string }[]; titles: string[]; missing: Set<number> } {
    let docs: { key: string; title: string }[];
    try {
      const template = loadTemplate(this.settings.templatesDir);
      docs = template.documents
        .filter((doc) => doc.required)
        .map((doc) => ({ key: doc.key, title: doc.title[language ?? "uz"] }));
    } catch (err) {
      logError(`Cannot read the document template, counting to ${DEFAULT_PACKAGE_SIZE} files: ${errorMessage(err)}`);
      return { total: DEFAULT_PACKAGE_SIZE, docs: [], titles: [], missing: new Set() };
    }
    const marked = userId !== null && this.folders.exists(userId) ? this.folders.status(userId).missing : [];
    // Keys of documents no longer in the template are ignored.
    const missing = new Set(docs.flatMap((doc, i) => (marked.includes(doc.key) ? [i] : [])));
    return { total: docs.length - missing.size, docs, titles: docs.map((doc) => doc.title), missing };
  }

  /** The client's status in their language: files received out of how many are needed, missing ones marked. */
  clientProgressText(userId: number, language: Language | null, { hint = false }: { hint?: boolean } = {}): string {
    const { total, titles, missing } = this.#packageSpec(language, userId);
    return statusText(this.folders.status(userId).received.length, total, titles, language, { missing, hint });
  }

  /** The client's document status for the Admin AI ("Qabul qilingan fayllar: 5/14" and the list), or null. */
  documentStatus(userId: number): string | null {
    if (!this.folders.exists(userId)) return null;
    return this.clientProgressText(userId, "uz");
  }

  /**
   * An admin wrote free text: the Admin AI answers from the database. Long answers are split; report files follow.
   */
  async adminChat(api: Api, adminId: number, text: string): Promise<void> {
    if (!this.admin) {
      await api.sendMessage(
        adminId,
        this.db
          ? "⚠️ Admin AI uchun AI provayder sozlanmagan (ANTHROPIC_API_KEY yoki GEMINI_API_KEY)."
          : "⚠️ Admin AI ishlashi uchun PostgreSQL ulanmagan (DATABASE_URL). Mijoz bilan ishlash uchun «users» tugmasidan foydalaning.",
      );
      return;
    }
    await api.sendChatAction(adminId, "typing").catch(() => undefined);
    const typing = setInterval(() => void api.sendChatAction(adminId, "typing").catch(() => undefined), 4500);
    typing.unref();
    try {
      await this.dbIdle();
      const answer = await this.admin.handle(adminId, text);
      for (const chunk of splitMessage(answer.text)) await api.sendMessage(adminId, chunk, { link_preview_options: { is_disabled: true } });
      for (const file of answer.files) {
        await api.sendDocument(adminId, new InputFile(file.buffer, file.name), { caption: truncate(file.caption, 1000) });
      }
      this.#dbWrite("admin action", (db) => db.adminAction(adminId, "ai_question", null, { text: text.slice(0, 500), provider: answer.provider }));
    } catch (err) {
      logError(`Admin AI failed for ${adminId}: ${errorMessage(err)}`);
      const reason =
        err instanceof AllProvidersDownError
          ? "Claude ham, Gemini ham hozir javob bermayapti. Birozdan keyin qayta so'rang."
          : `Xato: ${truncate(errorMessage(err), 300)}`;
      await api.sendMessage(adminId, `⚠️ So'rovni bajarib bo'lmadi. ${reason}`).catch(() => undefined);
    } finally {
      clearInterval(typing);
    }
  }

  /** "5/14" for the owner's users list, or null when the client has not sent a file or marked a document yet. */
  #receivedCount(userId: number): string | null {
    if (!this.folders.exists(userId)) return null;
    const status = this.folders.status(userId);
    if (status.received.length === 0 && status.missing.length === 0) return null;
    return `${status.received.length}/${this.#packageSpec("uz", userId).total}`;
  }

  /** True once the client's package is complete: the files cover every document they have, or it was sent already. */
  packageComplete(userId: number): boolean {
    if (!this.folders.exists(userId)) return false;
    const count = this.folders.status(userId).received.length;
    return this.folders.status(userId).packageSentAt !== null || (count > 0 && count >= this.#packageSpec(null, userId).total);
  }

  /** The client's persistent keyboard: without «❌ Menda yo'q hujjatlar» once the package is complete. */
  clientKeyboardFor(userId: number): ReplyKeyboardMarkup {
    return clientKeyboard(this.packageComplete(userId));
  }

  /** The «❌ Menda yo'q» menu for a client, in their language. */
  missingMenu(userId: number, language: Language | null): { text: string; keyboard: InlineKeyboardMarkup } {
    const { docs, missing } = this.#packageSpec(language, userId);
    return { text: MISSING_MENU_WORDS[language ?? "uz"].intro, keyboard: missingKeyboard(docs, missing, language) };
  }

  /**
   * A client pressed a document in the «❌ Menda yo'q» menu: it is marked as missing (or unmarked). Returns the
   * updated menu buttons, or null for an unknown document.
   */
  toggleMissing(userId: number, key: string): InlineKeyboardMarkup | null {
    const language = this.history.lastLanguage(DIRECT_HISTORY_ID, userId);
    if (!this.#packageSpec(language).docs.some((doc) => doc.key === key)) return null;
    if (this.packageComplete(userId)) return null;
    this.folders.toggleMissing(userId, key);
    return this.missingMenu(userId, language).keyboard;
  }

  /**
   * A client pressed «✅ Tayyor» in the menu: the choice is written to the conversation, the client gets their
   * status, and the package goes to the owner if the files they have sent now cover every document they have.
   */
  async finishMissing(api: Api, userId: number): Promise<void> {
    this.#api = api;
    const language = this.history.lastLanguage(DIRECT_HISTORY_ID, userId);
    const { total, docs, missing } = this.#packageSpec(language, userId);
    const chat: ChatContext = {
      target: { kind: "direct" },
      historyId: DIRECT_HISTORY_ID,
      chatId: userId,
      chatKey: HistoryStore.key(DIRECT_HISTORY_ID, userId),
      chatName: this.personTitle(userId),
      incoming: "[button] ✅ Tayyor",
      language,
    };
    const marked = docs.flatMap((doc, i) => (missing.has(i) ? [`${i + 1}. ${doc.title}`] : []));
    this.#remember(DIRECT_HISTORY_ID, userId, {
      role: "other",
      name: this.users.list().find((known) => known.id === userId)?.name ?? `ID ${userId}`,
      text: `[button] Menda yo'q hujjatlar: ${marked.length > 0 ? marked.join("; ") : "hech biri belgilanmadi"}`,
      lang: language,
    });
    log(`Chat ${chat.chatName} (${userId}): ${missing.size} document(s) marked as missing, ${total} file(s) needed.`);
    await this.#deliver(api, chat, this.clientProgressText(userId, language, { hint: false }), this.clientKeyboardFor(userId));
    await this.#locks.run(`files:${userId}`, async () => {
      const before = this.folders.status(userId).received.length;
      await this.#sendPackageIfComplete(api, userId, before);
    });
  }

  /** Downloads a client's file into their inbox and (re)starts the batch timer. */
  async #queueFile(api: Api, message: Message, chat: ChatContext): Promise<void> {
    const file = fileOf(message);
    if (!file) return;
    const lang = chat.language ?? "uz";
    const refuse = async (reason: string): Promise<void> => {
      this.folders.refuse(chat.chatId, file.name, reason);
      await this.#deliver(api, chat, `❌ ${file.name}: ${reason}.`);
    };
    const maxBytes = this.settings.maxFileMb * 1024 * 1024;
    if (file.size !== undefined && file.size > maxBytes) {
      log(`Chat ${chat.chatName} (${chat.chatId}): ${file.name} is larger than MAX_FILE_MB (${this.settings.maxFileMb}).`);
      await refuse(TOO_LARGE_REASON[lang](this.settings.maxFileMb));
      return;
    }
    const kept =
      (this.folders.exists(chat.chatId) ? this.folders.status(chat.chatId).received.length : 0) +
      this.inbox.read(chat.chatId).files.length;
    if (kept >= MAX_FILES_PER_CLIENT) {
      log(`Chat ${chat.chatName} (${chat.chatId}): ${file.name} refused, already ${kept} files (MAX_FILES_PER_CLIENT).`);
      await refuse(TOO_MANY_REASON[lang](MAX_FILES_PER_CLIENT));
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

    const workdir = path.join(this.settings.dataDir, "downloads");
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
      const batchChat: ReviewChat = {
        target: chat.target,
        chatId: chat.chatId,
        chatName: chat.chatName,
        language: chat.language,
        ...(chat.threadId !== undefined ? { threadId: chat.threadId } : {}),
      };
      this.inbox.add(batchChat, tmp, file.name, message.message_id, this.#clock(), file.fileId);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      logError(`Could not download ${file.name} from chat ${chat.chatId}: ${errorMessage(err)}`);
      await refuse(DOWNLOAD_FAILED_REASON[lang]);
      return;
    }
    log(`Chat ${chat.chatName} (${chat.chatId}): ${file.name} received.`);
    this.#scheduleBatch(chat.chatId, this.#batchDelayMs);
  }

  #scheduleBatch(userId: number, delayMs: number): void {
    const existing = this.#batchTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#batchTimers.delete(userId);
      void this.#startBatch(userId);
    }, Math.max(0, delayMs));
    timer.unref();
    this.#batchTimers.set(userId, timer);
  }

  #startBatch(userId: number): Promise<void> {
    const run = this.#locks
      .run(`files:${userId}`, () => this.#fileBatch(userId))
      .catch((err: unknown) => logError(`Handling the files of chat ${userId} failed: ${errorMessage(err)}`))
      .finally(() => {
        if (this.#batchRuns.get(userId) === run) this.#batchRuns.delete(userId);
      });
    this.#batchRuns.set(userId, run);
    return run;
  }

  /**
   * Collects everything of the last 24 hours (new clients, messages, files, packages) into one text file and sends
   * it to the admin. When nothing happened, the admin gets a short "no changes" message instead.
   */
  async sendDailyReport(api: Api): Promise<void> {
    const now = this.#clock();
    const since = now - REPORT_WINDOW_SECONDS;
    const inWindow = (ts: number): boolean => ts > since && ts <= now;
    const clients: ReportClient[] = this.users.list().map((user) => {
      const status = this.folders.exists(user.id) ? this.folders.status(user.id) : null;
      return {
        title: this.personTitle(user.id),
        id: user.id,
        isNew: inWindow(user.firstSeen),
        messages: this.transcripts
          .forChat(user.id)
          .filter((item) => inWindow(item.ts))
          .map((item) => ({ ts: item.ts, who: item.role === "other" ? item.name : this.settings.companyName, text: item.text })),
        files: (status?.received ?? []).filter((f) => inWindow(f.ts)).map((f) => ({ ts: f.ts, name: f.name })),
        progress: this.#receivedCount(user.id),
        packageSent: status?.packageSentAt != null && inWindow(status.packageSentAt),
      };
    });
    const report = buildDailyReport(clients, since, now, this.settings.companyName);
    if (report.hasChanges) {
      const insights = await this.#dailyInsights(report.text);
      const name = `hisobot-${tashkentDate(now)}.txt`;
      const text = insights ? `${report.text}\n\n=== AI xulosasi va tavsiyalar ===\n${insights}\n` : report.text;
      await this.#toAdmins("the daily report", async (adminId) => {
        await api.sendDocument(adminId, new InputFile(Buffer.from(text, "utf8"), name), {
          caption: `📋 Kunlik hisobot: ${tashkentDate(now)}`,
        });
        if (insights) {
          for (const chunk of splitMessage(`🧠 Kunlik tahlil (${tashkentDate(now)})\n\n${insights}`)) await api.sendMessage(adminId, chunk);
        }
      });
    } else {
      await this.#toAdmins("the daily report", (adminId) =>
        api.sendMessage(adminId, `📋 Kunlik hisobot (${tashkentDate(now)}): oxirgi 24 soatda hech qanday o'zgarish yo'q.`),
      );
    }
    this.#dbWrite("task", (db) => db.markTaskRun("daily_report", report.hasChanges ? "sent" : "no_changes"));
    log(`Daily report sent to the admins (${report.hasChanges ? "with changes" : "no changes"}).`);
  }

  /** The AI's conclusions and recommendations on the day (empty when no provider is available). */
  async #dailyInsights(reportText: string): Promise<string> {
    if (!this.ai) return "";
    try {
      const response = await this.ai.chat({
        purpose: "daily-report",
        tier: "main",
        maxTokens: 1500,
        system:
          `You analyse the daily activity report of «${this.settings.companyName}»'s customer Telegram bot for its admins. ` +
          "Write in Uzbek (Latin script), Telegram plain text, no Markdown. Structure: Qisqacha xulosa; Asosiy ko'rsatkichlar; " +
          "Savdo imkoniyatlari (which customers are closest to a deal and why); Muammolar (complaints, unanswered questions, " +
          "stuck document packages); Tavsiyalar (concrete next actions, with customer names). Use only facts from the report; " +
          "do not invent numbers. At most 2500 characters.",
        messages: [{ role: "user", content: reportText.slice(0, 60_000) }],
      });
      return response.text.trim();
    } catch (err) {
      logError(`The daily AI analysis failed (the plain report is sent): ${errorMessage(err)}`);
      return "";
    }
  }

  /**
   * Sends a zip of the data directory to the admin (see backup.ts), so that a lost volume can be restored.
   * Nothing is sent while nobody has written to the bot yet.
   */
  async sendBackup(api: Api): Promise<void> {
    const dir = this.settings.dataDir;
    if (this.users.list().length === 0) return;
    const backup = await buildBackup(dir);
    if (backup.buffer.length > 49 * 1024 * 1024) {
      logError(`The backup is ${Math.round(backup.buffer.length / 1024 / 1024)} MB, over Telegram's 50 MB limit; it was not sent.`);
      return;
    }
    const date = tashkentDate(this.#clock());
    const note = backup.skipped > 0 ? `\n${backup.skipped} ta hujjat hajm chegarasi tufayli kirmadi (ro'yxati arxiv ichida).` : "";
    await this.#toAdmins("the backup", (adminId) =>
      api.sendDocument(adminId, new InputFile(backup.buffer, `zaxira-${date}.zip`), {
        caption: `💾 Zaxira nusxa: ${date}\n${backup.included} ta fayl, ${(backup.buffer.length / 1024 / 1024).toFixed(1)} MB.${note}\nTiklash: arxivni botning data papkasiga (Railway'da /app/data) joylang. Suhbatlar PostgreSQL'da ham saqlanadi.`,
      }),
    );
    log(`Backup sent to the admin (${backup.included} files, ${backup.skipped} left out).`);
  }

  /**
   * Sends the daily report once a day, at DAILY_REPORT_HOUR Tashkent time (or at the first check after it, e.g.
   * after a restart). The date of the last report is kept in state.json, so a restart never sends it twice.
   */
  startDailyReport(api: Api): NodeJS.Timeout {
    const check = async (): Promise<void> => {
      const now = this.#clock();
      const today = tashkentDate(now);
      if (this.state.lastReportDate === today || tashkentHour(now) < this.settings.dailyReportHour) return;
      this.state.lastReportDate = today; // before sending, so a slow send is not started twice
      try {
        await this.sendDailyReport(api);
      } catch (err) {
        this.state.lastReportDate = "";
        logError(`The daily report could not be sent (will retry): ${errorMessage(err)}`);
        return;
      }
      try {
        await this.sendBackup(api);
      } catch (err) {
        logError(`The backup could not be sent: ${errorMessage(err)}`);
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    timer.unref();
    return timer;
  }

  /** Handles waiting files now instead of after the batch delay, and waits until every batch is done (tests, /resume). */
  async flushFiles(api?: Api): Promise<void> {
    if (api) this.#api = api;
    for (const [userId, timer] of this.#batchTimers) {
      clearTimeout(timer);
      this.#batchTimers.delete(userId);
    }
    const waiting = new Set([...this.inbox.pending(), ...this.#batchRuns.keys()]);
    await Promise.all([...waiting].map((userId) => this.#batchRuns.get(userId) ?? this.#startBatch(userId)));
  }

  /** After a restart: files that were waiting in the inbox are handled. */
  resumePendingFiles(api: Api): void {
    this.#api = api;
    for (const userId of this.inbox.pending()) this.#scheduleBatch(userId, this.#batchDelayMs);
  }

  /**
   * Moves every file of a client's inbox to received/, tells the client how many of the 14 have arrived, and
   * passes the package to the owner once it is complete. Files are not checked.
   */
  async #fileBatch(userId: number): Promise<void> {
    const api = this.#api;
    const data = this.inbox.read(userId);
    if (!api || !data.chat || data.files.length === 0) return;
    if (this.state.paused) return; // handled after /resume

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

    const before = this.folders.status(userId).received.length;
    const added: InboxFile[] = [];
    for (const file of data.files) {
      // The owner deleted this chat meanwhile.
      if (!this.folders.exists(userId)) return;
      try {
        this.folders.receive(userId, this.inbox.path(userId, file), file.name, file.fileId);
        added.push(file);
      } catch (err) {
        logError(`Could not save ${file.name} for chat ${userId}: ${errorMessage(err)}`);
      }
      this.inbox.remove(userId, file);
    }
    if (added.length === 0) return;

    const { total } = this.#packageSpec(lang, userId);
    const received = before + added.length;
    const hint = chat.target.kind === "direct";
    const summary = `${RECEIVED_WORDS[lang](added.map((f) => f.name))}\n\n${this.clientProgressText(userId, lang, { hint })}`;
    // While the owner is answering this client, the summary waits in the logs (previews) instead.
    const ownerActive = this.#blocked(chat.chatKey) === Outcome.owner_active;
    const sent =
      !ownerActive &&
      (await this.#deliver(api, chat, summary, chat.target.kind === "direct" ? this.clientKeyboardFor(userId) : undefined));
    if (!sent && ownerActive) this.#showPreview({ ...this.#previewOf(chat, summary), note: "not sent: the owner is answering" });
    log(
      `Chat ${chat.chatName} (${userId}): ${added.length} file(s) received, ${received}/${total} in all` +
        `${sent ? "" : " (summary not sent)"}.`,
    );
    await this.#sendPackageIfComplete(api, userId, before);
  }

  /**
   * The owner hears about a client's files only once the package is complete: one file per required document the
   * client has (14, less the ones marked «❌ Menda yo'q»). Then the whole package goes to them at once: one 🎉
   * message (with the missing documents), then every file in albums of up to 10. Files that come after that are
   * passed on one by one as extras. Nothing is sent before, however long the client takes.
   */
  async #sendPackageIfComplete(api: Api, userId: number, before: number): Promise<void> {
    const { total, docs, missing } = this.#packageSpec("uz", userId);
    const files = this.folders.receivedFiles(userId);
    const count = this.folders.status(userId).received.length;
    if (count < total || count === 0) return;
    const who = this.personTitle(userId);
    try {
      if (this.folders.markPackageSent(userId)) {
        const absent = docs.flatMap((doc, i) => (missing.has(i) ? [`• ${i + 1}. ${doc.title}`] : []));
        this.#dbWrite("pipeline", (db) => db.updatePipeline(userId, { stage: "documents_sent" }));
        await this.#toAdmins("the package", async (adminId) => {
          await api.sendMessage(
            adminId,
            `🎉 Yangi to'liq paket: ${who}\nMijoz ${count} ta fayl yubordi (kerak: ${total} ta). Fayllar quyida. ` +
              "Bot fayllarni tekshirmagan." +
              (absent.length > 0 ? `\n\n❌ Mijozda yo'q hujjatlar (${absent.length} ta):\n${absent.join("\n")}` : ""),
            { reply_markup: folderKeyboard(userId) },
          );
          await this.#sendAlbumsToOwner(api, adminId, files, total, `👤 ${who}`);
        });
        log(`Chat ${userId}: the package is complete; ${files.length} file(s) sent to the owner.`);
        return;
      }
      // The package already went to the owner: this batch's files are extras.
      for (const file of files.filter((f) => f.number > before)) {
        await this.#toAdmins("an extra file", (adminId) =>
          this.#sendFileToOwner(api, adminId, file, `🔄 Qo'shimcha fayl (${file.number}-fayl): ${file.name}\n👤 ${who}`),
        );
      }
    } catch (err) {
      logError(`Could not send the package of chat ${userId} to the owner: ${errorMessage(err)}`);
    }
  }

  /** The owner's 📎 button: the client's status and every file they sent. Returns how many files were sent. */
  async sendAcceptedFilesToOwner(api: Api, userId: number, adminId: number = this.settings.ownerId): Promise<number> {
    const files = this.folders.receivedFiles(userId);
    if (files.length === 0) return 0;
    await api.sendMessage(adminId, this.clientProgressText(userId, "uz"));
    await this.#sendAlbumsToOwner(api, adminId, files, this.#packageSpec("uz", userId).total, "");
    return files.length;
  }

  /**
   * Sends files to the owner as albums of up to 10 (a Telegram limit), each captioned "📄 3/14 — name". Files go by
   * their Telegram file_id when known (no re-upload, any size). If an album cannot be sent, its files are sent one
   * by one instead.
   */
  async #sendAlbumsToOwner(api: Api, adminId: number, files: PackageFile[], total: number, footer: string): Promise<void> {
    const captionOf = (file: PackageFile): string =>
      truncate([`📄 ${file.number}/${total} — ${file.name}`, ...(footer ? [footer] : [])].join("\n"), 1000);
    for (let i = 0; i < files.length; i += ALBUM_SIZE) {
      const chunk = files.slice(i, i + ALBUM_SIZE);
      if (chunk.length >= 2) {
        try {
          await api.sendMediaGroup(
            adminId,
            chunk.map((file) =>
              InputMediaBuilder.document(file.fileId ?? new InputFile(file.file, file.name), { caption: captionOf(file) }),
            ),
          );
          continue;
        } catch (err) {
          logError(`Sending an album of ${chunk.length} file(s) failed (${errorMessage(err)}); sending them one by one.`);
        }
      }
      for (const file of chunk) await this.#sendFileToOwner(api, adminId, file, captionOf(file));
    }
  }

  /**
   * Sends a saved file to the owner by its Telegram file_id when known (no re-upload, works for any size),
   * otherwise uploads the saved copy (Bot API uploads are limited to 50 MB).
   */
  async #sendFileToOwner(api: Api, adminId: number, file: Pick<PackageFile, "file" | "name" | "fileId">, caption: string): Promise<void> {
    const options = { caption: truncate(caption, 1000) };
    if (file.fileId) {
      try {
        await api.sendDocument(adminId, file.fileId, options);
        return;
      } catch (err) {
        logError(`Sending ${file.name} by file_id failed (${errorMessage(err)}); uploading the saved copy.`);
      }
    }
    await api.sendDocument(adminId, new InputFile(file.file, file.name), options);
  }


  async #connectionProblem(api: Api, connectionId: string): Promise<string> {
    try {
      const fresh = await api.getBusinessConnection(connectionId);
      this.#connections.set(connectionId, fresh);
      if (!this.isAdmin(fresh.user.id)) return "the connection belongs to another account";
      if (!fresh.is_enabled) return "the connection is disabled";
      if (!canReply(fresh)) return "the bot has no permission to reply in this account";
      return "";
    } catch (err) {
      return `could not re-check the connection (${errorMessage(err)})`;
    }
  }

  async #onGenerateError(api: Api, chat: ChatContext, err: unknown): Promise<{ outcome: Outcome; note: string }> {
    if (err instanceof AllProvidersDownError) {
      // Nothing is lost: the message waits in the queue and is answered (once) when a provider is back.
      const key = chat.incomingKey ?? `${chat.chatKey}:${Math.round(this.#clock())}`;
      const stored = { ...chat, incomingKey: key };
      if (this.db) {
        const db = this.db;
        this.#dbWrite("pending reply", () => db.enqueuePending(key, chat.chatId, stored as unknown as Record<string, unknown>, err.message));
      } else {
        this.#pendingMemory.set(key, stored);
      }
      logError(`Chat ${chat.chatName} (${chat.chatId}): ${err.message}. The message is queued.`);
      return { outcome: Outcome.queued, note: "AI providerlar ishlamayapti, xabar navbatda" };
    }
    logError(`Generating a reply for chat ${chat.chatName} failed: ${errorMessage(err)}`);
    if (this.settings.autoSend) {
      await this.#notifyAdmins(
        api,
        "error",
        `⚠️ Bot "${chat.chatName}" chatidagi xabarga javob tayyorlay olmadi, mijozga hech narsa yuborilmadi.\n\n` +
          `Sabab: ${truncate(errorMessage(err), 500)}`,
        replyKeyboard(chat.chatId),
      );
    }
    return { outcome: Outcome.error, note: truncate(errorMessage(err), 300) };
  }

  /**
   * Retries the messages that waited while every AI provider was down. Each is answered at most once (the reply
   * check in #respond); a message the person followed up on is covered by the reply to the newer one.
   */
  async processPending(api: Api): Promise<number> {
    this.#api = api;
    let entries: { key: string; chat: ChatContext }[];
    if (this.db) {
      await this.dbIdle();
      entries = (await this.db.pendingReplies(20)).map((p) => ({ key: p.incomingKey, chat: p.chat as unknown as ChatContext }));
    } else {
      entries = [...this.#pendingMemory].map(([key, chat]) => ({ key, chat }));
    }
    let answered = 0;
    for (const { key, chat } of entries) {
      if (!chat || typeof chat.chatId !== "number" || !this.users.list().some((u) => u.id === chat.chatId)) {
        await this.#finishPending(key);
        continue;
      }
      // The conversation went on and was answered meanwhile (by the bot or an admin): no late reply out of order.
      if (this.transcripts.forChat(chat.chatId).at(-1)?.role === "owner") {
        await this.#finishPending(key);
        continue;
      }
      const outcome = (await this.#locks.run(chat.chatKey, () => this.#respond(api, { ...chat, incomingKey: key }))).outcome;
      if (outcome === Outcome.queued) break; // still down: try again later, in order
      if (outcome === Outcome.owner_active || outcome === Outcome.paused) continue;
      await this.#finishPending(key);
      answered++;
    }
    if (answered > 0) log(`Answered ${answered} queued message(s).`);
    return answered;
  }

  async #finishPending(key: string): Promise<void> {
    this.#pendingMemory.delete(key);
    if (this.db) {
      const db = this.db;
      this.#dbWrite("pending done", () => db.finishPending(key));
      await this.dbIdle();
    }
  }

  startPendingWorker(api: Api): NodeJS.Timeout {
    this.#api = api;
    const timer = setInterval(() => {
      void this.processPending(api).catch((err: unknown) => logError(`Processing the queue failed: ${errorMessage(err)}`));
    }, PENDING_RETRY_SECONDS * 1000);
    timer.unref();
    return timer;
  }

  /** The API to use for notifications that do not come from an update (provider switches, scheduled work). */
  attachApi(api: Api): void {
    this.#api = api;
  }

  /** Tells the admins when Claude stops or comes back, or when no AI provider answers (TZ 16.4). */
  async notifyProviderSwitch(event: SwitchEvent): Promise<void> {
    const api = this.#api;
    const text =
      event.kind === "primary_down"
        ? `⚠️ Claude ishlamayapti (${event.failure.kind}). Bot avtomatik Gemini'ga o'tdi; suhbatlar konteksti saqlanadi. ` +
          `Claude har ${this.settings.aiProbeMinutes} daqiqada qayta tekshiriladi.\nSabab: ${truncate(event.failure.message, 300)}`
        : event.kind === "primary_restored"
          ? "✅ Claude tiklandi. Bot yana Claude orqali ishlayapti."
          : `🚨 Claude ham, Gemini ham javob bermayapti. Mijozlarning xabarlari navbatda saqlanadi va provayder tiklanishi ` +
            `bilan bir martadan javob beriladi.\n${event.failures.map((f) => `• ${f.provider}: ${f.kind} — ${truncate(f.message, 200)}`).join("\n")}`;
    log(`AI provider event: ${event.kind}`);
    this.#dbWrite("audit", (db) => db.audit("system", `ai_${event.kind}`, { text }));
    if (api) await this.#notifyAdmins(api, `provider:${event.kind}`, text);
  }

  async #alertEscalation(api: Api, chat: ChatContext): Promise<void> {
    log(`Chat ${chat.chatName}: the message was escalated to the admins.`);
    await this.#notifyAdmins(
      api,
      `escalate:${chat.chatKey}`,
      `🚨 Muhim murojaat: "${chat.chatName}" chati\n\nMurojaatchi xabari:\n${truncate(chat.incoming, 500)}\n\n` +
        `Iltimos, darhol ko'rib chiqing.`,
      replyKeyboard(chat.chatId),
    );
  }

  /** A customer asked the price: a lead for the admins (internal notification, TZ 19.4). */
  async #alertPriceLead(api: Api, chat: ChatContext, brain: BrainResult): Promise<void> {
    const services = brain.analysis.services.length > 0 ? brain.analysis.services.join(", ") : "aniqlanmagan";
    await this.#notifyAdmins(
      api,
      `price:${chat.chatKey}`,
      `💰 Narx so'radi: ${this.personTitle(chat.chatId)}\nXizmat: ${services}\nXabar: ${truncate(chat.incoming, 400)}\n\n` +
        "Bot mijozga price-list'dagi taxminiy narxni va kontaktlarni berdi.",
      replyKeyboard(chat.chatId),
    );
  }

  /** Runs a send for every admin; one admin's failure (blocked bot) does not stop the others. */
  async #toAdmins(label: string, send: (adminId: number) => Promise<unknown>): Promise<void> {
    for (const adminId of this.#admins) {
      try {
        await send(adminId);
      } catch (err) {
        logError(`Could not send ${label} to admin ${adminId}: ${errorMessage(err)}`);
      }
    }
  }

  /** Sends a private message from the bot to every admin, at most once per 10 minutes per key. */
  async #notifyAdmins(api: Api, key: string, text: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
    const now = this.#clock();
    const last = this.#ownerAlerts.get(key);
    if (last !== undefined && now - last < OWNER_ALERT_INTERVAL_SECONDS) return;
    this.#ownerAlerts.set(key, now);
    await this.#toAdmins("a notification", (adminId) => api.sendMessage(adminId, text, keyboard ? { reply_markup: keyboard } : {}));
  }

  /** Passes a message someone sent to the bot on to the admins, with a ✍️ reply button. */
  async #passToOwner(api: Api, message: Message, chat: ChatContext, ownerActive: boolean): Promise<void> {
    const who = this.personTitle(chat.chatId);
    const quiet = ownerActive ? "\n(Admin javob berayotgani uchun bot jim turibdi. Tugatilsa, «✖️ Tugatish» ni bosing.)" : "";
    await this.#toAdmins("a message", async (adminId) => {
      if (message.text !== undefined) {
        await api.sendMessage(adminId, `💬 ${who}:\n${truncate(message.text, 3500)}${quiet}`, {
          reply_markup: replyKeyboard(chat.chatId),
        });
        return;
      }
      await api.forwardMessage(adminId, chat.chatId, message.message_id);
      await api.sendMessage(adminId, `📎 ${who} fayl yubordi.${quiet}`, { reply_markup: replyKeyboard(chat.chatId) });
    });
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

  /**
   * Stores one message everywhere: the short history, the transcripts (JSON), chat.txt and PostgreSQL (with its
   * embedding for semantic search). `author` tells bot replies from admin replies in the database.
   */
  #remember(historyId: string, chatId: number, item: Omit<HistoryItem, "ts">, author: "bot" | "admin" = "bot"): void {
    const ts = this.#clock();
    this.history.add(historyId, chatId, item, ts);
    try {
      this.transcripts.add(historyId, chatId, item, ts);
    } catch (err) {
      logError(`Could not update the transcripts: ${errorMessage(err)}`);
    }
    try {
      this.folders.appendChat(chatId, item.role === "other" ? item.name : this.settings.companyName, item.text);
    } catch (err) {
      logError(`Could not update chat.txt of chat ${chatId}: ${errorMessage(err)}`);
    }
    const fromCustomer = item.role === "other";
    this.#dbWrite("message", async (db) => {
      if (fromCustomer) await db.touchCustomer(chatId, item.name, "", item.lang, ts);
      const id = await db.addMessage({
        customerId: chatId,
        source: historyId,
        role: fromCustomer ? "customer" : author,
        author: item.name,
        text: item.text,
        language: item.lang,
        ts,
        importKey: messageKey(historyId, chatId, ts, fromCustomer, item.text),
      });
      // Embeddings are made in the background: a slow Gemini call never delays a reply.
      const memory = this.memory;
      if (id !== null && memory) this.#track(memory.index({ id, customerId: chatId, text: item.text }));
    });
  }

  /**
   * The owner's 🗑: forgets everything about this client — history, transcripts, the users list entry and the whole
   * client folder (chat.txt, received files, files waiting in the inbox). Returns their name.
   */
  deleteChat(userId: number, adminId: number | null = null): string {
    const name = this.personTitle(userId);
    const timer = this.#batchTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.#batchTimers.delete(userId);
    this.transcripts.removeChat(userId);
    this.history.removeChat(userId);
    this.users.remove(userId);
    this.folders.delete(userId);
    for (const [admin, target] of Object.entries(this.state.replyModes)) {
      if (target === userId) this.state.setReplyMode(Number(admin), null);
    }
    this.#pendingMemory.forEach((chat, key) => {
      if (chat.chatId === userId) this.#pendingMemory.delete(key);
    });
    this.#dbWrite("delete customer", (db) => db.deleteCustomer(userId));
    if (adminId !== null) this.#dbWrite("admin action", (db) => db.adminAction(adminId, "delete_chat", String(userId)));
    log(`An admin deleted the chat and folder of ${userId}.`);
    return name;
  }

  #rememberUser(message: Message): void {
    const from = message.from;
    if (!from || this.isAdmin(from.id)) return;
    try {
      this.users.touch(from.id, senderName(message), from.username ?? "");
    } catch (err) {
      logError(`Could not update the users list: ${errorMessage(err)}`);
    }
    const name = senderName(message);
    const username = from.username ?? "";
    const ts = this.#clock();
    this.#dbWrite("customer", (db) => db.touchCustomer(from.id, name, username, null, ts));
  }

  /**
   * The owner's "users" list as HTML messages, each with one 📁 folder button per user
   * (under Telegram's 4096-character and 100-button limits).
   */
  usersListMessages(): UsersListPage[] {
    const users = this.users.list();
    if (users.length === 0) {
      return [{ text: "👥 Hozircha botga hech kim yozmagan.", buttons: [] }];
    }
    const header =
      `👥 Mijozlar: ${users.length} ta (yangilari tepada)\n` +
      "📁 Yozishmani ko'rish uchun mijoz tugmasini bosing.\n";
    const pages: UsersListPage[] = [];
    let current: UsersListPage = { text: header, buttons: [] };
    users.forEach((user, i) => {
      const name = `<a href="tg://user?id=${user.id}">${escapeHtml(user.name)}</a>`;
      const username = user.username ? ` @${escapeHtml(user.username)}` : "";
      const ready = this.#receivedCount(user.id);
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
    const documents = this.#receivedCount(userId) !== null ? `\n${this.clientProgressText(userId, "uz")}\n` : "";
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
    // Files that waited while the bot was paused or limited.
    if (this.#api) this.resumePendingFiles(this.#api);
  }

  modeText(): string {
    return this.settings.autoSend ? "AUTO-SEND" : "PREVIEW";
  }

  statusText(): string {
    const mode = this.settings.autoSend
      ? "AUTO-SEND (javoblar mijozlarga yuboriladi)"
      : "PREVIEW (javoblar faqat logda, mijozga yuborilmaydi)";
    const ai = this.ai?.status();
    const provider = !ai
      ? "sozlanmagan"
      : ai.active === null
        ? "hech biri sozlanmagan (ANTHROPIC_API_KEY / GEMINI_API_KEY)"
        : `${ai.active}${ai.circuitOpen ? ` (Claude ishlamayapti, keyingi tekshiruv ${ai.nextProbeAt ? tashkentTime(ai.nextProbeAt / 1000) : "—"})` : ""}`;
    const answering = Object.entries(this.state.replyModes).map(([admin, user]) => `${admin} → ${this.personTitle(user)}`);
    return [
      `Korxona: ${this.settings.companyName}`,
      `Rejim: ${mode}`,
      `Holat: ${this.state.paused ? "pauzada" : "ishlayapti"}`,
      `AI: ${provider}`,
      `Baza: ${this.db ? `PostgreSQL (${this.db.vectorMode === "pgvector" ? "pgvector" : "vektorlar real[]"})` : "ulanmagan — faqat JSON fayllar, Admin AI ishlamaydi"}`,
      `Adminlar: ${this.adminIds.join(", ")}`,
      `✍️ javob rejimida: ${answering.length > 0 ? answering.join("; ") : "hech kim"}`,
      `Mijozlar: ${this.users.list().length}`,
      `Data papka: ${this.settings.dataDir}`,
      "Ma'lumotlar muddatsiz saqlanadi; faqat admin 🗑 bilan o'chiradi.",
    ].join("\n");
  }

  startText(): string {
    const s = this.settings;
    const mode = s.autoSend
      ? "AUTO-SEND — javoblar mijozlarga avtomatik yuboriladi"
      : "PREVIEW — javoblar mijozlarga yuborilmaydi, faqat logda ko'rinadi";
    const state = this.state.paused ? "pauzada (/resume bilan yoqing)" : "ishlayapti";
    const lines = [
      "Assalomu alaykum!",
      "",
      `Bu bot «${s.companyName}» korxonasining raqamli yordamchisi. Botga yozgan har bir mijozga u AI (Claude, zaxirada ` +
        "Gemini) orqali company.md, narxlar ro'yxati va mijozning butun oldingi yozishmasi asosida o'zi javob beradi.",
      "",
      "Hozirgi holat:",
      `• Rejim: ${mode}`,
      `• Holat: ${state}`,
      "",
      "Siz (admin) uchun:",
      "• Shu chatga oddiy o'zbek tilida yozing — bu Admin AI yordamchisi. Masalan: «Bugun nechta mijoz bilan " +
        "gaplashildi?», «Eng ko'p yozishgan 20 ta mijozni ko'rsat», «Birinchi mijoz haqida batafsil», «U oxirgi marta " +
        "nimani so'ragan?», «Narx so'ragan mijozlar», «Oxirgi 30 kunlik hisobotni PDF qilib ber». Javoblar haqiqiy " +
        "bazadan olinadi, xulosa va tavsiyalar bilan.",
      "• Mijozlarning oddiy xabarlari sizga yuborilmaydi. Faqat 🚨 muhim murojaatlar, 💰 narx so'rovlari, fayllar va " +
        "to'liq hujjat paketlari keladi.",
      "• Mijozdan 14 ta hujjat so'raladi: " + DOCUMENTS_UZ.map((d, i) => `${i + 1}. ${d}`).join("; ") + ". Bot fayllarni " +
        "TEKSHIRMAYDI: saqlaydi, sanaydi va mijozga «N/14» deb yozadi. Mijozda yo'q hujjatlar «❌ Menda yo'q hujjatlar» " +
        "bilan belgilanadi. Hammasi kelganda sizga 🎉 xabar va butun paket keladi.",
      "• «users» — mijozlar ro'yxati; mijozni bossangiz yozishma, hujjatlar holati va «✍️ Javob yozish», «📄 chat.txt», " +
        "«📎 Qabul qilingan fayllar», «🗑 Chatni o'chirish» tugmalari chiqadi.",
      "• «✍️ Javob yozish» bosilgach, yozganlaringiz shu mijozga boradi va bot u bilan jim turadi — «✖️ Tugatish» " +
        "bosilguncha (taymer yo'q). Shu vaqtda mijoz yozsa, xabari sizga keladi.",
      "",
      "Buyruqlar:",
      "/pause — botni to'xtatish",
      "/resume — qayta yoqish",
      "/status — holat (AI provayder, baza, adminlar)",
      "/cancel — javob rejimini yopish",
      "/new — Admin AI bilan yangi mavzu (oldingi kontekstni unutadi)",
      "",
      "Bilib qo'ying:",
      "• Narx so'ralsa, bot faqat price-list'dagi summa va muddatni aytadi, ogohlantirish matni va kontaktlar bilan. " +
        "Ro'yxatda yo'q xizmatga narx aytmaydi.",
      "• Bot «mas'ul xodim javob beradi» demaydi: o'zi javob beradi, tasdiqlay olmagan narsani ochiq aytadi.",
      "• Claude ishlamasa, bot avtomatik Gemini'ga o'tadi va Claude'ni har " +
        `${s.aiProbeMinutes} daqiqada qayta tekshiradi. Ikkalasi ham ishlamasa, xabarlar navbatda kutadi.`,
      "• Ma'lumotlar muddatsiz saqlanadi. Faqat siz «🗑» bilan o'chirsangiz o'chadi.",
      "• Korxona haqidagi ma'lumotlar company.md, narxlar knowledge/prices.json faylida.",
    ];
    if (!s.autoSend) {
      lines.push("• Hozir PREVIEW rejimi: javoblarni tekshirib bo'lgach, avtomatik yuborish uchun AUTO_SEND=true qiling.");
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

/** Claude (primary) and Gemini (backup) from the settings; null when neither key is set. */
export function makeProviderManager(
  settings: Settings,
  hooks: { onLog?: ConstructorParameters<typeof AIProviderManager>[0]["onLog"]; onSwitch?: (event: SwitchEvent) => void } = {},
): { ai: AIProviderManager | null; gemini: GeminiProvider | null } {
  const claude = settings.anthropicApiKey
    ? new ClaudeProvider({ apiKey: settings.anthropicApiKey, mainModel: settings.claudeModel, fastModel: settings.claudeModelFast })
    : null;
  const gemini = settings.geminiApiKey
    ? new GeminiProvider({
        apiKey: settings.geminiApiKey,
        mainModel: settings.geminiModel,
        fastModel: settings.geminiModelFast,
        embeddingModel: settings.geminiEmbeddingModel,
      })
    : null;
  if (!claude && !gemini) return { ai: null, gemini: null };
  return {
    ai: new AIProviderManager({
      primary: claude,
      backup: gemini,
      timeoutMs: settings.aiTimeoutSeconds * 1000,
      probeIntervalMs: settings.aiProbeMinutes * 60_000,
      ...(hooks.onLog ? { onLog: hooks.onLog } : {}),
      ...(hooks.onSwitch ? { onSwitch: hooks.onSwitch } : {}),
    }),
    gemini,
  };
}

export interface BuildOptions extends AssistantOptions {
  /** Offline tests: a scripted generator instead of Claude/Gemini. */
  generator?: ReplyGenerator;
  brain?: CustomerBrain;
  embedder?: Embedder | null;
}

/**
 * Wires the modules together: AI Provider Manager -> Memory Manager -> Orchestrator (customer replies) and Admin AI
 * Assistant. With a scripted generator (tests) only the simple reply path is used.
 */
export function buildAssistant(settings: Settings, opts: BuildOptions = {}): Assistant {
  const db = opts.db ?? null;
  let assistant: Assistant | null = null;
  let ai = opts.ai ?? null;
  let embedder: Embedder | null = opts.embedder ?? null;
  if (!ai && !opts.generator && !opts.brain) {
    const built = makeProviderManager(settings, {
      onLog: (entry) => {
        if (!entry.ok) logError(`AI ${entry.provider}/${entry.model} ${entry.purpose} failed (${entry.failure}, attempt ${entry.attempt}): ${entry.error}`);
        if (db) void db.logProvider(entry).catch(() => undefined);
      },
    });
    ai = built.ai;
    if (opts.embedder === undefined) embedder = built.gemini;
  }
  let priceCache: { at: number; list: PriceList | null } = { at: 0, list: null };
  const priceList = (): PriceList | null => {
    // Read again at most once a minute, so a changed price list is used without a restart.
    if (Date.now() - priceCache.at > 60_000) priceCache = { at: Date.now(), list: loadPriceList(settings.pricesPath) };
    return priceCache.list;
  };
  const memory = opts.memory ?? (db ? new MemoryManager(db, ai, embedder, log) : null);
  const brain =
    opts.brain ??
    (opts.generator
      ? new SimpleBrain(opts.generator)
      : ai
        ? new Orchestrator({ ai, db, memory, priceList, log })
        : new SimpleBrain({
            generate: () => Promise.reject(new AllProvidersDownError([])),
          }));
  const admin =
    opts.admin ??
    (db && ai
      ? new AdminAssistant({
          db,
          ai,
          companyName: settings.companyName,
          priceList,
          documentStatus: (id) => assistant?.documentStatus(id) ?? null,
          reportFontPath: settings.reportFontPath,
          log,
          ...(opts.clock ? { now: opts.clock } : {}),
        })
      : null);
  assistant = new Assistant(settings, brain, { ...opts, db, ai, memory, admin });
  const built = assistant;
  ai?.subscribe((event) => void built.notifyProviderSwitch(event));
  return assistant;
}

/**
 * Language of what the person wrote (text or caption). A file without a caption has none: its "[document] name"
 * description is not their language, so the chat's last language is used instead.
 */
function languageOf(message: Message): Language | null {
  const words = message.text ?? message.caption;
  if (!words) return null;
  // One-word requests ("holat", "статус", "status") are too short for detectLanguage.
  const quick = message.text !== undefined ? quickRequest(message.text) : null;
  if (quick !== null) {
    if (/[ўқғҳ]/i.test(words)) return "uz";
    // The «❌ Menda yo'q hujjatlar» button is Uzbek for everyone: the chat's earlier language decides.
    if (quick === "missing" && !/\p{Script=Cyrillic}/u.test(words)) return null;
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
export async function telegramDownload(api: Api, botToken: string, fileId: string, target: string): Promise<void> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file path");
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
    const tooBig = "the file is too big for the Bot API (over 20 MB)";
    if (Number(response.headers.get("content-length") ?? 0) > BOT_API_DOWNLOAD_LIMIT) throw new Error(tooBig);
    // Streamed to disk: the whole file is never held in memory (the server has 0.5 GB for dozens of files).
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(bytes > BOT_API_DOWNLOAD_LIMIT ? new Error(tooBig) : null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      limit,
      fs.createWriteStream(target, { mode: 0o600, flags: "wx" }),
    );
  } catch (err) {
    const message = errorMessage(err);
    throw new Error(botToken ? message.split(botToken).join("[REDACTED]") : message);
  }
}

/** Told to the client after a batch: which files arrived. */
const RECEIVED_WORDS: Record<Language, (names: string[]) => string> = {
  uz: (names) => `📥 ${names.length} ta fayl qabul qilindi:\n${names.map((n) => `• ${n}`).join("\n")}`,
  ru: (names) => `📥 Получено файлов: ${names.length}\n${names.map((n) => `• ${n}`).join("\n")}`,
  en: (names) => `📥 ${names.length} file(s) received:\n${names.map((n) => `• ${n}`).join("\n")}`,
};

const DOCUMENTS_RU = [
  "Устав предприятия",
  "Выписка из ЕГРПО",
  "Электронное разрешение/лицензия на пользование недрами",
  "Лицензионное соглашение (шартнома) по ПКМ № 133",
  "УТЭР",
  "ТЭО (технико-экономическое обоснование)",
  "Проект горного отвода",
  "Документ, подтверждающий сдачу формы 5-ГР",
  "Экологический пакет: ЗВОС",
  "Экологический пакет: ЗЭП",
  "Экологический пакет: ПДВ",
  "Экологический пакет: лимиты",
  "Акты экспертизы промышленной безопасности (ЭПБ) по ОПО",
  "Решения о земельном отводе",
];
const DOCUMENTS_EN = [
  "Company charter",
  "Extract from the EGRPO register",
  "Electronic subsoil use permit/licence",
  "Licence agreement (shartnoma) under resolution No. 133",
  "UTER",
  "Feasibility study (TEO)",
  "Mining allotment project",
  "Document confirming that form 5-GR was submitted",
  "Environmental package: ZVOS",
  "Environmental package: ZEP",
  "Environmental package: PDV",
  "Environmental package: limits",
  "Industrial safety expert review (EPB) reports for hazardous facilities (OPO)",
  "Land allotment decisions",
];
const numbered = (items: readonly string[]): string => items.map((d, i) => `${i + 1}. ${d}`).join("\n");

const TEMPLATE_CAPTION: Record<Language, string> = {
  uz:
    `Quyidagi 14 ta hujjatni shu chatga yuboring, har birini alohida fayl qilib:\n${numbered(DOCUMENTS_UZ)}\n\n` +
    "Sizda bo'lmagan hujjatlarni «❌ Menda yo'q hujjatlar» tugmasi orqali belgilang. Hamma fayl kelgach, paket ko'rib " +
    "chiqish uchun qabul qilinadi.",
  ru:
    `Отправьте в этот чат 14 документов, каждый отдельным файлом:\n${numbered(DOCUMENTS_RU)}\n\n` +
    "Документы, которых у Вас нет, отметьте кнопкой «❌ Menda yo'q hujjatlar». Когда придут все файлы, пакет будет " +
    "принят на рассмотрение.",
  en:
    `Please send these 14 documents to this chat, each as a separate file:\n${numbered(DOCUMENTS_EN)}\n\n` +
    "Mark the documents you do not have with the «❌ Menda yo'q hujjatlar» button. Once all files have arrived, the " +
    "package is accepted for review.",
};

const TOO_LARGE_REASON: Record<Language, (mb: number) => string> = {
  uz: (mb) => `fayl ${mb} MB dan katta. Uni siqib yoki qismlarga bo'lib yuboring`,
  ru: (mb) => `файл больше ${mb} МБ. Сожмите его или отправьте частями`,
  en: (mb) => `the file is larger than ${mb} MB. Please compress or split it`,
};

const TOO_MANY_REASON: Record<Language, (max: number) => string> = {
  uz: (max) => `bitta mijozdan ${max} tadan ortiq fayl qabul qilinmaydi`,
  ru: (max) => `от одного клиента принимается не более ${max} файлов`,
  en: (max) => `no more than ${max} files are accepted from one client`,
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
