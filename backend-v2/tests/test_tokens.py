"""Tests for PAT token management and trusted flag enforcement."""
import pytest


class TestTokenCRUD:
    def test_create_token_returns_201_with_prefix(self, cookie_client):
        r = cookie_client.post("/api/v1/tokens", json={"name": "My Agent"})
        assert r.status_code == 201
        data = r.json()
        assert data["name"] == "My Agent"
        assert data["token"].startswith("pa_")
        assert "token_id" in data

    def test_list_tokens_includes_created_token(self, cookie_client):
        cookie_client.post("/api/v1/tokens", json={"name": "Agent One"})
        r = cookie_client.get("/api/v1/tokens")
        assert r.status_code == 200
        names = [t["name"] for t in r.json()]
        assert "Agent One" in names

    def test_new_token_trusted_false_by_default(self, cookie_client):
        cookie_client.post("/api/v1/tokens", json={"name": "New"})
        tokens = cookie_client.get("/api/v1/tokens").json()
        assert all(not t["trusted"] for t in tokens)

    def test_revoke_token(self, cookie_client):
        r = cookie_client.post("/api/v1/tokens", json={"name": "Temp"})
        token_id = r.json()["token_id"]
        del_r = cookie_client.delete(f"/api/v1/tokens/{token_id}")
        assert del_r.status_code == 204
        remaining = [t["token_id"] for t in cookie_client.get("/api/v1/tokens").json()]
        assert token_id not in remaining

    def test_revoke_nonexistent_returns_404(self, cookie_client):
        r = cookie_client.delete("/api/v1/tokens/does-not-exist")
        assert r.status_code == 404


class TestTrustedFlag:
    def test_cookie_can_set_trusted(self, cookie_client):
        r = cookie_client.post("/api/v1/tokens", json={"name": "Agent"})
        token_id = r.json()["token_id"]

        patch = cookie_client.patch(f"/api/v1/tokens/{token_id}/trusted",
                                    json={"trusted": True})
        assert patch.status_code == 200
        assert patch.json()["trusted"] is True

        tokens = cookie_client.get("/api/v1/tokens").json()
        match = next(t for t in tokens if t["token_id"] == token_id)
        assert match["trusted"] is True

    def test_pat_cannot_set_trusted(self, cookie_client, pat_client):
        r = cookie_client.post("/api/v1/tokens", json={"name": "Agent"})
        token_id = r.json()["token_id"]

        r2 = pat_client.patch(f"/api/v1/tokens/{token_id}/trusted", json={"trusted": True})
        assert r2.status_code == 403

    def test_set_trusted_nonexistent_returns_404(self, cookie_client):
        r = cookie_client.patch("/api/v1/tokens/no-such-token/trusted", json={"trusted": True})
        assert r.status_code == 404

    def test_toggle_trusted_on_and_off(self, cookie_client):
        r = cookie_client.post("/api/v1/tokens", json={"name": "Toggler"})
        tid = r.json()["token_id"]

        cookie_client.patch(f"/api/v1/tokens/{tid}/trusted", json={"trusted": True})
        cookie_client.patch(f"/api/v1/tokens/{tid}/trusted", json={"trusted": False})

        tokens = cookie_client.get("/api/v1/tokens").json()
        match = next(t for t in tokens if t["token_id"] == tid)
        assert match["trusted"] is False
