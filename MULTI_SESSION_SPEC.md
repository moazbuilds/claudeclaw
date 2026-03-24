# ClaudeClaw Multi-Session Thread Support - Feature Spec

## Goal
Add Discord thread binding with independent Claude CLI sessions per thread, enabling parallel conversations.

## Current Architecture
- Single global session (`session.json`)
- Single global queue (one message at a time)
- All messages (DM + channel) share one Claude CLI session

## Target Architecture
- Session map: `threadId → { sessionId, createdAt, lastUsedAt }`
- Per-thread queue: each thread processes messages independently
- Main channel keeps using the global session (backward compatible)
- Discord threads get their own isolated sessions

## Files to Modify

### 1. NEW: `src/sessionManager.ts`
- `SessionMap` class managing thread → session mappings
- Storage: `.claude/claudeclaw/sessions.json`
- Methods:
  - `getSession(threadId?: string)` — get or create session for thread
  - `createSession(threadId: string)` — bootstrap new Claude CLI session
  - `removeSession(threadId: string)` — cleanup on thread archive/delete
  - `listSessions()` — list all active sessions
- Falls back to global session when no threadId (backward compat)

### 2. MODIFY: `src/runner.ts`
- `execClaude()` accepts optional `sessionId` parameter
- `run()` and `runUserMessage()` accept optional `threadId`
- Per-thread queue instead of single global queue
- Each thread gets its own enqueue chain

### 3. MODIFY: `src/commands/discord.ts`
- Detect thread vs channel messages
- Route thread messages to their session via sessionManager
- Add commands:
  - `/thread` or auto-create: spawn new thread with fresh session
  - Thread archive → cleanup session
- Show thread session info in `/status`

### 4. MODIFY: `README.md`
- Document multi-session thread support
- Architecture diagram
- Configuration options
- Limitations

### 5. NEW: `docs/MULTI_SESSION.md`
- Detailed technical documentation
- Migration notes
- Session lifecycle
- Concurrency model

## Key Design Decisions
- **Backward compatible**: No threadId = use global session (existing behavior)
- **Auto-create sessions**: First message in a new thread auto-creates a session
- **Concurrency**: Each thread has its own queue, threads run in parallel
- **Storage**: JSON file, same pattern as existing session.json
- **No max limit initially**: Trust Claude CLI's own rate limiting

## Testing
- Parallel sessions work (already verified in POC)
- `--resume` with different sessionIds works (already verified)
- Thread isolation: messages in thread A don't leak to thread B
