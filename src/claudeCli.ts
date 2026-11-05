import { spawn, type ChildProcessByStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import util from "node:util";
/** Kept from the CLI version (this module is no longer used by the bot). */
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
import { ensurePrivateDir, isRecord } from "./store.js";

/**
 * Builtin plugins of Claude Code 2.1.303 (still the same in 2.1.310), taken from the `plugins` field of the
 * stream-json init event. All of them are switched off for the bot.
 */
export const BUILTIN_PLUGINS = [
  "cc-plugin-agents-md@builtin",
  "cc-plugin-telemetry@builtin",
  "cc-plugin-plugin-authoring@builtin",
] as const;

export const ISOLATION_SETTINGS = {
  disableAllHooks: true,
  enabledPlugins: Object.fromEntries(BUILTIN_PLUGINS.map((name) => [name, false])),
} as const;

/** Variables removed from the child environment besides everything starting with ANTHROPIC_. */
const STRIPPED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_API_HASH",
  "TELEGRAM_API_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SIMPLE",
  "NODE_OPTIONS",
];

export class ClaudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeError";
  }
}

export class ClaudeTimeout extends ClaudeError {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeTimeout";
  }
}

export class ClaudeAuthError extends ClaudeError {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "ClaudeAuthError";
  }
}

export class ClaudeLimitError extends ClaudeError {
  constructor(
    readonly detail: string,
    readonly resetsAt: number | null,
    readonly resetText: string | null,
  ) {
    const when = resetText ?? (resetsAt !== null ? new Date(resetsAt * 1000).toISOString() : "at an unknown time");
    super(`Claude subscription usage limit reached (resets ${when})`);
    this.name = "ClaudeLimitError";
  }
}

const LIMIT_RE = /usage limit|hit your (usage )?limit|limit reached|rate[ _-]?limit|out of (extra )?usage|quota/i;
const AUTH_RE = /not logged in|\/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i;

/** Turns a CLI failure message into the matching error. Returns the error, does not throw it. */
export function classifyFailure(message: string, status: number | null = null): ClaudeError {
  const text = message.trim();
  if (status === 429 || LIMIT_RE.test(text)) {
    const epoch = /\|(\d{9,11})\b/.exec(text);
    const resetsAt = epoch?.[1] !== undefined ? Number(epoch[1]) : null;
    const detail = text.replace(/\|\d{9,11}\b/g, "").trim();
    const reset = /\bresets?\s+(?:at\s+)?([^|\n·]+)/i.exec(detail);
    const resetText = reset?.[1] !== undefined ? reset[1].trim().replace(/[.\s]+$/, "") || null : null;
    return new ClaudeLimitError(detail.slice(0, 500), resetsAt, resetText);
  }
  if (status === 401 || status === 403 || AUTH_RE.test(text)) {
    return new ClaudeAuthError(
      "Claude CLI is not logged in. Run `claude` on this machine and log in with /login.",
      text.slice(0, 300),
    );
  }
  return new ClaudeError(text.slice(0, 500) || "Claude CLI failed without a message");
}

/** Reads the final JSON result line printed by `claude -p --output-format json|stream-json`. */
export function parseResult(code: number | null, stdout: string, stderr: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  let data: unknown = null;
  if (last !== undefined) {
    try {
      data = JSON.parse(last);
    } catch {
      data = null;
    }
  }
  if (!isRecord(data)) {
    throw classifyFailure(stderr.trim() || stdout.trim() || `exit code ${String(code)}`);
  }
  const result = typeof data.result === "string" ? data.result : "";
  if (data.is_error === true || data.subtype !== "success") {
    const status = typeof data.api_error_status === "number" ? data.api_error_status : null;
    const message = `${result} ${stderr}`.trim() || `Claude CLI reported an error (${String(data.subtype)})`;
    throw classifyFailure(message, status);
  }
  const text = result.trim();
  if (!text) throw new ClaudeError("Claude CLI returned an empty reply");
  return text;
}

