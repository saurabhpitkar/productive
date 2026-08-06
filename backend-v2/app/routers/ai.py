"""
AI assistant proxy and context/settings management.

Supported providers:
  - Claude (claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-5, claude-sonnet-4-6 etc.)
  - Gemini (gemini-2.0-flash, gemini-2.0-flash-lite, gemini-1.5-flash)

The user's API key is stored encrypted at rest. This endpoint decrypts it
server-side and forwards the request to the provider - the key never leaves
the server after initial storage.
"""
import json
import uuid
from datetime import datetime, timezone, date
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import or_

from ..auth import require_user
from ..crypto import encrypt_key, decrypt_key, mask_key
from ..database import get_session_factory, ensure_schema
from ..models import AiContext, UserSettings, Doc, DocLink, AiUsage, HitlReview, Base
from ..models import List as ListModel
from ..schemas import _extract_outline

router = APIRouter(prefix="/ai", tags=["ai"])


CLAUDE_MODELS = [
    {"id": "claude-sonnet-4-6",        "label": "Claude Sonnet 4.6 (Latest)",  "provider": "claude"},
    {"id": "claude-sonnet-4-5",        "label": "Claude Sonnet 4.5",            "provider": "claude"},
    {"id": "claude-haiku-4-5-20251001","label": "Claude Haiku 4.5 (Fast)",      "provider": "claude"},
    {"id": "claude-opus-4-5",          "label": "Claude Opus 4.5 (Powerful)",   "provider": "claude"},
]
GEMINI_MODELS = [
    {"id": "gemini-2.0-flash",         "label": "Gemini 2.0 Flash (Latest)",    "provider": "gemini"},
    {"id": "gemini-2.0-flash-lite",    "label": "Gemini 2.0 Flash Lite (Fast)", "provider": "gemini"},
    {"id": "gemini-1.5-flash",         "label": "Gemini 1.5 Flash",             "provider": "gemini"},
]
ALL_MODELS = CLAUDE_MODELS + GEMINI_MODELS


# ── Workspace tools (no delete exposed) ──────────────────────────────────────

