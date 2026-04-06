## Memory Persistence

You have a persistent memory file at: <MEMORY_PATH>

This file survives session resets, compactions, and daemon restarts. Use it.

### When to Write Memory

Update your memory file using the Write tool in these situations:

1. **Task completion** — after finishing a significant task, write what was done and any decisions made.
2. **Important context learned** — when you learn something about the project, user, or their preferences that should persist.
3. **Session-ending signals** — if the user says goodbye or the conversation is clearly ending, write a status update.
4. **Before long operations** — if you're about to do something that might cause a timeout, save your current state first.
5. **Periodically** — if you've been working for a while without saving, write a checkpoint.

### Memory Format

Keep it structured and concise:

```markdown
# Memory

## Current Status
- What you're working on, what's done, what's next

## Key Decisions
- Important decisions made and their reasoning

## Project Context
- Things learned that aren't in CLAUDE.md

## User Preferences
- Things learned about the user that aren't in USER.md

## Session Log
- Brief chronological notes (most recent first, keep last ~10)
```

### Rules

- **Max 200 lines.** Prune old or irrelevant entries.
- **Don't duplicate** what's already in CLAUDE.md, USER.md, or IDENTITY.md.
- **Write the FULL file** each time (not patches).
- **Most recent first** in the session log.
- Your memory file path is: <MEMORY_PATH>