/** Environment for the claude child process: no Anthropic API keys, bot token or provider switches. */
export function buildEnv(oauthToken?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.toUpperCase().startsWith("ANTHROPIC_")) continue;
    if (STRIPPED_ENV.includes(key.toUpperCase())) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
}

export type OutputFormat = "json" | "stream-json";

/**
 * Flags of a document review: only the Read tool, confined by --restricted to the working directory (the review
 * folder with the client's files), allowed without a prompt; anything else that would ask is denied.
 */
export const REVIEW_TOOL_ARGS = [
  "--tools",
  "Read",
  "--restricted",
  "--allowedTools",
  "Read",
  "--permission-prompts",
  "none",
] as const;

export function buildArgs(
  promptFile: string,
  opts: { outputFormat: OutputFormat; effort: Effort; model?: string; review?: boolean },
): string[] {
  const args = [
    "-p",
    "--safe-mode",
    "--settings",
    JSON.stringify(ISOLATION_SETTINGS),
    ...(opts.review ? REVIEW_TOOL_ARGS : ["--tools", ""]),
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt-file",
    promptFile,
    "--output-format",
    opts.outputFormat,
    "--effort",
    opts.effort,
  ];
  if (opts.outputFormat === "stream-json") args.push("--verbose");
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export interface ClaudeOptions {
  workdir: string;
  model?: string;
  effort?: Effort;
  timeoutSeconds?: number;
  oauthToken?: string;
  authLabel?: string;
}

export interface InspectInit {
  tools: string[];
  mcp_servers: string[];
  plugins: string[];
  skills: string[];
  apiKeySource: string | null;
  apiProvider: string | null;
  model: string | null;
}

export interface InspectResult {
  auth: string;
  init: InspectInit | null;
  reply: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one `claude -p` process per reply, without a shell, in an isolated working directory. */
export class ClaudeCLI {
  readonly workdir: string;
  readonly model: string | undefined;
  readonly effort: Effort;
  readonly timeoutSeconds: number;
  readonly #oauthToken: string;
  readonly #authLabel: string | undefined;

  constructor(
    readonly claudeBin: string,
    opts: ClaudeOptions,
  ) {
    this.workdir = opts.workdir;
    this.model = opts.model || undefined;
    this.effort = opts.effort ?? "low";
    this.timeoutSeconds = opts.timeoutSeconds ?? 120;
    this.#oauthToken = opts.oauthToken ?? "";
    this.#authLabel = opts.authLabel;
  }

  get authMode(): string {
    if (this.#authLabel) return this.#authLabel;
    return this.#oauthToken ? "subscription token" : "this machine's claude login";
  }

  toJSON(): Record<string, unknown> {
    return {
      claudeBin: this.claudeBin,
      workdir: this.workdir,
      model: this.model ?? null,
      effort: this.effort,
      timeoutSeconds: this.timeoutSeconds,
      authMode: this.authMode,
    };
  }

  toString(): string {
    return `ClaudeCLI(${this.claudeBin}, ${this.authMode})`;
  }

  [util.inspect.custom](): Record<string, unknown> {
    return this.toJSON();
  }

  async generate(system: string, user: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const run = await this.#run(system, user, "json", { signal: opts.signal });
    return this.#parse(run);
  }

  /**
   * Checks the client's files in `dir` (a fresh 0700 folder holding only those files): Claude runs there and may
   * only read files inside it. The timeout is doubled, since scanned PDFs take longer.
   */
  async review(system: string, user: string, dir: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const run = await this.#run(system, user, "json", { signal: opts.signal, cwd: dir, review: true });
    return this.#parse(run);
  }

  /** Sends a tiny request with stream-json output and reports what the CLI loaded. */
  async inspect(): Promise<InspectResult> {
    const run = await this.#run("Reply with exactly: OK", "ping", "stream-json");
    let init: InspectInit | null = null;
    for (const line of run.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(event) && event.type === "system" && event.subtype === "init") {
        init = {
          tools: names(event.tools),
          mcp_servers: names(event.mcp_servers),
          plugins: names(event.plugins),
          skills: names(event.skills),
          apiKeySource: typeof event.apiKeySource === "string" ? event.apiKeySource : null,
          apiProvider: typeof event.apiProvider === "string" ? event.apiProvider : null,
          model: typeof event.model === "string" ? event.model : null,
        };
        break;
      }
    }
    const reply = this.#parse(run);
    return { auth: this.authMode, init, reply };
  }

  #redact(text: string): string {
    return this.#oauthToken ? text.split(this.#oauthToken).join("[REDACTED]") : text;
  }

  #parse(run: RunResult): string {
    try {
      return parseResult(run.code, this.#redact(run.stdout), this.#redact(run.stderr));
    } catch (err) {
      if (err instanceof ClaudeAuthError && this.#oauthToken) {
        throw new ClaudeAuthError(
          "Claude rejected the subscription token or it has expired: run `claude setup-token` on a computer " +
            `with a browser and update CLAUDE_CODE_OAUTH_TOKEN. CLI said: ${err.detail}`,
          err.detail,
        );
      }
      throw err;
    }
  }

  async #run(
    system: string,
    user: string,
    outputFormat: OutputFormat,
    opts: { signal?: AbortSignal; cwd?: string; review?: boolean } = {},
  ): Promise<RunResult> {
    ensurePrivateDir(this.workdir);
    const promptFile = path.join(this.workdir, `system-${crypto.randomBytes(12).toString("hex")}.txt`);
    const handle = await fs.promises.open(promptFile, "wx", 0o600);
    try {
      try {
        await handle.writeFile(system, "utf8");
      } finally {
        await handle.close();
      }
      const args = buildArgs(promptFile, { outputFormat, effort: this.effort, model: this.model, review: opts.review });
      const timeout = opts.review ? this.timeoutSeconds * 2 : this.timeoutSeconds;
      return await this.#spawn(args, user, { signal: opts.signal, cwd: opts.cwd ?? this.workdir, timeoutSeconds: timeout });
    } finally {
      await fs.promises.rm(promptFile, { force: true });
    }
  }

  #spawn(
    args: string[],
    input: string,
    { signal, cwd, timeoutSeconds }: { signal?: AbortSignal; cwd: string; timeoutSeconds: number },
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ClaudeError("Claude call was aborted before it started"));
        return;
      }
      let child: ChildProcessByStdio<Writable, Readable, Readable>;
      try {
        child = spawn(this.claudeBin, args, {
          cwd,
          env: buildEnv(this.#oauthToken || undefined),
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        reject(new ClaudeError(`Could not start Claude CLI at "${this.claudeBin}": ${String(error)}`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = (): void => {
        killGroup(child.pid);
        finish(() => reject(new ClaudeError("Claude call was aborted")));
      };
      const timer = setTimeout(() => {
        killGroup(child.pid);
        finish(() => reject(new ClaudeTimeout(`Claude did not answer within ${timeoutSeconds} s`)));
      }, timeoutSeconds * 1000);
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      // The CLI may exit before reading stdin; EPIPE must not crash the bot.
      child.stdin.on("error", () => undefined);
      child.on("error", (error) => {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
        finish(() =>
          reject(
            code === "ENOENT"
              ? new ClaudeError(`Claude CLI not found at "${this.claudeBin}". Install Claude Code or set CLAUDE_BIN.`)
              : new ClaudeError(`Could not start Claude CLI: ${error.message}`),
          ),
        );
      });
      child.on("close", (code) => {
        finish(() =>
          resolve({
            code,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
          }),
        );
      });
      child.stdin.end(input);
    });
  }
}

/** Kills the whole process group of a detached child (claude plus anything it started). */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false }).on(
        "error",
        () => undefined,
      );
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (error) {
    if (!(isRecord(error) && error.code === "ESRCH")) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (isRecord(item)) {
      if (typeof item.source === "string") return item.source;
      if (typeof item.name === "string") return item.name;
    }
    return JSON.stringify(item);
  });
}
