"""
Productive v4 MCP Server

Exposes the OKF knowledge graph as MCP tools for Claude Desktop, Claude.ai,
and any MCP-compatible client.

Transport:
  STDIO  — Claude Desktop via `docker exec -i`
  SSE    — Claude.ai / remote clients via Cloudflare Tunnel (default in container)

Config (environment variables):
  PRODUCTIVE_API_URL  base URL of the backend (default: http://backend-v4:8000)
  PRODUCTIVE_PAT      personal access token (pa_…) — generate in Settings → API Access
  MCP_TRANSPORT       "sse" (default) or "stdio"
  MCP_PORT            port for SSE transport (default: 3006)
"""
import argparse
import os
import sys
import uuid

import httpx
from mcp.server.mcpserver import MCPServer

API_URL   = os.environ.get("PRODUCTIVE_API_URL", "http://backend-v4:8000")
PAT       = os.environ.get("PRODUCTIVE_PAT", "")
TRANSPORT = os.environ.get("MCP_TRANSPORT", "sse")
PORT      = int(os.environ.get("MCP_PORT", "3006"))

mcp = MCPServer("Productive")

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _headers(extra: dict | None = None) -> dict:
    h = {"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def _client(extra_headers: dict | None = None) -> httpx.Client:
    return httpx.Client(base_url=API_URL, headers=_headers(extra_headers), timeout=30)


def _get(path: str, **params) -> dict | list:
    with _client() as c:
        r = c.get(f"/api/v1{path}", params={k: v for k, v in params.items() if v is not None})
        r.raise_for_status()
        return r.json()


def _post(path: str, body: dict | None = None, extra_headers: dict | None = None) -> dict:
    with _client(extra_headers) as c:
        r = c.post(f"/api/v1{path}", json=body or {})
        r.raise_for_status()
        return r.json()


def _patch(path: str, body: dict) -> dict:
    with _client() as c:
        r = c.patch(f"/api/v1{path}", json=body)
        # 202 = HITL review queued — return transparently
        return r.json()


def _delete(path: str) -> int:
    with _client() as c:
        r = c.delete(f"/api/v1{path}")
        return r.status_code


# ── Doc tools ─────────────────────────────────────────────────────────────────

@mcp.tool()
def list_docs(
    q:          str | None = None,
    status:     str | None = None,
    priority:   str | None = None,
    limit:      int = 50,
    summary:    bool = False,
) -> list[dict]:
    """
    List docs from the knowledge graph.
    Supports full-text search (q) and filtering by task_status / priority.
    Pass summary=True for lightweight results (id, title, link_count, task_status only).
    """
    return _get("/docs", q=q, status=status, priority=priority, limit=limit,
                summary="true" if summary else None).get("items", [])


@mcp.tool()
def get_doc(doc_id: str) -> dict:
    """Fetch a single doc by ID including body, OKF metadata, tags, and HITL status."""
    return _get(f"/docs/{doc_id}")


@mcp.tool()
def create_doc(
    name:         str,
    body:         str = "",
    description:  str = "",
    doc_type:     str = "Note",
    task_status:  str = "todo",
    priority:     str | None = None,
    due_date:     str | None = None,
    tags:         dict | None = None,
    writer:       str | None = None,
) -> dict:
    """
    Create a new OKF doc in the knowledge graph.
    doc_type: Note | Plan | Decision | Reference | Metric
    task_status: todo | in_progress | done | cancelled | archived
    writer: OKF actor string (e.g. 'agent:claude-mcp'). Defaults to the PAT identity.
    """
    payload: dict = {
        "name": name,
        "body": body,
        "description": description,
        "doc_type": doc_type,
        "task_status": task_status,
    }
    if priority: payload["priority"] = priority
    if due_date: payload["due_date"] = due_date
    if tags:     payload["tags"] = tags
    if writer:   payload["writer"] = writer
    return _post("/docs", payload)


@mcp.tool()
def update_doc(
    doc_id:       str,
    name:         str | None = None,
    body:         str | None = None,
    description:  str | None = None,
    doc_type:     str | None = None,
    task_status:  str | None = None,
    priority:     str | None = None,
    due_date:     str | None = None,
    flag:         bool | None = None,
    tags:         dict | None = None,
    writer:       str | None = None,
) -> dict:
    """
    Update fields on an existing doc.
    Returns the updated doc, or a 202 object if HITL review is required.
    writer: OKF actor string recorded in the generated.by provenance field.
    """
    payload = {}
    if name        is not None: payload["name"]        = name
    if body        is not None: payload["body"]        = body
    if description is not None: payload["description"] = description
    if doc_type    is not None: payload["doc_type"]    = doc_type
    if task_status is not None: payload["task_status"] = task_status
    if priority    is not None: payload["priority"]    = priority
    if due_date    is not None: payload["due_date"]    = due_date
    if flag        is not None: payload["flag"]        = flag
    if tags        is not None: payload["tags"]        = tags
    if writer      is not None: payload["writer"]      = writer
    return _patch(f"/docs/{doc_id}", payload)


@mcp.tool()
def delete_doc(doc_id: str) -> dict:
    """Permanently delete a doc and remove it from the knowledge graph."""
    code = _delete(f"/docs/{doc_id}")
    return {"deleted": True, "status_code": code}


# ── Link tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def get_doc_links(doc_id: str, label: str | None = None) -> list[dict]:
    """
    Return outgoing links from a doc.
    Optionally filter by label: up | requires | related_to
    """
    return _get(f"/docs/{doc_id}/links", label=label)


@mcp.tool()
def get_backlinks(doc_id: str) -> list[dict]:
    """Return all docs that link TO this doc (reverse links / parents)."""
    return _get(f"/docs/{doc_id}/backlinks")


@mcp.tool()
def add_link(
    source_doc_id: str,
    target_doc_id: str,
    label:         str = "related_to",
    title:         str | None = None,
) -> dict:
    """
    Add a directional typed link between two docs.
    label: up | requires | related_to
    title: optional human-readable description of the relationship.
    """
    body: dict = {"target_doc_id": target_doc_id, "label": label}
    if title: body["title"] = title
    return _post(f"/docs/{source_doc_id}/links", body)


@mcp.tool()
def remove_link(source_doc_id: str, target_doc_id: str) -> dict:
    """Remove a directed link from source to target."""
    code = _delete(f"/docs/{source_doc_id}/links/{target_doc_id}")
    return {"removed": True, "status_code": code}


# ── Traversal tool ────────────────────────────────────────────────────────────

@mcp.tool()
def traverse_subtree(
    doc_id: str,
    depth:  int = 3,
    labels: str | None = None,
) -> dict:
    """
    Return the subgraph reachable from a doc via BFS up to `depth` hops.
    Returns {root_id, depth, nodes[], edges[]} in a single call — no N+1 reads.

    doc_id: UUID of the root doc
    depth:  maximum hop distance (1–10, default 3)
    labels: comma-separated link labels to follow (e.g. 'requires,up').
            Omit to follow all link types.

    Each node includes: id, title, doc_type, description, task_status, lifecycle,
    priority, hitl_required, link_count, body_preview (first 200 chars).
    Each edge includes: source_id, target_id, label.

    Use this to retrieve a project hierarchy (e.g. Japan Trip 2026 and all sub-docs)
    in one call instead of calling get_doc and get_doc_links N times.
    """
    return _get(f"/docs/{doc_id}/subtree", depth=depth, labels=labels)


# ── Batch create tool ─────────────────────────────────────────────────────────

@mcp.tool()
def batch_create_docs(
    docs:            list[dict],
    idempotency_key: str | None = None,
) -> dict:
    """
    Create multiple docs atomically.
    Each doc in `docs` is a CreateDocRequest object:
      {name, body?, description?, doc_type?, task_status?, priority?,
       due_date?, tags?, links?, hitl_required?, writer?}

    idempotency_key: optional key (e.g. a UUID) to make the call idempotent.
      If the same key is sent within 24h, the server returns the cached response
      instead of creating duplicates. Use this when automating multi-doc scaffolding.

    Returns {created: [DocResponse], idempotent_replay: bool}.
    """
    idem_key = idempotency_key or str(uuid.uuid4())
    extra = {"X-Idempotency-Key": idem_key}
    return _post("/docs/batch", {"docs": docs}, extra_headers=extra)


# ── Semantic / context tools ──────────────────────────────────────────────────

@mcp.tool()
def suggest_links(doc_id: str, top_k: int = 5) -> list[dict]:
    """
    Return docs most likely to be linked from the given doc, ranked by combined
    semantic + structural similarity score.

    Returns SimilarDoc[] with fields: id, title, doc_type, description,
    body_preview, semantic_score, structural_score, combined_score, updated_at.

    Use this to discover missing links in the knowledge graph or to propose
    related docs when writing a new doc.
    """
    return _get(f"/docs/{doc_id}/similar", top_k=top_k)


@mcp.tool()
def semantic_search(query: str, top_k: int = 10) -> list[dict]:
    """
    Find docs semantically similar to a free-text query using vector embeddings.
    Results are ranked by cosine similarity (requires an AI API key in Settings).

    Returns SimilarDoc[] sorted by combined_score descending.

    Use this when keyword search misses relevant docs because they use different
    terminology, or when you want to find thematically related content.
    """
    return _post("/docs/search/semantic", {"q": query, "top_k": top_k})


@mcp.tool()
def get_doc_context(doc_id: str) -> dict:
    """
    Return a doc together with its full relational context: forward links,
    backlinks, and sibling docs (docs sharing the same parent).

    Returns DocContext: {doc, forward_links, backlinks, siblings}.
    Each related item is a DocSummary: {id, title, doc_type, description,
    task_status, lifecycle, priority, hitl_required, link_count, body_preview}.

    Use this to understand where a doc sits in the knowledge graph before
    making edits, to avoid breaking existing connections.
    """
    return _get(f"/docs/{doc_id}/context")


@mcp.tool()
def search_sections(query: str, limit: int = 20) -> list[dict]:
    """
    Search doc headings (H1–H6) by keyword. Returns section-level results that
    point directly to the matching heading, not the whole doc.

    Returns SectionSearchResult[]: {doc_id, doc_title, heading, heading_level,
    body_preview, updated_at}.

    Use this when you need a specific section of a doc rather than the whole thing
    — e.g. "taper week" to find the race-prep section of a training plan doc.
    """
    return _get("/docs/search", q=query, mode="section", limit=limit)


# ── Inbox & activity tools ───────────────────────────────────────────────────

@mcp.tool()
def route_note(text: str) -> dict:
    """
    Submit a free-text note to the inbox routing loop.
    The server runs a 6-round Anthropic tool-calling loop to decide where the note
    belongs in the knowledge graph — appending to an existing doc, creating a new one,
    or flagging for human review (HITL).

    Returns a RoutingResult: {inbox_id, status, confidence, target_doc_id,
    target_doc_title, action, reasoning, rounds_used}.

    status values: routed | hitl_pending | failed
    action values: appended | created | hitl_queued | failed
    """
    return _post("/inbox", {"body": text})


@mcp.tool()
def get_activity_log(
    limit: int = 50,
    since: str | None = None,
) -> list[dict]:
    """
    Return recent activity log entries across all docs.

    limit: maximum entries to return (1–200, default 50)
    since: ISO 8601 timestamp — only return entries after this time
           (e.g. '2026-01-15T10:00:00Z')

    Each entry: {id, doc_id, action, actor, before_snapshot, after_snapshot, created_at}
    action values: created | updated | deleted | routed | batch_created
    actor format: human:user | agent:pat-client | agent:inbox-router/v4
    """
    return _get("/activity-log", limit=limit, since=since)


# ── HITL tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def list_hitl_reviews(
    outcome:      str | None = None,
    doc_id:       str | None = None,
    submitted_by: str | None = None,
) -> list[dict]:
    """
    List HITL reviews (pending by default).
    Pass outcome='all' for all reviews, or filter by 'approved' / 'rejected' / 'cancelled'.
    Requires a trusted token to resolve reviews.
    """
    return _get("/hitl/reviews", outcome=outcome, doc_id=doc_id, submitted_by=submitted_by)


