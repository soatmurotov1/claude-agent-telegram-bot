import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { run } from "@grammyjs/runner";
import { Bot, GrammyError } from "grammy";
import { ClaudeError } from "./claudeCli.js";
import {
  ConfigError,
  envFileWarning,
  loadSettings,
  type Settings,
  settingsFromProcessEnv,
} from "./config.js";
import { ALLOWED_UPDATES, buildComposer } from "./handlers.js";
import { detectLanguage, LANGUAGE_NAMES } from "./language.js";
import { buildSystemPrompt, buildUserPrompt, SKIP_TOKEN, splitEscalation } from "./prompts.js";
import {
  buildAssistant,
  errorMessage,
  log,
  logError,
  makeClaudeCli,
  profileIsFilled,
  readProfile,
} from "./service.js";
import { ensurePrivateDir, pruneJsonl } from "./store.js";

/** Project root: the parent of src/ (tsx) or dist/ (compiled). */
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(PROJECT_DIR, ".env");

const FORBIDDEN_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        "settings-from-env": { type: "boolean", default: false },
        "check-claude": { type: "boolean", default: false },
        try: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    logError(`Invalid arguments: ${errorMessage(err)}`);
    logError('Usage: bot.js [--settings-from-env] [--check-claude | --try "message"]');
    return 2;
  }

  const fromEnv = args["settings-from-env"] === true;
  const needsTelegram = !args["check-claude"] && args.try === undefined;

  let settings: Settings;
  try {
    settings = fromEnv
      ? settingsFromProcessEnv(ENV_FILE, { requireTelegram: needsTelegram })
      : loadSettings(ENV_FILE, { requireTelegram: needsTelegram });
  } catch (err) {
    if (err instanceof ConfigError) {
      logError(`Configuration error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (!fromEnv) {
    const warning = envFileWarning(settings.envFile);
    if (warning) logError(`WARNING: ${warning}`);
  }
  ensurePrivateDir(settings.dataDir);
  ensurePrivateDir(path.join(settings.dataDir, "claude-run"));
  const pruned = pruneJsonl(path.join(settings.dataDir, "previews.jsonl"), settings.historyTtlDays, () => Date.now() / 1000);
  if (pruned > 0) log(`Removed ${pruned} preview record(s) older than ${settings.historyTtlDays} days.`);

  if (args["check-claude"]) return checkClaude(settings);
  if (args.try !== undefined) return tryReply(settings, args.try);
  return runBot(settings);
}

async function checkClaude(settings: Settings): Promise<number> {
  const cli = makeClaudeCli(settings);
  log(`Checking Claude CLI at ${settings.claudeBin} (auth: ${settings.claudeAuthMode})...`);
  let result;
  try {
    result = await cli.inspect();
  } catch (err) {
    logError(`Claude check failed: ${err instanceof ClaudeError ? err.message : errorMessage(err)}`);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));

  const problems: string[] = [];
  const init = result.init;
  if (!init) {
    problems.push("the CLI did not report an init event");
  } else {
    for (const key of ["tools", "mcp_servers", "plugins", "skills"] as const) {
      if (init[key].length > 0) problems.push(`${key} must be empty but is: ${init[key].join(", ")}`);
    }
    if (init.apiKeySource !== null && FORBIDDEN_KEY_SOURCES.has(init.apiKeySource)) {
      problems.push(`the CLI uses an API key (apiKeySource=${init.apiKeySource}), not the subscription`);
    }
    if (init.apiProvider !== null && init.apiProvider !== "firstParty") {
      problems.push(`the CLI uses provider ${init.apiProvider}, expected firstParty`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) logError(`Claude check failed: ${problem}`);
    return 1;
  }
  log(`Claude check passed. Auth: ${result.auth}.`);
  return 0;
}

async function tryReply(settings: Settings, text: string): Promise<number> {
  if (!text.trim()) {
    logError('Usage: npm run try -- "message text"');
    return 2;
  }
  const language = detectLanguage(text);
  const system = buildSystemPrompt(settings.companyName, readProfile(settings.profilePath), new Date());
  const user = buildUserPrompt(
    [{ role: "other", name: "Test user", text, lang: language, ts: Date.now() / 1000 }],
    language,
  );
  let raw: string;
  try {
    raw = await makeClaudeCli(settings).generate(system, user);
  } catch (err) {
    logError(`Claude failed: ${errorMessage(err)}`);
    return 1;
  }
  const { escalate, text: reply } = splitEscalation(raw);
  console.log(
    [
      `Auth:      ${settings.claudeAuthMode}`,
      `Language:  ${language ? LANGUAGE_NAMES[language] : "unknown"}`,
      `Message:   ${text}`,
      `Escalated: ${escalate ? "yes" : "no"}`,
      `Reply:     ${reply.startsWith(SKIP_TOKEN) || !reply ? "(no reply: [SKIP])" : reply}`,
    ].join("\n"),
  );
  return 0;
}

async function runBot(settings: Settings): Promise<number> {
  const bot = new Bot(settings.botToken);
  const assistant = buildAssistant(settings);
  bot.use(buildComposer(assistant, settings));
  bot.catch((err) => {
    logError(`Error while handling update ${err.ctx.update.update_id}: ${errorMessage(err.error)}`);
  });

  try {
    await bot.init();
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 401) {
      logError("Telegram rejected TELEGRAM_BOT_TOKEN (401 Unauthorized). Check the token from @BotFather.");
      return 2;
    }
    throw err;
  }

  log(`Bot @${bot.botInfo.username} is running`);
  log(`Company: ${settings.companyName}`);
  if (settings.autoSend) {
    log("Mode: AUTO-SEND (WARNING: replies are sent to the people who wrote, without review)");
  } else {
    log("Mode: PREVIEW (replies are only shown in the logs, nothing is sent)");
  }
  log(`Direct chats: anyone may write to the bot; copies go to OWNER_ID ${settings.ownerId}`);
  log(`Claude auth: ${settings.claudeAuthMode}`);
  log(`Claude binary: ${settings.claudeBin}`);
  if (assistant.state.paused) logError("WARNING: the bot is paused. Send /resume to the bot from the owner account.");
  if (!profileIsFilled(readProfile(settings.profilePath))) {
    logError(`WARNING: ${settings.profilePath} is not filled in yet. Replies will contain almost no facts.`);
  }

  const runner = run(bot, { runner: { fetch: { allowed_updates: ALLOWED_UPDATES } } });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`Received ${signal}, stopping...`);
    void runner.stop().finally(() => {
      log("Stopped.");
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  await runner.task();
  return 0;
}

process.on("unhandledRejection", (reason) => {
  logError(`Unhandled promise rejection: ${errorMessage(reason)}`);
});

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      logError(`Fatal error: ${errorMessage(err)}`);
      process.exitCode = 1;
    },
  );
}
