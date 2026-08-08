import os

# Per-user SQLite files live at {DATABASE_DIR}/{user_id}.db
DATABASE_DIR: str      = os.environ.get("DATABASE_DIR", "/data/users")
ATTACHMENTS_DIR: str   = os.environ.get("ATTACHMENTS_DIR", "/attachments")

# Google OAuth 2.0 credentials from Google Cloud Console
GOOGLE_CLIENT_ID: str     = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET: str = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI: str  = os.environ.get("GOOGLE_REDIRECT_URI", "")

# GitHub OAuth 2.0 credentials - optional alternative sign-in
# Register at github.com/settings/developers → New OAuth App
# Callback URL: {APP_ORIGIN_V2}/api/v1/auth/github/callback
GITHUB_CLIENT_ID: str     = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET: str = os.environ.get("GITHUB_CLIENT_SECRET", "")

# JWT - sign with a long random secret: openssl rand -hex 32
JWT_SECRET_KEY: str   = os.environ.get("JWT_SECRET_KEY", "change-me")
JWT_ALGORITHM: str    = "HS256"
JWT_EXPIRE_DAYS: int  = 90   # 3-month sessions

# Fernet symmetric key for encrypting user API keys at rest.
# Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
ENCRYPTION_KEY: str   = os.environ.get("ENCRYPTION_KEY", "")

# CORS - public URL of the v2 frontend
APP_ORIGIN_V2: str    = os.environ.get("APP_ORIGIN_V2", "")

# Optional email allow-list - comma-separated Google addresses that may log in.
# Leave empty to allow any Google account.
_raw_emails = os.environ.get("ALLOWED_EMAILS", "")
ALLOWED_EMAILS: list[str] = [e.strip().lower() for e in _raw_emails.split(",") if e.strip()]
