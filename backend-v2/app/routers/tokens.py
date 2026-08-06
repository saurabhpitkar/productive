from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_user
from ..token_store import create_token, list_tokens, revoke_token, set_token_trusted

router = APIRouter(prefix="/tokens", tags=["tokens"])


class TokenCreate(BaseModel):
    name: str


@router.get("")
def get_tokens(user: dict = Depends(require_user)):
    return list_tokens(user["sub"])


@router.post("", status_code=201)
def new_token(body: TokenCreate, user: dict = Depends(require_user)):
    name = body.name.strip() or "API Token"
    raw, record = create_token(user["sub"], name)
    # raw token returned exactly once - never stored in plaintext, never returned again
    return {**record, "token": raw}


@router.delete("/{token_id}", status_code=204)
def delete_token(token_id: str, user: dict = Depends(require_user)):
    if not revoke_token(user["sub"], token_id):
        raise HTTPException(404, "Token not found")


class TokenTrustUpdate(BaseModel):
    trusted: bool


@router.patch("/{token_id}/trusted", status_code=200)
def update_token_trusted(token_id: str, body: TokenTrustUpdate, user: dict = Depends(require_user)):
    if user.get("auth_method") != "cookie":
        raise HTTPException(403, "Trusted flag can only be changed from the browser UI")
    if not set_token_trusted(user["sub"], token_id, body.trusted):
        raise HTTPException(404, "Token not found")
    return {"ok": True, "trusted": body.trusted}
