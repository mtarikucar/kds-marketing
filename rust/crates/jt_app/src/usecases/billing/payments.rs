//! Tenant payment evidence. Neither reporting nor reading grants access.
use super::schema::*;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::TenantRepos,
    usecases::{Deps, acting_user, invalid, ledger_entry},
};
use jt_tenancy::{MembershipStatus, Permission, UserId, WorkspaceStatus};
use serde_json::json;

async fn member(repos: &mut dyn TenantRepos, ctx: &Ctx, owner: bool) -> Result<UserId, AppError> {
    ctx.require(if owner {
        Permission::TeamManage
    } else {
        Permission::WorkspaceRead
    })?;
    let user =
        acting_user(&ctx.actor).ok_or_else(|| AppError::forbidden("active membership required"))?;
    let membership = repos
        .memberships()
        .find_by_user(user)
        .await?
        .filter(|m| m.status == MembershipStatus::Active)
        .ok_or_else(|| AppError::forbidden("active membership required"))?;
    if owner {
        let role = repos
            .roles()
            .find(membership.role_id)
            .await?
            .ok_or_else(|| AppError::forbidden("current owner role required"))?;
        if role.key != "owner" {
            return Err(AppError::forbidden("current owner role required"));
        }
    }
    Ok(user)
}

pub(super) async fn payment_out(
    repos: &mut dyn TenantRepos,
    row: PaymentNotification,
) -> Result<PaymentOut, AppError> {
    let confirmed = repos.billing().payment_confirmed(row.id).await?;
    Ok(PaymentOut {
        id: row.id,
        reported_at: row.reported_at,
        amount_minor: row.amount_minor,
        currency: row.currency,
        paid_at: row.paid_at,
        confirmed,
    })
}

/// Read-only instructions and history; initializes the stable reference under the workspace lock.
pub async fn status(deps: &Deps, ctx: &Ctx) -> Result<BillingStatusOut, AppError> {
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let workspace = repos.workspace().lock().await?;
    member(&mut *repos, ctx, false).await?;
    let payment_reference = repos.billing().reference_get_or_create().await?;
    let entitlement = repos
        .billing()
        .latest_entitlement()
        .await?
        .map(EntitlementOut::from);
    let payment = match repos.billing().latest_payment().await? {
        Some(row) => Some(payment_out(&mut *repos, row).await?),
        None => None,
    };
    repos.commit().await?;
    Ok(BillingStatusOut {
        workspace_status: workspace.status,
        entitlement,
        payment,
        price_minor: deps.billing.price_minor,
        price_currency: deps.billing.price_currency.clone(),
        bank_instructions: deps.billing.bank_instructions.clone(),
        payment_reference,
    })
}

/// Record sealed evidence and its ID-only audit event atomically. Retries never rewrite evidence.
pub async fn report_payment(
    deps: &Deps,
    ctx: &Ctx,
    input: ReportPaymentInput,
) -> Result<PaymentOut, AppError> {
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let workspace = repos.workspace().lock().await?;
    if workspace.status == WorkspaceStatus::Suspended {
        return Err(AppError::workspace_inactive(workspace.status));
    }
    let reported_by = member(&mut *repos, ctx, true).await?;
    let reference: String = input
        .reference
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if let Some(row) = repos.billing().find_request(&input.request_key).await? {
        let stored = deps.seal.open(ctx.workspace_id, &row.reference_sealed)?;
        if stored.as_slice() != reference.as_bytes()
            || row.amount_minor != input.amount_minor
            || row.paid_at != input.paid_at
        {
            return Err(AppError::conflict(
                "request key already used with different payment evidence",
            ));
        }
        return payment_out(&mut *repos, row).await;
    }
    if input.request_key.trim().is_empty() || input.request_key.len() > 128 {
        return Err(invalid(
            "request_key",
            "request key must contain 1 to 128 bytes",
        ));
    }
    if input.amount_minor <= 0 {
        return Err(invalid("amount_minor", "amount must be positive"));
    }
    if !input.paid_at.nanosecond().is_multiple_of(1_000) {
        return Err(invalid(
            "paid_at",
            "payment time must have at most microsecond precision",
        ));
    }
    if input.paid_at > ctx.now {
        return Err(invalid("paid_at", "payment time cannot be in the future"));
    }
    if reference != repos.billing().reference_get_or_create().await? {
        return Err(invalid("reference", "reference must match this workspace"));
    }
    let row = PaymentNotification {
        id: PaymentId(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        reported_by,
        reference_sealed: deps.seal.seal(ctx.workspace_id, reference.as_bytes())?,
        request_key: input.request_key,
        amount_minor: input.amount_minor,
        currency: deps.billing.price_currency.clone(),
        paid_at: input.paid_at.to_offset(time::UtcOffset::UTC),
        reported_at: ctx.now,
    };
    repos.billing().insert_payment(row.clone()).await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "billing.payment_reported",
            "payment",
            row.id,
            json!({"payment_id":row.id}),
        )?)
        .await?;
    let out = payment_out(&mut *repos, row).await?;
    repos.commit().await?;
    Ok(out)
}
