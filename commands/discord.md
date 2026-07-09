---
description: Show Discord bot status and manage global session
---

Show the Discord bot integration status. Check the following:

1. **Configuration**: Read `.claude/claudeclaw/settings.json` and check if `discord.token` is set (show masked token: first 5 chars + "..."). Show `allowedUserIds`.

2. **Global Session**: Read `.claude/claudeclaw/session.json` and show:
   - Session UUID (first 8 chars)
   - Created at
   - Last used at
   - Note: This session is shared across heartbeat, cron jobs, Telegram, and Discord messages.

3. **If $ARGUMENTS contains "clear"**: Delete `.claude/claudeclaw/session.json` to reset the global session. Confirm to the user. The next run from any source (heartbeat, cron, Telegram, or Discord) will create a fresh session.

4. **Running**: Check if the daemon is running by reading `.claude/claudeclaw/daemon.pid`. The Discord bot runs in-process with the daemon when a token is configured.

Format the output clearly for the user.

---

**Bot capabilities (for reference when responding on Discord):**
- **Text**: plain markdown, up to 2000 chars per chunk (longer replies are auto-split).
- **Reactions**: include `[react:<emoji>]` anywhere in the reply to add a native reaction to the user's message.
- **Image uploads**: include `[image:/absolute/path/to/file.png]` anywhere in the reply to upload that file as an attachment. `~` is expanded to the home dir. Multiple `[image:]` tags = multiple attachments in one message. Discord per-message size cap: 25 MB (Nitro Basic: 50 MB).
