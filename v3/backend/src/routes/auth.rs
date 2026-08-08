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

    // Spawn file watcher
    crate::store::watch::spawn_watcher(
        user_id.to_string(),
        docs_dir,
        state.index.clone(),
    );

    Ok(())
}

async fn seed_demo_data(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    seed_onboarding_docs(state, user_id).await;
    Ok(())
}

async fn seed_onboarding_docs(state: &AppState, user_id: &str) {
    use crate::models::{Doc, DocLink, DocPriority, DocStatus, LinkLabel};
    use chrono::Utc;
    use uuid::Uuid;
    use std::collections::HashMap;

    let docs_dir = state.user_docs_dir(user_id);
    let existing = file::load_all_docs(&docs_dir);
    if existing.iter().any(|(d, _)| d.title == "Read this") {
        return;
    }

    let now = Utc::now();

    // Pre-generate IDs so links can reference them
    let id1 = Uuid::new_v4(); // "Read this"
    let id2 = Uuid::new_v4(); // "Understand doc's data model"
    let id3 = Uuid::new_v4(); // "How it works"
    let id4 = Uuid::new_v4(); // "Advanced connections"
    let id5 = Uuid::new_v4(); // "Demo: 5-Project Knowledge Graph"

    let link = |target: Uuid, label: LinkLabel| DocLink { target_id: target, label };

    let guides: Vec<Doc> = vec![
        Doc {
            id: id1,
            title: "Read this".to_string(),
            description: String::new(),
            body: "Welcome to Productive v3! Your knowledge graph lives as plain markdown files on disk — portable, version-controlled, and AI-ready.\n\nCheck the linked docs below to learn more.".to_string(),
            status: DocStatus::Todo,
            priority: DocPriority::Low,
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            links: vec![
                link(id2, LinkLabel::Requires),
                link(id3, LinkLabel::Requires),
                link(id4, LinkLabel::Requires),
            ],
            hitl_required: false, hitl_status: None, note_outline: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id2,
            title: "Understand doc's data model".to_string(),
            description: String::new(),
            body: "Every doc has:\n- **title** — the name\n- **body** — markdown text with `[[Wiki Links]]`\n- **links** — typed connections: `up`, `requires`, `related_to`\n- **status** / **priority** / **flag** / **due_date**\n- **tags** — key/value metadata\n\nDocs are stored as OKF markdown files with YAML frontmatter.".to_string(),
            status: DocStatus::Todo,
            priority: DocPriority::Low,
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            links: vec![],
            hitl_required: false, hitl_status: None, note_outline: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id3,
            title: "How it works".to_string(),
            description: String::new(),
            body: "## Storage\nYour docs live in `~/.productive/users/{id}/docs/*.md`. Each file is a self-contained OKF document.\n\n## Git\nEvery change is auto-committed. Open a terminal in your docs folder to see the history with `git log`.".to_string(),
            status: DocStatus::InProgress,
            priority: DocPriority::Low,
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            links: vec![
                link(id2, LinkLabel::RelatedTo),
            ],
            hitl_required: false, hitl_status: None, note_outline: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id4,
            title: "Advanced connections".to_string(),
            description: String::new(),
            body: "## Link types\n- `up` — hierarchy: source is a child of target\n- `requires` — dependency: source needs target\n- `related_to` — lateral relationship\n\nAI agents can traverse these links to answer questions across your entire knowledge graph.".to_string(),
            status: DocStatus::Todo,
            priority: DocPriority::Low,
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            links: vec![],
            hitl_required: false, hitl_status: None, note_outline: None,
            created_at: now, updated_at: now,
        },
        Doc {
            id: id5,
            title: "Demo: 5-Project Knowledge Graph".to_string(),
            description: String::new(),
            body: "Build your own knowledge graph with 5 life projects:\n1. Japan Trip\n2. Career\n3. Finance\n4. Health\n5. Learning\n\nLink them together. Ask the AI assistant 'Is October a good time for Japan?' — it will traverse Career, Finance, and Health docs to answer.".to_string(),
            status: DocStatus::Todo,
            priority: DocPriority::High,
            flag: false,
            due_date: None, due_time: None, list_id: None,
            tags: HashMap::new(),
            links: vec![
                link(id1, LinkLabel::RelatedTo),
            ],
            hitl_required: false, hitl_status: None, note_outline: None,
            created_at: now, updated_at: now,
        },
    ];

    let user_root = state.user_root_dir(user_id);
    for mut d in guides {
        d.note_outline = Some(crate::store::file::compute_outline(&d.body));
        if let Ok(path) = crate::store::file::write_doc(&docs_dir, &d, None) {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let rel = format!("docs/{}", file_name);
            crate::store::git::commit_file(&user_root, &rel, &format!("seed: {}", d.title)).ok();
            state.index.upsert(user_id, &d, &file_name);
        }
    }
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