WORKSPACE_TOOLS = [
    {
        "name": "create_doc",
        "description": (
            "Create a new doc in the user's Productive workspace. "
            "Use this when the user asks to create a note, task, meeting record, or any document. "
            "Always populate as many fields as the user specified."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name":     {"type": "string",  "description": "Title of the doc"},
                "body":     {"type": "string",  "description": "Markdown body content"},
                "due_date": {"type": "string",  "description": "Due date YYYY-MM-DD"},
                "due_time": {"type": "string",  "description": "Due time HH:MM (24h, e.g. 09:00)"},
                "priority": {"type": "string",  "enum": ["high", "medium", "low"]},
                "status":   {"type": "string",  "enum": ["todo", "in_progress", "done", "cancelled", "archived"]},
                "flag":     {"type": "boolean", "description": "Flag/star this doc"},
                "list_id": {
                    "type": "string",
                    "description": (
                        "ID of the list to assign this doc to. "
                        "Call get_lists first to find existing list IDs, or create_list to make a new one."
                    ),
                },
                "links": {
                    "type": "array",
                    "description": (
                        "Docs to link from this doc. "
                        "Label 'up' = this doc is a child/sub-topic of the target (use when user says 'child', 'sub-doc', 'under', 'part of'). "
                        "Label 'requires' = this doc depends on/is blocked by the target (use when user says 'depends on', 'after', 'needs', 'predecessor', 'prerequisite'). "
                        "Label 'related_to' = lateral/general connection (default)."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "target_doc_id": {"type": "string", "description": "Doc ID to link to"},
                            "label": {"type": "string", "enum": ["up", "requires", "related_to"],
                                      "description": "Default: related_to"},
                        },
                        "required": ["target_doc_id"],
                    },
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "update_doc",
        "description": (
            "Update fields on an existing doc. "
            "Use list_docs to find the doc ID first if you don't already have it. "
            "Supports adding links to other docs with inferred labels."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "doc_id":   {"type": "string",  "description": "ID of the doc to update"},
                "name":     {"type": "string"},
                "body":     {"type": "string"},
                "due_date": {"type": "string",  "description": "YYYY-MM-DD"},
                "due_time": {"type": "string",  "description": "HH:MM"},
                "priority": {"type": "string",  "enum": ["high", "medium", "low"]},
                "status":   {"type": "string",  "enum": ["todo", "in_progress", "done", "cancelled", "archived"]},
                "flag":          {"type": "boolean"},
                "hitl_required": {
                    "type": "boolean",
                    "description": (
                        "When true, any future writes to this doc by external API agents "
                        "will be held for human review instead of applied immediately. "
                        "Set to true to protect important docs from unreviewed agent changes."
                    ),
                },
                "list_id": {
                    "type": "string",
                    "description": (
                        "ID of the list to assign this doc to. "
                        "Call get_lists first to find existing list IDs, or create_list to make a new one. "
                        "Pass an empty string to remove the doc from its current list."
                    ),
                },
                "links": {
                    "type": "array",
                    "description": (
                        "Docs to link from this doc (upserts - existing links with same target are updated). "
                        "Label 'up' = this doc is a child/sub-topic of the target (user says 'child', 'sub-doc', 'under', 'part of'). "
                        "Label 'requires' = this doc depends on the target (user says 'depends on', 'after', 'needs', 'predecessor', 'prerequisite'). "
                        "Label 'related_to' = lateral connection (default)."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "target_doc_id": {"type": "string", "description": "Doc ID to link to"},
                            "label": {"type": "string", "enum": ["up", "requires", "related_to"],
                                      "description": "Default: related_to"},
                        },
                        "required": ["target_doc_id"],
                    },
                },
            },
            "required": ["doc_id"],
        },
    },
    {
        "name": "list_docs",
        "description": "Search or list docs in the workspace. Use this to find docs by name or content before updating them.",
        "input_schema": {
            "type": "object",
            "properties": {
                "q":        {"type": "string",  "description": "Text search across name and body"},
                "status":   {"type": "string",  "description": "Comma-separated status filter"},
                "priority": {"type": "string",  "description": "Comma-separated priority filter"},
                "list_id":  {"type": "string",  "description": "Filter to docs in this list only"},
                "limit":    {"type": "integer", "description": "Max results, default 10"},
            },
        },
    },
    {
        "name": "get_lists",
        "description": (
            "Return all lists in the workspace with their IDs and names. "
            "Always call this before using list_id in create_doc or update_doc - "
            "you need the exact list ID, not the name."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "create_list",
        "description": "Create a new list with the given name. Returns the new list ID to use in create_doc or update_doc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "list_name": {"type": "string", "description": "Name for the new list"},
            },
            "required": ["list_name"],
        },
    },
    {
        "name": "get_doc",
        "description": (
            "Get full details of a single doc by its ID, including the complete body text "
            "and its outgoing link relationships (with labels and linked doc names)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "doc_id": {"type": "string"},
            },
            "required": ["doc_id"],
        },
    },
    {
        "name": "get_linked_docs",
        "description": (
            "Traverse the link graph from a starting doc and return all reachable docs "
            "up to `depth` hops away, with their status, priority, and link relationships. "
            "Use this to analyse dependencies, find prerequisites, or understand which tasks "
            "must be completed before others. "
            "Link labels: 'requires' means the source doc depends on the target (target must be done first); "
            "'up' means the source is a child/sub-topic of the target; "
            "'related_to' is a lateral connection. "
            "depth=1 returns direct links only; depth=2 includes links-of-links; depth=3 goes three hops out."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "doc_id": {"type": "string", "description": "Starting doc ID"},
                "depth":  {"type": "integer", "description": "Hops to traverse (1–3, default 2)"},
            },
            "required": ["doc_id"],
        },
    },
]


