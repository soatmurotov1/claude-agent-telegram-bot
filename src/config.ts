import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { parse } from "dotenv";

/** Every setting the bot understands. bot.ts reads and then wipes exactly these from process.env. */
export const SETTING_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "OWNER_ID",
  "COMPANY_NAME",
  "AUTO_SEND",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_BIN",
  "CLAUDE_MODEL",
  "CLAUDE_EFFORT",
  "CLAUDE_TIMEOUT_SECONDS",
  "LIMIT_COOLDOWN_MINUTES",
  "OWNER_TAKEOVER_MINUTES",
  "HISTORY_LIMIT",
  "HISTORY_TTL_DAYS",
  "REVIEW_DAILY_LIMIT",
  "DATA_DIR",
  "PROFILE_PATH",
  "TEMPLATES_DIR",
  "LAWS_DIR",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_COMPANY_NAME = "Sanoatgeokontexxizmat";

export type ClaudeAuthMode =
  | "this machine's claude login"
  | "subscription token from .env"
  | "subscription token from environment variables";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Settings {
  readonly botToken: string;
  readonly ownerId: number;
  readonly companyName: string;
  readonly autoSend: boolean;
  readonly claudeOauthToken: string;
  readonly claudeBin: string;
  readonly claudeModel: string;
  readonly claudeEffort: Effort;
  readonly claudeTimeoutSeconds: number;
  readonly limitCooldownMinutes: number;
  readonly ownerTakeoverMinutes: number;
  readonly historyLimit: number;
  readonly historyTtlDays: number;
  /** Claude calls for document checks allowed per 24 hours across all clients. */
  readonly reviewDailyLimit: number;
  readonly dataDir: string;
  readonly profilePath: string;
  readonly templatesDir: string;
  readonly lawsDir: string;
  readonly envFile: string;
  readonly fromEnvironment: boolean;
  readonly claudeAuthMode: ClaudeAuthMode;
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
  let ownerId = 0;
  const tokenValue = get("TELEGRAM_BOT_TOKEN");
  const ownerValue = get("OWNER_ID");
  if (requireTelegram) {
    if (!tokenValue) throw new ConfigError(`TELEGRAM_BOT_TOKEN is missing (check ${where}).`);
    if (!isBotToken(tokenValue)) {
      throw new ConfigError(
        `TELEGRAM_BOT_TOKEN does not look like a bot token from @BotFather (expected <digits>:<text>; check ${where}).`,
      );
    }
    if (!ownerValue) throw new ConfigError(`OWNER_ID is missing (check ${where}).`);
    if (!/^\d+$/.test(ownerValue) || Number(ownerValue) <= 0) {
      throw new ConfigError(`OWNER_ID must be a numeric Telegram user ID (check ${where}).`);
    }
    botToken = tokenValue;
    ownerId = Number(ownerValue);
  } else {
    // Telegram settings are optional here (--check-claude, --try); keep them only when valid.
    if (isBotToken(tokenValue)) botToken = tokenValue;
    if (/^\d+$/.test(ownerValue)) ownerId = Number(ownerValue);
  }

  const autoSendValue = get("AUTO_SEND").toLowerCase();
  let autoSend = false;
  if (autoSendValue) {
    if (TRUE_VALUES.has(autoSendValue)) autoSend = true;
    else if (!FALSE_VALUES.has(autoSendValue)) {
      throw new ConfigError(`AUTO_SEND must be one of true/false/1/0/yes/no/on/off (check ${where}).`);
    }
  }

  const claudeOauthToken = get("CLAUDE_CODE_OAUTH_TOKEN");
  if (claudeOauthToken) {
    if (claudeOauthToken.startsWith("sk-ant-api")) {
      throw new ConfigError(
        `CLAUDE_CODE_OAUTH_TOKEN holds an Anthropic API key, not a subscription token. ` +
          `Run "claude setup-token" and use the sk-ant-oat... token it prints (check ${where}).`,
      );
    }
    if (!claudeOauthToken.startsWith("sk-ant-oat") || /\s/.test(claudeOauthToken)) {
      throw new ConfigError(
        `CLAUDE_CODE_OAUTH_TOKEN is not a valid "claude setup-token" token: it must start with sk-ant-oat ` +
          `and be on a single line without spaces (check ${where}).`,
      );
    }
  }

  const effortValue = get("CLAUDE_EFFORT").toLowerCase() || "low";
  if (!isEffort(effortValue)) {
    throw new ConfigError(`CLAUDE_EFFORT must be one of ${EFFORT_LEVELS.join(", ")} (check ${where}).`);
  }

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

  const claudeBinValue = get("CLAUDE_BIN");
  const claudeBin = claudeBinValue
    ? claudeBinValue.includes("/") || claudeBinValue.includes("\\")
      ? path.resolve(baseDir, claudeBinValue)
      : (which(claudeBinValue) ?? claudeBinValue)
    : findClaudeBin();

  const values = {
    companyName: get("COMPANY_NAME") || DEFAULT_COMPANY_NAME,
    ownerId,
    autoSend,
    claudeBin,
    claudeModel: get("CLAUDE_MODEL"),
    claudeEffort: effortValue,
    claudeTimeoutSeconds: int("CLAUDE_TIMEOUT_SECONDS", 120, 1),
    limitCooldownMinutes: int("LIMIT_COOLDOWN_MINUTES", 30, 1),
    ownerTakeoverMinutes: int("OWNER_TAKEOVER_MINUTES", 15, 0),
    historyLimit: int("HISTORY_LIMIT", 50, 1),
    historyTtlDays: int("HISTORY_TTL_DAYS", 30, 1),
    reviewDailyLimit: int("REVIEW_DAILY_LIMIT", 100, 1),
    dataDir: path.resolve(baseDir, get("DATA_DIR") || "data"),
    profilePath: path.resolve(baseDir, get("PROFILE_PATH") || "company.md"),
    templatesDir: path.resolve(baseDir, get("TEMPLATES_DIR") || "templates"),
    lawsDir: path.resolve(baseDir, get("LAWS_DIR") || "laws"),
    envFile: envPath,
    fromEnvironment,
  };

  const authMode = (): ClaudeAuthMode => {
    if (!claudeOauthToken) return "this machine's claude login";
    return fromEnvironment
      ? "subscription token from environment variables"
      : "subscription token from .env";
  };
  const publicView = (): Record<string, unknown> => ({
    ...values,
    botToken: botToken ? "[hidden]" : "",
    claudeOauthToken: claudeOauthToken ? "[hidden]" : "",
    claudeAuthMode: authMode(),
  });

  const settings: Record<PropertyKey, unknown> = { ...values };
  // Secrets are non-enumerable so they never end up in logs, JSON or inspect output.
  Object.defineProperty(settings, "botToken", { value: botToken, enumerable: false });
  Object.defineProperty(settings, "claudeOauthToken", { value: claudeOauthToken, enumerable: false });
  Object.defineProperty(settings, "claudeAuthMode", { get: authMode, enumerable: true });
  Object.defineProperty(settings, "toJSON", { value: publicView, enumerable: false });
  Object.defineProperty(settings, util.inspect.custom, { value: publicView, enumerable: false });
  return Object.freeze(settings) as unknown as Settings;
}

/**
 * Container mode: reads SETTING_KEYS from process.env, then removes them from process.env
 * (even on error) so child processes such as `claude` never inherit the bot token.
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

function findClaudeBin(): string {
  const fallback = path.join(os.homedir(), ".local", "bin", "claude");
  if (process.platform !== "win32") return which("claude") ?? fallback;
  // Windows: a .cmd shim cannot be started without a shell, so prefer the real claude.exe.
  const found = which("claude.exe");
  if (found) return found;
  const shim = which("claude.cmd");
  if (shim) {
    const exe = path.join(path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (isExecutableFile(exe)) return exe;
  }
  const localExe = `${fallback}.exe`;
  return isExecutableFile(localExe) ? localExe : fallback;
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

function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
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
