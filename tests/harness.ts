import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, type Transformer } from "grammy";
import type { BusinessConnection, Update, UserFromGetMe } from "grammy/types";
import { loadSettings, type Settings } from "../src/config.js";
import { buildComposer } from "../src/handlers.js";
import { type Assistant, buildAssistant, type Preview, type ReplyGenerator } from "../src/service.js";

export const OWNER_ID = 1000;
export const CLIENT_ID = 2000;
export const CONNECTION_ID = "conn-1";
export const BOT_TOKEN = "123456:TEST-token-not-real";
export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BOT_INFO = {
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

/** Records every Bot API call and answers it locally; the network is never reached. */
export class RecordingApi {
  readonly calls: ApiCall[] = [];
  connection: BusinessConnection | null = null;
  #nextMessageId = 5000;
  /** Makes sendMediaGroup fail, to test the one-by-one fallback. */
  failMediaGroup = false;

  install(bot: Bot): void {
    const transformer: Transformer = async (_prev, method, payload) => {
      this.calls.push({ method, payload: { ...payload } as Record<string, unknown> });
      return this.#respond(method, payload as Record<string, unknown>) as never;
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
    if (method === "sendMediaGroup") {
      if (this.failMediaGroup) return { ok: false, error_code: 400, description: "Bad Request: album failed" };
      const media = Array.isArray(payload.media) ? payload.media : [];
      return {
        ok: true,
        result: media.map(() => ({
          message_id: this.#nextMessageId++,
          date: 1_800_000_000,
          chat: { id: Number(payload.chat_id), type: "private", first_name: "Chat" },
        })),
      };
    }
    if (method === "sendMessage" || method === "sendDocument") {
      return {
        ok: true,
        result: {
          message_id: this.#nextMessageId++,
          date: 1_800_000_000,
          chat: { id: Number(payload.chat_id), type: "private", first_name: "Chat" },
          ...(method === "sendMessage" ? { text: String(payload.text) } : {}),
        },
      };
    }
    return { ok: true, result: true };
  }

  byMethod(method: string): ApiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Messages and documents sent to one chat. */
  sentTo(chatId: number, method = "sendMessage"): ApiCall[] {
    return this.byMethod(method).filter((call) => Number(call.payload.chat_id) === chatId);
  }

  clear(): void {
    this.calls.length = 0;
  }
}

type Step = string | Error | ((system: string, user: string, dir?: string) => string | Promise<string>);

/** Scripted generator: `generate` and `review` take the next step (or the per-file answer). */
export class FakeGenerator implements ReplyGenerator {
  readonly calls: { system: string; user: string; dir?: string; files?: string[] }[] = [];
  readonly steps: Step[] = [];
  fallback: Step = "Murojaatingiz qabul qilindi.";

  push(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  async #next(system: string, user: string, dir?: string): Promise<string> {
    const step = this.steps.shift() ?? this.fallback;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(system, user, dir) : step;
  }

  async generate(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    return this.#next(system, user);
  }

  async review(system: string, user: string, dir: string): Promise<string> {
    this.calls.push({ system, user, dir, files: fs.readdirSync(dir) });
    return this.#next(system, user, dir);
  }
}

export class Clock {
  constructor(public t = 1_800_000_000) {}
  readonly now = (): number => this.t;
  advance(seconds: number): void {
    this.t += seconds;
  }
}

/** A review answer in the current form: every listed document the file holds, each with its own verdict. */
export function verdicts(
  items: { doc: string; accepted: boolean; parts?: string[]; reasons?: string[] }[],
  opts: { reasons?: string[]; applicant?: Record<string, unknown> } = {},
): string {
  return JSON.stringify({
    documents: items.map((item) => ({
      doc: item.doc,
      parts: item.parts ?? [],
      verdict: item.accepted ? "accepted" : "rejected",
      reasons: item.reasons ?? [],
    })),
    reasons: opts.reasons ?? [],
    summary: items.map((item) => item.doc).join(", ") || "file",
    applicant: opts.applicant ?? null,
  });
}

/**
 * A review answer in the older one-document form, still understood. No `parts` means the file holds every part of
 * the document.
 */
export function verdict(
  doc: string | null,
  accepted: boolean,
  opts: { parts?: string[]; reasons?: string[]; applicant?: Record<string, unknown> } = {},
): string {
  return JSON.stringify({
    doc,
    parts: opts.parts ?? [],
    verdict: accepted ? "accepted" : "rejected",
    reasons: opts.reasons ?? [],
    summary: doc ?? "file",
    applicant: opts.applicant ?? null,
  });
}

let updateId = 1;
let messageId = 100;

export class Harness {
  readonly root: string;
  readonly dataDir: string;
  readonly clock = new Clock();
  readonly generator = new FakeGenerator();
  readonly api = new RecordingApi();
  readonly previews: Preview[] = [];
  /** Content Telegram "serves" for each file_id. */
  readonly files = new Map<string, Buffer>();
  /** file_ids downloaded through the large-file (MTProto) path. */
  readonly largeDownloads: string[] = [];
  readonly settings: Settings;
  readonly #largeFiles: boolean;
  assistant!: Assistant;
  bot!: Bot;

  constructor(overrides: Record<string, string> = {}, { largeFiles = true }: { largeFiles?: boolean } = {}) {
    this.#largeFiles = largeFiles;
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "sgk-docs-test-"));
    this.dataDir = path.join(this.root, "data");
    const envFile = path.join(this.root, ".env");
    const profile = path.join(this.root, "company.md");
    fs.writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nOWNER_ID=${OWNER_ID}\nAUTO_SEND=true\n`, { mode: 0o600 });
    fs.writeFileSync(profile, "Korxona haqida\nRasmiy telefon: +998 71 000 00 00\n");
    this.settings = loadSettings(envFile, {
      overrides: {
        DATA_DIR: this.dataDir,
        PROFILE_PATH: profile,
        TEMPLATES_DIR: path.join(PROJECT_DIR, "templates"),
        LAWS_DIR: path.join(PROJECT_DIR, "laws"),
        ...overrides,
      },
    });
    this.#build();
  }

  #build(): void {
    this.assistant = buildAssistant(this.settings, {
      generator: this.generator,
      clock: this.clock.now,
      previewSink: (preview) => this.previews.push(preview),
      reviewDelayMs: 60_000,
      downloadFile: async (_api, fileId, target) => {
        const data = this.files.get(fileId);
        if (!data) throw new Error(`no such file ${fileId}`);
        await fs.promises.writeFile(target, data, { mode: 0o600 });
      },
      downloadLargeFile: this.#largeFiles
        ? async (fileId, target) => {
            const data = this.files.get(fileId);
            if (!data) throw new Error(`no such file ${fileId}`);
            this.largeDownloads.push(fileId);
            await fs.promises.writeFile(target, data, { mode: 0o600 });
          }
        : null,
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

  /** Runs waiting review batches now. */
  async flush(): Promise<void> {
    await this.assistant.flushReviews(this.bot.api);
  }

  setConnection(): void {
    this.api.connection = {
      id: CONNECTION_ID,
      user: { id: OWNER_ID, is_bot: false, first_name: "Sanoat" },
      user_chat_id: OWNER_ID,
      date: 1_700_000_000,
      is_enabled: true,
      rights: { can_reply: true },
      can_reply: true,
    } as unknown as BusinessConnection;
  }

  /** A private message to the bot. `file` makes it a document message served from `this.files`. */
  directMessage(
    text: string | null,
    opts: { fromId?: number; file?: { name: string; data: Buffer; size?: number }; photo?: Buffer } = {},
  ): Update {
    const fromId = opts.fromId ?? CLIENT_ID;
    const id = messageId++;
    const chat = { id: fromId, type: "private", first_name: "Aziz", username: `user${fromId}` };
    const message: Record<string, unknown> = {
      message_id: id,
      date: Math.floor(this.clock.t),
      chat,
      from: { id: fromId, is_bot: false, first_name: "Aziz", username: `user${fromId}` },
    };
    if (text !== null) {
      message.text = text;
      const command = /^\/\w+/.exec(text);
      if (command) message.entities = [{ type: "bot_command", offset: 0, length: command[0].length }];
    }
    if (opts.file) {
      const fileId = `file-${id}`;
      this.files.set(fileId, opts.file.data);
      message.document = {
        file_id: fileId,
        file_unique_id: `u-${fileId}`,
        file_name: opts.file.name,
        file_size: opts.file.size ?? opts.file.data.length,
      };
    }
    if (opts.photo) {
      const fileId = `photo-${id}`;
      this.files.set(fileId, opts.photo);
      message.photo = [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 800, height: 600, file_size: opts.photo.length }];
    }
    return { update_id: updateId++, message: message as unknown as NonNullable<Update["message"]> };
  }

  businessMessage(text: string | null, file?: { name: string; data: Buffer }): Update {
    const id = messageId++;
    const message: Record<string, unknown> = {
      message_id: id,
      date: Math.floor(this.clock.t),
      business_connection_id: CONNECTION_ID,
      chat: { id: CLIENT_ID, type: "private", first_name: "Aziz" },
      from: { id: CLIENT_ID, is_bot: false, first_name: "Aziz" },
      ...(text !== null ? { text } : {}),
    };
    if (file) {
      const fileId = `file-${id}`;
      this.files.set(fileId, file.data);
      message.document = { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: file.name, file_size: file.data.length };
    }
    return { update_id: updateId++, business_message: message as unknown as NonNullable<Update["business_message"]> };
  }

  callback(data: string, fromId = OWNER_ID): Update {
    const chat = { id: fromId, type: "private", first_name: "User" };
    return {
      update_id: updateId++,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: fromId, is_bot: false, first_name: "User" },
        chat_instance: "ci",
        data,
        message: { message_id: messageId++, date: Math.floor(this.clock.t), chat, text: "buttons" },
      },
    } as unknown as Update;
  }

  clientDir(userId = CLIENT_ID): string {
    return path.join(this.dataDir, "clients", String(userId));
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const harnesses: Harness[] = [];

export function makeHarness(overrides: Record<string, string> = {}, opts: { largeFiles?: boolean } = {}): Harness {
  const harness = new Harness(overrides, opts);
  harnesses.push(harness);
  return harness;
}

export function cleanupHarnesses(): void {
  for (const harness of harnesses.splice(0)) harness.cleanup();
}
