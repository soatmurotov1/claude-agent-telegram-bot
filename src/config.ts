import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { parse } from "dotenv";

/** Every setting the bot understands. bot.ts reads and then wipes exactly these from process.env. */
export const SETTING_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "OWNER_ID",
  "ADMIN_IDS",
  "COMPANY_NAME",
  "AUTO_SEND",
  "ANTHROPIC_API_KEY",
  "CLAUDE_MODEL",
  "CLAUDE_MODEL_FAST",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_MODEL_FAST",
  "GEMINI_EMBEDDING_MODEL",
  "AI_TIMEOUT_SECONDS",
  "AI_PROBE_MINUTES",
  "DATABASE_URL",
  "HISTORY_LIMIT",
  "REVIEW_DAILY_LIMIT",
  "DAILY_REPORT_HOUR",
  "MAX_FILE_MB",
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "DATA_DIR",
  "PROFILE_PATH",
  "TEMPLATES_DIR",
  "LAWS_DIR",
  "PRICES_PATH",
  "REPORT_FONT_PATH",
  // No longer used (Claude now runs through the API, and nothing is deleted by age); read only to warn about them.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_BIN",
  "CLAUDE_EFFORT",
  "CLAUDE_TIMEOUT_SECONDS",
  "LIMIT_COOLDOWN_MINUTES",
  "OWNER_TAKEOVER_MINUTES",
  "HISTORY_TTL_DAYS",
] as const;

/** Settings from the previous version that are ignored now; bot.ts warns when one is still set. */
export const OBSOLETE_KEYS: readonly SettingKey[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_BIN",
  "CLAUDE_EFFORT",
  "CLAUDE_TIMEOUT_SECONDS",
  "LIMIT_COOLDOWN_MINUTES",
  "OWNER_TAKEOVER_MINUTES",
  "HISTORY_TTL_DAYS",
];

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_CLAUDE_MODEL_FAST = "claude-haiku-5-5";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_MODEL_FAST = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

export type SettingKey = (typeof SETTING_KEYS)[number];

export const DEFAULT_COMPANY_NAME = "Sanoatgeokontexxizmat";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Settings {
  readonly botToken: string;
  /** The first admin (OWNER_ID, or the first of ADMIN_IDS); kept for the business connection check. */
  readonly ownerId: number;
  /** Every admin: OWNER_ID plus ADMIN_IDS. All admins are equal. */
  readonly adminIds: readonly number[];
  readonly companyName: string;
  readonly autoSend: boolean;
  readonly anthropicApiKey: string;
  readonly claudeModel: string;
  readonly claudeModelFast: string;
  readonly geminiApiKey: string;
  readonly geminiModel: string;
  readonly geminiModelFast: string;
  readonly geminiEmbeddingModel: string;
  readonly aiTimeoutSeconds: number;
  readonly aiProbeMinutes: number;
  readonly databaseUrl: string;
  /** Recent messages put into every reply prompt (older ones come from the summary and semantic search). */
  readonly historyLimit: number;
  /** Obsolete settings that are still set (bot.ts warns about them). */
  readonly obsoleteSettings: readonly string[];
  /** Claude calls for document checks allowed per 24 hours across all clients. */
  readonly reviewDailyLimit: number;
  /** Hour (0-23, Tashkent) at which the daily report goes to the admin. */
  readonly dailyReportHour: number;
  /** Largest file a client may send, in MB. Above 20 MB needs telegramApiId and telegramApiHash. */
  readonly maxFileMb: number;
  /** my.telegram.org app credentials for downloading files over 20 MB (0 and "" when not set). */
  readonly telegramApiId: number;
  readonly telegramApiHash: string;
  readonly dataDir: string;
  readonly profilePath: string;
  readonly templatesDir: string;
  readonly lawsDir: string;
  readonly pricesPath: string;
  readonly reportFontPath: string;
  readonly envFile: string;
  readonly fromEnvironment: boolean;
}

export interface LoadOptions {
  requireTelegram?: boolean;
  overrides?: Record<string, string>;
  source?: Record<string, string>;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Loads settings either from the .env file (local development) or from `source`
 * (container mode, built from process.env by settingsFromProcessEnv). The two are never mixed,
 * and nothing is ever written to process.env.
 */
export function loadSettings(envFile: string, opts: LoadOptions = {}): Settings {
  const requireTelegram = opts.requireTelegram ?? true;
  const fromEnvironment = opts.source !== undefined;
  const envPath = path.resolve(envFile);
  const baseDir = path.dirname(envPath);
  const where = fromEnvironment ? "the environment variables" : envPath;

  let raw: Record<string, string>;
  if (opts.source !== undefined) {
    raw = { ...opts.source };
  } else {
    let text: string;
    try {
      text = fs.readFileSync(envPath, "utf8");
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) {
        throw new ConfigError(
          `Settings file ${envPath} does not exist. Create it with: cp .env.example .env && chmod 600 .env`,
        );
      }
      throw new ConfigError(`Cannot read settings file ${envPath}: ${errorCode(err)}`);
    }
    raw = parse(text);
  }
  Object.assign(raw, opts.overrides ?? {});

