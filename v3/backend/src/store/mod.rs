pub mod file;
pub mod git;
pub mod index;
pub mod watch;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use sqlx::SqlitePool;

use self::index::DocIndex;

/// Shared application state threaded through all route handlers.
pub struct AppState {
    pub data_dir: PathBuf,
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
}

impl AppState {
    pub async fn init() -> Result<Self> {
        let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "/data/v3".to_string()));
        std::fs::create_dir_all(&data_dir)?;

        let token_db_path = data_dir.join("api_tokens.db");
        let token_db = crate::meta_db::init_token_db(&token_db_path).await?;

        let index = Arc::new(DocIndex::new());

        let allowed_emails = std::env::var("ALLOWED_EMAILS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();

        Ok(AppState {
            data_dir,
            index,
            token_db,
            jwt_secret: std::env::var("JWT_SECRET_KEY")
                .unwrap_or_else(|_| "dev-secret-change-me".to_string()),
            fernet_key: std::env::var("FERNET_KEY").unwrap_or_default(),
            google_client_id: std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
            google_client_secret: std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default(),
            google_redirect_uri: std::env::var("GOOGLE_REDIRECT_URI")
                .unwrap_or_else(|_| "http://localhost:3003/api/v1/auth/callback".to_string()),
            github_client_id: std::env::var("GITHUB_CLIENT_ID").unwrap_or_default(),
            github_client_secret: std::env::var("GITHUB_CLIENT_SECRET").unwrap_or_default(),
            app_origin: std::env::var("APP_ORIGIN_V3")
                .unwrap_or_else(|_| "http://localhost:3003".to_string()),
            allowed_emails,
        })
    }

    /// Returns the directory where a user's docs are stored, creating it if needed.
    pub fn user_docs_dir(&self, user_id: &str) -> PathBuf {
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
