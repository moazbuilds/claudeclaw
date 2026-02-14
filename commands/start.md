---
description: Start daemon mode or run one-shot prompt/trigger
---

Start the heartbeat daemon for this project. Follow these steps exactly:

1. **Block home-directory starts (CRITICAL, BLOCKER)**:
   - Run `pwd` and `echo "$HOME"`.
   - If `pwd` equals `$HOME`, STOP immediately.
   - Tell the user exactly:
     - "CRITICAL BLOCKER: For security reasons, close this session and start a new one from the folder you want to initialize ClaudeClaw in."
   - Do not continue with any other step until they restart from a non-home project directory.

2. **Ensure Bun is installed**: Run `which bun`. If it's not found:
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

3. **Check existing config**: Read `.claude/claudeclaw/settings.json` (if it exists). Determine which sections are already configured:
   - **Heartbeat configured** = `heartbeat.enabled` is `true` AND `heartbeat.prompt` is non-empty
   - **Telegram configured** = `telegram.token` is non-empty
   - **Security configured** = `security.level` exists and is not `"moderate"` (the default), OR `security.allowedTools`/`security.disallowedTools` are non-empty

4. **Interactive setup — smart mode** (BEFORE launching the daemon):

   **If ALL three sections are already configured**, show a summary of the current config and ask ONE question:

   Use AskUserQuestion:
   - "Your settings are already configured. Want to change anything?" (header: "Settings", options: "Keep current settings", "Reconfigure")

   If they choose "Keep current settings", skip to step 6 (first contact question).
   If they choose "Reconfigure", proceed to step 5 below as if nothing was configured.

   **If SOME sections are configured and others are not**, show the already-configured sections as a summary, then only ask about the unconfigured sections in step 5.

   **If NOTHING is configured** (fresh install), ask about all three sections in step 5.

5. **Ask setup questions**:

   Use **AskUserQuestion** to ask all unconfigured sections at once (up to 3 questions in one call):

   - **If heartbeat is NOT configured**: "Enable heartbeat? Example: I can remind you to drink water every 30 minutes, or you can fully customize what runs." (header: "Heartbeat", options: "Yes" / "No")
   - **If Telegram is NOT configured**: "Configure Telegram? Recommended if you want it 24/7 live." (header: "Telegram", options: "Yes" / "No")
   - **If security is NOT configured**: "What security level for Claude?" (header: "Security", options:
     - "Moderate (Recommended)" (description: "Full access scoped to project directory")
     - "Locked" (description: "Read-only — can only search and read files, no edits, bash, or web")
     - "Strict" (description: "Can edit files but no bash or web access")
     - "Unrestricted" (description: "Full access with no directory restriction — dangerous"))

   Then, based on their answers:

   - **If yes to heartbeat**: Use AskUserQuestion again with one question:
     - "How often should it run in minutes?" (header: "Interval", options: "5", "15", "30 (Recommended)", "60")
     - Set `heartbeat.enabled` to `true` and `heartbeat.interval` to their answer.

   - **If yes to Telegram**: Ask for two free-form values (both optional, user can skip either):
     - Telegram bot token (hint: create/get it from `@BotFather`)
     - Allowed Telegram user IDs (hint: use `@userinfobot` to get your numeric ID)
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

   Update `.claude/claudeclaw/settings.json` with their answers.

6. **First contact destination**: Use AskUserQuestion to ask where they want first contact to fire. Build options **dynamically** based on whether Telegram was configured in step 5:

   - **If Telegram IS configured** (header: "First contact"):
     - "Open in Claude Code (Recommended)" (description: "Meet your agent in Claude Code after launch")
     - "Fire to Telegram (Trigger)" (description: "Run start with --trigger and forward result to Telegram")

   - **If Telegram is NOT configured** (header: "First contact"):
     - "Open in Claude Code (Recommended)" (description: "Meet your agent in Claude Code after launch")
     - "Skip" (description: "Skip for now — daemon keeps running, you can connect later")

7. **Launch/start action**: Run command based on step 6 choice:
   - **If user chose "Fire to Telegram (Trigger)"**:
     ```bash
     mkdir -p .claude/claudeclaw/logs && nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts start --web --trigger --telegram > .claude/claudeclaw/logs/daemon.log 2>&1 & echo $!
     ```
   - **Otherwise**:
     ```bash
     mkdir -p .claude/claudeclaw/logs && nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts start --web > .claude/claudeclaw/logs/daemon.log 2>&1 & echo $!
     ```
   Use the description "Starting ClaudeClaw server" for this command.
   Wait 1 second, then check `cat .claude/claudeclaw/logs/daemon.log`. If it contains "Aborted: daemon already running", tell the user and exit.
   - Read `.claude/claudeclaw/settings.json` for `web.port` (default `4632` if missing) and `web.host` (default `127.0.0.1`).
   - Then try to open the dashboard directly:
     - Linux: `xdg-open http://<HOST>:<PORT>`
     - macOS: `open http://<HOST>:<PORT>`
     - If open command fails, print the URL clearly so user can open it manually.

8. **Capture session ID**: Read `.claude/claudeclaw/session.json` and extract the `sessionId` field. This is the shared Claude session used by the daemon for heartbeat, jobs, and Telegram.

9. **Report**: Print the ASCII art below then show the PID, session, status info, one-shot usage tips, and the Web UI URL.

CRITICAL: Output the ASCII art block below EXACTLY as-is inside a markdown code block. Do NOT re-indent, re-align, or adjust ANY whitespace. Copy every character verbatim. Only replace `<PID>` and `<WORKING_DIR>` with actual values.

```
🦞         🦞
   ▐▛███▜▌
  ▝▜█████▛▘
    ▘▘ ▝▝
```

# HELLO, I AM YOUR CLAUDECLAW!
**Daemon is running! PID: \<PID> | Dir: \<WORKING_DIR>**

```
/heartbeat:status  - check status
/heartbeat:stop    - stop daemon
/heartbeat:clear   - back up session & restart fresh
/heartbeat:config  - show config
```

**Talk to your agent anytime from Claude Code**
```bash
claude --resume <SESSION_ID>
```
Replace `<SESSION_ID>` with the session ID captured in step 8.

Show this direct Web UI URL:
```bash
http://<WEB_HOST>:<WEB_PORT>
```
Defaults: `WEB_HOST=127.0.0.1`, `WEB_PORT=4632` unless changed via settings or `--web-port`.

---

## Reference: File Formats

### Settings — `.claude/claudeclaw/settings.json`
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
- `security.level` — one of: `locked`, `strict`, `moderate`, `unrestricted`
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

### Jobs — `.claude/claudeclaw/jobs/<name>.md`
Jobs are markdown files with cron schedule frontmatter and a prompt body:
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```
- Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`
- The filename (without `.md`) becomes the job name
- Jobs are loaded at daemon startup from `.claude/claudeclaw/jobs/`
