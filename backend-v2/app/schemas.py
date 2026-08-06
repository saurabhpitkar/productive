import re
import json
from typing import Optional, Literal, List
from pydantic import BaseModel, Field, field_validator, ConfigDict


def _check_date(v: Optional[str]) -> Optional[str]:
    if v is not None and not (
        re.match(r"^\d{4}-\d{2}-\d{2}$", v) or  # ISO YYYY-MM-DD (current format)
        re.match(r"^\d{2}-\d{2}-\d{4}$", v)      # legacy MM-DD-YYYY
    ):
        raise ValueError("must be YYYY-MM-DD")
    return v

def _check_time(v: Optional[str]) -> Optional[str]:
    if v is not None and not re.match(r"^\d{2}:\d{2}$", v):
        raise ValueError("must be HH:MM")
    return v

def _extract_outline(body: str) -> str:
    headings = []
    for line in (body or "").split("\n"):
        m = re.match(r"^(#{1,6})\s+(.+)", line)
        if m:
            headings.append({"level": len(m.group(1)), "text": m.group(2).strip()})
    return json.dumps(headings, ensure_ascii=False)


# ── Doc ───────────────────────────────────────────────────────────────────────

class DocCreate(BaseModel):
    id:         Optional[str] = None   # client-provided UUID (honoured to prevent duplicates)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    name:       str
    body:       str = ""
    due_date:   Optional[str] = None
    due_time:   Optional[str] = None
    flag:       Optional[bool] = None
    list_id:    Optional[str] = None
    priority:   Optional[Literal["high", "medium", "low"]] = None
    status:     Literal["todo", "in_progress", "done", "cancelled", "archived"] = "todo"
    tags:       dict[str, str] = Field(default_factory=dict)

    @field_validator("due_date")
    @classmethod
    def v_date(cls, v): return _check_date(v)

    @field_validator("due_time")
    @classmethod
    def v_time(cls, v): return _check_time(v)


class DocUpdate(BaseModel):
    name:          Optional[str] = None
    body:          Optional[str] = None
    due_date:      Optional[str] = None
    due_time:      Optional[str] = None
    flag:          Optional[bool] = None
    list_id:       Optional[str] = None
    priority:      Optional[Literal["high", "medium", "low"]] = None
    status:        Optional[Literal["todo", "in_progress", "done", "cancelled", "archived"]] = None
    tags:          Optional[dict[str, str]] = None
    hitl_required: Optional[bool] = None   # PAT callers are blocked from setting this

    @field_validator("due_date")
    @classmethod
    def v_date(cls, v): return _check_date(v)

    @field_validator("due_time")
    @classmethod
    def v_time(cls, v): return _check_time(v)


class DocResponse(BaseModel):
    id:             str
    name:           str
    body:           str
    note_outline:   str
    due_date:       Optional[str]
    due_time:       Optional[str]
    flag:           Optional[bool]
    list_id:        Optional[str]
    priority:       Optional[str]
    status:         str
    tags:           dict
    linked_doc_ids: List[str]
    embedding:      Optional[str] = None
    hitl_required:  bool = False
    hitl_status:    Optional[str] = None
    created_at:     str
    updated_at:     str

    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_doc(cls, doc) -> "DocResponse":
        return cls(
            id=doc.id, name=doc.name, body=doc.body,
            note_outline=doc.note_outline or "[]",
            due_date=doc.due_date, due_time=doc.due_time, flag=doc.flag,
            list_id=doc.list_id, priority=doc.priority, status=doc.status,
            tags=doc.tags or {},
            linked_doc_ids=[lnk.target_doc_id for lnk in (doc.outgoing_links or [])],
            embedding=doc.embedding,
            hitl_required=getattr(doc, "hitl_required", None) or False,
            hitl_status=getattr(doc, "hitl_status", None),
            created_at=doc.created_at, updated_at=doc.updated_at,
        )


class PaginatedDocs(BaseModel):
    items:  List[DocResponse]
    total:  int
    limit:  int
    offset: int


# ── List ──────────────────────────────────────────────────────────────────────

class ListCreate(BaseModel):
    list_name: str

class ListUpdate(BaseModel):
    list_name: Optional[str] = None

class ListResponse(BaseModel):
    id:         str
    list_name:  str
    doc_ids:    List[str]
    doc_count:  int
    created_at: str
    updated_at: str


# ── Links ─────────────────────────────────────────────────────────────────────

class LinkCreate(BaseModel):
    target_doc_id: str
    label: str = "related_to"   # up | requires | related_to


class LinkResponse(BaseModel):
    target_doc_id: str
    label:         str
    created_at:    str


# ── HITL ──────────────────────────────────────────────────────────────────────

class HitlReviewResponse(BaseModel):
    id:               str
    doc_id:           str
    doc_name:         str
    proposed_payload: dict
    agent_pat_prefix: Optional[str]
    outcome:          Optional[str]
    human_notes:      Optional[str]
    created_at:       str
    resolved_at:      Optional[str]
    doc_current:      Optional[DocResponse] = None


# ── Sync ──────────────────────────────────────────────────────────────────────

class DeltaSyncResponse(BaseModel):
    docs:      List[DocResponse]
    lists:     List[ListResponse]
    synced_at: str
