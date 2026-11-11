//! `/api/devices`: the workspace's phones for a person in the panel (spec
//! `2026-10-28-device-bridge-design.md` §5.4): the phones, reading a screen, running a command on
//! a phone, one command, and a phone's log. Every route answers `200` with the JSON its MCP tool
//! answers (a list as a bare array). The device bridge's own routes are `/api/devices/bridge/*`
//! ([`super::device_bridge`]).

use axum::Json;
use axum::extract::State;
use jt_app::usecases::devices::agent::{
    self, ActInput, CommandOut, LogQuery, LoggedCommand, ObserveInput, PhoneOut, WaitQuery,
};
use jt_capability::CapabilityId;
use uuid::Uuid;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with the phones that are not retired.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<PhoneOut>>, ApiError> {
    Ok(Json(agent::list(&state.deps, &ctx).await?))
}

/// `200` with the `observe` command queued for the phone, as it stands after the wait. The body
/// is `{screenshot?, wait_s?}`.
pub async fn observe(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(phone): ApiPath<CapabilityId>,
    ApiJson(body): ApiJson<ObserveInput>,
) -> Result<Json<CommandOut>, ApiError> {
    Ok(Json(agent::observe(&state.deps, &ctx, phone, body).await?))
}

/// `200` with the command queued for the phone, as it stands after the wait. The body is
/// `{command, wait_s?}`; a phone that cannot take it is `409` (`device_offline`,
/// `phone_retired`) or `422` (`unsupported_by_bridge`, `unicode_unsupported`, a bound).
pub async fn act(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(phone): ApiPath<CapabilityId>,
    ApiJson(body): ApiJson<ActInput>,
) -> Result<Json<CommandOut>, ApiError> {
    Ok(Json(agent::act(&state.deps, &ctx, phone, body).await?))
}

/// `200` with the command, once it ended or after `?wait_s=` seconds (20 at most).
pub async fn command_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<WaitQuery>,
) -> Result<Json<CommandOut>, ApiError> {
    Ok(Json(
        agent::command_get(&state.deps, &ctx, id, query).await?,
    ))
}

/// `200` with the phone's most recent commands, newest first, without their results: `?limit=`.
pub async fn commands(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(phone): ApiPath<CapabilityId>,
    ApiQuery(query): ApiQuery<LogQuery>,
) -> Result<Json<Vec<LoggedCommand>>, ApiError> {
    Ok(Json(
        agent::commands(&state.deps, &ctx, phone, query).await?,
    ))
}
