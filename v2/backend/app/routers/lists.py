import uuid
from datetime import datetime, timezone
from typing import List as TList

from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_user
from ..database import get_session_factory, ensure_schema
from ..models import Doc, List as ListModel, DeletionLog, Base
from ..schemas import ListCreate, ListUpdate, ListResponse

router = APIRouter(prefix="/lists", tags=["lists"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_response(lst: ListModel, db) -> ListResponse:
    doc_ids = [d.id for d in db.query(Doc.id).filter(Doc.list_id == lst.id).all()]
    return ListResponse(
        id=lst.id, list_name=lst.list_name,
        doc_ids=doc_ids, doc_count=len(doc_ids),
        created_at=lst.created_at, updated_at=lst.updated_at,
    )


def _get_db(user: dict):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    return get_session_factory(user_id)()


@router.get("", response_model=TList[ListResponse])
def get_lists(user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        lists = db.query(ListModel).order_by(ListModel.list_name).all()
        return [_to_response(lst, db) for lst in lists]
    finally:
        db.close()


@router.post("", response_model=ListResponse, status_code=201)
def create_list(body: ListCreate, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        now = _now()
        lst = ListModel(id=str(uuid.uuid4()), list_name=body.list_name, created_at=now, updated_at=now)
        db.add(lst)
        db.commit()
        db.refresh(lst)
        return _to_response(lst, db)
    finally:
        db.close()


@router.get("/{list_id}", response_model=ListResponse)
def get_list(list_id: str, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        lst = db.query(ListModel).filter(ListModel.id == list_id).first()
        if not lst:
            raise HTTPException(404, "List not found")
        return _to_response(lst, db)
    finally:
        db.close()


@router.patch("/{list_id}", response_model=ListResponse)
def update_list(list_id: str, body: ListUpdate, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        lst = db.query(ListModel).filter(ListModel.id == list_id).first()
        if not lst:
            raise HTTPException(404, "List not found")
        if body.list_name is not None:
            lst.list_name = body.list_name
        lst.updated_at = _now()
        db.commit()
        db.refresh(lst)
        return _to_response(lst, db)
    finally:
        db.close()


@router.delete("/{list_id}", status_code=204)
def delete_list(list_id: str, user: dict = Depends(require_user)):
    db = _get_db(user)
    try:
        lst = db.query(ListModel).filter(ListModel.id == list_id).first()
        if not lst:
            raise HTTPException(404, "List not found")
        db.query(Doc).filter(Doc.list_id == list_id).update({"list_id": None, "updated_at": _now()})
        db.add(DeletionLog(id=list_id, item_type="list", deleted_at=_now()))
        db.delete(lst)
        db.commit()
    finally:
        db.close()
