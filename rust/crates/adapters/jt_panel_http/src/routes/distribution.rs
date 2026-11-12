//! `/api/distribution`: lead distribution for a person in the panel (spec
//! `2026-10-30-leads-pool-outreach-design.md` §3.9, §7.1). Every route answers `200` with the
//! JSON its MCP tool answers.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::distribution::{
    self, AssignmentsListInput, AssignmentsOut, BackfillInput, Distributed, DistributionOut,
    RepOut, RepSetInput, RulesSetInput,
};
use jt_tenancy::UserId;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with the mode, the rules, the members' profiles and the ownerless and stalled counts.
pub async fn get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<DistributionOut>, ApiError> {
    Ok(Json(distribution::get(&state.deps, &ctx).await?))
}

/// `200` with distribution after the rules (and the mode) are replaced.
pub async fn rules_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<RulesSetInput>,
) -> Result<Json<DistributionOut>, ApiError> {
    Ok(Json(
        distribution::rules_set(&state.deps, &ctx, body).await?,
    ))
}

/// `200` with the member's replaced profile.
pub async fn rep_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(user): ApiPath<UserId>,
    ApiJson(body): ApiJson<RepSetInput>,
) -> Result<Json<RepOut>, ApiError> {
    Ok(Json(
        distribution::rep_set(&state.deps, &ctx, user, body).await?,
    ))
}

/// `200` with a page of the assignment log: `?journey_id&user_id&limit&before_at&before_id`.
pub async fn assignments_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<AssignmentsListInput>,
) -> Result<Json<AssignmentsOut>, ApiError> {
    Ok(Json(
        distribution::assignments_list(&state.deps, &ctx, query).await?,
    ))
}

/// `200` with what the backfill decided.
pub async fn backfill(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<BackfillInput>,
) -> Result<Json<Distributed>, ApiError> {
    Ok(Json(distribution::backfill(&state.deps, &ctx, body).await?))
}
