//! `/api/agents`: the agent clients that have connected to the session's current workspace with
//! its API keys; and `/api/whoami`, the caller in that workspace.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::agents::{self, AgentConnectionOut, WhoAmI};

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

/// `200` with the signed-in user in the session's current workspace (`agents.whoami`): the same
/// answer `jeeta.agent.whoami` gives an agent, with the human as the actor.
pub async fn whoami(WorkspaceCtx(ctx): WorkspaceCtx) -> Result<Json<WhoAmI>, ApiError> {
    Ok(Json(agents::whoami(&ctx)?))
}
