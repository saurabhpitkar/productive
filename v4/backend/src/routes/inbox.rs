use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::embed::{
    combined_score, cosine_similarity, doc_embed_text, embed_text, spawn_embed_task,
    structural_similarity,
};
use crate::meta_db::{self, UserSettings};
use crate::models::{AuthUser, Doc, DocLink, DocResponse, LinkLabel, RoutingResult};
use crate::store::{file, git, AppState};

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

// ── POST /inbox ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SubmitRequest {
    pub body: String,
    pub user_title:     Option<String>,
    pub priority:       Option<String>,
    pub status:         Option<String>,
    pub due_date:       Option<String>,
    pub due_time:       Option<String>,
    pub linked_doc_ids: Option<Vec<String>>,
}

/// User-specified metadata fields parsed and validated before routing begins.
struct UserMeta {
    priority:       Option<crate::models::DocPriority>,
    task_status:    Option<crate::models::TaskStatus>,
    due_date:       Option<String>,
    due_time:       Option<String>,
    linked_doc_ids: Vec<String>,
}

impl UserMeta {
    fn has_metadata(&self) -> bool {
        self.priority.is_some() || self.task_status.is_some()
            || self.due_date.is_some() || self.due_time.is_some()
    }
}

pub async fn submit(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(req): Json<SubmitRequest>,
) -> Res<serde_json::Value> {
    if req.body.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "body must not be empty"));
    }

    // Validate and parse user-specified metadata fields up-front so callers
    // get a 400 immediately rather than a silent routing failure.
    let user_meta = {
        use std::str::FromStr;
        let priority = match req.priority.as_deref().filter(|s| !s.is_empty()) {
            None => None,
            Some(s) => Some(
                crate::models::DocPriority::from_str(s).map_err(|_| err(
                    StatusCode::BAD_REQUEST,
                    &format!("invalid priority '{}'; must be 'high', 'medium', or 'low'", s),
                ))?
            ),
        };
        let task_status = match req.status.as_deref().filter(|s| !s.is_empty()) {
            None => None,
            Some(s) => Some(
                crate::models::TaskStatus::from_str(s).map_err(|_| err(
                    StatusCode::BAD_REQUEST,
                    &format!("invalid status '{}'; must be 'todo', 'in_progress', 'done', 'cancelled', or 'archived'", s),
                ))?
            ),
        };
        let due_date = req.due_date.clone().filter(|s| !s.is_empty());
        if let Some(d) = &due_date {
            // Require YYYY-MM-DD
            if d.len() != 10 || !d.chars().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }
            }) {
                return Err(err(StatusCode::BAD_REQUEST,
                    &format!("invalid due_date '{}'; must be YYYY-MM-DD", d)));
            }
        }
        let due_time = req.due_time.clone().filter(|s| !s.is_empty());
        if let Some(t) = &due_time {
            // Require HH:MM
            if t.len() != 5 || !t.chars().enumerate().all(|(i, c)| {
                if i == 2 { c == ':' } else { c.is_ascii_digit() }
            }) {
                return Err(err(StatusCode::BAD_REQUEST,
                    &format!("invalid due_time '{}'; must be HH:MM", t)));
            }
        }
        UserMeta {
            priority,
            task_status,
            due_date,
            due_time,
            linked_doc_ids: req.linked_doc_ids.clone().unwrap_or_default(),
        }
    };

    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let inbox_id = meta_db::create_inbox_entry(&pool, &req.body).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    meta_db::update_inbox_entry(&pool, &inbox_id, "routing", None).await.ok();

    // Fire routing in background — caller gets inbox_id immediately and polls GET /inbox
    let state2 = Arc::clone(&state);
    let user2 = user.clone();
    let inbox_id2 = inbox_id.clone();
    let note_body = req.body.clone();
    let user_title_owned: Option<String> = req.user_title
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string());
    let pool2 = pool.clone();

    tokio::spawn(async move {
        let Ok(settings) = meta_db::get_settings(&pool2).await else { return };
        let link_settings = meta_db::get_link_settings(&pool2).await.unwrap_or_default();
        let user_title = user_title_owned.as_deref();
        let result = run_routing_loop(&state2, &user2, &inbox_id2, &note_body, user_title, &pool2, &settings).await;
        let result_json = serde_json::to_value(&result).ok();
        meta_db::update_inbox_entry(&pool2, &inbox_id2, &result.status, result_json.as_ref()).await.ok();

        // Apply user-specified metadata fields and manual links to the routed doc.
        if let Some(doc_id_str) = &result.target_doc_id {
            apply_user_meta_to_doc(&state2, &user2.sub, doc_id_str, &user_meta).await.ok();
            if let Ok(doc_uuid) = Uuid::parse_str(doc_id_str) {
                for linked_id_str in &user_meta.linked_doc_ids {
                    if let Ok(linked_uuid) = Uuid::parse_str(linked_id_str) {
                        do_link_docs(
                            &state2, &user2.sub, doc_uuid, linked_uuid,
                            LinkLabel::RelatedTo, &pool2, &inbox_id2, "manual",
                        ).await.ok();
                    }
                }
            }
        }

        if link_settings.links_enabled && link_settings.links_capture {
            if let Some(doc_id_str) = result.target_doc_id.clone() {
                run_async_link_analysis(state2, user2.sub, doc_id_str, pool2, inbox_id2, link_settings.links_require_review).await;
            }
        }
    });

    Ok(Json(serde_json::json!({ "inbox_id": inbox_id, "status": "routing" })))
}

// ── GET /inbox ────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct ListQuery {
    pub status: Option<String>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Res<Vec<serde_json::Value>> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let entries = meta_db::list_inbox_entries(&pool, q.status.as_deref()).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(entries))
}

// ── Routing loop ──────────────────────────────────────────────────────────────

