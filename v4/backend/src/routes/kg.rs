use std::collections::HashSet;
use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    embed::{self, cosine_similarity},
    meta_db,
    models::{AuthUser, LinkLabel},
    store::{file, AppState},
};
use chrono;

fn err500(e: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

// ── Storage info ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct StorageInfo {
    pub mode: String,
    pub docs_container_path: String,
    pub docs_folder_configured: bool,
}

pub async fn storage_info(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> Json<StorageInfo> {
    let docs_dir = state.user_docs_dir(&user.sub);
    Json(StorageInfo {
        mode: if state.docs_dir.is_some() {
            "local_folder".to_string()
        } else {
            "docker_volume".to_string()
        },
        docs_container_path: docs_dir.to_string_lossy().to_string(),
        docs_folder_configured: state.docs_dir.is_some(),
    })
}

// ── KG rebuild ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct KgRebuildResult {
    pub docs_scanned: usize,
    pub docs_already_embedded: usize,
    pub embeddings_updated: usize,
    pub embedding_errors: usize,
    pub docs_with_embeddings: usize,
    pub pairs_above_threshold: usize,
    pub pairs_skipped_existing: usize,
    /// Proposals already pending review before this run (queue backlog).
    pub already_pending_review: usize,
    /// New link proposals queued for human review by this run (links_require_review = true).
    pub proposals_queued_for_review: usize,
    /// Links applied directly by this run (links_require_review = false).
    pub links_auto_applied: usize,
    /// Docs newly assigned to a theme by embedding similarity this run.
    pub docs_theme_assigned: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
}

