---
description: Start the heartbeat daemon
---

Start the heartbeat daemon for this project. Follow these steps exactly:

1. **Ensure Bun is installed**: Run `which bun`. If it's not found:
   - Tell the user Bun is required and will be auto-installed.
   - Run:
     ```bash
     curl -fsSL https://bun.sh/install | bash
     ```
   - Then source the shell profile to make `bun` available in the current session:
     ```bash
     source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null || true
     ```
   - Verify `bun` is now available with `which bun`. If still not found, tell the user installation failed and to install manually from https://bun.sh, then exit.
   - Tell the user Bun was auto-installed successfully.

2. **Check existing config**: Read `.claude/heartbeat/settings.json` (if it exists). Determine which sections are already configured:
   - **Heartbeat configured** = `heartbeat.enabled` is `true` AND `heartbeat.prompt` is non-empty
   - **Telegram configured** = `telegram.token` is non-empty
   - **Security configured** = `security.level` exists and is not `"moderate"` (the default), OR `security.allowedTools`/`security.disallowedTools` are non-empty

3. **Interactive setup — smart mode** (BEFORE launching the daemon):

   **If ALL three sections are already configured**, show a summary of the current config and ask ONE question:

   Use AskUserQuestion:
   - "Your settings are already configured. Want to change anything?" (header: "Settings", options: "Keep current settings", "Reconfigure")

   If they choose "Keep current settings", skip to step 5 (launch daemon).
   If they choose "Reconfigure", proceed to step 4 below as if nothing was configured.

   **If SOME sections are configured and others are not**, show the already-configured sections as a summary, then only ask about the unconfigured sections in step 4.

   **If NOTHING is configured** (fresh install), ask about all three sections in step 4.

4. **Ask setup questions**:

   Use **AskUserQuestion** to ask all unconfigured sections at once (up to 3 questions in one call):

   - **If heartbeat is NOT configured**: "Enable heartbeat?" (header: "Heartbeat", options: "Yes" / "No")
   - **If Telegram is NOT configured**: "Configure Telegram?" (header: "Telegram", options: "Yes" / "No")
   - **If security is NOT configured**: "What security level for Claude?" (header: "Security", options:
     - "Locked" (description: "Read-only — can only search and read files, no edits, bash, or web")
     - "Strict" (description: "Can edit files but no bash or web access")
     - "Moderate (Recommended)" (description: "Full access scoped to project directory")
     - "Unrestricted" (description: "Full access with no directory restriction — dangerous"))

   Then, based on their answers:

   - **If yes to heartbeat**: Use AskUserQuestion again with two questions:
     - "What prompt should the heartbeat run on each check? (You can enter an inline prompt OR a file path ending in .md/.txt/.prompt)" (header: "Prompt", options: provide 2-3 example prompts relevant to the project)
     - "How often should it run in minutes?" (header: "Interval", options: "5", "15 (Recommended)", "30", "60")
     - Set `heartbeat.enabled` to `true`, `heartbeat.prompt` to their answer, `heartbeat.interval` to their answer.
     - Note: If the user provides a path ending in `.md`, `.txt`, or `.prompt`, the daemon will read the prompt from that file at each tick. Relative paths resolve from the project root. If the file is not found, the value is used as a literal string.

   - **If yes to Telegram**: Use AskUserQuestion again with two questions:
     - "What is your Telegram bot token?" (header: "Bot token", options: let user type via Other)
     - "What are the allowed Telegram user IDs?" (header: "User IDs", options: let user type via Other)
     - Set `telegram.token` and `telegram.allowedUserIds` (as array of numbers) accordingly.
     - Note: Telegram bot runs in-process with the daemon. All components (heartbeat, cron, telegram) share one Claude session.

   - **Security level mapping** — set `security.level` in settings based on their choice:
     - "Locked" → `"locked"`
     - "Strict" → `"strict"`
     - "Moderate" → `"moderate"`
     - "Unrestricted" → `"unrestricted"`

   - **If security is "Strict" or "Locked"**: Use AskUserQuestion to ask:
     - "Allow any specific tools on top of the security level? (e.g. Bash(git:*) to allow only git commands)" (header: "Allow tools", options: "None — use level defaults (Recommended)", "Bash(git:*) — git only", "Bash(git:*) Bash(npm:*) — git + npm")
     - If they pick an option with tools or type custom ones, set `security.allowedTools` to the list.

   Update `.claude/heartbeat/settings.json` with their answers.