async fn run_routing_loop(
    state: &Arc<AppState>,
    user: &AuthUser,
    inbox_id: &str,
    note_body: &str,
    user_title: Option<&str>,
    pool: &sqlx::SqlitePool,
    settings: &UserSettings,
) -> RoutingResult {
    let failed = |reason: &str| RoutingResult {
        inbox_id: inbox_id.to_string(),
        status: "failed".to_string(),
        confidence: 0.0,
        target_doc_id: None,
        target_doc_title: None,
        action: "failed".to_string(),
        reasoning: reason.to_string(),
        rounds_used: 0,
    };

    // Load user themes to inject into routing context
    let themes = meta_db::list_themes(pool).await.unwrap_or_default();

    // Round 1: semantic pre-seed — top-5 candidates
    let docs_dir = state.user_docs_dir(&user.sub);
    let all_docs: Vec<Doc> = file::load_all_docs(&docs_dir).into_iter().map(|(d, _)| d).collect();

    let candidates: Vec<(Uuid, f32)> =
        if let Ok((query_emb, _)) = embed_text(settings, &state.fernet_key, note_body).await {
            let all_embeddings = meta_db::load_all_embeddings(pool).await.unwrap_or_default();
            let doc_ids: std::collections::HashSet<Uuid> = all_docs.iter().map(|d| d.id).collect();

            let mut scored: Vec<(Uuid, f32)> = all_embeddings
                .iter()
                .filter_map(|(id_str, emb)| {
                    let id: Uuid = id_str.parse().ok()?;
                    if !doc_ids.contains(&id) { return None; }
                    let sem = cosine_similarity(&query_emb, emb);
                    let str_ = structural_similarity(Uuid::nil(), id, &*state.index, &user.sub);
                    Some((id, combined_score(sem, str_)))
                })
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            scored.truncate(5);
            scored
        } else {
            // No embeddings available — fall back to 5 most recently updated docs
            let mut fallback: Vec<&Doc> = all_docs.iter().collect();
            fallback.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            fallback.iter().take(5).map(|d| (d.id, 0.5)).collect()
        };

    // Build candidate context string for the LLM
    let doc_map: std::collections::HashMap<Uuid, &Doc> = all_docs.iter().map(|d| (d.id, d)).collect();
    let candidate_context: String = candidates
        .iter()
        .enumerate()
        .filter_map(|(i, (id, score))| {
            let doc = doc_map.get(id)?;
            let outline = format_outline_for_prompt(doc.note_outline.as_ref());
            let outline_section = if outline.is_empty() {
                String::new()
            } else {
                format!("\n  Outline:\n{}", outline.lines().map(|l| format!("    {}", l)).collect::<Vec<_>>().join("\n"))
            };
            Some(format!(
                "Candidate {} (score {:.2}):\n  ID: {}\n  Title: {}\n  Type: {}\n  Description: {}{}\n  Preview: {}",
                i + 1, score, id, doc.title, doc.doc_type, doc.description, outline_section,
                doc.body.chars().take(300).collect::<String>()
            ))
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    // Rounds 3–6: Anthropic / Gemini tool-calling loop
    let api_key_enc = match &settings.ai_api_key_enc {
        Some(k) => k.clone(),
        None => return failed("no API key configured — add one in Settings"),
    };
    let api_key = match crate::crypto::decrypt_key(&state.fernet_key, &api_key_enc) {
        Ok(k) => k,
        Err(_) => return failed("API key decryption failed"),
    };

    let tools = build_routing_tools();
    let themes_section = if themes.is_empty() {
        String::new()
    } else {
        let list = themes.iter()
            .map(|t| format!("  - id: \"{}\" | title: \"{}\"", t.id, t.title))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "\n\n## User-defined Themes\n\
             The user has organised their knowledge graph into the following top-level themes. \
             When routing or creating a doc, identify which theme best fits and include its id \
             in your terminal tool call. If no theme fits clearly (confidence < 0.50), omit theme_id.\n\n{}",
            list
        )
    };
    let system_base = r#"You are an inbox routing agent for a personal knowledge management (PKM) system.
Your job is to analyse an incoming note and decide exactly where it belongs in the user's knowledge graph.
You express your decision by calling exactly one terminal tool: route_to_doc, update_doc, create_new_doc, or request_hitl.

## Step 1 — Understand the note
Read the note carefully and identify:
- Primary topic (what is this fundamentally about?)
- Intent: is this a task, reference, idea, decision, or update to existing work?
- Named entities: people, projects, dates, systems, locations

## Step 2 — Evaluate the semantic candidates
You receive up to 5 pre-ranked candidate docs. For each:
- Read the title and body preview. Ask: does the note's primary topic belong inside this doc?
- If the preview is insufficient, call get_doc to read the full body.
- If a promising candidate mentions linked docs that may be better targets, call traverse_subtree (depth 1–2).
- Assign each candidate a mental confidence score: 0.0 (unrelated) → 1.0 (perfect fit).
- Stop exploring once you have a candidate at confidence ≥ 0.80 or have used 3 tool calls.

## Step 3 — Choose the terminal action

REPLACE → call update_doc when ALL of the following are true:
  1. The best candidate doc covers the same topic as the note (confidence ≥ 0.75).
  2. The note is a status update — the same tasks/items are present but with different completion states, updated values, or corrections to what is already in the doc.
  3. Appending the note would create duplicate or redundant content (the same checklist or item list appears twice).

APPEND → call route_to_doc when ALL of the following are true:
  1. The best candidate doc covers the same topic or project as the note (confidence ≥ 0.75).
  2. The note adds genuinely NEW information not already in the doc — new tasks, new observations, a new section.
  3. The note does not introduce a new standalone concept that warrants its own entry.

CREATE → call create_new_doc when:
  1. No candidate doc covers the note's topic (best confidence < 0.60), OR
  2. The note introduces a clearly distinct concept, project, or entity not yet in the graph.
  3. You are confident (≥ 0.75) in a specific title and the note has enough substance to stand alone.

HITL → call request_hitl when any of the following are true:
  1. Best candidate confidence is between 0.60 and 0.75 — fit is plausible but not clear.
  2. Two candidates score within 0.10 of each other and the note could reasonably go in either.
  3. The note is about a sensitive, financial, or high-stakes topic where a misroute would cause real harm.
  4. After 3 tool-use rounds you still cannot reach confidence ≥ 0.75 for any option.

## Step 4 — Call the terminal tool
Every terminal tool requires a `confidence` (0.0–1.0) and a `reasoning` string. The reasoning must:
- Name the doc chosen (or explain why none fits).
- State the confidence score and why that score was reached.
- Briefly explain why the top alternative was rejected.

## Formatting rules
- content_to_append must be clean markdown, preserving any structure from the original note.
- new_body (for update_doc) must be the complete replacement body — include all existing content you want to keep plus the updates from the note.
- When creating, use a specific noun-phrase title (e.g. "Japan Trip — Visa Checklist", not "New Note").
- Never route to a doc whose connection to the note is only tangential.
- Note: if the user provided an explicit title hint, the system will apply it automatically — you do not need to use it in your tool call."#;
    let system = format!("{}{}", system_base, themes_section);

    let user_title_note = user_title.map(|t|
        format!("\n\nUser-provided title hint: \"{}\" — the system will apply this automatically.", t)
    ).unwrap_or_default();

    let user_msg = format!(
        "Route this inbox note:\n\n{}{}\n\n---\nTop semantically similar docs in the knowledge graph:\n\n{}",
        note_body, user_title_note, candidate_context
    );

    let provider = detect_provider(settings);
    let model = settings.ai_model.clone()
        .unwrap_or_else(|| "claude-sonnet-4-5".to_string());

    let mut messages = vec![serde_json::json!({ "role": "user", "content": user_msg })];
    let mut rounds_used: u8 = 0;
    let mut total_input:  i64 = 0;
    let mut total_output: i64 = 0;
    let http = reqwest::Client::new();

    for _ in 0..6u8 {
        rounds_used += 1;

        let (has_tool_calls, content, raw_gemini, in_tok, out_tok) =
            match call_routing_llm(&http, provider, &api_key, &model, &system, &messages, &tools).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("routing LLM call failed: {}", e);
                    meta_db::log_ai_usage(pool, &model, total_input, total_output).await.ok();
                    return failed(&format!("LLM call failed: {}", e));
                }
            };
        total_input  += in_tok;
        total_output += out_tok;

        // Preserve raw Gemini parts (including thoughtSignature) in the assistant
        // message so the next round can replay them verbatim for thinking models.
        let mut asst_msg = serde_json::json!({ "role": "assistant", "content": content });
        if let Some(rg) = raw_gemini {
            asst_msg["_gemini_raw_parts"] = rg;
        }
        messages.push(asst_msg);

        if !has_tool_calls {
            return failed("LLM did not call a routing tool — decision unclear");
        }

        let mut tool_results = Vec::new();
        let mut terminal: Option<RoutingResult> = None;

        for block in &content {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") { continue; }
            let tool_id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name    = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input   = block.get("input").cloned().unwrap_or_default();

            let (tool_result, term) =
                handle_routing_tool(name, &input, state, user, inbox_id, rounds_used, pool, user_title, &themes).await;

            tool_results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tool_id,
                "tool_name": name,
                "content": tool_result.to_string(),
            }));
            if let Some(r) = term { terminal = Some(r); }
        }

        if let Some(result) = terminal {
            meta_db::log_ai_usage(pool, &model, total_input, total_output).await.ok();
            return result;
        }
        messages.push(serde_json::json!({ "role": "user", "content": tool_results }));
    }

    meta_db::log_ai_usage(pool, &model, total_input, total_output).await.ok();
    failed("routing loop exhausted without a decision")
}

