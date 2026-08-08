use std::sync::Arc;

use axum::{extract::State, http::StatusCode, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::meta_db;
use crate::models::{AuthUser, DocResponse};
use crate::store::{file, AppState};

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

// ── Settings ──────────────────────────────────────────────────────────────────

pub async fn get_settings(State(state): State<Arc<AppState>>, user: AuthUser) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let settings = meta_db::get_settings(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let api_key_set = settings.ai_api_key_enc.is_some();
    let api_key_masked = if api_key_set { "sk-ant-...***".to_string() } else { String::new() };

    Ok(Json(serde_json::json!({
        "provider": settings.ai_provider,
        "model": settings.ai_model,
        "api_key_set": api_key_set,
        "api_key_masked": api_key_masked,
        "prompt_limit": settings.ai_prompt_limit.unwrap_or(4000),
    })))
}

#[derive(Deserialize)]
pub struct UpdateSettingsRequest {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub prompt_limit: Option<i64>,
}

pub async fn update_settings(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<UpdateSettingsRequest>,
) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    meta_db::upsert_settings_singleton(&pool).await.ok();

    if let Some(p) = body.provider {
        sqlx::query("UPDATE user_settings SET ai_provider = ? WHERE id = 'singleton'").bind(p).execute(&pool).await.ok();
    }
    if let Some(m) = body.model {
        sqlx::query("UPDATE user_settings SET ai_model = ? WHERE id = 'singleton'").bind(m).execute(&pool).await.ok();
    }
    if let Some(key) = body.api_key {
        if key.is_empty() {
            sqlx::query("UPDATE user_settings SET ai_api_key_enc = NULL WHERE id = 'singleton'").execute(&pool).await.ok();
        } else {
            let enc = encrypt_key(&state.fernet_key, &key);
            sqlx::query("UPDATE user_settings SET ai_api_key_enc = ? WHERE id = 'singleton'").bind(enc).execute(&pool).await.ok();
        }
    }
    if let Some(limit) = body.prompt_limit {
        sqlx::query("UPDATE user_settings SET ai_prompt_limit = ? WHERE id = 'singleton'").bind(limit).execute(&pool).await.ok();
    }

    Ok(Json(serde_json::json!({"status": "ok"})))
}

// ── Context ───────────────────────────────────────────────────────────────────

pub async fn get_context(State(state): State<Arc<AppState>>, user: AuthUser) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    sqlx::query("INSERT INTO ai_context (id) VALUES ('singleton') ON CONFLICT(id) DO NOTHING")
        .execute(&pool).await.ok();

    use sqlx::Row;
    let row = sqlx::query("SELECT guardrails, persona, domain FROM ai_context WHERE id = 'singleton'")
        .fetch_one(&pool)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let guardrails: Option<String> = row.try_get("guardrails").ok().flatten();
    let persona: Option<String> = row.try_get("persona").ok().flatten();
    let domain: Option<String> = row.try_get("domain").ok().flatten();

    Ok(Json(serde_json::json!({
        "guardrails": guardrails.unwrap_or_default(),
        "persona": persona.unwrap_or_default(),
        "domain": domain.unwrap_or_default(),
    })))
}

#[derive(Deserialize)]
pub struct UpdateContextRequest {
    pub guardrails: Option<String>,
    pub persona: Option<String>,
    pub domain: Option<String>,
}

pub async fn update_context(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<UpdateContextRequest>,
) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    sqlx::query("INSERT INTO ai_context (id) VALUES ('singleton') ON CONFLICT(id) DO NOTHING")
        .execute(&pool).await.ok();

    if let Some(g) = body.guardrails {
        sqlx::query("UPDATE ai_context SET guardrails = ? WHERE id = 'singleton'").bind(g).execute(&pool).await.ok();
    }
    if let Some(p) = body.persona {
        sqlx::query("UPDATE ai_context SET persona = ? WHERE id = 'singleton'").bind(p).execute(&pool).await.ok();
    }
    if let Some(d) = body.domain {
        sqlx::query("UPDATE ai_context SET domain = ? WHERE id = 'singleton'").bind(d).execute(&pool).await.ok();
    }

    Ok(Json(serde_json::json!({"status": "ok"})))
}

