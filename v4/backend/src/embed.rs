use std::collections::HashSet;
use std::sync::Arc;

use uuid::Uuid;

use crate::crypto::decrypt_key;
use crate::meta_db::{self, UserSettings};
use crate::models::LinkLabel;
use crate::store::{file, index::DocIndex, AppState};

// ── Cosine & structural similarity ────────────────────────────────────────────

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() { return 0.0; }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let mag_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mag_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if mag_a == 0.0 || mag_b == 0.0 { return 0.0; }
    (dot / (mag_a * mag_b)).clamp(-1.0, 1.0)
}

/// Jaccard similarity on the union of forward + backward neighbors.
/// Combined score: semantic*0.8 + structural*0.2
pub fn structural_similarity(a_id: Uuid, b_id: Uuid, index: &DocIndex, user_id: &str) -> f32 {
    let neighbors = |id: Uuid| -> HashSet<Uuid> {
        let mut s = HashSet::new();
        for fwd in index.forward_links_for(user_id, id) { s.insert(fwd.target_id); }
        for bl  in index.backlinks_for(user_id, id)     { s.insert(bl.source_id); }
        s
    };
    let na = neighbors(a_id);
    let nb = neighbors(b_id);
    if na.is_empty() && nb.is_empty() { return 0.0; }
    let shared = na.intersection(&nb).count() as f32;
    let union  = na.union(&nb).count() as f32;
    if union == 0.0 { return 0.0; }
    shared / union
}

pub fn combined_score(semantic: f32, structural: f32) -> f32 {
    semantic * 0.8 + structural * 0.2
}

// ── Provider calls ────────────────────────────────────────────────────────────

async fn embed_google(api_key: &str, text: &str) -> anyhow::Result<Vec<f32>> {
    let resp = reqwest::Client::new()
        .post("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent")
        .query(&[("key", api_key)])
        .json(&serde_json::json!({ "content": { "parts": [{ "text": text }] } }))
        .send().await?
        .json::<serde_json::Value>().await?;
    if resp.pointer("/embedding/values").is_none() {
        let msg = resp.to_string();
        tracing::error!("Google embed API unexpected response: {}", msg);
        return Err(anyhow::anyhow!("{}", msg));
    }
    parse_embedding(resp.pointer("/embedding/values"))
}

async fn embed_voyage(api_key: &str, text: &str) -> anyhow::Result<Vec<f32>> {
    let resp = reqwest::Client::new()
        .post("https://api.voyageai.com/v1/embeddings")
        .bearer_auth(api_key)
        .json(&serde_json::json!({ "input": [text], "model": "voyage-3.5" }))
        .send().await?
        .json::<serde_json::Value>().await?;
    parse_embedding(resp.pointer("/data/0/embedding"))
}

async fn embed_openai(api_key: &str, text: &str) -> anyhow::Result<Vec<f32>> {
    let resp = reqwest::Client::new()
        .post("https://api.openai.com/v1/embeddings")
        .bearer_auth(api_key)
        .json(&serde_json::json!({ "input": text, "model": "text-embedding-3-small" }))
        .send().await?
        .json::<serde_json::Value>().await?;
    parse_embedding(resp.pointer("/data/0/embedding"))
}

fn parse_embedding(v: Option<&serde_json::Value>) -> anyhow::Result<Vec<f32>> {
    v.and_then(|a| a.as_array())
     .ok_or_else(|| anyhow::anyhow!("embedding not found in response"))?
     .iter()
     .map(|x| x.as_f64().map(|f| f as f32).ok_or_else(|| anyhow::anyhow!("non-numeric value")))
     .collect()
}

/// Call the embedding API for the user's configured provider.
/// Returns `Err(reason)` if the provider has no embedding endpoint, the key is
/// missing/invalid, or the API call fails. The reason string is user-visible.
pub async fn embed_text(settings: &UserSettings, fernet_key: &str, text: &str) -> Result<(Vec<f32>, &'static str), String> {
    let key_enc = settings.ai_api_key_enc.as_deref()
        .ok_or_else(|| "No API key configured".to_string())?;
    let api_key = decrypt_key(fernet_key, key_enc)
        .map_err(|e| format!("Key decryption failed: {e}"))?;
    let provider = settings.ai_provider.as_deref().unwrap_or("google");

    match provider {
        "voyage" | "voyageai" =>
            embed_voyage(&api_key, text).await
                .map(|e| (e, "voyage-3.5"))
                .map_err(|e| format!("Voyage API error: {e}")),
        "openai" =>
            embed_openai(&api_key, text).await
                .map(|e| (e, "text-embedding-3-small"))
                .map_err(|e| format!("OpenAI API error: {e}")),
        "claude" | "anthropic" | "openrouter" => {
            // These providers have no embedding endpoint.
            // Fall back to Voyage if the user has configured a separate Voyage key.
            if let Some(voyage_enc) = &settings.voyage_api_key_enc {
                let voyage_key = decrypt_key(fernet_key, voyage_enc)
                    .map_err(|e| format!("Voyage key decryption failed: {e}"))?;
                embed_voyage(&voyage_key, text).await
                    .map(|e| (e, "voyage-3.5"))
                    .map_err(|e| format!("Voyage API error: {e}"))
            } else {
                Err(format!(
                    "Provider '{provider}' has no embedding endpoint. \
                     Add a Voyage API key in Settings → AI to enable embeddings."
                ))
            }
        }
        // "gemini" and "google" both use the Google Generative Language embedding API
        _ =>
            embed_google(&api_key, text).await
                .map(|e| (e, "text-embedding-004"))
                .map_err(|e| format!("Google API error: {e}")),
    }
}

