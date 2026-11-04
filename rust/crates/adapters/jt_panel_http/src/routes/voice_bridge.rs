//! `/api/voice/bridge`: the voice bridge's own routes (spec `2026-10-27-agent-voice-calls-design.md`
//! §10): its heartbeat, its long-polled commands and its event batches. Served to the bridge's
//! bearer key only ([`crate::bearer`]); each answers `200` with what its use case returns.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::calls::bridge::{
    self, CommandsOut, CommandsQuery, EventsInput, EventsOut, RegisterInput, RegisterOut,
};

use crate::bearer::BridgeCtx;
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::state::AppState;

/// `200` with the bridge's capability, its status and how often to register again.
pub async fn register(
    State(state): State<AppState>,
    BridgeCtx(ctx): BridgeCtx,
    ApiJson(body): ApiJson<RegisterInput>,
) -> Result<Json<RegisterOut>, ApiError> {
    Ok(Json(bridge::register(&state.deps, &ctx, body).await?))
}

/// `200` with the commands now the bridge's, after waiting up to `?wait_s=` seconds (25 at most)
/// for one: `?wait_s=&extension=`.
pub async fn commands(
    State(state): State<AppState>,
    BridgeCtx(ctx): BridgeCtx,
    ApiQuery(query): ApiQuery<CommandsQuery>,
) -> Result<Json<CommandsOut>, ApiError> {
    Ok(Json(bridge::commands(&state.deps, &ctx, query).await?))
}

/// `200` with how many of the batch's events were applied now, before, or not at all.
pub async fn events(
    State(state): State<AppState>,
    BridgeCtx(ctx): BridgeCtx,
    ApiJson(body): ApiJson<EventsInput>,
) -> Result<Json<EventsOut>, ApiError> {
    Ok(Json(bridge::events(&state.deps, &ctx, body).await?))
}
