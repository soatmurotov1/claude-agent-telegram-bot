import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot, type Transformer } from "grammy";
import type { BusinessConnection, Message, Update, UserFromGetMe } from "grammy/types";
import { loadSettings, type Settings } from "../src/config.js";
import { buildComposer } from "../src/handlers.js";
import { type Assistant, buildAssistant, type Preview, type ReplyGenerator } from "../src/service.js";

export const OWNER_ID = 1000;
export const CUSTOMER_ID = 2000;
export const CONNECTION_ID = "conn-1";
export const BOT_TOKEN = "123456:TEST-token-not-real";

export const BOT_INFO: UserFromGetMe = {
  id: 123456,
  is_bot: true,
  first_name: "SGK Assistant",
  username: "sgk_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: true,
  has_main_web_app: false,
} as UserFromGetMe;

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Records every Bot API call and answers it locally; the real HTTP client is never reached. */
export class RecordingApi {
  readonly calls: ApiCall[] = [];
  connection: BusinessConnection | null = null;
  #nextMessageId = 5000;

  install(bot: Bot): void {
    const transformer: Transformer = async (_prev, method, payload) => {
      const record: Record<string, unknown> = { ...payload };
      this.calls.push({ method, payload: record });
      if (this.failOnce && this.failOnce.method === method) {
        const { description } = this.failOnce;
        this.failOnce = null;
        return { ok: false, error_code: 400, description } as never;
      }
      return this.#respond(method, record) as never;
    };
    bot.api.config.use(transformer);
  }

  #respond(method: string, payload: Record<string, unknown>): unknown {
    if (method === "getBusinessConnection") {
      if (this.connection && this.connection.id === payload.business_connection_id) {
        return { ok: true, result: structuredClone(this.connection) };
      }
      return { ok: false, error_code: 400, description: "Bad Request: business connection not found" };
    }
    if (method === "sendMessage") {
      const chatId = Number(payload.chat_id);
      const message = {
        message_id: this.#nextMessageId++,
        date: 1_800_000_000,
        chat: { id: chatId, type: "private", first_name: "Chat" },
        text: String(payload.text),
      };
      return { ok: true, result: message };
    }
    if (method === "forwardMessage") {
      const message = {
        message_id: this.#nextMessageId++,
        date: 1_800_000_000,
        chat: { id: Number(payload.chat_id), type: "private", first_name: "Owner" },
      };
      return { ok: true, result: message };
    }
    if (method === "createForumTopic") {
      return { ok: true, result: { message_thread_id: this.#nextMessageId++, name: payload.name, icon_color: 1 } };
    }
    if (method === "getChatMember") {
      return { ok: true, result: { status: "administrator", user: { id: payload.user_id }, can_manage_topics: true } };
    }
    if (method === "copyMessage") {
      if (this.failCopy) return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
      return { ok: true, result: { message_id: this.#nextMessageId++ } };
    }
    return { ok: true, result: true };
  }

  failCopy = false;
  /** The next call of this method fails with this description. */
  failOnce: { method: string; description: string } | null = null;

  byMethod(method: string): ApiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  clear(): void {
    this.calls.length = 0;
  }
}

type Step = string | Error | ((system: string, user: string) => string | Promise<string>);

/** Scripted reply generator that records every call. */
export class FakeGenerator implements ReplyGenerator {
  readonly calls: { system: string; user: string }[] = [];
  readonly steps: Step[] = [];
  fallback = "Murojaatingiz qabul qilindi.";
  hook: (() => void | Promise<void>) | null = null;

  push(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  async generate(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    if (this.hook) {
      const hook = this.hook;
      this.hook = null;
      await hook();
    }
    const step = this.steps.shift() ?? this.fallback;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(system, user) : step;
  }
}

export class Clock {
  constructor(public t = 1_800_000_000) {}
  readonly now = (): number => this.t;
  advance(seconds: number): void {
    this.t += seconds;
  }
}

export interface MessageOptions {
  fromId?: number;
  chatId?: number;
  messageId?: number;
  connectionId?: string;
  isBot?: boolean;
  viaBusinessBot?: boolean;
  firstName?: string;
  extra?: Record<string, unknown>;
}

export const DEFAULT_PROFILE = `<!-- template comment that must be stripped -->
# Korxona haqida
- Rasmiy telefon: +998 71 000 00 00
`;

let updateId = 1;
let messageId = 100;

export class Harness {
  readonly root: string;
  readonly dataDir: string;
  readonly envFile: string;
  readonly profilePath: string;
  readonly clock = new Clock();
  readonly generator = new FakeGenerator();
  readonly api = new RecordingApi();
  readonly previews: Preview[] = [];
  readonly settings: Settings;
  assistant!: Assistant;
  bot!: Bot;

  constructor(overrides: Record<string, string> = {}, envText = `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nOWNER_ID=${OWNER_ID}\n`) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "sgk-bot-test-"));
    this.dataDir = path.join(this.root, "data");
    this.envFile = path.join(this.root, ".env");
    this.profilePath = path.join(this.root, "company.md");
    fs.writeFileSync(this.envFile, envText, { mode: 0o600 });
    fs.writeFileSync(this.profilePath, DEFAULT_PROFILE);
    this.settings = loadSettings(this.envFile, {
      overrides: { DATA_DIR: this.dataDir, PROFILE_PATH: this.profilePath, ...overrides },
    });
    this.#build();
  }

  #build(): void {
    this.assistant = buildAssistant(this.settings, {
      generator: this.generator,
      clock: this.clock.now,
      previewSink: (preview) => this.previews.push(preview),
    });
    this.bot = new Bot(this.settings.botToken, {
      botInfo: BOT_INFO,
      client: {
        fetch: () => {
          throw new Error("network disabled in tests");
        },
      },
    });
    this.api.install(this.bot);
    this.bot.use(buildComposer(this.assistant, this.settings));
  }

