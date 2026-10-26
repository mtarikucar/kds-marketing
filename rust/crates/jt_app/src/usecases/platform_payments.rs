//! Operator-only settlement and explicit revocation. All writes serialize on the workspace.
use crate::{
    ctx::PlatformCtx,
    error::AppError,
    ports::{PlatformRepos, billing::*},
    usecases::{
        Deps, action,
        billing::{
            EntitlementOut,
            codes::{self, ActivationCodeDeliveryOut},
        },
        platform::{self, WorkspaceAdminOut},
    },
};
use jt_ledger::{LedgerEntry, Subject};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde::Serialize;
use serde_json::json;
use time::OffsetDateTime;

/// Operator evidence projection. No Debug: the reference must not enter operational logs.
#[derive(Serialize)]
pub struct PlatformPaymentOut {
    pub workspace_id: WorkspaceId,
    pub payment_id: PaymentId,
    #[serde(with = "time::serde::rfc3339")]
    pub reported_at: OffsetDateTime,
    pub amount_minor: i64,
    pub currency: String,
    #[serde(with = "time::serde::rfc3339")]
    pub paid_at: OffsetDateTime,
    pub reference: String,
    pub entitlement: Option<EntitlementOut>,
}

/// Retries return the current state without recovering a plaintext code.
#[derive(Serialize)]
pub struct ConfirmationOut {
    pub workspace: WorkspaceAdminOut,
    pub entitlement: EntitlementOut,
    pub activation: Option<ActivationCodeDeliveryOut>,
}

/// Evidence for manual comparison with bank records; nothing is automatically settled based
/// on an amount or reference supplied by a tenant.
pub async fn list(deps: &Deps, _pctx: &PlatformCtx) -> Result<Vec<PlatformPaymentOut>, AppError> {
    let mut repos = deps.uow.platform().await?;
    let rows = repos.payments_list().await?;
    // Two bulk reads for the entire list, never a query per payment. Historical grants are
    // keyed by both workspace and payment, so another payment's open grant cannot mask them.
    let mut entitlements: std::collections::BTreeMap<_, _> = repos
        .payment_entitlements_latest()
        .await?
        .into_iter()
        .filter_map(|e| e.payment_id.map(|payment| ((e.workspace_id, payment), e)))
        .collect();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let reference = deps.seal.open(row.workspace_id, &row.reference_sealed)?;
        let reference = std::str::from_utf8(&reference)
            .map_err(|_| AppError::internal("payment reference unavailable"))?
            .to_owned();
        let entitlement = entitlements
            .remove(&(row.workspace_id, row.id))
            .map(Into::into);
        out.push(PlatformPaymentOut {
            workspace_id: row.workspace_id,
            payment_id: row.id,
            reported_at: row.reported_at,
            amount_minor: row.amount_minor,
            currency: row.currency,
            paid_at: row.paid_at,
            reference,
            entitlement,
        });
    }
    Ok(out)
}

/// The authenticated operator attests they checked reference, amount, currency and paid_at
/// against the bank transfer. Creates an unactivated permanent grant and one-time code.
pub async fn confirm(
    deps: &Deps,
    pctx: &PlatformCtx,
    ws: WorkspaceId,
    id: PaymentId,
) -> Result<ConfirmationOut, AppError> {
    let mut repos = deps.uow.platform().await?;
    let workspace = repos.workspace_lock(ws).await?;
    repos
        .payment_get(ws, id)
        .await?
        .ok_or_else(|| AppError::not_found("payment"))?;
    if let Some(grant) = repos.entitlement_get(ws).await? {
        if grant.source != EntitlementSource::Paid || grant.payment_id != Some(id) {
            return Err(AppError::conflict(
                "workspace already has a different open entitlement",
            ));
        }
        return Ok(ConfirmationOut {
            workspace: platform::admin_view(&mut *repos, workspace).await?,
            entitlement: grant.into(),
            activation: None,
        });
    }
    pending(workspace.status)?;
    let grant = WorkspaceEntitlement {
        id: EntitlementId(deps.ids.uuid()),
        workspace_id: ws,
        source: EntitlementSource::Paid,
        payment_id: Some(id),
        confirmed_by: Some(pctx.operator_id),
        confirmed_at: pctx.now,
        activated_at: None,
        redeemed_by: None,
        revoked_at: None,
        reason: None,
    };
    repos.entitlement_insert(grant.clone()).await?;
    let delivery = codes::issue(deps, pctx, &mut *repos, ws, grant.id).await?;
    audit(
        &mut *repos,
        pctx,
        ws,
        "billing.confirmed",
        json!({"payment_id":id,"entitlement_id":grant.id,"activation_code_id":delivery.id}),
    )
    .await?;
    let out = ConfirmationOut {
        workspace: platform::admin_view(&mut *repos, workspace).await?,
        entitlement: grant.into(),
        activation: Some(delivery),
    };
    repos.commit().await?;
    Ok(out)
}

