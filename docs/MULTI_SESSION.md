# Multi-Session Support

Technical documentation for ClaudeClaw's multi-session feature (threads and channels).

## Overview

Discord threads and non-default channels get independent Claude CLI sessions with isolated working directories. Channels in `listenChannels` and DMs use the global session. The bot responds to all guild messages without requiring an @mention.

## Architecture

```
Discord Gateway
  │
  ├─ listenChannel message ──→ Global Queue ──→ Global Session (session.json, project cwd)
  ├─ DM message ─────────────→ Global Queue ──→ Global Session (session.json, project cwd)
  │
  ├─ Other channel message ──→ Channel Queue ──→ Channel Session (sessions.json, own cwd)
  ├─ Thread A message ───────→ Thread A Queue ──→ Thread A Session (sessions.json, own cwd)
  └─ Thread B message ───────→ Thread B Queue ──→ Thread B Session (sessions.json, own cwd)
```

- **Global queue**: Serializes listenChannel and DM messages.
- **Per-channel/thread queues**: Each has its own queue. Different channels/threads execute in parallel; messages within the same channel are serialized.

## Session Routing

The session selection logic in `discord.ts`:

```typescript
const isListenChannel = config.listenChannels.includes(channelId);
const threadId = (isGuild && !isListenChannel) ? channelId : undefined;
```

- `listenChannels` → global session (project working directory)
- Any other guild channel or thread → own session with isolated working directory
- DMs → global session

## Working Directory Isolation

Each non-global session runs Claude in its own directory:

```
.claude/claudeclaw/sessions/<channelId>/
```

This means each channel/thread session has:
- Its own `CLAUDE.md` (loaded automatically by Claude Code)
- Its own memory directory
- Its own Claude Code session files
- Independent conversation history

The global session runs in the project root directory as before.

## Session Lifecycle

### Creation
1. A message arrives in a non-listenChannel guild channel (or thread).
2. `runUserMessage()` is called with `channelId` as `threadId`.
3. `execClaude()` checks `sessionManager.getThreadSession(threadId)` — returns `null` for new sessions.
4. The session directory is created: `.claude/claudeclaw/sessions/<channelId>/`
5. Claude CLI is spawned with `cwd` set to that directory, `--output-format json`.
6. The returned `session_id` is saved via `sessionManager.createThreadSession(threadId, sessionId)`.

### Resume
1. Subsequent messages hit `getThreadSession(threadId)` which returns the existing `sessionId`.
2. Claude CLI is invoked with `--resume <sessionId>` in the same session directory.
3. Turn count is incremented per-session.

### Cleanup
Sessions are removed when:
- **Thread deleted**: `THREAD_DELETE` event triggers `removeThreadSession(threadId)`.
- **Thread archived**: `THREAD_UPDATE` with `thread_metadata.archived = true` triggers cleanup.

## Concurrency Model

```
Global Queue:      [msg1] → [msg2] → [msg3]     (serial)
Channel A Queue:   [msgA1] → [msgA2]             (serial within channel)
Channel B Queue:   [msgB1] → [msgB2]             (serial within channel)

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

### Channel/thread sessions: `.claude/claudeclaw/sessions.json`
```json
{
  "threads": {
    "1234567890": {
      "sessionId": "uuid",
      "threadId": "1234567890",
      "createdAt": "ISO8601",
      "lastUsedAt": "ISO8601",
      "turnCount": 10,
      "compactWarned": false
    }
  }
}
```

### Session working directories: `.claude/claudeclaw/sessions/<channelId>/`
Each session directory is an independent Claude Code project context.

## Files

| File | Role |
|------|------|
| `src/runner.ts` | Per-session queues, `cwd` parameter on `runClaudeOnce()`, `getSessionCwd()` helper |
| `src/sessionManager.ts` | Session CRUD, storage in `sessions.json` |
| `src/commands/discord.ts` | Channel/thread detection, session routing, `guildTriggerReason()` |
| `src/sessions.ts` | Global session (unchanged) |

## Guild Trigger Reason

`guildTriggerReason()` determines why the bot responds. It returns a string for logging:

| Reason | Trigger |
|--------|---------|
| `reply_to_bot` | User replied to bot's message |
| `mention` | User mentioned bot |
| `listen_channel` | Message in a listenChannel |
| `listen_channel_thread` | Thread whose parent is a listenChannel |
| `guild_message` | Catch-all — bot responds to all guild messages |

## Limitations

- No max session limit. Relies on Claude CLI's own rate limiting.
- Channel sessions are not automatically compacted.
- `/reset` only resets the global session, not channel/thread sessions.
- Channel sessions persist until manually cleaned up (unlike threads which have delete/archive events).
