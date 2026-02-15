---
description: View or modify heartbeat settings
---

View or modify the heartbeat daemon settings. Use `$ARGUMENTS` to determine the action.

Parse `$ARGUMENTS` to identify what the user wants. If no arguments are given, show the current config.

## Sub-commands

### `show` (default when no arguments)

1. Read `.claude/claudeclaw/settings.json`.
2. Display all settings clearly:

   **General**
   - Timezone: (e.g. `America/New_York` or "UTC")

   **Heartbeat**
   - Enabled: yes/no
   - Interval: Xm
   - Prompt: (show full prompt or "not set")
   - Exclude windows: (list each window's days + start-end, or "none")

   **Telegram**
   - Token: (first 5 chars + "..." or "not configured")
   - Allowed users: (list IDs or "none")

   **Security**
   - Level: (locked/strict/moderate/unrestricted)
   - Allowed tools: (list or "default")
   - Disallowed tools: (list or "none")

   **Web UI**
   - Enabled: yes/no
   - Address: host:port

3. Also list any cron jobs from `.claude/claudeclaw/jobs/` with their name and schedule.
4. Remind the user that changes are hot-reloaded every 30s — no daemon restart needed.

### `heartbeat on` / `heartbeat off` / `heartbeat enable` / `heartbeat disable`

Toggle the heartbeat on or off.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `heartbeat.enabled` to `true` or `false` based on the command.
3. Write the updated settings back.
4. Confirm the change.

### `heartbeat interval <minutes>` / `interval <minutes>`

Change the heartbeat interval.

1. Parse the number of minutes from `$ARGUMENTS`. If not provided or invalid, use **AskUserQuestion**: "How often should the heartbeat run?" (header: "Interval", options: "5 minutes", "15 minutes (Recommended)", "30 minutes", "60 minutes")
2. Read `.claude/claudeclaw/settings.json`.
3. Set `heartbeat.interval` to the new value.
4. Write the updated settings back.
5. Confirm the change. The daemon will pick up the new interval within 30 seconds.

### `heartbeat prompt` / `prompt`

Change the heartbeat prompt.

1. Read `.claude/claudeclaw/settings.json` and show the current prompt.
2. Use **AskUserQuestion**: "What prompt should the heartbeat run?" (header: "Prompt", options: suggest 2-3 prompts relevant to the project, plus the current prompt if set as an option)
3. Set `heartbeat.prompt` to the new value.
4. Write the updated settings back.
5. Confirm the change.

### `telegram token <token>` / `telegram token`

Set or update the Telegram bot token.

1. If token is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "What is your Telegram bot token from @BotFather?" (header: "Token", options: let user type via Other)
3. Read `.claude/claudeclaw/settings.json`.
4. Set `telegram.token` to the new value.
5. Write and confirm.

### `telegram users <id1,id2,...>` / `telegram users`

Set the allowed Telegram user IDs.

1. If IDs are in `$ARGUMENTS`, parse them as comma-separated numbers.
2. Otherwise, use **AskUserQuestion**: "What Telegram user IDs should be allowed? (comma-separated)" (header: "User IDs", options: let user type via Other)
3. Read `.claude/claudeclaw/settings.json`.
4. Set `telegram.allowedUserIds` to the array of numbers.
5. Write and confirm.

### `telegram off` / `telegram disable`

Disable Telegram integration.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `telegram.token` to `""` and `telegram.allowedUserIds` to `[]`.
3. Write and confirm.

### `timezone <tz>` / `timezone`

Set the IANA timezone (e.g. `America/New_York`, `Europe/London`, `UTC`).

1. If timezone is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "What timezone should ClaudeClaw use?" (header: "Timezone", options: "UTC (Recommended)", "America/New_York", "Europe/London")
3. Read `.claude/claudeclaw/settings.json`.
4. Set `timezone` to the new value. The `timezoneOffsetMinutes` will be auto-resolved from the timezone name.
5. Write and confirm.

### `security level <level>` / `security`

Set the security level for Claude sessions.

1. If level is in `$ARGUMENTS`, validate it is one of: `locked`, `strict`, `moderate`, `unrestricted`.
2. Otherwise, use **AskUserQuestion**: "What security level should sessions use?" (header: "Security", options: "locked — Read/Grep/Glob only", "strict — No Bash/WebSearch/WebFetch", "moderate — All tools, project-scoped (Recommended)", "unrestricted — All tools, no restrictions")
3. Read `.claude/claudeclaw/settings.json`.
4. Set `security.level` to the new value.
5. Write and confirm. Explain what the chosen level permits.

### `security tools allow <tool1,tool2,...>` / `security tools disallow <tool1,tool2,...>`

Add tools to the allowed or disallowed lists.

1. Parse comma-separated tool names from `$ARGUMENTS`.
2. Read `.claude/claudeclaw/settings.json`.
3. Append to `security.allowedTools` or `security.disallowedTools` (deduplicated).
4. Write and confirm.

### `web on` / `web off` / `web enable` / `web disable`

Toggle the web UI.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `web.enabled` to `true` or `false`.
3. Write and confirm.

### `web port <port>` / `web host <host>`

Configure web UI bind address or port.

1. Parse the value from `$ARGUMENTS`.
2. Read `.claude/claudeclaw/settings.json`.
3. Set `web.port` (number) or `web.host` (string) accordingly.
4. Write and confirm.

### `reset`

Reset all settings to defaults.

1. Use **AskUserQuestion**: "Reset all settings to defaults? This will disable heartbeat and clear Telegram config." (header: "Confirm", options: "Yes, reset everything", "No, keep current settings")
2. If confirmed, write the default settings:
   ```json
   {
     "timezone": "UTC",
     "timezoneOffsetMinutes": 0,
     "heartbeat": {
       "enabled": false,
       "interval": 15,
       "prompt": "",
       "excludeWindows": []
     },
     "telegram": {
       "token": "",
       "allowedUserIds": []
     },
     "security": {
       "level": "moderate",
       "allowedTools": [],
       "disallowedTools": []
     },
     "web": {
       "enabled": false,
       "host": "127.0.0.1",
       "port": 4632
     }
   }
   ```
3. Confirm the reset. Note: this does not delete cron jobs — use `/heartbeat:jobs delete` for that.

---

## Reference: Settings File

Location: `.claude/claudeclaw/settings.json`

```json
{
  "timezone": "America/New_York",
  "timezoneOffsetMinutes": -300,
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "Check git status and summarize recent changes.",
    "excludeWindows": [
      { "days": [0, 6], "start": "23:00", "end": "07:00" }
    ]
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  },
  "web": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4632
  }
}
```

| Key                        | Type       | Description                                    |
|----------------------------|------------|------------------------------------------------|
| `timezone`                 | string     | IANA timezone name (e.g. `America/New_York`)   |
| `timezoneOffsetMinutes`    | number     | UTC offset in minutes (auto-resolved from timezone) |
| `heartbeat.enabled`        | boolean    | Whether the recurring heartbeat runs           |
| `heartbeat.interval`       | number     | Minutes between heartbeat executions           |
| `heartbeat.prompt`         | string     | Prompt sent to Claude on each heartbeat        |
| `heartbeat.excludeWindows` | object[]   | Quiet windows where heartbeat is skipped       |
| `heartbeat.excludeWindows[].days` | number[] | Days of week (0=Sun..6=Sat); omit for all days |
| `heartbeat.excludeWindows[].start` | string | Window start time in `HH:MM` 24h format       |
| `heartbeat.excludeWindows[].end`   | string | Window end time in `HH:MM` 24h format         |
| `telegram.token`           | string     | Bot token from @BotFather                      |
| `telegram.allowedUserIds`  | number[]   | Telegram user IDs allowed to interact          |
| `security.level`           | string     | `locked` \| `strict` \| `moderate` \| `unrestricted` |
| `security.allowedTools`    | string[]   | Extra tools to allow                           |
| `security.disallowedTools` | string[]   | Tools to block                                 |
| `web.enabled`              | boolean    | Whether the web UI is served                   |
| `web.host`                 | string     | Bind address (default `127.0.0.1`)             |
| `web.port`                 | number     | Port number (default `4632`)                   |

The daemon hot-reloads this file every 30 seconds. No restart needed after changes.