// ── Background embed task ─────────────────────────────────────────────────────

/// Spawn a fire-and-forget tokio task that embeds `text`, stores the result, then
/// compares it against all other embedded docs and inserts link_proposals for pairs
/// above the 0.82 similarity threshold (respecting the user's links_enabled setting).
pub fn spawn_embed_task(state: Arc<AppState>, user_id: String, doc_id: Uuid, text: String) {
    tokio::spawn(async move {
        let user_root = state.user_root_dir(&user_id);
        let Ok(pool) = meta_db::init_user_meta_db(&user_root).await else { return };
        let Ok(settings) = meta_db::get_settings(&pool).await else { return };

        let Ok((embedding, model)) = embed_text(&settings, &state.fernet_key, &text).await
        else { return };

        if meta_db::store_embedding(&pool, doc_id, &embedding, model).await.is_err() { return; }
        tracing::debug!("stored embedding for doc {}", doc_id);

        // Auto-link: propose pairs above threshold if the user has linking enabled.
        let link_settings = meta_db::get_link_settings(&pool).await.unwrap_or_default();
        if !link_settings.links_enabled { return; }

        let all_embeddings = meta_db::load_all_embeddings(&pool).await.unwrap_or_default();
        if all_embeddings.len() < 2 { return; }

        // Skip pairs already pending to avoid duplicates.
        let pending = meta_db::fetch_link_proposals(&pool, Some("pending")).await.unwrap_or_default();
        let proposed: std::collections::HashSet<(String, String)> = pending.iter().map(|p| {
            let a = p.source_doc_id.clone().min(p.target_doc_id.clone());
            let b = p.source_doc_id.clone().max(p.target_doc_id.clone());
            (a, b)
        }).collect();

        let auto_threshold = link_settings.link_auto_threshold;
        let session_id = doc_id.to_string();

        let mut candidates: Vec<(Uuid, f32)> = all_embeddings
            .iter()
            .filter_map(|(id_str, emb)| {
                let id: Uuid = id_str.parse().ok()?;
                if id == doc_id { return None; }
                // Skip stale embeddings from deleted docs.
                if state.index.get_file_name(&user_id, id).is_none() { return None; }
                let a = doc_id.to_string().min(id.to_string());
                let b = doc_id.to_string().max(id.to_string());
                if proposed.contains(&(a, b)) { return None; }
                let sim = cosine_similarity(&embedding, emb);
                if sim < meta_db::LINK_FLOOR { return None; }
                Some((id, sim))
            })
            .collect();
        candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        candidates.truncate(3);

        let docs_dir = state.user_docs_dir(&user_id);
        let src_doc_opt = state.index.get_file_name(&user_id, doc_id)
            .map(|f| docs_dir.join(f))
            .or_else(|| file::find_doc_path(&docs_dir, doc_id))
            .and_then(|p| file::parse_doc(&p).ok());

        for (target_id, confidence) in candidates {
            let label = if let Some(ref src) = src_doc_opt {
                let tgt_kw = state.index.get_file_name(&user_id, target_id)
                    .map(|f| docs_dir.join(&f))
                    .or_else(|| file::find_doc_path(&docs_dir, target_id))
                    .and_then(|p| file::parse_doc(&p).ok())
                    .map(|d| d.vector_keywords)
                    .unwrap_or_default();
                crate::store::classify::classify_link_label(&src.body, &src.vector_keywords, &tgt_kw)
            } else {
                LinkLabel::RelatedTo
            };

            if confidence >= auto_threshold && !link_settings.links_require_review {
                crate::routes::inbox::do_link_docs(
                    &state, &user_id, doc_id, target_id, label.clone(), &pool, &session_id, "auto",
                ).await.ok();
            } else {
                meta_db::insert_link_proposal(&pool, doc_id, target_id, &label.to_string(), confidence, &session_id).await.ok();
            }
        }
    });
}

