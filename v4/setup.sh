#!/usr/bin/env bash
# Productive v4 — interactive setup script
# Run: bash setup.sh
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}→${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
die()     { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# ── Prerequisites ──────────────────────────────────────────────────────────────
command -v docker   >/dev/null 2>&1 || die "Docker not found. Install from https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not found. Update Docker Desktop or install the plugin."
command -v openssl  >/dev/null 2>&1 || die "openssl not found. Install via your package manager."

echo ""
echo -e "${BOLD}Productive v4 — Setup${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── .env file ─────────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  info "Created .env from .env.example"
else
  info ".env already exists — updating values only"
fi

# Read a value from .env (handles values that themselves contain '=')
get_env() { grep -E "^${1}=" "$ENV_FILE" | cut -d'=' -f2- | head -1; }

# Write or replace a key=value line in .env
set_env() {
  local key="$1" val="$2"
  # Escape any '|' in the value to avoid breaking sed's delimiter
  local escaped_val="${val//|/\\|}"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${escaped_val}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '\n%s=%s' "$key" "$val" >> "$ENV_FILE"
  fi
}

# ── Generate secrets ───────────────────────────────────────────────────────────
echo -e "${BOLD}Generating secrets...${NC}"

if [ -z "$(get_env JWT_SECRET_KEY)" ]; then
  set_env "JWT_SECRET_KEY" "$(openssl rand -hex 32)"
  success "JWT_SECRET_KEY generated"
else
  success "JWT_SECRET_KEY already set — skipped"
fi

if [ -z "$(get_env FERNET_KEY)" ]; then
  # Fernet = 32 random bytes as URL-safe base64 (replace + with - and / with _)
  set_env "FERNET_KEY" "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n')"
  success "FERNET_KEY generated"
else
  success "FERNET_KEY already set — skipped"
fi

echo ""

# ── Interactive prompt helper ──────────────────────────────────────────────────
# Usage: ask "Label" KEY [required|optional]
ask() {
  local label="$1" key="$2" mode="${3:-required}"
  local current
  current="$(get_env "$key")"

  if [ -n "$current" ]; then
    echo -e "  ${key} ${YELLOW}[set — press Enter to keep, or type a new value]${NC}"
    read -r -p "  → " val
    val="${val:-$current}"
  else
    if [ "$mode" = "required" ]; then
      echo -e "  ${label} ${RED}(required)${NC}"
    else
      echo -e "  ${label} ${YELLOW}(optional — press Enter to skip)${NC}"
    fi
    read -r -p "  → " val
    if [ "$mode" = "required" ] && [ -z "$val" ]; then
      die "${key} is required. Re-run setup.sh to try again."
    fi
  fi

  [ -n "$val" ] && set_env "$key" "$val"
}

# ── Domain ─────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Your domain${NC}"
echo "  Where Productive will be accessible."
echo "  Local only:  http://localhost:3005"
echo "  Production:  https://your-domain.com"
ask "Domain / origin URL" "APP_ORIGIN_V4" "required"

ORIGIN="$(get_env APP_ORIGIN_V4)"
REDIRECT_URI="${ORIGIN}/api/v1/auth/callback"

# ── Google OAuth ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Google OAuth${NC}"
echo "  1. Go to console.cloud.google.com → APIs & Services → Credentials"
echo "  2. Create credentials → OAuth 2.0 Client ID → Web application"
echo -e "  3. Add Authorised redirect URI: ${YELLOW}${REDIRECT_URI}${NC}"
echo ""
ask "Google Client ID"     "GOOGLE_CLIENT_ID"     "required"
ask "Google Client Secret"  "GOOGLE_CLIENT_SECRET"  "required"
set_env "GOOGLE_REDIRECT_URI" "$REDIRECT_URI"
success "GOOGLE_REDIRECT_URI set to ${REDIRECT_URI}"

# ── GitHub OAuth (optional) ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}GitHub OAuth${NC} — optional second login method"
echo "  github.com → Settings → Developer settings → OAuth Apps → New OAuth App"
echo -e "  Callback URL: ${YELLOW}${REDIRECT_URI}${NC}"
echo ""
ask "GitHub Client ID"     "GITHUB_CLIENT_ID"     "optional"
ask "GitHub Client Secret"  "GITHUB_CLIENT_SECRET"  "optional"

# ── Access control ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Access control${NC}"
echo "  Comma-separated list of emails that can sign in."
echo "  Leave empty to allow any authenticated Google/GitHub account."
ask "Allowed emails" "ALLOWED_EMAILS" "optional"

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Cloudflare Tunnel${NC} — optional, needed for HTTPS / public domain"
echo "  Zero Trust → Networks → Tunnels → Create tunnel → name: productive-v4"
echo -e "  Public hostname: ${ORIGIN} → Service: http://frontend-v4:3005"
ask "Cloudflare Tunnel token" "CLOUDFLARE_TUNNEL_TOKEN_V4" "optional"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
success ".env is configured"
echo ""
echo -e -n "${BOLD}Start containers now?${NC} [Y/n] "
read -r launch
if [[ "${launch:-Y}" =~ ^[Nn]$ ]]; then
  echo ""
  info "Run when ready:"
  echo "    cd $(dirname "$ENV_FILE") && docker compose up -d"
else
  echo ""
  info "Starting containers — first build compiles Rust and may take a few minutes..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --build
  echo ""
  success "Productive is running at ${ORIGIN}"
  echo ""
  echo "  Sign in at: ${ORIGIN}"
  echo "  To stop:    docker compose down"
  echo "  Logs:       docker compose logs -f"
fi
