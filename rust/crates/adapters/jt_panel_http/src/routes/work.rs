//! `/api/work`: what is pending for the session's current workspace (the home page's data: the
//! strategy's state, the items to act on and the agent check-in warning), and the check-in
//! interval. An agent's own check-in is MCP-only (`jeeta.work.checkin`): no route serves it.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::work::{self, AgentState, PendingOut};
use serde::Deserialize;

use crate::error::{ApiError, ApiJson};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `PUT /api/work/checkin-interval`: how often the agent is expected to check in, in minutes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckinIntervalBody {
    pub minutes: u32,
}

/// `200` with what is pending, as the signed-in user sees it.
pub async fn pending(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<PendingOut>, ApiError> {
    Ok(Json(work::pending(&state.deps, &ctx).await?))
}

/// `200` with the agent check-in state under the new interval.
pub async fn set_checkin_interval(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CheckinIntervalBody>,
) -> Result<Json<AgentState>, ApiError> {
    Ok(Json(
        work::set_checkin_interval(&state.deps, &ctx, body.minutes).await?,
    ))
}
