use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect},
    Json,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::Deserialize;
use time::Duration;

use crate::auth::{make_jwt, GitHubEmail, GitHubTokenResponse, GitHubUser, GoogleTokenResponse, GoogleUserInfo};
use crate::models::AuthUser;
use crate::store::AppState;
use crate::store::{file, git};

// ── Google OAuth ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginQuery { pub next: Option<String> }

pub async fn google_login(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LoginQuery>,
) -> impl IntoResponse {
    let next = q.next.unwrap_or_else(|| "/".to_string());
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid+email+profile&state={}",
        state.google_client_id,
        urlencoding::encode(&state.google_redirect_uri),
        urlencoding::encode(&next),
    );
    Redirect::temporary(&url)
}

#[derive(Deserialize)]
pub struct CallbackQuery { pub code: String, pub state: Option<String> }

pub async fn google_callback(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Query(q): Query<CallbackQuery>,
) -> impl IntoResponse {
    let client = reqwest::Client::new();

    let token_resp = client.post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", q.code.as_str()),
            ("client_id", &state.google_client_id),
            ("client_secret", &state.google_client_secret),
            ("redirect_uri", &state.google_redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send().await;

    let Ok(token_resp) = token_resp else {
        return (StatusCode::BAD_GATEWAY, "OAuth token exchange failed").into_response();
    };
    let Ok(token) = token_resp.json::<GoogleTokenResponse>().await else {
        return (StatusCode::BAD_GATEWAY, "parsing token response failed").into_response();
    };

    let Ok(user_resp) = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(&token.access_token)
        .send().await else {
        return (StatusCode::BAD_GATEWAY, "fetching user info failed").into_response();
    };
    let Ok(user) = user_resp.json::<GoogleUserInfo>().await else {
        return (StatusCode::BAD_GATEWAY, "parsing user info failed").into_response();
    };

    if !state.allowed_emails.is_empty() && !state.allowed_emails.contains(&user.email) {
        return (StatusCode::FORBIDDEN, "email not allowed").into_response();
    }

    let user_id = user.sub.clone();
    if let Err(e) = bootstrap_user(&state, &user_id).await {
        tracing::error!("bootstrap error for {}: {}", user_id, e);
    }

    let Ok(jwt) = make_jwt(&state, &user_id, &user.email, user.name.as_deref().unwrap_or("")) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "jwt error").into_response();
    };

    let cookie = session_cookie(jwt);
    let next = q.state.unwrap_or_else(|| "/".to_string());
    (jar.add(cookie), Redirect::temporary(&next)).into_response()
}

// ── GitHub OAuth ──────────────────────────────────────────────────────────────

pub async fn github_login(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&scope=user:email",
        state.github_client_id
    );
    Redirect::temporary(&url)
}

pub async fn github_callback(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Query(q): Query<CallbackQuery>,
) -> impl IntoResponse {
    let client = reqwest::Client::new();

    let token_resp = client.post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", state.github_client_id.as_str()),
            ("client_secret", state.github_client_secret.as_str()),
            ("code", q.code.as_str()),
        ])
        .send().await;

    let Ok(t) = token_resp.and_then(|r| Ok(r)) else {
        return (StatusCode::BAD_GATEWAY, "GitHub token exchange failed").into_response();
    };
    let Ok(token) = t.json::<GitHubTokenResponse>().await else {
        return (StatusCode::BAD_GATEWAY, "parsing GitHub token failed").into_response();
    };

    let Ok(user_resp) = client.get("https://api.github.com/user")
        .bearer_auth(&token.access_token)
        .header("User-Agent", "productive-v3")
        .send().await else {
        return (StatusCode::BAD_GATEWAY, "GitHub user fetch failed").into_response();
    };
    let Ok(gh_user) = user_resp.json::<GitHubUser>().await else {
        return (StatusCode::BAD_GATEWAY, "parsing GitHub user failed").into_response();
    };

    // Fetch primary verified email
    let email_resp = client.get("https://api.github.com/user/emails")
        .bearer_auth(&token.access_token)
        .header("User-Agent", "productive-v3")
        .send().await;
    let email = match email_resp {
        Ok(r) => r.json::<Vec<GitHubEmail>>().await
            .ok()
            .and_then(|emails| emails.into_iter().find(|e| e.primary && e.verified).map(|e| e.email))
            .unwrap_or_else(|| format!("gh_{}@github.local", gh_user.id)),
        Err(_) => format!("gh_{}@github.local", gh_user.id),
    };

    if !state.allowed_emails.is_empty() && !state.allowed_emails.contains(&email) {
        return (StatusCode::FORBIDDEN, "email not allowed").into_response();
    }

    let user_id = format!("gh_{}", gh_user.id);
    if let Err(e) = bootstrap_user(&state, &user_id).await {
        tracing::error!("bootstrap error for {}: {}", user_id, e);
    }

    let name = gh_user.name.unwrap_or(gh_user.login);
    let Ok(jwt) = make_jwt(&state, &user_id, &email, &name) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "jwt error").into_response();
    };

    let cookie = session_cookie(jwt);
    (jar.add(cookie), Redirect::temporary("/")).into_response()
}