5. **Launch daemon**: The daemon auto-initializes config and has a built-in safeguard against duplicate instances. Start it in the background:
   ```bash
   mkdir -p .claude/heartbeat/logs && nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts > .claude/heartbeat/logs/daemon.log 2>&1 & echo $!
   ```
   Use the description "🦞 Starting ClaudeClaw server" for this command.
   Wait 1 second, then check `cat .claude/heartbeat/logs/daemon.log`. If it contains "Aborted: daemon already running", tell the user and exit.

6. **Capture session ID**: Read `.claude/heartbeat/session.json` and extract the `sessionId` field. This is the shared Claude session used by the daemon for heartbeat, jobs, and Telegram.

7. **Report**: Print the ASCII art below then show the PID, session, and status info.

CRITICAL: Output the ASCII art block below EXACTLY as-is inside a markdown code block. Do NOT re-indent, re-align, or adjust ANY whitespace. Copy every character verbatim. Only replace `<PID>` and `<WORKING_DIR>` with actual values.

```
🦞         🦞
   ▐▛███▜▌
  ▝▜█████▛▘
    ▘▘ ▝▝
```

# HELLO, I AM YOUR CLAUDECLAW!
**Daemon is running! PID: \<PID> | Dir: \<WORKING_DIR>**

**Talk to your agent directly:**
```
claude --resume <SESSION_ID>
```
Replace `<SESSION_ID>` with the actual session ID from the session file. This opens the same Claude session the daemon uses. If Telegram is configured, the conversation is shared — anything said here or in Telegram goes to the same agent context.

```
/heartbeat:status  - check status
/heartbeat:stop    - stop daemon
/heartbeat:clear   - back up session & restart fresh
/heartbeat:config  - show config
```

The daemon hot-reloads settings and jobs every 30 seconds — no restart needed.

---

## Reference: File Formats

### Settings — `.claude/heartbeat/settings.json`
```json
{
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "Check git status and summarize recent changes."
    // OR use a file path:
    // "prompt": "prompts/heartbeat.md"
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  }
}
```
- `heartbeat.enabled` — whether the recurring heartbeat runs
- `heartbeat.interval` — minutes between heartbeat runs
- `heartbeat.prompt` — the prompt sent to Claude on each heartbeat. Can be an inline string or a file path ending in `.md`, `.txt`, or `.prompt` (relative to project root). File contents are re-read on each tick, so edits take effect without restarting the daemon.
- `telegram.token` — Telegram bot token from @BotFather
- `telegram.allowedUserIds` — array of numeric Telegram user IDs allowed to interact
- `security.level` — one of: `locked`, `strict`, `moderate`, `trusted`, `unrestricted`
- `security.allowedTools` — extra tools to allow on top of the level (e.g. `["Bash(git:*)"]`)
- `security.disallowedTools` — tools to block on top of the level

### Security Levels
All levels run without permission prompts (headless). Security is enforced via tool restrictions and project-directory scoping.

| Level | Tools available | Directory scoped |
|-------|----------------|-----------------|
| `locked` | Read, Grep, Glob only | Yes — project dir only |
| `strict` | Everything except Bash, WebSearch, WebFetch | Yes — project dir only |
| `moderate` | All tools | Yes — project dir only |
| `unrestricted` | All tools | No — full system access |

### Jobs — `.claude/heartbeat/jobs/<name>.md`
Jobs are markdown files with cron schedule frontmatter and a prompt body:
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```
- Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`
- The filename (without `.md`) becomes the job name
- Jobs are loaded at daemon startup from `.claude/heartbeat/jobs/`
