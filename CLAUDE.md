# ClaudeClaw

A daemon that wraps Claude Code CLI, adding Discord/Telegram integration, heartbeat monitoring, session management, and a web UI.

## Architecture

- **Entry point**: `src/index.ts` — CLI dispatcher (`start`, `stop`, `status`, `send`, `clear`, `discord`, `telegram`)
- **Runner** (`src/runner.ts`): Core execution engine. Spawns `claude -p` subprocesses, manages session lifecycle (create/resume/compact), model routing, fallback, rate-limit handling. Each session gets its own queue to run independently in parallel.
- **Session manager** (`src/sessionManager.ts`): Persists sessions to `.claude/claudeclaw/sessions.json`. Each session is keyed by a string (`"default"` for heartbeat/cron/telegram, Discord channel/thread ID for per-channel sessions). The `Session` interface uses `key` (not `threadId`) and the data file uses `sessions` (not `threads`). A migration in `loadSessions()` handles the old format.
- **Sessions** (`src/sessions.ts`): Legacy global session file (`.claude/claudeclaw/session.json`) — used by `clear`, `discord`, `telegram` for `resetSession`/`peekSession`/`backupSession`.
- **Discord** (`src/commands/discord.ts`): Gateway WebSocket client. Per-channel session isolation for guild channels; listen channels share the default session. AI-powered thread intent classifier for creating/deleting Discord threads via natural language.
- **Telegram** (`src/commands/telegram.ts`): Long-polling Telegram bot. Uses `message_thread_id` for Telegram topic threads.

## Session isolation

Each session runs in its own working directory at `.claude/claudeclaw/sessions/{key}/` with isolated memory at `.claude/claudeclaw/sessions/{key}/memory/` (via `--settings '{"autoMemoryDirectory": ...}'`). The project-root `CLAUDE.md` is loaded via `--append-system-prompt` on every invocation (not auto-discovered, since session cwds are nested).

## Naming conventions

- **session**: A Claude Code conversation, identified by a `key` (e.g. `"default"`, a Discord channel ID, etc.) and containing a Claude `sessionId` (UUID).
- **thread**: Refers specifically to Discord threads (the Discord API concept) — `knownThreads`, `rejoinThreads`, `THREAD_CREATE`, etc.
- Avoid using "thread" to mean "session" in code or comments.

## Plugin & Deployment Setup

The plugin is installed from GitHub as a marketplace. Three directories are involved:

| Directory | Purpose |
|---|---|
| **`~/claudeclaw-repo/`** | This repo. Dev/test copy — edit code, run tests, push to GitHub (`vinayh/claudeclaw`). |
| **`~/.claude/plugins/marketplaces/claudeclaw/`** | Marketplace clone. Claude's plugin system pulls from `vinayh/claudeclaw`. Updated via `/plugin marketplace update`. |
| **`~/.claude/plugins/cache/claudeclaw/claudeclaw/1.0.0/`** | Cached copy the daemon actually runs from. Copied from the marketplace clone on install/update. |

**Deploy workflow:**
1. Edit and test in this repo
2. `git push origin master`
3. In Claude Code: `/plugin marketplace update` (pulls latest from GitHub into marketplace clone)
4. Reinstall: `/plugin install claudeclaw@claudeclaw` (copies marketplace clone into cache)
5. `systemctl --user restart claudeclaw`

**Daemon management:**
```
systemctl --user start claudeclaw
systemctl --user stop claudeclaw
systemctl --user restart claudeclaw
journalctl --user -u claudeclaw -f
```

Service file: `~/.config/systemd/user/claudeclaw.service`
Working directory: `~/claudeclaw` (the project being managed)
Logs: `~/claudeclaw/.claude/claudeclaw/logs/`

## Key files

- `src/runner.ts` — execution engine, prompt assembly, compact logic
- `src/sessionManager.ts` — session CRUD, persistence, migration
- `src/commands/discord.ts` — Discord Gateway client, message routing
- `src/commands/telegram.ts` — Telegram bot polling loop
- `src/config.ts` — settings loader (`settings.json`)
- `src/model-router.ts` — agentic mode model selection
- `prompts/` — system prompt files (IDENTITY.md, USER.md, SOUL.md)
- `skills/` — skill definitions
