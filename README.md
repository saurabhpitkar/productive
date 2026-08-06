# Productive

An AI-augmented personal knowledge graph. Write docs, link them together, and let AI agents read and write your knowledge - with you staying in control.

---

## What it is

A self-hosted second brain where everything is a **doc**: notes, tasks, plans, research, decisions. Docs connect to each other via typed links (`requires`, `related_to`, `up`), forming a knowledge graph that grows over time and spans every area of your life.

AI agents (via PAT tokens or MCP) can read and write docs. You set which docs are sensitive and require your approval before any agent change takes effect.

---

## Why it's different

| Feature | Most note apps | Productive |
|---|---|---|
| Knowledge graph with typed links | ❌ | ✅ |
| Agent writes with human oversight (HITL) | ❌ | ✅ |
| Per-doc trust level (some docs always reviewed) | ❌ | ✅ |
| Offline-first PWA with delta sync | ❌ | ✅ |
| Your data in your own SQLite (no central server) | ❌ | ✅ |
| MCP native (Claude Desktop + Claude.ai web) | ❌ | ✅ |
| Multi-provider AI (Claude + Gemini) | ❌ | ✅ |
| REST API with PAT tokens for any tool/agent | ❌ | ✅ |

---

## Quick start

**Prerequisites:** Docker Desktop, a Google Cloud project (for OAuth), and an Anthropic or Google AI API key.

```bash
git clone <this-repo> productive
cd productive
cp .env.example .env
```

Fill in the required values in `.env`:

```
# Required
JWT_SECRET_KEY=          # openssl rand -hex 32
ENCRYPTION_KEY=          # python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
APP_ORIGIN_V2=https://your-domain.com

# At least one OAuth provider is required
GOOGLE_CLIENT_ID=        # console.cloud.google.com → APIs → Credentials
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://your-domain.com/api/v1/auth/callback

# GitHub OAuth (optional - but recommended for developers)
GITHUB_CLIENT_ID=        # github.com/settings/developers → New OAuth App
GITHUB_CLIENT_SECRET=    # Callback URL: https://your-domain.com/api/v1/auth/github/callback
```

Then:

```bash
docker compose up -d
```

Open `http://localhost:3001` (or your domain). Sign in with GitHub or Google. On first login you'll be offered the demo vault.

### GitHub OAuth app setup (2 minutes)

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**
2. Set **Authorization callback URL** to `https://your-domain.com/api/v1/auth/github/callback`
3. Copy Client ID and Client Secret into `.env`
4. Restart: `docker compose up -d backend-v2`

No Google Cloud project required if you only want GitHub sign-in.

---

## New user onboarding

On first login, a one-time prompt asks how you want to start:

- **Explore demo vault** - loads 5 pre-linked life projects (Japan trip, career, finance, health, learning) so you can see how a knowledge graph feels before building your own. You can delete any or all demo docs at any time.
- **Start fresh** - empty vault, you build from scratch.

The demo is opt-in and idempotent - if you already have docs the seed endpoint is a no-op.

---

## How it works

### 1. Everything is a doc

A doc has a name, a markdown body, optional metadata (due date, priority, status, tags), and typed links to other docs.

### 2. Link types shape the graph

| Label | Meaning | Example |
|---|---|---|
| `requires` | This doc depends on or contains the other | "Japan Trip" → `requires` → "Budget Breakdown" |
| `related_to` | Lateral connection across domains | "Japan Trip" → `related_to` → "Finance 2026" |
| `up` | Parent / broader context | "Learning 2026" → `up` → "Career 2026" |

### 3. Skeleton-first workflow

1. **You create the skeleton** (5–10 min): a root doc for a topic plus child docs for the questions you care about, linked together
2. **Agents fill the branches**: given the root, an agent traverses links and fills each branch using context from sibling docs
3. **Cross-domain links compound value**: an agent answering "is October a good time for Japan?" can traverse your Career doc (leave availability) and Finance doc (budget) - because those links exist

### 4. HITL (Human-in-the-Loop)

Mark any doc as `hitl_required = true` from the UI. From that point:
- Browser (you): writes go through immediately
- Trusted agents: writes go through immediately (you explicitly trust them)
- Untrusted agents: writes are intercepted, stored as a pending review, and return HTTP 202
- You see proposed changes in the **Reviews** sidebar and approve, reject, or cancel each one

