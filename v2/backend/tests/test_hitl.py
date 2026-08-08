"""Tests for HITL review lifecycle, guards, and query filters."""
import pytest
from .conftest import make_doc, enable_hitl


def submit_review(pat_client, doc_id: str, name: str = "Proposed name") -> dict:
    """Helper: trigger a HITL review by making an untrusted PAT write."""
    r = pat_client.patch(f"/api/v1/docs/{doc_id}", json={"name": name})
    assert r.status_code == 202
    return r.json()


class TestReviewLifecycle:
    def test_untrusted_pat_write_creates_pending_review(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        submit_review(pat_client, doc["id"])

        r = cookie_client.get("/api/v1/hitl/reviews")
        assert r.status_code == 200
        reviews = r.json()
        assert any(rv["doc_id"] == doc["id"] and rv["outcome"] is None for rv in reviews)

    def test_approve_applies_payload_and_clears_status(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Original")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"], name="Approved name")
        review_id = rv["review_id"]

        r = cookie_client.post(f"/api/v1/hitl/reviews/{review_id}/resolve",
                               json={"outcome": "approved"})
        assert r.status_code == 200
        assert r.json()["outcome"] == "approved"

        updated = cookie_client.get(f"/api/v1/docs/{doc['id']}").json()
        assert updated["name"] == "Approved name"
        assert updated["hitl_status"] is None

    def test_reject_leaves_doc_unchanged(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Original")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"], name="Rejected name")

        cookie_client.post(f"/api/v1/hitl/reviews/{rv['review_id']}/resolve",
                           json={"outcome": "rejected", "human_notes": "Not acceptable"})

        updated = cookie_client.get(f"/api/v1/docs/{doc['id']}").json()
        assert updated["name"] == "Original"
        assert updated["hitl_status"] is None

    def test_cancel_frees_doc_for_new_review(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])

        cookie_client.post(f"/api/v1/hitl/reviews/{rv['review_id']}/resolve",
                           json={"outcome": "cancelled"})

        # Now a new review should be accepted
        r = pat_client.patch(f"/api/v1/docs/{doc['id']}", json={"name": "Second attempt"})
        assert r.status_code == 202

    def test_resolve_twice_returns_409(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])
        rid = rv["review_id"]

        cookie_client.post(f"/api/v1/hitl/reviews/{rid}/resolve", json={"outcome": "approved"})
        r = cookie_client.post(f"/api/v1/hitl/reviews/{rid}/resolve", json={"outcome": "rejected"})
        assert r.status_code == 409

    def test_invalid_outcome_returns_400(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])
        r = cookie_client.post(f"/api/v1/hitl/reviews/{rv['review_id']}/resolve",
                               json={"outcome": "dunno"})
        assert r.status_code == 400


class TestResolveGuard:
    def test_untrusted_pat_cannot_resolve(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])
        r = pat_client.post(f"/api/v1/hitl/reviews/{rv['review_id']}/resolve",
                            json={"outcome": "approved"})
        assert r.status_code == 403

    def test_trusted_pat_can_resolve(self, cookie_client, pat_client, trusted_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])
        r = trusted_client.post(f"/api/v1/hitl/reviews/{rv['review_id']}/resolve",
                                json={"outcome": "approved"})
        assert r.status_code == 200

    def test_cookie_can_resolve(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])
        r = cookie_client.post(f"/api/v1/hitl/reviews/{rv['review_id']}/resolve",
                               json={"outcome": "rejected"})
        assert r.status_code == 200


class TestQueryFilters:
    def test_doc_id_filter(self, cookie_client, pat_client):
        doc_a = make_doc(cookie_client, name="A")
        doc_b = make_doc(cookie_client, name="B")
        enable_hitl(cookie_client, doc_a["id"])
        enable_hitl(cookie_client, doc_b["id"])
        submit_review(pat_client, doc_a["id"])
        submit_review(pat_client, doc_b["id"])

        r = cookie_client.get(f"/api/v1/hitl/reviews?doc_id={doc_a['id']}")
        assert r.status_code == 200
        reviews = r.json()
        assert all(rv["doc_id"] == doc_a["id"] for rv in reviews)
        assert len(reviews) == 1

    def test_submitted_by_filter(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        submit_review(pat_client, doc["id"])

        # Find the actual prefix from the review (deterministic even with random PAT)
        all_reviews = cookie_client.get("/api/v1/hitl/reviews").json()
        prefix = all_reviews[0]["agent_pat_prefix"]
        assert prefix is not None

        r = cookie_client.get(f"/api/v1/hitl/reviews?submitted_by={prefix}")
        assert r.status_code == 200
        reviews = r.json()
        assert len(reviews) == 1
        assert reviews[0]["agent_pat_prefix"] == prefix

    def test_outcome_all_includes_resolved(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])
        cookie_client.post(f"/api/v1/hitl/reviews/{rv['review_id']}/resolve",
                           json={"outcome": "rejected"})

        pending = cookie_client.get("/api/v1/hitl/reviews").json()
        assert len(pending) == 0

        all_reviews = cookie_client.get("/api/v1/hitl/reviews?outcome=all").json()
        assert len(all_reviews) == 1
        assert all_reviews[0]["outcome"] == "rejected"

    def test_get_review_includes_doc_current(self, cookie_client, pat_client):
        doc = make_doc(cookie_client, name="Doc", body="current body")
        enable_hitl(cookie_client, doc["id"])
        rv = submit_review(pat_client, doc["id"])

        r = cookie_client.get(f"/api/v1/hitl/reviews/{rv['review_id']}")
        assert r.status_code == 200
        detail = r.json()
        assert detail["doc_current"] is not None
        assert detail["doc_current"]["body"] == "current body"
