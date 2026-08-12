# Productive

Personal AI-augmented knowledge graph. Write docs, link them wiki-style, let AI agents propose edits, and review anything sensitive before it lands. Offline-first with a 30-second sync loop.

**Stack:** Rust/Axum backend · React/TypeScript frontend · SQLite · Docker Compose

---

## Quick start

Prerequisites: [Docker Desktop](https://docs.docker.com/get-docker/) (includes Compose v2).

### Mac / Linux

```bash
git clone https://github.com/<your-username>/productive.git
cd productive/v4
bash setup.sh
```

### Windows

```powershell
git clone https://github.com/<your-username>/productive.git
cd productive\v4
.\setup.ps1
```

The script:
- generates `JWT_SECRET_KEY` and `FERNET_KEY` automatically (no Python or extra tools needed)
- walks you through Google OAuth setup with the exact redirect URI pre-filled
- asks for optional extras (GitHub OAuth, allowed emails, Cloudflare tunnel)
- offers to start the containers when done

First build compiles the Rust backend and takes 3–5 minutes. Subsequent starts are instant.

---

## Manual setup

If you prefer to configure `.env` yourself:

**1. Copy the example**
```bash
cp .env.example .env
```

**2. Generate secrets**
```bash
# JWT_SECRET_KEY
openssl rand -hex 32

# FERNET_KEY (URL-safe base64)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n'
```

**3. Create a Google OAuth app**

- Go to [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials
- Create credentials → OAuth 2.0 Client ID → Web application
- Add an **Authorised redirect URI**: `https://your-domain.com/api/v1/auth/callback`
  (or `http://localhost:3005/api/v1/auth/callback` for local testing)
- Copy the Client ID and Client Secret into `.env`

**4. Fill in `.env` and start**
```bash
docker compose up -d
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Yes | Full callback URL (set by setup script) |
| `JWT_SECRET_KEY` | Yes | Session token signing key — 64 hex chars |
| `FERNET_KEY` | Yes | Encryption key for stored OAuth tokens |
| `APP_ORIGIN_V4` | Yes | Base URL of the app, no trailing slash |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth client ID (second login method) |
| `GITHUB_CLIENT_SECRET` | No | GitHub OAuth client secret |
| `ALLOWED_EMAILS` | No | Comma-separated list; empty = any account |
| `HOST_DOCS_DIR` | No | Local folder to store docs on host filesystem |
| `CLOUDFLARE_TUNNEL_TOKEN_V4` | No | Token for Cloudflare Tunnel (HTTPS) |
| `MCP_PAT` | No | API token for the MCP server (Claude Desktop) |
| `ROUTE_THRESHOLD` | No | Auto-routing confidence threshold (default: 0.80) |
| `VITE_SYNC_INTERVAL_MS` | No | Background sync interval in ms (default: 180000) |

---

## Storing docs on your own filesystem

By default docs are stored inside a Docker-managed volume. To keep them in a folder you control (good for git, Obsidian, etc.), set `HOST_DOCS_DIR` in `.env`:

```
# Windows
HOST_DOCS_DIR=C:/Users/YourName/Documents/my-notes

# Mac / Linux
HOST_DOCS_DIR=/Users/YourName/Documents/my-notes
```

The folder is bind-mounted into the container. Productive reads and writes `.md` files there directly.

---

## Connecting Claude Desktop (MCP)

1. Sign in, go to Settings → API Access, create a token and enable **Trusted**
2. Paste the token as `MCP_PAT` in `.env` and restart: `docker compose up -d`
3. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "productive": {
      "command": "docker",
      "args": ["exec", "-i", "v4-mcp-server-v4-1",
               "python", "-m", "mcp_server.main", "--transport", "stdio"]
    }
  }
}
```

Claude can now read, create, and update docs in your knowledge graph directly from the chat.

---

## How auto-linking works

After every doc save, a background task embeds the doc and scores cosine similarity against all stored embeddings. Pairs above the floor threshold (65%) become link proposals; pairs above the auto threshold (default 82%) are applied immediately.

**Link labels are classified automatically — no LLM call:**

| Label | Signal |
|---|---|
| `requires` | Source body contains dependency language (`depends on`, `blocked by`, `requires`, `prerequisite`, etc.) |
| `belongs_to` | Source keywords are a subset of target keywords — source is the narrower/more specific doc |
| `related_to` | Default when neither of the above fires |

Labels are stored per-link in YAML frontmatter. If you manually change a link label via the UI, the auto-linker will never overwrite it — your edit is marked `source: "manual"` and protected permanently.

**Keyword extraction:** top-5 representative terms per doc are computed from `title + body` (weighted term frequency, no API call) and stored as `vector_keywords` in frontmatter. These power the `belongs_to` heuristic.

---

## Useful commands

```bash
# Start
docker compose up -d

# Stop
docker compose down

# View logs
docker compose logs -f

# Rebuild after a code change
docker compose build && docker compose up -d

# Re-run setup (safe to run again — secrets are preserved)
bash setup.sh        # Mac / Linux
.\setup.ps1          # Windows
```
