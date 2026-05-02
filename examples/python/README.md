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

## vault.py - Encrypted Secrets Vault

Fernet-encrypted (AES-128-CBC + HMAC-SHA256) secrets vault for ClaudeClaw
agents. Credentials are never stored in plaintext on disk.

Requires: `pip install cryptography`

**Features:**
- Fernet symmetric encryption (AES-128-CBC + HMAC-SHA256)
- Auto-generates vault key on first use (chmod 600)
- Key source priority: env var > key file > auto-generate
- Fallback to environment variables for missing keys
- Import secrets from .env files

**Usage:**
```python
from vault import vault

# Read a secret (falls back to env var if not in vault)
token = vault.get("TELEGRAM_BOT_TOKEN")

# Store a secret (encrypted on disk)
vault.set("API_KEY", "sk-...")

# List stored keys (values stay encrypted)
print(vault.list_keys())

# Bulk import from .env
vault.import_from_env_file(".env")
```

### Key Management

The vault key is stored at `~/.claudeclaw/vault/.vault_key` (chmod 600).
Override with the `CLAUDECLAW_VAULT_KEY` environment variable.

### CLI Usage

The same module is also a CLI:

```bash
python3 vault.py set TELEGRAM_BOT_TOKEN "1234:abc..."
python3 vault.py get TELEGRAM_BOT_TOKEN
python3 vault.py list
python3 vault.py delete OLD_KEY
python3 vault.py import ~/.env --overwrite
```

Use `python3 vault.py --help` to see all options.
