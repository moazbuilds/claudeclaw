#!/usr/bin/env python3
"""
Encrypted secrets vault for ClaudeClaw agents.
Credentials are never stored in plaintext on disk.
Fernet encryption (AES-128-CBC + HMAC-SHA256).

Usage:
    from vault import vault
    token = vault.get("TELEGRAM_BOT_TOKEN")
    vault.set("NEW_KEY", "value")
"""

import json
import os
import sys
from pathlib import Path

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:
    print("ERROR: pip3 install cryptography", file=sys.stderr)
    sys.exit(1)

VAULT_FILE = Path.home() / ".claudeclaw" / "vault" / "secrets.enc"
KEY_FILE = Path.home() / ".claudeclaw" / "vault" / ".vault_key"


class VaultError(RuntimeError):
    """Raised when the vault cannot be safely read or written."""


def _get_key() -> bytes:
    """Load or generate the master vault key."""
    # Priority 1: environment variable.
    env_key = os.environ.get("CLAUDECLAW_VAULT_KEY")
    if env_key:
        return env_key.encode()

    # Priority 2: key file (chmod 600).
    if KEY_FILE.exists():
        key = KEY_FILE.read_bytes().strip()
        if key:
            return key

    # Priority 3: generate a new key.
    key = Fernet.generate_key()
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_bytes(key)
    KEY_FILE.chmod(0o600)
    print(f"Generated new vault key: {KEY_FILE}", file=sys.stderr)
    return key


def _load() -> dict:
    """Load and decrypt the vault."""
    if not VAULT_FILE.exists():
        return {}
    try:
        f = Fernet(_get_key())
        raw = VAULT_FILE.read_bytes()
        return json.loads(f.decrypt(raw))
    except InvalidToken:
        raise VaultError("Vault key is invalid or the vault file is corrupted")
    except Exception as e:
        raise VaultError(f"Vault read failed: {e}") from e


def _save(data: dict):
    """Encrypt and save the vault."""
    VAULT_FILE.parent.mkdir(parents=True, exist_ok=True)
    f = Fernet(_get_key())
    encrypted = f.encrypt(json.dumps(data, ensure_ascii=False).encode())
    VAULT_FILE.write_bytes(encrypted)
    VAULT_FILE.chmod(0o600)


class Vault:
    def __init__(self):
        self._data = None

    def _ensure_loaded(self):
        if self._data is None:
            self._data = _load()

    def get(self, key: str, default=None):
        """Get a secret, falling back to the environment if it is not in the vault."""
        self._ensure_loaded()
        value = self._data.get(key)
        if value is not None:
            return value
        # Fallback .env
        return os.environ.get(key, default)

    def set(self, key: str, value: str):
        """Add or update a secret in the vault."""
        self._ensure_loaded()
        self._data[key] = value
        _save(self._data)

    def delete(self, key: str):
        """Delete a secret from the vault."""
        self._ensure_loaded()
        if key in self._data:
            del self._data[key]
            _save(self._data)

    def list_keys(self) -> list:
        """List the keys present in the vault, without values."""
        self._ensure_loaded()
        return list(self._data.keys())

    def import_from_env_file(self, env_path: str, overwrite: bool = False):
        """Import secrets from an .env file into the vault."""
        self._ensure_loaded()
        imported = []
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and value and (overwrite or key not in self._data):
                    self._data[key] = value
                    imported.append(key)
        if imported:
            _save(self._data)
        return imported


# Global instance
vault = Vault()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="ClaudeClaw encrypted secrets vault CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python3 vault.py set TELEGRAM_BOT_TOKEN "1234:abc..."
  python3 vault.py get TELEGRAM_BOT_TOKEN
  python3 vault.py list
  python3 vault.py delete OLD_KEY
  python3 vault.py import ~/.env --overwrite""",
    )
    sub = parser.add_subparsers(dest="cmd", required=True, metavar="COMMAND")

    p_set = sub.add_parser("set", help="Store a secret (key value)")
    p_set.add_argument("key")
    p_set.add_argument("value")

    p_get = sub.add_parser("get", help="Read a secret")
    p_get.add_argument("key")

    sub.add_parser("list", help="List all secret keys (values not shown)")

    p_del = sub.add_parser("delete", help="Remove a secret")
    p_del.add_argument("key")

    p_imp = sub.add_parser("import", help="Import keys from a .env file")
    p_imp.add_argument("path", help="Path to .env file")
    p_imp.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing keys (default: keep existing)",
    )

    args = parser.parse_args()

    if args.cmd == "set":
        try:
            vault.set(args.key, args.value)
        except VaultError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"✅ Stored {args.key}")
    elif args.cmd == "get":
        try:
            value = vault.get(args.key)
        except VaultError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        if value is None:
            print(f"❌ {args.key} not found", file=sys.stderr)
            sys.exit(1)
        print(value)
    elif args.cmd == "list":
        try:
            keys = vault.list_keys()
        except VaultError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        if not keys:
            print("(vault empty)")
        else:
            for k in sorted(keys):
                print(k)
    elif args.cmd == "delete":
        try:
            vault.delete(args.key)
        except VaultError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"✅ Deleted {args.key}")
    elif args.cmd == "import":
        try:
            imported = vault.import_from_env_file(args.path, overwrite=args.overwrite)
        except VaultError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        if imported:
            imported_keys = ", ".join(sorted(imported))
            print(f"✅ Imported {len(imported)} key(s): {imported_keys}")
        else:
            print("(no keys imported — file empty or all keys exist)")
