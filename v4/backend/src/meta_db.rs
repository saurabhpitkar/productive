use std::path::Path;

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool, sqlite::SqliteConnectOptions};
use uuid::Uuid;

// ── Global token DB ───────────────────────────────────────────────────────────

pub async fn init_token_db(path: &Path) -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = SqlitePool::connect_with(opts).await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS api_token (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            hash TEXT NOT NULL UNIQUE,
            prefix TEXT NOT NULL,
            trusted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_used_at TEXT
        )"
    ).execute(&pool).await?;
    Ok(pool)
}

// ── Per-user sidecar DB ───────────────────────────────────────────────────────

pub async fn init_user_meta_db(user_root: &Path) -> Result<SqlitePool> {
    let path = user_root.join("_meta.db");
    let opts = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = SqlitePool::connect_with(opts).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_settings (
            id TEXT PRIMARY KEY DEFAULT 'singleton',
            ai_provider TEXT,
            ai_model TEXT,
            ai_api_key_enc TEXT,
            voyage_api_key_enc TEXT,
            ai_prompt_limit INTEGER DEFAULT 4000,
            ai_context_guardrails TEXT DEFAULT '',
            ai_context_persona TEXT DEFAULT '',
            ai_context_domain TEXT DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS hitl_review (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            proposed_payload TEXT NOT NULL,
            agent_pat_prefix TEXT,
            outcome TEXT,
            human_notes TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS deletion_log (
            id TEXT PRIMARY KEY,
            item_type TEXT NOT NULL,
            deleted_at TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ai_context (
            id TEXT PRIMARY KEY DEFAULT 'singleton',
            guardrails TEXT DEFAULT '',
            persona TEXT DEFAULT '',
            domain TEXT DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ai_usage (
            id TEXT PRIMARY KEY,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS activity_log (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            action TEXT NOT NULL,
            actor TEXT NOT NULL,
            before_snapshot TEXT,
            after_snapshot TEXT,
            created_at TEXT NOT NULL,
            session_id TEXT
        )"
    ).execute(&pool).await?;

    // Safe migration: add session_id column for existing databases that pre-date it
    sqlx::query("ALTER TABLE activity_log ADD COLUMN session_id TEXT")
        .execute(&pool)
        .await
        .ok(); // "duplicate column name" error is expected and ignored

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS idempotency_keys (
            key TEXT PRIMARY KEY,
            response_body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS inbox (
            id TEXT PRIMARY KEY,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            routing_result TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS doc_embedding (
            doc_id TEXT PRIMARY KEY,
            embedding TEXT NOT NULL,
            model TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS link_proposals (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            source_doc_id TEXT NOT NULL,
            target_doc_id TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT 'related_to',
            confidence REAL NOT NULL DEFAULT 0.0,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            resolved_at TEXT
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS themes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS theme_embeddings (
            theme_id TEXT PRIMARY KEY,
            embedding BLOB NOT NULL,
            model TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    // Safe migrations for link settings columns (ignored if already present)
    sqlx::query("ALTER TABLE user_settings ADD COLUMN voyage_api_key_enc TEXT")
        .execute(&pool).await.ok();
    sqlx::query("ALTER TABLE user_settings ADD COLUMN links_enabled INTEGER DEFAULT 1")
        .execute(&pool).await.ok();
    sqlx::query("ALTER TABLE user_settings ADD COLUMN links_capture INTEGER DEFAULT 1")
        .execute(&pool).await.ok();
    sqlx::query("ALTER TABLE user_settings ADD COLUMN links_chat INTEGER DEFAULT 0")
        .execute(&pool).await.ok();
    sqlx::query("ALTER TABLE user_settings ADD COLUMN links_require_review INTEGER DEFAULT 0")
        .execute(&pool).await.ok();
    sqlx::query("ALTER TABLE user_settings ADD COLUMN link_auto_threshold REAL DEFAULT 0.82")
        .execute(&pool).await.ok();
    sqlx::query("ALTER TABLE themes ADD COLUMN description TEXT NOT NULL DEFAULT ''")
        .execute(&pool).await.ok();

    // Prune expired idempotency keys on startup (best-effort, not fatal)
    sqlx::query("DELETE FROM idempotency_keys WHERE expires_at < datetime('now')")
        .execute(&pool)
        .await
        .ok();

    Ok(pool)
}

// ── Token operations ──────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ApiToken {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub prefix: String,
    pub trusted: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

pub async fn validate_token(pool: &SqlitePool, raw: &str) -> Option<(String, bool)> {
    use sha2::{Digest, Sha256};
    let hash = hex::encode(Sha256::digest(raw.as_bytes()));
    let row = sqlx::query("SELECT user_id, trusted FROM api_token WHERE hash = ?")
        .bind(&hash)
        .fetch_optional(pool)
        .await
        .ok()??;
    let user_id: String = row.try_get("user_id").ok()?;
    let trusted: i64 = row.try_get("trusted").ok()?;
    // update last_used_at
    sqlx::query("UPDATE api_token SET last_used_at = datetime('now') WHERE hash = ?")
        .bind(&hash)
        .execute(pool)
        .await
        .ok();
    Some((user_id, trusted != 0))
}

pub async fn list_tokens(pool: &SqlitePool, user_id: &str) -> Result<Vec<ApiToken>> {
    let rows = sqlx::query(
        "SELECT id, user_id, name, prefix, trusted, created_at, last_used_at
         FROM api_token WHERE user_id = ? ORDER BY created_at DESC"
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    rows.iter().map(|r| Ok(ApiToken {
        id: r.try_get("id")?,
        user_id: r.try_get("user_id")?,
        name: r.try_get("name")?,
        prefix: r.try_get("prefix")?,
        trusted: r.try_get::<i64, _>("trusted")? != 0,
        created_at: r.try_get("created_at")?,
        last_used_at: r.try_get("last_used_at")?,
    })).collect()
}

// ── HITL operations ───────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct HitlReview {
    pub id: String,
    pub doc_id: String,
    pub proposed_payload: String,
    pub agent_pat_prefix: Option<String>,
    pub outcome: Option<String>,
    pub human_notes: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

fn row_to_review(r: &sqlx::sqlite::SqliteRow) -> Result<HitlReview> {
    Ok(HitlReview {
        id: r.try_get("id")?,
        doc_id: r.try_get("doc_id")?,
        proposed_payload: r.try_get("proposed_payload")?,
        agent_pat_prefix: r.try_get("agent_pat_prefix")?,
        outcome: r.try_get("outcome")?,
        human_notes: r.try_get("human_notes")?,
        created_at: r.try_get("created_at")?,
        resolved_at: r.try_get("resolved_at")?,
    })
}

pub async fn create_hitl_review(
    pool: &SqlitePool,
    doc_id: Uuid,
    payload: &serde_json::Value,
    agent_prefix: Option<&str>,
) -> Result<HitlReview> {
    let id = Uuid::new_v4().to_string();
    let doc_id_str = doc_id.to_string();
    let payload_str = serde_json::to_string(payload)?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO hitl_review (id, doc_id, proposed_payload, agent_pat_prefix, created_at)
         VALUES (?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&doc_id_str)
    .bind(&payload_str)
    .bind(agent_prefix)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(HitlReview {
        id,
        doc_id: doc_id_str,
        proposed_payload: payload_str,
        agent_pat_prefix: agent_prefix.map(String::from),
        outcome: None,
        human_notes: None,
        created_at: now,
        resolved_at: None,
    })
}

pub async fn fetch_reviews(pool: &SqlitePool) -> Result<Vec<HitlReview>> {
    let rows = sqlx::query(
        "SELECT id, doc_id, proposed_payload, agent_pat_prefix, outcome, human_notes, created_at, resolved_at
         FROM hitl_review ORDER BY created_at DESC"
    )
    .fetch_all(pool)
    .await?;
    rows.iter().map(|r| row_to_review(r)).collect()
}

pub async fn fetch_review_by_id(pool: &SqlitePool, id: &str) -> Result<Option<HitlReview>> {
    let row = sqlx::query(
        "SELECT id, doc_id, proposed_payload, agent_pat_prefix, outcome, human_notes, created_at, resolved_at
         FROM hitl_review WHERE id = ?"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.map(|r| row_to_review(&r)).transpose()
}

pub async fn resolve_hitl_review(
    pool: &SqlitePool,
    id: &str,
    outcome: &str,
    human_notes: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE hitl_review SET outcome = ?, human_notes = ?, resolved_at = ? WHERE id = ?"
    )
    .bind(outcome)
    .bind(human_notes)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn count_pending_hitl(pool: &SqlitePool, doc_id: &str) -> i64 {
    sqlx::query("SELECT COUNT(*) as cnt FROM hitl_review WHERE doc_id = ? AND outcome IS NULL")
        .bind(doc_id)
        .fetch_one(pool)
        .await
        .and_then(|r| r.try_get::<i64, _>("cnt"))
        .unwrap_or(0)
}

// ── DeletionLog ───────────────────────────────────────────────────────────────

pub async fn log_deletion(pool: &SqlitePool, item_id: Uuid, item_type: &str) -> Result<()> {
    let id = item_id.to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT OR REPLACE INTO deletion_log (id, item_type, deleted_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(item_type)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn deletions_since(pool: &SqlitePool, since: &str, item_type: &str) -> Result<Vec<String>> {
    let rows = sqlx::query(
        "SELECT id FROM deletion_log WHERE item_type = ? AND deleted_at > ?"
    )
    .bind(item_type)
    .bind(since)
    .fetch_all(pool)
    .await?;
    rows.iter().map(|r| Ok(r.try_get::<String, _>("id")?)).collect()
}

// ── Settings & AI helpers ─────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct UserSettings {
    pub ai_provider: Option<String>,
    pub ai_model: Option<String>,
    pub ai_api_key_enc: Option<String>,
    pub voyage_api_key_enc: Option<String>,
    pub ai_prompt_limit: Option<i64>,
    pub ai_context_guardrails: Option<String>,
    pub ai_context_persona: Option<String>,
    pub ai_context_domain: Option<String>,
}

pub async fn get_settings(pool: &SqlitePool) -> Result<UserSettings> {
    let row = sqlx::query(
        "SELECT ai_provider, ai_model, ai_api_key_enc, voyage_api_key_enc, ai_prompt_limit,
                ai_context_guardrails, ai_context_persona, ai_context_domain
         FROM user_settings WHERE id = 'singleton'"
    )
    .fetch_optional(pool)
    .await?;

    Ok(match row {
        None => UserSettings::default(),
        Some(r) => UserSettings {
            ai_provider: r.try_get("ai_provider").ok(),
            ai_model: r.try_get("ai_model").ok(),
            ai_api_key_enc: r.try_get("ai_api_key_enc").ok().flatten(),
            voyage_api_key_enc: r.try_get("voyage_api_key_enc").ok().flatten(),
            ai_prompt_limit: r.try_get("ai_prompt_limit").ok(),
            ai_context_guardrails: r.try_get("ai_context_guardrails").ok(),
            ai_context_persona: r.try_get("ai_context_persona").ok(),
            ai_context_domain: r.try_get("ai_context_domain").ok(),
        },
    })
}

pub async fn upsert_settings_singleton(pool: &SqlitePool) -> Result<()> {
    sqlx::query("INSERT INTO user_settings (id) VALUES ('singleton') ON CONFLICT(id) DO NOTHING")
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn log_ai_usage(pool: &SqlitePool, model: &str, input: i64, output: i64) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO ai_usage (id, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(model)
    .bind(input)
    .bind(output)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Activity log ──────────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ActivityLogEntry {
    pub id: String,
    pub doc_id: String,
    /// Name extracted from after_snapshot or before_snapshot at query time.
    pub doc_name: Option<String>,
    /// created | updated | deleted | routed | linked | unlinked | batch_created
    pub action: String,
    /// human:user | agent:inbox-router/v4 | agent:pat-client
    pub actor: String,
    /// Groups all activity entries from a single inbox routing session.
    pub session_id: Option<String>,
    pub before_snapshot: Option<serde_json::Value>,
    pub after_snapshot: Option<serde_json::Value>,
    pub created_at: String,
}

pub async fn log_activity(
    pool: &SqlitePool,
    doc_id: Uuid,
    action: &str,
    actor: &str,
    before: Option<&serde_json::Value>,
    after: Option<&serde_json::Value>,
    session_id: Option<&str>,
) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO activity_log (id, doc_id, action, actor, before_snapshot, after_snapshot, created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(doc_id.to_string())
    .bind(action)
    .bind(actor)
    .bind(before.map(|v| v.to_string()))
    .bind(after.map(|v| v.to_string()))
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn fetch_activity_log(
    pool: &SqlitePool,
    limit: i64,
    since: Option<&str>,
) -> Result<Vec<ActivityLogEntry>> {
    let rows = if let Some(since) = since {
        sqlx::query(
            "SELECT id, doc_id, action, actor, before_snapshot, after_snapshot, created_at, session_id
             FROM activity_log WHERE created_at > ? ORDER BY created_at DESC LIMIT ?"
        )
        .bind(since)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT id, doc_id, action, actor, before_snapshot, after_snapshot, created_at, session_id
             FROM activity_log ORDER BY created_at DESC LIMIT ?"
        )
        .bind(limit)
        .fetch_all(pool)
        .await?
    };

    rows.iter().map(|r| {
        let before_raw: Option<String> = r.try_get("before_snapshot")?;
        let after_raw: Option<String> = r.try_get("after_snapshot")?;
        let before_json: Option<serde_json::Value> = before_raw.as_deref().and_then(|s| serde_json::from_str(s).ok());
        let after_json:  Option<serde_json::Value> = after_raw.as_deref().and_then(|s| serde_json::from_str(s).ok());

        // Extract doc_name from whichever snapshot is available (prefer after for create/update)
        let doc_name = after_json.as_ref()
            .and_then(|v| v["name"].as_str().map(String::from))
            .or_else(|| before_json.as_ref()
                .and_then(|v| v["name"].as_str().map(String::from)));

        Ok(ActivityLogEntry {
            id: r.try_get("id")?,
            doc_id: r.try_get("doc_id")?,
            doc_name,
            action: r.try_get("action")?,
            actor: r.try_get("actor")?,
            session_id: r.try_get("session_id")?,
            before_snapshot: before_json,
            after_snapshot: after_json,
            created_at: r.try_get("created_at")?,
        })
    }).collect()
}

// ── Idempotency keys ──────────────────────────────────────────────────────────

/// Returns the cached response body if the key exists and has not expired.
pub async fn check_idempotency_key(pool: &SqlitePool, key: &str) -> Result<Option<serde_json::Value>> {
    let row = sqlx::query(
        "SELECT response_body FROM idempotency_keys
         WHERE key = ? AND expires_at > datetime('now')"
    )
    .bind(key)
    .fetch_optional(pool)
    .await?;

    match row {
        None => Ok(None),
        Some(r) => {
            let body: String = r.try_get("response_body")?;
            Ok(serde_json::from_str(&body).ok())
        }
    }
}

/// Stores the response for an idempotency key with a 24-hour TTL.
pub async fn store_idempotency_key(
    pool: &SqlitePool,
    key: &str,
    response: &serde_json::Value,
) -> Result<()> {
    let now = Utc::now();
    let expires = (now + chrono::Duration::hours(24)).to_rfc3339();
    sqlx::query(
        "INSERT OR REPLACE INTO idempotency_keys (key, response_body, created_at, expires_at)
         VALUES (?, ?, ?, ?)"
    )
    .bind(key)
    .bind(response.to_string())
    .bind(now.to_rfc3339())
    .bind(&expires)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Doc embeddings ────────────────────────────────────────────────────────────

pub async fn store_embedding(pool: &SqlitePool, doc_id: Uuid, embedding: &[f32], model: &str) -> Result<()> {
    let json = serde_json::to_string(embedding)?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT OR REPLACE INTO doc_embedding (doc_id, embedding, model, updated_at)
         VALUES (?, ?, ?, ?)"
    )
    .bind(doc_id.to_string())
    .bind(&json)
    .bind(model)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_embedding(pool: &SqlitePool, doc_id: Uuid) -> Result<Option<Vec<f32>>> {
    let row = sqlx::query("SELECT embedding FROM doc_embedding WHERE doc_id = ?")
        .bind(doc_id.to_string())
        .fetch_optional(pool)
        .await?;
    match row {
        None => Ok(None),
        Some(r) => {
            let json: String = r.try_get("embedding")?;
            Ok(serde_json::from_str::<Vec<f32>>(&json).ok())
        }
    }
}

/// Load all stored embeddings: Vec<(doc_id_str, embedding)>
pub async fn load_all_embeddings(pool: &SqlitePool) -> Result<Vec<(String, Vec<f32>)>> {
    let rows = sqlx::query("SELECT doc_id, embedding FROM doc_embedding")
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let doc_id: String = r.try_get("doc_id")?;
        let json: String = r.try_get("embedding")?;
        if let Ok(emb) = serde_json::from_str::<Vec<f32>>(&json) {
            out.push((doc_id, emb));
        }
    }
    Ok(out)
}

pub async fn delete_embedding(pool: &SqlitePool, doc_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM doc_embedding WHERE doc_id = ?")
        .bind(doc_id.to_string())
        .execute(pool)
        .await?;
    Ok(())
}

// ── Link settings & proposals ─────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LinkSettings {
    pub links_enabled: bool,
    pub links_capture: bool,
    pub links_chat: bool,
    pub links_require_review: bool,
    /// Similarity threshold (0.0–1.0) above which links are auto-applied (when links_require_review=false).
    /// Pairs between LINK_FLOOR (0.65) and this value are always queued for review.
    /// Default: 0.82
    pub link_auto_threshold: f32,
}

pub const LINK_FLOOR: f32 = 0.65;

impl Default for LinkSettings {
    fn default() -> Self {
        LinkSettings {
            links_enabled: true,
            links_capture: true,
            links_chat: false,
            links_require_review: false,
            link_auto_threshold: 0.82,
        }
    }
}

pub async fn get_link_settings(pool: &SqlitePool) -> Result<LinkSettings> {
    let row = sqlx::query(
        "SELECT links_enabled, links_capture, links_chat, links_require_review, link_auto_threshold
         FROM user_settings WHERE id = 'singleton'"
    )
    .fetch_optional(pool).await?;

    Ok(match row {
        None => LinkSettings::default(),
        Some(r) => LinkSettings {
            links_enabled:        r.try_get::<Option<i64>, _>("links_enabled").ok().flatten().unwrap_or(1) != 0,
            links_capture:        r.try_get::<Option<i64>, _>("links_capture").ok().flatten().unwrap_or(1) != 0,
            links_chat:           r.try_get::<Option<i64>, _>("links_chat").ok().flatten().unwrap_or(0) != 0,
            links_require_review: r.try_get::<Option<i64>, _>("links_require_review").ok().flatten().unwrap_or(0) != 0,
            link_auto_threshold:  r.try_get::<Option<f64>, _>("link_auto_threshold").ok().flatten().unwrap_or(0.82) as f32,
        },
    })
}

pub async fn update_link_settings(pool: &SqlitePool, s: &LinkSettings) -> Result<()> {
    upsert_settings_singleton(pool).await?;
    sqlx::query(
        "UPDATE user_settings SET
            links_enabled = ?,
            links_capture = ?,
            links_chat = ?,
            links_require_review = ?,
            link_auto_threshold = ?,
            updated_at = datetime('now')
         WHERE id = 'singleton'"
    )
    .bind(s.links_enabled as i64)
    .bind(s.links_capture as i64)
    .bind(s.links_chat as i64)
    .bind(s.links_require_review as i64)
    .bind(s.link_auto_threshold as f64)
    .execute(pool).await?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LinkProposal {
    pub id: String,
    pub session_id: Option<String>,
    pub source_doc_id: String,
    pub target_doc_id: String,
    pub label: String,
    pub confidence: f64,
    pub status: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

pub async fn insert_link_proposal(
    pool: &SqlitePool,
    source_doc_id: Uuid,
    target_doc_id: Uuid,
    label: &str,
    confidence: f32,
    session_id: &str,
) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO link_proposals (id, session_id, source_doc_id, target_doc_id, label, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(source_doc_id.to_string())
    .bind(target_doc_id.to_string())
    .bind(label)
    .bind(confidence as f64)
    .bind(&now)
    .execute(pool).await?;
    Ok(())
}

pub async fn fetch_link_proposals(pool: &SqlitePool, status_filter: Option<&str>) -> Result<Vec<LinkProposal>> {
    let rows = if let Some(s) = status_filter {
        sqlx::query(
            "SELECT id, session_id, source_doc_id, target_doc_id, label, confidence, status, created_at, resolved_at
             FROM link_proposals WHERE status = ? ORDER BY created_at DESC"
        ).bind(s).fetch_all(pool).await?
    } else {
        sqlx::query(
            "SELECT id, session_id, source_doc_id, target_doc_id, label, confidence, status, created_at, resolved_at
             FROM link_proposals ORDER BY created_at DESC"
        ).fetch_all(pool).await?
    };

    rows.iter().map(|r| Ok(LinkProposal {
        id:            r.try_get("id")?,
        session_id:    r.try_get("session_id")?,
        source_doc_id: r.try_get("source_doc_id")?,
        target_doc_id: r.try_get("target_doc_id")?,
        label:         r.try_get("label")?,
        confidence:    r.try_get("confidence")?,
        status:        r.try_get("status")?,
        created_at:    r.try_get("created_at")?,
        resolved_at:   r.try_get("resolved_at")?,
    })).collect()
}

pub async fn resolve_link_proposal(pool: &SqlitePool, id: &str, status: &str) -> Result<Option<LinkProposal>> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE link_proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
    )
    .bind(status).bind(&now).bind(id).execute(pool).await?;

    let row = sqlx::query(
        "SELECT id, session_id, source_doc_id, target_doc_id, label, confidence, status, created_at, resolved_at
         FROM link_proposals WHERE id = ?"
    ).bind(id).fetch_optional(pool).await?;

    Ok(row.map(|r| LinkProposal {
        id:            r.try_get("id").unwrap_or_default(),
        session_id:    r.try_get("session_id").ok().flatten(),
        source_doc_id: r.try_get("source_doc_id").unwrap_or_default(),
        target_doc_id: r.try_get("target_doc_id").unwrap_or_default(),
        label:         r.try_get("label").unwrap_or_default(),
        confidence:    r.try_get("confidence").unwrap_or(0.0),
        status:        r.try_get("status").unwrap_or_default(),
        created_at:    r.try_get("created_at").unwrap_or_default(),
        resolved_at:   r.try_get("resolved_at").ok().flatten(),
    }))
}

// ── Themes ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Theme {
    pub id: String,
    pub title: String,
    pub description: String,
    pub created_at: String,
}

pub async fn create_theme(pool: &SqlitePool, title: &str, description: &str) -> Result<Theme> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO themes (id, title, description, created_at) VALUES (?, ?, ?, ?)")
        .bind(&id).bind(title).bind(description).bind(&now)
        .execute(pool).await?;
    Ok(Theme { id, title: title.to_string(), description: description.to_string(), created_at: now })
}

pub async fn update_theme(pool: &SqlitePool, id: &str, title: Option<&str>, description: Option<&str>) -> Result<Theme> {
    if let Some(t) = title {
        sqlx::query("UPDATE themes SET title = ? WHERE id = ?")
            .bind(t).bind(id).execute(pool).await?;
    }
    if let Some(d) = description {
        let capped = d.chars().take(1000).collect::<String>();
        sqlx::query("UPDATE themes SET description = ? WHERE id = ?")
            .bind(&capped).bind(id).execute(pool).await?;
    }
    get_theme(pool, id).await?.ok_or_else(|| anyhow::anyhow!("theme not found"))
}

pub async fn get_theme(pool: &SqlitePool, id: &str) -> Result<Option<Theme>> {
    let rows = sqlx::query("SELECT id, title, description, created_at FROM themes WHERE id = ?")
        .bind(id).fetch_all(pool).await?;
    Ok(rows.first().map(|r| Theme {
        id:          r.try_get("id").unwrap_or_default(),
        title:       r.try_get("title").unwrap_or_default(),
        description: r.try_get("description").unwrap_or_default(),
        created_at:  r.try_get("created_at").unwrap_or_default(),
    }))
}

pub async fn list_themes(pool: &SqlitePool) -> Result<Vec<Theme>> {
    let rows = sqlx::query("SELECT id, title, description, created_at FROM themes ORDER BY created_at ASC")
        .fetch_all(pool).await?;
    rows.iter().map(|r| Ok(Theme {
        id:          r.try_get("id")?,
        title:       r.try_get("title")?,
        description: r.try_get("description")?,
        created_at:  r.try_get("created_at")?,
    })).collect()
}

pub async fn delete_theme(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM themes WHERE id = ?")
        .bind(id).execute(pool).await?;
    sqlx::query("DELETE FROM theme_embeddings WHERE theme_id = ?")
        .bind(id).execute(pool).await.ok();
    Ok(())
}

pub async fn store_theme_embedding(pool: &SqlitePool, theme_id: &str, embedding: &[f32], model: &str) -> Result<()> {
    let bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO theme_embeddings (theme_id, embedding, model, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(theme_id) DO UPDATE SET embedding=excluded.embedding, model=excluded.model, updated_at=excluded.updated_at"
    ).bind(theme_id).bind(&bytes).bind(model).bind(&now)
     .execute(pool).await?;
    Ok(())
}

pub async fn load_theme_embeddings(pool: &SqlitePool) -> Result<Vec<(String, Vec<f32>)>> {
    let rows = sqlx::query("SELECT theme_id, embedding FROM theme_embeddings")
        .fetch_all(pool).await?;
    Ok(rows.iter().filter_map(|r| {
        let id: String = r.try_get("theme_id").ok()?;
        let bytes: Vec<u8> = r.try_get("embedding").ok()?;
        let floats = bytes.chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        Some((id, floats))
    }).collect())
}

// ── Inbox ─────────────────────────────────────────────────────────────────────

pub async fn create_inbox_entry(pool: &SqlitePool, body: &str) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO inbox (id, body, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)"
    )
    .bind(&id)
    .bind(body)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(id)
}

pub async fn update_inbox_entry(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    routing_result: Option<&serde_json::Value>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE inbox SET status = ?, routing_result = ?, updated_at = ? WHERE id = ?"
    )
    .bind(status)
    .bind(routing_result.map(|v| v.to_string()))
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_inbox_entries(pool: &SqlitePool, status: Option<&str>) -> Result<Vec<serde_json::Value>> {
    let rows = if let Some(s) = status {
        sqlx::query("SELECT id, body, status, routing_result, created_at, updated_at FROM inbox WHERE status = ? ORDER BY created_at DESC LIMIT 100")
            .bind(s)
            .fetch_all(pool)
            .await?
    } else {
        sqlx::query("SELECT id, body, status, routing_result, created_at, updated_at FROM inbox ORDER BY created_at DESC LIMIT 100")
            .fetch_all(pool)
            .await?
    };

    rows.iter().map(|r| {
        let routing_result_raw: Option<String> = r.try_get("routing_result")?;
        let routing_result = routing_result_raw.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null);
        Ok(serde_json::json!({
            "id": r.try_get::<String, _>("id")?,
            "body": r.try_get::<String, _>("body")?,
            "status": r.try_get::<String, _>("status")?,
            "routing_result": routing_result,
            "created_at": r.try_get::<String, _>("created_at")?,
            "updated_at": r.try_get::<String, _>("updated_at")?,
        }))
    }).collect()
}
