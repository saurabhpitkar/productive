"""
Productive MCP Server

Exposes the knowledge graph as MCP tools so Claude Desktop, Claude.ai, and
any MCP-compatible client can read and write docs natively.

Transport:
  STDIO  - Claude Desktop via `docker exec -i`
  SSE    - Claude.ai web / remote clients via Cloudflare Tunnel (default in container)

Config (environment variables):
  PRODUCTIVE_API_URL  base URL of the backend (default: http://backend-v3:8000)
  PRODUCTIVE_PAT      personal access token (pa_…) for auth - generate in Settings → API Access
  MCP_TRANSPORT       "sse" (default) or "stdio"
  MCP_PORT            port for SSE transport (default: 3004)
"""
import argparse
import os
import sys

import httpx
from mcp.server.mcpserver import MCPServer

API_URL   = os.environ.get("PRODUCTIVE_API_URL", "http://backend-v3:8000")
PAT       = os.environ.get("PRODUCTIVE_PAT", "")
TRANSPORT = os.environ.get("MCP_TRANSPORT", "sse")
PORT      = int(os.environ.get("MCP_PORT", "3004"))

mcp = MCPServer("Productive")

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _headers() -> dict:
    return {"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"}


def _client() -> httpx.Client:
    return httpx.Client(base_url=API_URL, headers=_headers(), timeout=30)


def _get(path: str, **params) -> dict | list:
    with _client() as c:
        r = c.get(f"/api/v1{path}", params={k: v for k, v in params.items() if v is not None})
        r.raise_for_status()
        return r.json()


def _post(path: str, body: dict | None = None) -> dict:
    with _client() as c:
        r = c.post(f"/api/v1{path}", json=body or {})
        r.raise_for_status()
        return r.json()


def _patch(path: str, body: dict) -> dict:
    with _client() as c:
        r = c.patch(f"/api/v1{path}", json=body)
        # 202 = HITL review queued - return it transparently
        return r.json()


def _delete(path: str) -> int:
    with _client() as c:
        r = c.delete(f"/api/v1{path}")
        return r.status_code


# ── Doc tools ─────────────────────────────────────────────────────────────────

@mcp.tool()
def list_docs(
    q:       str | None = None,
    status:  str | None = None,
    priority: str | None = None,
    limit:   int = 50,
) -> list[dict]:
    """List docs from the knowledge graph. Supports full-text search (q) and filtering by status/priority."""
    return _get("/docs", q=q, status=status, priority=priority, limit=limit).get("items", [])


@mcp.tool()
def get_doc(doc_id: str) -> dict:
    """Fetch a single doc by ID, including its body, tags, and HITL status."""
    return _get(f"/docs/{doc_id}")


@mcp.tool()
def create_doc(
    name:     str,
    body:     str = "",
    priority: str | None = None,
    status:   str = "todo",
    due_date: str | None = None,
    tags:     dict | None = None,
) -> dict:
    """Create a new doc in the knowledge graph."""
    payload: dict = {"name": name, "body": body, "status": status}
    if priority: payload["priority"] = priority
    if due_date: payload["due_date"] = due_date
    if tags:     payload["tags"] = tags
    return _post("/docs", payload)


@mcp.tool()
def update_doc(
    doc_id:   str,
    name:     str | None = None,
    body:     str | None = None,
    priority: str | None = None,
    status:   str | None = None,
    due_date: str | None = None,
    flag:     bool | None = None,
    tags:     dict | None = None,
) -> dict:
    """
    Update fields on an existing doc. Returns the updated doc, or a 202 object
    if the doc requires HITL review (hitl_required=true and this token is untrusted).
    """
    payload = {}
    if name     is not None: payload["name"]     = name
    if body     is not None: payload["body"]     = body
    if priority is not None: payload["priority"] = priority
    if status   is not None: payload["status"]   = status
    if due_date is not None: payload["due_date"] = due_date
    if flag     is not None: payload["flag"]     = flag
    if tags     is not None: payload["tags"]     = tags
    return _patch(f"/docs/{doc_id}", payload)


@mcp.tool()
def delete_doc(doc_id: str) -> dict:
    """Permanently delete a doc and all its links."""
    code = _delete(f"/docs/{doc_id}")
    return {"deleted": True, "status_code": code}


# ── Link tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def get_doc_links(doc_id: str) -> list[dict]:
    """Return all outgoing links from a doc (label: up / requires / related_to)."""
    return _get(f"/docs/{doc_id}/links")


@mcp.tool()
def get_backlinks(doc_id: str) -> list[dict]:
    """Return all docs that link TO this doc (reverse links)."""
    return _get(f"/docs/{doc_id}/backlinks")


@mcp.tool()
def add_link(source_doc_id: str, target_doc_id: str, label: str = "related_to") -> dict:
    """
    Add a directional link between two docs.
    label must be one of: up, requires, related_to
    """
    return _post(f"/docs/{source_doc_id}/links", {"target_doc_id": target_doc_id, "label": label})


@mcp.tool()
def remove_link(source_doc_id: str, target_doc_id: str) -> dict:
    """Remove a link between two docs."""
    code = _delete(f"/docs/{source_doc_id}/links/{target_doc_id}")
    return {"removed": True, "status_code": code}


# ── HITL tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def list_hitl_reviews(
    outcome:      str | None = None,
    doc_id:       str | None = None,
    submitted_by: str | None = None,
) -> list[dict]:
    """
    List HITL reviews. By default returns pending reviews only.
    Pass outcome='all' for all, or outcome='approved'/'rejected'/'cancelled' to filter.
    Requires a trusted token to resolve reviews.
    """
    return _get("/hitl/reviews", outcome=outcome, doc_id=doc_id, submitted_by=submitted_by)


@mcp.tool()
def get_hitl_review(review_id: str) -> dict:
    """Fetch a single HITL review including the current state of the doc."""
    return _get(f"/hitl/reviews/{review_id}")


@mcp.tool()
def resolve_hitl_review(
    review_id:   str,
    outcome:     str,
    human_notes: str | None = None,
) -> dict:
    """
    Resolve a HITL review. outcome must be one of: approved, rejected, cancelled.
    Requires a trusted PAT or browser session. Untrusted PATs will receive a 403.
    """
    body: dict = {"outcome": outcome}
    if human_notes:
        body["human_notes"] = human_notes
    return _post(f"/hitl/reviews/{review_id}/resolve", body)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Productive MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default=TRANSPORT,
        help="Transport mode: stdio (Claude Desktop) or sse (remote/web)",
    )
    parser.add_argument("--port", type=int, default=PORT, help="Port for SSE transport")
    args, _ = parser.parse_known_args()

    if not PAT:
        print("ERROR: PRODUCTIVE_PAT is not set. Generate a PAT in Settings → API Access.", file=sys.stderr)
        sys.exit(1)

    if args.transport == "stdio":
        mcp.run(transport="stdio")
    else:
        mcp.run(transport="sse", host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
