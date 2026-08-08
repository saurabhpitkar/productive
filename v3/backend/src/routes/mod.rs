pub mod auth;
pub mod docs;
pub mod lists;
pub mod sync;
pub mod tokens;
pub mod hitl;
pub mod ai;

use std::sync::Arc;
use axum::{Router, routing::{get, post, patch, delete}};
use crate::store::AppState;

pub fn router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        // Auth
        .route("/auth/login",          get(auth::google_login))
        .route("/auth/callback",       get(auth::google_callback))
        .route("/auth/github/login",   get(auth::github_login))
        .route("/auth/github/callback", get(auth::github_callback))
        .route("/auth/me",             get(auth::me))
        .route("/auth/logout",         post(auth::logout))
        .route("/auth/seed-fresh",     post(auth::seed_fresh))

        // Docs — all-links MUST be registered before /:id
        .route("/docs/all-links",      get(docs::all_links))
        .route("/docs",                get(docs::list).post(docs::create))
        .route("/docs/:id",            get(docs::get).patch(docs::update).delete(docs::delete))
        .route("/docs/:id/links",      get(docs::get_links).post(docs::add_link))
        .route("/docs/:id/links/:tid", delete(docs::remove_link))
        .route("/docs/:id/backlinks",  get(docs::get_backlinks))

        // Lists
        .route("/lists",       get(lists::list).post(lists::create))
        .route("/lists/:id",   patch(lists::update).delete(lists::delete))

        // Sync
        .route("/sync/delta",  get(sync::delta))

        // Tokens
        .route("/tokens",            get(tokens::list).post(tokens::create))
        .route("/tokens/:id",        delete(tokens::revoke))
        .route("/tokens/:id/trusted", patch(tokens::set_trusted))

        // HITL
        .route("/hitl/reviews",          get(hitl::list_reviews))
        .route("/hitl/reviews/:id",      get(hitl::get_review))
        .route("/hitl/reviews/:id/resolve", post(hitl::resolve_review))

        // AI
        .route("/ai/settings",  get(ai::get_settings).patch(ai::update_settings))
        .route("/ai/chat",      post(ai::chat))
        .route("/ai/usage",     get(ai::get_usage))
        .route("/ai/embed",     post(ai::embed))
        .route("/ai/context",   get(ai::get_context).patch(ai::update_context))
}
