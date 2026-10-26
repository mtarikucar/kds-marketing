//! Operator-only evidence and one-time activation code delivery; never cache these responses.
use super::platform::ReasonBody;
use crate::{
    error::{ApiError, ApiJson, ApiPath},
    platform_session::PlatformAuthed,
    state::AppState,
};
use axum::{
    Json,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};
use jt_app::{ports::billing::PaymentId, usecases::platform_payments};
use jt_tenancy::WorkspaceId;

pub async fn list(
    State(state): State<AppState>,
    PlatformAuthed(pctx): PlatformAuthed,
) -> Result<Response, ApiError> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(platform_payments::list(&state.deps, &pctx).await?),
    )
        .into_response())
}
pub async fn confirm(
    State(state): State<AppState>,
    PlatformAuthed(pctx): PlatformAuthed,
    ApiPath((ws, id)): ApiPath<(WorkspaceId, PaymentId)>,
) -> Result<Response, ApiError> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(platform_payments::confirm(&state.deps, &pctx, ws, id).await?),
    )
        .into_response())
}
pub async fn reissue(
    State(state): State<AppState>,
    PlatformAuthed(pctx): PlatformAuthed,
    ApiPath((ws, id)): ApiPath<(WorkspaceId, PaymentId)>,
) -> Result<Response, ApiError> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(platform_payments::reissue(&state.deps, &pctx, ws, id).await?),
    )
        .into_response())
}
pub async fn revoke_activation(
    State(state): State<AppState>,
    PlatformAuthed(pctx): PlatformAuthed,
    ApiPath(ws): ApiPath<WorkspaceId>,
    ApiJson(body): ApiJson<ReasonBody>,
) -> Result<Response, ApiError> {
    Ok(
        Json(platform_payments::revoke_activation(&state.deps, &pctx, ws, &body.reason).await?)
            .into_response(),
    )
}
