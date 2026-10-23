//! Commission snapshots are part of the Won transaction; payment is an explicit decision.
use super::record;
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{TenantRepos, compliance::CommissionRow},
    usecases::{Deps, invalid},
};
use jt_inbox::*;
use jt_tenancy::{MembershipStatus, Permission, UserId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

/// Called with the workspace and journey locked, before committing Won.
pub(crate) async fn snapshot(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: &Journey,
    amount_minor: i64,
    currency: &str,
) -> Result<CommissionRow, AppError> {
    let payee = if let Some(owner) = journey.owner {
        r.memberships()
            .find_by_user(owner)
            .await?
            .filter(|m| m.status == MembershipStatus::Active)
            .map(|_| owner)
    } else {
        None
    };
    let override_rate = match payee {
        Some(user) => r.commissions().user_rate(user).await?,
        None => None,
    };
    let rate_bp = match override_rate {
        Some(rate) => rate,
        None => r.commissions().default_rate().await?.unwrap_or(0),
    };
    // The domain helper deliberately panics on overflow; reject unrepresentable input first.
    let product = i128::from(amount_minor) * i128::from(rate_bp);
    let quotient = product / 10_000;
    let remainder = product % 10_000;
    let rounded =
        quotient + i128::from(remainder > 5_000 || (remainder == 5_000 && quotient % 2 != 0));
    if amount_minor < 0 || i64::try_from(rounded).is_err() {
        return Err(invalid(
            "amount_minor",
            "commission amount exceeds supported range",
        ));
    }
    let row = CommissionRow {
        id: deps.ids.uuid(),
        workspace_id: ctx.workspace_id,
        created_at: ctx.now,
        commission: Commission {
            journey_id: journey.id,
            payee,
            amount_minor: commission_for(amount_minor, rate_bp),
            currency: currency.into(),
            rate_bp,
            state: if payee.is_some() {
                CommissionState::Pending
            } else {
                CommissionState::NoPayee
            },
        },
    };
    r.commissions().insert(row.clone()).await?;
    record(r, ctx, "inbox.commission.created", "commission", row.id,
        json!({"person_id":journey.person_id,"journey_id":journey.id,"payee":payee,"amount_minor":row.commission.amount_minor,"currency":currency,"rate_bp":rate_bp,"state":row.commission.state})).await?;
    Ok(row)
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListInput {
    pub state: Option<CommissionState>,
    pub payee: Option<UserId>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RateInput {
    pub user_id: Option<UserId>,
    pub rate_bp: u16,
}
pub async fn list(
    deps: &Deps,
    ctx: &Ctx,
    input: ListInput,
) -> Result<Vec<CommissionRow>, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    Ok(r.commissions()
        .list()
        .await?
        .into_iter()
        .filter(|row| {
            input.state.is_none_or(|s| row.commission.state == s)
                && input.payee.is_none_or(|p| row.commission.payee == Some(p))
        })
        .collect())
}
pub async fn set_rate(deps: &Deps, ctx: &Ctx, input: RateInput) -> Result<RateInput, AppError> {
    ctx.require(Permission::InboxManage)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    if let Some(user) = input.user_id {
        if r.memberships()
            .find_by_user(user)
            .await?
            .filter(|m| m.status == MembershipStatus::Active)
            .is_none()
        {
            return Err(AppError::not_found(
                "rate requires an active workspace member",
            ));
        }
        r.commissions()
            .set_user_rate(user, Some(input.rate_bp))
            .await?;
    } else {
        r.commissions().set_default_rate(input.rate_bp).await?;
    }
    record(
        r.as_mut(),
        ctx,
        "inbox.commission_rates.set",
        "workspace",
        ctx.workspace_id,
        json!({"user_id":input.user_id,"rate_bp":input.rate_bp}),
    )
    .await?;
    r.commit().await?;
    Ok(input)
}
pub async fn approve(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<CommissionRow, AppError> {
    change(
        deps,
        ctx,
        id,
        CommissionState::Pending,
        CommissionState::Approved,
    )
    .await
}
pub async fn pay(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<CommissionRow, AppError> {
    change(
        deps,
        ctx,
        id,
        CommissionState::Approved,
        CommissionState::Paid,
    )
    .await
}
async fn change(
    deps: &Deps,
    ctx: &Ctx,
    id: Uuid,
    from: CommissionState,
    to: CommissionState,
) -> Result<CommissionRow, AppError> {
    ctx.require(Permission::InboxManage)?;
    if !ctx.is_owner_or_manager() {
        return Err(AppError {
            code: ErrorCode::Forbidden,
            message: "commission approval and payment require owner or manager authority".into(),
            details: json!({"reason":"owner_or_manager_required"}),
        });
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    // Serializes transitions with other decisions and Won/rate changes in this workspace.
    r.people().lock_workspace().await?;
    let mut row = r
        .commissions()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such commission"))?;
    if row.commission.payee.is_none() || row.commission.state != from {
        return Err(AppError::conflict(
            "commission is not in the required payable state",
        ));
    }
    r.commissions().set_state(id, to).await?;
    row.commission.state = to;
    record(r.as_mut(), ctx, if to == CommissionState::Approved { "inbox.commission.approved" } else { "inbox.commission.paid" }, "commission", id,
        json!({"journey_id":row.commission.journey_id,"payee":row.commission.payee,"amount_minor":row.commission.amount_minor,"currency":row.commission.currency,"from":from,"to":to})).await?;
    r.commit().await?;
    Ok(row)
}