  const get = (key: SettingKey): string => (raw[key] ?? "").trim();

  let botToken = "";
  const tokenValue = get("TELEGRAM_BOT_TOKEN");
  const ownerValue = get("OWNER_ID");
  const adminValue = get("ADMIN_IDS");
  const adminIds: number[] = [];
  for (const part of [ownerValue, ...adminValue.split(/[,;\s]+/)]) {
    if (!part) continue;
    if (!/^\d+$/.test(part) || Number(part) <= 0) {
      if (requireTelegram) {
        throw new ConfigError(`OWNER_ID and ADMIN_IDS must hold numeric Telegram user IDs, separated by commas (check ${where}).`);
      }
      continue;
    }
    if (!adminIds.includes(Number(part))) adminIds.push(Number(part));
  }
  if (requireTelegram) {
    if (!tokenValue) throw new ConfigError(`TELEGRAM_BOT_TOKEN is missing (check ${where}).`);
    if (!isBotToken(tokenValue)) {
      throw new ConfigError(
        `TELEGRAM_BOT_TOKEN does not look like a bot token from @BotFather (expected <digits>:<text>; check ${where}).`,
      );
    }
    if (adminIds.length === 0) throw new ConfigError(`ADMIN_IDS (or OWNER_ID) is missing (check ${where}).`);
    botToken = tokenValue;
  } else if (isBotToken(tokenValue)) {
    // Telegram settings are optional here (--check-ai, --try); keep them only when valid.
    botToken = tokenValue;
  }
  const ownerId = adminIds[0] ?? 0;

  const autoSendValue = get("AUTO_SEND").toLowerCase();
  let autoSend = false;
  if (autoSendValue) {
    if (TRUE_VALUES.has(autoSendValue)) autoSend = true;
    else if (!FALSE_VALUES.has(autoSendValue)) {
      throw new ConfigError(`AUTO_SEND must be one of true/false/1/0/yes/no/on/off (check ${where}).`);
    }
  }