def _execute_tool(
    tool_name: str,
    tool_input: dict,
    user_id: str,
    auth_method: str = "cookie",
    pat_prefix: str | None = None,
    pat_trusted: bool = False,
) -> str:
    """Execute a workspace tool and return a JSON string result."""
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    ts = datetime.now(timezone.utc).isoformat()

    if tool_name == "create_doc":
        doc_id = str(uuid.uuid4())
        with SessionLocal() as db:
            doc = Doc(
                id=doc_id,
                name=tool_input["name"],
                body=tool_input.get("body", ""),
                note_outline=_extract_outline(tool_input.get("body", "")),
                due_date=tool_input.get("due_date"),
                due_time=tool_input.get("due_time"),
                priority=tool_input.get("priority"),
                status=tool_input.get("status", "todo"),
                flag=tool_input.get("flag"),
                list_id=tool_input.get("list_id") or None,
                tags={},
                created_at=ts,
                updated_at=ts,
            )
            db.add(doc)
            for link_info in (tool_input.get("links") or []):
                target_id = link_info.get("target_doc_id")
                label = link_info.get("label", "related_to")
                if target_id and label in ("up", "requires", "related_to"):
                    db.add(DocLink(
                        source_doc_id=doc_id,
                        target_doc_id=target_id,
                        label=label,
                        created_at=ts,
                    ))
            db.commit()
            links_added = len([l for l in (tool_input.get("links") or []) if l.get("target_doc_id")])
            return json.dumps({"ok": True, "doc_id": doc.id, "name": doc.name, "links_added": links_added})

    if tool_name == "update_doc":
        doc_id = tool_input.get("doc_id")
        with SessionLocal() as db:
            doc = db.query(Doc).filter(Doc.id == doc_id).first()
            if not doc:
                return json.dumps({"error": f"Doc {doc_id} not found"})

            # PAT callers may not change hitl_required via AI tool loop
            if auth_method == "pat" and "hitl_required" in tool_input:
                return json.dumps({"error": "API tokens cannot modify hitl_required"})

            # HITL gate: intercept untrusted PAT writes to protected docs
            if doc.hitl_required and auth_method == "pat" and not pat_trusted:
                if doc.hitl_status == "pending":
                    return json.dumps({"error": f"Doc {doc_id} already has a pending review - cannot queue another"})
                payload = {k: v for k, v in tool_input.items() if k not in ("doc_id", "hitl_required", "links")}
                review = HitlReview(
                    id=str(uuid.uuid4()),
                    doc_id=doc_id,
                    proposed_payload=json.dumps(payload),
                    agent_pat_prefix=pat_prefix,
                    outcome=None,
                    created_at=ts,
                    resolved_at=None,
                )
                db.add(review)
                doc.hitl_status = "pending"
                db.commit()
                return json.dumps({
                    "review_id": review.id,
                    "status": "pending_review",
                    "message": f"Doc '{doc.name}' is HITL-protected. Changes queued for human review.",
                })

            for field in ("name", "body", "due_date", "due_time", "priority", "status", "flag", "hitl_required"):
                if field in tool_input:
                    setattr(doc, field, tool_input[field])
            if "list_id" in tool_input:
                doc.list_id = tool_input["list_id"] or None
            if "body" in tool_input:
                doc.note_outline = _extract_outline(doc.body or "")
            doc.updated_at = ts
            for link_info in (tool_input.get("links") or []):
                target_id = link_info.get("target_doc_id")
                label = link_info.get("label", "related_to")
                if target_id and label in ("up", "requires", "related_to"):
                    existing = db.query(DocLink).filter(
                        DocLink.source_doc_id == doc_id,
                        DocLink.target_doc_id == target_id,
                    ).first()
                    if existing:
                        existing.label = label
                    else:
                        db.add(DocLink(
                            source_doc_id=doc_id,
                            target_doc_id=target_id,
                            label=label,
                            created_at=ts,
                        ))
            db.commit()
            links_added = len([l for l in (tool_input.get("links") or []) if l.get("target_doc_id")])
            return json.dumps({"ok": True, "doc_id": doc_id, "name": doc.name, "links_added": links_added})

    if tool_name == "list_docs":
        with SessionLocal() as db:
            q = db.query(Doc).filter(Doc.status != "archived")
            if tool_input.get("q"):
                pat = f"%{tool_input['q']}%"
                q = q.filter(or_(Doc.name.ilike(pat), Doc.body.ilike(pat)))
            if tool_input.get("status"):
                q = q.filter(Doc.status.in_([s.strip() for s in tool_input["status"].split(",")]))
            if tool_input.get("priority"):
                q = q.filter(Doc.priority.in_([p.strip() for p in tool_input["priority"].split(",")]))
            if tool_input.get("list_id"):
                q = q.filter(Doc.list_id == tool_input["list_id"])
            limit = min(int(tool_input.get("limit", 10)), 50)
            docs  = q.order_by(Doc.updated_at.desc()).limit(limit).all()
            list_ids = {d.list_id for d in docs if d.list_id}
            lists_map: dict[str, str] = {}
            if list_ids:
                for lst in db.query(ListModel).filter(ListModel.id.in_(list_ids)).all():
                    lists_map[lst.id] = lst.list_name
            return json.dumps([
                {"id": d.id, "name": d.name, "status": d.status,
                 "priority": d.priority, "due_date": d.due_date, "due_time": d.due_time,
                 "list_id": d.list_id, "list_name": lists_map.get(d.list_id) if d.list_id else None}
                for d in docs
            ])

    if tool_name == "get_doc":
        with SessionLocal() as db:
            doc = db.query(Doc).filter(Doc.id == tool_input.get("doc_id")).first()
            if not doc:
                return json.dumps({"error": "Doc not found"})
            links = []
            for lnk in db.query(DocLink).filter(DocLink.source_doc_id == doc.id).all():
                target = db.query(Doc).filter(Doc.id == lnk.target_doc_id).first()
                links.append({
                    "target_doc_id": lnk.target_doc_id,
                    "target_name": target.name if target else "Unknown",
                    "label": lnk.label,
                })
            lst = db.query(ListModel).filter(ListModel.id == doc.list_id).first() if doc.list_id else None
            return json.dumps({
                "id": doc.id, "name": doc.name, "body": doc.body,
                "status": doc.status, "priority": doc.priority,
                "due_date": doc.due_date, "due_time": doc.due_time,
                "flag": doc.flag, "updated_at": doc.updated_at,
                "list_id": doc.list_id, "list_name": lst.list_name if lst else None,
                "links": links,
            })

    if tool_name == "get_lists":
        with SessionLocal() as db:
            lists = db.query(ListModel).order_by(ListModel.list_name).all()
            return json.dumps([
                {"id": lst.id, "list_name": lst.list_name,
                 "doc_count": db.query(Doc).filter(Doc.list_id == lst.id).count()}
                for lst in lists
            ])

    if tool_name == "create_list":
        list_name = (tool_input.get("list_name") or "").strip()
        if not list_name:
            return json.dumps({"error": "list_name is required"})
        with SessionLocal() as db:
            lst = ListModel(id=str(uuid.uuid4()), list_name=list_name, created_at=ts, updated_at=ts)
            db.add(lst)
            db.commit()
            return json.dumps({"ok": True, "list_id": lst.id, "list_name": lst.list_name})

    if tool_name == "get_linked_docs":
        root_id   = tool_input.get("doc_id")
        max_depth = min(int(tool_input.get("depth", 2)), 3)
        with SessionLocal() as db:
            docs_map:   dict[str, dict] = {}
            edges:      list[dict]      = []
            seen_edges: set[tuple]      = set()
            queue = [(root_id, 0)]
            seen_ids: set[str] = set()

            while queue:
                doc_id, hop = queue.pop(0)
                if doc_id in seen_ids:
                    continue
                seen_ids.add(doc_id)
                doc = db.query(Doc).filter(Doc.id == doc_id).first()
                if not doc:
                    continue
                docs_map[doc_id] = {
                    "id": doc.id, "name": doc.name, "status": doc.status,
                    "priority": doc.priority, "due_date": doc.due_date,
                    "flag": doc.flag,
                    "body_snippet": (doc.body or "")[:300],
                }
                if hop < max_depth:
                    for lnk in db.query(DocLink).filter(DocLink.source_doc_id == doc_id).all():
                        key = (doc_id, lnk.target_doc_id)
                        if key not in seen_edges:
                            seen_edges.add(key)
                            tgt = db.query(Doc).filter(Doc.id == lnk.target_doc_id).first()
                            edges.append({
                                "from_id": doc_id, "from_name": doc.name,
                                "to_id": lnk.target_doc_id,
                                "to_name": tgt.name if tgt else lnk.target_doc_id,
                                "label": lnk.label,
                            })
                        if lnk.target_doc_id not in seen_ids:
                            queue.append((lnk.target_doc_id, hop + 1))
                    for lnk in db.query(DocLink).filter(DocLink.target_doc_id == doc_id).all():
                        key = (lnk.source_doc_id, doc_id)
                        if key not in seen_edges:
                            seen_edges.add(key)
                            src = db.query(Doc).filter(Doc.id == lnk.source_doc_id).first()
                            edges.append({
                                "from_id": lnk.source_doc_id,
                                "from_name": src.name if src else lnk.source_doc_id,
                                "to_id": doc_id, "to_name": doc.name,
                                "label": lnk.label,
                            })
                        if lnk.source_doc_id not in seen_ids:
                            queue.append((lnk.source_doc_id, hop + 1))

            return json.dumps({
                "root_doc_id": root_id,
                "docs": list(docs_map.values()),
                "edges": edges,
            })

    return json.dumps({"error": f"Unknown tool: {tool_name}"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log_usage(user_id: str, provider: str, model: str, input_tokens: int, output_tokens: int) -> None:
    try:
        ensure_schema(user_id, Base)
        SessionLocal = get_session_factory(user_id)
        with SessionLocal() as db:
            db.add(AiUsage(
                id            = str(uuid.uuid4()),
                created_at    = _now(),
                provider      = provider,
                model         = model,
                input_tokens  = input_tokens,
                output_tokens = output_tokens,
                total_tokens  = input_tokens + output_tokens,
            ))
            db.commit()
    except Exception:
        pass  # Never let usage logging crash a chat response


def _get_settings(user_id: str) -> UserSettings:
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        row = db.query(UserSettings).filter(UserSettings.id == "singleton").first()
        if not row:
            row = UserSettings(id="singleton", updated_at=_now())
            db.add(row)
            db.commit()
            db.refresh(row)
        # Detach from session so we can return the object
        db.expunge(row)
        return row


# ── Models endpoint ──────────────────────────────────────────────────────────

@router.get("/models")
def list_models():
    return ALL_MODELS


# ── Settings ─────────────────────────────────────────────────────────────────

class SettingsRead(BaseModel):
    provider:         Optional[str] = None
    model:            Optional[str] = None
    api_key_masked:   Optional[str] = None   # redacted - never full key
    api_key_set:      bool = False
    prompt_limit:     int  = 10000
    context_enabled:  bool = True
    display_name:     Optional[str] = None
    avatar_url:       Optional[str] = None
    google_email:     Optional[str] = None


class SettingsUpdate(BaseModel):
    provider:        Optional[str] = None
    model:           Optional[str] = None
    api_key:         Optional[str] = None    # plaintext on the way in; encrypted before storage
    prompt_limit:    Optional[int] = None
    context_enabled: Optional[bool] = None
    display_name:    Optional[str] = None


@router.get("/settings", response_model=SettingsRead)
def get_ai_settings(user: dict = Depends(require_user)):
    row = _get_settings(user["sub"])
    plaintext = decrypt_key(row.ai_api_key_enc) if row.ai_api_key_enc else ""
    return SettingsRead(
        provider=row.ai_provider,
        model=row.ai_model,
        api_key_masked=mask_key(plaintext) if plaintext else None,
        api_key_set=bool(plaintext),
        prompt_limit=row.ai_prompt_limit or 10000,
        context_enabled=row.ai_context_enabled if row.ai_context_enabled is not None else True,
        display_name=row.display_name,
        avatar_url=row.avatar_url,
        google_email=row.google_email,
    )


@router.patch("/settings")
def update_ai_settings(body: SettingsUpdate, user: dict = Depends(require_user)):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        row = db.query(UserSettings).filter(UserSettings.id == "singleton").first()
        if not row:
            row = UserSettings(id="singleton", updated_at=_now())
            db.add(row)

        if body.provider is not None:
            row.ai_provider = body.provider
        if body.model is not None:
            row.ai_model = body.model
        if body.api_key is not None:
            row.ai_api_key_enc = encrypt_key(body.api_key) if body.api_key else None
        if body.prompt_limit is not None:
            row.ai_prompt_limit = max(100, min(50000, body.prompt_limit))
        if body.context_enabled is not None:
            row.ai_context_enabled = body.context_enabled
        if body.display_name is not None:
            row.display_name = body.display_name
        row.updated_at = _now()
        db.commit()
    return {"ok": True}


# ── AI Context blocks ─────────────────────────────────────────────────────────

class ContextBlock(BaseModel):
    key:     str
    content: str


@router.get("/context")
def get_context(user: dict = Depends(require_user)):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        rows = db.query(AiContext).all()
        return [{"key": r.key, "content": r.content, "updated_at": r.updated_at} for r in rows]


@router.put("/context/{key}")
def upsert_context(key: str, body: ContextBlock, user: dict = Depends(require_user)):
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        row = db.query(AiContext).filter(AiContext.key == key).first()
        if row:
            row.content    = body.content
            row.updated_at = _now()
        else:
            db.add(AiContext(key=key, content=body.content, updated_at=_now()))
        db.commit()
    return {"ok": True}


@router.delete("/context/{key}", status_code=204)
def delete_context(key: str, user: dict = Depends(require_user)):
    user_id = user["sub"]
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        row = db.query(AiContext).filter(AiContext.key == key).first()
        if row:
            db.delete(row)
            db.commit()


# ── Token usage ──────────────────────────────────────────────────────────────

@router.get("/usage")
def get_usage(user: dict = Depends(require_user)):
    """Return last 7 days of AI token usage, aggregated by day and model."""
    from datetime import datetime as dt, timedelta
    user_id = user["sub"]
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    cutoff = (dt.utcnow() - timedelta(days=7)).isoformat()

    with SessionLocal() as db:
        rows = db.query(AiUsage).filter(AiUsage.created_at >= cutoff).order_by(AiUsage.created_at).all()
        data = [
            {"date": r.created_at[:10], "provider": r.provider, "model": r.model,
             "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
             "total_tokens": r.total_tokens}
            for r in rows
        ]

    # Aggregate by day
    daily: dict[str, dict] = {}
    by_model: dict[str, dict] = {}
    for r in data:
        day = r["date"]
        if day not in daily:
            daily[day] = {"date": day, "input_tokens": 0, "output_tokens": 0, "calls": 0}
        daily[day]["input_tokens"]  += r["input_tokens"]
        daily[day]["output_tokens"] += r["output_tokens"]
        daily[day]["calls"] += 1

        key = r["model"]
        if key not in by_model:
            by_model[key] = {"model": key, "provider": r["provider"],
                             "input_tokens": 0, "output_tokens": 0, "calls": 0}
        by_model[key]["input_tokens"]  += r["input_tokens"]
        by_model[key]["output_tokens"] += r["output_tokens"]
        by_model[key]["calls"] += 1

    total_input  = sum(d["input_tokens"]  for d in daily.values())
    total_output = sum(d["output_tokens"] for d in daily.values())
    total_calls  = sum(d["calls"]         for d in daily.values())

    return {
        "days":     sorted(daily.values(),    key=lambda x: x["date"]),
        "by_model": sorted(by_model.values(), key=lambda x: -x["calls"]),
        "total_7d": {
            "input_tokens":  total_input,
            "output_tokens": total_output,
            "total_tokens":  total_input + total_output,
            "calls":         total_calls,
        },
    }


# ── Chat proxy ────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role:    str   # 'user' | 'assistant'
    content: str


class ChatRequest(BaseModel):
    messages:       list[ChatMessage]
    system_prompt:  Optional[str] = None
    max_tokens:     int = 2048


@router.post("/chat")
async def chat(body: ChatRequest, user: dict = Depends(require_user)):
    user_id  = user["sub"]
    settings = _get_settings(user_id)

    if not settings.ai_api_key_enc:
        raise HTTPException(402, "No API key configured - add one in Settings → AI Assistant")

    api_key  = decrypt_key(settings.ai_api_key_enc)
    provider = settings.ai_provider or "claude"
    model    = settings.ai_model or "claude-sonnet-4-6"

    # Build system prompt: base instructions + today's date + user context blocks
    today_str = date.today().strftime("%Y-%m-%d (%A)")
    system_parts: list[str] = [
        (
            "You are a helpful AI assistant embedded in Productive, a personal workspace app. "
            "You can create, search, view, and update docs for the user using the tools provided. "
            "A doc has: name (title), body (markdown), due_date (YYYY-MM-DD), due_time (HH:MM), "
            "priority (high/medium/low), status (todo/in_progress/done/cancelled/archived), flag (boolean), "
            "and an optional list assignment (list_id). "
            "Docs are organised into lists (like folders). When the user mentions a list by name, "
            "call get_lists first to find its ID - never guess a list_id. "
            "If the list doesn't exist yet, call create_list to create it, then use the returned list_id. "
            "Docs can be linked with labels: 'up' (this doc is a child/sub-topic of the target - use when user says "
            "'child', 'sub-doc', 'under', 'part of'), 'requires' (this doc depends on the target - use when user says "
            "'depends on', 'after', 'needs', 'predecessor', 'prerequisite'), 'related_to' (lateral, the default). "
            f"Today is {today_str}. Use this to resolve relative dates like 'tomorrow' or 'next Monday'. "
            "When the user asks you to create or update a doc, always use the appropriate tool - do not just describe it. "
            "When the user asks about dependencies, prerequisites, what to do first, or the relationship between tasks, "
            "use get_linked_docs (depth 2 or 3) to traverse the full link graph before answering - "
            "do not guess or infer from names alone. "
            "Link label meanings in get_linked_docs edges: "
            "'requires' = the from_doc depends on the to_doc (to_doc must be done first); "
            "'up' = from_doc is a child/sub-topic of to_doc; "
            "'related_to' = lateral connection. "
            "When referencing a specific doc in your text response (one you created, updated, retrieved, or found), "
            "use the format [[Doc Name|doc-id]] - you always have the doc_id from tool results. "
            "Example: 'I created [[Project Alpha|abc-123]] for you.' These render as clickable links for the user."
        )
    ]
    ensure_schema(user_id, Base)
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        ctx_rows = db.query(AiContext).all()
        for row in ctx_rows:
            if row.content.strip():
                system_parts.append(f"[{row.key}]\n{row.content.strip()}")
    if body.system_prompt:
        system_parts.append(body.system_prompt)
    system = "\n\n".join(system_parts)

    # Enforce user prompt limit on the last user message
    prompt_limit = settings.ai_prompt_limit or 10000
    msgs = [m.model_dump() for m in body.messages]
    if msgs and msgs[-1]["role"] == "user":
        msgs[-1]["content"] = msgs[-1]["content"][:prompt_limit]

    auth_method = user.get("auth_method", "cookie")
    pat_prefix  = user.get("pat_prefix")
    pat_trusted = user.get("pat_trusted", False)
    if provider == "claude":
        return await _call_claude(api_key, model, msgs, system, body.max_tokens, user_id, auth_method, pat_prefix, pat_trusted)
    elif provider == "gemini":
        return await _call_gemini(api_key, model, msgs, system, body.max_tokens, user_id, auth_method, pat_prefix, pat_trusted)
    else:
        raise HTTPException(400, f"Unknown provider: {provider}")


async def _call_claude(
    api_key: str, model: str, messages: list,
    system: str | None, max_tokens: int, user_id: str = "",
    auth_method: str = "cookie", pat_prefix: str | None = None, pat_trusted: bool = False,
):
    msgs = list(messages)  # local copy - we append tool rounds to this
    payload: dict = {
        "model":      model,
        "max_tokens": max_tokens,
        "tools":      WORKSPACE_TOOLS,
        "messages":   msgs,
    }
    if system:
        payload["system"] = system

    tools_used    = False
    affected_docs: list[dict] = []
    headers = {
        "x-api-key":         api_key,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
    }

    for _ in range(8):  # max 8 tool rounds
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=payload,
            )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Claude API error: {resp.text[:200]}")

        data        = resp.json()
        stop_reason = data.get("stop_reason")
        content     = data.get("content", [])

        if stop_reason == "end_turn":
            text  = "".join(b["text"] for b in content if b.get("type") == "text")
            usage = data.get("usage") or {}
            _log_usage(user_id, "claude", model,
                       input_tokens=usage.get("input_tokens", 0),
                       output_tokens=usage.get("output_tokens", 0))
            return {"role": "assistant", "content": text, "usage": usage,
                    "tools_used": tools_used, "affected_docs": affected_docs}

        if stop_reason == "tool_use":
            tools_used = True
            msgs.append({"role": "assistant", "content": content})
            tool_results = []
            for block in content:
                if block.get("type") == "tool_use":
                    result = _execute_tool(block["name"], block.get("input", {}), user_id, auth_method, pat_prefix, pat_trusted)
                    # Collect doc IDs for clickable links in the frontend
                    if block["name"] in ("create_doc", "update_doc", "get_doc"):
                        try:
                            rd       = json.loads(result)
                            doc_id   = rd.get("doc_id") or rd.get("id")
                            doc_name = rd.get("name", "Untitled")
                            if doc_id and not any(d["id"] == doc_id for d in affected_docs):
                                affected_docs.append({"id": doc_id, "name": doc_name})
                        except Exception:
                            pass
                    if block["name"] == "get_linked_docs":
                        try:
                            rd = json.loads(result)
                            for doc in rd.get("docs", []):
                                if doc.get("id") and not any(d["id"] == doc["id"] for d in affected_docs):
                                    affected_docs.append({"id": doc["id"], "name": doc.get("name", "Untitled")})
                        except Exception:
                            pass
                    tool_results.append({
                        "type":        "tool_result",
                        "tool_use_id": block["id"],
                        "content":     result,
                    })
            msgs.append({"role": "user", "content": tool_results})
            payload["messages"] = msgs
            continue

        break

    text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
    return {"role": "assistant", "content": text or "I ran into an issue.", "usage": None,
            "tools_used": tools_used, "affected_docs": affected_docs}


def _claude_tool_to_gemini(tool: dict) -> dict:
    """Convert a Claude-style tool definition to Gemini functionDeclaration."""
    schema = tool["input_schema"].copy()
    schema.pop("type", None)  # Gemini schema omits top-level "type"
    return {"name": tool["name"], "description": tool["description"], "parameters": schema}


async def _call_gemini(
    api_key: str, model: str, messages: list,
    system: str | None, max_tokens: int, user_id: str = "",
    auth_method: str = "cookie", pat_prefix: str | None = None, pat_trusted: bool = False,
):
    contents = []
    if system:
        contents.append({"role": "user",  "parts": [{"text": f"System: {system}"}]})
        contents.append({"role": "model", "parts": [{"text": "Understood."}]})
    for m in messages:
        if isinstance(m.get("content"), str):
            role = "model" if m["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": m["content"]}]})

    gemini_tools  = [{"functionDeclarations": [_claude_tool_to_gemini(t) for t in WORKSPACE_TOOLS]}]
    tools_used    = False
    affected_docs: list[dict] = []

    for _ in range(8):
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
                json={
                    "contents":         contents,
                    "tools":            gemini_tools,
                    "generationConfig": {"maxOutputTokens": max_tokens},
                },
            )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Gemini API error: {resp.text[:200]}")

        data  = resp.json()
        parts = data["candidates"][0]["content"]["parts"]

        fn_calls = [p for p in parts if "functionCall" in p]
        if fn_calls:
            tools_used = True
            contents.append({"role": "model", "parts": parts})
            fn_responses = []
            for p in fn_calls:
                fc     = p["functionCall"]
                result = _execute_tool(fc["name"], fc.get("args", {}), user_id, auth_method, pat_prefix, pat_trusted)
                if fc["name"] in ("create_doc", "update_doc", "get_doc"):
                    try:
                        rd       = json.loads(result)
                        doc_id   = rd.get("doc_id") or rd.get("id")
                        doc_name = rd.get("name", "Untitled")
                        if doc_id and not any(d["id"] == doc_id for d in affected_docs):
                            affected_docs.append({"id": doc_id, "name": doc_name})
                    except Exception:
                        pass
                if fc["name"] == "get_linked_docs":
                    try:
                        rd = json.loads(result)
                        for doc in rd.get("docs", []):
                            if doc.get("id") and not any(d["id"] == doc["id"] for d in affected_docs):
                                affected_docs.append({"id": doc["id"], "name": doc.get("name", "Untitled")})
                    except Exception:
                        pass
                fn_responses.append({
                    "functionResponse": {
                        "name":     fc["name"],
                        "response": {"content": result},
                    }
                })
            contents.append({"role": "user", "parts": fn_responses})
            continue

        text  = "".join(p.get("text", "") for p in parts)
        usage = data.get("usageMetadata") or {}
        _log_usage(user_id, "gemini", model,
                   input_tokens=usage.get("promptTokenCount", 0),
                   output_tokens=usage.get("candidatesTokenCount", 0))
        return {"role": "assistant", "content": text, "usage": usage,
                "tools_used": tools_used, "affected_docs": affected_docs}

    return {"role": "assistant", "content": "I ran into an issue.", "usage": None,
            "tools_used": tools_used, "affected_docs": affected_docs}


# ── Embedding proxy ───────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    texts: list[str]


@router.post("/embed")
async def embed(body: EmbedRequest, user: dict = Depends(require_user)):
    """
    Generate embeddings for a list of texts using the user's configured provider.
    Returns a list of float arrays (one per input text).
    """
    user_id  = user["sub"]
    settings = _get_settings(user_id)

    if not settings.ai_api_key_enc:
        raise HTTPException(402, "No API key configured")

    api_key  = decrypt_key(settings.ai_api_key_enc)
    provider = settings.ai_provider or "claude"

    if provider == "gemini":
        return await _embed_gemini(api_key, body.texts)
    else:
        # Claude doesn't have a standalone embedding API - use Gemini endpoint
        # If provider is Claude but we want embeddings, fall back gracefully
        raise HTTPException(400, "Embeddings require Gemini provider (text-embedding-004)")


async def _embed_gemini(api_key: str, texts: list[str]) -> dict:
    results = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for text in texts:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={api_key}",
                json={"model": "models/text-embedding-004", "content": {"parts": [{"text": text}]}},
            )
            if resp.status_code == 200:
                results.append(resp.json()["embedding"]["values"])
            else:
                results.append([])
    return {"embeddings": results}
