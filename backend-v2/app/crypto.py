"""
Fernet symmetric encryption for storing user API keys at rest.
The ENCRYPTION_KEY env var is the Fernet key (URL-safe base64, 32 bytes).
If not set, a warning is logged and keys are stored plaintext (dev-only).
"""
import logging
from cryptography.fernet import Fernet, InvalidToken
from .config import ENCRYPTION_KEY

_fernet: Fernet | None = None


def _get_fernet() -> Fernet | None:
    global _fernet
    if _fernet is None and ENCRYPTION_KEY:
        try:
            _fernet = Fernet(ENCRYPTION_KEY.encode())
        except Exception:
            logging.error("ENCRYPTION_KEY is invalid - API keys will be stored plaintext")
    if _fernet is None:
        logging.warning("ENCRYPTION_KEY not set - API keys stored plaintext (dev only)")
    return _fernet


def encrypt_key(plaintext: str) -> str:
    f = _get_fernet()
    if f is None:
        return plaintext
    return f.encrypt(plaintext.encode()).decode()


def decrypt_key(ciphertext: str) -> str:
    f = _get_fernet()
    if f is None:
        return ciphertext
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except (InvalidToken, Exception):
        return ""


def mask_key(plaintext: str) -> str:
    """Return a redacted version safe to send to the frontend."""
    if not plaintext or len(plaintext) < 8:
        return "••••••••"
    return plaintext[:6] + "••••••••" + plaintext[-4:]