  const anthropicApiKey = get("ANTHROPIC_API_KEY");
  if (anthropicApiKey && (!anthropicApiKey.startsWith("sk-ant-") || /\s/.test(anthropicApiKey))) {
    throw new ConfigError(`ANTHROPIC_API_KEY must be an Anthropic API key (sk-ant-..., one line; check ${where}).`);
  }
  if (anthropicApiKey.startsWith("sk-ant-oat")) {
    throw new ConfigError(
      `ANTHROPIC_API_KEY holds a Claude subscription token (sk-ant-oat...). Create an API key in the Claude Console ` +
        `(console.anthropic.com -> API keys) and use that (check ${where}).`,
    );
  }
  const geminiApiKey = get("GEMINI_API_KEY");
  if (geminiApiKey && /\s/.test(geminiApiKey)) {
    throw new ConfigError(`GEMINI_API_KEY must be on one line without spaces (check ${where}).`);
  }
  const databaseUrl = get("DATABASE_URL");
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigError(`DATABASE_URL must be a postgresql:// connection string (check ${where}).`);
  }
  const obsoleteSettings = OBSOLETE_KEYS.filter((key) => get(key) !== "");

  const int = (key: SettingKey, fallback: number, min: number): number => {
    const value = get(key);
    if (!value) return fallback;
    if (!/^\d+$/.test(value)) {
      throw new ConfigError(`${key} must be a whole number (check ${where}).`);
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min) {
      throw new ConfigError(`${key} must be a whole number of at least ${min} (check ${where}).`);
    }
    return n;
  };

  const apiIdValue = get("TELEGRAM_API_ID");
  const telegramApiHash = get("TELEGRAM_API_HASH");
  if (apiIdValue && !/^\d+$/.test(apiIdValue)) {
    throw new ConfigError(`TELEGRAM_API_ID must be the numeric api_id from my.telegram.org (check ${where}).`);
  }
  if (telegramApiHash && !/^[0-9a-f]{32}$/i.test(telegramApiHash)) {
    throw new ConfigError(`TELEGRAM_API_HASH must be the 32-character api_hash from my.telegram.org (check ${where}).`);
  }
  if (Boolean(apiIdValue) !== Boolean(telegramApiHash)) {
    throw new ConfigError(`Set both TELEGRAM_API_ID and TELEGRAM_API_HASH, or neither (check ${where}).`);
  }

  const values = {
    companyName: get("COMPANY_NAME") || DEFAULT_COMPANY_NAME,
    ownerId,
    adminIds: Object.freeze([...adminIds]),
    autoSend,
    claudeModel: get("CLAUDE_MODEL") || DEFAULT_CLAUDE_MODEL,
    claudeModelFast: get("CLAUDE_MODEL_FAST") || DEFAULT_CLAUDE_MODEL_FAST,
    geminiModel: get("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL,
    geminiModelFast: get("GEMINI_MODEL_FAST") || DEFAULT_GEMINI_MODEL_FAST,
    geminiEmbeddingModel: get("GEMINI_EMBEDDING_MODEL") || DEFAULT_GEMINI_EMBEDDING_MODEL,
    aiTimeoutSeconds: int("AI_TIMEOUT_SECONDS", 90, 5),
    aiProbeMinutes: int("AI_PROBE_MINUTES", 5, 1),
    historyLimit: int("HISTORY_LIMIT", 40, 1),
    obsoleteSettings: Object.freeze([...obsoleteSettings]),
    reviewDailyLimit: int("REVIEW_DAILY_LIMIT", 100, 1),
    dailyReportHour: Math.min(int("DAILY_REPORT_HOUR", 9, 0), 23),
    maxFileMb: Math.min(int("MAX_FILE_MB", 100, 1), 100),
    telegramApiId: apiIdValue ? Number(apiIdValue) : 0,
    dataDir: path.resolve(baseDir, get("DATA_DIR") || "data"),
    profilePath: path.resolve(baseDir, get("PROFILE_PATH") || "company.md"),
    templatesDir: path.resolve(baseDir, get("TEMPLATES_DIR") || "templates"),
    lawsDir: path.resolve(baseDir, get("LAWS_DIR") || "laws"),
    pricesPath: path.resolve(baseDir, get("PRICES_PATH") || path.join("knowledge", "prices.json")),
    reportFontPath: get("REPORT_FONT_PATH") ? path.resolve(baseDir, get("REPORT_FONT_PATH")) : "",
    envFile: envPath,
    fromEnvironment,
  };

  const publicView = (): Record<string, unknown> => ({
    ...values,
    botToken: botToken ? "[hidden]" : "",
    anthropicApiKey: anthropicApiKey ? "[hidden]" : "",
    geminiApiKey: geminiApiKey ? "[hidden]" : "",
    databaseUrl: databaseUrl ? "[hidden]" : "",
    telegramApiHash: telegramApiHash ? "[hidden]" : "",
  });

  const settings: Record<PropertyKey, unknown> = { ...values };
  // Secrets are non-enumerable so they never end up in logs, JSON or inspect output.
  Object.defineProperty(settings, "botToken", { value: botToken, enumerable: false });
  Object.defineProperty(settings, "anthropicApiKey", { value: anthropicApiKey, enumerable: false });
  Object.defineProperty(settings, "geminiApiKey", { value: geminiApiKey, enumerable: false });
  Object.defineProperty(settings, "databaseUrl", { value: databaseUrl, enumerable: false });
  Object.defineProperty(settings, "telegramApiHash", { value: telegramApiHash, enumerable: false });
  Object.defineProperty(settings, "toJSON", { value: publicView, enumerable: false });
  Object.defineProperty(settings, util.inspect.custom, { value: publicView, enumerable: false });
  return Object.freeze(settings) as unknown as Settings;
}

/**
 * Container mode: reads SETTING_KEYS from process.env, then removes them from process.env
 * (even on error) so no child process or library ever reads the tokens from the environment.
 */
export function settingsFromProcessEnv(
  envFile: string,
  opts: Omit<LoadOptions, "source"> = {},
): Settings {
  try {
    const source: Record<string, string> = {};
    for (const key of SETTING_KEYS) {
      const value = process.env[key];
      if (value !== undefined) source[key] = value;
    }
    return loadSettings(envFile, { ...opts, source });
  } finally {
    for (const key of SETTING_KEYS) delete process.env[key];
  }
}

/** Returns a warning when the .env file is readable by group or others, otherwise null. */
export function envFileWarning(envFile: string): string | null {
  if (process.platform === "win32") return null;
  let mode: number;
  try {
    mode = fs.statSync(envFile).mode;
  } catch {
    return null;
  }
  if ((mode & 0o077) === 0) return null;
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  return `${envFile} is readable by other users (mode ${octal}) and holds secret tokens. Fix it with: chmod 600 ${envFile}`;
}

/** Minimal shell-free `which`: searches PATH for an executable file. */
export function which(name: string, envPath = process.env.PATH ?? ""): string | null {
  // On Windows a name without an extension is tried with PATHEXT only (a bare "claude" there is a sh shim).
  const exts =
    process.platform === "win32" && !path.extname(name)
      ? (process.env.PATHEXT ?? ".EXE;.COM").split(";").filter(Boolean).map((e) => e.toLowerCase())
      : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isBotToken(value: string): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(value);
}

export function isErrnoCode(err: unknown, code: string): boolean {
  return errorCode(err) === code;
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return "unknown error";
}
