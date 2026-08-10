mod auth;
mod crypto;
mod embed;
mod meta_db;
mod models;
mod routes;
mod store;

use axum::{Router, middleware};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub use store::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let state = Arc::new(AppState::init().await?);

    // Start file watchers for all user doc directories found during index warm-up.
    // New users get their watcher started on first doc write (ensure_user_watched).
    {
        let users_dir = state.data_dir.join("users");
        if let Ok(entries) = std::fs::read_dir(&users_dir) {
            for entry in entries.flatten() {
                let user_id = entry.file_name().to_string_lossy().to_string();
                let docs_dir = entry.path().join("docs");
                if docs_dir.is_dir() {
                    AppState::ensure_user_watched(&state, &user_id);
                }
            }
        }
    }

    // Background embedding sweep — runs every 10 minutes for all users.
    // Embeds up to 20 docs per user that are missing stored embeddings.
    {
        let embed_state = Arc::clone(&state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(600));
            interval.tick().await; // skip the immediate first tick; first run is at t+10min
            loop {
                interval.tick().await;
                embed::background_embed_users(&embed_state).await;
                embed::background_embed_themes(&embed_state).await;
            }
        });
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .allow_credentials(false);

    let app = Router::new()
        .nest("/api/v1", routes::router(state.clone()))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let bind = std::env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8000".to_string());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on {}", bind);
    axum::serve(listener, app).await?;
    Ok(())
}
