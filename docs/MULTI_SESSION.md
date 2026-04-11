# Multi-Session Support

Technical documentation for ClaudeClaw's multi-session feature.

## Overview

Each Discord channel and thread gets its own independent conversation (session) with an isolated working directory. Channels listed in `listenChannels` and DMs share the global session. The bot responds to all guild messages without requiring an @mention.

**Terminology:**
- **Session** — a persistent Claude CLI conversation with its own history, memory, and working directory.
- **Channel** — a Discord channel (e.g. #general, #dev).
- **Thread** — a Discord thread within a channel.

## Architecture

```
Discord Gateway
  │
  ├─ listenChannel message ──→ Global Queue ──→ Global Session (project cwd)
  ├─ DM ─────────────────────→ Global Queue ──→ Global Session (project cwd)
  │
  ├─ Other channel message ──→ Per-channel Queue ──→ Dedicated Session (own cwd)
  ├─ Thread A message ───────→ Per-thread Queue  ──→ Dedicated Session (own cwd)
  └─ Thread B message ───────→ Per-thread Queue  ──→ Dedicated Session (own cwd)
```

- **Global queue**: Serializes messages from `listenChannels` and DMs into one shared session.
- **Per-channel/thread queues**: Each Discord channel or thread has its own queue. Different channels and threads execute in parallel; messages within the same channel or thread are serialized.

## Session Routing

The routing logic in `discord.ts`:

```typescript
const isListenChannel = config.listenChannels.includes(channelId);
const threadId = (isGuild && !isListenChannel) ? channelId : undefined;
```

- Messages in a `listenChannel` → routed to the **global session** (project working directory)
- Messages in any other Discord channel or thread → routed to a **dedicated session** with its own working directory
- DMs → routed to the **global session**

## Working Directory Isolation

Each dedicated session runs Claude in its own directory:

```
.claude/claudeclaw/sessions/<discord-channel-or-thread-id>/
```

This gives each Discord channel and thread:
- Its own `CLAUDE.md` (loaded automatically by Claude Code)
- Its own memory directory
- Its own Claude Code session files
- Independent conversation history

The global session runs in the project root directory as before.

## Session Lifecycle

### Creation
1. A message arrives in a Discord channel or thread that is not in `listenChannels`.
2. `runUserMessage()` is called with the Discord channel/thread ID.
3. `execClaude()` checks for an existing session — returns `null` for new conversations.
4. A working directory is created: `.claude/claudeclaw/sessions/<discord-id>/`
5. Claude CLI is spawned with `cwd` set to that directory and `--output-format json`.
6. The returned `session_id` is persisted in `sessions.json`.

### Resume
1. Subsequent messages in the same Discord channel or thread look up the existing session.
2. Claude CLI is invoked with `--resume <sessionId>` in the same working directory.
3. Turn count is incremented for that session.

### Cleanup
Sessions are removed when:
- **Thread deleted**: Discord's `THREAD_DELETE` event triggers session removal.
- **Thread archived**: Discord's `THREAD_UPDATE` with `archived = true` triggers cleanup.
- Note: Sessions for regular Discord channels persist until manually cleaned up (channels don't have delete/archive events like threads do).

## Concurrency Model

```
Global Queue:          [msg1] → [msg2] → [msg3]     (serial)
#dev Queue:            [msgA1] → [msgA2]             (serial within #dev)
#design Queue:         [msgB1] → [msgB2]             (serial within #design)
Thread "fixes" Queue:  [msgC1]                        (serial within thread)

All queues run in parallel with each other.
```

Each queue prevents concurrent `--resume` calls on the same session. Different sessions run concurrently.

## Storage

### Global session: `.claude/claudeclaw/session.json`
```json
{
  "sessionId": "uuid",
  "createdAt": "ISO8601",
  "lastUsedAt": "ISO8601",
  "turnCount": 42,
  "compactWarned": false
}
```

### Per-channel/thread sessions: `.claude/claudeclaw/sessions.json`
```json
{
  "threads": {
    "<discord-channel-or-thread-id>": {
      "sessionId": "uuid",
      "threadId": "<discord-channel-or-thread-id>",
      "createdAt": "ISO8601",
      "lastUsedAt": "ISO8601",
      "turnCount": 10,
      "compactWarned": false
    }
  }
}
```

Note: The `threads` key and `threadId` field are legacy naming — they store sessions for both Discord channels and threads.

### Session working directories: `.claude/claudeclaw/sessions/<discord-id>/`
Each directory is an independent Claude Code project context.

## Files

| File | Role |
|------|------|
| `src/runner.ts` | Per-session queues, `cwd` parameter on `runClaudeOnce()`, `getSessionCwd()` helper |
| `src/sessionManager.ts` | Session CRUD, persistence in `sessions.json` |
| `src/commands/discord.ts` | Discord channel/thread detection, session routing, `guildTriggerReason()` |
| `src/sessions.ts` | Global session (unchanged) |

## Guild Trigger Reason

`guildTriggerReason()` determines why the bot responds to a Discord guild message. It returns a string for logging:

| Reason | Trigger |
|--------|---------|
| `reply_to_bot` | User replied to bot's message |
| `mention` | User @mentioned the bot |
| `listen_channel` | Message in a Discord channel listed in `listenChannels` |
| `listen_channel_thread` | Message in a Discord thread whose parent channel is in `listenChannels` |
| `guild_message` | Catch-all — bot responds to all Discord guild messages |

## Limitations

- No max session limit. Relies on Claude CLI's own rate limiting.
- Sessions are not automatically compacted.
- `/reset` only resets the global session, not per-channel/thread sessions.
- Sessions for regular Discord channels persist until manually cleaned up (unlike Discord threads which have delete/archive events).
