//! `/api/agents`: the agent clients that have connected to the session's current workspace with
//! its API keys; their wake addresses (`/api/agents/wakes`, `/api/agents/{api_key_id}/wake`),
//! which only a person reads and sets; and `/api/whoami`, the caller in that workspace.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::agents::{self, AgentConnectionOut, WhoAmI};
use jt_app::usecases::wake::{self, WakeKind, WakesOut};
use jt_tenancy::ApiKeyId;
use serde::Deserialize;

use crate::error::{ApiError, ApiJson, ApiPath};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with the workspace's agent connections, first seen first.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<AgentConnectionOut>>, ApiError> {
    Ok(Json(agents::list(&state.deps, &ctx).await?))
}

/// `200` with the signed-in user in the session's current workspace (`agents.whoami`): the same
/// answer `jeeta.agent.whoami` gives an agent, with the human as the actor.
pub async fn whoami(WorkspaceCtx(ctx): WorkspaceCtx) -> Result<Json<WhoAmI>, ApiError> {
    Ok(Json(agents::whoami(&ctx)?))
}

/// `200` with every agent's wake state and what each kind of waiting work can expect.
pub async fn wakes(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<WakesOut>, ApiError> {
    Ok(Json(wake::list(&state.deps, &ctx).await?))
}

/// `PUT /api/agents/{api_key_id}/wake`: the address. The token and secret are taken here and
/// never answered back.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeBody {
    pub kind: WakeKind,
    #[serde(default)]
    pub routine_id: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub secret: Option<String>,
}

/// `200` with the wake states after the address was set.
pub async fn wake_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(api_key_id): ApiPath<ApiKeyId>,
    ApiJson(body): ApiJson<WakeBody>,
) -> Result<Json<WakesOut>, ApiError> {
    let input = wake::SetWake {
        api_key_id,
        kind: body.kind,
        routine_id: body.routine_id,
        token: body.token,
        url: body.url,
        secret: body.secret,
    };
    Ok(Json(wake::set(&state.deps, &ctx, input).await?))
}

/// `200` with the wake states after the address was removed.
pub async fn wake_remove(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(api_key_id): ApiPath<ApiKeyId>,
) -> Result<Json<WakesOut>, ApiError> {
    Ok(Json(wake::remove(&state.deps, &ctx, api_key_id).await?))
}

/// `200` with the wake states once the agent's wake waits to go out ("run now").
pub async fn wake_now(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(api_key_id): ApiPath<ApiKeyId>,
) -> Result<Json<WakesOut>, ApiError> {
    Ok(Json(wake::wake_now(&state.deps, &ctx, api_key_id).await?))
}
