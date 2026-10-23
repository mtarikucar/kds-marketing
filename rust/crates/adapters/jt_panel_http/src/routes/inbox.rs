//! Strategy-gated inbox routes; bodies and outputs are shared with MCP.
use crate::{
    error::{ApiError, ApiJson, ApiPath, ApiQuery},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::usecases::inbox::{JourneyId, PersonId, dictionaries, journeys, people};
use serde_json::Value;

fn to_json(value: &impl serde::Serialize) -> Result<Json<Value>, ApiError> {
    let bytes = serde_json::to_vec(value).map_err(jt_app::error::AppError::from)?;
    Ok(Json(
        serde_json::from_slice(&bytes).map_err(jt_app::error::AppError::from)?,
    ))
}
pub async fn people_search(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(input): ApiQuery<people::SearchInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::search(&state.deps, &ctx, input).await?)
}
pub async fn people_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::get(&state.deps, &ctx, id).await?)
}
pub async fn people_create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<people::CreateInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::create(&state.deps, &ctx, input).await?)
}
pub async fn identities_add(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
    ApiJson(input): ApiJson<people::IdentityInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::add_identity(&state.deps, &ctx, id, input).await?)
}
pub async fn journeys_open(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::open(&state.deps, &ctx, id).await?)
}
pub async fn events_report(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<journeys::ReportInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::report(&state.deps, &ctx, id, input).await?)
}
pub async fn lost_reasons_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Value>, ApiError> {
    to_json(&dictionaries::list_lost_reasons(&state.deps, &ctx).await?)
}
pub async fn lost_reasons_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<dictionaries::LostReasonInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&dictionaries::set_lost_reason(&state.deps, &ctx, input).await?)
}
pub async fn journeys_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::get(&state.deps, &ctx, id).await?)
}
pub async fn journeys_assign_owner(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<journeys::AssignOwnerInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::assign_owner(&state.deps, &ctx, id, input).await?)
}

/// Replace workspace status label overrides; unknown stage keys are VALIDATION.
pub async fn status_labels_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<dictionaries::StatusLabelsInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&dictionaries::set_status_labels(&state.deps, &ctx, input).await?)
}
