"""
JWT-based authentication for v2.
Tokens are issued after Google OAuth and stored in httpOnly cookies (90-day expiry).
"""
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import jwt
from fastapi import Cookie, HTTPException, Request, status

from .config import (
    JWT_SECRET_KEY, JWT_ALGORITHM, JWT_EXPIRE_DAYS, ALLOWED_EMAILS,
)


def create_jwt(user_id: str, email: str, name: str, avatar_url: str = "") -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub":    user_id,
        "email":  email,
        "name":   name,
        "avatar": avatar_url,
        "iat":    int(now.timestamp()),
        "exp":    int((now + timedelta(days=JWT_EXPIRE_DAYS)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired - please log in again")
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid session token")


def get_current_user(request: Request) -> dict:
    # 1. Cookie auth (browser / frontend)
    cookie_token = request.cookies.get("pa_session")
    if cookie_token:
        payload = decode_jwt(cookie_token)
        if ALLOWED_EMAILS and payload.get("email", "").lower() not in ALLOWED_EMAILS:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This Google account is not authorised")
        return {**payload, "auth_method": "cookie"}

    # 2. Bearer header (external API / agents)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        bearer = auth_header[7:].strip()
        if bearer.startswith("pa_"):
            # Personal access token - validate against global token store
            from .token_store import validate_token
            info = validate_token(bearer)
            if not info:
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or revoked API token")
            return {
                "sub":         info["user_id"],
                "email":       "",
                "name":        "",
                "avatar":      "",
                "auth_method": "pat",
                "pat_prefix":  bearer[:14],
                "pat_trusted": info["trusted"],
            }
        else:
            # Fall back to JWT decode for any non-PAT bearer usage
            payload = decode_jwt(bearer)
            if ALLOWED_EMAILS and payload.get("email", "").lower() not in ALLOWED_EMAILS:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "This Google account is not authorised")
            return {**payload, "auth_method": "cookie"}

    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")


def require_user(request: Request) -> dict:
    """FastAPI dependency that returns the decoded JWT payload."""
    return get_current_user(request)


COOKIE_MAX_AGE = JWT_EXPIRE_DAYS * 86400  # seconds