// ── Embedding text builders ───────────────────────────────────────────────────

/// Build the text to embed for a doc: title + description + body (capped at 8k chars).
pub fn doc_embed_text(title: &str, description: &str, body: &str) -> String {
    let combined = format!("{}\n{}\n{}", title, description, body);
    combined.chars().take(8000).collect()
}

/// Build embedding text for a theme: title + description + titles of linked docs.
/// The linked doc titles enrich the embedding so it improves as docs are added to the theme.
pub fn theme_embed_text(title: &str, description: &str, linked_doc_titles: &[String]) -> String {
    let mut parts = vec![title.to_string()];
    if !description.is_empty() { parts.push(description.to_string()); }
    if !linked_doc_titles.is_empty() {
        parts.push(format!("Related: {}", linked_doc_titles.join(", ")));
    }
    parts.join("\n").chars().take(4000).collect()
}

/// Collect titles of all docs that list `theme_id` in their theme_ids.
pub fn collect_theme_doc_titles(docs_dir: &std::path::Path, theme_id: &str) -> Vec<String> {
    file::load_all_docs(docs_dir)
        .into_iter()
        .filter_map(|(doc, _)| {
            if doc.theme_ids.contains(&theme_id.to_string()) {
                Some(doc.title)
            } else {
                None
            }
        })
        .collect()
}

/// Embed a single theme and store the result. Called from PATCH /themes/:id and rebuild KG.
pub async fn embed_theme(
    state: &Arc<AppState>,
    user_id: &str,
    theme: &meta_db::Theme,
    docs_dir: &std::path::Path,
    pool: &sqlx::SqlitePool,
) {
    let Ok(settings) = meta_db::get_settings(pool).await else { return };
    let linked_titles = collect_theme_doc_titles(docs_dir, &theme.id);
    let text = theme_embed_text(&theme.title, &theme.description, &linked_titles);
    match embed_text(&settings, &state.fernet_key, &text).await {
        Ok((embedding, model)) => {
            meta_db::store_theme_embedding(pool, &theme.id, &embedding, model).await.ok();
            tracing::debug!("embedded theme '{}' for user {}", theme.title, user_id);
        }
        Err(e) => tracing::debug!("theme embed failed for '{}': {}", theme.title, e),
    }
}

// ── Background embedding sweep ────────────────────────────────────────────────

