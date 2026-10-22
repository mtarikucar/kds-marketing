//! The workspace's budget items and their spend (spec §6.2 "Bütçe kalemi"): `budget.items.list`,
//! `budget.items.create`, `budget.spend.record` and `budget.spend.list`. The tenant's own money
//! and caps, never the system's credit (K4).
//!
//! Creating an item needs `budget.manage`; everything else `workspace.read`, so an agent (or a
//! person) can report what it spent. Spend is append-only. Recording over the cap is allowed: the
//! spend is recorded, what remains goes negative, and a `budget.over_cap` entry flags it (the hard
//! cap applies to the spend connectors report, in M3). An item's spend in its period is counted
//! over the UTC window of `period_window` that holds the time of the call.
//!
//! Each change writes ledger entries about the item (`subject.kind = "budget_item"`) or the spend
//! (`"budget_spend"`) under the strategy version in force, if any.

use jt_capability::{
    BudgetItem, BudgetItemId, BudgetKind, BudgetSpend, BudgetSpendId, NewBudgetItem,
    NewBudgetSpend, Period, SpendSource, Unit, period_window, remaining, unit_fits,
};
use jt_ledger::Actor;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

use super::capabilities::{append, capability_error, version_in_force};
use super::{Deps, keyset_cursor};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;

const NO_SUCH_BUDGET_ITEM: &str = "no such budget item";

/// How many spend entries a page holds when the caller names no limit.
pub const DEFAULT_SPEND_PAGE: u32 = 50;

/// What a budget item is created with. From JSON, an unknown field is refused.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetItemInput {
    pub name: String,
    pub kind: BudgetKind,
    /// `{"kind": "currency", "value": "TRY"}`, `{"kind": "count", "value": "spools"}` or
    /// `{"kind": "minutes"}`.
    pub unit: Unit,
    /// The most that may be spent per period, in `unit` (minor units of a currency); not
    /// negative.
    pub cap: i64,
    pub period: Period,
}

/// A budget item with what was spent from it in its current period and what remains (negative
/// when over the cap).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BudgetItemOut {
    pub item: BudgetItem,
    pub spent_in_period: i64,
    pub remaining: i64,
}

/// A spend just recorded, with what remains of its item's cap in the period (negative when over
/// the cap).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BudgetSpendOut {
    pub spend: BudgetSpend,
    pub remaining: i64,
}

/// Creates a budget item and returns it, nothing spent. Needs `budget.manage`.
///
/// The name is trimmed; a bad name, unit or a negative cap is `VALIDATION` naming `name`, `unit`
/// or `cap`. The unit must fit the kind (`unit_fits`: money in a currency, consumables and agent
/// quotas as a count, agent hours in minutes), else `VALIDATION` with
/// `details.reason = "unit_mismatch"`. The item carries the strategy version in force, if any.
/// Writes `budget.items.create` (payload `name`, `kind`, `unit`, `cap`, `period`).
pub async fn create_item(
    deps: &Deps,
    ctx: &Ctx,
    input: BudgetItemInput,
) -> Result<BudgetItemOut, AppError> {
    ctx.require(Permission::BudgetManage)?;
    let BudgetItemInput {
        name,
        kind,
        unit,
        cap,
        period,
    } = input;
    let mut item = BudgetItem::new(
        BudgetItemId(deps.ids.uuid()),
        ctx.workspace_id,
        NewBudgetItem {
            name,
            kind,
            unit,
            cap,
            period,
        },
        ctx.now,
    )
    .map_err(capability_error)?;
    if !unit_fits(item.kind, &item.unit) {
        return Err(AppError::validation(
            format!(
                "a {} budget item is not counted in {}",
                item.kind.key(),
                unit_kind(&item.unit)
            ),
            json!({ "reason": "unit_mismatch" }),
        ));
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    item.strategy_version_id = in_force.map(|v| v.as_uuid());
    repos.budget().insert_item(item.clone()).await?;
    append(
        repos.as_mut(),
        ctx,
        "budget.items.create",
        "budget_item",
        item.id,
        in_force,
        json!({
            "name": item.name,
            "kind": item.kind,
            "unit": item.unit,
            "cap": item.cap,
            "period": item.period,
        }),
    )
    .await?;
    repos.commit().await?;
    Ok(BudgetItemOut {
        spent_in_period: 0,
        remaining: item.cap,
        item,
    })
}

/// Every budget item, oldest first, with what was spent from it in its period at `ctx.now`.
/// Needs `workspace.read`.
pub async fn list_items(deps: &Deps, ctx: &Ctx) -> Result<Vec<BudgetItemOut>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let items = repos.budget().list_items().await?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let spent_in_period = spent_in_period(repos.as_mut(), &item, ctx.now).await?;
        out.push(BudgetItemOut {
            remaining: remaining(item.cap, spent_in_period),
            spent_in_period,
            item,
        });
    }
    Ok(out)
}

