use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::meta_db;
use crate::models::{
    AuthUser, AuthMethod, CreateDocRequest, CreateLinkRequest, DocLink, DocResponse,
    LinkLabel, LinkResponse, UpdateDocRequest,
};
use crate::store::{file, git, AppState};

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

/// Look up a doc's file path via the in-memory index, falling back to a filesystem scan.
fn resolve_doc_path(
    state: &AppState,
    user_id: &str,
    docs_dir: &std::path::Path,
    doc_id: Uuid,
) -> Result<(std::path::PathBuf, String), (StatusCode, Json<serde_json::Value>)> {
    let file_name = state.index.get_file_name(user_id, doc_id)
        .or_else(|| {
            // Fallback: scan filesystem (e.g. after restart before index is warmed)
            file::find_doc_path(docs_dir, doc_id)
                .and_then(|p| p.file_name()?.to_str().map(String::from))
        })
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "doc not found"))?;
    Ok((docs_dir.join(&file_name), file_name))
}

// ── List ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct ListQuery {
    pub q: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub flag: Option<bool>,
    pub list_id: Option<Uuid>,
    pub limit: Option<usize>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let mut docs: Vec<_> = file::load_all_docs(&docs_dir)
        .into_iter()
        .map(|(d, _)| d)
        .collect();

    let status_filter = q.status.as_deref().unwrap_or("active");
    docs.retain(|d| {
        let s = d.status.to_string();
        if status_filter == "archived" { s == "archived" }
        else if status_filter == "active" { s != "archived" }
        else { s == status_filter }
    });

    if let Some(p) = &q.priority { docs.retain(|d| d.priority.to_string() == *p); }
    if let Some(flag) = q.flag { docs.retain(|d| d.flag == flag); }
    if let Some(lid) = q.list_id { docs.retain(|d| d.list_id == Some(lid)); }
    if let Some(query) = &q.q {
        let q_lower = query.to_lowercase();
        docs.retain(|d| d.title.to_lowercase().contains(&q_lower) || d.body.to_lowercase().contains(&q_lower));
    }

    docs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let limit = q.limit.unwrap_or(1000);
    docs.truncate(limit);

    let items: Vec<DocResponse> = docs.iter().map(DocResponse::from).collect();
    let total = items.len();
    Ok(Json(serde_json::json!({ "items": items, "total": total, "limit": limit, "offset": 0 })))
}

// ── Create ────────────────────────────────────────────────────────────────────

pub async fn create(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<CreateDocRequest>,
) -> Res<DocResponse> {
    use crate::models::{Doc, DocPriority, DocStatus};
    use std::collections::HashMap;

    let now = Utc::now();
    let mut doc = Doc {
        id: Uuid::new_v4(),
        title: body.name,
        description: String::new(),
        body: body.body.unwrap_or_default(),
        status: body.status.as_deref().and_then(|s| s.parse().ok()).unwrap_or_default(),
        priority: body.priority.as_deref().and_then(|s| s.parse().ok()).unwrap_or_default(),
        flag: body.flag.unwrap_or(false),
        due_date: body.due_date,
        due_time: body.due_time,
        list_id: body.list_id,
        tags: body.tags.unwrap_or_default(),
        links: body.links.as_deref().unwrap_or(&[]).iter()
            .filter_map(|l| {
                let label: LinkLabel = l.label.as_deref().unwrap_or("related_to").parse().ok()?;
                Some(DocLink { target_id: l.target_doc_id, label })
            })
            .collect(),
        hitl_required: body.hitl_required.unwrap_or(false),
        hitl_status: None,
        note_outline: None,
        created_at: now,
        updated_at: now,
    };
    doc.note_outline = Some(file::compute_outline(&doc.body));

    let docs_dir = state.user_docs_dir(&user.sub);
    let path = file::write_doc(&docs_dir, &doc, None)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("create: {}", doc.title)).ok();
    state.index.upsert(&user.sub, &doc, &file_name);

    Ok(Json(DocResponse::from(&doc)))
}

// ── Get ───────────────────────────────────────────────────────────────────────

pub async fn get(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Res<DocResponse> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let (path, _) = resolve_doc_path(&state, &user.sub, &docs_dir, id)?;
    let doc = file::parse_doc(&path).map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;
    Ok(Json(DocResponse::from(&doc)))
}

