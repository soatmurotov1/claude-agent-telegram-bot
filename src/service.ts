import fs from "node:fs";
import path from "node:path";
import { GrammyError, HttpError, type Api } from "grammy";
import type { BusinessConnection, Message } from "grammy/types";
import { ClaudeCLI, ClaudeError, ClaudeLimitError } from "./claudeCli.js";
import type { Settings } from "./config.js";
import { detectLanguage, type Language } from "./language.js";
import { buildSystemPrompt, buildUserPrompt, SKIP_TOKEN, splitEscalation } from "./prompts.js";
import {
  appendJsonl,
  type Clock,
  ensurePrivateDir,
  HistoryStore,
  isRecord,
  RuntimeState,
  SeenMessages,
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

export class Assistant {
  readonly history: HistoryStore;
  readonly seen: SeenMessages;
  readonly state: RuntimeState;
  readonly outcomes: Outcome[] = [];
  readonly previewsFile: string;
  readonly #connections = new Map<string, BusinessConnection>();
  readonly #takeoverUntil = new Map<string, number>();
  readonly #locks = new KeyedMutex();
  readonly #ownerAlerts = new Map<string, number>();
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
    this.seen = new SeenMessages(path.join(dir, "seen.json"));
    this.state = new RuntimeState(path.join(dir, "state.json"));
    this.previewsFile = path.join(dir, "previews.jsonl");
  }

  async onBusinessMessage(api: Api, message: Message): Promise<Outcome> {
    const outcome = await this.#handle(api, message);
    this.outcomes.push(outcome);
    if (this.outcomes.length > 100) this.outcomes.splice(0, this.outcomes.length - 100);
    return outcome;
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

  async #handle(api: Api, message: Message): Promise<Outcome> {
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
      this.history.add(connectionId, chatId, {
        role: "owner",
        name: this.settings.companyName,
        text,
        lang: detectLanguage(text),
      });
      if (this.settings.ownerTakeoverMinutes > 0) {
        this.#takeoverUntil.set(chatKey, this.#clock() + this.settings.ownerTakeoverMinutes * 60);
      }
      return Outcome.owner_message;
    }

    const language = detectLanguage(text) ?? this.history.lastLanguage(connectionId, chatId);
    const chatName = chatTitle(message);
    this.history.add(connectionId, chatId, { role: "other", name: senderName(message), text, lang: language });

    return this.#locks.run(chatKey, () =>
      this.#respond(api, { connectionId, chatId, chatKey, chatName, incoming: text, language }),
    );
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

  async #respond(
    api: Api,
    chat: {
      connectionId: string;
      chatId: number;
      chatKey: string;
      chatName: string;
      incoming: string;
      language: Language | null;
    },
  ): Promise<Outcome> {
    const blocked = this.#blocked(chat.chatKey);
    if (blocked) return blocked;

    const system = buildSystemPrompt(
      this.settings.companyName,
      readProfile(this.settings.profilePath),
      new Date(this.#clock() * 1000),
    );
    const user = buildUserPrompt(this.history.get(chat.connectionId, chat.chatId), chat.language);

    let raw: string;
    try {
      raw = await this.generator.generate(system, user);
    } catch (err) {
      return this.#onGenerateError(api, chat.chatName, err);
    }

    const { escalate, text: reply } = splitEscalation(raw);
    if (!reply || reply.startsWith(SKIP_TOKEN)) {
      log(`Chat ${chat.chatName} (${chat.chatId}): no reply needed ([SKIP]).`);
      return Outcome.skipped;
    }
    if (escalate) await this.#alertEscalation(api, chat.chatKey, chat.chatName, chat.incoming);

    const preview: Preview = {
      connectionId: chat.connectionId,
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
      return Outcome.previewed;
    }

    // Auto-send: the owner may have written, paused, or the limit may have hit while Claude was thinking.
    const blockedNow = this.#blocked(chat.chatKey);
    if (blockedNow) {
      this.#showPreview({ ...preview, note: `not sent: ${blockedNow} (state changed while the reply was generated)` });
      return blockedNow;
    }

    // Re-check the connection with Telegram itself right before sending, never from the cache.
    let reason = "";
    try {
      const fresh = await api.getBusinessConnection(chat.connectionId);
      this.#connections.set(chat.connectionId, fresh);
      if (fresh.user.id !== this.settings.ownerId) reason = "the connection belongs to another account";
      else if (!fresh.is_enabled) reason = "the connection is disabled";
      else if (!canReply(fresh)) reason = "the bot has no permission to reply in this account";
    } catch (err) {
      reason = `could not re-check the connection (${errorMessage(err)})`;
    }
    if (reason) {
      logError(`Not sending to chat ${chat.chatId}: ${reason}.`);
      this.#showPreview({ ...preview, note: `not sent: ${reason}` });
      return Outcome.permission_denied;
    }

    try {
      for (const chunk of splitMessage(reply)) {
        await api.sendMessage(chat.chatId, chunk, { business_connection_id: chat.connectionId });
      }
    } catch (err) {
      if (err instanceof GrammyError || err instanceof HttpError) {
        logError(`Sending the reply to chat ${chat.chatId} failed: ${errorMessage(err)}`);
        return Outcome.error;
      }
      throw err;
    }
    this.history.add(chat.connectionId, chat.chatId, {
      role: "owner",
      name: this.settings.companyName,
      text: reply,
      lang: chat.language,
    });
    log(`Sent a reply to chat ${chat.chatName} (${chat.chatId})${escalate ? " [ESCALATED]" : ""}.`);
    return Outcome.sent;
  }

  async #onGenerateError(api: Api, chatName: string, err: unknown): Promise<Outcome> {
    if (err instanceof ClaudeLimitError) {
      const now = this.#clock();
      const until =
        err.resetsAt !== null && err.resetsAt > now ? err.resetsAt : now + this.settings.limitCooldownMinutes * 60;
      this.state.limitUntil = until;
      const untilText = new Date(until * 1000).toISOString();
      logError(`${err.message}. No replies will be generated until ${untilText}. CLI said: ${err.detail}`);
      if (this.settings.autoSend) {
        await this.#notifyOwner(
          api,
          "limit",
          `⚠️ Claude obunasining foydalanish limiti tugadi. Bot ${tashkentTime(until)} gacha (Toshkent vaqti) ` +
            `murojaatlarga javob bermaydi. Bu vaqtda kelgan xabarlarga o'zingiz javob bering. ` +
            `Limit oldinroq tiklansa, /resume yuboring.`,
        );
      }
      return Outcome.limited;
    }
    if (err instanceof ClaudeError) {
      logError(`Claude failed for chat ${chatName}: ${errorMessage(err)}`);
      if (this.settings.autoSend) {
        await this.#notifyOwner(
          api,
          "error",
          `⚠️ Bot "${chatName}" chatidagi murojaatga javob tayyorlay olmadi, murojaatchiga hech narsa yuborilmadi. ` +
            `Iltimos, o'zingiz javob bering.\n\nSabab: ${truncate(err.message, 500)}`,
        );
      }
      return Outcome.error;
    }
    logError(`Unexpected error while generating a reply for chat ${chatName}: ${errorMessage(err)}`);
    return Outcome.error;
  }

  async #alertEscalation(api: Api, chatKey: string, chatName: string, incoming: string): Promise<void> {
    log(`Chat ${chatName}: the message was escalated to the owner.`);
    await this.#notifyOwner(
      api,
      `escalate:${chatKey}`,
      `🚨 Muhim murojaat: "${chatName}" chati\n\nMurojaatchi xabari:\n${truncate(incoming, 500)}\n\n` +
        `Iltimos, darhol ko'rib chiqing.`,
    );
  }

  /** Sends a private message from the bot to the owner, at most once per 10 minutes per key. */
  async #notifyOwner(api: Api, key: string, text: string): Promise<void> {
    const now = this.#clock();
    const last = this.#ownerAlerts.get(key);
    if (last !== undefined && now - last < OWNER_ALERT_INTERVAL_SECONDS) return;
    this.#ownerAlerts.set(key, now);
    try {
      await api.sendMessage(this.settings.ownerId, text);
    } catch (err) {
      logError(`Could not notify the owner: ${errorMessage(err)}`);
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
      `History is kept for ${this.settings.historyTtlDays} days`,
    ].join("\n");
  }

  startText(): string {
    const s = this.settings;
    const mode = s.autoSend
      ? "AUTO-SEND — javoblar murojaatchilarga avtomatik yuboriladi"
      : "PREVIEW — javoblar faqat server logida ko'rsatiladi, hech kimga yuborilmaydi";
    const state = this.state.paused ? "pauzada (/resume bilan yoqing)" : "ishlayapti";
    const lines = [
      "Assalomu alaykum!",
      "",
      `Bu bot «${s.companyName}» korxonasining Telegram Business yordamchisi. U korxona akkauntiga kelgan ` +
        `murojaatlarga korxona nomidan rasmiy va xushmuomala javob tayyorlaydi.`,
      "",
      "Hozirgi holat:",
      `• Rejim: ${mode}`,
      `• Holat: ${state}`,
      "",
      "Qanday ulanadi (korxona akkauntida):",
      "1. Telegram → Settings → Telegram Business → Chatbots.",
      "2. Shu botning username'ini kiriting.",
      "3. Bot qaysi chatlarni ko'rishini tanlang.",
      "4. Javob berish (reply) ruxsatini yoqing.",
      "Buning uchun akkauntda Telegram Premium bo'lishi kerak.",
      "",
      "Buyruqlar:",
      "/pause — botni to'xtatish",
      "/resume — qayta yoqish (pauza va limitni tozalaydi)",
      "/status — holat",
      "",
      "Bilib qo'ying:",
      `• Chatda xodim o'zi yozsa, bot u yerda ${s.ownerTakeoverMinutes} daqiqa jim turadi.`,
      "• Bot narx, muddat, shartnoma, ruxsatnoma, ekspertiza yoki tekshiruv natijasi bo'yicha va'da bermaydi — " +
        "murojaatni qabul qilib, mas'ul xodimga yo'naltiradi.",
      "• Favqulodda holat, shikoyat yoki rasmiy so'rovlarda sizga shu yerda alohida xabar yuboradi.",
      `• Suhbat tarixi ${s.historyTtlDays} kun saqlanadi, keyin o'chiriladi.`,
      "• Korxona haqidagi ma'lumotlar company.md faylida turadi — uni to'ldirish kerak.",
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
