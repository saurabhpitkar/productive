# Productive v4

An AI-augmented knowledge graph with human oversight. Made for humans and agents doing capture and retrieval. 

---

## What It Does

- **Knowledge graph** — docs are connected by typed links (`belongs_to`, `requires`, `related_to`). A doc can belong to multiple themes or parent docs; the graph traverses subtrees on demand.
- **Bring your own AI** — used for AI-based capture, knowledge graph maintenance, and semantic embeddings 
- **Capture** — type your thoughts or send notes via AI agent; an AI agent finds the best existing doc to append it to, or creates a new one if nothing fits.
- **Themes** — define high-level topic buckets (e.g. "Career 2026", "Health"); the routing agent uses them as anchors when deciding where ideas live.
- **AI assistant** — chat interface with tool-use: create, update, search, and link docs via natural language.
- **Multi-provider AI** — Claude (Anthropic) or Gemini (Google) for capture; any model on OpenRouter for chat. Switch in Settings; your encrypted key never leaves the server.
- **Offline-first** — the React frontend keeps a full local copy in IndexedDB. Delta sync pulls changes from the server on reconnect.
- **Plain files** — every doc is a markdown file with YAML frontmatter on disk. The graph is git-committed on every write. No database lock-in.
- **MCP server** — expose your knowledge graph to Claude Desktop and Claude.ai as native tools.

---

## Quick Start

### Prerequisites
- Docker + Docker Compose
- A Google Cloud OAuth 2.0 app (for login)
- An AI API key (Claude or Gemini — required for inbox routing and embeddings)

### 1. Clone and configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# Google OAuth (required)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3005/api/v1/auth/callback

# Security (required)
JWT_SECRET_KEY=$(openssl rand -hex 32)
# Either of these generates a valid Fernet key:
FERNET_KEY=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
# FERNET_KEY=$(openssl rand -base64 32 | tr '+/' '-_')

# Access control (optional — empty allows any Google account)
ALLOWED_EMAILS=you@example.com

# Inbox routing confidence gate (optional, default 0.80 based on embedding similarity scores, customizable)
ROUTE_THRESHOLD=0.80
```

### 2. Start

```bash
docker compose up -d
```

App is at `http://localhost:3005`.

### 3. Add your AI API key

Settings → AI → choose provider → paste API key → Save.

| Provider | Where to get a key | Supports embeddings? |
|---|---|---|
| Claude (Anthropic) | console.anthropic.com | No — use Gemini for embeddings |
| Gemini (Google) | aistudio.google.com/apikey | Yes (`text-embedding-004`) |
| OpenRouter | openrouter.ai/keys | Chat only — no embedding endpoint |

> **Note:** Embeddings (used for semantic search, link proposals, and inbox candidate scoring) require a Gemini key regardless of which provider you use for chat.

---

## How the Knowledge Graph Works

### Docs and links

Every doc is a node. Links are typed edges:

| Label | Meaning |
|---|---|
| `belongs_to` | This doc belongs to / rolls up into the target (e.g. "Japan Flights" → `belongs_to` → "Japan Trip 2026") |
| `requires` | This doc depends on the target (e.g. "Japan Trip 2026" → `requires` → "Visa & Admin") |
| `related_to` | Lateral association (e.g. "Japan Trip 2026" → `related_to` → "Finance 2026") |

A doc may have multiple `belongs_to` links (belonging to multiple themes or parent docs). Cross-domain links (travel ↔ finance ↔ career) let the AI answer questions that span topics.

### Themes

Themes are high-level buckets defined in Settings or the sidebar:

```
Sidebar → Themes → +
```

When the inbox routing agent creates or appends a note, it receives your theme list and tags the doc with the best-matching `theme_id` (omitted when no theme fits with ≥50% confidence). Clicking a theme in the sidebar shows all docs under it.

### Capture

The **Capture with AI** is the fastest way to add ideas without deciding where they go:

1. Open Inbox (or use the Capture button in the sidebar)
2. Type or paste anything — a meeting note, a thought, a link
3. The AI agent embeds the text, finds the closest existing docs, and either appends to the best match or creates a new doc
4. The activity log records what was done and where

**`ROUTE_THRESHOLD`** (0.0–1.0): the minimum confidence the routing agent must express before it executes an action. At 0.80 (default), the agent routes or creates only when it's ≥80% confident — lower-confidence cases go to the HITL review queue. Lower values = more auto-actions; higher values = more conservative (more items queued for review).

### Auto-linking

After every doc save, the backend embeds the doc and compares it against all others using cosine similarity. A 3-tier rule decides what happens:

| Similarity | Behavior |
|---|---|
| ≥ auto-link threshold (default 82%) | Auto-apply if "Review before applying" is off, otherwise queue |
| 65% – threshold | Always queued for review |
| < 65% | Ignored |

The threshold is adjustable (65%–95%) via **Settings → AI Usage → Links → Auto-link threshold**.

### Rebuild knowledge graph

Settings → AI Usage → Links → **Rebuild knowledge graph** scans all docs, generates embeddings for any that are missing (up to 50 per run), and applies the same 3-tier logic across all pairs. Run this after bulk-importing docs or if auto-linking seems stale. The result shows `links_auto_applied`, `proposals_queued_for_review`, and `already_pending_review` (your backlog before this run).

