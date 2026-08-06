"""
OAuth sign-in: Google and GitHub.

Google setup:
  console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID
  Authorized redirect URI: {APP_ORIGIN_V2}/api/v1/auth/callback

GitHub setup:
  github.com/settings/developers → New OAuth App
  Authorization callback URL: {APP_ORIGIN_V2}/api/v1/auth/github/callback
"""
import secrets
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from ..auth import create_jwt, require_user, COOKIE_MAX_AGE
from ..config import (
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
    GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
    ALLOWED_EMAILS, APP_ORIGIN_V2,
)
from ..database import ensure_schema, get_session_factory, seed_demo_data
from ..models import Base, UserSettings

router = APIRouter(prefix="/auth", tags=["auth"])

GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USER_URL  = "https://www.googleapis.com/oauth2/v3/userinfo"

GITHUB_AUTH_URL   = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL  = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL   = "https://api.github.com/user"
GITHUB_EMAILS_URL = "https://api.github.com/user/emails"

# In-memory CSRF state store  (state_token → redirect_after)
_states: dict[str, str] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="pa_session",
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=APP_ORIGIN_V2.startswith("https"),
        samesite="lax",
        path="/",
    )


def _finalize_login(user_id: str, email: str, name: str, avatar: str, redirect_after: str) -> RedirectResponse:
    """Common post-OAuth logic: schema + settings, issue JWT, redirect."""
    ensure_schema(user_id, Base)
    is_new = _init_user_settings(user_id, email, name, avatar)
    token = create_jwt(user_id, email, name, avatar)
    dest = "/?welcome=1" if is_new else redirect_after
    response = RedirectResponse(f"{APP_ORIGIN_V2}{dest}")
    _set_session_cookie(response, token)
    return response


# ── Google OAuth ──────────────────────────────────────────────────────────────

@router.get("/login")
def login(request: Request, next: str = "/"):
    """Redirect to Google's consent screen."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(503, "Google OAuth not configured (GOOGLE_CLIENT_ID missing)")
    state = secrets.token_urlsafe(32)
    _states[state] = next
    params = {
        "client_id":     GOOGLE_CLIENT_ID,
        "redirect_uri":  GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope":         "openid email profile",
        "state":         state,
        "access_type":   "online",
        "prompt":        "select_account",
    }
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")


@router.get("/callback")
async def callback(request: Request, code: str = "", state: str = "", error: str = ""):
    if error:
        return RedirectResponse(f"{APP_ORIGIN_V2}/login?error={error}")
    if state not in _states:
        raise HTTPException(400, "Invalid OAuth state - possible CSRF")
    redirect_after = _states.pop(state)
    if not code:
        raise HTTPException(400, "Missing authorization code")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(GOOGLE_TOKEN_URL, data={
            "code": code, "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": GOOGLE_REDIRECT_URI, "grant_type": "authorization_code",
        })
    if token_resp.status_code != 200:
        raise HTTPException(502, "Failed to exchange Google auth code")

    access_tok = token_resp.json().get("access_token")

    async with httpx.AsyncClient() as client:
        user_resp = await client.get(GOOGLE_USER_URL,
                                     headers={"Authorization": f"Bearer {access_tok}"})
    if user_resp.status_code != 200:
        raise HTTPException(502, "Failed to fetch Google user info")

    profile   = user_resp.json()
    google_id = profile.get("sub")
    email     = profile.get("email", "").lower()
    name      = profile.get("name", email)
    avatar    = profile.get("picture", "")

    if not google_id:
        raise HTTPException(502, "Google did not return a user ID")
    if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
        return RedirectResponse(f"{APP_ORIGIN_V2}/login?error=not_allowed")

    return _finalize_login(google_id, email, name, avatar, redirect_after)


# ── GitHub OAuth ──────────────────────────────────────────────────────────────

@router.get("/github/login")
def github_login(request: Request, next: str = "/"):
    """Redirect to GitHub's consent screen."""
    if not GITHUB_CLIENT_ID:
        raise HTTPException(503, "GitHub OAuth not configured (GITHUB_CLIENT_ID missing)")
    state = secrets.token_urlsafe(32)
    _states[state] = next
    params = {
        "client_id":    GITHUB_CLIENT_ID,
        "scope":        "read:user user:email",
        "state":        state,
        "allow_signup": "true",
    }
    return RedirectResponse(f"{GITHUB_AUTH_URL}?{urlencode(params)}")