  /** A new Assistant and Bot on the same data directory, like a process restart. */
  restart(): void {
    this.#build();
  }

  async send(update: Update): Promise<void> {
    await this.bot.handleUpdate(update);
  }

  get outcomes(): readonly string[] {
    return this.assistant.outcomes;
  }

  lastOutcome(): string | undefined {
    return this.assistant.outcomes.at(-1);
  }

  connectionPayload(changes: Record<string, unknown> = {}): BusinessConnection {
    const payload: Record<string, unknown> = {
      id: CONNECTION_ID,
      user: { id: OWNER_ID, is_bot: false, first_name: "Sanoat" },
      user_chat_id: OWNER_ID,
      date: 1_700_000_000,
      is_enabled: true,
      rights: { can_reply: true },
      can_reply: true,
      ...changes,
    };
    return payload as unknown as BusinessConnection;
  }

  /** Changes what Telegram answers to getBusinessConnection, without sending an update. */
  setConnection(changes: Record<string, unknown> = {}): BusinessConnection {
    this.api.connection = this.connectionPayload(changes);
    return this.api.connection;
  }

  /** Telegram sends a business_connection update and remembers the connection for lookups. */
  async connect(changes: Record<string, unknown> = {}): Promise<void> {
    const connection = this.setConnection(changes);
    await this.send({ update_id: updateId++, business_connection: connection });
  }

  businessMessage(text: string | null, opts: MessageOptions = {}): Update {
    const fromId = opts.fromId ?? CUSTOMER_ID;
    const chatId = opts.chatId ?? CUSTOMER_ID;
    const message: Record<string, unknown> = {
      message_id: opts.messageId ?? messageId++,
      date: Math.floor(this.clock.t),
      business_connection_id: opts.connectionId ?? CONNECTION_ID,
      chat: { id: chatId, type: "private", first_name: opts.firstName ?? "Aziz" },
      from: { id: fromId, is_bot: opts.isBot ?? false, first_name: opts.firstName ?? "Aziz" },
      ...(text !== null ? { text } : {}),
      ...(opts.viaBusinessBot
        ? { sender_business_bot: { id: BOT_INFO.id, is_bot: true, first_name: BOT_INFO.first_name } }
        : {}),
      ...opts.extra,
    };
    return { update_id: updateId++, business_message: message as unknown as NonNullable<Update["business_message"]> };
  }

  directMessage(
    text: string | null,
    opts: {
      fromId?: number;
      messageId?: number;
      replyTo?: number;
      group?: boolean;
      isBot?: boolean;
      extra?: Record<string, unknown>;
    } = {},
  ): Update {
    const fromId = opts.fromId ?? OWNER_ID;
    const command = text !== null ? /^\/\w+/.exec(text) : null;
    const chat = opts.group
      ? { id: -100500, type: "group", title: "Group" }
      : { id: fromId, type: "private", first_name: "User", username: `user${fromId}` };
    const message: Record<string, unknown> = {
      message_id: opts.messageId ?? messageId++,
      date: Math.floor(this.clock.t),
      chat,
      from: { id: fromId, is_bot: opts.isBot ?? false, first_name: "User", username: `user${fromId}` },
      ...(text !== null ? { text } : {}),
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
      ...(opts.replyTo !== undefined
        ? { reply_to_message: { message_id: opts.replyTo, date: 1, chat, text: "copy" } }
        : {}),
      ...opts.extra,
    };
    return { update_id: updateId++, message: message as unknown as NonNullable<Update["message"]> };
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const harnesses: Harness[] = [];

export function makeHarness(overrides: Record<string, string> = {}): Harness {
  const harness = new Harness(overrides);
  harnesses.push(harness);
  return harness;
}

export function cleanupHarnesses(): void {
  for (const harness of harnesses.splice(0)) harness.cleanup();
}

export function readJsonl(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function fileMode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

export const isWindows = process.platform === "win32";
