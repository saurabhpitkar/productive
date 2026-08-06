"""
Global PAT (Personal Access Token) store.
Uses a single shared SQLite file at /data/api_tokens.db - separate from per-user DBs
so any token can be validated without knowing the user first.
"""
import hashlib
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone

_DB_PATH = os.path.join(os.environ.get("DATABASE_DIR", "/data"), "api_tokens.db")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS api_token (
                token_id     TEXT PRIMARY KEY,
                token_hash   TEXT UNIQUE NOT NULL,
                user_id      TEXT NOT NULL,
                name         TEXT NOT NULL,
                prefix       TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                last_used_at TEXT,
                active       INTEGER NOT NULL DEFAULT 1,
                trusted      INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Migrate existing rows that predate the trusted column
        cols = {row[1] for row in conn.execute("PRAGMA table_info(api_token)").fetchall()}
        if "trusted" not in cols:
            conn.execute("ALTER TABLE api_token ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_token(user_id: str, name: str) -> tuple[str, dict]:
    """
    Generate a new PAT. Returns (raw_token, metadata).
    raw_token is shown to the user exactly once - never stored in plaintext.
    """
    raw      = "pa_" + secrets.token_urlsafe(40)
    h        = hashlib.sha256(raw.encode()).hexdigest()
    token_id = str(uuid.uuid4())
    prefix   = raw[:12]   # "pa_" + first 9 chars - enough to identify without being guessable
    now      = _now()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO api_token (token_id, token_hash, user_id, name, prefix, created_at, active) "
            "VALUES (?, ?, ?, ?, ?, ?, 1)",
            (token_id, h, user_id, name, prefix, now),
        )
    return raw, {"token_id": token_id, "name": name, "prefix": prefix,
                 "created_at": now, "last_used_at": None}


def validate_token(raw: str) -> dict | None:
    """Returns {user_id, trusted} if token is valid and active. Updates last_used_at. Returns None otherwise."""
    h = hashlib.sha256(raw.encode()).hexdigest()
    with _connect() as conn:
        row = conn.execute(
            "SELECT user_id, trusted FROM api_token WHERE token_hash = ? AND active = 1", (h,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE api_token SET last_used_at = ? WHERE token_hash = ?", (_now(), h)
            )
            return {"user_id": row["user_id"], "trusted": bool(row["trusted"])}
    return None


def list_tokens(user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT token_id, name, prefix, created_at, last_used_at, trusted FROM api_token "
            "WHERE user_id = ? AND active = 1 ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()
        return [{**dict(r), "trusted": bool(r["trusted"])} for r in rows]


def set_token_trusted(user_id: str, token_id: str, trusted: bool) -> bool:
    """Set the trusted flag on a token. Returns True if the token was found and updated."""
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE api_token SET trusted = ? WHERE token_id = ? AND user_id = ? AND active = 1",
            (1 if trusted else 0, token_id, user_id),
        )
        return cur.rowcount > 0


def revoke_token(user_id: str, token_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE api_token SET active = 0 WHERE token_id = ? AND user_id = ?",
            (token_id, user_id),
        )
        return cur.rowcount > 0
