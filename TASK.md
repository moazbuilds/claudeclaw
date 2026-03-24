# Task: Add Multi-Session Thread Support to ClaudeClaw

Read MULTI_SESSION_SPEC.md for the full specification.

## What to do:

1. **Create `src/sessionManager.ts`** — Manages thread-to-session mappings
   - Store in `.claude/claudeclaw/sessions.json`
   - getOrCreateSession(threadId) / removeSession(threadId) / listSessions()
   - Bootstrap new sessions by calling Claude CLI with `--output-format json` to get session_id
   - Falls back to global session.json when no threadId

2. **Modify `src/runner.ts`**
   - Add threadId parameter to run() and runUserMessage()
   - Create per-thread queues (Map<string, queue>) so threads run in parallel
   - execClaude() should accept an explicit sessionId to resume
   - Keep backward compat: no threadId = use global session (existing behavior)

3. **Modify `src/commands/discord.ts`**
   - Detect if message is in a thread (message.channel.isThread())
   - Route thread messages through sessionManager
   - First message in thread auto-creates a new session
   - Add `/status` enhancement to show thread session info
   - Thread delete/archive should clean up sessions

4. **Update `README.md`**
   - Add "Multi-Session Threads" section explaining the feature
   - Show how threads get independent sessions
   - Note parallel processing capability

5. **Create `docs/MULTI_SESSION.md`**
   - Technical documentation with architecture details
   - Session lifecycle, concurrency model, storage format

## Important constraints:
- DO NOT break existing single-session behavior (DMs, main channel)
- The global queue stays for non-thread messages
- Each thread gets its OWN queue (parallel execution)
- Use the same Claude CLI invocation pattern as existing code
- Keep the same coding style as the existing codebase (TypeScript, Bun)
- Run `bun build` or type-check if possible to verify no errors

When completely finished, run: openclaw system event --text "Done: ClaudeClaw multi-session thread support implemented" --mode now
