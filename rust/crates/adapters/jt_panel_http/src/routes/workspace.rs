//! `/api/workspace`: the current workspace.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::workspace::{self, WorkspaceOut};

use crate::error::ApiError;
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with the session's current workspace and the caller's role and permissions there.
pub async fn info(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<WorkspaceOut>, ApiError> {
    Ok(Json(workspace::info(&state.deps, &ctx).await?))
}
