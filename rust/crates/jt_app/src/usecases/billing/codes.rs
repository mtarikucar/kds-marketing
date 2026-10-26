//! Operator-issued activation challenges. Plaintext exists only in the one-time delivery.
use crate::{
    ctx::PlatformCtx,
    error::AppError,
    ports::{PlatformRepos, billing::*},
    usecases::Deps,
};
use hmac::{Hmac, KeyInit, Mac};
use jt_tenancy::WorkspaceId;
use serde::Serialize;
use sha2::Sha256;
use time::{Duration, OffsetDateTime};

/// Deliberately not Debug: delivered once to the operator for out-of-band handoff.
#[derive(Serialize)]
pub struct ActivationCodeDeliveryOut {
    pub id: ActivationCodeId,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    pub code: String,
}

/// Workspace key plus explicit workspace/grant/action binding. Redemption verifies the same
/// MAC in constant time.
pub fn activation_digest(
    deps: &Deps,
    ws: WorkspaceId,
    grant: EntitlementId,
    code: &str,
) -> Result<Vec<u8>, AppError> {
    Ok(activation_mac(deps, ws, grant, code)?
        .finalize()
        .into_bytes()
        .to_vec())
}

fn activation_mac(
    deps: &Deps,
    ws: WorkspaceId,
    grant: EntitlementId,
    code: &str,
) -> Result<Hmac<Sha256>, AppError> {
    let key = deps.seal.hmac_key(ws, "billing.activate")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_ref())
        .map_err(|_| AppError::internal("activation key unavailable"))?;
    mac.update(ws.as_uuid().as_bytes());
    mac.update(grant.as_uuid().as_bytes());
    mac.update(b"billing.activate\0");
    mac.update(code.as_bytes());
    Ok(mac)
}

fn generate(deps: &Deps) -> String {
    let mut code = String::with_capacity(8);
    // 24 bytes produce 32 full, uniformly distributed base64url symbols (no partial last
    // symbol). Reject everything except the 36-symbol alphabet, without case-folding bias.
    while code.len() < 8 {
        for b in deps
            .tokens
            .token(24)
            .bytes()
            .filter(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            code.push(char::from(b));
            if code.len() == 8 {
                break;
            }
        }
    }
    code
}

pub(crate) async fn issue(
    deps: &Deps,
    pctx: &PlatformCtx,
    repos: &mut dyn PlatformRepos,
    ws: WorkspaceId,
    grant: EntitlementId,
) -> Result<ActivationCodeDeliveryOut, AppError> {
    let (code, digest) = loop {
        let code = generate(deps);
        let digest = activation_digest(deps, ws, grant, &code)?;
        if !repos.activation_code_digest_exists(ws, &digest).await? {
            break (code, digest);
        }
    };
    repos
        .activation_code_invalidate_current(ws, pctx.now)
        .await?;
    let id = ActivationCodeId(deps.ids.uuid());
    let expires_at = pctx.now + Duration::hours(72);
    repos
        .activation_code_insert(
            ws,
            ActivationCodeRow {
                id,
                workspace_id: ws,
                entitlement_id: grant,
                action: "billing.activate".into(),
                digest,
                issued_by: pctx.operator_id,
                created_at: pctx.now,
                expires_at,
                attempts: 0,
                invalidated_at: None,
                consumed_at: None,
                redeemed_by: None,
            },
        )
        .await?;
    Ok(ActivationCodeDeliveryOut {
        id,
        expires_at,
        code,
    })
}

/// Redeem the workspace's current challenge from a human owner session.
pub async fn activate(
    deps: &Deps,
    ctx: &crate::ctx::Ctx,
    input: super::ActivateInput,
) -> Result<super::BillingStatusOut, AppError> {
    use crate::usecases::{invalid, ledger_entry};
    use jt_ledger::Actor;
    use jt_tenancy::{MembershipStatus, Permission, WorkspaceStatus};
    use serde_json::json;

    let Actor::Human { user_id } = ctx.actor else {
        return Err(AppError::forbidden("human session required"));
    };
    if ctx.agent_connection_id.is_some() {
        return Err(AppError::forbidden("human session required"));
    }
    ctx.require(Permission::TeamManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let workspace = repos.workspace().lock().await?;
    let membership = repos
        .memberships()
        .lock_by_user(user_id)
        .await?
        .filter(|m| m.status == MembershipStatus::Active)
        .ok_or_else(|| AppError::forbidden("active owner membership required"))?;
    repos
        .roles()
        .find(membership.role_id)
        .await?
        .filter(|r| r.key == "owner" && r.permissions.contains(&Permission::TeamManage))
        .ok_or_else(|| AppError::forbidden("current owner role required"))?;
    let refused = || invalid("code", "activation code is invalid or unavailable");
    // Expiry is judged at the moment the locks are held, not when the request started: a slow
    // request body or a lock wait must not stretch a challenge past its 72 hours.
    let now = deps.clock.now();
    if workspace.status != WorkspaceStatus::PendingPayment {
        return Err(refused());
    }
    let challenge = repos
        .activation_codes()
        .lock_current_by_workspace()
        .await?
        .filter(|c| {
            c.workspace_id == ctx.workspace_id
                && c.invalidated_at.is_none()
                && c.consumed_at.is_none()
                && c.expires_at > now
                && c.attempts < 5
        })
        .ok_or_else(refused)?;
    let grant = repos
        .billing()
        .entitlement()
        .await?
        .filter(|g| {
            g.id == challenge.entitlement_id
                && g.workspace_id == ctx.workspace_id
                && g.source == EntitlementSource::Paid
                && g.payment_id.is_some()
                && g.revoked_at.is_none()
                && g.activated_at.is_none()
        })
        .ok_or_else(refused)?;
    let valid = activation_mac(deps, ctx.workspace_id, grant.id, &input.code)?
        .verify_slice(&challenge.digest)
        .is_ok();
    if challenge.action != "billing.activate"
        || input.code.len() != 8
        || !input
            .code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        || !valid
    {
        repos
            .activation_codes()
            .record_failed_attempt(challenge.id)
            .await?;
        repos.commit().await?;
        return Err(refused());
    }
    repos
        .activation_codes()
        .consume(challenge.id, now, user_id)
        .await?;
    repos
        .billing()
        .activate_entitlement(grant.id, now, user_id)
        .await?;
    repos
        .workspace()
        .set_status(
            ctx.workspace_id,
            WorkspaceStatus::Active,
            "billing.activate",
            &ctx.actor,
        )
        .await?;
    let mut entry = ledger_entry(
        ctx,
        "billing.activated",
        "entitlement",
        grant.id,
        json!({"entitlement_id": grant.id, "payment_id": grant.payment_id,
        "activation_code_id": challenge.id, "redeemed_by": user_id}),
    )?;
    entry.at = now;
    repos.ledger().append(entry).await?;
    let payment_reference = repos.billing().reference_get_or_create().await?;
    let entitlement = repos
        .billing()
        .latest_entitlement()
        .await?
        .map(super::EntitlementOut::from);
    let payment = match repos.billing().latest_payment().await? {
        Some(row) => Some(super::payments::payment_out(&mut *repos, row).await?),
        None => None,
    };
    let out = super::BillingStatusOut {
        workspace_status: WorkspaceStatus::Active,
        entitlement,
        payment,
        payment_reference,
        price_minor: deps.billing.price_minor,
        price_currency: deps.billing.price_currency.clone(),
        bank_instructions: deps.billing.bank_instructions.clone(),
    };
    repos.commit().await?;
    Ok(out)
}