/// Called every 10 minutes. For every user who has linking enabled and an
/// embedding-capable key, embeds up to 20 docs that are missing embeddings.
/// Stops early for a user if the first embedding attempt fails (shared failure mode).
pub async fn background_embed_users(state: &Arc<AppState>) {
    let users_dir = state.data_dir.join("users");
    let Ok(entries) = std::fs::read_dir(&users_dir) else { return };

    for entry in entries.flatten() {
        let user_id = entry.file_name().to_string_lossy().to_string();
        let user_root = state.user_root_dir(&user_id);
        let Ok(pool) = meta_db::init_user_meta_db(&user_root).await else { continue };
        let link_settings = meta_db::get_link_settings(&pool).await.unwrap_or_default();
        if !link_settings.links_enabled { continue; }
        let Ok(settings) = meta_db::get_settings(&pool).await else { continue };

        let docs_dir = state.user_docs_dir(&user_id);
        let all_docs = file::load_all_docs(&docs_dir);
        let existing = meta_db::load_all_embeddings(&pool).await.unwrap_or_default();
        let embedded_ids: std::collections::HashSet<String> =
            existing.iter().map(|(id, _)| id.clone()).collect();

        let to_embed: Vec<_> = all_docs.iter()
            .filter(|(doc, _)| !embedded_ids.contains(&doc.id.to_string()))
            .take(20)
            .collect();

        if to_embed.is_empty() { continue; }
        tracing::info!("background embed: {} docs queued for user {}", to_embed.len(), user_id);

        let mut newly_embedded: Vec<Uuid> = Vec::new();

        for (doc, _) in &to_embed {
            let text = doc_embed_text(&doc.title, &doc.description, &doc.body);
            match embed_text(&settings, &state.fernet_key, &text).await {
                Ok((embedding, model)) => {
                    if meta_db::store_embedding(&pool, doc.id, &embedding, model).await.is_ok() {
                        newly_embedded.push(doc.id);
                    }
                    // Gentle rate-limit between API calls
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                }
                Err(e) => {
                    tracing::debug!("background embed failed for user {}: {}", user_id, e);
                    break; // Shared key/quota failure — skip remaining docs for this user
                }
            }
        }

        // After storing new embeddings, run link-proposal analysis for each doc that
        // was just embedded. This ensures that old docs (created before the embed
        // feature existed) get linked to related content the next time the sweep runs.
        if newly_embedded.is_empty() { continue; }

        let all_emb = meta_db::load_all_embeddings(&pool).await.unwrap_or_default();
        if all_emb.len() < 2 { continue; }

        let pending = meta_db::fetch_link_proposals(&pool, Some("pending")).await.unwrap_or_default();
        let proposed: std::collections::HashSet<(String, String)> = pending.iter().map(|p| {
            let a = p.source_doc_id.clone().min(p.target_doc_id.clone());
            let b = p.source_doc_id.clone().max(p.target_doc_id.clone());
            (a, b)
        }).collect();

        let auto_threshold = link_settings.link_auto_threshold;

        for doc_id in &newly_embedded {
            let doc_id_str = doc_id.to_string();
            let Some(doc_emb) = all_emb.iter()
                .find(|(id, _)| id == &doc_id_str)
                .map(|(_, e)| e)
            else { continue };
            let session_id = format!("sweep-{}", doc_id);

            let mut candidates: Vec<(Uuid, f32)> = all_emb
                .iter()
                .filter_map(|(id_str, emb)| {
                    let id: Uuid = id_str.parse().ok()?;
                    if id == *doc_id { return None; }
                    // Skip stale embeddings from deleted docs.
                    if state.index.get_file_name(&user_id, id).is_none() { return None; }
                    let a = doc_id_str.clone().min(id.to_string());
                    let b = doc_id_str.clone().max(id.to_string());
                    if proposed.contains(&(a, b)) { return None; }
                    let sim = cosine_similarity(doc_emb, emb);
                    if sim < meta_db::LINK_FLOOR { return None; }
                    Some((id, sim))
                })
                .collect();
            candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            candidates.truncate(3);

            let docs_dir = state.user_docs_dir(&user_id);
            let src_doc_opt = state.index.get_file_name(&user_id, *doc_id)
                .map(|f| docs_dir.join(f))
                .or_else(|| file::find_doc_path(&docs_dir, *doc_id))
                .and_then(|p| file::parse_doc(&p).ok());

            for (target_id, confidence) in candidates {
                let label = if let Some(ref src) = src_doc_opt {
                    let tgt_kw = state.index.get_file_name(&user_id, target_id)
                        .map(|f| docs_dir.join(&f))
                        .or_else(|| file::find_doc_path(&docs_dir, target_id))
                        .and_then(|p| file::parse_doc(&p).ok())
                        .map(|d| d.vector_keywords)
                        .unwrap_or_default();
                    crate::store::classify::classify_link_label(&src.body, &src.vector_keywords, &tgt_kw)
                } else {
                    LinkLabel::RelatedTo
                };

                if confidence >= auto_threshold && !link_settings.links_require_review {
                    crate::routes::inbox::do_link_docs(
                        state, &user_id, *doc_id, target_id, label.clone(), &pool, &session_id, "auto",
                    ).await.ok();
                    tracing::debug!("sweep auto-link: {} → {} ({:.2})", doc_id, target_id, confidence);
                } else {
                    meta_db::insert_link_proposal(&pool, *doc_id, target_id, &label.to_string(), confidence, &session_id).await.ok();
                    tracing::debug!("sweep link proposal: {} → {} ({:.2})", doc_id, target_id, confidence);
                }
            }
        }
    }
}

// ── Background theme embedding sweep ─────────────────────────────────────────

/// Called every 10 minutes alongside doc embedding. For each user, embeds any
/// themes that are missing an embedding or whose description has never been embedded.
pub async fn background_embed_themes(state: &Arc<AppState>) {
    let users_dir = state.data_dir.join("users");
    let Ok(entries) = std::fs::read_dir(&users_dir) else { return };

    for entry in entries.flatten() {
        let user_id = entry.file_name().to_string_lossy().to_string();
        let user_root = state.user_root_dir(&user_id);
        let Ok(pool) = meta_db::init_user_meta_db(&user_root).await else { continue };
        let Ok(themes) = meta_db::list_themes(&pool).await else { continue };
        if themes.is_empty() { continue; }

        let embedded: std::collections::HashSet<String> = meta_db::load_theme_embeddings(&pool)
            .await.unwrap_or_default().into_iter().map(|(id, _)| id).collect();

        let docs_dir = state.user_docs_dir(&user_id);
        for theme in &themes {
            if embedded.contains(&theme.id) { continue; }
            embed_theme(state, &user_id, theme, &docs_dir, &pool).await;
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }
    }
}