@router.get("/github/callback")
async def github_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    if error:
        return RedirectResponse(f"{APP_ORIGIN_V2}/login?error={error}")
    if state not in _states:
        raise HTTPException(400, "Invalid OAuth state - possible CSRF")
    redirect_after = _states.pop(state)
    if not code:
        raise HTTPException(400, "Missing authorization code")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            GITHUB_TOKEN_URL,
            data={"client_id": GITHUB_CLIENT_ID, "client_secret": GITHUB_CLIENT_SECRET, "code": code},
            headers={"Accept": "application/json"},
        )
    if token_resp.status_code != 200:
        raise HTTPException(502, "Failed to exchange GitHub auth code")

    access_tok = token_resp.json().get("access_token")
    if not access_tok:
        raise HTTPException(502, "GitHub did not return an access token")

    gh_headers = {"Authorization": f"Bearer {access_tok}", "Accept": "application/json"}

    async with httpx.AsyncClient() as client:
        user_resp = await client.get(GITHUB_USER_URL, headers=gh_headers)
    if user_resp.status_code != 200:
        raise HTTPException(502, "Failed to fetch GitHub user info")

    profile   = user_resp.json()
    github_id = profile.get("id")
    name      = profile.get("name") or profile.get("login", "")
    avatar    = profile.get("avatar_url", "")
    email     = (profile.get("email") or "").lower()

    if not github_id:
        raise HTTPException(502, "GitHub did not return a user ID")

    # Fetch primary verified email if the profile email is private
    if not email:
        async with httpx.AsyncClient() as client:
            emails_resp = await client.get(GITHUB_EMAILS_URL, headers=gh_headers)
        if emails_resp.status_code == 200:
            for entry in emails_resp.json():
                if entry.get("primary") and entry.get("verified"):
                    email = entry["email"].lower()
                    break
    if not email:
        email = f"{profile.get('login', github_id)}@users.noreply.github.com"

    if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
        return RedirectResponse(f"{APP_ORIGIN_V2}/login?error=not_allowed")

    # Prefix GitHub IDs to avoid collision with Google's numeric-string IDs
    user_id = f"gh_{github_id}"
    return _finalize_login(user_id, email, name, avatar, redirect_after)


# ── Onboarding ────────────────────────────────────────────────────────────────

@router.post("/seed-demo")
def seed_demo(user: dict = Depends(require_user)):
    """
    Opt-in demo vault seeding. Only seeds if the user has zero docs.
    Called from the first-login onboarding prompt in the UI.
    """
    seeded = seed_demo_data(user["sub"])
    return {"seeded": seeded}


# ── Session endpoints ─────────────────────────────────────────────────────────

@router.get("/me")
def me(user: dict = Depends(require_user)):
    return {
        "user_id": user["sub"],
        "email":   user["email"],
        "name":    user["name"],
        "avatar":  user.get("avatar", ""),
    }


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie("pa_session", path="/")
    return {"ok": True}


# ── Internal helpers ──────────────────────────────────────────────────────────

def _init_user_settings(user_id: str, email: str, name: str, avatar: str) -> bool:
    """Upsert the user settings singleton. Returns True on first-ever login (new user)."""
    SessionLocal = get_session_factory(user_id)
    with SessionLocal() as db:
        existing = db.query(UserSettings).filter(UserSettings.id == "singleton").first()
        if not existing:
            db.add(UserSettings(
                id="singleton",
                google_email=email,
                display_name=name,
                avatar_url=avatar,
                updated_at=_now(),
            ))
            db.commit()
            return True
        existing.google_email = email
        if name:   existing.display_name = name
        if avatar: existing.avatar_url = avatar
        existing.updated_at = _now()
        db.commit()
        return False
