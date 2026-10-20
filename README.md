# Sanoatgeokontexxizmat — Telegram Business assistant

A Telegram Business bot for the **company account** of «Sanoatgeokontexxizmat». When a citizen, customer or
partner organisation writes to that account, the bot prepares a formal, polite reply on behalf of the company.
Everything the bot knows about the company comes from [`company.md`](company.md).

Replies are written by the **Claude Code CLI** (`claude -p`) installed next to the bot, using a Claude
**subscription** token from `claude setup-token`. An Anthropic API key is never used.

## What it does

The bot works in two ways at the same time:

- **Direct chats (no Telegram Premium needed).** Anyone who writes to the bot itself gets a reply prepared from
  `company.md`. **Every such chat is copied to the admin** (`OWNER_ID`): the person's message plus what the bot
  answered (or why it did not). Media is forwarded. The admin answers a person by **replying** to that copy; the bot
  delivers the answer and stays silent in that chat for `OWNER_TAKEOVER_MINUTES`. At most
  20 Claude calls per person per hour, to protect the subscription limit.
- **Telegram Business (optional, needs Premium).** The bot can also be connected to the company's account through
  Telegram Business → **Chatbots** and then answers the chats of that account.

Common to both:

- **Preview mode is the default** (`AUTO_SEND=false`): replies are not sent to anyone. They are printed to the log
  as `PREVIEW, not sent` blocks, stored in `data/previews.jsonl`, and for direct chats shown to the admin as a
  draft. Set `AUTO_SEND=true` to let the bot answer people.
- There is no allowlist in the code: anyone may write to the bot; for Business, Telegram's Chatbots setting
  decides which chats the bot sees.
- **The bot never decides anything on behalf of the company.** It gives information from `company.md`, confirms
  that a request was received and refers to the responsible employee. It makes no promises or conclusions about
  prices, deadlines, contracts, permits, expert reviews or inspection results.
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
| Claude answers `[ESCALATE] …` | Owner gets an alert; the reply itself follows the normal preview/auto-send path |
| Before an auto-send | Pause/limit/takeover are checked again, and the connection is re-read from Telegram (owner, enabled, reply right) |
| History retention | Messages and previews older than `HISTORY_TTL_DAYS` (default 30) are deleted |
| Someone writes to the bot directly | Claude answers from `company.md` (sent only with `AUTO_SEND=true`); the admin always gets a copy |
| Admin replies to a copy | The answer is delivered to that person; the bot is silent there for `OWNER_TAKEOVER_MINUTES` |
| More than 20 messages per hour from one person | Claude is not called; the admin still gets the copies |
| Admin writes to the bot without replying to a copy | Short hint; Claude is never called for the admin's own messages |
| Groups, channels, other people's `/pause` `/status` | Ignored |

### Owner commands (private chat with the bot, from the `OWNER_ID` account)

- `/start` — guide in Uzbek: what the bot does, current mode and state, how to connect it, commands.
- `/pause`, `/resume` (also clears the limit and takeover timers), `/status`.
- **`users` button** (persistent keyboard, owner only; also `/users`): lists everyone who wrote to the bot in the
  last `HISTORY_TTL_DAYS` days, newest first, with @username, ID, message count and last message time. Under the
  list is a 📁 button per person: pressing it shows the whole conversation with them (their messages, the bot's
  replies and the admin's replies, oldest first). A very long conversation arrives as a `.txt` file.

- **Admin group, a folder per person** (`/setup`): create a Telegram group for the admin and employees, turn on
  *Topics* in its settings, add the bot as an admin with the *Manage topics* right and send `/setup` in the group.
  Every person who wrote in the last `HISTORY_TTL_DAYS` days gets a topic ("folder") with the whole conversation
  so far, and from then on each new message, the bot's reply and what it did go into that person's folder instead
  of the admin's private chat (🚨 important requests are also sent to the admin privately). Anything written in a
  person's folder is delivered to that person (to people who wrote through the business account: text only), and
  the bot stays quiet in that chat for `OWNER_TAKEOVER_MINUTES`. A deleted folder is opened again on the next
  message. The people who write to the bot never see these folders. `/setup` in the private chat shows these steps.

Turn **Threaded Mode off** in @BotFather (Bot Settings → Threaded Mode). It is a setting for the whole bot that the
Bot API cannot change: while it is on, Telegram shows topics ("folders") to the people who write to the bot too. The
admin's per-person folders are the 📁 buttons above and do not need it. The bot warns about it in the log at startup.

Anyone else who sends `/start` gets a short Uzbek welcome asking them to write their question (Claude is not
called for `/start`).

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
| `relay.json` | Which admin copy belongs to which person (for replies) |
| `topics.json` | The admin group and each person's folder (topic) in it |
| `users.json` | People who wrote to the bot (name, @username, ID, counts) for the `users` list |

History and previews older than `HISTORY_TTL_DAYS` are deleted. Messages from the people who write to the company
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
   `OWNER_TAKEOVER_MINUTES`, `HISTORY_LIMIT`, `HISTORY_TTL_DAYS`. `CLAUDE_BIN`, `DATA_DIR` and `PROFILE_PATH` are
   not needed.
6. **Volume (the bot's memory).** Right-click the canvas (or Cmd+K / Ctrl+K) → *Volume* → choose the service →
   mount path exactly `/app/data` → *Deploy*. Everything in the table above is written there and survives
   redeploys. Without a volume, the memory, users, pause and limit state are lost on every deploy; the log then
   says `WARNING: no Railway volume is attached`. With the volume the log shows
   `Data directory: /app/data (N chat(s) in memory)`.
7. **Logs** should show `Bot @… is running`, `Mode: PREVIEW` and
   `Claude auth: subscription token from environment variables`. Red lines in Railway are just stderr, not errors.
8. From the admin account (`OWNER_ID`) send `/start` to the bot. Test from **another** account by writing to the
   bot: the admin gets a copy with the draft reply. After the replies have been checked for a few days, set
   `AUTO_SEND=true`; then people get the answers.
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
| `npm run typecheck` / `npm test` / `npm run build` | TypeScript check, tests (offline), compile to `dist/` | |

`--check-claude` and `--try` also work with `--settings-from-env` and do not need Telegram settings.

### Tests

`npm test` runs offline: Telegram calls go to a recording transformer and the Claude CLI is replaced by a fake
script. The CLI tests use POSIX process groups and file modes and are skipped on Windows; run them on Linux or
macOS (or in Docker) for full coverage.

### Files

```
src/bot.ts         entry point, CLI flags, startup checks, long polling with @grammyjs/runner
src/config.ts      settings from .env or environment variables
src/claudeCli.ts   claude -p wrapper, isolation, errors
src/language.ts    language hint (uz/ru/en)
src/prompts.ts     system and user prompts, [SKIP]/[ESCALATE]
src/store.ts       history, duplicates, state, previews (atomic JSON files)
src/service.ts     Assistant: business message flow, owner commands
src/handlers.ts    grammY router
company.md         company profile (fill in)
tests/             vitest tests
Dockerfile, railway.json, .dockerignore
```
