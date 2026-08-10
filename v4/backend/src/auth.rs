use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::{FromRequestParts, State},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use axum_extra::extract::CookieJar;
use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{AuthMethod, AuthUser};
use crate::store::AppState;

pub const COOKIE_NAME_PUB: &str = "pa_session";
const JWT_EXPIRY_SECS: i64 = 60 * 60 * 24 * 30; // 30 days

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub email: String,
    pub name: String,
    pub exp: i64,
}

pub fn make_jwt(state: &AppState, user_id: &str, email: &str, name: &str) -> Result<String> {
    let claims = Claims {
        sub: user_id.to_string(),
        email: email.to_string(),
        name: name.to_string(),
        exp: Utc::now().timestamp() + JWT_EXPIRY_SECS,
    };
    Ok(encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )?)
}

pub fn verify_jwt(state: &AppState, token: &str) -> Option<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .ok()
    .map(|d| d.claims)
}

// ── Axum extractor ────────────────────────────────────────────────────────────

#[axum::async_trait]
impl FromRequestParts<Arc<AppState>> for AuthUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self, Self::Rejection> {
        // 1. Try Bearer PAT
        if let Some(auth) = parts.headers.get("Authorization") {
            if let Ok(v) = auth.to_str() {
                if v.starts_with("Bearer pa_") {
                    let raw = &v["Bearer ".len()..];
                    if let Some((user_id, trusted)) = crate::meta_db::validate_token(&state.token_db, raw).await {
                        let prefix = raw.chars().take(14).collect::<String>();
                        return Ok(AuthUser {
                            sub: user_id,
                            email: String::new(),
                            name: String::new(),
                            auth_method: AuthMethod::Pat,
                            pat_trusted: trusted,
                        });
                    }
                    return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({"detail": "invalid PAT"}))).into_response());
                }
            }
        }

        // 2. Try cookie JWT
        let jar = CookieJar::from_request_parts(parts, state).await.unwrap();
        if let Some(cookie) = jar.get(COOKIE_NAME_PUB) {
            if let Some(claims) = verify_jwt(state, cookie.value()) {
                return Ok(AuthUser {
                    sub: claims.sub,
                    email: claims.email,
                    name: claims.name,
                    auth_method: AuthMethod::Cookie,
                    pat_trusted: false,
                });
            }
        }

        Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({"detail": "not authenticated"}))).into_response())
    }
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GoogleTokenResponse {
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
pub struct GoogleUserInfo {
    pub sub: String,
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitHubTokenResponse {
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
pub struct GitHubUser {
    pub id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitHubEmail {
    pub email: String,
    pub primary: bool,
    pub verified: bool,
}
