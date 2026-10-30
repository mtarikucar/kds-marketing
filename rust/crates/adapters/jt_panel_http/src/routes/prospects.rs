//! `/api/prospects`: the prospect pool for a person in the panel (spec
//! `2026-10-30-leads-pool-outreach-design.md` §7.1). Every route answers `200` with the JSON its
//! MCP tool answers. `check` and `do-not-contact/lift` are `POST` although they only read: their
//! bodies carry contact values, and contact values never go into a URL.

use axum::Json;
use axum::extract::State;
use jt_app::usecases::prospects::{
    self, CheckInput, CheckOut, DecideInput, DncInput, DncOut, EraseInput, EraseOut, GetOut,
    LiftInput, LiftOut, ListInput, ListOut, ProspectOut, ScoreOut, SettingsInput, SettingsOut,
};
use jt_prospects::{CreateInput, ProspectId, ScoreInput, UpdateInput};

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with `{ok}` or the refusal `create` would meet. The body is what is known of the business.
pub async fn check(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CheckInput>,
) -> Result<Json<CheckOut>, ApiError> {
    Ok(Json(prospects::check(&state.deps, &ctx, body).await?))
}

/// `200` with the recorded prospect; `409` for a duplicate or a cap, `403` for the blocklist.
pub async fn create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CreateInput>,
) -> Result<Json<ProspectOut>, ApiError> {
    Ok(Json(prospects::create(&state.deps, &ctx, body).await?))
}

/// `200` with the prospect after the edit; `409` for a stale revision.
pub async fn update(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ProspectId>,
    ApiJson(body): ApiJson<UpdateInput>,
) -> Result<Json<ProspectOut>, ApiError> {
    Ok(Json(prospects::update(&state.deps, &ctx, id, body).await?))
}

/// `200` with a page of the pool: `?status&research_task_id&city&segment_key&bucket&limit&before_at&before_id`.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<ListInput>,
) -> Result<Json<ListOut>, ApiError> {
    Ok(Json(prospects::list(&state.deps, &ctx, query).await?))
}

/// `200` with the prospect, its evidence, scores, duplicate candidates and history.
pub async fn get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ProspectId>,
) -> Result<Json<GetOut>, ApiError> {
    Ok(Json(prospects::get(&state.deps, &ctx, id).await?))
}

/// `200` with the score as stored and the status after it.
pub async fn score(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ProspectId>,
    ApiJson(body): ApiJson<ScoreInput>,
) -> Result<Json<ScoreOut>, ApiError> {
    Ok(Json(prospects::score(&state.deps, &ctx, id, body).await?))
}

/// `200` with the prospect after the decision.
pub async fn decide(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ProspectId>,
    ApiJson(body): ApiJson<DecideInput>,
) -> Result<Json<ProspectOut>, ApiError> {
    Ok(Json(prospects::decide(&state.deps, &ctx, id, body).await?))
}

/// `200` with the kinds of key now on the do-not-contact list.
pub async fn do_not_contact(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<DncInput>,
) -> Result<Json<DncOut>, ApiError> {
    Ok(Json(
        prospects::do_not_contact(&state.deps, &ctx, body).await?,
    ))
}

/// `200` with whether the entry was lifted.
pub async fn dnc_lift(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<LiftInput>,
) -> Result<Json<LiftOut>, ApiError> {
    Ok(Json(prospects::dnc_lift(&state.deps, &ctx, body).await?))
}

/// `200` once the prospect is erased.
pub async fn erase(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ProspectId>,
    ApiJson(body): ApiJson<EraseInput>,
) -> Result<Json<EraseOut>, ApiError> {
    Ok(Json(prospects::erase(&state.deps, &ctx, id, body).await?))
}

/// `200` with the pool's settings.
pub async fn settings_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<SettingsOut>, ApiError> {
    Ok(Json(prospects::settings_get(&state.deps, &ctx).await?))
}

/// `200` with the settings after the change.
pub async fn settings_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<SettingsInput>,
) -> Result<Json<SettingsOut>, ApiError> {
    Ok(Json(
        prospects::settings_set(&state.deps, &ctx, body).await?,
    ))
}
