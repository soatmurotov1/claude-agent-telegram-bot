import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { Bot, GrammyError } from "grammy";
import { ConfigError, envFileWarning, loadSettings, type Settings, settingsFromProcessEnv } from "./config.js";
import { Database } from "./db/database.js";
import { importJsonData } from "./db/importJson.js";
import { ALLOWED_UPDATES, buildComposer } from "./handlers.js";
import { loadPriceList } from "./knowledge/prices.js";
import { detectLanguage, LANGUAGE_NAMES } from "./language.js";
import { loadTemplate } from "./templates.js";
import { SKIP_TOKEN, splitEscalation, splitTemplate } from "./prompts.js";
import { buildAssistant, errorMessage, log, logError, makeProviderManager, profileIsFilled, readProfile } from "./service.js";
import { ensurePrivateDir } from "./store.js";

/** Project root: the parent of src/ (tsx) or dist/ (compiled). */
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(PROJECT_DIR, ".env");

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        "settings-from-env": { type: "boolean", default: false },
        "check-ai": { type: "boolean", default: false },
        // Old name of --check-ai, kept so existing scripts keep working.
        "check-claude": { type: "boolean", default: false },
        try: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    logError(`Invalid arguments: ${errorMessage(err)}`);
    logError('Usage: bot.js [--settings-from-env] [--check-ai | --try "message"]');
    return 2;
  }

  const fromEnv = args["settings-from-env"] === true;
  const checkAi = args["check-ai"] === true || args["check-claude"] === true;
  const needsTelegram = !checkAi && args.try === undefined;

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
  for (const key of settings.obsoleteSettings) {
    logError(`WARNING: ${key} is no longer used and can be removed (Claude now runs through ANTHROPIC_API_KEY; nothing is deleted by age).`);
  }
  for (const warning of settings.aiWarnings) logError(`WARNING: ${warning}`);
  ensurePrivateDir(settings.dataDir);

  if (checkAi) return checkProviders(settings);
  if (args.try !== undefined) return tryReply(settings, args.try);
  return runBot(settings);
}

/** Sends a tiny request to Claude and to Gemini and says which of them work. */
async function checkProviders(settings: Settings): Promise<number> {
  const { ai } = makeProviderManager(settings);
  if (!ai) {
    logError("Neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set.");
    return 1;
  }
  let ok = 0;
  for (const [name, configured] of [
    ["Claude", settings.anthropicApiKey],
    ["Gemini", settings.geminiApiKey],
  ] as const) {
    if (!configured) {
      log(`${name}: not configured.`);
      continue;
    }
    const { ai: single } = makeProviderManager({
      ...settings,
      anthropicApiKey: name === "Claude" ? settings.anthropicApiKey : "",
      geminiApiKey: name === "Gemini" ? settings.geminiApiKey : "",
    } as Settings);
    try {
      const response = await single!.chat({
        purpose: "check",
        tier: "fast",
        maxTokens: 20,
        system: "Answer with one word.",
        messages: [{ role: "user", content: "Say OK." }],
      });
      log(`${name}: OK (${response.model}, ${response.latencyMs} ms).`);
      ok++;
    } catch (err) {
      logError(`${name}: FAILED — ${errorMessage(err)}`);
    }
  }
  return ok > 0 ? 0 : 1;
}

async function tryReply(settings: Settings, text: string): Promise<number> {
  if (!text.trim()) {
    logError('Usage: npm run try -- "message text"');
    return 2;
  }
  const assistant = buildAssistant(settings);
  if (!assistant.ai) {
    logError("Neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set.");
    return 1;
  }
  const language = detectLanguage(text);
  const brain = assistant.brain;
  let result;
  try {
    result = await brain.reply({
      customerId: 1,
      chatName: "Test user",
      language,
      recent: [{ role: "other", name: "Test user", text, lang: language, ts: Date.now() / 1000 }],
      incoming: text,
      incomingKey: "try",
      companyName: settings.companyName,
      profileText: readProfile(settings.profilePath),
      now: new Date(),
    });
  } catch (err) {
    logError(`AI failed: ${errorMessage(err)}`);
    return 1;
  }
  const { escalate, text: withMarkers } = splitEscalation(result.raw);
  const { sendTemplate, text: reply } = splitTemplate(withMarkers);
  console.log(
    [
      `Provider:  ${result.provider ?? "-"} ${result.model ?? ""}`,
      `Language:  ${language ? LANGUAGE_NAMES[language] : "unknown"}`,
      `Message:   ${text}`,
      `Type:      ${result.analysis.requestType} (${result.analysis.complexity}, context ${result.analysis.contextCompleteness}, confidence ${result.analysis.confidence})`,
      `Workflow:  ${result.path.join(" -> ")}`,
      `Escalated: ${escalate ? "yes" : "no"}`,
      `Questionnaire: ${sendTemplate ? "sent after the reply" : "no"}`,
      `Reply:     ${reply.startsWith(SKIP_TOKEN) || !reply ? "(no reply: [SKIP])" : reply}`,
      ...(result.notes.length > 0 ? [`Notes:     ${result.notes.join("; ")}`] : []),
    ].join("\n"),
  );
  return 0;
}

