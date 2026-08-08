use std::sync::Arc;

use axum::{extract::{Path, State}, http::StatusCode, Json};
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::meta_db::ApiToken;
use crate::models::{AuthMethod, AuthUser};
use crate::store::AppState;

type Res<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"detail": msg})))
}

pub async fn list(State(state): State<Arc<AppState>>, user: AuthUser) -> Res<Vec<ApiToken>> {
    let tokens = crate::meta_db::list_tokens(&state.token_db, &user.sub).await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(tokens))
}

#[derive(Deserialize)]
pub struct CreateTokenRequest { pub name: String }

#[derive(Serialize)]
pub struct CreateTokenResponse {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub token: String,
    pub created_at: String,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Json(body): Json<CreateTokenRequest>,
) -> Res<CreateTokenResponse> {
    let raw_bytes: Vec<u8> = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(40).collect();
    let raw_suffix = String::from_utf8(raw_bytes).unwrap();
    let raw = format!("pa_{}", raw_suffix);
    let hash = hex::encode(Sha256::digest(raw.as_bytes()));
    let prefix = raw.chars().take(14).collect::<String>();
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO api_token (id, user_id, name, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&user.sub)
    .bind(&body.name)
    .bind(&hash)
    .bind(&prefix)
    .bind(&now)
    .execute(&state.token_db)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    Ok(Json(CreateTokenResponse { id, name: body.name, prefix, token: raw, created_at: now }))
}

pub async fn revoke(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let result = sqlx::query("DELETE FROM api_token WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.sub)
        .execute(&state.token_db)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err(err(StatusCode::NOT_FOUND, "token not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SetTrustedRequest { pub trusted: bool }

pub async fn set_trusted(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<SetTrustedRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    if user.auth_method == AuthMethod::Pat {
        return Err(err(StatusCode::FORBIDDEN, "only browser users can set trusted flag"));
    }
    let trusted = body.trusted as i64;
    sqlx::query("UPDATE api_token SET trusted = ? WHERE id = ? AND user_id = ?")
        .bind(trusted)
        .bind(&id)
        .bind(&user.sub)
        .execute(&state.token_db)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(StatusCode::OK)
}