// ── Chat ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub system_prompt: Option<String>,
}

pub async fn chat(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<ChatRequest>,
) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let settings = meta_db::get_settings(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let Some(key_enc) = settings.ai_api_key_enc else {
        return Err(err(StatusCode::PAYMENT_REQUIRED, "no API key configured"));
    };

    let api_key = decrypt_key(&state.fernet_key, &key_enc)
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "key decryption failed"))?;
    let model_owned = settings.ai_model.unwrap_or_else(|| "claude-sonnet-5".to_string());
    let model = model_owned.as_str();

    // Build system prompt
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let mut sys_parts = vec![
        format!("You are a helpful AI assistant for Productive v3, a personal knowledge graph. Today is {}.", today),
        "Docs are identified as [[Doc Name|uuid]]. When referencing a doc in your response, use this format.".to_string(),
        "Available tools: create_doc, update_doc, get_doc, list_docs, delete_doc, get_lists, create_list, get_linked_docs.".to_string(),
    ];
    if let Some(g) = settings.ai_context_guardrails.as_deref().filter(|s| !s.is_empty()) { sys_parts.push(g.to_string()); }
    if let Some(p) = settings.ai_context_persona.as_deref().filter(|s| !s.is_empty()) { sys_parts.push(p.to_string()); }
    if let Some(d) = settings.ai_context_domain.as_deref().filter(|s| !s.is_empty()) { sys_parts.push(d.to_string()); }
    if let Some(extra) = body.system_prompt { sys_parts.push(extra); }
    let system = sys_parts.join("\n\n");

    // Build tool definitions (same as v2)
    let tools = build_tools();

    // Run tool-use loop (max 8 rounds)
    let http = reqwest::Client::new();
    let mut messages: Vec<serde_json::Value> = body.messages.iter().map(|m| serde_json::json!({
        "role": m.role,
        "content": m.content,
    })).collect();

    let mut final_text = String::new();
    let mut tools_used = false;
    let mut affected_docs: Vec<serde_json::Value> = Vec::new();
    let mut input_tokens_total = 0u64;
    let mut output_tokens_total = 0u64;

    for _ in 0..8 {
        let req_body = serde_json::json!({
            "model": model,
            "max_tokens": settings.ai_prompt_limit.unwrap_or(4000),
            "system": system,
            "tools": tools,
            "messages": messages,
        });

        let resp = call_anthropic(&http, &api_key, &req_body).await
            .map_err(|e| err(StatusCode::BAD_GATEWAY, &e.to_string()))?;

        if let Some(usage) = resp.get("usage") {
            input_tokens_total += usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            output_tokens_total += usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        }

        let stop_reason = resp.get("stop_reason").and_then(|v| v.as_str()).unwrap_or("end_turn");
        let content = resp.get("content").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        messages.push(serde_json::json!({ "role": "assistant", "content": content }));

        if stop_reason != "tool_use" {
            // Extract text from content
            for block in &content {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        final_text = t.to_string();
                    }
                }
            }
            break;
        }

        // Handle tool calls
        tools_used = true;
        let mut tool_results = Vec::new();
        for block in &content {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") { continue; }
            let tool_id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input = block.get("input").cloned().unwrap_or_default();

            let result = handle_tool(tool_name, input, &state, &user, &mut affected_docs).await;
            tool_results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tool_id,
                "content": result.to_string(),
            }));
        }
        messages.push(serde_json::json!({ "role": "user", "content": tool_results }));
    }

    // Log usage (swallow errors — never fail the chat response)
    meta_db::log_ai_usage(&pool, model, input_tokens_total as i64, output_tokens_total as i64).await.ok();

    Ok(Json(serde_json::json!({
        "response": final_text,
        "tools_used": tools_used,
        "affected_docs": affected_docs,
    })))
}

