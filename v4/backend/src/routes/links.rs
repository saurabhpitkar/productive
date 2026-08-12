use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::meta_db::{self, LinkProposal, LinkSettings};
use crate::models::{AuthUser, LinkLabel};
use crate::store::AppState;

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

// ── GET /links/settings ───────────────────────────────────────────────────────

pub async fn get_settings(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> Res<LinkSettings> {
    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let s = meta_db::get_link_settings(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(s))
}

// ── PATCH /links/settings ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LinkSettingsPatch {
    pub links_enabled: Option<bool>,
    pub links_capture: Option<bool>,
    pub links_chat: Option<bool>,
    pub links_require_review: Option<bool>,
    pub link_auto_threshold: Option<f32>,
}

pub async fn update_settings(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(patch): Json<LinkSettingsPatch>,
) -> Res<LinkSettings> {
    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let current = meta_db::get_link_settings(&pool).await.unwrap_or_default();

    // Clamp threshold to valid range [0.65, 0.95]
    let threshold = patch.link_auto_threshold
        .map(|v| v.clamp(0.65, 0.95))
        .unwrap_or(current.link_auto_threshold);

    let updated = LinkSettings {
        links_enabled:        patch.links_enabled.unwrap_or(current.links_enabled),
        links_capture:        patch.links_capture.unwrap_or(current.links_capture),
        links_chat:           patch.links_chat.unwrap_or(current.links_chat),
        links_require_review: patch.links_require_review.unwrap_or(current.links_require_review),
        link_auto_threshold:  threshold,
    };

    meta_db::update_link_settings(&pool, &updated).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    Ok(Json(updated))
}

// ── GET /links/proposals ──────────────────────────────────────────────────────

pub async fn list_proposals(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> Res<Vec<LinkProposal>> {
    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let proposals = meta_db::fetch_link_proposals(&pool, Some("pending")).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(proposals))
}

// ── POST /links/proposals/:id/resolve ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct ResolveProposalRequest {
    pub outcome: String, // "approved" | "rejected"
}

pub async fn resolve_proposal(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<ResolveProposalRequest>,
) -> Res<()> {
    if req.outcome != "approved" && req.outcome != "rejected" {
        return Err(err(StatusCode::BAD_REQUEST, "outcome must be 'approved' or 'rejected'"));
    }

    let pool = meta_db::init_user_meta_db(&state.user_root_dir(&user.sub)).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let proposal = meta_db::resolve_link_proposal(&pool, &id, &req.outcome).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    // If approved, create the actual link.
    // If either doc no longer exists (stale proposal from a deleted doc), reject
    // gracefully rather than propagating an error to the UI.
    if req.outcome == "approved" {
        if let Some(p) = proposal {
            let source_id: Uuid = p.source_doc_id.parse()
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid source_doc_id in proposal"))?;
            let target_id: Uuid = p.target_doc_id.parse()
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid target_doc_id in proposal"))?;
            let label: LinkLabel = p.label.parse()
                .unwrap_or(LinkLabel::RelatedTo);

            // Verify both docs still exist before attempting to link.
            let docs_dir = state.user_docs_dir(&user.sub);
            let src_ok = state.index.get_file_name(&user.sub, source_id).is_some()
                || crate::store::file::find_doc_path(&docs_dir, source_id).is_some();
            let tgt_ok = state.index.get_file_name(&user.sub, target_id).is_some()
                || crate::store::file::find_doc_path(&docs_dir, target_id).is_some();

            if src_ok && tgt_ok {
                super::inbox::do_link_docs(
                    &state, &user.sub, source_id, target_id, label, &pool,
                    p.session_id.as_deref().unwrap_or(""), "manual",
                ).await.map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
            } else {
                // One or both docs were deleted. Mark proposal rejected so it disappears.
                meta_db::resolve_link_proposal(&pool, &id, "rejected").await.ok();
                tracing::debug!("auto-rejected stale proposal {}: source_ok={} target_ok={}", id, src_ok, tgt_ok);
            }
        }
    }

    Ok(Json(()))
}
