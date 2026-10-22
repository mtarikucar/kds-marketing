//! `/api/api-keys`: the API keys of the session's current workspace.
//!
//! Issuing answers `201` with the key's plaintext, the only time it is ever shown, marked
//! `Cache-Control: no-store`; the list never carries it. Revoking answers `204`.

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use jt_app::usecases::api_keys::{self, CreateKey, KeySummary};
use jt_tenancy::ApiKeyId;
use serde::Deserialize;

use crate::error::{ApiError, ApiJson, ApiPath};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `POST /api/api-keys`. Without `scopes` (or with none) the key gets every permission of its
/// issuer. An unknown field is refused, as `jeeta.api_keys.create` refuses it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateKeyBody {
    pub name: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// `201` with the new key, including its plaintext.
pub async fn create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CreateKeyBody>,
) -> Result<Response, ApiError> {
    let input = CreateKey {
        name: body.name,
        scopes: body.scopes,
    };
    let key = api_keys::create(&state.deps, &ctx, input).await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(key),
    )
        .into_response())
}

/// `200` with the workspace's keys, active and revoked.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<KeySummary>>, ApiError> {
    Ok(Json(api_keys::list(&state.deps, &ctx).await?))
}

/// `204`: the key is revoked.
pub async fn revoke(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(key_id): ApiPath<ApiKeyId>,
) -> Result<StatusCode, ApiError> {
    api_keys::revoke(&state.deps, &ctx, key_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