// ── Me / Logout / Seed-fresh ──────────────────────────────────────────────────

pub async fn me(user: AuthUser) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "sub": user.sub,
        "email": user.email,
        "name": user.name,
    }))
}

pub async fn logout(jar: CookieJar) -> impl IntoResponse {
    let removed = Cookie::build((crate::auth::COOKIE_NAME_PUB, ""))
        .path("/")
        .max_age(Duration::seconds(-1))
        .build();
    (jar.remove(removed), Redirect::temporary("/login"))
}

pub async fn seed_fresh(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> impl IntoResponse {
    seed_onboarding_docs(&state, &user.sub).await;
    Json(serde_json::json!({"status": "ok"}))
}

// ── Bootstrap (first login) ───────────────────────────────────────────────────

async fn bootstrap_user(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    let user_root = state.user_root_dir(user_id);

    // Init git repo
    git::ensure_repo(&user_root)?;

    // Init sidecar DB
    crate::meta_db::init_user_meta_db(&user_root).await?;

    // Load existing docs and migrate any UUID-named files to title-based names
    let docs_dir = state.user_docs_dir(user_id);
    let docs_with_files = file::load_all_docs(&docs_dir);
    let is_new = docs_with_files.is_empty();

    for (doc, file_name) in &docs_with_files {
        // Migrate UUID-named files (stem is a valid UUID) to title-based names
        let stem = file_name.trim_end_matches(".md");
        if uuid::Uuid::parse_str(stem).is_ok() {
            let new_stem = file::title_to_stem(&doc.title);
            let new_name = format!("{}.md", new_stem);
            if &new_name != file_name {
                let target = file::resolve_write_path(&docs_dir, &new_stem, doc.id);
                if std::fs::rename(docs_dir.join(file_name), &target).is_ok() {
                    let new_fn = target.file_name().unwrap_or_default().to_string_lossy().to_string();
                    git::commit_rename(
                        &user_root,
                        &format!("docs/{}", file_name),
                        &format!("docs/{}", new_fn),
                        &format!("migrate: rename to title-based"),
                    ).ok();
                    state.index.upsert(user_id, doc, &new_fn);
                    continue;
                }
            }
        }
        state.index.upsert(user_id, doc, file_name);
    }

    // Seed demo data on first login
    if is_new {
        if let Err(e) = seed_demo_data(state, user_id).await {
            tracing::warn!("seed_demo_data failed: {}", e);
        }
    }

    // Ensure file watcher is running for this user (no-op if already started)
    // Note: state here is &AppState, ensure_user_watched needs Arc<AppState>,
    // so we skip the direct call — the watcher starts on first doc write instead.

    Ok(())
}

async fn seed_demo_data(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    seed_onboarding_docs(state, user_id).await;
    Ok(())
}

async fn seed_onboarding_docs(state: &AppState, user_id: &str) {
    use crate::models::{Doc, DocLink, DocPriority, TaskStatus, LinkLabel};
    use chrono::Utc;
    use uuid::Uuid;
    use std::collections::HashMap;

    let docs_dir = state.user_docs_dir(user_id);
    let existing = file::load_all_docs(&docs_dir);
    if existing.iter().any(|(d, _)| d.title == "Example - Read this") {
        return;
    }

    let now = Utc::now();
    let user_root = state.user_root_dir(user_id);

    // Create Travel and Personal info themes in meta DB (idempotent — reuse if already exist)
    let (travel_id, personal_id) = if let Ok(pool) = crate::meta_db::init_user_meta_db(&user_root).await {
        let existing_themes = crate::meta_db::list_themes(&pool).await.unwrap_or_default();

        let travel_id = if let Some(t) = existing_themes.iter().find(|t| t.title == "Travel") {
            t.id.clone()
        } else {
            crate::meta_db::create_theme(&pool, "Travel", "Trip planning, itineraries, and travel docs").await
                .ok().map(|t| t.id).unwrap_or_default()
        };

        let personal_id = if let Some(t) = existing_themes.iter().find(|t| t.title == "Personal") {
            t.id.clone()
        } else {
            crate::meta_db::create_theme(&pool, "Personal", "Personal information and identity documents").await
                .ok().map(|t| t.id).unwrap_or_default()
        };

        (travel_id, personal_id)
    } else {
        (String::new(), String::new())
    };

    // IDs for getting-started docs
    let id_root   = Uuid::new_v4();
    let id_capture = Uuid::new_v4();
    let id_links  = Uuid::new_v4();
    let id_ai     = Uuid::new_v4();

    // IDs for travel example docs
    let id_japan  = Uuid::new_v4();
    let id_visa   = Uuid::new_v4();
    let id_resto  = Uuid::new_v4();

    let link = |target: Uuid, label: LinkLabel| DocLink { target_id: target, label, title: None, source: Some("manual".to_string()) };

    let mut all_docs: Vec<Doc> = vec![
        // ── Getting started ────────────────────────────────────────────────────
        Doc {
            id: id_root,
            doc_type: "Note".to_string(),
            title: "Example - Read this".to_string(),
            description: "Getting started with Productive v4.".to_string(),
            body: "Welcome to Productive v4 — a personal AI knowledge graph.\n\nYour notes live as plain markdown files on disk, version-controlled with git, and queryable by the AI assistant.\n\n## What to do next\n\n- **Capture** — tap the Capture button (or the sidebar icon) to drop a thought. The AI routes it to the right doc automatically.\n- **AI assistant** — open the right-side chat panel to ask questions, create docs, or update fields by natural language.\n- **Themes** — group docs into themes (e.g. Travel, Career). The AI uses themes to route captured notes.\n- **Links** — docs connect via typed links (`belongs_to`, `requires`, `related_to`). The knowledge graph panel shows them visually.\n\nSee the linked docs below for details.".to_string(),
            lifecycle: Default::default(),
            stale_after: None, generated: None, verified: vec![],
            task_status: TaskStatus::Todo,
            priority: Some(DocPriority::Low),
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            theme_ids: vec![],
            links: vec![
                link(id_capture, LinkLabel::Requires),
                link(id_links,   LinkLabel::Requires),
                link(id_ai,      LinkLabel::Requires),
            ],
            hitl_required: false, hitl_status: None, note_outline: None,
            vector_keywords: vec![], keyword_source_hash: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id_capture,
            doc_type: "Note".to_string(),
            title: "Example - How Capture works".to_string(),
            description: "AI-powered inbox routing explained.".to_string(),
            body: "## Capture\n\nThe **Capture** button (sidebar or top of the doc list) opens an input where you type any thought.\n\n- **AI mode** — the AI embeds your text, finds the closest existing doc, and either appends to it or creates a new one. You can set priority, due date, status, and link docs before submitting.\n- **Manual mode** — skips routing. You fill in the title and details yourself.\n\n## Themes\n\nCreate themes in Settings or the sidebar. When the AI routes a capture, it assigns it to the best-matching theme if confidence ≥ 50%. Themes act as high-level topic anchors.\n\n## Route threshold\n\nSet in `.env` as `ROUTE_THRESHOLD` (default 0.80). Below the threshold, the capture goes to the review queue (Settings → Reviews) instead of auto-routing.".to_string(),
            lifecycle: Default::default(),
            stale_after: None, generated: None, verified: vec![],
            task_status: TaskStatus::Todo,
            priority: Some(DocPriority::Low),
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            theme_ids: vec![],
            links: vec![],
            hitl_required: false, hitl_status: None, note_outline: None,
            vector_keywords: vec![], keyword_source_hash: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id_links,
            doc_type: "Reference".to_string(),
            title: "Example - Doc links and the knowledge graph".to_string(),
            description: "Link types, graph traversal, and auto-linking.".to_string(),
            body: "## Link types\n\n| Label | Meaning |\n|---|---|\n| `belongs_to` | Source is a child of target (e.g. Japan Trip → belongs_to → Travel theme) |\n| `requires` | Source depends on target (e.g. Japan Trip → requires → Japan Visa) |\n| `related_to` | Lateral association (e.g. Favorite Restaurants → related_to → Japan Trip) |\n\n## Graph panel\n\nEach doc shows its parents (above) and children (below) in a flow diagram. Click any node to open it.\n\n## Auto-linking\n\nAfter every capture, the system embeds the doc and compares it against all others. Pairs above the similarity threshold are linked automatically (or queued for review if you've enabled that). Adjust the threshold in **Settings → AI Usage → Links**.".to_string(),
            lifecycle: Default::default(),
            stale_after: None, generated: None, verified: vec![],
            task_status: TaskStatus::Todo,
            priority: Some(DocPriority::Low),
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            theme_ids: vec![],
            links: vec![],
            hitl_required: false, hitl_status: None, note_outline: None,
            vector_keywords: vec![], keyword_source_hash: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id_ai,
            doc_type: "Reference".to_string(),
            title: "Example - AI assistant".to_string(),
            description: "What the AI assistant can do and how to use it.".to_string(),
            body: "## AI assistant\n\nOpen the chat panel from the right edge of the screen. The AI has access to your full knowledge graph via tools:\n\n| Tool | What it does |\n|---|---|\n| `list_docs` | Search your docs |\n| `get_doc` | Read a doc's full content |\n| `create_doc` | Create a new doc |\n| `update_doc` | Edit name, body, status, priority |\n| `delete_doc` | Delete permanently |\n| `get_linked_docs` | Traverse outgoing links |\n| `get_lists` / `create_list` | Manage lists |\n\nDocs referenced in responses are clickable — they open inline.\n\n## Providers\n\nSet your provider and model in **Settings → AI Usage → AI Assistant**. Claude and Gemini are supported for capture routing; any OpenRouter model works for chat.".to_string(),
            lifecycle: Default::default(),
            stale_after: None, generated: None, verified: vec![],
            task_status: TaskStatus::Todo,
            priority: Some(DocPriority::Low),
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            theme_ids: vec![],
            links: vec![],
            hitl_required: false, hitl_status: None, note_outline: None,
            vector_keywords: vec![], keyword_source_hash: None,
            created_at: now, updated_at: now,
        },

        // ── Travel example ─────────────────────────────────────────────────────
        Doc {
            id: id_japan,
            doc_type: "Plan".to_string(),
            title: "Example - Japan Trip 2026".to_string(),
            description: "Two-week trip to Japan — planning doc.".to_string(),
            body: "## Japan Trip 2026\n\nA two-week trip planned for October 2026.\n\n- **Budget:** ~$4,000 USD\n- **Duration:** 14 nights\n- **Cities:** Tokyo (7 nights), Kyoto (4 nights), Osaka (3 nights)\n\n## Status\n\n- [ ] Visa (see linked doc)\n- [ ] Flights\n- [ ] Accommodation\n- [ ] JR Pass\n- [ ] Itinerary\n\n## Notes\n\nOctober is peak fall-foliage season. Book accommodation early.".to_string(),
            lifecycle: Default::default(),
            stale_after: None, generated: None, verified: vec![],
            task_status: TaskStatus::InProgress,
            priority: Some(DocPriority::High),
            flag: true,
            due_date: Some("2026-10-01".to_string()),
            due_time: None,
            list_id: None,
            tags: HashMap::new(),
            theme_ids: if travel_id.is_empty() { vec![] } else { vec![travel_id.clone()] },
            links: vec![link(id_visa, LinkLabel::Requires)],
            hitl_required: false, hitl_status: None, note_outline: None,
            vector_keywords: vec![], keyword_source_hash: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id_visa,
            doc_type: "Reference".to_string(),
            title: "Example - Japan Visa".to_string(),
            description: "Japan tourist visa requirements and checklist.".to_string(),
            body: "## Japan Tourist Visa\n\nMost nationalities get visa-free entry for 90 days. Check your passport at mofa.go.jp.\n\n## Checklist (if visa required)\n\n- [ ] Valid passport (6+ months remaining)\n- [ ] Return flight booking\n- [ ] Hotel/accommodation proof\n- [ ] Bank statement (last 3 months)\n- [ ] Itinerary\n- [ ] Visa application form\n\n## Processing time\n\nTypically 5–7 business days. Apply at least 4 weeks before travel.".to_string(),
            lifecycle: Default::default(),
            stale_after: None, generated: None, verified: vec![],
            task_status: TaskStatus::Todo,
            priority: Some(DocPriority::High),
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            theme_ids: if personal_id.is_empty() { vec![] } else { vec![personal_id.clone()] },
            links: vec![],
            hitl_required: false, hitl_status: None, note_outline: None,
            vector_keywords: vec![], keyword_source_hash: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id_resto,
            doc_type: "Note".to_string(),
            title: "Example - Favorite restaurants — Tokyo".to_string(),
            description: "Tokyo restaurant shortlist for the 2026 trip.".to_string(),
            body: "## Tokyo restaurants to try\n\n- **Ichiran Ramen** — solo ramen booths, Shinjuku and Shibuya locations\n- **Tsukiji Outer Market** — breakfast sushi\n- **Gonpachi Nishi-Azabu** — the 'Kill Bill' restaurant, great yakitori\n- **Depachika** — basement food halls in any major department store (Isetan, Takashimaya)\n\n## Budget tip\n\nLunch sets (teishoku) at sit-down restaurants are usually ¥800–1,200 and excellent value.".to_string(),
            lifecycle: Default::default(),
            stale_after: None, generated: None, verified: vec![],
            task_status: TaskStatus::Todo,
            priority: Some(DocPriority::Low),
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            theme_ids: if travel_id.is_empty() { vec![] } else { vec![travel_id.clone()] },
            links: vec![link(id_japan, LinkLabel::RelatedTo)],
            hitl_required: false, hitl_status: None, note_outline: None,
            vector_keywords: vec![], keyword_source_hash: None,
            created_at: now, updated_at: now,
        },
    ];

    for d in &mut all_docs {
        d.note_outline = Some(crate::store::file::compute_outline(&d.body));
        d.vector_keywords = crate::store::keywords::extract_keywords(&d.title, &d.description, &d.body);
        d.keyword_source_hash = Some(crate::store::keywords::source_hash(&d.title, &d.body));
    }

    for d in all_docs {
        if let Ok(path) = crate::store::file::write_doc(&docs_dir, &d, None) {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let rel = format!("docs/{}", file_name);
            crate::store::git::commit_file(&user_root, &rel, &format!("seed: {}", d.title)).ok();
            state.index.upsert(user_id, &d, &file_name);
        }
    }
}

// ── Reset account data ────────────────────────────────────────────────────────

pub async fn reset_account_data(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
) -> impl IntoResponse {
    let docs_dir = state.user_docs_dir(&user.sub);
    let user_root = state.user_root_dir(&user.sub);

    // Collect existing docs from disk so we can remove them from the index
    let existing = file::load_all_docs(&docs_dir);
    let mut deleted = 0usize;

    for (doc, file_name) in &existing {
        let path = docs_dir.join(file_name);
        if std::fs::remove_file(&path).is_ok() {
            state.index.remove(&user.sub, doc.id);
            deleted += 1;
        }
    }

    crate::store::git::commit_file(&user_root, "docs", "reset: deleted all docs").ok();

    // Clear review/proposal/embedding data that references the now-deleted docs
    if let Ok(pool) = crate::meta_db::init_user_meta_db(&user_root).await {
        sqlx::query("DELETE FROM hitl_review").execute(&pool).await.ok();
        sqlx::query("DELETE FROM link_proposals").execute(&pool).await.ok();
        sqlx::query("DELETE FROM doc_embedding").execute(&pool).await.ok();
    }

    // Re-seed fresh demo docs with updated content
    seed_onboarding_docs(&state, &user.sub).await;

    Json(serde_json::json!({ "deleted_docs": deleted, "seeded": true }))
        .into_response()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn session_cookie(jwt: String) -> Cookie<'static> {
    Cookie::build((crate::auth::COOKIE_NAME_PUB, jwt))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(Duration::days(30))
        .build()
}
