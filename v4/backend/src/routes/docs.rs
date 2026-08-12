use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::embed::{doc_embed_text, spawn_embed_task};
use crate::meta_db;
use crate::models::{
    AuthMethod, AuthUser, BatchCreateRequest, BatchCreateResponse, CreateDocRequest,
    CreateLinkRequest, Doc, DocLifecycle, DocLink, DocResponse, DocSummary, LinkLabel,
    LinkResponse, SubtreeEdge, SubtreeNode, SubtreeResponse, UpdateDocRequest,
};
use crate::store::{file, git, AppState};

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

fn resolve_doc_path(
    state: &AppState,
    user_id: &str,
    docs_dir: &std::path::Path,
    doc_id: Uuid,
) -> Result<(std::path::PathBuf, String), (StatusCode, Json<serde_json::Value>)> {
    let file_name = state.index.get_file_name(user_id, doc_id)
        .or_else(|| {
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
    pub summary: Option<bool>,
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
        let s = d.task_status.to_string();
        if status_filter == "archived" { s == "archived" }
        else if status_filter == "active" { s != "archived" }
        else { s == status_filter }
    });

    if let Some(p) = &q.priority { docs.retain(|d| d.priority.as_ref().map_or(false, |dp| dp.to_string() == *p)); }
    if let Some(flag) = q.flag { docs.retain(|d| d.flag == flag); }
    if let Some(lid) = q.list_id { docs.retain(|d| d.list_id == Some(lid)); }
    if let Some(query) = &q.q {
        let q_lower = query.to_lowercase();
        docs.retain(|d| {
            d.title.to_lowercase().contains(&q_lower)
                || d.body.to_lowercase().contains(&q_lower)
                || d.description.to_lowercase().contains(&q_lower)
        });
    }

    docs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let limit = q.limit.unwrap_or(1000);
    docs.truncate(limit);

    if q.summary.unwrap_or(false) {
        let items: Vec<DocSummary> = docs.iter().map(DocSummary::from).collect();
        let total = items.len();
        return Ok(Json(serde_json::json!({ "items": items, "total": total, "limit": limit, "offset": 0 })));
    }

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
    let now = Utc::now();
    let auth_method = match &user.auth_method {
        AuthMethod::Cookie => "cookie",
        AuthMethod::Pat => "pat",
    };
    let generated = Some(file::make_generated(body.writer.as_deref(), auth_method));

    let mut doc = Doc {
        id: Uuid::new_v4(),
        doc_type: body.doc_type.unwrap_or_else(|| "Note".to_string()),
        title: body.name,
        description: body.description.unwrap_or_default(),
        body: body.body.unwrap_or_default(),
        lifecycle: body.lifecycle.as_deref().and_then(|s| s.parse().ok()).unwrap_or_default(),
        stale_after: body.stale_after,
        generated,
        verified: vec![],
        task_status: body.task_status.as_deref().and_then(|s| s.parse().ok()).unwrap_or_default(),
        priority: body.priority.as_deref().filter(|s| !s.is_empty()).and_then(|s| s.parse().ok()),
        flag: body.flag.unwrap_or(false),
        due_date: body.due_date,
        due_time: body.due_time,
        list_id: body.list_id,
        tags: body.tags.unwrap_or_default(),
        theme_ids: vec![],
        links: body.links.as_deref().unwrap_or(&[]).iter()
            .filter_map(|l| {
                let label: LinkLabel = l.label.as_deref().unwrap_or("related_to").parse().ok()?;
                Some(DocLink { target_id: l.target_doc_id, label, title: l.title.clone(), source: Some("manual".to_string()) })
            })
            .collect(),
        hitl_required: body.hitl_required.unwrap_or(false),
        hitl_status: None,
        note_outline: None,
        vector_keywords: vec![],
        keyword_source_hash: None,
        created_at: now,
        updated_at: now,
    };
    doc.note_outline = Some(file::compute_outline(&doc.body));
    doc.vector_keywords = crate::store::keywords::extract_keywords(&doc.title, &doc.description, &doc.body);
    doc.keyword_source_hash = Some(crate::store::keywords::source_hash(&doc.title, &doc.body));

    let docs_dir = state.user_docs_dir(&user.sub);
    let path = file::write_doc(&docs_dir, &doc, None)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("create: {}", doc.title)).ok();
    state.index.upsert(&user.sub, &doc, &file_name);

    // Ensure a file watcher is running for this user (no-op if already started).
    crate::store::AppState::ensure_user_watched(&state, &user.sub);

    // Background embedding — non-blocking
    spawn_embed_task(
        state.clone(), user.sub.clone(), doc.id,
        doc_embed_text(&doc.title, &doc.description, &doc.body),
    );

    // Activity log (fire-and-forget)
    {
        let user_root_act = state.user_root_dir(&user.sub);
        let actor = if matches!(user.auth_method, AuthMethod::Cookie) { "human:user" } else { "agent:pat-client" };
        let after_snap = serde_json::to_value(DocResponse::from(&doc)).ok();
        let doc_id = doc.id;
        let actor_s = actor.to_string();
        tokio::spawn(async move {
            if let Ok(pool) = meta_db::init_user_meta_db(&user_root_act).await {
                meta_db::log_activity(&pool, doc_id, "created", &actor_s, None, after_snap.as_ref(), None).await.ok();
            }
        });
    }

    Ok(Json(DocResponse::from(&doc)))
}

