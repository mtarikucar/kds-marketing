//! Operator-only metadata projection.
use crate::{ApiError, AppState, PlatformAuthed};
use axum::{Json, extract::State, http::header, response::IntoResponse};
use jt_app::usecases::ops;
pub async fn health(
    State(state): State<AppState>,
    PlatformAuthed(ctx): PlatformAuthed,
) -> Result<impl IntoResponse, ApiError> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(ops::health(&state.deps, &ctx).await?),
    ))
}