// ── Update ────────────────────────────────────────────────────────────────────

pub async fn update(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateDocRequest>,
) -> Result<axum::response::Response, (StatusCode, Json<serde_json::Value>)> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let (path, current_file_name) = resolve_doc_path(&state, &user.sub, &docs_dir, id)?;
    let mut doc = file::parse_doc(&path).map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;

    // HITL gate
    if doc.hitl_required && user.auth_method == AuthMethod::Pat && !user.pat_trusted {
        let user_root = state.user_root_dir(&user.sub);
        let meta_pool = meta_db::init_user_meta_db(&user_root).await
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        let pending = meta_db::count_pending_hitl(&meta_pool, &doc.id.to_string()).await;
        if pending > 0 {
            return Ok((StatusCode::CONFLICT, Json(serde_json::json!({"detail": "review already pending"}))).into_response());
        }
        let payload = serde_json::to_value(&body).unwrap_or_default();
        let review = meta_db::create_hitl_review(&meta_pool, id, &payload, None).await
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        doc.hitl_status = Some("pending".to_string());
        doc.updated_at = Utc::now();
        file::write_doc(&docs_dir, &doc, Some(&current_file_name)).ok();
        state.index.upsert(&user.sub, &doc, &current_file_name);
        return Ok((StatusCode::ACCEPTED, Json(serde_json::json!({
            "review_id": review.id, "status": "pending", "message": "HITL review created"
        }))).into_response());
    }

    // Direct write
    if let Some(name) = body.name { doc.title = name; }
    if let Some(b) = body.body {
        doc.body = b;
        doc.note_outline = Some(file::compute_outline(&doc.body));
    }
    if let Some(s) = body.status { doc.status = s.parse().unwrap_or_default(); }
    if let Some(p) = body.priority { doc.priority = p.parse().unwrap_or_default(); }
    if let Some(f) = body.flag { doc.flag = f; }
    if let Some(v) = body.due_date {
        doc.due_date = if v.is_null() { None } else { v.as_str().map(String::from) };
    }
    if let Some(v) = body.due_time {
        doc.due_time = if v.is_null() { None } else { v.as_str().map(String::from) };
    }
    if let Some(v) = body.list_id {
        doc.list_id = if v.is_null() { None } else { v.as_str().and_then(|s| s.parse().ok()) };
    }
    if let Some(t) = body.tags { doc.tags = t; }
    if let Some(hr) = body.hitl_required {
        if user.auth_method == AuthMethod::Pat {
            return Err(err(StatusCode::FORBIDDEN, "PAT callers cannot set hitl_required"));
        }
        doc.hitl_required = hr;
    }
    if let Some(v) = body.hitl_status {
        doc.hitl_status = if v.is_null() { None } else { v.as_str().map(String::from) };
    }
    if let Some(links_req) = body.links {
        doc.links = links_req.iter()
            .filter_map(|l| {
                let label: LinkLabel = l.label.as_deref().unwrap_or("related_to").parse().ok()?;
                if l.target_doc_id == id { return None; }
                Some(DocLink { target_id: l.target_doc_id, label })
            })
            .collect();
    }
    doc.updated_at = Utc::now();

    let new_path = file::write_doc(&docs_dir, &doc, Some(&current_file_name))
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let new_file_name = new_path.file_name().unwrap_or_default().to_string_lossy().to_string();

    let user_root = state.user_root_dir(&user.sub);
    if new_file_name != current_file_name {
        git::commit_rename(
            &user_root,
            &format!("docs/{}", current_file_name),
            &format!("docs/{}", new_file_name),
            &format!("rename: {} -> {}", current_file_name, new_file_name),
        ).ok();
    } else {
        git::commit_file(&user_root, &format!("docs/{}", new_file_name), &format!("update: {}", doc.title)).ok();
    }
    state.index.upsert(&user.sub, &doc, &new_file_name);

    Ok(Json(DocResponse::from(&doc)).into_response())
}

// ── Delete ────────────────────────────────────────────────────────────────────

