# Sanoatgeokontexxizmat — Telegram Business assistant

A Telegram Business bot for the **company account** of «Sanoatgeokontexxizmat». When a citizen, customer or
partner organisation writes to that account, the bot prepares a formal, polite reply on behalf of the company.
Everything the bot knows about the company comes from [`company.md`](company.md).

Replies are written by the **Claude Code CLI** (`claude -p`) installed next to the bot, using a Claude
**subscription** token from `claude setup-token`. An Anthropic API key is never used.

## What it does

The bot works in two ways at the same time:

- **Direct chats (no Telegram Premium needed).** Anyone who writes to the bot itself gets a reply prepared from
  `company.md`. The admin (`OWNER_ID`) is **not** sent every message: only 🚨 important requests and the files,
  photos and voice messages people send (forwarded, as `company.md` promises them). The admin reads a conversation
  and answers it from the `users` button (see below); the bot then stays silent in that chat for
  `OWNER_TAKEOVER_MINUTES`. At most 20 Claude calls per person per hour, to protect the subscription limit.
- **Telegram Business (optional, needs Premium).** The bot can also be connected to the company's account through
  Telegram Business → **Chatbots** and then answers the chats of that account.

Common to both:

- **Preview mode is the default** (`AUTO_SEND=false`): replies are not sent to anyone. They are printed to the log
  as `PREVIEW, not sent` blocks, stored in `data/previews.jsonl`, and for direct chats shown to the admin as a
  draft. Set `AUTO_SEND=true` to let the bot answer people.
- There is no allowlist in the code: anyone may write to the bot; for Business, Telegram's Chatbots setting
  decides which chats the bot sees.
