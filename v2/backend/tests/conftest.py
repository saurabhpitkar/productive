"""
Test configuration and shared fixtures.

Environment variables must be set BEFORE any app module is imported,
because config.py reads them at import time.
"""
import os
import tempfile
import time

# ── Set test env vars before any app import ───────────────────────────────────
_TEST_ROOT = tempfile.mkdtemp(prefix="pa_test_")

os.environ.setdefault("DATABASE_DIR",         _TEST_ROOT)
os.environ.setdefault("JWT_SECRET_KEY",       "test-jwt-secret-do-not-use-in-prod")
os.environ.setdefault("ENCRYPTION_KEY",       "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
os.environ.setdefault("ALLOWED_EMAILS",       "")
os.environ.setdefault("APP_ORIGIN_V2",        "http://localhost:3001")
os.environ.setdefault("GOOGLE_CLIENT_ID",     "test-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-client-secret")

# ── App imports (safe after env is set) ───────────────────────────────────────
import pytest
import jwt
from fastapi.testclient import TestClient

from app.main import app
import app.database as _db_mod
import app.token_store as _ts_mod

_JWT_SECRET = os.environ["JWT_SECRET_KEY"]
_TEST_USER_ID = "testuser_cookie"
_TEST_EMAIL   = "test@example.com"


def _make_jwt(sub: str = _TEST_USER_ID, email: str = _TEST_EMAIL) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "email": email, "name": "Test User", "avatar": "",
         "iat": now, "exp": now + 3600},
        _JWT_SECRET,
        algorithm="HS256",
    )


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolate_db(tmp_path, monkeypatch):
    """Give every test its own empty SQLite files. Runs automatically for every test."""
    db_dir     = str(tmp_path)
    token_path = str(tmp_path / "api_tokens.db")

    monkeypatch.setattr(_db_mod, "DATABASE_DIR", db_dir)
    monkeypatch.setattr(_ts_mod, "_DB_PATH",     token_path)

    # Clear SQLAlchemy engine cache so new engines are created under tmp_path
    _db_mod._engines.clear()
    _db_mod._migrated.clear()

    # Initialise a fresh token store at the new path
    _ts_mod.init_db()

    yield db_dir


@pytest.fixture
def cookie_client(isolate_db):
    """
    TestClient authenticated as a browser/human user.
    Uses the JWT Bearer path in auth.py (non-pa_ bearer → auth_method='cookie').
    This is equivalent to cookie auth for all access-control purposes.
    """
    token = _make_jwt()
    with TestClient(app, raise_server_exceptions=True) as c:
        c.headers.update({"Authorization": f"Bearer {token}"})
        yield c


@pytest.fixture
def pat_client(isolate_db):
    """TestClient authenticated via a real untrusted PAT."""
    raw, meta = _ts_mod.create_token(_TEST_USER_ID, "Test PAT")
    with TestClient(app, raise_server_exceptions=True) as c:
        c.headers.update({"Authorization": f"Bearer {raw}"})
        c.pat_prefix = raw[:14]  # matches auth.py bearer[:14] stored on reviews
        yield c


@pytest.fixture
def trusted_client(isolate_db):
    """TestClient authenticated via a real trusted PAT."""
    raw, meta = _ts_mod.create_token(_TEST_USER_ID, "Trusted PAT")
    _ts_mod.set_token_trusted(_TEST_USER_ID, meta["token_id"], True)
    with TestClient(app, raise_server_exceptions=True) as c:
        c.headers.update({"Authorization": f"Bearer {raw}"})
        yield c


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_doc(client: TestClient, name: str = "Test Doc", body: str = "", **kwargs) -> dict:
    r = client.post("/api/v1/docs", json={"name": name, "body": body, **kwargs})
    assert r.status_code == 201, r.text
    return r.json()


def enable_hitl(client: TestClient, doc_id: str) -> None:
    """Mark a doc as hitl_required=True. Must be called with cookie_client."""
    r = client.patch(f"/api/v1/docs/{doc_id}", json={"hitl_required": True})
    assert r.status_code == 200, r.text
