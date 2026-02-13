---
description: Clear session and start fresh
---

Clear the current Claude session by backing it up and restarting the daemon with a fresh session.

Run:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts --clear
```

This will:
1. Rename `session.json` → `session_<index>.backup` (preserving the old session)
2. Stop the running daemon if any
3. The next `/heartbeat:start` will create a brand new session

Report the output to the user.