async function connectDatabase(settings: Settings): Promise<Database | null> {
  if (!settings.databaseUrl) {
    logError(
      "WARNING: DATABASE_URL is not set. The bot runs on the JSON files only: no long-term memory search, no Admin AI " +
        "and no analytics. Add a PostgreSQL database (Railway: + New -> Database -> PostgreSQL) and set DATABASE_URL.",
    );
    return null;
  }
  try {
    const db = await Database.connect(settings.databaseUrl);
    log(`PostgreSQL connected (embeddings: ${db.vectorMode === "pgvector" ? "pgvector" : "real[] without pgvector"}).`);
    const imported = await importJsonData(db, settings.dataDir);
    if (imported.messages > 0) log(`Imported ${imported.messages} message(s) of ${imported.customers} customer(s) from the JSON files.`);
    return db;
  } catch (err) {
    logError(`WARNING: PostgreSQL is not reachable (${errorMessage(err)}). The bot runs on the JSON files only until restart.`);
    return null;
  }
}

async function runBot(settings: Settings): Promise<number> {
  const bot = new Bot(settings.botToken);
  const db = await connectDatabase(settings);
  const assistant = buildAssistant(settings, { db });
  bot.use(buildComposer(assistant, settings));
  bot.catch((err) => {
    logError(`Error while handling update ${err.ctx.update.update_id}: ${errorMessage(err.error)}`);
  });

  // A short network hiccup at start-up must not crash the container: Railway gives up after a few failed restarts.
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.init();
      break;
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 401) {
        logError("Telegram rejected TELEGRAM_BOT_TOKEN (401 Unauthorized). Check the token from @BotFather.");
        return 2;
      }
      if (attempt >= INIT_ATTEMPTS) throw err;
      logError(`Telegram is not reachable (${errorMessage(err)}). Retrying in ${attempt * 5} s (${attempt}/${INIT_ATTEMPTS}).`);
      await sleep(attempt * 5_000);
    }
  }
  await removeWebhook(bot);
  assistant.attachApi(bot.api);
  if (settings.aiWarnings.length > 0) {
    const text =
      "⚠️ Claude kaliti (ANTHROPIC_API_KEY) ishlamaydi, shuning uchun bot hozir faqat Gemini orqali javob beryapti.\n\n" +
      "Claude obuna tokeni (sk-ant-oat...) API uchun yaramaydi. console.anthropic.com -> API keys bo'limida " +
      "sk-ant-api... bilan boshlanadigan API kalit yarating va Railway -> Variables -> ANTHROPIC_API_KEY ga qo'ying.";
    for (const adminId of assistant.adminIds) {
      await bot.api.sendMessage(adminId, text).catch((err: unknown) => logError(`Could not warn admin ${adminId}: ${errorMessage(err)}`));
    }
  }

  log(`Bot @${bot.botInfo.username} is running`);
  log(`Company: ${settings.companyName}`);
  log(
    settings.autoSend
      ? "Mode: AUTO-SEND (WARNING: replies are sent to the people who wrote, without review)"
      : "Mode: PREVIEW (replies are only shown in the logs, nothing is sent)",
  );
  log(`Admins: ${assistant.adminIds.join(", ")}`);
  const status = assistant.ai?.status();
  if (!status) {
    logError("WARNING: no AI provider is configured (ANTHROPIC_API_KEY / GEMINI_API_KEY). Every message is queued.");
  } else {
    log(
      `AI: primary ${status.primary ?? "none"} (${settings.claudeModel} / ${settings.claudeModelFast}), backup ${status.backup ?? "none"}` +
        `${status.backup ? ` (${settings.geminiModel} / ${settings.geminiModelFast})` : ""}`,
    );
    if (!status.backup) logError("WARNING: GEMINI_API_KEY is not set: there is no backup when Claude fails, and no semantic search.");
    if (!status.primary) logError("WARNING: ANTHROPIC_API_KEY is not set: Gemini answers everything.");
  }
  const prices = loadPriceList(settings.pricesPath);
  log(prices ? `Price list: ${settings.pricesPath} (valid on ${prices.validOn})` : `WARNING: price list ${settings.pricesPath} not readable; no prices are named.`);
  log(`Data directory: ${settings.dataDir} (${assistant.history.chatCount()} chat(s) in memory)`);
  // Railway sets RAILWAY_VOLUME_MOUNT_PATH only when a volume is attached to the service.
  if (process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    logError(
      "WARNING: no Railway volume is attached, so the client files and JSON memory are lost on every deploy. Add a " +
        "volume mounted at /app/data to this service.",
    );
  } else if (process.env.RAILWAY_VOLUME_MOUNT_PATH && path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH) !== settings.dataDir) {
    logError(
      `WARNING: the Railway volume is mounted at ${process.env.RAILWAY_VOLUME_MOUNT_PATH}, but the bot writes to ` +
        `${settings.dataDir}. Change the volume's mount path to ${settings.dataDir}.`,
    );
  }
  if (bot.botInfo.has_topics_enabled) {
    logError(
      "WARNING: Threaded Mode (topics in private chats) is ON for this bot, so Telegram opens a new topic for " +
        "messages. Turn it off: @BotFather -> /mybots -> the bot -> Bot Settings -> Threaded Mode.",
    );
  }
  if (assistant.state.paused) logError("WARNING: the bot is paused. Send /resume to the bot from an admin account.");
  if (!profileIsFilled(readProfile(settings.profilePath))) {
    logError(`WARNING: ${settings.profilePath} is not filled in yet. Replies will contain almost no facts.`);
  }
  try {
    const template = loadTemplate(settings.templatesDir);
    log(`Document template: ${template.id} (a package is ${template.documents.filter((d) => d.required).length} files)`);
  } catch (err) {
    logError(`WARNING: ${errorMessage(err)}. A package is counted as 14 files.`);
  }
  if (assistant.mtproto) {
    void assistant.mtproto.check().then(
      (who) => log(`Files over 20 MB: enabled (MTProto login as ${who}), up to ${settings.maxFileMb} MB.`),
      (err: unknown) =>
        logError(
          `WARNING: files over 20 MB cannot be downloaded: MTProto login failed (${errorMessage(err)}). ` +
            "Check TELEGRAM_API_ID and TELEGRAM_API_HASH.",
        ),
    );
  } else {
    log("Files over 20 MB: off (set TELEGRAM_API_ID and TELEGRAM_API_HASH from my.telegram.org to accept them).");
  }
  const waiting = assistant.inbox.pending();
  if (waiting.length > 0) log(`Resuming the files waiting from ${waiting.length} client(s).`);
  assistant.resumePendingFiles(bot.api);
  assistant.startDailyReport(bot.api);
  log(`Daily report to the admins: every day at ${String(settings.dailyReportHour).padStart(2, "0")}:00 (Tashkent time).`);

  // Task Scheduler: queued replies, Claude probes, embedding backfill.
  assistant.startPendingWorker(bot.api);
  assistant.ai?.startProbes();
  if (assistant.memory) {
    const memory = assistant.memory;
    const backfill = setInterval(() => {
      void memory.backfill(40).catch((err: unknown) => logError(`Embedding backfill failed: ${errorMessage(err)}`));
    }, 5 * 60_000);
    backfill.unref();
  }

  let runner: RunnerHandle | null = null;
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`Received ${signal}, stopping...`);
    void Promise.resolve(runner?.stop())
      .then(() => assistant.idle())
      .then(() => db?.close())
      .finally(() => {
        log("Stopped.");
        process.exit(0);
      });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  // 409 Conflict means another getUpdates (a second copy of the bot with the same token: the bot started on a PC,
  // a second Railway service or replica, the previous deployment that has not stopped yet) or a webhook. The grammY
  // runner treats it as fatal; exiting would make Railway restart the bot a few times and then mark it Crashed.
  // Instead the bot waits and polls again, so it takes over as soon as the other copy stops.
  let conflictDelayMs = CONFLICT_DELAY_MIN_MS;
  while (!stopping) {
    const startedAt = Date.now();
    runner = run(bot, { runner: { fetch: { allowed_updates: ALLOWED_UPDATES } } });
    try {
      await runner.task();
      return 0;
    } catch (err) {
      if (stopping) return 0;
      if (!(err instanceof GrammyError && err.error_code === 409)) throw err;
      if (Date.now() - startedAt > 10 * 60_000) conflictDelayMs = CONFLICT_DELAY_MIN_MS;
      if (/webhook/i.test(err.description)) {
        await removeWebhook(bot);
      } else {
        logError(
          "WARNING: 409 Conflict — another copy of this bot is reading updates with the same TELEGRAM_BOT_TOKEN " +
            "(the bot running on a computer, a second Railway service or replica, or the previous deployment). " +
            `Only one copy may run. Polling again in ${Math.round(conflictDelayMs / 1000)} s.`,
        );
      }
      await sleep(conflictDelayMs);
      conflictDelayMs = Math.min(conflictDelayMs * 2, CONFLICT_DELAY_MAX_MS);
    }
  }
  return 0;
}

const INIT_ATTEMPTS = 6;
const CONFLICT_DELAY_MIN_MS = 5_000;
const CONFLICT_DELAY_MAX_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The bot reads updates by polling, which Telegram refuses (409) while a webhook is set for the token. */
async function removeWebhook(bot: Bot): Promise<void> {
  try {
    const info = await bot.api.getWebhookInfo();
    if (!info.url) return;
    await bot.api.deleteWebhook();
    logError(`WARNING: a webhook (${info.url}) was set for this bot token; it was removed so polling works.`);
  } catch (err) {
    logError(`WARNING: could not check or remove the webhook: ${errorMessage(err)}`);
  }
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
      // Exit now: open PostgreSQL connections would otherwise keep a bot that no longer polls alive for a while.
      process.exit(1);
    },
  );
}
