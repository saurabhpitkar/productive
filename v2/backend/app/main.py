import logging
import traceback
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import APP_ORIGIN_V2, DATABASE_DIR
from .routers import docs, lists, sync
from .routers import auth as auth_router
from .routers import ai as ai_router
from .routers import attachments as attach_router
from .routers import tokens as tokens_router
from .routers import hitl as hitl_router
from .token_store import init_db

# Ensure data directories exist and global token DB is initialised
os.makedirs(DATABASE_DIR, exist_ok=True)
init_db()

app = FastAPI(title="Productive API v2", version="2.0.0", docs_url="/api/docs")

# ── CORS ──────────────────────────────────────────────────────────────────────
_origins = [APP_ORIGIN_V2] if APP_ORIGIN_V2 else ["http://localhost:3001"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    allow_credentials=True,   # needed for httpOnly cookie auth
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth_router.router, prefix="/api/v1")
app.include_router(docs.router,        prefix="/api/v1")
app.include_router(lists.router,       prefix="/api/v1")
app.include_router(sync.router,        prefix="/api/v1")
app.include_router(ai_router.router,   prefix="/api/v1")
app.include_router(attach_router.router,  prefix="/api/v1")
app.include_router(tokens_router.router, prefix="/api/v1")
app.include_router(hitl_router.router,   prefix="/api/v1")


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.0"}


@app.exception_handler(Exception)
async def generic_handler(_request: Request, exc: Exception):
    logging.error(traceback.format_exc())
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})