pub async fn delete(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let (path, file_name) = resolve_doc_path(&state, &user.sub, &docs_dir, id)?;
    let doc = file::parse_doc(&path).map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;

    file::delete_doc_file(&docs_dir, &file_name)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let user_root = state.user_root_dir(&user.sub);
    git::commit_remove(&user_root, &format!("docs/{}", file_name), &format!("delete: {}", doc.title)).ok();
    state.index.remove(&user.sub, id);

    let meta_pool = meta_db::init_user_meta_db(&user_root).await.ok();
    if let Some(pool) = meta_pool {
        meta_db::log_deletion(&pool, id, "doc").await.ok();
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Links ─────────────────────────────────────────────────────────────────────

pub async fn get_links(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Res<Vec<LinkResponse>> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let (path, _) = resolve_doc_path(&state, &user.sub, &docs_dir, id)?;
    let doc = file::parse_doc(&path).map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;

    let label_filter = q.get("label").map(String::as_str);
    let links: Vec<LinkResponse> = doc.links.iter()
        .filter(|l| label_filter.map(|f| l.label.to_string() == f).unwrap_or(true))
        .map(|l| LinkResponse {
            source_doc_id: id,
            target_doc_id: l.target_id,
            label: l.label.to_string(),
            created_at: doc.created_at,
        })
        .collect();

    Ok(Json(links))
}

pub async fn add_link(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<CreateLinkRequest>,
) -> Res<LinkResponse> {
    if body.target_doc_id == id {
        return Err(err(StatusCode::BAD_REQUEST, "self-links are not allowed"));
    }
    let label: LinkLabel = body.label.as_deref().unwrap_or("related_to").parse()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid label"))?;

    let docs_dir = state.user_docs_dir(&user.sub);
    let (path, file_name) = resolve_doc_path(&state, &user.sub, &docs_dir, id)?;
    let mut doc = file::parse_doc(&path).map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;

    // No-op if link already exists with same label
    if !doc.links.iter().any(|l| l.target_id == body.target_doc_id && l.label == label) {
        doc.links.push(DocLink { target_id: body.target_doc_id, label: label.clone() });
    }

    doc.updated_at = Utc::now();
    file::write_doc(&docs_dir, &doc, Some(&file_name))
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("link: {}", doc.title)).ok();
    state.index.upsert(&user.sub, &doc, &file_name);

    Ok(Json(LinkResponse {
        source_doc_id: id,
        target_doc_id: body.target_doc_id,
        label: label.to_string(),
        created_at: doc.created_at,
    }))
}

pub async fn remove_link(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path((id, target_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let (path, file_name) = resolve_doc_path(&state, &user.sub, &docs_dir, id)?;
    let mut doc = file::parse_doc(&path).map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;

    let before = doc.links.len();
    doc.links.retain(|l| l.target_id != target_id);
    if doc.links.len() == before {
        return Err(err(StatusCode::NOT_FOUND, "link not found"));
    }

    doc.updated_at = Utc::now();
    file::write_doc(&docs_dir, &doc, Some(&file_name))
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("unlink: {}", doc.title)).ok();
    state.index.upsert(&user.sub, &doc, &file_name);

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_backlinks(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Res<Vec<DocResponse>> {
    let label_filter = q.get("label").map(String::as_str);
    let backlinks = state.index.backlinks_for(&user.sub, id);
    let docs_dir = state.user_docs_dir(&user.sub);
    let mut results = Vec::new();
    for bl in &backlinks {
        if label_filter.map(|f| bl.label.to_string() != f).unwrap_or(false) { continue; }
        if let Some(file_name) = state.index.get_file_name(&user.sub, bl.source_id) {
            let path = docs_dir.join(&file_name);
            if let Ok(doc) = file::parse_doc(&path) {
                results.push(DocResponse::from(&doc));
            }
        }
    }
    Ok(Json(results))
}

// ── All links ─────────────────────────────────────────────────────────────────

pub async fn all_links(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> Res<Vec<LinkResponse>> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let docs: Vec<_> = file::load_all_docs(&docs_dir).into_iter().map(|(d, _)| d).collect();
    let mut links = Vec::new();
    for doc in &docs {
        for link in &doc.links {
            links.push(LinkResponse {
                source_doc_id: doc.id,
                target_doc_id: link.target_id,
                label: link.label.to_string(),
                created_at: doc.created_at,
            });
        }
    }
    Ok(Json(links))
}
