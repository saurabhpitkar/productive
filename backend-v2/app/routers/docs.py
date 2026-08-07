import json
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import case, or_, text
from sqlalchemy.orm import Session

from pydantic import BaseModel as PydanticBase

from ..auth import require_user
from ..database import get_session_factory, ensure_schema
from ..models import Doc, DocLink, HitlReview, DeletionLog, Base, LINK_LABELS
from ..schemas import DocCreate, DocUpdate, DocResponse, PaginatedDocs, LinkCreate, _extract_outline


class DocLinkResponse(PydanticBase):
    source_doc_id: str
    target_doc_id: str
    label: str
    created_at: str

router = APIRouter(prefix="/docs", tags=["docs"])

_PRIORITY_ORDER = case(
    (Doc.priority == "high",   1),
    (Doc.priority == "medium", 2),
    (Doc.priority == "low",    3),
    else_=4,
)
_SORT_MAP = {
    "name":       Doc.name,
    "priority":   _PRIORITY_ORDER,
    "created_at": Doc.created_at,
    "updated_at": Doc.updated_at,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_db(user: dict):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    return get_session_factory(user_id)()


@router.get("", response_model=PaginatedDocs)
def list_docs(
    q:             Optional[str]  = Query(None),
    status:        Optional[str]  = Query(None),
    priority:      Optional[str]  = Query(None),
    flag:          Optional[bool] = Query(None),
    list_id:       Optional[str]  = Query(None),
    sort:          str            = Query("updated_at"),
    order:         str            = Query("desc"),
    limit:         int            = Query(200, le=1000),
    offset:        int            = Query(0),
    updated_since: Optional[str]  = Query(None),
    user: dict = Depends(require_user),
):
    db = _get_db(user)
    try:
        q_base = db.query(Doc)
        statuses = [s.strip() for s in status.split(",")] if status else None
        if statuses:
            q_base = q_base.filter(Doc.status.in_(statuses))
        else:
            q_base = q_base.filter(Doc.status != "archived")
        if q:
            q_base = q_base.filter(or_(Doc.name.ilike(f"%{q}%"), Doc.body.ilike(f"%{q}%")))
        if priority:
            q_base = q_base.filter(Doc.priority.in_([p.strip() for p in priority.split(",")]))
        if flag is not None:
            q_base = q_base.filter(Doc.flag == flag)
        if list_id:
            q_base = q_base.filter(Doc.list_id == list_id)
        if updated_since:
            q_base = q_base.filter(Doc.updated_at > updated_since)
        total    = q_base.count()
        sort_col = _SORT_MAP.get(sort, Doc.updated_at)
        q_base   = q_base.order_by(sort_col.desc() if order == "desc" else sort_col.asc())
        docs     = q_base.offset(offset).limit(limit).all()
        return PaginatedDocs(
            items=[DocResponse.from_doc(d) for d in docs],
            total=total, limit=limit, offset=offset,
        )
    finally:
        db.close()


@router.get("/all-links", response_model=List[DocLinkResponse])
def get_all_links(user: dict = Depends(require_user)):
    """Return every link for this user with its label - used by the client to compute doc hierarchy."""
    db = _get_db(user)
    try:
        links = db.query(DocLink).all()
        return [DocLinkResponse(
            source_doc_id=l.source_doc_id,
            target_doc_id=l.target_doc_id,
            label=l.label,
            created_at=l.created_at,
        ) for l in links]
    finally:
        db.close()


@router.post("", response_model=DocResponse, status_code=201)
def create_doc(body: DocCreate, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        now    = _now()
        doc_id = body.id or str(uuid.uuid4())
        existing = db.query(Doc).filter(Doc.id == doc_id).first()
        if existing:
            return DocResponse.from_doc(existing)
        data = body.model_dump(exclude={"id", "created_at", "updated_at"})
        doc  = Doc(
            id=doc_id,
            created_at=body.created_at or now,
            updated_at=body.updated_at or now,
            note_outline=_extract_outline(body.body),
            **data,
        )
        db.add(doc)
        db.commit()
        db.refresh(doc)
        return DocResponse.from_doc(doc)
    finally:
        db.close()


@router.get("/{doc_id}", response_model=DocResponse)
def get_doc(doc_id: str, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        doc = db.query(Doc).filter(Doc.id == doc_id).first()
        if not doc:
            raise HTTPException(404, "Doc not found")
        return DocResponse.from_doc(doc)
    finally:
        db.close()


@router.patch("/{doc_id}", response_model=DocResponse,
              responses={202: {"description": "Pending HITL review created"}})
def update_doc(doc_id: str, body: DocUpdate, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        doc = db.query(Doc).filter(Doc.id == doc_id).first()
        if not doc:
            raise HTTPException(404, "Doc not found")
        updates = body.model_dump(exclude_unset=True)

        # PAT callers may not change hitl_required
        if user["auth_method"] == "pat" and "hitl_required" in updates:
            raise HTTPException(403, "API tokens cannot modify hitl_required")

        # HITL gate: intercept untrusted agent writes to protected docs
        if doc.hitl_required and user["auth_method"] == "pat" and not user.get("pat_trusted"):
            if doc.hitl_status == "pending":
                raise HTTPException(409, "A review is already pending for this doc")
            payload = {k: v for k, v in updates.items() if k != "hitl_required"}
            review = HitlReview(
                id=str(uuid.uuid4()),
                doc_id=doc_id,
                proposed_payload=json.dumps(payload),
                agent_pat_prefix=user.get("pat_prefix"),
                outcome=None,
                created_at=_now(),
                resolved_at=None,
            )
            db.add(review)
            doc.hitl_status = "pending"
            db.commit()
            return JSONResponse(status_code=202, content={
                "review_id": review.id,
                "status": "pending_review",
                "message": "This doc requires human review before changes are applied.",
            })

        # Normal update path
        for field, value in updates.items():
            setattr(doc, field, value)
        if "body" in updates:
            doc.note_outline = _extract_outline(doc.body or "")
        doc.updated_at = _now()
        db.commit()
        db.refresh(doc)
        return DocResponse.from_doc(doc)
    finally:
        db.close()


@router.delete("/{doc_id}", status_code=204)
def delete_doc(doc_id: str, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        doc = db.query(Doc).filter(Doc.id == doc_id).first()
        if not doc:
            return
        # Bump updated_at on docs that linked TO this one so delta sync
        # returns them with corrected linked_doc_ids.
        affected_ids = [
            row[0] for row in
            db.query(DocLink.source_doc_id)
              .filter(DocLink.target_doc_id == doc_id)
              .all()
        ]
        if affected_ids:
            db.query(Doc).filter(Doc.id.in_(affected_ids)).update(
                {"updated_at": _now()}, synchronize_session=False
            )
        db.add(DeletionLog(id=doc_id, item_type="doc", deleted_at=_now()))
        db.delete(doc)
        db.commit()
    finally:
        db.close()


@router.post("/{doc_id}/links", status_code=201)
def add_link(doc_id: str, body: LinkCreate, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        if doc_id == body.target_doc_id:
            raise HTTPException(400, "Self-links are not permitted")
        if not db.query(Doc).filter(Doc.id == doc_id).first():
            raise HTTPException(404, "Source doc not found")
        if not db.query(Doc).filter(Doc.id == body.target_doc_id).first():
            raise HTTPException(404, "Target doc not found")
        if body.label not in LINK_LABELS:
            raise HTTPException(400, f"Label must be one of: {', '.join(LINK_LABELS)}")
        existing = db.query(DocLink).filter(
            DocLink.source_doc_id == doc_id,
            DocLink.target_doc_id == body.target_doc_id,
        ).first()
        if existing:
            if existing.label != body.label:
                existing.label = body.label
                db.commit()
        else:
            db.add(DocLink(
                source_doc_id=doc_id,
                target_doc_id=body.target_doc_id,
                label=body.label,
                created_at=_now(),
            ))
        db.query(Doc).filter(Doc.id == doc_id).update({"updated_at": _now()})
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.delete("/{doc_id}/links/{target_id}", status_code=204)
def remove_link(doc_id: str, target_id: str, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        link = db.query(DocLink).filter(
            DocLink.source_doc_id == doc_id,
            DocLink.target_doc_id == target_id,
        ).first()
        if not link:
            raise HTTPException(404, "Link not found")
        db.delete(link)
        db.query(Doc).filter(Doc.id == doc_id).update({"updated_at": _now()})
        db.commit()
    finally:
        db.close()


@router.get("/{doc_id}/links", response_model=List[DocLinkResponse])
def get_doc_links(doc_id: str, user: dict = Depends(require_user)):
    """Return outgoing links from this doc with their labels."""
    db = _get_db(user)
    try:
        links = db.query(DocLink).filter(DocLink.source_doc_id == doc_id).all()
        return [DocLinkResponse(
            source_doc_id=l.source_doc_id,
            target_doc_id=l.target_doc_id,
            label=l.label,
            created_at=l.created_at,
        ) for l in links]
    finally:
        db.close()


@router.get("/{doc_id}/backlinks", response_model=List[DocResponse])
def get_backlinks(doc_id: str, user: dict = Depends(require_user)):
    """Return all docs that link TO this doc (reverse links)."""
    db = _get_db(user)
    try:
        links  = db.query(DocLink).filter(DocLink.target_doc_id == doc_id).all()
        ids    = [l.source_doc_id for l in links]
        docs   = db.query(Doc).filter(Doc.id.in_(ids)).all()
        return [DocResponse.from_doc(d) for d in docs]
    finally:
        db.close()


@router.get("/{doc_id}/linked", response_model=List[DocResponse])
def get_linked(doc_id: str, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        links = db.query(DocLink).filter(DocLink.source_doc_id == doc_id).all()
        ids   = [l.target_doc_id for l in links]
        docs  = db.query(Doc).filter(Doc.id.in_(ids)).all()
        return [DocResponse.from_doc(d) for d in docs]
    finally:
        db.close()