/// Scan up to 50 docs without embeddings, generate embeddings, then create
/// link_proposals for pairs with cosine similarity above 0.65.
pub async fn rebuild(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> Result<Json<KgRebuildResult>, (StatusCode, String)> {
    let docs_dir = state.user_docs_dir(&user.sub);
    let user_root = state.user_root_dir(&user.sub);

    let pool = meta_db::init_user_meta_db(&user_root).await.map_err(err500)?;
    let settings = meta_db::get_settings(&pool).await.map_err(err500)?;

    let provider = settings.ai_provider.as_deref().unwrap_or("google");
    // Detect common failure conditions before attempting embeddings.
    let pre_warning: Option<String> = if settings.ai_api_key_enc.is_none() {
        Some("No AI API key configured. Add your key in Settings → AI to enable embeddings.".to_string())
    } else if matches!(provider, "claude" | "anthropic") {
        Some(format!(
            "Provider '{}' has no embedding endpoint. Use Gemini, OpenAI, or Voyage in Settings → AI.",
            provider
        ))
    } else if matches!(provider, "openrouter") {
        Some("OpenRouter is a chat proxy — it has no embedding endpoint. Add a Gemini or OpenAI key in Settings → AI for embeddings.".to_string())
    } else {
        None
    };

    // 1. Collect all docs from disk
    let all_docs = file::load_all_docs(&docs_dir);
    let docs_scanned = all_docs.len();

    // 2. Load existing embeddings
    let existing = meta_db::load_all_embeddings(&pool).await.unwrap_or_default();
    let embedded_ids: HashSet<String> = existing.iter().map(|(id, _)| id.clone()).collect();
    let docs_already_embedded = embedded_ids.len();

    // 3. Embed docs missing embeddings (hard cap: 50 to control token cost)
    let mut embeddings_updated = 0usize;
    let mut embedding_errors = 0usize;
    let mut first_embed_error: Option<String> = None;

    // Skip embedding attempts if we already know the provider/key can't work.
    let skip_embed = pre_warning.is_some();

    if !skip_embed {
        let to_embed: Vec<_> = all_docs
            .iter()
            .filter(|(doc, _)| !embedded_ids.contains(&doc.id.to_string()))
            .take(50)
            .collect();

        for (doc, _) in &to_embed {
            let text = embed::doc_embed_text(&doc.title, &doc.description, &doc.body);
            match embed::embed_text(&settings, &state.fernet_key, &text).await {
                Ok((embedding, model)) => {
                    if meta_db::store_embedding(&pool, doc.id, &embedding, model).await.is_ok() {
                        embeddings_updated += 1;
                    } else {
                        embedding_errors += 1;
                    }
                }
                Err(e) => {
                    tracing::error!("embed failed for doc {}: {}", doc.id, e);
                    if first_embed_error.is_none() { first_embed_error = Some(e); }
                    embedding_errors += 1;
                    // If every doc fails the same way, stop after the first to avoid spam.
                    if embedding_errors >= 3 && embeddings_updated == 0 { break; }
                }
            }
        }
    }

    // 4. Load all embeddings fresh (includes newly stored ones).
    //    Prune any stale entries whose doc files no longer exist (deleted docs).
    let raw_embeddings = meta_db::load_all_embeddings(&pool).await.unwrap_or_default();
    let all_embeddings: Vec<(String, Vec<f32>)> = {
        let mut valid = Vec::with_capacity(raw_embeddings.len());
        for (id_str, emb) in raw_embeddings {
            if let Ok(uuid) = Uuid::parse_str(&id_str) {
                if state.index.get_file_name(&user.sub, uuid).is_some() {
                    valid.push((id_str, emb));
                } else {
                    // Stale embedding — delete it so future runs are clean.
                    meta_db::delete_embedding(&pool, uuid).await.ok();
                }
            }
        }
        valid
    };
    let docs_with_embeddings = all_embeddings.len();

    // Build final warning: use pre-run warning if set, otherwise surface post-run API errors.
    let warning = pre_warning.or_else(|| {
        if embedding_errors > 0 {
            Some(format!(
                "{} docs failed to embed — the '{}' API key may be invalid or rate-limited. Check Settings → AI.",
                embedding_errors, provider
            ))
        } else {
            None
        }
    });

    // Load link settings to determine auto-apply vs queue behaviour
    let link_settings = meta_db::get_link_settings(&pool).await.unwrap_or_default();

    // 5. Build a set of already-proposed pairs (pending) to avoid duplicates
    let pending = meta_db::fetch_link_proposals(&pool, Some("pending")).await.unwrap_or_default();
    let already_pending_review = pending.len();
    let mut proposed_pairs: HashSet<(String, String)> = pending
        .iter()
        .map(|p| {
            let a = p.source_doc_id.clone().min(p.target_doc_id.clone());
            let b = p.source_doc_id.clone().max(p.target_doc_id.clone());
            (a, b)
        })
        .collect();

    if docs_with_embeddings < 2 {
        return Ok(Json(KgRebuildResult {
            docs_scanned,
            docs_already_embedded,
            embeddings_updated,
            embedding_errors,
            docs_with_embeddings,
            pairs_above_threshold: 0,
            pairs_skipped_existing: 0,
            already_pending_review,
            proposals_queued_for_review: 0,
            links_auto_applied: 0,
            docs_theme_assigned: 0,
            warning,
            error_detail: first_embed_error,
        }));
    }

    // 6. Build a set of already-linked pairs from the in-memory index
    let mut linked_pairs: HashSet<(String, String)> = HashSet::new();
    for (doc_id_str, _) in &all_embeddings {
        if let Ok(uuid) = Uuid::parse_str(doc_id_str) {
            for link in state.index.forward_links_for(&user.sub, uuid) {
                let a = doc_id_str.clone().min(link.target_id.to_string());
                let b = doc_id_str.clone().max(link.target_id.to_string());
                linked_pairs.insert((a, b));
            }
        }
    }

    // 7. Compute pairwise cosine similarity with 3-tier logic:
    //    sim >= auto_threshold + !require_review → auto-apply
    //    sim >= auto_threshold + require_review  → queue for review
    //    LINK_FLOOR <= sim < auto_threshold      → always queue for review
    //    sim < LINK_FLOOR                        → ignore
    let auto_threshold = link_settings.link_auto_threshold;
    let session_id = Uuid::new_v4().to_string();
    let mut proposals_queued_for_review = 0usize;
    let mut links_auto_applied = 0usize;
    let mut pairs_above_threshold = 0usize;
    let mut pairs_skipped_existing = 0usize;

    for i in 0..all_embeddings.len() {
        for j in (i + 1)..all_embeddings.len() {
            let (id_a, emb_a) = &all_embeddings[i];
            let (id_b, emb_b) = &all_embeddings[j];

            let sim = cosine_similarity(emb_a, emb_b);
            if sim < meta_db::LINK_FLOOR { continue; }

            pairs_above_threshold += 1;

            let a = id_a.clone().min(id_b.clone());
            let b = id_a.clone().max(id_b.clone());

            if proposed_pairs.contains(&(a.clone(), b.clone()))
                || linked_pairs.contains(&(a.clone(), b.clone()))
            {
                pairs_skipped_existing += 1;
                continue;
            }

            if let (Ok(ua), Ok(ub)) = (Uuid::parse_str(id_a), Uuid::parse_str(id_b)) {
                if sim >= auto_threshold && !link_settings.links_require_review {
                    if super::inbox::do_link_docs(&state, &user.sub, ua, ub, LinkLabel::RelatedTo, &pool, &session_id).await.is_ok() {
                        proposed_pairs.insert((a, b));
                        links_auto_applied += 1;
                    }
                } else {
                    if meta_db::insert_link_proposal(&pool, ua, ub, "related_to", sim, &session_id).await.is_ok() {
                        proposed_pairs.insert((a, b));
                        proposals_queued_for_review += 1;
                    }
                }
            }
        }
    }

    // 8. Phase 3 — Theme classification via embedding similarity
    //    For each theme with an embedding, find docs above auto_threshold that
    //    aren't already assigned to that theme, and assign them.
    let mut docs_theme_assigned = 0usize;
    let themes = meta_db::list_themes(&pool).await.unwrap_or_default();
    if !themes.is_empty() {
        // Ensure theme embeddings exist (embed any that are missing)
        let docs_dir = state.user_docs_dir(&user.sub);
        for theme in &themes {
            embed::embed_theme(&state, &user.sub, theme, &docs_dir, &pool).await;
        }
        let theme_embeddings = meta_db::load_theme_embeddings(&pool).await.unwrap_or_default();

        if !theme_embeddings.is_empty() {
            // Reload all doc embeddings (same as all_embeddings above)
            let all_doc_emb = &all_embeddings;
            for (theme_id, theme_emb) in &theme_embeddings {
                for (doc_id_str, doc_emb) in all_doc_emb {
                    let sim = cosine_similarity(doc_emb, theme_emb);
                    if sim < auto_threshold { continue; }

                    // Load doc, check/assign theme
                    let Ok(doc_uuid) = Uuid::parse_str(doc_id_str) else { continue };
                    let file_name = match state.index.get_file_name(&user.sub, doc_uuid)
                        .or_else(|| file::find_doc_path(&docs_dir, doc_uuid)
                            .and_then(|p| p.file_name()?.to_str().map(String::from)))
                    {
                        Some(f) => f,
                        None => continue,
                    };
                    let Ok(mut doc) = file::parse_doc(&docs_dir.join(&file_name)) else { continue };
                    if doc.theme_ids.contains(theme_id) { continue; }

                    doc.theme_ids.push(theme_id.clone());
                    doc.updated_at = chrono::Utc::now();
                    if file::write_doc(&docs_dir, &doc, Some(&file_name)).is_ok() {
                        state.index.upsert(&user.sub, &doc, &file_name);
                        docs_theme_assigned += 1;
                        tracing::debug!("rebuild: assigned theme {} to doc {} ({:.2})", theme_id, doc_id_str, sim);
                    }
                }
                // Re-embed theme now that new docs may have been added (enriches future queries)
                if let Some(t) = themes.iter().find(|t| &t.id == theme_id) {
                    embed::embed_theme(&state, &user.sub, t, &docs_dir, &pool).await;
                }
            }
        }
    }

    Ok(Json(KgRebuildResult {
        docs_scanned,
        docs_already_embedded,
        embeddings_updated,
        embedding_errors,
        docs_with_embeddings,
        pairs_above_threshold,
        pairs_skipped_existing,
        already_pending_review,
        proposals_queued_for_review,
        links_auto_applied,
        docs_theme_assigned,
        warning,
        error_detail: first_embed_error,
    }))
}
