//! `/api/calls`: the workspace's phone calls (spec `2026-10-27-agent-voice-calls-design.md` §7):
//! the call policy, placing a call, the call log and one call, a call's turns as they come (the
//! live view's long-poll), saying a sentence on an agent's call or handing it over to a rep, and
//! ending a call with its outcome. Every route answers `200` with the JSON its MCP tool answers
//! (the list as a bare array); numbers are masked, except in one call's view for a person holding
//! `calls.manage`.

use axum::Json;
use axum::extract::State;
use jt_app::ports::calls::{CallId, CallPolicy};
use jt_app::usecases::calls::listen::{self as listening, ListenOut, ListenQuery};
use jt_app::usecases::calls::say::{self as saying, SayInput, SayOut, TransferInput};
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

/// `200` with the call's turns after `?after_seq=`, once there are any or the call ended, else
/// after `?wait_s=` seconds (25 at most) with `timed_out`.
pub async fn listen(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CallId>,
    ApiQuery(query): ApiQuery<ListenQuery>,
) -> Result<Json<ListenOut>, ApiError> {
    Ok(Json(listening::listen(&state.deps, &ctx, id, query).await?))
}

/// `200` with the queued sentence's turn. The body is `{text, expect_reply?, allow_barge_in?}`;
/// a call not on the line is `409` with `details.reason = "not_live"`.
pub async fn say(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CallId>,
    ApiJson(body): ApiJson<SayInput>,
) -> Result<Json<SayOut>, ApiError> {
    Ok(Json(saying::say(&state.deps, &ctx, id, body).await?))
}

/// `200` with the transferred call. The body is `{to_extension?}`.
pub async fn transfer(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CallId>,
    ApiJson(body): ApiJson<TransferInput>,
) -> Result<Json<CallOut>, ApiError> {
    Ok(Json(saying::transfer(&state.deps, &ctx, id, body).await?))
}
