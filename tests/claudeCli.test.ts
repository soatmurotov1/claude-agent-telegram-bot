import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BUILTIN_PLUGINS,
  ClaudeAuthError,
  ClaudeCLI,
  ClaudeError,
  ClaudeLimitError,
  ClaudeTimeout,
  classifyFailure,
  parseResult,
} from "../src/claudeCli.js";
import { isWindows } from "./helpers.js";

const TOKEN = `sk-ant-oat01-${"Ab3_".repeat(16)}`;

const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("fs");
const { spawn } = require("child_process");
const mode = process.env.FAKE_MODE || "ok";
const report = process.env.FAKE_REPORT;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--system-prompt-file");
  const promptFile = i >= 0 ? argv[i + 1] : null;
  const cwd = process.cwd();
  const data = {
    argv, stdin, env: process.env, cwd,
    cwdMode: fs.statSync(cwd).mode & 0o777,
    cwdEntries: fs.readdirSync(cwd),
    pid: process.pid,
    promptFile,
    systemPrompt: promptFile ? fs.readFileSync(promptFile, "utf8") : null,
    promptMode: promptFile ? fs.statSync(promptFile).mode & 0o777 : null,
  };
  const write = (extra) => fs.writeFileSync(report, JSON.stringify({ ...data, ...extra }));
  const result = (obj) => process.stdout.write(JSON.stringify({ type: "result", ...obj }) + "\\n");
  const stream = argv.includes("stream-json");
  switch (mode) {
    case "ok":
      write();
      if (stream) {
        process.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [], plugins: [], skills: [], apiKeySource: "none", model: "fake-model" }) + "\\n");
      }
      result({ subtype: "success", is_error: false, result: "  Hello from fake Claude  \\n" });
      break;
    case "sleep": {
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      write({ grandchildPid: grandchild.pid });
      setTimeout(() => {}, 60000);
      break;
    }
    case "limit_epoch":
      write();
      result({ subtype: "success", is_error: true, result: "Claude AI usage limit reached|1900000000" });
      process.exit(1);
    case "limit_text":
      write();
      result({ subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm (Asia/Tashkent)" });
      process.exit(1);
    case "auth":
      write();
      process.stderr.write("OAuth token " + (process.env.CLAUDE_CODE_OAUTH_TOKEN || "none") + " has expired\\n");
      result({ subtype: "success", is_error: true, result: "Invalid API key · Please run /login", api_error_status: 401 });
      process.exit(1);
    case "crash":
      write();
      process.stderr.write("Segmentation fault in fake claude\\n");
      process.exit(3);
    case "empty":
      write();
      result({ subtype: "success", is_error: false, result: "   " });
      break;
    case "echo_token":
      write();
      result({ subtype: "success", is_error: false, result: "token=" + (process.env.CLAUDE_CODE_OAUTH_TOKEN || "none") });
      break;
  }
});
`;

interface Report {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  cwdMode: number;
  cwdEntries: string[];
  pid: number;
  promptFile: string | null;
  systemPrompt: string | null;
  promptMode: number | null;
  grandchildPid?: number;
}

let dir = "";
let fakeBin = "";
let reportFile = "";
let workdir = "";
const savedEnv = { ...process.env };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sgk-claude-test-"));
  fakeBin = path.join(dir, "claude");
  fs.writeFileSync(fakeBin, FAKE_CLAUDE, { mode: 0o755 });
  fs.chmodSync(fakeBin, 0o755);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

let counter = 0;
function setup(mode: string, opts: { token?: string; timeoutSeconds?: number; label?: string } = {}): ClaudeCLI {
  counter += 1;
  reportFile = path.join(dir, `report-${counter}.json`);
  workdir = path.join(dir, `work-${counter}`, "claude-run");
  process.env.FAKE_MODE = mode;
  process.env.FAKE_REPORT = reportFile;
  return new ClaudeCLI(fakeBin, {
    workdir,
    effort: "low",
    timeoutSeconds: opts.timeoutSeconds ?? 10,
    oauthToken: opts.token,
    authLabel: opts.label,
  });
}

function report(): Report {
  return JSON.parse(fs.readFileSync(reportFile, "utf8")) as Report;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err instanceof Error && "code" in err && err.code === "ESRCH");
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

async function waitForReport(ms = 5000): Promise<Report> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(reportFile)) {
      try {
        return report();
      } catch {
        // partially written
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("fake claude did not write a report");
}

// The fake CLI is a shebang script and the tests rely on POSIX process groups and file modes.
describe.skipIf(isWindows)("ClaudeCLI with a fake claude binary", () => {
  it("returns the trimmed result", async () => {
    const cli = setup("ok");
    await expect(cli.generate("system text", "hello")).resolves.toBe("Hello from fake Claude");
  });

  it("passes the conversation only on stdin and the system prompt only through a 0600 file", async () => {
    const cli = setup("ok");
    const profile = "COMPANY_SECRET_PROFILE_LINE";
    await cli.generate(`rules\n<company>${profile}</company>`, "USER_MESSAGE_TEXT");
    const r = report();
    expect(r.stdin).toBe("USER_MESSAGE_TEXT");
    expect(r.argv.join(" ")).not.toContain("USER_MESSAGE_TEXT");
    expect(r.argv.join(" ")).not.toContain(profile);
    expect(r.systemPrompt).toContain(profile);
    expect(r.promptMode).toBe(0o600);
    expect(r.promptFile && fs.existsSync(r.promptFile)).toBe(false);
  });

  it("removes the prompt file on errors too", async () => {
    const cli = setup("crash");
    await expect(cli.generate("system", "x")).rejects.toBeInstanceOf(ClaudeError);
    const r = report();
    expect(r.promptFile && fs.existsSync(r.promptFile)).toBe(false);
  });

  it("never runs shell syntax from the message", async () => {
    const cli = setup("ok");
    const a = path.join(dir, "pwned-a");
    const b = path.join(dir, "pwned-b");
    const text = `$(touch ${a}) \`touch ${b}\` ; touch ${a}`;
    await cli.generate("system", text);
    expect(report().stdin).toBe(text);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });

  it("passes every isolation flag in order and no --mcp-config or --bare", async () => {
    const cli = setup("ok");
    await cli.generate("system", "hi");
    const { argv } = report();
    const promptIndex = argv.indexOf("--system-prompt-file");
    expect(argv).toEqual([
      "-p",
      "--safe-mode",
      "--settings",
      argv[3],
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--system-prompt-file",
      argv[promptIndex + 1],
      "--output-format",
      "json",
      "--effort",
      "low",
    ]);
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--bare");
    const settings = JSON.parse(argv[3] ?? "{}") as {
      disableAllHooks: boolean;
      enabledPlugins: Record<string, boolean>;
    };
    expect(settings.disableAllHooks).toBe(true);
    for (const plugin of BUILTIN_PLUGINS) expect(settings.enabledPlugins[plugin]).toBe(false);
  });

  it("adds --model when configured and --verbose for stream-json", async () => {
    const cli = new ClaudeCLI(fakeBin, { workdir: path.join(dir, "model-run"), model: "sonnet", timeoutSeconds: 10 });
    process.env.FAKE_MODE = "ok";
    reportFile = path.join(dir, "report-model.json");
    process.env.FAKE_REPORT = reportFile;
    await cli.inspect();
    const { argv } = report();
    expect(argv).toContain("--verbose");
    expect(argv.slice(-2)).toEqual(["--model", "sonnet"]);
  });

  it("cleans the child environment", async () => {
    const cli = setup("ok");
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-parent";
    process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
    process.env.TELEGRAM_BOT_TOKEN = "1:parent";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-parent-token";
    process.env.CLAUDE_CODE_SIMPLE = "1";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.NODE_OPTIONS = "--max-old-space-size=64";
    await cli.generate("system", "hi");
    const { env } = report();
    for (const key of Object.keys(env)) expect(key.startsWith("ANTHROPIC_")).toBe(false);
    for (const key of [
      "TELEGRAM_BOT_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_SIMPLE",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "NODE_OPTIONS",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
  });

  it("puts a configured token only into the child environment", async () => {
    const cli = setup("ok", { token: TOKEN });
    await cli.generate("system prompt", "user text");
    const r = report();
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(r.argv.join(" ")).not.toContain(TOKEN);
    expect(r.stdin).not.toContain(TOKEN);
    expect(r.systemPrompt).not.toContain(TOKEN);
    expect(JSON.stringify(cli)).not.toContain(TOKEN);
    expect(util.inspect(cli, { showHidden: true, depth: 5 })).not.toContain(TOKEN);
    expect(String(cli)).not.toContain(TOKEN);
  });

  it("has no token in the child when none is configured", async () => {
    const cli = setup("echo_token");
    await expect(cli.generate("system", "hi")).resolves.toBe("token=none");
    expect(report().env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("redacts the token from CLI output", async () => {
    const cli = setup("echo_token", { token: TOKEN });
    await expect(cli.generate("system", "hi")).resolves.toBe("token=[REDACTED]");
  });

  it("explains a rejected token without showing it", async () => {
    const cli = setup("auth", { token: TOKEN });
    const err = await cli.generate("system", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeAuthError);
    const message = (err as ClaudeAuthError).message;
    expect(message).toContain("claude setup-token");
    expect(message).toContain("CLI said:");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(TOKEN);
    expect((err as ClaudeAuthError).detail).not.toContain(TOKEN);
  });

  it("inspect() reports the auth mode and the init event", async () => {
    const cli = setup("ok", { token: TOKEN, label: "subscription token from .env" });
    const result = await cli.inspect();
    expect(result.auth).toBe("subscription token from .env");
    expect(result.reply).toBe("Hello from fake Claude");
    expect(result.init).toEqual({
      tools: [],
      mcp_servers: [],
      plugins: [],
      skills: [],
      apiKeySource: "none",
      apiProvider: null,
      model: "fake-model",
    });
    expect(setup("ok").authMode).toBe("this machine's claude login");
  });

  it("runs in its own private working directory", async () => {
    const cli = setup("ok");
    await cli.generate("system", "hi");
    const r = report();
    expect(fs.realpathSync(r.cwd)).toBe(fs.realpathSync(workdir));
    expect(r.cwdMode).toBe(0o700);
    expect(r.cwdEntries).toHaveLength(1);
    expect(r.cwdEntries[0]).toMatch(/^system-[0-9a-f]+\.txt$/);
  });

  it("kills the whole process group on timeout", async () => {
    const cli = setup("sleep", { timeoutSeconds: 1 });
    const started = Date.now();
    const err = await cli.generate("system", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeTimeout);
    expect(err).toBeInstanceOf(ClaudeError);
    expect(Date.now() - started).toBeLessThan(5000);
    const r = await waitForReport();
    expect(await waitDead(r.pid)).toBe(true);
    expect(r.grandchildPid).toBeDefined();
    expect(await waitDead(r.grandchildPid ?? 0)).toBe(true);
  });

  it("kills the process group when the signal aborts", async () => {
    const cli = setup("sleep", { timeoutSeconds: 30 });
    const controller = new AbortController();
    const pending = cli.generate("system", "hi", { signal: controller.signal }).catch((e: unknown) => e);
    const r = await waitForReport();
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err).not.toBeInstanceOf(ClaudeTimeout);
    expect(await waitDead(r.pid)).toBe(true);
    expect(await waitDead(r.grandchildPid ?? 0)).toBe(true);
  });

  it("classifies limit, login, crash and empty failures", async () => {
    const epoch = await setup("limit_epoch").generate("s", "u").catch((e: unknown) => e);
    expect(epoch).toBeInstanceOf(ClaudeLimitError);
    expect((epoch as ClaudeLimitError).resetsAt).toBe(1900000000);

    const text = await setup("limit_text").generate("s", "u").catch((e: unknown) => e);
    expect(text).toBeInstanceOf(ClaudeLimitError);
    expect((text as ClaudeLimitError).resetText).toBe("3pm (Asia/Tashkent)");
    expect((text as ClaudeLimitError).resetsAt).toBeNull();

    const auth = await setup("auth").generate("s", "u").catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(ClaudeAuthError);
    expect((auth as Error).message).toContain("/login");

    const crash = await setup("crash").generate("s", "u").catch((e: unknown) => e);
    expect(crash).toBeInstanceOf(ClaudeError);
    expect(crash).not.toBeInstanceOf(ClaudeAuthError);
    expect((crash as Error).message).toContain("Segmentation fault");

    const empty = await setup("empty").generate("s", "u").catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(ClaudeError);
    expect((empty as Error).message).toContain("empty");
  });

  it("reports a missing binary", async () => {
    const cli = new ClaudeCLI(path.join(dir, "does-not-exist"), { workdir: path.join(dir, "missing-run") });
    const err = await cli.generate("s", "u").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect((err as Error).message).toContain("not found");
  });
});

describe("classifyFailure", () => {
  it("detects limits by status and by text, with epoch and reset text", () => {
    const byStatus = classifyFailure("Too many requests", 429);
    expect(byStatus).toBeInstanceOf(ClaudeLimitError);

    const epoch = classifyFailure("Claude AI usage limit reached|1760000000");
    expect(epoch).toBeInstanceOf(ClaudeLimitError);
    expect((epoch as ClaudeLimitError).resetsAt).toBe(1760000000);
    expect((epoch as ClaudeLimitError).detail).toBe("Claude AI usage limit reached");
    expect(epoch.message).toMatch(/^Claude subscription usage limit reached \(resets /);

    const text = classifyFailure("You've hit your usage limit · resets 3pm (Europe/Berlin)");
    expect((text as ClaudeLimitError).resetText).toBe("3pm (Europe/Berlin)");
    expect(text.message).toBe("Claude subscription usage limit reached (resets 3pm (Europe/Berlin))");

    for (const msg of ["rate_limit_error", "You are out of extra usage", "quota exceeded", "Rate limit hit"]) {
      expect(classifyFailure(msg)).toBeInstanceOf(ClaudeLimitError);
    }
  });

  it("detects login problems", () => {
    for (const msg of ["Not logged in · Please run /login", "Invalid API key", "authentication_error", "401 Unauthorized"]) {
      const err = classifyFailure(msg);
      expect(err).toBeInstanceOf(ClaudeAuthError);
      expect(err.message).toContain("/login");
      expect((err as ClaudeAuthError).detail).toBe(msg);
    }
    expect(classifyFailure("forbidden", 403)).toBeInstanceOf(ClaudeAuthError);
    expect(classifyFailure("x".repeat(1000) + " not logged in")).toBeInstanceOf(ClaudeAuthError);
    expect((classifyFailure("not logged in " + "y".repeat(1000)) as ClaudeAuthError).detail.length).toBe(300);
  });

  it("falls back to a generic, truncated ClaudeError", () => {
    const err = classifyFailure("z".repeat(2000));
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err).not.toBeInstanceOf(ClaudeLimitError);
    expect(err).not.toBeInstanceOf(ClaudeAuthError);
    expect(err.message.length).toBe(500);
  });

  it("sets error names and the class hierarchy", () => {
    expect(new ClaudeError("a").name).toBe("ClaudeError");
    expect(new ClaudeTimeout("a").name).toBe("ClaudeTimeout");
    expect(new ClaudeAuthError("a", "b").name).toBe("ClaudeAuthError");
    expect(new ClaudeLimitError("a", null, null).name).toBe("ClaudeLimitError");
    for (const err of [new ClaudeTimeout("a"), new ClaudeAuthError("a", "b"), new ClaudeLimitError("a", 1, null)]) {
      expect(err).toBeInstanceOf(ClaudeError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("parseResult", () => {
  it("returns the trimmed result of the last JSON line", () => {
    const stdout = `{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success","is_error":false,"result":"  Javob  "}\n\n`;
    expect(parseResult(0, stdout, "")).toBe("Javob");
  });

  it("classifies error results with stderr and api_error_status", () => {
    const limit = `{"type":"result","subtype":"success","is_error":true,"result":"Request failed","api_error_status":429}`;
    expect(() => parseResult(1, limit, "")).toThrow(ClaudeLimitError);
    const auth = `{"type":"result","subtype":"error_during_execution","is_error":false,"result":""}`;
    expect(() => parseResult(1, auth, "Not logged in")).toThrow(ClaudeAuthError);
  });

  it("rejects empty results and non-JSON output", () => {
    expect(() => parseResult(0, `{"type":"result","subtype":"success","is_error":false,"result":" "}`, "")).toThrow(
      /empty/,
    );
    expect(() => parseResult(1, "plain text", "boom")).toThrow("boom");
    expect(() => parseResult(1, "plain text", "")).toThrow("plain text");
    expect(() => parseResult(2, "", "")).toThrow("exit code 2");
  });
});
