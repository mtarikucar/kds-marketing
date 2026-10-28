//! The voice bridge's key on its routes (`/api/voice/bridge/*`, the catalog's `calls.bridge.*`):
//! those routes take an `Authorization: Bearer` API key, read and resolved as the MCP endpoint
//! does (`api_keys::bearer_of`, `api_keys::authenticate`), and never the session cookie. The gate
//! layer resolves the key before anything else ([`crate::gate`]); the handler's [`BridgeCtx`]
//! takes the principal it left in the request. A missing, unknown or revoked key is `401` with
//! the one message every unusable key gets.

use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;
use jt_app::catalog::UseCase;
use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::usecases::api_keys::{self, AgentPrincipal};
use jt_app::usecases::calls::bridge;

use crate::error::ApiError;
use crate::state::AppState;

/// The catalog id prefix of the use cases served to the voice bridge's key.
const BRIDGE_USE_CASES: &str = "calls.bridge.";

/// Whether use case `uc` is served to a bearer key instead of a panel session.
pub fn takes_bearer_key(uc: &UseCase) -> bool {
    uc.id.starts_with(BRIDGE_USE_CASES)
}

/// The principal behind the request's bearer key, resolved once per request.
pub async fn principal(parts: &mut Parts, state: &AppState) -> Result<AgentPrincipal, ApiError> {
    if let Some(principal) = parts.extensions.get::<AgentPrincipal>() {
        return Ok(principal.clone());
    }
    let bearer = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(api_keys::bearer_of)
        .ok_or_else(|| AppError::unauthenticated(api_keys::INVALID_KEY))?;
    let principal = api_keys::authenticate(&state.deps, bearer).await?;
    parts.extensions.insert(principal.clone());
    Ok(principal)
}

/// The context of a voice bridge's call: its key's principal as `calls::bridge::ctx_for_bridge`
/// makes it, at the clock's time. `401` without a usable bearer key.
#[derive(Clone, Debug)]
pub struct BridgeCtx(pub Ctx);

impl FromRequestParts<AppState> for BridgeCtx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let principal = principal(parts, state).await?;
        Ok(BridgeCtx(bridge::ctx_for_bridge(
            &principal,
            state.deps.clock.now(),
        )))
    }
}
