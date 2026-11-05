# Sanoatgeokontexxizmat — Telegram AI assistant

A Telegram bot for «Sanoatgeokontexxizmat». Customers write to the bot; an **AI orchestrator** understands each
message, remembers the whole earlier conversation, answers on behalf of the company and collects the 14 investment
documents. Admins talk to an **Admin AI assistant** in plain Uzbek in the same bot and get statistics, analyses and
PDF/Excel/CSV reports from the real database. The Uzbek design notes are in [`docs/AI-TIZIM.md`](docs/AI-TIZIM.md).

- **AI**: Claude through the **Anthropic API** (`ANTHROPIC_API_KEY`) is the primary provider; **Google Gemini**
  (`GEMINI_API_KEY`) is the automatic backup. When Claude fails (key, billing, rate limit, outage) the bot switches to
  Gemini in the same request, keeps the full context, probes Claude every `AI_PROBE_MINUTES` and switches back. If
  both fail, messages are queued and answered once later. The Claude Code CLI and subscription token are no longer used.
- **Memory**: PostgreSQL (`DATABASE_URL`) with pgvector when available: every message, a customer profile (company
  name, STIR, location, mineral type, licence, services …), an auto-updated conversation summary, and semantic search
  over the customer's earlier messages (Gemini embeddings; keyword search otherwise). The bot never asks again for a
  fact the customer already gave, and does not repeat its own earlier replies.
- **Decision tree**: every customer message gets an analysis (type, complexity, context completeness, confidence,
  missing facts), a workflow (answer, sales, price, documents, clarify, escalate …), a self-check of the reply
  (forbidden "an employee will answer" phrases, prices not in the price list, repeats, re-asked facts) and a row in
  `ai_requests`.
- **Prices**: only from [`knowledge/prices.json`](knowledge/prices.json) (the price list of 30.10.2026), exactly as
  written, with the company's disclaimer and contacts. Services not in the list get no amount.
- **Nothing is deleted by age.** Data goes away only when an admin presses 🗑 for a chat.

## What it does

- **Direct chats.** Anyone who writes to the bot gets an answer from the orchestrator. Admins (`ADMIN_IDS`, all equal)
  are **not** sent every message: only 🚨 important requests, 💰 price requests, files and complete document packages.
- **Telegram Business (optional, needs Premium)** still works as before; employees' own messages there are recorded,
  never answered.
