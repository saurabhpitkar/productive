import json
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import require_user
from ..database import get_session_factory, ensure_schema
from ..models import Doc, HitlReview, Base
from ..schemas import DocResponse, HitlReviewResponse, _extract_outline

router = APIRouter(prefix="/hitl", tags=["hitl"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_db(user: dict):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    return get_session_factory(user_id)()


def _to_response(r: HitlReview, doc_name: str, doc=None, include_current: bool = False) -> HitlReviewResponse:
    return HitlReviewResponse(
        id=r.id,
        doc_id=r.doc_id,
        doc_name=doc_name,
        proposed_payload=json.loads(r.proposed_payload),
        agent_pat_prefix=r.agent_pat_prefix,
        outcome=r.outcome,
        human_notes=r.human_notes,
        created_at=r.created_at,
        resolved_at=r.resolved_at,
        doc_current=DocResponse.from_doc(doc) if (include_current and doc) else None,
    )


@router.get("/reviews", response_model=List[HitlReviewResponse])
def list_reviews(
    outcome:      Optional[str] = Query(None, description="Omit=pending only, 'all'=all, or specific value"),
    doc_id:       Optional[str] = Query(None, description="Filter by doc ID"),
    submitted_by: Optional[str] = Query(None, description="Filter by agent_pat_prefix"),
    user: dict = Depends(require_user),
):
    db = _get_db(user)
    try:
        q = db.query(HitlReview)
        if outcome is None:
            q = q.filter(HitlReview.outcome == None)  # noqa: E711
        elif outcome != "all":
            q = q.filter(HitlReview.outcome == outcome)
        if doc_id:
            q = q.filter(HitlReview.doc_id == doc_id)
        if submitted_by:
            q = q.filter(HitlReview.agent_pat_prefix == submitted_by)
        reviews = q.order_by(HitlReview.created_at.desc()).all()
        result = []
        for r in reviews:
            doc = db.query(Doc).filter(Doc.id == r.doc_id).first()
            result.append(_to_response(r, doc.name if doc else "Deleted doc"))
        return result
    finally:
        db.close()


@router.get("/reviews/{review_id}", response_model=HitlReviewResponse)
def get_review(review_id: str, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        r = db.query(HitlReview).filter(HitlReview.id == review_id).first()
        if not r:
            raise HTTPException(404, "Review not found")
        doc = db.query(Doc).filter(Doc.id == r.doc_id).first()
        return _to_response(r, doc.name if doc else "Deleted doc", doc=doc, include_current=True)
    finally:
        db.close()


class ResolveRequest(BaseModel):
    outcome:     str            # "approved" | "rejected" | "cancelled"
    human_notes: Optional[str] = None


@router.post("/reviews/{review_id}/resolve")
def resolve_review(review_id: str, body: ResolveRequest, user: dict = Depends(require_user)):
    # Untrusted PAT callers cannot resolve reviews - only browser users and trusted tokens
    if user["auth_method"] == "pat" and not user.get("pat_trusted"):
        raise HTTPException(403, "Only trusted tokens or browser users can resolve reviews")

    if body.outcome not in ("approved", "rejected", "cancelled"):
        raise HTTPException(400, "outcome must be one of: approved, rejected, cancelled")

    db = _get_db(user)
    try:
        r = db.query(HitlReview).filter(HitlReview.id == review_id).first()
        if not r:
            raise HTTPException(404, "Review not found")
        if r.outcome is not None:
            raise HTTPException(409, "Review already resolved")

        doc = db.query(Doc).filter(Doc.id == r.doc_id).first()
        if doc:
            if body.outcome == "approved":
                payload = json.loads(r.proposed_payload)
                for field, value in payload.items():
                    setattr(doc, field, value)
                if "body" in payload:
                    doc.note_outline = _extract_outline(doc.body or "")
            doc.hitl_status = None
            doc.updated_at = _now()

        r.outcome = body.outcome
        r.human_notes = body.human_notes
        r.resolved_at = _now()
        db.commit()
        return {"ok": True, "outcome": body.outcome}
    finally:
        db.close()
