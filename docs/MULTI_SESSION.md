# Multi-Session Thread Support

Technical documentation for ClaudeClaw's multi-session thread feature.

## Overview

Discord threads get independent Claude CLI sessions, enabling parallel conversations. The main channel and DMs continue using the single global session (backward compatible).

## Architecture

```
Discord Gateway
  │
  ├─ Main channel message ──→ Global Queue ──→ Global Session (session.json)
  ├─ DM message ─────────────→ Global Queue ──→ Global Session (session.json)
  │
  ├─ Thread A message ───────→ Thread A Queue ──→ Thread A Session (sessions.json)
  └─ Thread B message ───────→ Thread B Queue ──→ Thread B Session (sessions.json)
```

- **Global queue**: Serializes non-thread messages (existing behavior).
- **Per-thread queues**: Each thread has its own queue. Different threads execute in parallel; messages within the same thread are serialized.

## Session Lifecycle

### Creation
1. A message arrives in a Discord thread.
2. `discord.ts` detects the thread via `knownThreads` cache (populated from `GUILD_CREATE`, `THREAD_CREATE`, `THREAD_LIST_SYNC` events).
3. `runUserMessage()` is called with the `threadId`.
4. `execClaude()` checks `sessionManager.getThreadSession(threadId)` — returns `null` for new threads.
5. Claude CLI is invoked with `--output-format json` to bootstrap a new session.
6. The returned `session_id` is saved via `sessionManager.createThreadSession(threadId, sessionId)`.

### Resume
1. Subsequent messages in the same thread hit `getThreadSession(threadId)` which returns the existing `sessionId`.
2. Claude CLI is invoked with `--resume <sessionId>`.
3. Turn count is incremented per-thread.

### Cleanup
Sessions are removed when:
- **Thread deleted**: `THREAD_DELETE` event triggers `removeThreadSession(threadId)`.
- **Thread archived**: `THREAD_UPDATE` with `thread_metadata.archived = true` triggers cleanup.

## Concurrency Model

```
Global Queue:    [msg1] → [msg2] → [msg3]     (serial)
Thread A Queue:  [msgA1] → [msgA2]             (serial within thread)
Thread B Queue:  [msgB1] → [msgB2]             (serial within thread)

Thread A and Thread B run in parallel.
Global Queue runs independently of all thread queues.
```

Each queue prevents concurrent `--resume` calls on the same session (which would cause Claude CLI errors). Different sessions can safely run concurrently.

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

### Thread sessions: `.claude/claudeclaw/sessions.json`
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

Thread sessions use the Discord thread channel ID as the key.

## Files

| File | Role |
|------|------|
| `src/sessionManager.ts` | Thread session CRUD, storage in `sessions.json` |
| `src/runner.ts` | Per-thread queues, `threadId` parameter on `run()`/`runUserMessage()`/`execClaude()` |
| `src/commands/discord.ts` | Thread detection via `knownThreads` cache, event handlers, `/status` enhancement |
| `src/sessions.ts` | Global session (unchanged) |

## Thread Detection

Discord thread channels are tracked via gateway events:

| Event | Action |
|-------|--------|
| `GUILD_CREATE` | Cache all active threads from `data.threads` |
| `THREAD_CREATE` | Add thread to cache |
| `THREAD_DELETE` | Remove from cache + cleanup session |
| `THREAD_UPDATE` | Remove if archived, add if unarchived |
| `THREAD_LIST_SYNC` | Bulk-add active threads |

The `knownThreads` map stores `threadId → { parentId }`. When a message's `channel_id` matches a known thread, it's routed to a thread-specific session.

Threads in listen channels (where the parent channel is in `listenChannels`) auto-respond without requiring a mention.

## Limitations

- No max thread session limit. Relies on Claude CLI's own rate limiting.
- Thread sessions are not automatically compacted (global `/compact` command only affects the global session).
- `/reset` only resets the global session, not thread sessions.
- Thread sessions persist until thread deletion/archival.
