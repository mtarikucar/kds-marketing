//! `/api/budget/items`: the budget items of the session's current workspace and their spend: the
//! tenant's own money and caps (spec §6.2 "Bütçe kalemi").
//!
//! Creating an item and recording a spend answer `201`. A spend's `source` is the caller, never
//! the body.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jt_app::usecases::budget::{
    self, BudgetItemInput, BudgetItemOut, BudgetSpendOut, DEFAULT_SPEND_PAGE,
};
use jt_capability::{BudgetItemId, BudgetSpend, BudgetSpendId};
use serde::Deserialize;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `POST /api/budget/items/{budget_item_id}/spend`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpendBody {
    /// In the item's unit (minor units of a currency); positive.
    pub amount: i64,
    /// An invoice number, a campaign id, …
    #[serde(default)]
    pub reference: Option<String>,
}

/// `GET /api/budget/items/{budget_item_id}/spend?limit=&before_at=&before_id=`; every parameter
/// is optional, but `before_at` and `before_id` (the previous page's last entry) come together.
#[derive(Debug, Default, Deserialize)]
pub struct SpendQuery {
    /// At most this many entries: default 50, at most 500 (a larger value is capped).
    pub limit: Option<u32>,
    /// The `at` of the previous page's last entry.
    pub before_at: Option<String>,
    /// The `id` of the previous page's last entry.
    pub before_id: Option<BudgetSpendId>,
}

/// `200` with every budget item, oldest first, with what was spent from it in its period.
pub async fn list_items(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<BudgetItemOut>>, ApiError> {
    Ok(Json(budget::list_items(&state.deps, &ctx).await?))
}

/// `201` with the new budget item, nothing spent. The body is the item as [`BudgetItemInput`]
/// reads it: `{name, kind, unit, cap, period}`.
pub async fn create_item(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<BudgetItemInput>,
) -> Result<(StatusCode, Json<BudgetItemOut>), ApiError> {
    let item = budget::create_item(&state.deps, &ctx, body).await?;
    Ok((StatusCode::CREATED, Json(item)))
}

/// `201` with the recorded spend and what remains of the item's cap in its period.
pub async fn record_spend(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(item): ApiPath<BudgetItemId>,
    ApiJson(body): ApiJson<SpendBody>,
) -> Result<(StatusCode, Json<BudgetSpendOut>), ApiError> {
    let spend = budget::record_spend(&state.deps, &ctx, item, body.amount, body.reference).await?;
    Ok((StatusCode::CREATED, Json(spend)))
}

/// `200` with one page of the item's spend, newest first.
pub async fn spend(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(item): ApiPath<BudgetItemId>,
    ApiQuery(query): ApiQuery<SpendQuery>,
) -> Result<Json<Vec<BudgetSpend>>, ApiError> {
    let before = budget::spend_cursor(query.before_at.as_deref(), query.before_id)?;
    let limit = query.limit.unwrap_or(DEFAULT_SPEND_PAGE);
    Ok(Json(
        budget::spend(&state.deps, &ctx, item, limit, before).await?,
    ))
}
