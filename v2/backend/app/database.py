"""
Per-user SQLite database management.
Each authenticated user gets their own .db file at DATABASE_DIR/{user_id}.db.
Engines are cached in-process to avoid re-creating them on every request.
"""
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from threading import Lock

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from .config import DATABASE_DIR

_engines: dict[str, object] = {}
_lock = Lock()
_migrated: set[str] = set()


class Base(DeclarativeBase):
    pass


def _make_engine(db_path: str):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def set_pragmas(dbapi_conn, _record):
        if isinstance(dbapi_conn, sqlite3.Connection):
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


def get_engine_for_user(user_id: str):
    with _lock:
        if user_id not in _engines:
            db_path = os.path.join(DATABASE_DIR, f"{user_id}.db")
            _engines[user_id] = _make_engine(db_path)
        return _engines[user_id]


def get_session_factory(user_id: str):
    engine = get_engine_for_user(user_id)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _run_migrations(engine) -> None:
    """Add columns introduced after initial schema creation (ALTER TABLE is idempotent via PRAGMA check)."""
    with engine.begin() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(doc)")).fetchall()}
        if "hitl_required" not in existing:
            conn.execute(text("ALTER TABLE doc ADD COLUMN hitl_required BOOLEAN NOT NULL DEFAULT 0"))
        if "hitl_status" not in existing:
            conn.execute(text("ALTER TABLE doc ADD COLUMN hitl_status VARCHAR"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _seed_onboarding_docs(engine) -> None:
    """Seed 5 getting-started guide docs. Skipped if 'Read this' already exists."""
    try:
        Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        session = Session()
        try:
            from .models import Doc, DocLink
            if session.query(Doc).filter(Doc.name == "Read this").count() > 0:
                return

            now = _now()
            d1 = str(uuid.uuid4())
            d2 = str(uuid.uuid4())
            d3 = str(uuid.uuid4())
            d4 = str(uuid.uuid4())
            d5 = str(uuid.uuid4())

            DOC1_BODY = (
                "Full documentation: https://github.com/saurabhpitkar/productive/tree/main#productive\n\n"
                "---\n\n"
                "## What it is\n\n"
                "A self-hosted second brain where everything is a **doc**: notes, tasks, plans, research, decisions. "
                "Docs connect to each other via typed links (`requires`, `related_to`, `up`), forming a knowledge graph "
                "that grows over time and spans every area of your life.\n\n"
                "AI agents (via PAT tokens or MCP) can read and write docs. You set which docs are sensitive and require "
                "your approval before any agent change takes effect.\n\n"
                "---\n\n"
                "## Why it's different\n\n"
                "| Feature | Most note apps | Productive |\n"
                "|---|---|---|\n"
                "| Knowledge graph with typed links | ❌ | ✅ |\n"
                "| Agent writes with human oversight (HITL) | ❌ | ✅ |\n"
                "| Per-doc trust level (some docs always reviewed) | ❌ | ✅ |\n"
                "| Offline-first PWA with delta sync | ❌ | ✅ |\n"
                "| Your data in your own SQLite (no central server) | ❌ | ✅ |\n"
                "| MCP native (Claude Desktop + Claude.ai web) | ❌ | ✅ |\n"
                "| Multi-provider AI (Claude + Gemini) | ❌ | ✅ |\n"
                "| REST API with PAT tokens for any tool/agent | ❌ | ✅ |\n\n"
                "---\n\n"
                "## Quick start\n\n"
                "**Prerequisites:** Docker Desktop, a Google Cloud project (for OAuth), "
                "and an Anthropic or Google AI API key.\n\n"
                "```bash\n"
                "git clone https://github.com/saurabhpitkar/productive.git\n"
                "cd productive\n"
                "cp .env.example .env\n"
                "```\n\n"
                "Fill in the required values in `.env`:\n\n"
                "```\n"
                "# Required\n"
                "JWT_SECRET_KEY=          # openssl rand -hex 32\n"
                "ENCRYPTION_KEY=          # python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"\n"
                "APP_ORIGIN_V2=https://your-domain.com\n\n"
                "# OAuth options for logging in\n"
                "GOOGLE_CLIENT_ID=        # console.cloud.google.com → APIs → Credentials\n"
                "GOOGLE_CLIENT_SECRET=\n"
                "GOOGLE_REDIRECT_URI=https://your-domain.com/api/v1/auth/callback\n\n"
                "GITHUB_CLIENT_ID=        # github.com/settings/developers → New OAuth App\n"
                "GITHUB_CLIENT_SECRET=    # Callback URL: https://your-domain.com/api/v1/auth/github/callback\n"
                "```\n\n"
                "Then:\n\n"
                "```bash\n"
                "docker compose up -d\n"
                "```\n\n"
                "Open `http://localhost:3001` (or your domain). Sign in with GitHub or Google."
            )

            DOC2_BODY = (
                "## Everything is a doc\n\n"
                "A doc has a name, a markdown body, optional metadata, and typed links to other docs. "
                "Every field is optional except `name`.\n\n"
                "| Field | Type | Description |\n"
                "|---|---|---|\n"
                "| `id` | UUID | Server-generated primary key |\n"
                "| `name` | string | Title |\n"
                "| `body` | string | Markdown body (empty string if unset) |\n"
                "| `status` | enum | `todo` / `in_progress` / `done` / `cancelled` / `archived` |\n"
                "| `priority` | enum | `high` / `medium` / `low` / null |\n"
                "| `due_date` | string | `YYYY-MM-DD` or null |\n"
                "| `due_time` | string | `HH:MM` (24h) or null |\n"
                "| `flag` | boolean | Flagged for attention |\n"
                "| `list_id` | UUID | Folder / list assignment (optional) |\n"
                "| `tags` | object | Free-form `{key: value}` metadata pairs |\n"
                "| `linked_doc_ids` | UUID[] | IDs of docs this doc links to (derived from links table) |\n"
                "| `hitl_required` | boolean | When true, untrusted agent writes go to review queue instead of applying directly |\n"
                "| `hitl_status` | enum | `pending` while a review is queued, null otherwise |\n"
                "| `note_outline` | JSON | Auto-computed heading structure `[{level, text}]` (read-only) |\n"
                "| `created_at` | ISO 8601 | Creation timestamp (UTC, server-set) |\n"
                "| `updated_at` | ISO 8601 | Last modified (UTC, server-set on every write) |"
            )

            DOC3_BODY = (
                "## Link types shape the graph\n\n"
                "| Label | Meaning | Example |\n"
                "|---|---|---|\n"
                "| `requires` | This doc depends on or contains the other | \"Japan Trip\" → `requires` → \"Budget Breakdown\" |\n"
                "| `related_to` | Lateral connection across domains | \"Japan Trip\" → `related_to` → \"Finance 2026\" |\n"
                "| `up` | Parent / broader context | \"Learning 2026\" → `up` → \"Career 2026\" |\n\n"
                "---\n\n"
                "## Skeleton-first workflow\n\n"
                "1. **You create the skeleton** (5–10 min): a root doc for a topic plus child docs for the questions "
                "you care about, linked together\n"
                "2. **Agents fill the branches**: given the root, an agent traverses links and fills each branch "
                "using context from sibling docs\n"
                "3. **Cross-domain links compound value**: an agent answering “is October a good time for Japan?” "
                "can traverse your Career doc (leave availability) and Finance doc (budget) — because those links exist\n\n"
                "---\n\n"
                "## HITL (Human-in-the-Loop)\n\n"
                "Mark any doc as `hitl_required = true` from the doc panel. From that point:\n"
                "- **Browser (you):** writes go through immediately\n"
                "- **Trusted agents:** writes go through immediately (you explicitly trust them in Settings → API Access)\n"
                "- **Untrusted agents:** writes are intercepted, stored as a pending review, and return HTTP 202\n"
                "- You see proposed changes in the **Reviews** sidebar and approve, reject, or cancel each one"
            )

            DOC4_BODY = (
                "## Personal Access Tokens (PATs)\n\n"
                "Generate a PAT in **Settings → API Access**. Use it as `Authorization: Bearer pa_…` "
                "header on any API call.\n\n"
                "All endpoints are under `/api/v1`. Full interactive schema: `https://your-domain.com/api/docs`.\n\n"
                "| Method | Endpoint | Description |\n"
                "|---|---|---|\n"
                "| GET | `/docs` | List docs — filter by `status`, `priority`, `q`, `limit`, `offset` |\n"
                "| POST | `/docs` | Create doc |\n"
                "| GET | `/docs/{id}` | Get single doc |\n"
                "| PATCH | `/docs/{id}` | Update doc — returns 202 + review_id if HITL-protected |\n"
                "| DELETE | `/docs/{id}` | Hard delete doc |\n"
                "| GET | `/docs/{id}/links` | Outgoing links with labels |\n"
                "| GET | `/docs/{id}/backlinks` | Docs that link to this doc |\n"
                "| POST | `/docs/{id}/links` | Add or update a typed link |\n"
                "| GET | `/hitl/reviews` | Pending reviews |\n"
                "| POST | `/hitl/reviews/{id}/resolve` | Approve / reject / cancel a review |\n"
                "| GET | `/tokens` | List your PATs |\n"
                "| POST | `/tokens` | Create a PAT — raw token returned once, never stored |\n\n"
                "**Cookie-only endpoints (PATs receive 403):**\n"
                "- `PATCH /tokens/{id}/trusted` — toggle a token’s trusted flag (agents cannot self-elevate)\n"
                "- Setting `hitl_required: true` on a doc\n\n"
                "---\n\n"
                "## MCP setup (Claude Desktop + Claude.ai web)\n\n"
                "The MCP server exposes all knowledge graph tools natively to any MCP-compatible client.\n\n"
                "### Step 1: Generate a trusted PAT\n\n"
                "In Settings → API Access, create a PAT, toggle it **Trusted**, copy it, and add to `.env`:\n"
                "```\n"
                "MCP_PAT=pa_your_token_here\n"
                "```\n\n"
                "Restart: `docker compose up -d mcp-server`\n\n"
                "### Step 2a: Claude Desktop (STDIO)\n\n"
                "**macOS:**\n"
                "```bash\n"
                "mkdir -p ~/Library/Application\\ Support/Claude\n"
                "open -e ~/Library/Application\\ Support/Claude/claude_desktop_config.json\n"
                "```\n\n"
                "**Windows:** open `%APPDATA%\\Claude\\claude_desktop_config.json` in any text editor.\n\n"
                "Paste this config:\n"
                "```json\n"
                "{\n"
                "  \"mcpServers\": {\n"
                "    \"productive\": {\n"
                "      \"command\": \"docker\",\n"
                "      \"args\": [\n"
                "        \"exec\", \"-i\", \"productive-mcp-server-1\",\n"
                "        \"python\", \"-m\", \"mcp_server.main\", \"--transport\", \"stdio\"\n"
                "      ]\n"
                "    }\n"
                "  }\n"
                "}\n"
                "```\n\n"
                "Save, then **fully quit and restart Claude Desktop** (Cmd+Q / Alt+F4, not just close the window).\n\n"
                "### Step 2b: Claude.ai web (HTTP/SSE)\n\n"
                "1. Expose port 3002 via Cloudflare Tunnel (e.g. `mcp.your-domain.com → localhost:3002`)\n"
                "2. Go to claude.ai → Settings → Integrations → Add integration → Remote MCP Server\n"
                "3. Enter URL: `https://mcp.your-domain.com/sse`\n\n"
                "For Claude Code, add to `.claude/settings.json`:\n"
                "```json\n"
                "{\n"
                "  \"mcpServers\": {\n"
                "    \"productive\": {\n"
                "      \"type\": \"sse\",\n"
                "      \"url\": \"https://mcp.your-domain.com/sse\",\n"
                "      \"headers\": {\n"
                "        \"Authorization\": \"Bearer pa_your_token_here\"\n"
                "      }\n"
                "    }\n"
                "  }\n"
                "}\n"
                "```\n\n"
                "### Available MCP tools\n\n"
                "| Tool | Description |\n"
                "|---|---|\n"
                "| `list_docs` | Search and filter docs |\n"
                "| `get_doc` | Fetch a doc by ID |\n"
                "| `create_doc` | Create a new doc |\n"
                "| `update_doc` | Update doc fields (HITL applies) |\n"
                "| `delete_doc` | Delete a doc |\n"
                "| `add_link` | Add a typed link between docs |\n"
                "| `list_hitl_reviews` | List pending reviews |\n"
                "| `resolve_hitl_review` | Approve / reject / cancel a review |"
            )

            DOC5_BODY = (
                "Every new account that chooses to explore the demo vault starts with this knowledge graph. "
                "It shows how cross-domain links let agents answer questions that span your whole life context.\n\n"
                "## The graph at a glance\n\n"
                "```\n"
                "Japan Trip 2026 [HITL]\n"
                "  ├─[requires]─ Flights\n"
                "  ├─[requires]─ Accommodation\n"
                "  │   ├─[requires]─ Tokyo - 5 nights          \"Shinjuku, max $150/night\"\n"
                "  │   └─[requires]─ Kyoto - 3 nights\n"
                "  ├─[requires]─ Itinerary\n"
                "  │   ├─[requires]─ Week 1 - Tokyo            (detailed day-by-day body)\n"
                "  │   └─[requires]─ Week 2 - Kyoto + Osaka\n"
                "  ├─[requires]─ Budget Breakdown [HITL]\n"
                "  ├─[requires]─ Packing List\n"
                "  ├─[requires]─ Visa & Admin [HITL]\n"
                "  ├─[related_to]─ Career 2026                (leave timing)\n"
                "  ├─[related_to]─ Finance 2026               (budget constraint)\n"
                "  └─[related_to]─ Health 2026                (walking fitness asset)\n\n"
                "Career 2026\n"
                "  ├─[requires]─ Promo Case Document [HITL]\n"
                "  ├─[requires]─ Key Projects\n"
                "  │   ├─[requires]─ Project Alpha            \"Auth migration, Q2 GA\"\n"
                "  │   └─[requires]─ Project Beta\n"
                "  ├─[requires]─ Skills to Build\n"
                "  │   ├─[requires]─ System Design Practice\n"
                "  │   └─[requires]─ Technical Writing\n"
                "  └─[related_to]─ Learning 2026\n\n"
                "Finance 2026 [HITL]\n"
                "  ├─[requires]─ Monthly Budget [HITL]\n"
                "  ├─[requires]─ Emergency Fund\n"
                "  ├─[requires]─ Investments\n"
                "  │   ├─[requires]─ Index Funds - DCA\n"
                "  │   └─[requires]─ Tax-advantaged Accounts\n"
                "  ├─[requires]─ Discretionary Spend Tracker\n"
                "  └─[related_to]─ Japan Trip 2026\n\n"
                "Health 2026\n"
                "  ├─[requires]─ Training Plan - Half Marathon\n"
                "  │   ├─[requires]─ Weeks 1–4 Base\n"
                "  │   ├─[requires]─ Weeks 5–8 Build\n"
                "  │   └─[requires]─ Race Week\n"
                "  ├─[requires]─ Nutrition Plan\n"
                "  │   ├─[requires]─ Meal Prep Sunday\n"
                "  │   └─[requires]─ Race Day Nutrition\n"
                "  ├─[requires]─ Recovery Protocols\n"
                "  └─[related_to]─ Japan Trip 2026\n\n"
                "Learning 2026\n"
                "  ├─[requires]─ Reading List\n"
                "  │   ├─[requires]─ Currently Reading\n"
                "  │   ├─[requires]─ Reading Queue\n"
                "  │   └─[requires]─ Notes: Atomic Habits\n"
                "  ├─[requires]─ Courses\n"
                "  │   ├─[requires]─ System Design Course\n"
                "  │   └─[requires]─ Rust Programming\n"
                "  ├─[related_to]─ Career 2026\n"
                "  └─[up]─ Career 2026\n"
                "```\n\n"
                "## What the cross-domain links enable\n\n"
                "Ask the AI: *“Is October a good time for the Japan trip given everything going on?”*\n\n"
                "An agent with MCP access traverses:\n"
                "- **Japan Trip** → reads October dates and budget\n"
                "- **Career 2026** (via `related_to`) → reads Q4 promo timeline and project deadlines\n"
                "- **Finance 2026** (via `related_to`) → reads discretionary budget remaining\n"
                "- **Health 2026** (via `related_to`) → reads half marathon date in November\n\n"
                "And answers: *“October 15–29 has a conflict — Project Alpha GA is targeted for October. "
                "Also, your half marathon is November 8, so the last week of October is your taper. "
                "Financially, you have $3,200 left in discretionary budget which covers the $4,000 trip "
                "if you pull from Q1 savings. I’d suggest moving the trip to September or discussing "
                "the Q4 timeline with your manager first.”*\n\n"
                "That answer requires context from 4 different life domains. "
                "No other note app makes it available to the agent in one traversal."
            )

            onboarding_docs = [
                dict(id=d1, name="Read this",                        hitl_required=True,  body=DOC1_BODY),
                dict(id=d2, name="Understand doc's data model",      hitl_required=False, body=DOC2_BODY),
                dict(id=d3, name="How it works",                     hitl_required=False, body=DOC3_BODY),
                dict(id=d4, name="Advanced connections",             hitl_required=False, body=DOC4_BODY),
                dict(id=d5, name="Demo: 5-Project Knowledge Graph",  hitl_required=True,  body=DOC5_BODY),
            ]

            for d in onboarding_docs:
                session.add(Doc(
                    id=d["id"],
                    name=d["name"],
                    body=d["body"],
                    note_outline="[]",
                    hitl_required=d["hitl_required"],
                    status="todo",
                    tags={},
                    created_at=now,
                    updated_at=now,
                ))

            for src, tgt, label in [
                (d1, d2, "requires"),    # Read this → data model
                (d1, d3, "requires"),    # Read this → how it works
                (d1, d4, "requires"),    # Read this → advanced connections
                (d3, d2, "related_to"), # How it works ↔ data model
                (d5, d1, "related_to"), # Demo KG ↔ Read this
            ]:
                session.add(DocLink(
                    source_doc_id=src,
                    target_doc_id=tgt,
                    label=label,
                    created_at=now,
                ))

            session.commit()
        finally:
            session.close()
    except Exception:
        pass


def _seed_demo_data(engine) -> None:
    """
    Populate a brand-new user DB with 5 demo life-project knowledge graphs.
    Only runs when the doc table is completely empty (first login).
    Failures are swallowed so a bad seed never blocks login.
    """
    try:
        Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        session = Session()
        try:
            # Skip if user already has docs
            from .models import Doc, DocLink
            if session.query(Doc).count() > 0:
                return

            now = _now()
            uid = lambda: str(uuid.uuid4())

            # ── Define docs ───────────────────────────────────────────────────
            docs_data = [
                # ── Project 1: Japan Trip 2026 ────────────────────────────────
                dict(id=(j0:=uid()), name="Japan Trip 2026", hitl_required=True,
                     body="2-week trip in October 2026. Total budget ~$4,000 for 2 adults. "
                          "Need to confirm work leave before booking.\n\n"
                          "## Goals\n- Experience autumn foliage (koyo) in Kyoto\n"
                          "- Try authentic ramen and sushi\n- Visit teamLab digital art\n\n"
                          "## Key constraints\n- Budget: $4,000 all-in\n- Dates: Oct 15–29\n"
                          "- Work approval required before confirming flights"),
                dict(id=(j1:=uid()), name="Flights - Japan 2026", body=""),
                dict(id=(j2:=uid()), name="Accommodation - Japan 2026", body=""),
                dict(id=(j3:=uid()), name="Tokyo - 5 nights",
                     body="**Preferred area:** Shinjuku or Shibuya (walkable to JR stations)\n"
                          "**Budget:** max $150/night for 2 adults\n"
                          "**Shortlist:**\n- Shinjuku Granbell Hotel\n- Hotel Gracery Shinjuku\n- Keio Plaza Hotel"),
                dict(id=(j4:=uid()), name="Kyoto - 3 nights",
                     body="**Preferred area:** Gion or Higashiyama for walkability to temples"),
                dict(id=(j5:=uid()), name="Itinerary - Japan 2026", body=""),
                dict(id=(j6:=uid()), name="Week 1 - Tokyo",
                     body="## Day 1 - Arrival\nArrive Narita/Haneda, transfer to hotel. Rest.\n\n"
                          "## Day 2 - Shinjuku & Harajuku\n- Morning: Shinjuku Gyoen\n"
                          "- Afternoon: Takeshita Street\n- Evening: Omoide Yokocho ramen\n\n"
                          "## Day 3 - Akihabara & teamLab\n- Morning: Akihabara electronics\n"
                          "- Afternoon/Evening: teamLab Borderless\n\n"
                          "## Day 4 - Asakusa & Tokyo Skytree\n"
                          "## Day 5 - Nikko day trip"),
                dict(id=(j7:=uid()), name="Week 2 - Kyoto + Osaka day trip", body=""),
                dict(id=(j8:=uid()), name="Budget Breakdown - Japan", hitl_required=True,
                     body="| Category | Est. Cost |\n|---|---|\n"
                          "| Flights (2 pax) | $1,800 |\n| Accommodation | $1,000 |\n"
                          "| Food | $600 |\n| Transport (JR Pass) | $400 |\n"
                          "| Activities & entrance | $200 |\n| **Total** | **$4,000** |"),
                dict(id=(j9:=uid()), name="Packing List - Japan", body=""),
                dict(id=(j10:=uid()), name="Visa & Admin - Japan", hitl_required=True,
                     body="- [ ] Confirm passport validity (needs 6 months beyond return date)\n"
                          "- [ ] Japan visa (waived for US/EU/most passports - verify)\n"
                          "- [ ] Travel insurance\n- [ ] Notify bank of travel dates\n"
                          "- [ ] Download Suica app (mobile transit card)"),

                # ── Project 2: Career 2026 ────────────────────────────────────
                dict(id=(c0:=uid()), name="Career 2026",
                     body="**Goal:** Staff Engineer promotion by Q4 2026.\n\n"
                          "## Success criteria\n- Lead 2 cross-team projects\n"
                          "- Publish 3 internal design docs\n- Positive 360 feedback from 5+ peers\n\n"
                          "## Timeline\n- Q1: Set goals with manager, identify key projects\n"
                          "- Q2–Q3: Execute + build evidence\n- Q4: Promo packet + calibration"),
                dict(id=(c1:=uid()), name="Promo Case Document", hitl_required=True,
                     body="# Staff Engineer Promotion Case\n\n## Impact\n_To be filled Q3/Q4_\n\n"
                          "## Technical leadership\n- Designed auth migration for 50M users\n"
                          "- Led incident response framework adoption\n\n"
                          "## Scope & influence\nCross-team, cross-org impact examples here."),
                dict(id=(c2:=uid()), name="Key Projects 2026", body=""),
                dict(id=(c3:=uid()), name="Project Alpha - Auth Migration",
                     body="Tech lead. Migrating legacy session auth to JWT + OAuth2.\n"
                          "**Status:** In progress\n**Target:** Q2 2026 GA\n**Team:** 4 engineers"),
                dict(id=(c4:=uid()), name="Project Beta - Platform Observability", body=""),
                dict(id=(c5:=uid()), name="Skills to Build - 2026", body=""),
                dict(id=(c6:=uid()), name="System Design - Practice",
                     body="## Resources\n- [Designing Data-Intensive Applications](DDIA)\n"
                          "- Leetcode system design questions\n- Internal design doc reviews\n\n"
                          "## Weekly practice\nOne design problem per week. Write it up as an ADR."),
                dict(id=(c7:=uid()), name="Technical Writing - Practice", body=""),

                # ── Project 3: Finance 2026 ───────────────────────────────────
                dict(id=(f0:=uid()), name="Finance 2026", hitl_required=True,
                     body="**Goal:** Save $25,000 in 2026. Build 6-month emergency fund.\n\n"
                          "## Annual targets\n- Emergency fund: $18,000 (6 months expenses)\n"
                          "- Index fund contributions: $500/month\n"
                          "- Discretionary: $4,000 (travel etc.)\n\n"
                          "## Monthly income: $8,500 after tax"),
                dict(id=(f1:=uid()), name="Monthly Budget 2026", hitl_required=True,
                     body="| Category | Budget |\n|---|---|\n"
                          "| Rent | $2,200 |\n| Groceries | $400 |\n| Transport | $150 |\n"
                          "| Subscriptions | $100 |\n| Dining out | $300 |\n"
                          "| Savings (auto) | $2,000 |\n| Investments | $500 |\n"
                          "| Discretionary | $333 |\n| **Total** | **$6,000** |"),
                dict(id=(f2:=uid()), name="Emergency Fund",
                     body="**Target:** $18,000 (6 months of $3,000 expenses)\n"
                          "**Current:** $12,500\n**Gap:** $5,500\n\n"
                          "Auto-transfer $500/month from checking. ETA: 11 months."),
                dict(id=(f3:=uid()), name="Investments 2026", body=""),
                dict(id=(f4:=uid()), name="Index Funds - DCA",
                     body="**Strategy:** Dollar-cost average $500/month into:\n"
                          "- 70% VTI (total US market)\n- 20% VXUS (international)\n- 10% BND (bonds)\n\n"
                          "**Platform:** Fidelity. Auto-invest on 1st of each month."),
                dict(id=(f5:=uid()), name="Tax-advantaged Accounts",
                     body="- 401k: Max $23,000/year - currently contributing 15% salary\n"
                          "- Roth IRA: Max $7,000/year - fund by April deadline\n"
                          "- HSA: $4,150/year (if eligible)"),
                dict(id=(f6:=uid()), name="Discretionary Spend Tracker", body=""),

                # ── Project 4: Health 2026 ────────────────────────────────────
                dict(id=(h0:=uid()), name="Health 2026",
                     body="**Goals:**\n- Complete half marathon in November 2026 (sub-2:15)\n"
                          "- Lose 5kg by June (sustainable pace: 0.5kg/week)\n"
                          "- Sleep 7.5h average\n\n"
                          "## Weekly baseline\n- Run 4x/week\n- Strength 2x/week\n- 8k steps/day"),
                dict(id=(h1:=uid()), name="Training Plan - Half Marathon", body=""),
                dict(id=(h2:=uid()), name="Training: Weeks 1–4 Base",
                     body="**Goal:** Build aerobic base. 3 easy runs + 1 long run/week.\n\n"
                          "| Day | Session | Distance |\n|---|---|---|\n"
                          "| Mon | Easy run | 5km |\n| Wed | Easy run | 6km |\n"
                          "| Fri | Easy run | 5km |\n| Sun | Long run | 10km |\n\n"
                          "Pace: conversational (Zone 2). No speedwork yet."),
                dict(id=(h3:=uid()), name="Training: Weeks 5–8 Build", body=""),
                dict(id=(h4:=uid()), name="Training: Race Week", body=""),
                dict(id=(h5:=uid()), name="Nutrition Plan", body=""),
                dict(id=(h6:=uid()), name="Meal Prep - Sunday",
                     body="## Template\n- **Protein:** Chicken breast or salmon (4 portions)\n"
                          "- **Carbs:** Brown rice or sweet potato\n- **Veg:** Roasted broccoli + spinach\n\n"
                          "## Macros target (training day)\n- Protein: 160g\n- Carbs: 250g\n- Fat: 70g"),
                dict(id=(h7:=uid()), name="Race Day Nutrition", body=""),
                dict(id=(h8:=uid()), name="Recovery Protocols",
                     body="## Sleep\n- Target: 7.5h. Bedtime 10:30pm alarm 6am.\n"
                          "- Track HRV with Whoop/Garmin. Rest day if HRV drops >20%.\n\n"
                          "## Post-run\n- 20min walk cooldown\n- Foam roll calves + IT band\n"
                          "- Protein shake within 30 min"),

                # ── Project 5: Learning 2026 ──────────────────────────────────
                dict(id=(l0:=uid()), name="Learning 2026",
                     body="**Goals:** Read 24 books (2/month). Complete 2 technical courses.\n\n"
                          "## Focus areas\n1. Systems thinking & distributed systems\n"
                          "2. Rust programming language\n3. Writing & communication\n\n"
                          "**Rule:** 30 min reading before phone in the morning."),
                dict(id=(l1:=uid()), name="Reading List 2026", body=""),
                dict(id=(l2:=uid()), name="Currently Reading",
                     body="**Thinking, Fast and Slow** - Daniel Kahneman\n\n"
                          "Chapter 14 / 38. Reading for 20 min each morning.\n\n"
                          "### Key takeaways so far\n"
                          "- System 1 (fast/automatic) vs System 2 (slow/deliberate)\n"
                          "- Anchoring bias is stronger than intuition suggests\n"
                          "- Availability heuristic leads to overestimating dramatic events"),
                dict(id=(l3:=uid()), name="Reading Queue",
                     body="Priority order:\n"
                          "1. The Pragmatic Programmer (Andy Hunt & Dave Thomas)\n"
                          "2. Designing Data-Intensive Applications (Kleppmann)\n"
                          "3. Staff Engineer (Will Larson)\n"
                          "4. The Art of Learning (Josh Waitzkin)\n"
                          "5. Atomic Habits (James Clear)\n"
                          "6. A Philosophy of Software Design (John Ousterhout)\n"
                          "7. The Mom Test (Rob Fitzpatrick)\n"
                          "8. Deep Work (Cal Newport)"),
                dict(id=(l4:=uid()), name="Notes: Atomic Habits",
                     body="# Key Takeaways\n\n## The 4 Laws of Behavior Change\n"
                          "1. Make it obvious (cue)\n2. Make it attractive (craving)\n"
                          "3. Make it easy (response)\n4. Make it satisfying (reward)\n\n"
                          "## Identity-based habits\n> 'Every action is a vote for the type of person you want to become'\n\n"
                          "Start with identity, not outcomes. 'I am a runner' vs 'I want to run'.\n\n"
                          "## 1% better every day\n1.01^365 = 37.78. Tiny gains compound enormously."),
                dict(id=(l5:=uid()), name="Courses 2026", body=""),
                dict(id=(l6:=uid()), name="System Design Course",
                     body="**Course:** Grokking System Design (Educative.io)\n"
                          "**Progress:** Module 3 / 10 - Load Balancing\n\n"
                          "## Notes\n- Consistent hashing: minimizes cache misses on node add/remove\n"
                          "- CAP theorem: can only guarantee 2 of 3 (consistency, availability, partition tolerance)"),
                dict(id=(l7:=uid()), name="Rust Programming",
                     body="**Resource:** The Rust Book (doc.rust-lang.org/book)\n"
                          "**Progress:** Chapter 10 - Generic Types, Traits, Lifetimes\n\n"
                          "## Key concepts mastered\n- Ownership & borrowing\n- Pattern matching\n"
                          "- Structs and enums\n\n## Still to cover\n- Async/await\n- Macros\n- Unsafe"),
            ]

            # Build Doc objects
            doc_map = {}
            for d in docs_data:
                doc = Doc(
                    id=d["id"],
                    name=d["name"],
                    body=d.get("body", ""),
                    note_outline="[]",
                    hitl_required=d.get("hitl_required", False),
                    status="todo",
                    tags={},
                    created_at=now,
                    updated_at=now,
                )
                doc_map[d["id"]] = doc
                session.add(doc)

            # ── Define links ──────────────────────────────────────────────────
            links = [
                # Japan Trip
                (j0, j1, "requires"), (j0, j2, "requires"), (j2, j3, "requires"),
                (j2, j4, "requires"), (j0, j5, "requires"), (j5, j6, "requires"),
                (j5, j7, "requires"), (j0, j8, "requires"), (j0, j9, "requires"),
                (j0, j10, "requires"),
                # Career
                (c0, c1, "requires"), (c0, c2, "requires"), (c2, c3, "requires"),
                (c2, c4, "requires"), (c0, c5, "requires"), (c5, c6, "requires"),
                (c5, c7, "requires"),
                # Finance
                (f0, f1, "requires"), (f0, f2, "requires"), (f0, f3, "requires"),
                (f3, f4, "requires"), (f3, f5, "requires"), (f0, f6, "requires"),
                # Health
                (h0, h1, "requires"), (h1, h2, "requires"), (h1, h3, "requires"),
                (h1, h4, "requires"), (h0, h5, "requires"), (h5, h6, "requires"),
                (h5, h7, "requires"), (h0, h8, "requires"),
                # Learning
                (l0, l1, "requires"), (l1, l2, "requires"), (l1, l3, "requires"),
                (l1, l4, "requires"), (l0, l5, "requires"), (l5, l6, "requires"),
                (l5, l7, "requires"),
                # Cross-domain links
                (j0, c0, "related_to"),   # Japan Trip ↔ Career (leave timing)
                (j0, f0, "related_to"),   # Japan Trip ↔ Finance (budget constraint)
                (j0, h0, "related_to"),   # Japan Trip ↔ Health (fitness asset on trip)
                (c0, l0, "related_to"),   # Career ↔ Learning (skills feed promo case)
                (l0, c0, "up"),           # Learning serves Career
            ]

            for src, tgt, label in links:
                session.add(DocLink(
                    source_doc_id=src,
                    target_doc_id=tgt,
                    label=label,
                    created_at=now,
                ))

            session.commit()
        finally:
            session.close()
    except Exception:
        pass  # Never block login due to seeding failure

    _seed_onboarding_docs(engine)


def ensure_schema(user_id: str, base):
    """Create all tables for this user's DB if they don't exist yet, then run column migrations."""
    engine = get_engine_for_user(user_id)
    base.metadata.create_all(bind=engine)
    if user_id not in _migrated:
        _run_migrations(engine)
        _migrated.add(user_id)


def seed_fresh_data(user_id: str) -> None:
    """Seed onboarding guide docs for a user who chose 'Start fresh'."""
    engine = get_engine_for_user(user_id)
    _seed_onboarding_docs(engine)


def seed_demo_data(user_id: str) -> bool:
    """
    Seed demo knowledge graph for user_id. Returns True if seeding happened,
    False if skipped because the user already has docs.
    Called from the /auth/seed-demo endpoint (opt-in, not automatic).
    """
    from .models import Doc
    from sqlalchemy.orm import Session
    engine = get_engine_for_user(user_id)
    with Session(engine) as session:
        if session.query(Doc).count() > 0:
            return False
    _seed_demo_data(engine)
    return True


def get_db(user_id: str):
    """FastAPI dependency factory - call as Depends(get_db(user_id))."""
    SessionLocal = get_session_factory(user_id)
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
