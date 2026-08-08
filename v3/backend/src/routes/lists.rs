use std::sync::Arc;

use axum::{extract::{Path, State}, http::StatusCode, Json};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::meta_db;
use crate::models::{AuthUser, List, ListResponse};
use crate::store::{file, git, AppState};

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

pub async fn list(State(state): State<Arc<AppState>>, user: AuthUser) -> Res<Vec<ListResponse>> {
    let user_root = state.user_root_dir(&user.sub);
    let docs_dir  = state.user_docs_dir(&user.sub);
    let all_docs: Vec<_> = file::load_all_docs(&docs_dir).into_iter().map(|(d, _)| d).collect();
    let lists = file::load_lists(&user_root);
    Ok(Json(lists.iter().map(|l| ListResponse::from_list(l, &all_docs)).collect()))
}

#[derive(Deserialize)]
pub struct CreateListRequest {
    // Accept both `list_name` (frontend) and `name` (legacy)
    #[serde(alias = "name")]
    pub list_name: String,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<CreateListRequest>,
) -> Res<ListResponse> {
    let user_root = state.user_root_dir(&user.sub);
    let mut lists = file::load_lists(&user_root);
    let now  = Utc::now();
    let list = List { id: Uuid::new_v4(), name: body.list_name, created_at: now, updated_at: now };
    lists.push(list.clone());
    file::save_lists(&user_root, &lists).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    git::commit_file(&user_root, "_lists.yaml", &format!("create list: {}", list.name)).ok();
    // Newly created list has no docs yet
    Ok(Json(ListResponse::from_list(&list, &[])))
}

#[derive(Deserialize)]
pub struct UpdateListRequest {
    // Accept both `list_name` (frontend) and `name` (legacy)
    #[serde(alias = "name")]
    pub list_name: Option<String>,
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateListRequest>,
) -> Res<ListResponse> {
    let user_root = state.user_root_dir(&user.sub);
    let docs_dir  = state.user_docs_dir(&user.sub);
    let mut lists = file::load_lists(&user_root);
    let list = lists.iter_mut().find(|l| l.id == id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "list not found"))?;
    if let Some(name) = body.list_name { list.name = name; }
    list.updated_at = Utc::now();
    let updated = list.clone();
    file::save_lists(&user_root, &lists).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    git::commit_file(&user_root, "_lists.yaml", &format!("update list: {}", updated.name)).ok();
    let all_docs: Vec<_> = file::load_all_docs(&docs_dir).into_iter().map(|(d, _)| d).collect();
    Ok(Json(ListResponse::from_list(&updated, &all_docs)))
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let user_root = state.user_root_dir(&user.sub);
    let mut lists = file::load_lists(&user_root);
    let before = lists.len();
    lists.retain(|l| l.id != id);
    if lists.len() == before { return Err(err(StatusCode::NOT_FOUND, "list not found")); }

    file::save_lists(&user_root, &lists).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    git::commit_file(&user_root, "_lists.yaml", "delete list").ok();

    // Log deletion for sync/delta
    let meta_pool = meta_db::init_user_meta_db(&user_root).await.ok();
    if let Some(pool) = meta_pool {
        meta_db::log_deletion(&pool, id, "list").await.ok();
    }

    Ok(StatusCode::NO_CONTENT)
}