// ── Usage ─────────────────────────────────────────────────────────────────────

pub async fn get_usage(State(state): State<Arc<AppState>>, user: AuthUser) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    use sqlx::Row;
    let since = (Utc::now() - chrono::Duration::days(7)).to_rfc3339();
    let rows = sqlx::query(
        "SELECT model, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
         FROM ai_usage WHERE created_at > ? GROUP BY model"
    )
    .bind(&since)
    .fetch_all(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let by_model: Vec<serde_json::Value> = rows.iter().map(|r| {
        let model: String = r.try_get("model").unwrap_or_default();
        let input: i64 = r.try_get("input_tokens").unwrap_or(0);
        let output: i64 = r.try_get("output_tokens").unwrap_or(0);
        serde_json::json!({ "model": model, "input_tokens": input, "output_tokens": output })
    }).collect();

    Ok(Json(serde_json::json!({ "by_model": by_model })))
}

// ── Embed ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EmbedRequest { pub text: String }

pub async fn embed(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<EmbedRequest>,
) -> Res<serde_json::Value> {
    let user_root = state.user_root_dir(&user.sub);
    let pool = meta_db::init_user_meta_db(&user_root).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let settings = meta_db::get_settings(&pool).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let key_enc = settings.ai_api_key_enc
        .ok_or_else(|| err(StatusCode::PAYMENT_REQUIRED, "no API key"))?;

    let api_key = decrypt_key(&state.fernet_key, &key_enc)
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "key decryption failed"))?;

    let http = reqwest::Client::new();
    let resp = http.post("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent")
        .query(&[("key", &api_key)])
        .json(&serde_json::json!({ "content": { "parts": [{ "text": body.text }] } }))
        .send().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, &e.to_string()))?;

    let json = resp.json::<serde_json::Value>().await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, &e.to_string()))?;
    Ok(Json(json))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn build_tools() -> serde_json::Value {
    serde_json::json!([
        { "name": "list_docs", "description": "List docs for the user", "input_schema": { "type": "object", "properties": { "q": { "type": "string" }, "status": { "type": "string" }, "limit": { "type": "integer" } } } },
        { "name": "get_doc", "description": "Get a doc by ID", "input_schema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } },
        { "name": "create_doc", "description": "Create a new doc", "input_schema": { "type": "object", "properties": { "name": { "type": "string" }, "body": { "type": "string" }, "status": { "type": "string" }, "priority": { "type": "string" }, "links": { "type": "array", "items": { "type": "object" } } }, "required": ["name"] } },
        { "name": "update_doc", "description": "Update an existing doc", "input_schema": { "type": "object", "properties": { "id": { "type": "string" }, "name": { "type": "string" }, "body": { "type": "string" }, "status": { "type": "string" } }, "required": ["id"] } },
        { "name": "delete_doc", "description": "Delete a doc permanently", "input_schema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } },
        { "name": "get_linked_docs", "description": "Get docs linked to a doc", "input_schema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } },
        { "name": "get_lists", "description": "Get all lists", "input_schema": { "type": "object", "properties": {} } },
        { "name": "create_list", "description": "Create a new list", "input_schema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } },
    ])
}

async fn call_anthropic(http: &reqwest::Client, api_key: &str, body: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let resp = http.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(body)
        .send().await?
        .json::<serde_json::Value>().await?;
    Ok(resp)
}

async fn handle_tool(
    name: &str,
    input: serde_json::Value,
    state: &AppState,
    user: &AuthUser,
    affected_docs: &mut Vec<serde_json::Value>,
) -> serde_json::Value {
    let docs_dir = state.user_docs_dir(&user.sub);
    match name {
        "list_docs" => {
            let docs = file::load_all_docs(&docs_dir);
            let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
            let q = input.get("q").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let results: Vec<serde_json::Value> = docs.iter()
                .filter(|(d, _)| q.is_empty() || d.title.to_lowercase().contains(&q))
                .take(limit)
                .map(|(d, _)| serde_json::json!({ "id": d.id, "name": d.title, "status": d.status.to_string(), "body": &d.body[..d.body.len().min(200)] }))
                .collect();
            serde_json::json!(results)
        }
        "get_doc" => {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let id: uuid::Uuid = match id.parse() { Ok(v) => v, Err(_) => return serde_json::json!({"error": "invalid id"}) };
            let path = state.index.get_file_name(&user.sub, id)
                .map(|f| docs_dir.join(f))
                .or_else(|| file::find_doc_path(&docs_dir, id));
            match path.and_then(|p| file::parse_doc(&p).ok()) {
                Some(d) => { affected_docs.push(serde_json::json!({"id": d.id, "name": d.title})); serde_json::to_value(DocResponse::from(&d)).unwrap_or_default() }
                None => serde_json::json!({"error": "not found"}),
            }
        }
        "create_doc" => {
            use crate::models::{Doc, DocPriority, DocStatus};
            let now = Utc::now();
            let title = input.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
            let mut doc = Doc {
                id: Uuid::new_v4(), title: title.clone(), description: String::new(),
                body: input.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                status: DocStatus::Todo, priority: DocPriority::Medium, flag: false,
                due_date: None, due_time: None, list_id: None, tags: Default::default(),
                links: vec![], hitl_required: false, hitl_status: None, note_outline: None,
                created_at: now, updated_at: now,
            };
            doc.note_outline = Some(file::compute_outline(&doc.body));
            if let Ok(path) = file::write_doc(&docs_dir, &doc, None) {
                let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let user_root = state.user_root_dir(&user.sub);
                crate::store::git::commit_file(&user_root, &format!("docs/{}", file_name), &format!("create: {}", doc.title)).ok();
                state.index.upsert(&user.sub, &doc, &file_name);
                affected_docs.push(serde_json::json!({"id": doc.id, "name": doc.title}));
                serde_json::to_value(DocResponse::from(&doc)).unwrap_or_default()
            } else {
                serde_json::json!({"error": "failed to create"})
            }
        }
        "update_doc" => {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let id: uuid::Uuid = match id.parse() { Ok(v) => v, Err(_) => return serde_json::json!({"error": "invalid id"}) };
            let current_file_name = state.index.get_file_name(&user.sub, id)
                .or_else(|| file::find_doc_path(&docs_dir, id)
                    .and_then(|p| p.file_name().and_then(|f| f.to_str()).map(String::from)));
            match current_file_name {
                None => serde_json::json!({"error": "not found"}),
                Some(current_file_name) => {
                    let path = docs_dir.join(&current_file_name);
                    match file::parse_doc(&path) {
                        Ok(mut doc) => {
                            if let Some(b) = input.get("body").and_then(|v| v.as_str()) { doc.body = b.to_string(); doc.note_outline = Some(file::compute_outline(&doc.body)); }
                            if let Some(n) = input.get("name").and_then(|v| v.as_str()) { doc.title = n.to_string(); }
                            if let Some(s) = input.get("status").and_then(|v| v.as_str()) { doc.status = s.parse().unwrap_or_default(); }
                            doc.updated_at = Utc::now();
                            if let Ok(new_path) = file::write_doc(&docs_dir, &doc, Some(&current_file_name)) {
                                let new_file_name = new_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                                let user_root = state.user_root_dir(&user.sub);
                                crate::store::git::commit_file(&user_root, &format!("docs/{}", new_file_name), &format!("update: {}", doc.title)).ok();
                                state.index.upsert(&user.sub, &doc, &new_file_name);
                                affected_docs.push(serde_json::json!({"id": doc.id, "name": doc.title}));
                                serde_json::to_value(DocResponse::from(&doc)).unwrap_or_default()
                            } else { serde_json::json!({"error": "write failed"}) }
                        }
                        Err(_) => serde_json::json!({"error": "not found"}),
                    }
                }
            }
        }
        "delete_doc" => {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let id: uuid::Uuid = match id.parse() { Ok(v) => v, Err(_) => return serde_json::json!({"error": "invalid id"}) };
            if user.auth_method == crate::models::AuthMethod::Pat && !user.pat_trusted {
                return serde_json::json!({"error": "delete blocked: untrusted PAT"});
            }
            let file_name = state.index.get_file_name(&user.sub, id)
                .or_else(|| file::find_doc_path(&docs_dir, id)
                    .and_then(|p| p.file_name().and_then(|f| f.to_str()).map(String::from)));
            match file_name {
                None => serde_json::json!({"error": "not found"}),
                Some(file_name) => {
                    let path = docs_dir.join(&file_name);
                    match file::parse_doc(&path) {
                        Ok(doc) => {
                            file::delete_doc_file(&docs_dir, &file_name).ok();
                            let user_root = state.user_root_dir(&user.sub);
                            crate::store::git::commit_remove(&user_root, &format!("docs/{}", file_name), &format!("delete: {}", doc.title)).ok();
                            state.index.remove(&user.sub, id);
                            serde_json::json!({"status": "deleted"})
                        }
                        Err(_) => serde_json::json!({"error": "not found"}),
                    }
                }
            }
        }
        "get_linked_docs" => {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let id: uuid::Uuid = match id.parse() { Ok(v) => v, Err(_) => return serde_json::json!({"error": "invalid id"}) };
            let path = state.index.get_file_name(&user.sub, id)
                .map(|f| docs_dir.join(f))
                .or_else(|| file::find_doc_path(&docs_dir, id));
            match path.and_then(|p| file::parse_doc(&p).ok()) {
                Some(doc) => {
                    let linked: Vec<serde_json::Value> = doc.links.iter().filter_map(|l| {
                        let lpath = state.index.get_file_name(&user.sub, l.target_id)
                            .map(|f| docs_dir.join(f))
                            .or_else(|| file::find_doc_path(&docs_dir, l.target_id));
                        lpath.and_then(|p| file::parse_doc(&p).ok())
                            .map(|d| serde_json::json!({"id": d.id, "name": d.title, "label": l.label.to_string()}))
                    }).collect();
                    serde_json::json!(linked)
                }
                None => serde_json::json!({"error": "not found"}),
            }
        }
        "get_lists" => {
            let user_root = state.user_root_dir(&user.sub);
            serde_json::to_value(file::load_lists(&user_root)).unwrap_or_default()
        }
        "create_list" => {
            let user_root = state.user_root_dir(&user.sub);
            let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
            let now = Utc::now();
            let list = crate::models::List { id: Uuid::new_v4(), name, created_at: now, updated_at: now };
            let mut lists = file::load_lists(&user_root);
            lists.push(list.clone());
            file::save_lists(&user_root, &lists).ok();
            crate::store::git::commit_file(&user_root, "_lists.yaml", &format!("create list: {}", list.name)).ok();
            serde_json::to_value(&list).unwrap_or_default()
        }
        _ => serde_json::json!({"error": format!("unknown tool: {}", name)}),
    }
}

fn encrypt_key(fernet_key: &str, plaintext: &str) -> String {
    if fernet_key.is_empty() { return plaintext.to_string(); }
    match fernet::Fernet::new(fernet_key) {
        Some(f) => f.encrypt(plaintext.as_bytes()),
        None => plaintext.to_string(),
    }
}

fn decrypt_key(fernet_key: &str, ciphertext: &str) -> anyhow::Result<String> {
    if fernet_key.is_empty() { return Ok(ciphertext.to_string()); }
    match fernet::Fernet::new(fernet_key) {
        Some(f) => {
            let bytes = f.decrypt(ciphertext).map_err(|_| anyhow::anyhow!("decryption failed"))?;
            Ok(String::from_utf8(bytes)?)
        }
        None => anyhow::bail!("invalid fernet key"),
    }
}
