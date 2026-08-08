"""Tests for doc CRUD, links, and HITL gate enforcement."""
import pytest
from fastapi.testclient import TestClient
from .conftest import make_doc, enable_hitl


class TestDocCRUD:
    def test_create_returns_201_with_fields(self, cookie_client):
        r = cookie_client.post("/api/v1/docs", json={"name": "Hello", "body": "world"})
        assert r.status_code == 201
        d = r.json()
        assert d["name"] == "Hello"
        assert d["body"] == "world"
        assert d["hitl_required"] is False
        assert d["hitl_status"] is None

    def test_get_existing_doc(self, cookie_client):
        doc = make_doc(cookie_client, name="Get me")
        r = cookie_client.get(f"/api/v1/docs/{doc['id']}")
        assert r.status_code == 200
        assert r.json()["name"] == "Get me"

    def test_get_nonexistent_returns_404(self, cookie_client):
        r = cookie_client.get("/api/v1/docs/does-not-exist")
        assert r.status_code == 404

    def test_patch_cookie_updates_field(self, cookie_client):
        doc = make_doc(cookie_client, name="Before")
        r = cookie_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "After"})
        assert r.status_code == 200
        assert r.json()["name"] == "After"

    def test_patch_note_outline_recomputed(self, cookie_client):
        doc = make_doc(cookie_client, body="# H1\n## H2")
        outline = doc["note_outline"]
        import json
        parsed = json.loads(outline)
        assert parsed[0]["level"] == 1
        assert parsed[0]["text"] == "H1"
        assert parsed[1]["level"] == 2

    def test_delete_returns_204(self, cookie_client):
        doc = make_doc(cookie_client, name="Delete me")
        r = cookie_client.delete(f"/api/v1/docs/{doc['id']}")
        assert r.status_code == 204
        assert cookie_client.get(f"/api/v1/docs/{doc['id']}").status_code == 404

    def test_list_docs(self, cookie_client):
        make_doc(cookie_client, name="Alpha")
        make_doc(cookie_client, name="Beta")
        r = cookie_client.get("/api/v1/docs")
        assert r.status_code == 200
        names = [d["name"] for d in r.json()["items"]]
        assert "Alpha" in names and "Beta" in names


class TestHitlGate:
    def test_untrusted_pat_write_to_protected_doc_returns_202(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Protected")
        enable_hitl(cookie_client, doc["id"])
        r = pat_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "Hacked"})
        assert r.status_code == 202
        body = r.json()
        assert body["status"] == "pending_review"
        assert "review_id" in body

    def test_doc_unchanged_after_hitl_intercept(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Original")
        enable_hitl(cookie_client, doc["id"])
        pat_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "Changed"})
        r = cookie_client.get(f"/api/v1/docs/{doc['id']}")
        assert r.json()["name"] == "Original"

    def test_trusted_pat_bypasses_hitl(self, cookie_client, trusted_client):
        doc = make_doc(cookie_client, name="Original")
        enable_hitl(cookie_client, doc["id"])
        r = trusted_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "Trusted update"})
        assert r.status_code == 200
        assert r.json()["name"] == "Trusted update"

    def test_cookie_bypasses_hitl(self, cookie_client):
        doc = make_doc(cookie_client, name="Original")
        enable_hitl(cookie_client, doc["id"])
        r = cookie_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "Browser update"})
        assert r.status_code == 200

    def test_second_pat_write_while_pending_returns_409(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Protected")
        enable_hitl(cookie_client, doc["id"])
        pat_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "First"})
        r = pat_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "Second"})
        assert r.status_code == 409

    def test_pat_cannot_set_hitl_required(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        r = pat_client.patch(f"/api/v1/docs/{doc['id']}", json={"hitl_required": True})
        assert r.status_code == 403

    def test_unprotected_pat_write_succeeds(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Open doc")
        r = pat_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "Updated"})
        assert r.status_code == 200


class TestDocLinks:
    def test_add_link(self, cookie_client):
        a = make_doc(cookie_client, name="A")
        b = make_doc(cookie_client, name="B")
        r = cookie_client.post(f"/api/v1/docs/{a['id']}/links",
                               json={"target_doc_id": b["id"], "label": "requires"})
        assert r.status_code == 201

    def test_get_links(self, cookie_client):
        a = make_doc(cookie_client, name="A")
        b = make_doc(cookie_client, name="B")
        cookie_client.post(f"/api/v1/docs/{a['id']}/links",
                           json={"target_doc_id": b["id"], "label": "related_to"})
        r = cookie_client.get(f"/api/v1/docs/{a['id']}/links")
        assert r.status_code == 200
        links = r.json()
        assert any(l["target_doc_id"] == b["id"] for l in links)

    def test_backlinks(self, cookie_client):
        a = make_doc(cookie_client, name="A")
        b = make_doc(cookie_client, name="B")
        cookie_client.post(f"/api/v1/docs/{a['id']}/links",
                           json={"target_doc_id": b["id"], "label": "up"})
        r = cookie_client.get(f"/api/v1/docs/{b['id']}/backlinks")
        assert r.status_code == 200
        assert any(d["id"] == a["id"] for d in r.json())

    def test_remove_link(self, cookie_client):
        a = make_doc(cookie_client, name="A")
        b = make_doc(cookie_client, name="B")
        cookie_client.post(f"/api/v1/docs/{a['id']}/links",
                           json={"target_doc_id": b["id"], "label": "related_to"})
        r = cookie_client.delete(f"/api/v1/docs/{a['id']}/links/{b['id']}")
        assert r.status_code == 204
        links = cookie_client.get(f"/api/v1/docs/{a['id']}/links").json()
        assert not any(l["target_doc_id"] == b["id"] for l in links)

    def test_self_link_rejected(self, cookie_client):
        a = make_doc(cookie_client, name="A")
        r = cookie_client.post(f"/api/v1/docs/{a['id']}/links",
                               json={"target_doc_id": a["id"], "label": "related_to"})
        assert r.status_code == 400

    def test_invalid_link_label_rejected(self, cookie_client):
        a = make_doc(cookie_client, name="A")
        b = make_doc(cookie_client, name="B")
        r = cookie_client.post(f"/api/v1/docs/{a['id']}/links",
                               json={"target_doc_id": b["id"], "label": "invented"})
        assert r.status_code == 400
