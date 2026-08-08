from sqlalchemy import Column, String, Boolean, JSON, Integer, ForeignKey, Text, Float
from sqlalchemy.orm import relationship
from .database import Base

# Link labels: up (broader context/MOC), requires (dependency), related_to (lateral)
LINK_LABELS = ("up", "requires", "related_to")


class DocLink(Base):
    __tablename__ = "doc_link"

    source_doc_id = Column(String, ForeignKey("doc.id", ondelete="CASCADE"), primary_key=True)
    target_doc_id = Column(String, ForeignKey("doc.id", ondelete="CASCADE"), primary_key=True)
    label         = Column(String, nullable=False, default="related_to")  # up | requires | related_to
    created_at    = Column(String, nullable=False)


class Doc(Base):
    __tablename__ = "doc"

    id            = Column(String, primary_key=True)
    name          = Column(String, nullable=False)
    body          = Column('note', String, nullable=False, default="")
    note_outline  = Column(String, nullable=False, default="[]")
    due_date      = Column(String, nullable=True)
    due_time      = Column(String, nullable=True)
    flag          = Column(Boolean, nullable=True)
    list_id       = Column(String, ForeignKey("list.id", ondelete="SET NULL"), nullable=True)
    priority      = Column(String, nullable=True)
    status        = Column(String, nullable=False, default="todo")
    tags          = Column(JSON, nullable=False, default=dict)
    embedding     = Column(Text, nullable=True)   # JSON array of floats (model embedding vector)
    hitl_required = Column(Boolean, nullable=False, default=False)
    hitl_status   = Column(String, nullable=True)   # None | "pending"
    created_at    = Column(String, nullable=False)
    updated_at    = Column(String, nullable=False)

    outgoing_links = relationship(
        "DocLink",
        foreign_keys=[DocLink.source_doc_id],
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    incoming_links = relationship(
        "DocLink",
        foreign_keys=[DocLink.target_doc_id],
        lazy="selectin",
        viewonly=True,
    )


class List(Base):
    __tablename__ = "list"

    id         = Column(String, primary_key=True)
    list_name  = Column(String, nullable=False)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)

    docs = relationship("Doc", backref="list", lazy="select")


class Attachment(Base):
    """Metadata for file attachments. Bytes are stored on the filesystem."""
    __tablename__ = "attachment"

    id         = Column(String, primary_key=True)
    doc_id     = Column(String, ForeignKey("doc.id", ondelete="CASCADE"), nullable=False)
    filename   = Column(String, nullable=False)
    mime_type  = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    file_path  = Column(String, nullable=False)   # relative to ATTACHMENTS_DIR
    created_at = Column(String, nullable=False)

    doc = relationship("Doc", backref="attachments")


class HitlReview(Base):
    """Proposed change to a HITL-protected doc that awaits human approval."""
    __tablename__ = "hitl_review"

    id               = Column(String, primary_key=True)
    doc_id           = Column(String, ForeignKey("doc.id", ondelete="CASCADE"), nullable=False)
    proposed_payload = Column(Text, nullable=False)   # JSON dict of fields the agent tried to set
    agent_pat_prefix = Column(String, nullable=True)  # first 14 chars of the pa_… token
    outcome          = Column(String, nullable=True)  # None | "approved" | "rejected" | "cancelled"
    human_notes      = Column(Text, nullable=True)
    created_at       = Column(String, nullable=False)
    resolved_at      = Column(String, nullable=True)


class DeletionLog(Base):
    """Tombstone table: records hard-deleted docs and lists so delta sync can propagate deletions."""
    __tablename__ = "deletion_log"

    id         = Column(String, primary_key=True)   # UUID of the deleted item
    item_type  = Column(String, nullable=False)      # "doc" or "list"
    deleted_at = Column(String, nullable=False)      # ISO timestamp


class AiContext(Base):
    """Named text blocks injected into the AI system prompt."""
    __tablename__ = "ai_context"

    key        = Column(String, primary_key=True)   # e.g. 'guardrails', 'persona', 'domain'
    content    = Column(Text, nullable=False, default="")
    updated_at = Column(String, nullable=False)


class AiUsage(Base):
    """Per-call AI token usage log for cost tracking."""
    __tablename__ = "ai_usage"

    id            = Column(String, primary_key=True)
    created_at    = Column(String, nullable=False)   # ISO datetime UTC
    provider      = Column(String, nullable=False)   # 'claude' | 'gemini'
    model         = Column(String, nullable=False)
    input_tokens  = Column(Integer, nullable=False, default=0)
    output_tokens = Column(Integer, nullable=False, default=0)
    total_tokens  = Column(Integer, nullable=False, default=0)


class UserSettings(Base):
    """
    Per-user settings stored server-side.
    The AI API key is stored encrypted (Fernet). The frontend only ever
    receives the masked version - never the plaintext or ciphertext.
    """
    __tablename__ = "user_settings"

    id                  = Column(String, primary_key=True, default="singleton")
    ai_provider         = Column(String, nullable=True)   # 'claude' | 'gemini'
    ai_model            = Column(String, nullable=True)   # model ID string
    ai_api_key_enc      = Column(Text, nullable=True)     # Fernet-encrypted key
    ai_prompt_limit     = Column(Integer, nullable=False, default=10000)
    ai_context_enabled  = Column(Boolean, nullable=False, default=True)
    display_name        = Column(String, nullable=True)
    avatar_url          = Column(String, nullable=True)
    google_email        = Column(String, nullable=True)
    updated_at          = Column(String, nullable=False)
