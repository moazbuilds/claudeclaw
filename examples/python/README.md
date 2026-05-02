# vault.py - Encrypted Secrets Vault

Fernet-encrypted (AES-128-CBC + HMAC-SHA256) secrets vault for ClaudeClaw
agents. Credentials are never stored in plaintext on disk.

Requires: `pip install cryptography`

## Features

- Fernet symmetric encryption (AES-128-CBC + HMAC-SHA256)
- Auto-generates vault key on first use (chmod 600)
- Key source priority: env var > key file > auto-generate
- Fallback to environment variables for missing keys
- Import secrets from .env files

## Usage

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

## Key Management

The vault key is stored at `~/.claudeclaw/vault/.vault_key` (chmod 600).
Override with the `CLAUDECLAW_VAULT_KEY` environment variable.

## CLI Usage

The same module is also a CLI:

```bash
python3 vault.py set TELEGRAM_BOT_TOKEN "1234:abc..."
python3 vault.py get TELEGRAM_BOT_TOKEN
python3 vault.py list
python3 vault.py delete OLD_KEY
python3 vault.py import ~/.env --overwrite
```

Use `python3 vault.py --help` to see all options.
