//! `/api/events`: what the connections of the session's current workspace brought in (webhooks,
//! polls), to read and acknowledge: `GET /api/events/pending` (unprocessed, oldest first),
//! `GET /api/events` (every event, newest first) and `POST /api/events/ack`.
//!
//! Every route answers `200` with the JSON its MCP tool answers: a page `{events, next}`, whose
//! `next` is the cursor of the following page (`{after_at, after_id}` for pending events,
//! `{before_at, before_id}` for the listing) or `null` on the last page, and `{acked}` for an
//! acknowledgement. Queries and bodies are read strictly, by the use case's own types: an unknown
//! parameter or field is `422 VALIDATION`. No answer carries an event's raw body.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::events::{
    self, Ack, AckOut, AfterCursor, BeforeCursor, EventPage, List, Pending,
};

use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with one page of unprocessed events, oldest first:
/// `?limit=&after_at=&after_id=` ([`Pending`]; `limit` 50 by default, at most 200).
pub async fn pending(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<Pending>,
) -> Result<Json<EventPage<AfterCursor>>, ApiError> {
    Ok(Json(events::pending(&state.deps, &ctx, query).await?))
}

/// `200` with one page of events, newest first, processed ones included unless
/// `include_processed=false`: `?limit=&before_at=&before_id=&include_processed=&kind=&provider=`
/// ([`List`]).
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<List>,
) -> Result<Json<EventPage<BeforeCursor>>, ApiError> {
    Ok(Json(events::list(&state.deps, &ctx, query).await?))
}

/// `200` with how many of the events `{ids}` ([`Ack`], 1 to 200 ids) were newly marked
/// processed.
pub async fn ack(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<Ack>,
) -> Result<Json<AckOut>, ApiError> {
    Ok(Json(events::ack(&state.deps, &ctx, body).await?))
}
