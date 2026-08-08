import os
import uuid
import mimetypes
from datetime import datetime, timezone

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from ..auth import require_user
from ..config import ATTACHMENTS_DIR
from ..database import get_session_factory, ensure_schema
from ..models import Attachment, Base

router = APIRouter(prefix="/attachments", tags=["attachments"])

MAX_FILE_BYTES = 50 * 1024 * 1024   # 50 MB per file


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/{doc_id}")
async def upload(doc_id: str, file: UploadFile = File(...), user: dict = Depends(require_user)):
    user_id = user["sub"]
    data    = await file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "File exceeds 50 MB limit")

    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    att_id   = str(uuid.uuid4())
    rel_path = os.path.join(user_id, doc_id, att_id, file.filename or "file")
    abs_path = os.path.join(ATTACHMENTS_DIR, rel_path)

    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    async with aiofiles.open(abs_path, "wb") as f:
        await f.write(data)

    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        att = Attachment(
            id=att_id, doc_id=doc_id,
            filename=file.filename or "file",
            mime_type=mime,
            size_bytes=len(data),
            file_path=rel_path,
            created_at=_now(),
        )
        db.add(att)
        db.commit()
        db.refresh(att)
        return {
            "id": att.id, "doc_id": att.doc_id,
            "filename": att.filename, "mime_type": att.mime_type,
            "size_bytes": att.size_bytes, "created_at": att.created_at,
        }


@router.get("/{doc_id}")
def list_attachments(doc_id: str, user: dict = Depends(require_user)):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        rows = db.query(Attachment).filter(Attachment.doc_id == doc_id).all()
        return [
            {"id": r.id, "doc_id": r.doc_id, "filename": r.filename,
             "mime_type": r.mime_type, "size_bytes": r.size_bytes, "created_at": r.created_at}
            for r in rows
        ]


@router.get("/file/{attachment_id}")
def download(attachment_id: str, user: dict = Depends(require_user)):
    user_id = user["sub"]
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        att = db.query(Attachment).filter(Attachment.id == attachment_id).first()
        if not att:
            raise HTTPException(404, "Attachment not found")
        abs_path = os.path.join(ATTACHMENTS_DIR, att.file_path)
        if not os.path.exists(abs_path):
            raise HTTPException(404, "File missing from storage")
        return FileResponse(abs_path, media_type=att.mime_type, filename=att.filename)


@router.delete("/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: str, user: dict = Depends(require_user)):
    user_id = user["sub"]
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        att = db.query(Attachment).filter(Attachment.id == attachment_id).first()
        if not att:
            raise HTTPException(404, "Attachment not found")
        abs_path = os.path.join(ATTACHMENTS_DIR, att.file_path)
        try:
            os.remove(abs_path)
        except FileNotFoundError:
            pass
        db.delete(att)
        db.commit()