// ── Per-tool handler ──────────────────────────────────────────────────────────

/// If the LLM omitted theme_id, fall back to a case-insensitive title match.
fn infer_theme_id(
    agent_theme_id: Option<String>,
    themes: &[meta_db::Theme],
    text: &str,
) -> Option<String> {
    if let Some(id) = agent_theme_id.filter(|s| !s.is_empty()) { return Some(id); }
    if themes.is_empty() { return None; }
    let lower = text.to_lowercase();
    themes.iter()
        .find(|t| lower.contains(&t.title.to_lowercase()))
        .map(|t| t.id.clone())
}

async fn handle_routing_tool(
    name: &str,
    input: &serde_json::Value,
    state: &Arc<AppState>,
    user: &AuthUser,
    inbox_id: &str,
    rounds_used: u8,
    pool: &sqlx::SqlitePool,
    user_title: Option<&str>,
    themes: &[meta_db::Theme],
) -> (serde_json::Value, Option<RoutingResult>) {
    let docs_dir = state.user_docs_dir(&user.sub);

    match name {
        "get_doc" => {
            let id_str = input.get("doc_id").and_then(|v| v.as_str()).unwrap_or("");
            let result = id_str.parse::<Uuid>().ok()
                .and_then(|id| state.index.get_file_name(&user.sub, id))
                .and_then(|f| file::parse_doc(&docs_dir.join(f)).ok())
                .and_then(|doc| serde_json::to_value(DocResponse::from(&doc)).ok())
                .unwrap_or_else(|| serde_json::json!({"error": "doc not found"}));
            (result, None)
        }

        "traverse_subtree" => {
            use std::collections::{HashSet, VecDeque};
            let id_str = input.get("doc_id").and_then(|v| v.as_str()).unwrap_or("");
            let depth  = input.get("depth").and_then(|v| v.as_u64()).unwrap_or(2).min(5) as u32;

            let result = if let Ok(id) = id_str.parse::<Uuid>() {
                let mut visited: HashSet<Uuid> = HashSet::new();
                let mut nodes: Vec<serde_json::Value> = Vec::new();
                let mut edges: Vec<serde_json::Value> = Vec::new();
                let mut queue: VecDeque<(Uuid, u32)> = VecDeque::new();
                visited.insert(id);
                queue.push_back((id, 0));

                while let Some((cur, d)) = queue.pop_front() {
                    if let Some(meta) = state.index.get_meta(&user.sub, cur) {
                        nodes.push(serde_json::json!({
                            "id": cur, "title": meta.title,
                            "task_status": meta.task_status, "priority": meta.priority,
                        }));
                    }
                    if d >= depth { continue; }
                    for fwd in state.index.forward_links_for(&user.sub, cur) {
                        edges.push(serde_json::json!({
                            "source_id": cur, "target_id": fwd.target_id,
                            "label": fwd.label.to_string(),
                        }));
                        if !visited.contains(&fwd.target_id) {
                            visited.insert(fwd.target_id);
                            queue.push_back((fwd.target_id, d + 1));
                        }
                    }
                }
                serde_json::json!({"root_id": id, "depth": depth, "nodes": nodes, "edges": edges})
            } else {
                serde_json::json!({"error": "invalid doc_id"})
            };
            (result, None)
        }

        "route_to_doc" => {
            let doc_id_str = input.get("doc_id").and_then(|v| v.as_str()).unwrap_or("");
            let ai_content = input.get("content_to_append").and_then(|v| v.as_str()).unwrap_or("");
            let confidence = input.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let reasoning  = input.get("reasoning").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let agent_tid  = input.get("theme_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
            let theme_id   = infer_theme_id(agent_tid, themes, ai_content);

            // If user provided a title hint, prepend it as a section header
            let effective_content = match user_title {
                Some(t) if !t.is_empty() => format!("## {}\n\n{}", t, ai_content),
                _ => ai_content.to_string(),
            };

            let result = if confidence >= state.route_threshold {
                match do_append(state, user, doc_id_str, &effective_content, pool, inbox_id, theme_id.as_deref()).await {
                    Ok((doc_id, title)) => RoutingResult {
                        inbox_id: inbox_id.to_string(), status: "routed".to_string(),
                        confidence, target_doc_id: Some(doc_id), target_doc_title: Some(title),
                        action: "appended".to_string(), reasoning, rounds_used,
                    },
                    Err(e) => RoutingResult {
                        inbox_id: inbox_id.to_string(), status: "failed".to_string(),
                        confidence, target_doc_id: None, target_doc_title: None,
                        action: "failed".to_string(),
                        reasoning: format!("{}: {}", reasoning, e), rounds_used,
                    },
                }
            } else {
                RoutingResult {
                    inbox_id: inbox_id.to_string(), status: "hitl_pending".to_string(),
                    confidence, target_doc_id: Some(doc_id_str.to_string()), target_doc_title: None,
                    action: "hitl_queued".to_string(),
                    reasoning: format!(
                        "Confidence {:.2} below threshold {:.2}. {}",
                        confidence, state.route_threshold, reasoning
                    ),
                    rounds_used,
                }
            };
            (serde_json::json!({"status": result.status.clone()}), Some(result))
        }

        "update_doc" => {
            let doc_id_str = input.get("doc_id").and_then(|v| v.as_str()).unwrap_or("");
            let new_body   = input.get("new_body").and_then(|v| v.as_str()).unwrap_or("");
            let confidence = input.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let reasoning  = input.get("reasoning").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let agent_tid  = input.get("theme_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
            let theme_id   = infer_theme_id(agent_tid, themes, new_body);

            let result = if confidence >= state.route_threshold {
                match do_update(state, user, doc_id_str, new_body, pool, inbox_id, theme_id.as_deref()).await {
                    Ok((doc_id, title)) => RoutingResult {
                        inbox_id: inbox_id.to_string(), status: "routed".to_string(),
                        confidence, target_doc_id: Some(doc_id), target_doc_title: Some(title),
                        action: "updated".to_string(), reasoning, rounds_used,
                    },
                    Err(e) => RoutingResult {
                        inbox_id: inbox_id.to_string(), status: "failed".to_string(),
                        confidence, target_doc_id: None, target_doc_title: None,
                        action: "failed".to_string(),
                        reasoning: format!("{}: {}", reasoning, e), rounds_used,
                    },
                }
            } else {
                RoutingResult {
                    inbox_id: inbox_id.to_string(), status: "hitl_pending".to_string(),
                    confidence, target_doc_id: Some(doc_id_str.to_string()), target_doc_title: None,
                    action: "hitl_queued".to_string(),
                    reasoning: format!(
                        "Confidence {:.2} below threshold {:.2}. {}",
                        confidence, state.route_threshold, reasoning
                    ),
                    rounds_used,
                }
            };
            (serde_json::json!({"status": result.status.clone()}), Some(result))
        }

        "create_new_doc" => {
            let ai_title   = input.get("title").and_then(|v| v.as_str()).unwrap_or("Inbox Note");
            let body_text  = input.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let confidence = input.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let reasoning  = input.get("reasoning").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let agent_tid  = input.get("theme_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);

            // User-provided title overrides AI suggestion when present
            let effective_title = user_title
                .filter(|t| !t.is_empty())
                .unwrap_or(ai_title);

            let theme_id = infer_theme_id(agent_tid, themes, &format!("{} {}", effective_title, body_text));

            let result = if confidence >= state.route_threshold {
                match do_create(state, user, effective_title, body_text, pool, inbox_id, theme_id.as_deref()).await {
                    Ok((doc_id, doc_title)) => RoutingResult {
                        inbox_id: inbox_id.to_string(), status: "routed".to_string(),
                        confidence, target_doc_id: Some(doc_id), target_doc_title: Some(doc_title),
                        action: "created".to_string(), reasoning, rounds_used,
                    },
                    Err(e) => RoutingResult {
                        inbox_id: inbox_id.to_string(), status: "failed".to_string(),
                        confidence, target_doc_id: None, target_doc_title: None,
                        action: "failed".to_string(),
                        reasoning: format!("{}: {}", reasoning, e), rounds_used,
                    },
                }
            } else {
                RoutingResult {
                    inbox_id: inbox_id.to_string(), status: "hitl_pending".to_string(),
                    confidence, target_doc_id: None, target_doc_title: None,
                    action: "hitl_queued".to_string(),
                    reasoning: format!(
                        "Confidence {:.2} below threshold {:.2}. {}",
                        confidence, state.route_threshold, reasoning
                    ),
                    rounds_used,
                }
            };
            (serde_json::json!({"status": result.status.clone()}), Some(result))
        }

        "request_hitl" => {
            let reasoning = input.get("reasoning").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let result = RoutingResult {
                inbox_id: inbox_id.to_string(), status: "hitl_pending".to_string(),
                confidence: 0.0, target_doc_id: None, target_doc_title: None,
                action: "hitl_queued".to_string(), reasoning, rounds_used,
            };
            (serde_json::json!({"status": "hitl_pending"}), Some(result))
        }

        _ => (serde_json::json!({"error": format!("unknown tool: {}", name)}), None),
    }
}

// ── Write helpers ─────────────────────────────────────────────────────────────

async fn do_append(
    state: &Arc<AppState>,
    user: &AuthUser,
    doc_id_str: &str,
    content: &str,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    theme_id: Option<&str>,
) -> anyhow::Result<(String, String)> {
    let doc_id: Uuid = doc_id_str.parse()
        .map_err(|_| anyhow::anyhow!("invalid doc_id: {}", doc_id_str))?;
    let docs_dir = state.user_docs_dir(&user.sub);

    let file_name = state.index.get_file_name(&user.sub, doc_id)
        .or_else(|| file::find_doc_path(&docs_dir, doc_id)
            .and_then(|p| p.file_name()?.to_str().map(String::from)))
        .ok_or_else(|| anyhow::anyhow!("doc not found: {}", doc_id))?;

    let mut doc = file::parse_doc(&docs_dir.join(&file_name))?;
    let separator = if doc.body.trim().is_empty() { "" } else { "\n\n" };
    doc.body = format!("{}{}{}", doc.body, separator, content);
    doc.note_outline = Some(file::compute_outline(&doc.body));
    doc.generated = Some(file::make_generated(Some("agent:inbox-router/v4"), "pat"));
    doc.updated_at = Utc::now();
    if let Some(tid) = theme_id {
        if !doc.theme_ids.contains(&tid.to_string()) {
            doc.theme_ids.push(tid.to_string());
        }
    }

    file::write_doc(&docs_dir, &doc, Some(&file_name))?;
    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(
        &user_root,
        &format!("docs/{}", file_name),
        &format!("inbox: routed to {}", doc.title),
    ).ok();
    state.index.upsert(&user.sub, &doc, &file_name);
    spawn_embed_task(
        Arc::clone(state),
        user.sub.clone(),
        doc.id,
        doc_embed_text(&doc.title, &doc.description, &doc.body),
    );

    let doc_id = doc.id;
    let after_snap = serde_json::to_value(DocResponse::from(&doc)).ok();
    let pool_clone = pool.clone();
    let sid = session_id.to_string();
    tokio::spawn(async move {
        meta_db::log_activity(
            &pool_clone, doc_id, "routed", "agent:inbox-router/v4", None, after_snap.as_ref(), Some(&sid),
        ).await.ok();
    });

    Ok((doc.id.to_string(), doc.title.clone()))
}

async fn do_update(
    state: &Arc<AppState>,
    user: &AuthUser,
    doc_id_str: &str,
    new_body: &str,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    theme_id: Option<&str>,
) -> anyhow::Result<(String, String)> {
    let doc_id: Uuid = doc_id_str.parse()
        .map_err(|_| anyhow::anyhow!("invalid doc_id: {}", doc_id_str))?;
    let docs_dir = state.user_docs_dir(&user.sub);

    let file_name = state.index.get_file_name(&user.sub, doc_id)
        .or_else(|| file::find_doc_path(&docs_dir, doc_id)
            .and_then(|p| p.file_name()?.to_str().map(String::from)))
        .ok_or_else(|| anyhow::anyhow!("doc not found: {}", doc_id))?;

    let mut doc = file::parse_doc(&docs_dir.join(&file_name))?;
    doc.body = new_body.to_string();
    doc.note_outline = Some(file::compute_outline(&doc.body));
    doc.generated = Some(file::make_generated(Some("agent:inbox-router/v4"), "pat"));
    doc.updated_at = Utc::now();
    if let Some(tid) = theme_id {
        if !doc.theme_ids.contains(&tid.to_string()) {
            doc.theme_ids.push(tid.to_string());
        }
    }

    file::write_doc(&docs_dir, &doc, Some(&file_name))?;
    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(
        &user_root,
        &format!("docs/{}", file_name),
        &format!("inbox: updated {}", doc.title),
    ).ok();
    state.index.upsert(&user.sub, &doc, &file_name);
    spawn_embed_task(
        Arc::clone(state),
        user.sub.clone(),
        doc.id,
        doc_embed_text(&doc.title, &doc.description, &doc.body),
    );

    let doc_id = doc.id;
    let after_snap = serde_json::to_value(DocResponse::from(&doc)).ok();
    let pool_clone = pool.clone();
    let sid = session_id.to_string();
    tokio::spawn(async move {
        meta_db::log_activity(
            &pool_clone, doc_id, "updated", "agent:inbox-router/v4", None, after_snap.as_ref(), Some(&sid),
        ).await.ok();
    });

    Ok((doc.id.to_string(), doc.title.clone()))
}

async fn do_create(
    state: &Arc<AppState>,
    user: &AuthUser,
    title: &str,
    body_text: &str,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    theme_id: Option<&str>,
) -> anyhow::Result<(String, String)> {
    use std::collections::HashMap;
    use crate::models::{DocLifecycle, DocPriority, TaskStatus};

    let now = Utc::now();
    let mut doc = Doc {
        id: Uuid::new_v4(),
        doc_type: "Note".to_string(),
        title: title.to_string(),
        description: String::new(),
        body: body_text.to_string(),
        lifecycle: DocLifecycle::default(),
        stale_after: None,
        generated: Some(file::make_generated(Some("agent:inbox-router/v4"), "pat")),
        verified: vec![],
        task_status: TaskStatus::default(),
        priority: None,
        flag: false,
        due_date: None,
        due_time: None,
        list_id: None,
        tags: HashMap::new(),
        theme_ids: vec![],
        links: vec![],
        hitl_required: false,
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
    if let Some(tid) = theme_id {
        if !doc.theme_ids.contains(&tid.to_string()) {
            doc.theme_ids.push(tid.to_string());
        }
    }

    let docs_dir = state.user_docs_dir(&user.sub);
    let path = file::write_doc(&docs_dir, &doc, None)?;
    let fname = path.file_name().and_then(|f| f.to_str()).unwrap_or("").to_string();

    let user_root = state.user_root_dir(&user.sub);
    git::commit_file(
        &user_root,
        &format!("docs/{}", fname),
        &format!("inbox: created {}", doc.title),
    ).ok();
    state.index.upsert(&user.sub, &doc, &fname);
    spawn_embed_task(
        Arc::clone(state),
        user.sub.clone(),
        doc.id,
        doc_embed_text(&doc.title, &doc.description, &doc.body),
    );

    let doc_id = doc.id;
    let after_snap = serde_json::to_value(DocResponse::from(&doc)).ok();
    let pool_clone = pool.clone();
    let sid = session_id.to_string();
    tokio::spawn(async move {
        meta_db::log_activity(
            &pool_clone, doc_id, "created", "agent:inbox-router/v4", None, after_snap.as_ref(), Some(&sid),
        ).await.ok();
    });

    Ok((doc.id.to_string(), doc.title.clone()))
}

// ── Metadata apply helper ─────────────────────────────────────────────────────

async fn apply_user_meta_to_doc(
    state: &Arc<AppState>,
    user_sub: &str,
    doc_id_str: &str,
    user_meta: &UserMeta,
) -> anyhow::Result<()> {
    if !user_meta.has_metadata() { return Ok(()); }
    let doc_id: Uuid = doc_id_str.parse()?;
    let docs_dir = state.user_docs_dir(user_sub);
    let file_name = state.index.get_file_name(user_sub, doc_id)
        .or_else(|| file::find_doc_path(&docs_dir, doc_id)
            .and_then(|p| p.file_name()?.to_str().map(String::from)))
        .ok_or_else(|| anyhow::anyhow!("doc not found: {}", doc_id))?;
    let mut doc = file::parse_doc(&docs_dir.join(&file_name))?;
    if let Some(p) = &user_meta.priority    { doc.priority = Some(p.clone()); }
    if let Some(s) = &user_meta.task_status { doc.task_status = s.clone(); }
    if let Some(d) = &user_meta.due_date    { doc.due_date    = Some(d.clone()); }
    if let Some(t) = &user_meta.due_time    { doc.due_time    = Some(t.clone()); }
    doc.updated_at = Utc::now();
    file::write_doc(&docs_dir, &doc, Some(&file_name))?;
    let user_root = state.user_root_dir(user_sub);
    git::commit_file(
        &user_root,
        &format!("docs/{}", file_name),
        &format!("inbox: metadata applied to {}", doc.title),
    ).ok();
    state.index.upsert(user_sub, &doc, &file_name);
    Ok(())
}

// ── Link helpers ─────────────────────────────────────────────────────────────

pub async fn do_link_docs(
    state: &Arc<AppState>,
    user_sub: &str,
    source_id: Uuid,
    target_id: Uuid,
    label: LinkLabel,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    link_source: &str,
) -> anyhow::Result<()> {
    if source_id == target_id {
        anyhow::bail!("self-links are not allowed");
    }
    let docs_dir = state.user_docs_dir(user_sub);
    let file_name = state.index.get_file_name(user_sub, source_id)
        .or_else(|| file::find_doc_path(&docs_dir, source_id)
            .and_then(|p| p.file_name()?.to_str().map(String::from)))
        .ok_or_else(|| anyhow::anyhow!("source doc {} not found", source_id))?;

    let mut doc = file::parse_doc(&docs_dir.join(&file_name))?;
    // Auto-linker must not overwrite a link the user has explicitly set.
    if link_source == "auto" && doc.links.iter().any(|l| l.target_id == target_id && l.source.as_deref() == Some("manual")) {
        return Ok(());
    }
    if !doc.links.iter().any(|l| l.target_id == target_id && l.label == label) {
        doc.links.push(DocLink { target_id, label, title: None, source: Some(link_source.to_string()) });
    }
    doc.updated_at = Utc::now();
    file::write_doc(&docs_dir, &doc, Some(&file_name))?;
    let user_root = state.user_root_dir(user_sub);
    git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("link: {}", doc.title)).ok();
    state.index.upsert(user_sub, &doc, &file_name);

    let after_snap = serde_json::to_value(DocResponse::from(&doc)).ok();
    meta_db::log_activity(
        pool, source_id, "linked", "agent:link-analysis/v4", None, after_snap.as_ref(), Some(session_id),
    ).await.ok();

    Ok(())
}

// ── Async Phase 2: link analysis ──────────────────────────────────────────────

async fn run_async_link_analysis(
    state: Arc<AppState>,
    user_sub: String,
    doc_id_str: String,
    pool: sqlx::SqlitePool,
    session_id: String,
    require_review: bool,
) {
    // Wait for the embedding from Phase 1's spawn_embed_task to be stored
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let doc_id: Uuid = match doc_id_str.parse() { Ok(id) => id, Err(_) => return };

    let query_emb = match meta_db::load_embedding(&pool, doc_id).await.ok().flatten() {
        Some(e) => e,
        None => {
            tracing::debug!("async link analysis: no embedding for {} yet, skipping", doc_id);
            return;
        }
    };

    let all_embeddings = match meta_db::load_all_embeddings(&pool).await {
        Ok(e) => e,
        Err(_) => return,
    };

    // Skip pairs that already have a pending proposal (from spawn_embed_task).
    let pending = meta_db::fetch_link_proposals(&pool, Some("pending")).await.unwrap_or_default();
    let proposed: std::collections::HashSet<(String, String)> = pending.iter().map(|p| {
        let a = p.source_doc_id.clone().min(p.target_doc_id.clone());
        let b = p.source_doc_id.clone().max(p.target_doc_id.clone());
        (a, b)
    }).collect();

    let link_settings = meta_db::get_link_settings(&pool).await.unwrap_or_default();
    let auto_threshold = link_settings.link_auto_threshold;

    let doc_id_str = doc_id.to_string();
    let mut candidates: Vec<(Uuid, f32)> = all_embeddings
        .iter()
        .filter_map(|(id_str, emb)| {
            let id: Uuid = id_str.parse().ok()?;
            if id == doc_id { return None; }
            // Skip stale embeddings from deleted docs.
            if state.index.get_file_name(&user_sub, id).is_none() { return None; }
            let a = doc_id_str.clone().min(id.to_string());
            let b = doc_id_str.clone().max(id.to_string());
            if proposed.contains(&(a, b)) { return None; }
            let sim = cosine_similarity(&query_emb, emb);
            if sim < meta_db::LINK_FLOOR { return None; }
            Some((id, sim))
        })
        .collect();
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(3);

    if candidates.is_empty() { return; }

    let src_doc_opt = {
        let docs_dir = state.user_docs_dir(&user_sub);
        state.index.get_file_name(&user_sub, doc_id)
            .map(|f| docs_dir.join(f))
            .or_else(|| file::find_doc_path(&docs_dir, doc_id))
            .and_then(|p| file::parse_doc(&p).ok())
    };

    for (target_id, confidence) in candidates {
        let label = if let Some(ref src) = src_doc_opt {
            let docs_dir = state.user_docs_dir(&user_sub);
            let tgt_kw = state.index.get_file_name(&user_sub, target_id)
                .map(|f| docs_dir.join(f))
                .or_else(|| file::find_doc_path(&docs_dir, target_id))
                .and_then(|p| file::parse_doc(&p).ok())
                .map(|d| d.vector_keywords)
                .unwrap_or_default();
            crate::store::classify::classify_link_label(&src.body, &src.vector_keywords, &tgt_kw)
        } else {
            LinkLabel::RelatedTo
        };

        // Above threshold + require_review=off → apply directly
        // Everything else above the floor → queue for review
        if confidence >= auto_threshold && !require_review {
            do_link_docs(
                &state, &user_sub, doc_id, target_id, label.clone(), &pool, &session_id, "auto",
            ).await.ok();
        } else {
            meta_db::insert_link_proposal(
                &pool, doc_id, target_id, &label.to_string(), confidence, &session_id,
            ).await.ok();
        }
    }
}

// ── Provider detection & dispatch ────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Provider { Anthropic, Gemini }

fn detect_provider(settings: &crate::meta_db::UserSettings) -> Provider {
    match settings.ai_provider.as_deref() {
        Some("gemini") => Provider::Gemini,
        _ => Provider::Anthropic,
    }
}

/// Calls the right LLM and normalises the response to Anthropic-style content
/// blocks so the routing loop code stays provider-agnostic.
/// Returns (has_tool_calls, anthropic_style_content_blocks, raw_gemini_parts, input_tokens, output_tokens).
/// raw_gemini_parts is Some(_) only for Gemini calls and carries the unmodified response parts
/// (including thoughtSignature) so they can be preserved verbatim in the next round's history.
async fn call_routing_llm(
    http: &reqwest::Client,
    provider: Provider,
    api_key: &str,
    model: &str,
    system: &str,
    messages: &[serde_json::Value],
    tools: &serde_json::Value,
) -> anyhow::Result<(bool, Vec<serde_json::Value>, Option<serde_json::Value>, i64, i64)> {
    match provider {
        Provider::Anthropic => {
            // Strip internal `tool_name` field from tool_result blocks before
            // sending — Anthropic rejects extra fields with invalid_request_error.
            let clean_messages: Vec<serde_json::Value> = messages.iter().map(|m| {
                if let Some(arr) = m["content"].as_array() {
                    let content: Vec<serde_json::Value> = arr.iter().map(|block| {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                            let mut b = block.clone();
                            if let Some(obj) = b.as_object_mut() { obj.remove("tool_name"); }
                            b
                        } else { block.clone() }
                    }).collect();
                    serde_json::json!({"role": m["role"], "content": content})
                } else { m.clone() }
            }).collect();

            let req_body = serde_json::json!({
                "model": model,
                "max_tokens": 1024,
                "system": system,
                "tools": tools,
                "messages": clean_messages,
            });
            let resp = call_anthropic(http, api_key, &req_body).await?;
            if let Some(err_val) = resp.get("error") {
                anyhow::bail!("Anthropic error: {}", err_val);
            }
            let stop_reason = resp["stop_reason"].as_str().unwrap_or("end_turn");
            let content = resp["content"].as_array().cloned().unwrap_or_default();
            let input_tokens  = resp["usage"]["input_tokens"].as_i64().unwrap_or(0);
            let output_tokens = resp["usage"]["output_tokens"].as_i64().unwrap_or(0);
            Ok((stop_reason == "tool_use", content, None, input_tokens, output_tokens))
        }

        Provider::Gemini => {
            let func_decls: Vec<serde_json::Value> = tools.as_array().unwrap_or(&vec![]).iter().map(|t| {
                serde_json::json!({
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["input_schema"],
                })
            }).collect();
            let gemini_tools = serde_json::json!([{"functionDeclarations": func_decls}]);

            let contents: Vec<serde_json::Value> = messages.iter().map(|m| {
                let role = if m["role"].as_str() == Some("assistant") { "model" } else { "user" };
                // For model turns: if we preserved the raw Gemini parts from the previous
                // round (including thoughtSignature), use them verbatim so Gemini 2.5
                // thinking models don't reject the request.
                if role == "model" {
                    if let Some(raw) = m.get("_gemini_raw_parts") {
                        return serde_json::json!({"role": "model", "parts": raw});
                    }
                }
                if let Some(text) = m["content"].as_str() {
                    return serde_json::json!({"role": role, "parts": [{"text": text}]});
                }
                if let Some(arr) = m["content"].as_array() {
                    let parts: Vec<serde_json::Value> = arr.iter().filter_map(|block| {
                        match block["type"].as_str() {
                            Some("text") => Some(serde_json::json!({"text": block["text"]})),
                            Some("tool_use") => Some(serde_json::json!({
                                "functionCall": { "name": block["name"], "args": block["input"] }
                            })),
                            Some("tool_result") => Some(serde_json::json!({
                                "functionResponse": {
                                    "name": block.get("tool_name").and_then(|v| v.as_str()).unwrap_or("tool"),
                                    "response": { "result": block["content"].as_str().unwrap_or("") },
                                }
                            })),
                            _ => None,
                        }
                    }).collect();
                    return serde_json::json!({"role": role, "parts": parts});
                }
                serde_json::json!({"role": role, "parts": []})
            }).collect();

            let req_body = serde_json::json!({
                "system_instruction": { "parts": [{ "text": system }] },
                "tools": gemini_tools,
                // Force tool calling so the model never returns plain text mid-loop.
                "tool_config": { "function_calling_config": { "mode": "ANY" } },
                "contents": contents,
                // 8192 leaves room for thinking tokens (Gemini 2.5 uses them internally).
                "generationConfig": { "maxOutputTokens": 8192 },
            });

            let resp = call_gemini(http, api_key, model, &req_body).await?;

            let raw_parts = resp["candidates"][0]["content"]["parts"]
                .as_array().cloned().unwrap_or_default();

            // Normalize to Anthropic-style blocks for the routing logic.
            // thought/thoughtSignature parts become text blocks (or are ignored).
            let content: Vec<serde_json::Value> = raw_parts.iter().enumerate().map(|(i, part)| {
                if let Some(fc) = part.get("functionCall") {
                    serde_json::json!({
                        "type": "tool_use",
                        "id": format!("gemini_tool_{}", i),
                        "name": fc["name"],
                        "input": fc.get("args").cloned().unwrap_or(serde_json::json!({})),
                    })
                } else if part.get("thought").and_then(|v| v.as_bool()) == Some(true) {
                    // Suppress thought parts from routing logic — they carry no tool calls.
                    serde_json::json!({ "type": "text", "text": "" })
                } else {
                    serde_json::json!({
                        "type": "text",
                        "text": part["text"].as_str().unwrap_or(""),
                    })
                }
            }).collect();

            let has_tool_calls = content.iter().any(|b| b["type"].as_str() == Some("tool_use"));
            let input_tokens  = resp["usageMetadata"]["promptTokenCount"].as_i64().unwrap_or(0);
            let output_tokens = resp["usageMetadata"]["candidatesTokenCount"].as_i64().unwrap_or(0);
            // Preserve raw_parts so the routing loop can stash them in the assistant
            // message and replay them verbatim in subsequent rounds (required for
            // Gemini 2.5 thinking models that attach thoughtSignature to function calls).
            Ok((has_tool_calls, content, Some(serde_json::Value::Array(raw_parts)), input_tokens, output_tokens))
        }
    }
}

// ── Anthropic client ──────────────────────────────────────────────────────────

async fn call_anthropic(
    http: &reqwest::Client,
    api_key: &str,
    body: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let resp = http
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(body)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;
    Ok(resp)
}

// ── Gemini client ─────────────────────────────────────────────────────────────

async fn call_gemini(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    body: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );
    let resp = http.post(&url).json(body).send().await?.json::<serde_json::Value>().await?;
    if let Some(err_val) = resp.get("error") {
        anyhow::bail!("Gemini error: {}", err_val);
    }
    Ok(resp)
}

// ── Outline formatting ────────────────────────────────────────────────────────

fn format_outline_for_prompt(outline: Option<&serde_json::Value>) -> String {
    outline
        .and_then(|v| v.as_array())
        .map(|items| {
            items.iter()
                .filter_map(|item| {
                    let level = item.get("level")?.as_u64()? as usize;
                    let text  = item.get("text")?.as_str()?;
                    if text.is_empty() { return None; }
                    Some(format!("{} {}", "#".repeat(level), text))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

fn build_routing_tools() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "get_doc",
            "description": "Read the full content of a doc by its UUID.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "doc_id": { "type": "string", "description": "UUID of the doc to read" }
                },
                "required": ["doc_id"]
            }
        },
        {
            "name": "traverse_subtree",
            "description": "Explore the subgraph reachable from a doc via BFS up to `depth` hops. Returns nodes and edges.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "doc_id": { "type": "string" },
                    "depth":  { "type": "integer", "default": 2 }
                },
                "required": ["doc_id"]
            }
        },
        {
            "name": "route_to_doc",
            "description": "TERMINAL: Append the note to an existing doc. Only call when: (1) the target doc covers the same topic as the note, (2) confidence ≥ 0.75, and (3) the note is additional detail within that doc's scope — not a new standalone concept.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "doc_id":            { "type": "string", "description": "UUID of the target doc" },
                    "content_to_append": { "type": "string", "description": "Clean markdown to append; preserve any structure from the original note" },
                    "confidence":        { "type": "number", "description": "Your confidence 0.0–1.0 that this is the right target doc" },
                    "reasoning":         { "type": "string", "description": "Name the doc, state the confidence, and briefly explain why top alternatives were rejected" },
                    "theme_id":          { "type": "string", "description": "UUID of the user-defined theme this doc belongs to (from User-defined Themes list). Omit if no theme fits." }
                },
                "required": ["doc_id", "content_to_append", "confidence", "reasoning"]
            }
        },
        {
            "name": "update_doc",
            "description": "TERMINAL: Replace the full body of an existing doc. Use ONLY when the note is a status update of existing content — same tasks with different completion states, same items with updated values, or corrections to what is already there. Do NOT use for genuinely new information; use route_to_doc for appending new detail.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "doc_id":    { "type": "string", "description": "UUID of the target doc to replace" },
                    "new_body":  { "type": "string", "description": "Complete replacement markdown body — include all content you want to keep plus the updates from the note" },
                    "confidence": { "type": "number", "description": "Your confidence 0.0–1.0 that this doc is the right target and replacement is the right action" },
                    "reasoning":  { "type": "string", "description": "Name the doc, state why this is a status update (not new info), and confirm the new_body preserves all wanted existing content" },
                    "theme_id":   { "type": "string", "description": "UUID of the user-defined theme. Omit if no theme fits." }
                },
                "required": ["doc_id", "new_body", "confidence", "reasoning"]
            }
        },
        {
            "name": "create_new_doc",
            "description": "TERMINAL: Create a new standalone doc. Only call when: no candidate reaches confidence 0.60, or the note introduces a distinct concept not yet in the graph. Confidence in the title and placement must be ≥ 0.75.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title":      { "type": "string", "description": "Specific noun-phrase title, e.g. 'Japan Trip — Visa Checklist'" },
                    "body":       { "type": "string", "description": "Full clean markdown content for the new doc" },
                    "confidence": { "type": "number", "description": "Your confidence 0.0–1.0 that a new doc is the right choice" },
                    "reasoning":  { "type": "string", "description": "Explain why no existing doc was a fit and why this title/scope is correct" },
                    "theme_id":   { "type": "string", "description": "UUID of the user-defined theme this doc belongs to (from User-defined Themes list). Omit if no theme fits." }
                },
                "required": ["title", "body", "confidence", "reasoning"]
            }
        },
        {
            "name": "request_hitl",
            "description": "TERMINAL: Escalate to human review. Call when: best confidence is 0.60–0.75 (plausible but unclear), two candidates score within 0.10 of each other, the note is high-stakes/sensitive, or 3 tool rounds have not produced confidence ≥ 0.75 for any option.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "reasoning": { "type": "string", "description": "Identify the ambiguity: which docs were considered, their scores, and what specific information is missing to decide" }
                },
                "required": ["reasoning"]
            }
        }
    ])
}
