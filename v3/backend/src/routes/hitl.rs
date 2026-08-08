use std::sync::Arc;

use axum::{extract::{Path, Query, State}, http::StatusCode, Json};
use serde::Deserialize;

use crate::meta_db::{self, HitlReview};
use crate::models::{AuthMethod, AuthUser, DocResponse};
use crate::store::{file, AppState};

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

#[derive(Deserialize, Default)]
pub struct ReviewsQuery {
    pub outcome: Option<String>,
    pub doc_id: Option<String>,
    pub submitted_by: Option<String>,
}

pub async fn list_reviews(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Query(q): Query<ReviewsQuery>,
) -> Res<Vec<HitlReview>> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let all_outcomes = q.outcome.as_deref() == Some("all");
    let mut rows = meta_db::fetch_reviews(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    if !all_outcomes {
        rows.retain(|r| r.outcome.is_none());
    }
    if let Some(doc_id) = &q.doc_id {
        rows.retain(|r| &r.doc_id == doc_id);
    }
    if let Some(submitted_by) = &q.submitted_by {
        rows.retain(|r| r.agent_pat_prefix.as_deref() == Some(submitted_by.as_str()));
    }

    Ok(Json(rows))
}

pub async fn get_review(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let review = meta_db::fetch_review_by_id(&pool, &id).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "review not found"))?;

    let doc_id: uuid::Uuid = review.doc_id.parse()
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "invalid doc_id in review"))?;
    let docs_dir = state.user_docs_dir(&user.sub);
    let doc_current = file::find_doc_path(&docs_dir, doc_id)
        .and_then(|path| file::parse_doc(&path).ok())
        .map(|d| serde_json::to_value(DocResponse::from(&d)).unwrap_or_default());

    let mut val = serde_json::to_value(&review).unwrap_or_default();
    if let serde_json::Value::Object(ref mut map) = val {
        map.insert("doc_current".to_string(), doc_current.unwrap_or(serde_json::Value::Null));
    }
    Ok(Json(val))
}

#[derive(Deserialize)]
pub struct ResolveRequest {
    pub outcome: String,
    pub human_notes: Option<String>,
}

pub async fn resolve_review(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<ResolveRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    if user.auth_method == AuthMethod::Pat && !user.pat_trusted {
        return Err(err(StatusCode::FORBIDDEN, "only trusted tokens or browser users can resolve reviews"));
    }

    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let review = meta_db::fetch_review_by_id(&pool, &id).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "review not found"))?;

    if review.outcome.is_some() {
        return Err(err(StatusCode::CONFLICT, "review already resolved"));
    }

    meta_db::resolve_hitl_review(&pool, &id, &body.outcome, body.human_notes.as_deref()).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let doc_id: uuid::Uuid = review.doc_id.parse()
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "invalid doc_id"))?;
    let docs_dir = state.user_docs_dir(&user.sub);
    let file_name = state.index.get_file_name(&user.sub, doc_id)
        .or_else(|| file::find_doc_path(&docs_dir, doc_id)
            .and_then(|p| p.file_name().and_then(|f| f.to_str()).map(String::from)));

    if let Some(file_name) = file_name {
        let path = docs_dir.join(&file_name);
        if body.outcome == "approved" {
            let payload: crate::models::UpdateDocRequest = serde_json::from_str(&review.proposed_payload)
                .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
            if let Ok(mut doc) = file::parse_doc(&path) {
                if let Some(b) = payload.body {
                    doc.body = b;
                    doc.note_outline = Some(file::compute_outline(&doc.body));
                }
                if let Some(s) = payload.status { doc.status = s.parse().unwrap_or_default(); }
                if let Some(p) = payload.priority { doc.priority = p.parse().unwrap_or_default(); }
                doc.hitl_status = None;
                doc.updated_at = chrono::Utc::now();
                file::write_doc(&docs_dir, &doc, Some(&file_name)).ok();
                crate::store::git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("hitl approved: {}", doc.title)).ok();
                state.index.upsert(&user.sub, &doc, &file_name);
            }
        } else if let Ok(mut doc) = file::parse_doc(&path) {
            doc.hitl_status = None;
            doc.updated_at = chrono::Utc::now();
            file::write_doc(&docs_dir, &doc, Some(&file_name)).ok();
            state.index.upsert(&user.sub, &doc, &file_name);
        }
    }

    Ok(StatusCode::OK)
}
