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

/// Workspace key plus explicit workspace/grant/action binding. Task 4 uses the same digest
/// when checking a challenge, with a constant-time comparison.
pub fn activation_digest(
    deps: &Deps,
    ws: WorkspaceId,
    grant: EntitlementId,
    code: &str,
) -> Result<Vec<u8>, AppError> {
    let key = deps.seal.hmac_key(ws, "billing.activate")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_ref())
        .map_err(|_| AppError::internal("activation key unavailable"))?;
    mac.update(ws.as_uuid().as_bytes());
    mac.update(grant.as_uuid().as_bytes());
    mac.update(b"billing.activate\0");
    mac.update(code.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
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
    let previous = repos.activation_code_lock_current_by_workspace(ws).await?;
    let (code, digest) = loop {
        let code = generate(deps);
        let digest = activation_digest(deps, ws, grant, &code)?;
        if previous.as_ref().is_none_or(|old| old.digest != digest) {
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
