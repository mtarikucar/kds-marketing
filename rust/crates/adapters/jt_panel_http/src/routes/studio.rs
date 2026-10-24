//! Studio controls use the same strict DTOs and services as MCP.
use crate::{
    error::{ApiError, ApiJson},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::ports::studio::StudioControl;
use jt_app::usecases::studio::control::{
    self, ApprovalInput, ApprovalOut, BrakeInput, StudioPolicyInput,
};
pub async fn brake(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<BrakeInput>,
) -> Result<Json<StudioControl>, ApiError> {
    Ok(Json(control::brake(&s.deps, &ctx, body).await?))
}
pub async fn policy_set(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<StudioPolicyInput>,
) -> Result<Json<StudioControl>, ApiError> {
    Ok(Json(control::policy_set(&s.deps, &ctx, body).await?))
}
pub async fn approve(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<ApprovalInput>,
) -> Result<Json<ApprovalOut>, ApiError> {
    Ok(Json(control::approve(&s.deps, &ctx, body).await?))
}
