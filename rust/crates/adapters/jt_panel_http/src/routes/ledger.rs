//! `/api/ledger`: the ledger of the session's current workspace, newest first.

use axum::Json;
use axum::extract::State;
use jt_app::ports::LedgerFilter;
use jt_app::usecases::ledger::{self, DEFAULT_LIMIT, LedgerEntryOut};
use serde::Deserialize;

use crate::error::{ApiError, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `GET /api/ledger?action_prefix=&actor_kind=&limit=&before_id=`; every parameter is optional.
#[derive(Debug, Default, Deserialize)]
pub struct LedgerQuery {
    /// Keep only actions starting with this text, e.g. `team.`.
    pub action_prefix: Option<String>,
    /// Keep only entries by this kind of actor: `human`, `agent` or `system`.
    pub actor_kind: Option<String>,
    /// At most this many entries: default 50, at most 500 (a larger value is capped).
    pub limit: Option<u32>,
    /// Only entries older than this one: the last id of the previous page.
    pub before_id: Option<i64>,
}

/// `200` with the matching entries (`[{ id, entry }]`), secret payload values masked.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<LedgerQuery>,
) -> Result<Json<Vec<LedgerEntryOut>>, ApiError> {
    let filter = LedgerFilter {
        action_prefix: query.action_prefix,
        actor_kind: query.actor_kind,
        limit: query.limit.unwrap_or(DEFAULT_LIMIT),
        before_id: query.before_id,
    };
    Ok(Json(ledger::list(&state.deps, &ctx, filter).await?))
}
