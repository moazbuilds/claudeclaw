#!/usr/bin/env python3
"""
Append-only operation journal for ClaudeClaw agents.
Chaque action importante est loggée avec timestamp, session_id, statut.
Stocké hors contexte Claude — survit aux crashes et redémarrages.
"""

import json
import os
import uuid
from datetime import datetime, timezone

JOURNAL_FILE = os.path.expanduser("~/.claudeclaw/journal/operations.jsonl")
SESSION_FILE = os.path.expanduser("~/.claudeclaw/journal/current-session.json")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _ensure_dir():
    """Ensure the journal directory exists before any session/journal write."""
    os.makedirs(os.path.dirname(JOURNAL_FILE), exist_ok=True)


def get_session_id():
    """Retourne ou crée un session_id persistant pour cette session."""
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE) as f:
                data = json.load(f)
            return data.get("session_id", str(uuid.uuid4()))
        except Exception:
            pass
    session_id = str(uuid.uuid4())
    _ensure_dir()
    with open(SESSION_FILE, "w") as f:
        json.dump({"session_id": session_id, "started_at": _now()}, f)
    return session_id


def log_action(action_type: str, description: str, status: str = "started", payload: dict = None):
    """
    Loggue une action dans le journal.

    status: 'started' | 'completed' | 'failed' | 'skipped'
    Retourne l'entry_id pour pouvoir mettre à jour le statut plus tard.
    """
    _ensure_dir()
    entry_id = str(uuid.uuid4())[:8]
    entry = {
        "id": entry_id,
        "ts": _now(),
        "session_id": get_session_id(),
        "type": action_type,
        "description": description,
        "status": status,
        "payload": payload or {},
    }
    with open(JOURNAL_FILE, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry_id


def update_status(entry_id: str, status: str, note: str = None):
    """Met à jour le statut d'une action existante."""
    _ensure_dir()
    update = {
        "id": entry_id,
        "ts": _now(),
        "session_id": get_session_id(),
        "type": "_update",
        "status": status,
        "note": note or "",
    }
    with open(JOURNAL_FILE, "a") as f:
        f.write(json.dumps(update, ensure_ascii=False) + "\n")


def get_incomplete_tasks(limit: int = 10):
    """
    Retourne les tâches 'started' sans 'completed' correspondant.
    Utile au démarrage pour détecter les tâches interrompues.
    """
    if not os.path.exists(JOURNAL_FILE):
        return []

    entries = {}
    with open(JOURNAL_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                eid = e.get("id")
                if not eid:
                    continue
                if e.get("type") == "_update":
                    if eid in entries:
                        entries[eid]["status"] = e["status"]
                else:
                    entries[eid] = e
            except Exception:
                continue

    incomplete = [
        e for e in entries.values()
        if e.get("status") == "started" and e.get("type") != "_update"
    ]
    # Trier par timestamp décroissant
    incomplete.sort(key=lambda x: x.get("ts", ""), reverse=True)
    return incomplete[:limit]


def get_recent(limit: int = 20, action_type: str = None):
    """Retourne les N dernières entrées du journal."""
    if not os.path.exists(JOURNAL_FILE):
        return []

    entries = []
    with open(JOURNAL_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                if action_type and e.get("type") != action_type:
                    continue
                if e.get("type") != "_update":
                    entries.append(e)
            except Exception:
                continue

    entries.sort(key=lambda x: x.get("ts", ""), reverse=True)
    return entries[:limit]


def new_session():
    """Crée une nouvelle session (à appeler au démarrage de chaque session Claude)."""
    _ensure_dir()
    session_id = str(uuid.uuid4())
    with open(SESSION_FILE, "w") as f:
        json.dump({"session_id": session_id, "started_at": _now()}, f)
    log_action("session", "New agent session started", status="completed")
    return session_id
