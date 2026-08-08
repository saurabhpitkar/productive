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
    pub ai_prompt_limit: Option<i64>,
    pub ai_context_guardrails: Option<String>,
    pub ai_context_persona: Option<String>,
    pub ai_context_domain: Option<String>,
}

pub async fn get_settings(pool: &SqlitePool) -> Result<UserSettings> {
    let row = sqlx::query(
        "SELECT ai_provider, ai_model, ai_api_key_enc, ai_prompt_limit,
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
