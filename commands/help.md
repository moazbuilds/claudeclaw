---
description: Show heartbeat plugin help
---

Display this help information to the user:

**Claude Heartbeat** — a cron-like daemon that runs Claude prompts on a schedule.

**Commands:**
- `/heartbeat:start` — Initialize config and start the daemon
- `/heartbeat:stop` — Stop the running daemon
- `/heartbeat:clear` — Back up the current session and restart fresh
- `/heartbeat:status` — Show daemon status, countdowns, and config
- `/heartbeat:config` — View or modify heartbeat settings (interval, prompt, telegram)
- `/heartbeat:jobs` — Create, list, edit, or delete cron jobs
- `/heartbeat:logs` — Show recent execution logs (accepts count or job name filter)
- `/heartbeat:telegram` — Show Telegram bot status and sessions (use `clear` to reset sessions)
- `/heartbeat:help` — Show this help message

**How it works:**
- The daemon runs in the background checking your schedule every 60 seconds
- A **heartbeat** prompt runs at a fixed interval (default: every 15 minutes)
- **Jobs** are markdown files in `.claude/heartbeat/jobs/` with cron schedules
- The statusline shows a live countdown to the next run

**Configuration:**
- `.claude/heartbeat/settings.json` — Main config (heartbeat interval, prompt, enabled)
- `.claude/heartbeat/jobs/*.md` — Cron jobs with schedule frontmatter and a prompt body

**Job file format:**
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```

Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`

**Note:** Bun is required to run the daemon. It will be auto-installed on first `/heartbeat:start` if missing.

**Telegram bot:**
- A standalone process that bridges Telegram messages to Claude sessions
- Each Telegram user gets a persistent Claude session (with full skill/MCP/plugin support)
- Configure in `.claude/heartbeat/settings.json` under `telegram` key
- Run with: `bun run telegram` (separate from the daemon)
- Users can send `/reset` in Telegram to start a fresh session