- **Preview mode is the default** (`AUTO_SEND=false`): replies are only logged and stored in `data/previews.jsonl`.
- **It works towards a deal**: it asks for the 14 documents (numbered, in the company's exact wording) and offers the
  express questionnaire. It never says that a responsible employee will answer; what it cannot confirm it says
  honestly, with the company's contacts.
- **It collects documents**: files are saved and counted, **not checked**; the complete package goes to the admins.
- **Escalation**: emergencies, complaints, official requests → alert to every admin with a ✍️ button.

## Behaviour

| Situation | What happens |
| --- | --- |
| Business connection of an account that is not an admin | Ignored, warning in the log, the AI is not called |
| Which chats | Whatever is selected in Telegram Business → Chatbots; every chat Telegram delivers is handled |
| An employee writes from the company account | Stored in history (as an admin message), never answered |
| Messages from bots / sent by this bot | Ignored (`sender_business_bot`, `is_bot`) |
| Same message delivered twice | Handled once (`data/seen.json` and `processed_updates` in PostgreSQL); at most one reply per message (`outgoing_replies`) |
| Service messages (title changes, pins …) | Ignored; stickers, voice, photos, documents are described as `[sticker] 😀`, `[voice message]` … |
| `/pause` | No replies are generated until `/resume` (kept across restarts) |
| Claude fails (auth, billing, rate limit, 5xx, timeout) | Transient errors are retried twice; then Gemini answers the same request with the same context; admins are told once; Claude is probed every `AI_PROBE_MINUTES` and used again when it answers |
| Claude and Gemini both fail | The message is queued (`pending_replies`), admins are told once, and it is answered (once) when a provider is back |
| The person writes again while a reply is being written | The older reply is dropped; the newer message is answered with both in view |
| The AI answers `[SKIP]` | Nothing is shown or sent ("thanks", "ok", stickers) |
| `[ESCALATE]`, or the analysis says complaint / emergency / official request | Every admin gets an alert with a ✍️ reply button |
| A customer asks a price | Price and days only from the price list, with the disclaimer and contacts; every admin gets a 💰 lead |
| Before an auto-send | Pause and ✍️ reply mode are checked again, and the business connection is re-read from Telegram |
| History retention | Nothing is deleted by age; only an admin's 🗑 deletes a chat (JSON files, folder and database rows) |
| Someone writes to the bot directly | The orchestrator answers (sent only with `AUTO_SEND=true`); the admins get no copy |
| A client sends files or photos (also 10-50 at once, any format) | Collected for `REVIEW_BATCH_SECONDS` (15 s) after the last one, then saved and counted (not checked); one summary goes to the client: `📥 N ta fayl qabul qilindi` and `Qabul qilingan fayllar: X/14`. The admin gets nothing until the package is complete |
| The last needed file arrives (however long it takes) | The admin gets one 🎉 message (with the documents the client does not have), then every file in albums of up to 10 (by `file_id`, so any size), each captioned `📄 3/14 — name` |
| Client presses «❌ Menda yo'q hujjatlar» | A menu of the 14 documents: each press marks ❌ / unmarks one; «✅ Tayyor» shows the status (e.g. `0/12`) and sends the package if the files already cover the rest. Bot chat only; in business chats Claude answers |
| A file comes after the package was sent | Passed to the admin at once as `🔄 Qo'shimcha fayl` |
| A file is larger than 20 MB | Downloaded over MTProto when `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` are set (up to `MAX_FILE_MB`, default and maximum 100); otherwise the client is asked to compress or split it |
| Client writes "holat" / "статус" / presses 📊 | Their document status, without Claude |
| Client writes "anketa" / "анкета" / presses 📄, or Claude adds `[SEND_TEMPLATE]` | The blank questionnaire is sent (Russian for Russian and English speakers) |
| Admin writes after pressing ✍️ | Text, photo, file or voice goes to that person; the bot is silent for that person until «✖️ Tugatish» (no timer, kept across restarts) |
| The person writes while the bot is silent | The message is passed to the admin with a ✍️ button, so nothing is missed |
| Admin presses ✖️ Tugatish | The silence ends at once: the bot answers that person again |
| More than 20 messages per hour from one person | The AI is not called |
| Admin writes without pressing ✍️ | The Admin AI assistant answers from the database (statistics, analyses, reports) |
| Groups, channels, other people's `/pause` `/status` | Ignored |

### Admin commands (private chat with the bot, from an `ADMIN_IDS` account)

- **Free text** — the Admin AI assistant: "Bugun nechta mijoz bilan gaplashildi?", "Eng ko'p gaplashilgan 20 ta chatni
  chiqar", "Birinchi mijoz haqida batafsil", "U oxirgi marta nimani so'ragan?", "Litsenziyasi tugashiga 30 kun qolgan
  korxonalar", "Narx so'ragan mijozlar", "Oxirgi 30 kunlik hisobotni PDF qilib ber". It reads the database only through
  read-only tools (overview, top chats, customer details and messages, customers by criterion, request statistics,
  unanswered questions, search, conversation analysis, provider status, report files) and keeps each admin's context
  ("birinchi mijoz", "shu mijoz"). `/new` starts a fresh topic.
- `/start` — guide in Uzbek. `/pause`, `/resume`, `/status` (AI provider, database, admins, reply modes), `/cancel`.
- **`users` button** (also `/users`): everyone who wrote to the bot, newest first, with a 📁 button per person:
  the conversation, document status and **✍️ Javob yozish**, **📄 chat.txt**, **📎 Qabul qilingan fayllar**,
  **🗑 Chatni o'chirish** (asks first; deletes the JSON history, the client folder and every database row of the person).
- **Answering a person:** press ✍️, then send anything; it goes to that person until **✖️ Tugatish** (or `/cancel`).
  The bot is silent for that person meanwhile; their messages are passed to the admins.

Turn **Threaded Mode off** in @BotFather (Bot Settings → Threaded Mode). It is a setting for the whole bot that the
Bot API cannot change: while it is on, Telegram shows topics ("folders") to the people who write to the bot. The bot
warns about it in the log at startup.

Anyone else who sends `/start` gets a short Uzbek welcome and a keyboard with **📊 Hujjatlar holati** and
**📄 Anketa shabloni** (Claude is not called for `/start`).

## Documents

The 14 documents asked for are listed in [`templates/investment-checklist/template.json`](templates/investment-checklist/template.json),
taken from the company's express questionnaire «Инвестициялар учун объект тайёргарлигининг экспресс-анкетаси»
(`uz.docx`) / «Экспресс-анкета готовности объекта к инвестициям» (`ru.docx`). The client is asked to send each one
as a separate file:

| # | Document |
| --- | --- |
| 1 | Company charter |
| 2 | Extract from the state register (ЕГРПО) |
| 3 | Electronic subsoil use permit / licence (one document) |
| 4 | Licence agreement (shartnoma) under resolution No. 133 |
| 5 | UTER (УТЭР) |
| 6 | Feasibility study (TIA / ТЭО) |
| 7 | Mining allotment project |
| 8 | Proof that form 5-GR was submitted |
| 9 | Environmental package: ZVOS |
| 10 | Environmental package: ZEP |
| 11 | Environmental package: PDV |
| 12 | Environmental package: limits |
| 13 | Industrial safety expert review (EPB) reports for hazardous facilities (OPO) |
| 14 | Land allotment decisions |

The questionnaire with the NDA stays in `template.json` with `"required": false`: the 📄 button and `[SEND_TEMPLATE]`
still send the blank form, but it is not counted.

**The bot does not check the files** (no Claude, no format check): it does not know which file is which document.
It only counts them:

1. A file is downloaded into `data/clients/<id>/inbox/` (kept across restarts), then moved to `received/` and
   counted. Files over `MAX_FILE_MB`, or over 20 MB without `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`, are refused
   and not counted (`refused.jsonl`).
2. The client gets `📥 N ta fayl qabul qilindi` with the names and `Qabul qilingan fayllar: X/14`, with the list of
   the 14 documents as a reminder. "holat" / "статус" / 📊 shows the same.
3. **Documents the client does not have.** The client presses «❌ Menda yo'q hujjatlar» (or writes it) and gets a
   menu of the 14 documents. Each press marks a document ❌ or unmarks it (kept in `status.json` as `missing`);
   «✅ Tayyor» writes the choice to the conversation and shows the status. Marked documents are not asked for: with
   2 marked, the package is 12 files. The menu works in the bot's own chat only (inline buttons).
4. The client may take minutes or days: the admin is sent nothing before. When the files cover every document the
   client has (after a file batch, or after «✅ Tayyor»), the admin gets **one 🎉 message** listing the missing
   documents, then **every file** in **albums of up to 10** (Telegram's limit; 14 files → 10 + 4), numbered in the
   order they came (`📄 3/14 — name`). If more come in one batch, all of them are sent. If an album fails, its
   files are sent one by one.
5. Files after that go to the admin one by one as `🔄 Qo'shimcha fayl (15-fayl): name`.
6. The 📎 button in the client's folder sends all received files at any time.

The number of files in a package is the number of required documents in `template.json` (14; 14 also when the
template cannot be read), less the documents the client marked as missing. Clients from the earlier version, when
files were checked, keep their accepted files: they are counted as received (a file that held several documents
once).

## How the AI is called

`src/ai/` holds one adapter per provider and the manager:

- `claudeProvider.ts` — Anthropic Messages API (`x-api-key`, tool use). Models: `CLAUDE_MODEL` (default
  `claude-sonnet-5-5`, replies and admin analysis) and `CLAUDE_MODEL_FAST` (default `claude-haiku-5-5`, analysis,
  summaries).
- `geminiProvider.ts` — `generateContent` with the key in the `x-goog-api-key` header (never in a URL), function calling
  with thought signatures, and `batchEmbedContents` for embeddings. Models: `GEMINI_MODEL` (default `gemini-3.8-flash`),
  `GEMINI_MODEL_FAST` (default `gemini-3.5-flash-lite`), `GEMINI_EMBEDDING_MODEL` (default `gemini-embedding-001`, 768 dims).
- `providerManager.ts` — AIProviderManager: retry with backoff for transient errors, timeout (`AI_TIMEOUT_SECONDS`),
  circuit breaker with a background probe every `AI_PROBE_MINUTES`, the same `ChatResponse` format from both, a log row
  per call (`ai_provider_logs`) and switch events for the admins.

Keys are never logged: errors are cleaned of the key, settings print `[hidden]`, and in container mode the variables are
removed from `process.env` after reading. `npm run check-ai` sends a tiny request to each configured provider.

## Data and privacy

**PostgreSQL** (`DATABASE_URL`) is the main store: `customers`, `companies`, `licenses`, `conversations`, `messages`,
`conversation_summaries`, `customer_memories`, `memory_embeddings`, `company_knowledge`, `customer_services`,
`sales_pipeline`, `tasks`, `scheduled_tasks`, `ai_requests`, `ai_provider_logs`, `admin_messages`, `admin_state`,
`admin_actions`, `reports`, `audit_logs`, `processed_updates`, `outgoing_replies`, `pending_replies`
(see [`src/db/migrations.ts`](src/db/migrations.ts)). Migrations run at start. pgvector is used when the server has it;
otherwise embeddings are stored as `real[]` and compared in Node. At every start the JSON files are imported (only what
is missing), so the existing conversations are in the database from the first run.

The volume (`/app/data`) still holds the client files and the JSON files the existing features use:

| File | Content |
| --- | --- |
| `transcripts.json` | Every message per chat (no limit, no expiry) |
| `history.json` | The last `HISTORY_LIMIT` messages per chat (a cache) |
| `previews.jsonl` | Replies prepared in preview mode |
| `seen.json` | IDs of handled messages (duplicates) |
| `state.json` | Pause flag, open ✍️ reply modes, date of the last daily report |
| `users.json` | People who wrote to the bot, for the `users` list |
| `mtproto.session` | MTProto session for files over 20 MB; keep it private |
| `clients/<id>/…` | chat.txt, received files, refused files, status, inbox |

Nothing is deleted by age. Only an admin's 🗑 deletes a person (JSON entries, folder and, by cascade, every database
row). Customers' messages are sent to Anthropic and, when Claude is down or for embeddings, to Google. Agree on this
with the company's management and align it with the company's personal-data requirements before going live.
Customers never get statistics or other customers' data: the customer flow has no access to the admin tools, and
every memory query is filtered by the customer's ID.

## Deploy to Railway

1. **Keys.** Claude: [console.anthropic.com](https://console.anthropic.com) → API keys. Gemini: Google AI Studio →
   Get API key. Never put them into the code or GitHub.
2. **PostgreSQL.** In the Railway project: **+ New → Database → PostgreSQL** (or the pgvector template, for vector
   search in the database). In the bot service's Variables add `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. **Variables** (Service → Variables → Raw Editor):
   ```
   TELEGRAM_BOT_TOKEN=...
   ADMIN_IDS=111111111,222222222
   ANTHROPIC_API_KEY=sk-ant-...
   GEMINI_API_KEY=...
   GEMINI_MODEL=gemini-3.8-flash
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   AUTO_SEND=false
   ```
   Remove `CLAUDE_CODE_OAUTH_TOKEN`, `OWNER_TAKEOVER_MINUTES` and `HISTORY_TTL_DAYS` (they are ignored; the log warns).
   `OWNER_ID` may stay: it is added to the admins.
4. **Volume** at `/app/data` stays as before (client files).
5. Logs should show `PostgreSQL connected`, `AI: primary claude …, backup gemini …`, `Price list: …`, `Mode: PREVIEW`.
6. From an admin account send `/start`, then `/status`. Test from another account. After the previews look right for a
   week or two, set `AUTO_SEND=true`.

Run the bot in one place only (two pollers with the same token disturb each other).

## Local development

Requires Node.js 22+ (and PostgreSQL for the full features).

```
npm install
cp .env.example .env && chmod 600 .env     # then fill in the keys
npm run check-ai
npm run try -- "Salom, UTER narxi qancha?"
```

### Commands

| Command | What it does | Exit codes |
| --- | --- | --- |
| `npm start` | Runs the bot with settings from `.env` | 0 stopped, 2 config error or bot token rejected |
| `node dist/bot.js --settings-from-env` | Container mode (Railway) | same |
| `npm run check-ai` | Sends a tiny request to Claude and Gemini | 0 at least one works, 1 none |
| `npm run try -- "text"` | Analysis, workflow and reply for a made-up message | 0 ok, 1 AI failed, 2 config error |
| `npm run typecheck` / `npm test` / `npm run build` | TypeScript check, tests, compile to `dist/` | |

### Tests

`npm test` runs offline: Telegram calls go to a recording transformer (`tests/harness.ts`), Claude and Gemini are
scripted fakes behind the real AIProviderManager (`tests/fakes.ts`).

- `tests/documents.test.ts` — the 14 documents, packages, previews, large files, business chats, deletion.
- `tests/providers.test.ts` — provider switching, circuit breaker, error classification, the Gemini adapter, price
  list, forbidden phrases, repeat and re-ask checks, decision tree.
- `tests/acceptance.test.ts` — the 10 acceptance tests of the specification (TZ 22) plus reports, the queue, deletion
  and the JSON import. They need PostgreSQL: `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test`
  (the user must be allowed to create databases; each test uses its own database). Without it they are skipped.

### Files

```
src/bot.ts                 entry point, startup checks, database, scheduler (queue, probes, embedding backfill)
src/config.ts              settings from .env or environment variables
src/handlers.ts            grammY router (customers, admins, buttons)
src/service.ts             Assistant: message flow, idempotency, queue, notifications, files and packages
src/ai/                    Claude and Gemini adapters, AIProviderManager, JSON helper
src/orchestrator/          AI orchestrator, decision tree, reply self-check
src/memory.ts              Memory Manager: profile, summary, semantic search, embeddings
src/db/                    PostgreSQL access, migrations, JSON import
src/admin/adminAssistant.ts  Admin AI assistant and its read-only tools
src/analytics.ts           statistics queries
src/reports.ts             PDF, Excel and CSV reports
src/knowledge/prices.ts    the price list (knowledge/prices.json) and amount checks
src/prompts.ts             customer system prompt, markers
src/store.ts, clientFolder.ts, documentReview.ts, templates.ts, largeFiles.ts, dailyReport.ts, backup.ts, language.ts
src/claudeCli.ts           the old Claude Code CLI wrapper (not used any more)
company.md                 company profile
knowledge/prices.json      price list (prices and days)
templates/                 the questionnaire and the 14 documents
docs/AI-TIZIM.md           design notes in Uzbek
tests/                     vitest tests
```
