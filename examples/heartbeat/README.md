# Heartbeat example

The heartbeat runs on a fixed interval while the daemon is up. It nudges Claude to check reminders, follow-ups, and anything that needs a human ping — without you having to ask.

## Enable in settings

Add or merge this block in `.claude/claudeclaw/settings.json`:

```json
{
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "prompts/HEARTBEAT.md",
    "forwardToTelegram": false,
    "excludeWindows": [
      {
        "days": [0, 6],
        "start": "22:00",
        "end": "08:00"
      }
    ]
  },
  "timeouts": {
    "heartbeat": 15
  }
}
```

| Field | Meaning |
|-------|---------|
| `enabled` | Turn the heartbeat on or off |
| `interval` | Minutes between runs |
| `prompt` | Path to the prompt file (relative to project root) or inline text |
| `forwardToTelegram` | When `true`, forward non-`HEARTBEAT_OK` output to Telegram |
| `excludeWindows` | Optional quiet hours (local timezone from `timezone` in settings) |

## Prompt template

The built-in template lives at `prompts/heartbeat/HEARTBEAT.md` in the plugin. To customize it for your project, copy or author:

`.claude/claudeclaw/prompts/HEARTBEAT.md`

Project overrides fully replace the built-in template.

## Start the daemon

```bash
/claudeclaw:start
```

Or from the CLI:

```bash
bun run src/index.ts start
```

Use `/claudeclaw:status` (or `bun run src/index.ts status`) to confirm the next heartbeat countdown.

## Expected behavior

- If nothing needs attention, Claude replies `HEARTBEAT_OK` and the daemon stays quiet (unless `forwardToTelegram` is on).
- If something does need attention, output can be forwarded to configured messaging channels.
- Heartbeat logs are written under `.claude/claudeclaw/logs/`.
