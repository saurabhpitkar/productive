use std::sync::Arc;

use axum::{extract::{Query, State}, http::StatusCode, Json};
use serde::Deserialize;

use crate::meta_db;
use crate::models::AuthUser;
use crate::store::AppState;

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

#[derive(Deserialize, Default)]
pub struct ActivityQuery {
    pub limit: Option<i64>,
    pub since: Option<String>,
}

// GET /activity-log?limit=50&since=ISO8601
pub async fn get_activity_log(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Query(q): Query<ActivityQuery>,
) -> Res<Vec<meta_db::ActivityLogEntry>> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let entries = meta_db::fetch_activity_log(&pool, limit, q.since.as_deref()).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    Ok(Json(entries))
}
