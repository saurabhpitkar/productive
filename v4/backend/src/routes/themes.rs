use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::meta_db::{self, Theme};
use crate::models::AuthUser;
use crate::store::AppState;

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

// ── GET /themes ───────────────────────────────────────────────────────────────

pub async fn list(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> Res<Vec<Theme>> {
    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let themes = meta_db::list_themes(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(themes))
}

// ── POST /themes ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateThemeRequest {
    pub title: String,
    pub description: Option<String>,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(req): Json<CreateThemeRequest>,
) -> Res<Theme> {
    if req.title.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "title must not be empty"));
    }
    let description = req.description.as_deref().unwrap_or("").chars().take(1000).collect::<String>();
    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let theme = meta_db::create_theme(&pool, req.title.trim(), &description).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(theme))
}

// ── PATCH /themes/:id ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateThemeRequest {
    pub title: Option<String>,
    pub description: Option<String>,
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateThemeRequest>,
) -> Res<Theme> {
    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let description_capped = req.description.as_deref()
        .map(|d| d.chars().take(1000).collect::<String>());

    let theme = meta_db::update_theme(
        &pool,
        &id,
        req.title.as_deref(),
        description_capped.as_deref(),
    ).await.map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    // Trigger re-embedding in background so the updated description takes effect
    let state2 = Arc::clone(&state);
    let user_sub = user.sub.clone();
    let theme_id = theme.id.clone();
    tokio::spawn(async move {
        let user_root = state2.user_root_dir(&user_sub);
        if let Ok(pool2) = meta_db::init_user_meta_db(&user_root).await {
            if let Some(t) = meta_db::get_theme(&pool2, &theme_id).await.ok().flatten() {
                let docs_dir = state2.user_docs_dir(&user_sub);
                crate::embed::embed_theme(&state2, &user_sub, &t, &docs_dir, &pool2).await;
            }
        }
    });

    Ok(Json(theme))
}

// ── DELETE /themes/:id ────────────────────────────────────────────────────────

pub async fn delete(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Res<()> {
    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    meta_db::delete_theme(&pool, &id).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(()))
}
