use std::sync::Arc;

use axum::{extract::{Query, State}, http::StatusCode, Json};
use serde::Deserialize;

use crate::meta_db;
use crate::models::{AuthUser, DocResponse, ListResponse};
use crate::store::{file, AppState};

#[derive(Deserialize)]
pub struct SinceQuery { pub since: Option<String> }

pub async fn delta(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Query(q): Query<SinceQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let user_root = state.user_root_dir(&user.sub);
    let docs_dir = state.user_docs_dir(&user.sub);

    let since = q.since.as_deref().unwrap_or("1970-01-01T00:00:00Z");
    let since_dt = since.parse::<chrono::DateTime<chrono::Utc>>().unwrap_or(chrono::DateTime::UNIX_EPOCH);

    let meta_pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"detail": e.to_string()}))))?;

    // Docs updated since
    let docs_with_files = file::load_all_docs(&docs_dir);
    let updated_docs: Vec<DocResponse> = docs_with_files.iter()
        .filter(|(d, _)| d.updated_at > since_dt)
        .map(|(d, _)| DocResponse::from(d))
        .collect();

    // Deleted IDs since
    let deleted_doc_ids = meta_db::deletions_since(&meta_pool, since, "doc").await.unwrap_or_default();
    let deleted_list_ids = meta_db::deletions_since(&meta_pool, since, "list").await.unwrap_or_default();

    // All lists with doc_ids computed from docs_with_files
    let raw_lists = file::load_lists(&user_root);
    let all_docs_vec: Vec<_> = docs_with_files.into_iter().map(|(d, _)| d).collect();
    let lists: Vec<ListResponse> = raw_lists.iter()
        .map(|l| ListResponse::from_list(l, &all_docs_vec))
        .collect();

    Ok(Json(serde_json::json!({
        "docs": updated_docs,
        "lists": lists,
        "deleted_doc_ids": deleted_doc_ids,
        "deleted_list_ids": deleted_list_ids,
        "synced_at": chrono::Utc::now().to_rfc3339(),
    })))
}