/// Replace a lost/expired/locked challenge without changing the entitlement.
pub async fn reissue(
    deps: &Deps,
    pctx: &PlatformCtx,
    ws: WorkspaceId,
    id: PaymentId,
) -> Result<ConfirmationOut, AppError> {
    let mut repos = deps.uow.platform().await?;
    let workspace = repos.workspace_lock(ws).await?;
    repos
        .payment_get(ws, id)
        .await?
        .ok_or_else(|| AppError::not_found("payment"))?;
    pending(workspace.status)?;
    let grant = repos
        .entitlement_get(ws)
        .await?
        .filter(|e| {
            e.source == EntitlementSource::Paid
                && e.payment_id == Some(id)
                && e.activated_at.is_none()
        })
        .ok_or_else(|| AppError::conflict("matching unactivated paid entitlement required"))?;
    let delivery = codes::issue(deps, pctx, &mut *repos, ws, grant.id).await?;
    audit(
        &mut *repos,
        pctx,
        ws,
        "billing.code_reissued",
        json!({"payment_id":id,"entitlement_id":grant.id,"activation_code_id":delivery.id}),
    )
    .await?;
    let out = ConfirmationOut {
        workspace: platform::admin_view(&mut *repos, workspace).await?,
        entitlement: grant.into(),
        activation: Some(delivery),
    };
    repos.commit().await?;
    Ok(out)
}

/// Close an entitlement, invalidate its challenge and return to pending payment atomically.
pub async fn revoke_activation(
    deps: &Deps,
    pctx: &PlatformCtx,
    ws: WorkspaceId,
    reason: &str,
) -> Result<WorkspaceAdminOut, AppError> {
    let reason = platform::reason(reason)?;
    let mut repos = deps.uow.platform().await?;
    let mut workspace = repos.workspace_lock(ws).await?;
    let grant = repos.entitlement_get(ws).await?;
    if grant.is_none() && workspace.status == WorkspaceStatus::PendingPayment {
        return platform::admin_view(&mut *repos, workspace).await;
    }
    if let Some(grant) = &grant {
        repos
            .entitlement_revoke(ws, grant.id, pctx.now, reason)
            .await?;
    }
    repos
        .activation_code_invalidate_current(ws, pctx.now)
        .await?;
    repos
        .workspace_set_status(
            ws,
            WorkspaceStatus::PendingPayment,
            reason,
            &platform::actor(pctx),
        )
        .await?;
    audit(
        &mut *repos,
        pctx,
        ws,
        "billing.activation_revoked",
        json!({"entitlement_id":grant.map(|g|g.id),"reason":reason}),
    )
    .await?;
    workspace.status = WorkspaceStatus::PendingPayment;
    let out = platform::admin_view(&mut *repos, workspace).await?;
    repos.commit().await?;
    Ok(out)
}

fn pending(status: WorkspaceStatus) -> Result<(), AppError> {
    if status != WorkspaceStatus::PendingPayment {
        return Err(AppError::conflict("workspace must be pending payment"));
    }
    Ok(())
}
async fn audit(
    repos: &mut dyn PlatformRepos,
    pctx: &PlatformCtx,
    ws: WorkspaceId,
    name: &str,
    payload: serde_json::Value,
) -> Result<(), AppError> {
    let mut entry = LedgerEntry::new(ws, platform::actor(pctx), action(name)?, payload, pctx.now);
    entry.subject = Some(Subject {
        kind: "workspace".into(),
        id: ws.to_string(),
    });
    repos.ledger_append(entry).await?;
    Ok(())
}
