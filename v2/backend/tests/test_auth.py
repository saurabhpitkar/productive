"""
Tests for auth middleware - verifying the /api/health and /api/v1/docs
endpoints respond correctly under different auth states.

Note: most auth path testing happens implicitly in test_docs.py /
test_hitl.py via fixture overrides. This file tests the actual
JWT/PAT code paths by NOT using dependency overrides.
"""
import pytest
import jwt
import time
from fastapi.testclient import TestClient

from app.main import app
from app import token_store as _ts


# Don't use the override fixtures here - we want real auth middleware
@pytest.fixture
def raw_client(isolate_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


class TestHealthEndpoint:
    def test_health_always_200(self, raw_client):
        r = raw_client.get("/api/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


class TestMissingAuth:
    def test_no_auth_returns_401(self, raw_client):
        r = raw_client.get("/api/v1/docs")
        assert r.status_code == 401

    def test_invalid_bearer_returns_401(self, raw_client):
        r = raw_client.get("/api/v1/docs",
                           headers={"Authorization": "Bearer not_a_valid_token"})
        assert r.status_code == 401

    def test_invalid_pat_returns_401(self, raw_client):
        r = raw_client.get("/api/v1/docs",
                           headers={"Authorization": "Bearer pa_totallyfaketoken1234567890"})
        assert r.status_code == 401


class TestCookieAuth:
    def test_valid_jwt_cookie_allows_access(self, raw_client):
        secret = "test-jwt-secret-do-not-use-in-prod"
        payload = {
            "sub": "test_user_jwt",
            "email": "jwt@example.com",
            "name": "JWT User",
            "avatar": "",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, secret, algorithm="HS256")
        r = raw_client.get("/api/v1/docs", cookies={"pa_session": token})
        assert r.status_code == 200

    def test_expired_jwt_returns_401(self, raw_client):
        secret = "test-jwt-secret-do-not-use-in-prod"
        payload = {
            "sub": "test_user_jwt",
            "email": "jwt@example.com",
            "name": "JWT User",
            "avatar": "",
            "iat": int(time.time()) - 7200,
            "exp": int(time.time()) - 3600,  # expired 1h ago
        }
        token = jwt.encode(payload, secret, algorithm="HS256")
        r = raw_client.get("/api/v1/docs", cookies={"pa_session": token})
        assert r.status_code == 401


class TestPATAuth:
    def test_valid_pat_allows_access(self, isolate_db, raw_client):
        raw, _ = _ts.create_token("pat_test_user", "Test Agent")
        r = raw_client.get("/api/v1/docs",
                           headers={"Authorization": f"Bearer {raw}"})
        assert r.status_code == 200

    def test_revoked_pat_returns_401(self, isolate_db, raw_client):
        raw, meta = _ts.create_token("pat_test_user", "Revoked Agent")
        _ts.revoke_token("pat_test_user", meta["token_id"])
        r = raw_client.get("/api/v1/docs",
                           headers={"Authorization": f"Bearer {raw}"})
        assert r.status_code == 401
