from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ..auth import require_user
from ..database import get_session_factory, ensure_schema
from ..models import Doc, List as ListModel, DeletionLog, Base
from ..schemas import DeltaSyncResponse, DocResponse, ListResponse
from .lists import _to_response as list_to_response

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/delta", response_model=DeltaSyncResponse)
def delta_sync(
    since: Optional[str] = Query(None),
    user: dict = Depends(require_user),
):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    db = SessionLocal()
    try:
        doc_q  = db.query(Doc)
        list_q = db.query(ListModel)
        if since:
            doc_q  = doc_q.filter(Doc.updated_at > since)
            list_q = list_q.filter(ListModel.updated_at > since)
        docs  = doc_q.all()
        lists = list_q.all()

        deleted_doc_ids:  list[str] = []
        deleted_list_ids: list[str] = []
        if since:
            tombstones = db.query(DeletionLog).filter(DeletionLog.deleted_at > since).all()
            deleted_doc_ids  = [t.id for t in tombstones if t.item_type == "doc"]
            deleted_list_ids = [t.id for t in tombstones if t.item_type == "list"]

        return DeltaSyncResponse(
            docs=[DocResponse.from_doc(d) for d in docs],
            lists=[list_to_response(lst, db) for lst in lists],
            deleted_doc_ids=deleted_doc_ids,
            deleted_list_ids=deleted_list_ids,
            synced_at=datetime.now(timezone.utc).isoformat(),
        )
    finally:
        db.close()