/// Records that `amount` (in the item's unit) was spent from budget item `item`, at `ctx.now`,
/// and returns the spend with what remains. Needs `workspace.read`.
///
/// The source is the caller: an agent, a person, or a system component (recorded as the
/// connector named by its component). The reference is trimmed; blank is none. An amount that is
/// not positive is `VALIDATION` naming `amount`, a reference over 256 characters naming
/// `reference`; an item that is not this workspace's is `NOT_FOUND`. Writes `budget.spend.record`
/// (payload `item_id`, `amount`, `source` and, when given, `reference`) and, when the spend takes
/// the item over its cap for the period, `budget.over_cap` about the item (payload `item_id`,
/// `remaining`).
pub async fn record_spend(
    deps: &Deps,
    ctx: &Ctx,
    item: BudgetItemId,
    amount: i64,
    reference: Option<String>,
) -> Result<BudgetSpendOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let source = match &ctx.actor {
        Actor::Agent { .. } => SpendSource::Agent,
        Actor::Human { .. } => SpendSource::Human,
        Actor::System { component } => SpendSource::Connector(component.clone()),
    };
    let reference = reference
        .map(|r| r.trim().to_owned())
        .filter(|r| !r.is_empty());
    let spend = BudgetSpend::new(
        BudgetSpendId(deps.ids.uuid()),
        ctx.workspace_id,
        item,
        NewBudgetSpend {
            amount,
            source,
            reference,
        },
        ctx.now,
    )
    .map_err(capability_error)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let budget_item = repos
        .budget()
        .find_item(item)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_BUDGET_ITEM))?;
    repos.budget().append_spend(spend.clone()).await?;
    let spent = spent_in_period(repos.as_mut(), &budget_item, ctx.now).await?;
    let remaining = remaining(budget_item.cap, spent);
    let in_force = version_in_force(repos.as_mut()).await?;
    let source_key = match &spend.source {
        SpendSource::Connector(_) => "connector",
        SpendSource::Agent => "agent",
        SpendSource::Human => "human",
    };
    let mut payload = json!({ "item_id": item, "amount": amount, "source": source_key });
    if let Some(reference) = &spend.reference {
        payload["reference"] = json!(reference);
    }
    append(
        repos.as_mut(),
        ctx,
        "budget.spend.record",
        "budget_spend",
        spend.id,
        in_force,
        payload,
    )
    .await?;
    if remaining < 0 {
        append(
            repos.as_mut(),
            ctx,
            "budget.over_cap",
            "budget_item",
            item,
            in_force,
            json!({ "item_id": item, "remaining": remaining }),
        )
        .await?;
    }
    repos.commit().await?;
    Ok(BudgetSpendOut { spend, remaining })
}

/// One page of budget item `item`'s spend, newest first: at most `limit` entries (clamped to
/// `1..=MAX_SPEND_PAGE`) ordered before `before`, the `(at, id)` of the previous page's last
/// entry. Needs `workspace.read`; an item that is not this workspace's is `NOT_FOUND`.
pub async fn spend(
    deps: &Deps,
    ctx: &Ctx,
    item: BudgetItemId,
    limit: u32,
    before: Option<(OffsetDateTime, BudgetSpendId)>,
) -> Result<Vec<BudgetSpend>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    if repos.budget().find_item(item).await?.is_none() {
        return Err(AppError::not_found(NO_SUCH_BUDGET_ITEM));
    }
    repos.budget().list_spend(item, limit, before).await
}

/// The `before` cursor of [`spend`] from the two halves a caller sends: `before_at`, an RFC 3339
/// time as a spend's `at` reads, and `before_id`, that spend's id. Both or neither, else
/// `VALIDATION` naming the missing one; a `before_at` that does not parse is `VALIDATION` naming
/// it. The panel and the MCP tool read their parameters through it alike.
pub fn spend_cursor(
    before_at: Option<&str>,
    before_id: Option<BudgetSpendId>,
) -> Result<Option<(OffsetDateTime, BudgetSpendId)>, AppError> {
    keyset_cursor(before_at, before_id)
}

/// What `unit` counts, in words, for a message.
fn unit_kind(unit: &Unit) -> &'static str {
    match unit {
        Unit::Currency(_) => "a currency",
        Unit::Count(_) => "a count",
        Unit::Minutes => "minutes",
    }
}

/// What was spent from `item` in the window of its period that holds `now`.
async fn spent_in_period(
    repos: &mut dyn TenantRepos,
    item: &BudgetItem,
    now: OffsetDateTime,
) -> Result<i64, AppError> {
    let (from, to) = period_window(item.period, now);
    repos.budget().spent_between(item.id, from, to).await
}
