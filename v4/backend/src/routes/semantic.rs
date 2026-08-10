use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::embed::{self, combined_score, cosine_similarity, doc_embed_text, structural_similarity};
use crate::meta_db;
use crate::models::{AuthUser, DocContext, DocSummary, SectionSearchResult, SimilarDoc};
use crate::store::{file, AppState};

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

// ── GET /docs/{id}/similar ────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct TopKQuery { pub top_k: Option<usize> }

pub async fn get_similar(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<TopKQuery>,
) -> Res<Vec<SimilarDoc>> {
    let top_k = q.top_k.unwrap_or(10).min(50);
    let user_root = state.user_root_dir(&user.sub);
    let docs_dir  = state.user_docs_dir(&user.sub);

    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    // Get or compute the query doc's embedding
    let query_embedding = match meta_db::load_embedding(&pool, id).await.ok().flatten() {
        Some(e) => e,
        None => {
            // Try to compute on the fly (best-effort — may fail if no API key)
            let path = crate::store::file::find_doc_path(&docs_dir, id)
                .ok_or_else(|| err(StatusCode::NOT_FOUND, "doc not found"))?;
            let doc = file::parse_doc(&path).map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;
            let text = doc_embed_text(&doc.title, &doc.description, &doc.body);
            let settings = meta_db::get_settings(&pool).await.unwrap_or_default();
            embed::embed_text(&settings, &state.fernet_key, &text).await
                .map(|(e, _)| e)
                .map_err(|e| err(StatusCode::PAYMENT_REQUIRED, &format!("no embedding available — {e}")))?
        }
    };

    // Load all embeddings
    let all_embeddings = meta_db::load_all_embeddings(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    // Load doc metadata for titles/previews
    let all_docs: Vec<_> = file::load_all_docs(&docs_dir).into_iter().map(|(d, _)| d).collect();
    let doc_map: std::collections::HashMap<Uuid, _> = all_docs.iter().map(|d| (d.id, d)).collect();

    let mut results: Vec<SimilarDoc> = all_embeddings.iter()
        .filter_map(|(doc_id_str, emb)| {
            let doc_id: Uuid = doc_id_str.parse().ok()?;
            if doc_id == id { return None; } // skip self
            let doc = doc_map.get(&doc_id)?;
            let semantic = cosine_similarity(&query_embedding, emb);
            let structural = structural_similarity(id, doc_id, &state.index, &user.sub);
            let combined = combined_score(semantic, structural);
            Some(SimilarDoc {
                id: doc_id,
                title: doc.title.clone(),
                doc_type: doc.doc_type.clone(),
                description: doc.description.clone(),
                body_preview: doc.body.chars().take(200).collect(),
                semantic_score: semantic,
                structural_score: structural,
                combined_score: combined,
                updated_at: doc.updated_at,
            })
        })
        .collect();

    results.sort_by(|a, b| b.combined_score.partial_cmp(&a.combined_score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);

    Ok(Json(results))
}

// ── POST /docs/search/semantic ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SemanticSearchRequest {
    pub q: String,
    pub top_k: Option<usize>,
}

pub async fn semantic_search(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<SemanticSearchRequest>,
) -> Res<Vec<SimilarDoc>> {
    let top_k = body.top_k.unwrap_or(10).min(50);
    let user_root = state.user_root_dir(&user.sub);
    let docs_dir  = state.user_docs_dir(&user.sub);

    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let settings = meta_db::get_settings(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let (query_embedding, _) = embed::embed_text(&settings, &state.fernet_key, &body.q).await
        .map_err(|e| err(StatusCode::PAYMENT_REQUIRED, &format!("embedding unavailable — {e}")))?;

    let all_embeddings = meta_db::load_all_embeddings(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let all_docs: Vec<_> = file::load_all_docs(&docs_dir).into_iter().map(|(d, _)| d).collect();
    let doc_map: std::collections::HashMap<Uuid, _> = all_docs.iter().map(|d| (d.id, d)).collect();

    let mut results: Vec<SimilarDoc> = all_embeddings.iter()
        .filter_map(|(doc_id_str, emb)| {
            let doc_id: Uuid = doc_id_str.parse().ok()?;
            let doc = doc_map.get(&doc_id)?;
            let semantic = cosine_similarity(&query_embedding, emb);
            Some(SimilarDoc {
                id: doc_id,
                title: doc.title.clone(),
                doc_type: doc.doc_type.clone(),
                description: doc.description.clone(),
                body_preview: doc.body.chars().take(200).collect(),
                semantic_score: semantic,
                structural_score: 0.0,
                combined_score: semantic,
                updated_at: doc.updated_at,
            })
        })
        .collect();

    results.sort_by(|a, b| b.combined_score.partial_cmp(&a.combined_score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);

    Ok(Json(results))
}

// ── GET /docs/{id}/context ────────────────────────────────────────────────────

pub async fn get_doc_context(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Res<DocContext> {
    let docs_dir = state.user_docs_dir(&user.sub);

    let file_name = state.index.get_file_name(&user.sub, id)
        .or_else(|| file::find_doc_path(&docs_dir, id)
            .and_then(|p| p.file_name()?.to_str().map(String::from)))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "doc not found"))?;
    let doc = file::parse_doc(&docs_dir.join(&file_name))
        .map_err(|_| err(StatusCode::NOT_FOUND, "doc not found"))?;

    // Forward links → DocSummary
    let forward_links: Vec<DocSummary> = doc.links.iter()
        .filter_map(|l| {
            let fname = state.index.get_file_name(&user.sub, l.target_id)?;
            file::parse_doc(&docs_dir.join(fname)).ok()
        })
        .map(|d| DocSummary::from(&d))
        .collect();

    // Backlinks → DocSummary
    let backlinks: Vec<DocSummary> = state.index.backlinks_for(&user.sub, id).iter()
        .filter_map(|bl| {
            let fname = state.index.get_file_name(&user.sub, bl.source_id)?;
            file::parse_doc(&docs_dir.join(fname)).ok()
        })
        .map(|d| DocSummary::from(&d))
        .collect();

    // Siblings: other docs that share the same 'belongs_to' parent as this doc
    let my_parents: std::collections::HashSet<Uuid> = doc.links.iter()
        .filter(|l| l.label == crate::models::LinkLabel::BelongsTo)
        .map(|l| l.target_id)
        .collect();

    let siblings: Vec<DocSummary> = if my_parents.is_empty() {
        vec![]
    } else {
        // Find other docs that have an 'up' link to any of the same parents
        file::load_all_docs(&docs_dir)
            .into_iter()
            .filter_map(|(d, _)| {
                if d.id == id { return None; }
                let is_sibling = d.links.iter().any(|l| {
                    l.label == crate::models::LinkLabel::BelongsTo && my_parents.contains(&l.target_id)
                });
                if is_sibling { Some(DocSummary::from(&d)) } else { None }
            })
            .collect()
    };

    use crate::models::DocResponse;
    Ok(Json(DocContext {
        doc: DocResponse::from(&doc),
        forward_links,
        backlinks,
        siblings,
    }))
}

// ── GET /docs/search?mode=section ─────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct SectionSearchQuery {
    pub q: Option<String>,
    pub mode: Option<String>,
    pub limit: Option<usize>,
}

pub async fn section_search(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Query(q): Query<SectionSearchQuery>,
) -> Res<Vec<SectionSearchResult>> {
    let query = q.q.as_deref().unwrap_or("").to_lowercase();
    let limit = q.limit.unwrap_or(50).min(200);
    let docs_dir = state.user_docs_dir(&user.sub);

    if query.is_empty() {
        return Ok(Json(vec![]));
    }

    let docs = file::load_all_docs(&docs_dir);
    let mut results: Vec<SectionSearchResult> = Vec::new();

    for (doc, _) in &docs {
        let outline = match &doc.note_outline {
            Some(serde_json::Value::Array(items)) => items.clone(),
            _ => continue,
        };
        for item in &outline {
            let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let level = item.get("level").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
            if text.to_lowercase().contains(&query) {
                results.push(SectionSearchResult {
                    doc_id: doc.id,
                    doc_title: doc.title.clone(),
                    heading: text.to_string(),
                    heading_level: level,
                    body_preview: doc.body.chars().take(200).collect(),
                    updated_at: doc.updated_at,
                });
            }
        }
    }

    results.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    results.truncate(limit);

    Ok(Json(results))
}