---

## AI Assistant

The chat panel (bottom-right) has access to these tools:

| Tool | Description |
|---|---|
| `list_docs` | Search docs by keyword |
| `get_doc` | Read a doc's full content |
| `create_doc` | Create a new doc |
| `update_doc` | Edit an existing doc |
| `delete_doc` | Delete a doc permanently |
| `get_linked_docs` | Traverse outgoing links |
| `get_lists` | List all named lists |
| `create_list` | Create a new list |

Docs referenced in responses are clickable — they open in the inline doc panel.

---

## Settings Reference

Settings has two tabs: **Account** and **AI Usage**.

### Account tab

**Profile** — Your Google/GitHub display name and avatar. Sign-out button.

**API Access** — Personal access tokens for external agents and scripts.

**Sync & Auto-save** — Auto-save delay; polling interval (every 3 min or 30 min).

**Storage** — Shows whether docs are in a Docker volume or a local folder. Set `HOST_DOCS_DIR` in `.env` to point to a folder of markdown files. Import .md files directly from a local folder.

### AI Usage tab

**AI Assistant**

| Field | Description |
|---|---|
| Provider | `claude`, `gemini`, or `openrouter`. Determines inbox routing + embedding provider. |
| Model | The chat/routing model. Use `gemini-2.5-flash` or `claude-sonnet-4-5` for best results. |
| API Key | Encrypted at rest. Never returned to the browser in plaintext. |
| Voyage API Key | Required for embeddings when using Claude or OpenRouter (no built-in embedding endpoint). |
| Persona | Extra instructions injected into every AI chat system prompt. |
| Guardrails | Content constraints added to every AI chat call. |

**Links**

| Field | Description |
|---|---|
| Enable auto-linking | Master toggle: generates embeddings and link proposals after every save. |
| Link on capture | Run link analysis after inbox routing creates/appends a doc. |
| Link on chat | Run link analysis after the AI assistant creates or updates a doc. |
| Require review | When on, proposals queue on the Reviews page. When off, links above the threshold are applied automatically. |
| Auto-link threshold | Similarity score (65%–95%, default 82%) above which links auto-apply or queue. Pairs between 65% and this threshold always queue regardless of the Require review setting. |

All auto-discovered links use the `related_to` label. Vector similarity can only detect topical overlap — hierarchical labels (`belongs_to`, `requires`) need human judgment and can be set manually.

**Rebuild knowledge graph** — Scans all docs, generates missing embeddings (up to 50), and applies the 3-tier threshold logic across all pairs. The result shows links auto-applied, proposals queued for review, and your existing backlog count. Run this after bulk imports or if the link graph seems stale.

---

## MCP Server (Claude Desktop / Claude.ai)

The MCP server exposes your knowledge graph as native tools to Claude.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "productive": {
      "command": "docker",
      "args": [
        "exec", "-i", "v4-mcp-server-v4-1",
        "python", "-m", "mcp_server.main", "--transport", "stdio"
      ]
    }
  }
}
```

Then generate a **trusted PAT** in Settings → API Access and set it in `.env`:

```env
MCP_PAT=pa_...
```

Restart: `docker compose up -d --force-recreate mcp-server-v4`

### Claude.ai web

Set `MCP_TRANSPORT=sse` (the default) and connect via `http://localhost:3006/sse`, or expose the port through your Cloudflare tunnel.

---

## API Access (External Agents)

Generate a Personal Access Token in Settings → API Access.

```bash
curl -H "Authorization: Bearer pa_..." http://localhost:3005/api/v1/docs
```

Trusted tokens can write directly. Untrusted tokens are gated by the HITL review queue (Settings → Reviews).

OpenAPI docs available at `/api/v1/` — all routes are under that prefix.

---

## Architecture

```
Browser
  │  (IndexedDB/Dexie — offline copy)
  │  delta sync ↑↓
  ▼
frontend-v4  (Nginx, :3005)
  │  /api/v1/* → proxy
  ▼
backend-v4  (Rust/Axum, :8000)
  │  reads/writes
  ├── /data/v4/users/{id}/docs/*.md   (OKF markdown + YAML frontmatter)
  ├── /data/v4/users/{id}/_meta.db    (SQLite: settings, inbox, themes, embeddings, …)
  └── /data/v4/api_tokens.db          (global PAT hashes)

mcp-server-v4  (Python FastMCP, :3006)
  │  REST → backend-v4
  └── Claude Desktop / Claude.ai
```

All doc writes are git-committed in the user's directory. `_meta.db` is gitignored.

---

## Development

Rebuild after code changes:

```bash
# Backend only
docker compose build --no-cache backend-v4
docker compose up -d --force-recreate backend-v4

# Frontend only
docker compose build --no-cache frontend-v4
docker compose up -d --force-recreate frontend-v4
```

Logs:

```bash
docker compose logs -f backend-v4
docker compose logs -f frontend-v4
```

See `backend/constraints.md` for backend rules and invariants.  
See `system.md` for a full system reference.
