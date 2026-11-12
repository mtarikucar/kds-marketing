//! `/api/research/tasks`: research tasks for a person in the panel (spec
//! `2026-10-30-leads-pool-outreach-design.md` §3.7, §7.1). Every route answers `200` with the
//! JSON its MCP tool answers.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::research::{
    self, ClaimOut, CloseInput, CreateInput, GetOut, ListInput, ListOut, TaskOut,
};
use jt_prospects::ResearchTaskId;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with a page of tasks: `?status&limit&before_at&before_id`.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<ListInput>,
) -> Result<Json<ListOut>, ApiError> {
    Ok(Json(research::tasks_list(&state.deps, &ctx, query).await?))
}

/// `200` with the task, what it may still record today, how many it found and its newest
/// prospects.
pub async fn get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ResearchTaskId>,
) -> Result<Json<GetOut>, ApiError> {
    Ok(Json(research::tasks_get(&state.deps, &ctx, id).await?))
}

/// `200` with the ad-hoc task created; `409 prospecting_off` while the strategy has no ICP.
pub async fn create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CreateInput>,
) -> Result<Json<TaskOut>, ApiError> {
    Ok(Json(research::tasks_create(&state.deps, &ctx, body).await?))
}

/// `200` with the claim: the caller's, or another recorder's live one.
pub async fn claim(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ResearchTaskId>,
) -> Result<Json<ClaimOut>, ApiError> {
    Ok(Json(research::tasks_claim(&state.deps, &ctx, id).await?))
}

/// `200` with the closed task; `409 standing_task` for a standing one.
pub async fn close(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ResearchTaskId>,
    ApiJson(body): ApiJson<CloseInput>,
) -> Result<Json<TaskOut>, ApiError> {
    Ok(Json(
        research::tasks_close(&state.deps, &ctx, id, body).await?,
    ))
}
