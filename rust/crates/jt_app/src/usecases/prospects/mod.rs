//! The prospect pool (spec 2026-10-30-leads-pool-outreach-design.md §3, §7.1): businesses agents
//! research with their own tools and record with evidence, kept apart from the inbox until
//! promoted. Jeeta stores, checks, dedupes and fences what is recorded; it never researches.
//!
//! Rules every use case here keeps:
//! - The recorder of every value is the authenticated actor ([`recorder`]): an agent's
//!   connection and issuer, or a person. The system records nothing in the pool.
//! - Errors are `FORBIDDEN {reason}` for fences, `CONFLICT {reason, ...}` for duplicates, caps
//!   and stale writes, `VALIDATION {field, reason}` for input.
//! - Ledger payloads and `tracing` carry ids, counts, reasons and field names, never a value.
//! - Lock order: the inbox lock (`people().lock_workspace()`) before the pool lock
//!   (`prospects().lock_pool()`) before rows.

mod dedupe;
pub mod pool;

pub use pool::{
    CheckInput, CheckOut, DuplicateCandidate, GetOut, ListInput, ListOut, NextPage, ProspectOut,
    check, create, get, list, update,
};

use hmac::{Hmac, KeyInit, Mac};
use jt_ledger::Actor;
use jt_prospects::{Key, ProspectError, ProspectId, Recorder};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{LeadsPolicy, TenantRepos};
use crate::usecases::Deps;

/// The `SecretBox::hmac_key` purpose of the blocklist's keyed hashes.
pub const BLOCKLIST_PURPOSE: &str = "prospects.blocklist";

/// The recorder of a pool write: the agent's connection and the user who issued it, or the
/// person. A system actor records nothing in the pool (`FORBIDDEN {reason: system_actor}`).
pub(crate) fn recorder(ctx: &Ctx) -> Result<Recorder, AppError> {
    match &ctx.actor {
        Actor::Agent {
            connection_id,
            user_id,
        } => Ok(Recorder::Agent {
            connection_id: *connection_id,
            user_id: *user_id,
        }),
        Actor::Human { user_id } => Ok(Recorder::Human { user_id: *user_id }),
        Actor::System { .. } => Err(refused(
            ErrorCode::Forbidden,
            "system_actor",
            "the system records nothing in the prospect pool",
            json!({}),
        )),
    }
}

/// A refusal with `details.reason = reason` and the `extra` details beside it.
pub(crate) fn refused(code: ErrorCode, reason: &str, message: &str, extra: Value) -> AppError {
    let mut details = json!({ "reason": reason });
    if let (Some(d), Value::Object(extra)) = (details.as_object_mut(), extra) {
        d.extend(extra);
    }
    AppError {
        code,
        message: message.to_owned(),
        details,
    }
}

/// `VALIDATION {field, reason}` for a pool rule's refusal; the value is never named.
pub(crate) fn invalid_from(e: ProspectError) -> AppError {
    let ProspectError::Invalid { field, reason } = e;
    AppError::validation(
        format!("{field}: {reason}"),
        json!({ "field": field, "reason": reason }),
    )
}

/// `NOT_FOUND` for a prospect that is not in the workspace.
pub(crate) fn no_such_prospect() -> AppError {
    AppError::not_found("no such prospect")
}

/// The workspace's leads policy (its defaults while none is stored).
pub(crate) async fn leads_policy(r: &mut dyn TenantRepos) -> Result<LeadsPolicy, AppError> {
    Ok(r.workspace_policy().get().await?.leads)
}

/// Writes the pool's ledger entry `action` about prospect `id`, under the strategy version in
/// force.
pub(crate) async fn record(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    id: ProspectId,
    payload: Value,
) -> Result<(), AppError> {
    let version = super::capabilities::version_in_force(r).await?;
    super::capabilities::append(r, ctx, action, "prospect", id, version, payload).await
}

/// The blocklist hash of `key` in workspace `ctx.workspace_id`: lowercase hex HMAC-SHA256 under
/// the workspace's [`BLOCKLIST_PURPOSE`] key, over `jt_prospects::blocklist_material`.
pub(crate) fn blocklist_hash(deps: &Deps, ctx: &Ctx, key: &Key) -> Result<String, AppError> {
    let secret = deps.seal.hmac_key(ctx.workspace_id, BLOCKLIST_PURPOSE)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_ref())
        .map_err(|_| AppError::internal("blocklist key unavailable"))?;
    mac.update(&jt_prospects::blocklist_material(key.kind, &key.value));
    let mut out = String::with_capacity(64);
    for byte in mac.finalize().into_bytes() {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
}