---

## Connecting AI agents

### Personal Access Tokens (PATs)

Generate a PAT in **Settings → API Access**. Use it as `Authorization: Bearer pa_…` on any API call.

```bash
# List your docs
curl https://your-domain.com/api/v1/docs \
  -H "Authorization: Bearer pa_YOUR_TOKEN"

# Update a doc (HITL gate applies if doc is protected)
curl -X PATCH https://your-domain.com/api/v1/docs/DOC_ID \
  -H "Authorization: Bearer pa_YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Updated content"}'
```

A 202 response means the write was intercepted for HITL review:
```json
{
  "review_id": "uuid",
  "status": "pending_review",
  "message": "This doc requires human review before changes are applied."
}
```

### Trusted tokens

In **Settings → API Access**, toggle a token to **Trusted** to let it bypass HITL review. Only you (browser/cookie auth) can change this flag - an agent cannot elevate its own trust.

### HITL via API (for trusted agents or custom review UIs)

```bash
# List pending reviews
curl https://your-domain.com/api/v1/hitl/reviews \
  -H "Authorization: Bearer pa_TRUSTED_TOKEN"

# Approve a review
curl -X POST https://your-domain.com/api/v1/hitl/reviews/REVIEW_ID/resolve \
  -H "Authorization: Bearer pa_TRUSTED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"outcome": "approved", "human_notes": "Looks good"}'
```

---

## MCP setup (Claude Desktop + Claude.ai web)

The MCP server exposes all knowledge graph tools natively to any MCP-compatible client.

### Step 1: Generate a trusted PAT

In Settings → API Access, create a PAT, toggle it **Trusted**, copy it, and add it to `.env`:
```
MCP_PAT=pa_your_token_here
```

Restart: `docker compose up -d mcp-server`

### Step 2a: Claude Desktop (STDIO)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "productive": {
      "command": "docker",
      "args": [
        "exec", "-i", "productive-mcp-server-1",
        "python", "-m", "mcp_server.main", "--transport", "stdio"
      ]
    }
  }
}
```

Restart Claude Desktop. You'll see "Productive" in the tools panel.

### Step 2b: Claude.ai web (HTTP/SSE)

Expose port 3002 via Cloudflare Tunnel (add to your tunnel config), then add the MCP server URL in Claude.ai settings.

### Available MCP tools

| Tool | Description |
|---|---|
| `list_docs` | Search and filter docs |
| `get_doc` | Fetch a doc by ID |
| `create_doc` | Create a new doc |
| `update_doc` | Update doc fields (HITL applies) |
| `delete_doc` | Delete a doc |
| `get_doc_links` | Get outgoing links from a doc |
| `get_backlinks` | Get docs that link to a doc |
| `add_link` | Add a typed link between docs |
| `remove_link` | Remove a link |
| `list_hitl_reviews` | List pending reviews |
| `get_hitl_review` | Get a review with current doc state |
| `resolve_hitl_review` | Approve / reject / cancel a review |

### ChatGPT custom actions

Point your ChatGPT custom action at the OpenAPI schema: `https://your-domain.com/api/docs`. Use `Authorization: Bearer pa_…` as the API key. No MCP needed - the existing REST API is the interface.

---

## Demo: 5-Project Knowledge Graph

Every new account starts with this demo graph. It shows how cross-domain links let agents answer questions that span your whole life context.

### The graph at a glance