// ── Batch create ──────────────────────────────────────────────────────────────

pub async fn batch_create(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    Json(body): Json<BatchCreateRequest>,
) -> Res<BatchCreateResponse> {
    let user_root = state.user_root_dir(&user.sub);
    let meta_pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    // Idempotency check
    let idem_key = headers.get("x-idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    if let Some(ref key) = idem_key {
        if let Ok(Some(cached)) = meta_db::check_idempotency_key(&meta_pool, key).await {
            let resp: BatchCreateResponse = serde_json::from_value(cached)
                .unwrap_or(BatchCreateResponse { created: vec![], idempotent_replay: true });
            return Ok(Json(resp));
        }
    }

    let auth_method = match &user.auth_method {
        AuthMethod::Cookie => "cookie",
        AuthMethod::Pat => "pat",
    };
    let docs_dir = state.user_docs_dir(&user.sub);
    let mut created = Vec::new();

    for req in body.docs {
        let now = Utc::now();
        let generated = Some(file::make_generated(req.writer.as_deref(), auth_method));
        let mut doc = Doc {
            id: Uuid::new_v4(),
            doc_type: req.doc_type.unwrap_or_else(|| "Note".to_string()),
            title: req.name,
            description: req.description.unwrap_or_default(),
            body: req.body.unwrap_or_default(),
            lifecycle: req.lifecycle.as_deref().and_then(|s| s.parse().ok()).unwrap_or_default(),
            stale_after: req.stale_after,
            generated,
            verified: vec![],
            task_status: req.task_status.as_deref().and_then(|s| s.parse().ok()).unwrap_or_default(),
            priority: req.priority.as_deref().filter(|s| !s.is_empty()).and_then(|s| s.parse().ok()),
            flag: req.flag.unwrap_or(false),
            due_date: req.due_date,
            due_time: req.due_time,
            list_id: req.list_id,
            tags: req.tags.unwrap_or_default(),
            theme_ids: vec![],
            links: req.links.as_deref().unwrap_or(&[]).iter()
                .filter_map(|l| {
                    let label: LinkLabel = l.label.as_deref().unwrap_or("related_to").parse().ok()?;
                    Some(DocLink { target_id: l.target_doc_id, label, title: l.title.clone(), source: Some("manual".to_string()) })
                })
                .collect(),
            hitl_required: req.hitl_required.unwrap_or(false),
            hitl_status: None,
            note_outline: None,
            vector_keywords: vec![],
            keyword_source_hash: None,
            created_at: now,
            updated_at: now,
        };
        doc.note_outline = Some(file::compute_outline(&doc.body));
        doc.vector_keywords = crate::store::keywords::extract_keywords(&doc.title, &doc.description, &doc.body);
        doc.keyword_source_hash = Some(crate::store::keywords::source_hash(&doc.title, &doc.body));

        let path = file::write_doc(&docs_dir, &doc, None)
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

        let user_root = state.user_root_dir(&user.sub);
        git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("create: {}", doc.title)).ok();
        state.index.upsert(&user.sub, &doc, &file_name);
        spawn_embed_task(
            state.clone(), user.sub.clone(), doc.id,
            doc_embed_text(&doc.title, &doc.description, &doc.body),
        );
        created.push(DocResponse::from(&doc));
    }

    let response = BatchCreateResponse { created, idempotent_replay: false };

    // Store idempotency result
    if let Some(ref key) = idem_key {
        if let Ok(v) = serde_json::to_value(&response) {
            meta_db::store_idempotency_key(&meta_pool, key, &v).await.ok();
        }
    }

    Ok(Json(response))
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

