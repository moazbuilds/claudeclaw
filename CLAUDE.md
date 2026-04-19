# ClaudeClaw — Claude Instructions

## Session Continuity

On every session start, check for a handoff file:

```bash
ls "${CLAUDECLAW_PROJECT_DIR:-$PWD}/PRIOR_SESSION_STATE.md" 2>/dev/null
```

If it exists:
1. Read it immediately
2. Read your MEMORY.md
3. Fill in the "Active Work Summary" and "Key Facts" sections
4. Tell the user you have resumed and state what was in progress
5. Delete the file after reading — it is consumed, not persistent

This file is written automatically by the bundled hooks when:
- Turn count reaches threshold (default: 40 turns, configurable via `CLAUDECLAW_TURN_THRESHOLD`)
- A `/compact` runs (PreCompact hook)
