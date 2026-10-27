//! `/api/calls`: the workspace's phone calls (spec `2026-10-27-agent-voice-calls-design.md` §7):
//! the call policy, placing a rep's call, the call log and one call, and ending a call with its
//! outcome. Every route answers `200` with the JSON its MCP tool answers (the list as a bare
//! array); numbers are masked, except in one call's view for a person holding `calls.manage`.

use axum::Json;
use axum::extract::State;
use jt_app::ports::calls::{CallId, CallPolicy};
use jt_app::usecases::calls::{self, CallOut, EndInput, ListQuery, PlaceInput, PolicyInput};
use serde_json::Value;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with the call policy (the defaults while none is stored).
pub async fn policy_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<CallPolicy>, ApiError> {
    Ok(Json(calls::policy_get(&state.deps, &ctx).await?))
}

/// `200` with the stored policy. The body is the whole policy, read strictly.
pub async fn policy_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<PolicyInput>,
) -> Result<Json<CallPolicy>, ApiError> {
    Ok(Json(calls::policy_set(&state.deps, &ctx, body).await?))
}

/// `200` with the placed call; a refusal is `409` with `details.reason`.
pub async fn place(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<PlaceInput>,
) -> Result<Json<CallOut>, ApiError> {
    Ok(Json(calls::place(&state.deps, &ctx, body).await?))
}

/// `200` with the calls, newest first: `?person_id=&state=&direction=&since=&limit=`.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    Ok(Json(calls::list(&state.deps, &ctx, query).await?))
}

/// `200` with the call and its turns.
pub async fn get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CallId>,
) -> Result<Json<CallOut>, ApiError> {
    Ok(Json(calls::get(&state.deps, &ctx, id).await?))
}

/// `200` with the ended call. The body is `{outcome, summary?, follow_up_task?}`.
pub async fn end(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CallId>,
    ApiJson(body): ApiJson<EndInput>,
) -> Result<Json<CallOut>, ApiError> {
    Ok(Json(calls::end(&state.deps, &ctx, id, body).await?))
}