// ── Subtree traversal ─────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct SubtreeQuery {
    pub depth: Option<u32>,
    pub labels: Option<String>,
}

pub async fn get_subtree(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<SubtreeQuery>,
) -> Res<SubtreeResponse> {
    let max_depth = q.depth.unwrap_or(3).min(10);
    let label_filter: Option<HashSet<String>> = q.labels.as_deref().map(|s| {
        s.split(',').map(|p| p.trim().to_string()).collect()
    });

    let docs_dir = state.user_docs_dir(&user.sub);

    // Verify root exists
    resolve_doc_path(&state, &user.sub, &docs_dir, id)
        .map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;

    let mut visited: HashSet<Uuid> = HashSet::new();
    let mut nodes: Vec<SubtreeNode> = Vec::new();
    let mut edges: Vec<SubtreeEdge> = Vec::new();
    let mut queue: VecDeque<(Uuid, u32)> = VecDeque::new();

    visited.insert(id);
    queue.push_back((id, 0));

    while let Some((current_id, depth)) = queue.pop_front() {
        // Resolve doc for node metadata — try index first, fall back to file read
        let node = if let Some(meta) = state.index.get_meta(&user.sub, current_id) {
            // Build SubtreeNode from cheap in-memory meta
            let path = docs_dir.join(&meta.file_name);
            let (body_preview, link_count) = file::parse_doc(&path)
                .map(|d| (d.body.chars().take(200).collect::<String>(), d.links.len()))
                .unwrap_or_default();
            SubtreeNode {
                id: current_id,
                title: meta.title.clone(),
                doc_type: "Note".to_string(), // meta doesn't cache doc_type yet; acceptable for BFS
                description: String::new(),
                task_status: meta.task_status.clone(),
                lifecycle: "stable".to_string(),
                priority: meta.priority.clone(),
                hitl_required: false,
                link_count,
                body_preview,
            }
        } else {
            // Full file read fallback (e.g. index not warmed after restart)
            let path = match file::find_doc_path(&docs_dir, current_id) {
                Some(p) => p,
                None => continue,
            };
            match file::parse_doc(&path) {
                Ok(d) => SubtreeNode::from(&d),
                Err(_) => continue,
            }
        };
        nodes.push(node);

        if depth >= max_depth { continue; }

        let forward = state.index.forward_links_for(&user.sub, current_id);
        for fwd in forward {
            // Apply label filter
            if let Some(ref allowed) = label_filter {
                if !allowed.contains(&fwd.label.to_string()) { continue; }
            }
            edges.push(SubtreeEdge {
                source_id: current_id,
                target_id: fwd.target_id,
                label: fwd.label.to_string(),
            });
            if !visited.contains(&fwd.target_id) {
                visited.insert(fwd.target_id);
                queue.push_back((fwd.target_id, depth + 1));
            }
        }
    }

    Ok(Json(SubtreeResponse { root_id: id, depth: max_depth, nodes, edges }))
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
    let before_snap = serde_json::to_value(DocResponse::from(&doc)).ok();

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
    let auth_method_str = match &user.auth_method {
        AuthMethod::Cookie => "cookie",
        AuthMethod::Pat => "pat",
    };
    let content_changed = body.name.is_some() || body.body.is_some() || body.description.is_some();

    if let Some(name) = body.name { doc.title = name; }
    if let Some(b) = body.body {
        doc.body = b;
        doc.note_outline = Some(file::compute_outline(&doc.body));
    }
    if let Some(d) = body.description { doc.description = d; }
    if let Some(dt) = body.doc_type { doc.doc_type = dt; }
    if let Some(s) = body.task_status { doc.task_status = s.parse().unwrap_or_default(); }
    if let Some(l) = body.lifecycle { doc.lifecycle = l.parse().unwrap_or(DocLifecycle::Stable); }
    if let Some(v) = body.stale_after {
        doc.stale_after = if v.is_null() { None } else { v.as_str().map(String::from) };
    }
    if let Some(p) = &body.priority {
        doc.priority = if p.is_empty() { None } else { p.parse().ok() };
    }
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
                Some(DocLink { target_id: l.target_doc_id, label, title: l.title.clone(), source: Some("manual".to_string()) })
            })
            .collect();
    }

    // Refresh keywords when title, description, or body changed
    if content_changed {
        if crate::store::keywords::should_refresh(&doc.title, &doc.body, doc.keyword_source_hash.as_deref()) {
            doc.vector_keywords = crate::store::keywords::extract_keywords(&doc.title, &doc.description, &doc.body);
            doc.keyword_source_hash = Some(crate::store::keywords::source_hash(&doc.title, &doc.body));
        }
    }

    // Update provenance
    doc.generated = Some(file::make_generated(body.writer.as_deref(), auth_method_str));
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
    spawn_embed_task(
        state.clone(), user.sub.clone(), doc.id,
        doc_embed_text(&doc.title, &doc.description, &doc.body),
    );

    // Activity log (fire-and-forget)
    {
        let user_root_act = state.user_root_dir(&user.sub);
        let actor_s = auth_method_str.to_string();
        let after_snap = serde_json::to_value(DocResponse::from(&doc)).ok();
        let doc_id = doc.id;
        tokio::spawn(async move {
            if let Ok(pool) = meta_db::init_user_meta_db(&user_root_act).await {
                meta_db::log_activity(&pool, doc_id, "updated", &actor_s, before_snap.as_ref(), after_snap.as_ref(), None).await.ok();
            }
        });
    }

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
        let before_snap = serde_json::to_value(DocResponse::from(&doc)).ok();
        let actor = if matches!(user.auth_method, AuthMethod::Cookie) { "human:user" } else { "agent:pat-client" };
        meta_db::log_deletion(&pool, id, "doc").await.ok();
        meta_db::log_activity(&pool, id, "deleted", actor, before_snap.as_ref(), None, None).await.ok();
        // Remove embedding so deleted docs don't appear in future pairwise comparisons.
        meta_db::delete_embedding(&pool, id).await.ok();
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Links ─────────────────────────────────────────────────────────────────────

