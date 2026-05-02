# Python Plugin Examples

Standalone Python modules that extend ClaudeClaw agents with crash-recovery
and security capabilities. These are not part of the core TypeScript runtime
but can be called from custom prompts or automation scripts.

## journal.py - Append-Only Operation Journal

Logs every significant agent action to a JSONL file with timestamps, session
IDs, and status tracking. Survives crashes and context window resets.

**Features:**
- Append-only JSONL format (no data loss on crash)
- Session ID tracking across restarts
- Status lifecycle: started -> completed / failed / skipped
- Incomplete task detection on startup (crash recovery)
- Recent history queries with optional type filtering

**Usage:**
```python
from journal import log_action, update_status, get_incomplete_tasks

# Log an action
entry_id = log_action("deploy", "Deploying v2.1 to production")

# Update status when done
update_status(entry_id, "completed", "Deployed successfully")

# On restart, check for interrupted tasks
interrupted = get_incomplete_tasks()
```