@mcp.tool()
def get_hitl_review(review_id: str) -> dict:
    """Fetch a single HITL review including the proposed payload and current doc state."""
    return _get(f"/hitl/reviews/{review_id}")


@mcp.tool()
def resolve_hitl_review(
    review_id:   str,
    outcome:     str,
    human_notes: str | None = None,
) -> dict:
    """
    Resolve a HITL review. outcome: approved | rejected | cancelled.
    Requires a trusted PAT or browser session (untrusted PATs receive 403).
    When approved, the proposed changes are applied to the doc automatically.
    """
    body: dict = {"outcome": outcome}
    if human_notes:
        body["human_notes"] = human_notes
    return _post(f"/hitl/reviews/{review_id}/resolve", body)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Productive v4 MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default=TRANSPORT,
        help="Transport mode: stdio (Claude Desktop) or sse (remote/web)",
    )
    parser.add_argument("--port", type=int, default=PORT, help="Port for SSE transport")
    args, _ = parser.parse_known_args()

    if not PAT:
        print("ERROR: PRODUCTIVE_PAT not set. Generate a PAT in Settings → API Access.", file=sys.stderr)
        sys.exit(1)

    if args.transport == "stdio":
        mcp.run(transport="stdio")
    else:
        mcp.run(transport="sse", host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