pub async fn get_links(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<HashMap<String, String>>,
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
            title: l.title.clone(),
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

    if !doc.links.iter().any(|l| l.target_id == body.target_doc_id && l.label == label) {
        doc.links.push(DocLink { target_id: body.target_doc_id, label: label.clone(), title: body.title.clone(), source: Some("manual".to_string()) });
    }

    doc.updated_at = Utc::now();
    file::write_doc(&docs_dir, &doc, Some(&file_name))
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("link: {}", doc.title)).ok();
    state.index.upsert(&user.sub, &doc, &file_name);

    // Log the link creation (fire-and-forget)
    {
        let user_root_act = user_root.clone();
        let actor = if matches!(user.auth_method, AuthMethod::Cookie) { "human:user" } else { "agent:pat-client" };
        let actor_s = actor.to_string();
        let snap = serde_json::to_value(DocResponse::from(&doc)).ok();
        let doc_id = doc.id;
        tokio::spawn(async move {
            if let Ok(pool) = meta_db::init_user_meta_db(&user_root_act).await {
                meta_db::log_activity(&pool, doc_id, "linked", &actor_s, None, snap.as_ref(), None).await.ok();
            }
        });
    }

    Ok(Json(LinkResponse {
        source_doc_id: id,
        target_doc_id: body.target_doc_id,
        label: label.to_string(),
        title: body.title,
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

    // Log the link removal (fire-and-forget)
    {
        let user_root_act = user_root.clone();
        let actor = if matches!(user.auth_method, AuthMethod::Cookie) { "human:user" } else { "agent:pat-client" };
        let actor_s = actor.to_string();
        let snap = serde_json::to_value(DocResponse::from(&doc)).ok();
        let doc_id = doc.id;
        tokio::spawn(async move {
            if let Ok(pool) = meta_db::init_user_meta_db(&user_root_act).await {
                meta_db::log_activity(&pool, doc_id, "unlinked", &actor_s, None, snap.as_ref(), None).await.ok();
            }
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_backlinks(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<HashMap<String, String>>,
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
                title: link.title.clone(),
                created_at: doc.created_at,
            });
        }
    }
    Ok(Json(links))
}

// ── SubtreeNode From<&Doc> ────────────────────────────────────────────────────

impl From<&Doc> for SubtreeNode {
    fn from(d: &Doc) -> Self {
        SubtreeNode {
            id: d.id,
            title: d.title.clone(),
            doc_type: d.doc_type.clone(),
            description: d.description.clone(),
            task_status: d.task_status.to_string(),
            lifecycle: d.lifecycle.to_string(),
            priority: d.priority.as_ref().map(|p| p.to_string()),
            hitl_required: d.hitl_required,
            link_count: d.links.len(),
            body_preview: d.body.chars().take(200).collect(),
        }
    }
}
