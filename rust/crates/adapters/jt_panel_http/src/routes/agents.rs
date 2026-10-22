//! `/api/agents`: the agent clients that have connected to the session's current workspace with
//! its API keys.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::agents::{self, AgentConnectionOut};

use crate::error::ApiError;
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with the workspace's agent connections, first seen first.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<AgentConnectionOut>>, ApiError> {
    Ok(Json(agents::list(&state.deps, &ctx).await?))
}