- **It works towards a deal.** It answers from `company.md` and moves the person to the next step: it sends the
  express questionnaire (anketa with NDA, Uzbek or Russian), asks them to fill in and sign it and to send the
  documents listed in it. "A responsible employee will answer" is kept for serious cases only (exact prices, the
  company's own deadlines, guarantees, complaints, emergencies, official requests). It still makes no promises
  about prices, deadlines, permits, expert reviews or inspection results.
- **It checks documents.** Files clients send are checked against the template, saved per client and summed up
  as percentages (see [Documents](#documents)).
- **Escalation**: for emergencies (accident, gas leak, fire, injury, collapse), complaints, official requests,
  or mentions of courts, prosecutors or media, Claude starts its answer with `[ESCALATE]`. The bot then sends the
  owner a private alert (in Uzbek) in the bot chat — also in preview mode — at most once per 10 minutes per chat.

## Behaviour

| Situation | What happens |
| --- | --- |
| Connection of another Telegram account (not `OWNER_ID`) | Ignored, warning in the log, Claude is not called |
| Which chats | Whatever is selected in Telegram Business → Chatbots; every chat Telegram delivers is handled |
| An employee writes from the company account | Stored in history, never answered; the bot stays silent in that chat for `OWNER_TAKEOVER_MINUTES` |
| Messages from bots / sent by this bot | Ignored (`sender_business_bot`, `is_bot`) |
| Same message delivered twice | Handled once (kept in `data/seen.json`, survives restarts) |
| Service messages (title changes, pins …) | Ignored; stickers, voice, photos, documents are described as `[sticker] 😀`, `[voice message]` … |
| `/pause` | No replies are generated until `/resume` (kept across restarts) |
| Subscription usage limit | No Claude calls until the reset time (or `LIMIT_COOLDOWN_MINUTES`); kept across restarts; owner is told in auto-send mode |
| Timeout or login error | Nothing is sent to the chat; owner is told in auto-send mode (at most every 10 minutes) |
| Claude answers `[SKIP]` | Nothing is shown or sent ("thanks", "ok", stickers) |
| Claude answers `[ESCALATE] …` | Owner gets an alert with a ✍️ reply button; the reply itself follows the normal preview/auto-send path |
| Before an auto-send | Pause/limit/takeover are checked again, and the connection is re-read from Telegram (owner, enabled, reply right) |
| History retention | Messages and previews older than `HISTORY_TTL_DAYS` (default 30) are deleted |
| Someone writes to the bot directly | Claude answers from `company.md` (sent only with `AUTO_SEND=true`); the admin gets no copy |
| A client sends files or photos (also 10-50 at once) | Collected for `REVIEW_BATCH_SECONDS` (15 s) after the last one, then each is checked against the template; one summary goes to the client, a short note to the admin |
| A file cannot be checked (bad JSON from Claude, CLI error) | Saved in `rejected/` and sent to the admin with ⚠️ |
| A file is larger than 20 MB | Not downloaded (Bot API limit); the client is asked to compress or split it |
| Client writes "holat" / "статус" / presses 📊 | Their document status, without Claude |
| Client writes "anketa" / "анкета" / presses 📄, or Claude adds `[SEND_TEMPLATE]` | The blank questionnaire is sent (Russian for Russian and English speakers) |
| More than `REVIEW_DAILY_LIMIT` document checks in 24 h | Remaining files wait in the inbox and are retried an hour later |
| Admin writes after pressing ✍️ | Text, photo, file or voice goes to that person; the bot is silent there for `OWNER_TAKEOVER_MINUTES` |
| The person writes while the bot is silent | The message is passed to the admin with a ✍️ button, so nothing is missed |
| Admin presses ✖️ Tugatish | The silence ends at once: the bot answers that person again |
| More than 20 messages per hour from one person | Claude is not called |
| Admin writes without pressing ✍️ | Short hint; Claude is never called for the admin's own messages |
| Groups, channels, other people's `/pause` `/status` | Ignored |

### Owner commands (private chat with the bot, from the `OWNER_ID` account)

- `/start` — guide in Uzbek: what the bot does, current mode and state, how to connect it, commands.
- `/pause`, `/resume` (also clears the limit and takeover timers), `/status`.
- **`users` button** (persistent keyboard, owner only; also `/users`): lists everyone who wrote to the bot in the
  last `HISTORY_TTL_DAYS` days, newest first, with @username, ID, message count and last message time. Under the
  list is a 📁 button per person (with `📊 N%` when they have sent documents): pressing it shows their document
  status and the whole conversation with them (oldest first; a very long one arrives as a `.txt` file), with
  **✍️ Javob yozish**, **📄 chat.txt**, **📎 Qabul qilingan fayllar** and **🗑 Chatni o'chirish** under it.
- **🗑 Chatni o'chirish** asks for confirmation, then deletes the person's history, transcript, users-list entry
  and the whole `data/clients/<id>/` folder. It cannot be undone. Only the owner can do this.
- **Answering a person:** press ✍️ (under the conversation, a 🚨 alert or a forwarded file), then send the answer —
  text, photo, file, voice, anything. Everything sent goes to that person until **✖️ Tugatish** (or `/cancel`) is
  pressed or `REPLY_MODE_MINUTES` (15) pass without a message. People who wrote through the business account are
  answered through it, text only.

Turn **Threaded Mode off** in @BotFather (Bot Settings → Threaded Mode). It is a setting for the whole bot that the
Bot API cannot change: while it is on, Telegram shows topics ("folders") to the people who write to the bot. The bot
warns about it in the log at startup.

Anyone else who sends `/start` gets a short Uzbek welcome and a keyboard with **📊 Hujjatlar holati** and
**📄 Anketa shabloni** (Claude is not called for `/start`).

## Documents

The documents asked for are defined in [`templates/investment-checklist/template.json`](templates/investment-checklist/template.json),
taken from the company's express questionnaire «Инвестициялар учун объект тайёргарлигининг экспресс-анкетаси»
(`uz.docx`) / «Экспресс-анкета готовности объекта к инвестициям» (`ru.docx`):

| Key | Document | Optional when the questionnaire marks item |
| --- | --- | --- |
| `anketa` | The filled-in questionnaire with the signed NDA | never |
| `ustav`, `egrpo` | Charter, register extract (≤ 3 months old) | 1, 2 |
| `ruxsatnoma`, `litsenziya_kelishuvi` | Subsoil use permit, licence agreement | 3 |
| `loyiha_hujjatlari`, `5gr_tasdiq` | Project documents (UTER, TEO, mining allotment), proof of form 5-GR | 5, 6 |
| `ekologik_paket` | ZVOS/ZEP, PDV, limits, environmental review conclusion | 7 |
| `epb_dalolatnoma`, `yer_ajratmasi` | Industrial safety review, land allotment decision | 8, 9 |

How a file is checked (`src/documentReview.ts`):

1. It is downloaded into `data/clients/<id>/inbox/` (kept across restarts and usage limits).
2. DOCX and XLSX text is extracted in the bot (checkbox states ☐/☒ and highlighted text are kept); TXT/CSV are
   read as is. PDF and images are opened by Claude itself: the CLI runs in a fresh 0700 folder holding only that
   file, with `--tools Read --restricted --allowedTools Read --permission-prompts none`, so it can read nothing
   else. Other formats (DOC, ZIP …) are rejected with a request for PDF/DOCX/XLSX/JPG/PNG.
3. Claude gets the template (each document's acceptance checks), the summaries in [`laws/`](laws/), the company
   from the accepted questionnaire and the file, and answers with JSON: which document it is, accepted or
   rejected, reasons in the client's language.
4. Accepted → `accepted/<key>/`; rejected → `rejected/` with `reasons.jsonl`. A later wrong copy never undoes an
   accepted document. The accepted questionnaire also records the company and the items marked "NA".
5. Progress = accepted / required (documents of NA items are not required): `Tayyor 60% · Xato 20% · Yetishmaydi 20%`
   and one line per document with ✅ ❌ ⬜ ➖ and the reason.

To add a document or change a check, edit `template.json` (read fresh for every file) and push. A new template
goes into its own folder with the same layout; `DEFAULT_TEMPLATE_ID` in `src/templates.ts` picks the active one.
The service contract template can be added the same way later.

`npm run review -- path/to/file.pdf --lang ru` checks one local file and prints the verdict, without Telegram and
without saving anything.

## How Claude is called

One `claude -p` process per reply, started with `spawn` (no shell), in its own process group, in the private
directory `data/claude-run` (0700):

```
claude -p --safe-mode --settings '{"disableAllHooks":true,"enabledPlugins":{…builtin plugins…:false}}'
  --tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence
  --system-prompt-file <temp file> --output-format json --effort <CLAUDE_EFFORT> [--model <CLAUDE_MODEL>]
```

- The conversation goes **only through stdin**; the system prompt (with `company.md`) goes through a temporary
  0600 file that is deleted afterwards, so neither appears in `ps`.
- `--bare` is **not** used: it ignores OAuth logins, so the subscription would not work.
- The child environment is cleaned: every `ANTHROPIC_*` variable, `TELEGRAM_BOT_TOKEN`, Bedrock/Vertex/Foundry
  switches, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SIMPLE` and `NODE_OPTIONS` are removed;
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` are added. `CLAUDE_CODE_OAUTH_TOKEN`
  is set only from the bot's own settings.
- Token rules: the token is never logged, never put into argv, prompts or JSON output, and is replaced by
  `[REDACTED]` in CLI output before parsing. If the token is rejected, the error says to run `claude setup-token`
  again and shows what the CLI said (with the token hidden).
- `npm run check-claude` sends a tiny request and verifies that no tools, MCP servers, plugins or skills are
  loaded, that no API key is used, and which authentication was used.

## Data and privacy

Everything is stored in `data/` (on Railway: the volume at `/app/data`), directories 0700, files 0600:

| File | Content |
| --- | --- |
| `history.json` | Last `HISTORY_LIMIT` messages per connection and chat (fallback only) |
| `transcripts.json` | Every message per chat: the bot's memory (Claude gets the last `HISTORY_LIMIT` messages with the person, earlier conversations included) and the admin's 📁 folders |
| `previews.jsonl` | Replies prepared in preview mode (or not sent) |
| `seen.json` | IDs of handled messages (for duplicates) |
| `state.json` | Pause flag and usage-limit deadline |
| `users.json` | People who wrote to the bot (name, @username, ID, counts) for the `users` list |
| `clients/<id>/chat.txt` | The whole conversation with this person as plain text |
| `clients/<id>/accepted/<doc>/` | Files that passed the template check |
| `clients/<id>/rejected/` | Files that did not, with `reasons.jsonl` |
| `clients/<id>/status.json` | Per-document state, used for the percentages |
| `clients/<id>/inbox/` | Files waiting for review |

History and previews older than `HISTORY_TTL_DAYS` are deleted. Client folders are kept until the owner deletes
the chat with 🗑; the client's documents (licences, charters …) are confidential under the questionnaire's NDA. Messages from the people who write to the company
**are sent to Claude (Anthropic)** to generate replies and are stored on the Railway server. Agree on this with the
company's management and the person responsible for information security, and align it with the company's
personal-data requirements, before you connect the bot.

## Deploy to Railway

1. **Claude token.** On a computer with a browser run `claude setup-token`, confirm with the subscription account
   and copy the `sk-ant-oat…` token (valid for 1 year).
2. **Bot.** In @BotFather: `/newbot`, then *Bot Settings → Business Mode → Turn on*. Get the company account's
   numeric ID from @userinfobot.
3. **GitHub.** Push this code to a **private** repository (`company.md` is baked into the Docker image).
4. **Railway → New Project → Deploy from GitHub repo** → choose the repository. It builds with the `Dockerfile`.
5. **Service → Variables → Raw Editor**:
   ```
   TELEGRAM_BOT_TOKEN=...
   OWNER_ID=...
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
   AUTO_SEND=false
   ```
   Optional: `COMPANY_NAME`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_TIMEOUT_SECONDS`, `LIMIT_COOLDOWN_MINUTES`,
   `OWNER_TAKEOVER_MINUTES`, `HISTORY_LIMIT`, `HISTORY_TTL_DAYS`, `REVIEW_DAILY_LIMIT`. `CLAUDE_BIN`, `DATA_DIR`, `PROFILE_PATH`, `TEMPLATES_DIR` and `LAWS_DIR` are
   not needed.
6. **Volume (the bot's memory).** Right-click the canvas (or Cmd+K / Ctrl+K) → *Volume* → choose the service →
   mount path exactly `/app/data` → *Deploy*. Everything in the table above is written there and survives
   redeploys. Without a volume, the memory, users, pause and limit state are lost on every deploy; the log then
   says `WARNING: no Railway volume is attached`. With the volume the log shows
   `Data directory: /app/data (N chat(s) in memory)`.
7. **Logs** should show `Bot @… is running`, `Mode: PREVIEW` and
   `Claude auth: subscription token from environment variables`. Red lines in Railway are just stderr, not errors.
8. From the admin account (`OWNER_ID`) send `/start` to the bot. Test from **another** account by writing to the
   bot. In `PREVIEW` mode the drafts are only in the Railway log and `previews.jsonl`, and people get no answer;
   after the drafts have been checked for a few days, set `AUTO_SEND=true`.
9. Optional, with Telegram Premium: in **Settings → Telegram Business → Chatbots** of the company account enter the
   bot's username, choose the chats and allow replying (Business Mode must be on in @BotFather). The log shows
   `Business connection …: user=<id> enabled=True`.

Notes:

- Run the bot in **one place only**: two pollers with the same bot token disturb each other (do not run
  `npm start` locally while Railway is running).
- Every push redeploys. Changing `company.md` also means commit + push.
- Claude token expired or leaked: run `claude setup-token` again and update the Railway variable. Bot token
  leaked: `/revoke` in @BotFather and update `TELEGRAM_BOT_TOKEN`.

## Local development

Requires Node.js 22+ and the Claude Code CLI.

```
npm install
cp .env.example .env && chmod 600 .env     # then edit .env with a text editor
npm run check-claude
npm run try -- "Salom, ish vaqtingiz qanday?"
```

Without `CLAUDE_CODE_OAUTH_TOKEN` the machine's own `claude` login is used. Locally only `.env` is read; shell
variables are ignored and nothing is written to `process.env`.

### Commands

| Command | What it does | Exit codes |
| --- | --- | --- |
| `npm start` | Runs the bot with settings from `.env` | 0 stopped, 2 config error or bot token rejected |
| `node dist/bot.js --settings-from-env` | Container mode (Railway): settings from environment variables, which are then removed from `process.env` | same |
| `npm run check-claude` | Checks the Claude CLI without Telegram | 0 ok, 1 check failed, 2 config error |
| `npm run try -- "text"` | Shows the reply to a made-up message (language, escalation, reply) | 0 ok, 1 Claude failed, 2 config error |
| `npm run review -- file [--lang uz\|ru\|en]` | Checks one local file against the template and prints the verdict | 0 ok, 1 Claude failed, 2 config error or no file |
| `npm run typecheck` / `npm test` / `npm run build` | TypeScript check, tests (offline), compile to `dist/` | |

`--check-claude` and `--try` also work with `--settings-from-env` and do not need Telegram settings.

### Tests

`npm test` runs offline: Telegram calls go to a recording transformer (`tests/harness.ts`), file downloads are
served from memory and Claude is replaced by a scripted generator. `tests/documents.test.ts` covers the template,
DOCX/XLSX text, review answers, batches of many files, preview mode, usage limits across restarts, business
chats, chat.txt, the questionnaire, the client status and deleting a chat.

### Files

```
src/bot.ts         entry point, CLI flags, startup checks, long polling with @grammyjs/runner
src/config.ts      settings from .env or environment variables
src/claudeCli.ts   claude -p wrapper, isolation, errors
src/language.ts    language hint (uz/ru/en)
src/prompts.ts     system and user prompts, [SKIP]/[ESCALATE]/[SEND_TEMPLATE], document review prompts
src/store.ts       history, duplicates, state, previews (atomic JSON files)
src/templates.ts   loads templates/<id>/template.json
src/clientFolder.ts  data/clients/<id>/: chat.txt, accepted/rejected files, status, percentages
src/documentReview.ts  DOCX/XLSX text, inbox, one-file check with Claude, JSON verdict
src/service.ts     Assistant: message flow, review batches, owner commands
src/handlers.ts    grammY router
company.md         company profile (fill in)
templates/         document templates (blank questionnaire uz/ru + template.json)
laws/              lex.uz summaries used by document checks
tests/             vitest tests
Dockerfile, railway.json, .dockerignore
```