```
Japan Trip 2026 [HITL]
  ├─[requires]─ Flights
  ├─[requires]─ Accommodation
  │   ├─[requires]─ Tokyo - 5 nights          "Shinjuku, max $150/night"
  │   └─[requires]─ Kyoto - 3 nights
  ├─[requires]─ Itinerary
  │   ├─[requires]─ Week 1 - Tokyo            (detailed day-by-day body)
  │   └─[requires]─ Week 2 - Kyoto + Osaka
  ├─[requires]─ Budget Breakdown [HITL]       (cost table pre-filled)
  ├─[requires]─ Packing List
  ├─[requires]─ Visa & Admin [HITL]           (checklist pre-filled)
  ├─[related_to]─ Career 2026                (leave timing)
  ├─[related_to]─ Finance 2026               (budget constraint)
  └─[related_to]─ Health 2026                (walking fitness asset)

Career 2026
  ├─[requires]─ Promo Case Document [HITL]   (evidence template)
  ├─[requires]─ Key Projects
  │   ├─[requires]─ Project Alpha            "Auth migration, Q2 GA"
  │   └─[requires]─ Project Beta
  ├─[requires]─ Skills to Build
  │   ├─[requires]─ System Design Practice   (resources + weekly plan)
  │   └─[requires]─ Technical Writing
  └─[related_to]─ Learning 2026

Finance 2026 [HITL]
  ├─[requires]─ Monthly Budget [HITL]        (full budget table)
  ├─[requires]─ Emergency Fund               "Target $18k, current $12.5k"
  ├─[requires]─ Investments
  │   ├─[requires]─ Index Funds - DCA        (70/20/10 VTI/VXUS/BND)
  │   └─[requires]─ Tax-advantaged Accounts  (401k/Roth IRA limits)
  ├─[requires]─ Discretionary Spend Tracker
  └─[related_to]─ Japan Trip 2026

Health 2026
  ├─[requires]─ Training Plan - Half Marathon
  │   ├─[requires]─ Weeks 1–4 Base           (weekly schedule pre-filled)
  │   ├─[requires]─ Weeks 5–8 Build
  │   └─[requires]─ Race Week
  ├─[requires]─ Nutrition Plan
  │   ├─[requires]─ Meal Prep Sunday         (macro targets + template)
  │   └─[requires]─ Race Day Nutrition
  ├─[requires]─ Recovery Protocols           (sleep, HRV, foam roll)
  └─[related_to]─ Japan Trip 2026

Learning 2026
  ├─[requires]─ Reading List
  │   ├─[requires]─ Currently Reading        "Thinking Fast and Slow - ch 14"
  │   ├─[requires]─ Reading Queue            (8 books, prioritised)
  │   └─[requires]─ Notes: Atomic Habits     (full key takeaways)
  ├─[requires]─ Courses
  │   ├─[requires]─ System Design Course     "Grokking - Module 3/10"
  │   └─[requires]─ Rust Programming         "Chapter 10/20"
  ├─[related_to]─ Career 2026
  └─[up]─ Career 2026
```

### What the cross-domain links enable

Ask the AI: *"Is October a good time for the Japan trip given everything going on?"*

An agent with MCP access traverses:
- **Japan Trip** → reads October dates and budget
- **Career 2026** (via `related_to`) → reads Q4 promo timeline and project deadlines
- **Finance 2026** (via `related_to`) → reads discretionary budget remaining
- **Health 2026** (via `related_to`) → reads half marathon date in November

And answers: *"October 15–29 has a conflict - Project Alpha GA is targeted for October. Also, your half marathon is November 8, so the last week of October is your taper. Financially, you have $3,200 left in discretionary budget which covers the $4,000 trip if you pull from Q1 savings. I'd suggest moving the trip to September or discussing the Q4 timeline with your manager first."*

That answer requires context from 4 different life domains. No other note app makes it available to the agent in one traversal.

---

## Architecture

```
Docker Compose (productive-net-v2)
├── frontend-v2   React 18 + Vite PWA (port 3001)
│                 Offline-first via IndexedDB (Dexie.js v4)
│                 Delta sync every 30s (active tab) / configurable background
├── backend-v2    FastAPI + SQLAlchemy 2.0 (no port exposed externally)
│                 Per-user SQLite at /data/users/{google_id}.db
│                 Global PAT store at /data/api_tokens.db
├── mcp-server    MCP server (port 3002, SSE transport)
│                 Calls backend-v2 via PAT - no direct DB access
└── cloudflared   Cloudflare Tunnel (public access without open ports)
```

**Auth:** Google OAuth 2.0 (browser) or PAT Bearer token (agents/API).  
**AI:** Claude (Anthropic) or Gemini (Google) - user-configured, key encrypted at rest.  
**Data:** Each Google account has its own isolated SQLite. No shared tables.

### API reference

Interactive API docs: `https://your-domain.com/api/docs`

---

## Running tests

```bash
# Backend (pytest - runs in Docker test stage)
make test-backend

# Frontend (vitest)
make test-frontend

# Both
make test
```

Or individually:
```bash
docker compose --profile test run --rm backend-v2-test
cd frontend-v2 && npm test
```

---

## License

MIT
