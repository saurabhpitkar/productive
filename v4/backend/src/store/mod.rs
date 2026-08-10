pub mod file;
pub mod git;
pub mod index;
pub mod watch;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use dashmap::DashSet;
use sqlx::SqlitePool;

use self::index::DocIndex;

/// Shared application state threaded through all route handlers.
pub struct AppState {
    pub data_dir: PathBuf,
    /// When set via `DOCS_DIR` env var, all users share this flat folder for docs (single-user/local mode).
    pub docs_dir: Option<PathBuf>,
    pub index: Arc<DocIndex>,
    /// Global token store (PAT hashes)
    pub token_db: SqlitePool,
    pub jwt_secret: String,
    pub fernet_key: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    pub google_redirect_uri: String,
    pub github_client_id: String,
    pub github_client_secret: String,
    pub app_origin: String,
    pub allowed_emails: Vec<String>,
    /// Minimum confidence (0.0–1.0) for auto-routing inbox notes without HITL.
    pub route_threshold: f32,
    /// Tracks which users already have an active file-system watcher.
    pub watched_users: Arc<DashSet<String>>,
}

impl AppState {
    pub async fn init() -> Result<Self> {
        let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "/data/v4".to_string()));
        std::fs::create_dir_all(&data_dir)?;

        // Optional: if DOCS_DIR is set (non-empty), docs for all users live in this flat folder (single-user/local mode).
        let docs_dir: Option<PathBuf> = std::env::var("DOCS_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|d| {
                let p = PathBuf::from(d);
                std::fs::create_dir_all(&p).ok();
                p
            });

        let token_db_path = data_dir.join("api_tokens.db");
        let token_db = crate::meta_db::init_token_db(&token_db_path).await?;

        let index = Arc::new(DocIndex::new());

        // Warm up the in-memory index from all docs that already exist on disk.
        // Without this, traverse_subtree and link lookups return empty results
        // for every doc that pre-dates the current server startup.
        let users_dir = data_dir.join("users");
        if let Ok(user_entries) = std::fs::read_dir(&users_dir) {
            for user_entry in user_entries.flatten() {
                let user_id = user_entry.file_name().to_string_lossy().to_string();
                // When DOCS_DIR is set, all users share that flat folder; otherwise use per-user docs/
                let scan_dir = if let Some(ref dd) = docs_dir {
                    dd.clone()
                } else {
                    user_entry.path().join("docs")
                };
                if !scan_dir.is_dir() { continue; }
                let mut count = 0u32;
                if let Ok(doc_entries) = std::fs::read_dir(&scan_dir) {
                    for doc_entry in doc_entries.flatten() {
                        let path = doc_entry.path();
                        if path.extension().map(|e| e == "md").unwrap_or(false) {
                            if let Ok(doc) = file::parse_doc(&path) {
                                let fname = path.file_name()
                                    .and_then(|f| f.to_str())
                                    .unwrap_or("")
                                    .to_string();
                                index.upsert(&user_id, &doc, &fname);
                                count += 1;
                            }
                        }
                    }
                }
                tracing::info!("index warm-up: {} docs for user {}", count, user_id);
            }
        }

        let allowed_emails = std::env::var("ALLOWED_EMAILS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();

        Ok(AppState {
            data_dir,
            docs_dir,
            index,
            token_db,
            watched_users: Arc::new(DashSet::new()),
            jwt_secret: std::env::var("JWT_SECRET_KEY")
                .unwrap_or_else(|_| "dev-secret-change-me".to_string()),
            fernet_key: std::env::var("FERNET_KEY").unwrap_or_default(),
            google_client_id: std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
            google_client_secret: std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default(),
            google_redirect_uri: std::env::var("GOOGLE_REDIRECT_URI")
                .unwrap_or_else(|_| "http://localhost:3003/api/v1/auth/callback".to_string()),
            github_client_id: std::env::var("GITHUB_CLIENT_ID").unwrap_or_default(),
            github_client_secret: std::env::var("GITHUB_CLIENT_SECRET").unwrap_or_default(),
            app_origin: std::env::var("APP_ORIGIN_V4")
                .unwrap_or_else(|_| "http://localhost:3005".to_string()),
            allowed_emails,
            route_threshold: std::env::var("ROUTE_THRESHOLD")
                .ok()
                .and_then(|s| s.parse::<f32>().ok())
                .unwrap_or(0.80)
                .clamp(0.0, 1.0),
        })
    }

    /// Ensure a file watcher is active for this user's docs directory.
    /// Safe to call on every request — no-ops if already watching.
    pub fn ensure_user_watched(state: &Arc<Self>, user_id: &str) {
        if state.watched_users.contains(user_id) { return; }
        state.watched_users.insert(user_id.to_string());
        let docs_dir = state.user_docs_dir(user_id);
        watch::spawn_watcher(user_id.to_string(), docs_dir, Arc::clone(state));
        tracing::info!("started watcher for user {}", user_id);
    }

    /// Returns the directory where a user's docs are stored, creating it if needed.
    /// When `DOCS_DIR` is set, all users share that flat folder (single-user / local-folder mode).
    pub fn user_docs_dir(&self, user_id: &str) -> PathBuf {
        if let Some(ref dd) = self.docs_dir {
            std::fs::create_dir_all(dd).ok();
            return dd.clone();
        }
        let dir = self.data_dir.join("users").join(user_id).join("docs");
        std::fs::create_dir_all(&dir).ok();
        dir
    }

    /// Returns the user's root dir (parent of docs/).
    pub fn user_root_dir(&self, user_id: &str) -> PathBuf {
        let dir = self.data_dir.join("users").join(user_id);
        std::fs::create_dir_all(&dir).ok();
        dir
    }
}
