//! The prospect pool (spec 2026-10-30-leads-pool-outreach-design.md §3, §7.1): businesses agents
//! research with their own tools and record with evidence, kept apart from the inbox until
//! promoted. Jeeta stores, checks, dedupes and fences what is recorded; it never researches.
//!
//! Rules every use case here keeps:
//! - The recorder of every value is the authenticated actor (`recorder`): an agent's
//!   connection and issuer, or a person. The system records nothing in the pool.
//! - Errors are `FORBIDDEN {reason}` for fences, `CONFLICT {reason, ...}` for duplicates, caps
//!   and stale writes, `VALIDATION {field, reason}` for input.
//! - Ledger payloads and `tracing` carry ids, counts, reasons and field names, never a value.
//! - Lock order: the inbox lock (`people().lock_workspace()`) before the pool lock
//!   (`prospects().lock_pool()`) before rows. The leads policy is read without a lock
//!   (`workspace_policy().read()`); only `settings_set` takes the workspace-policy lock, and it
//!   takes no pool lock.
//! - Only hard keys (phone, email, Instagram, TikTok) are hashed onto the blocklist and only a
//!   hard key's hit refuses; a soft key (domain, name and city) is a non-blocking flag.
//! - A request key stores the ids it recorded (`{prospect_id}`), never the answer: a replay reads
//!   the row again, and an erasure, a do-not-contact mark or a purge forgets the requests that
//!   recorded the row.

pub(crate) mod blocklist;
pub(crate) mod dedupe;
pub mod playbook;
pub mod pool;
pub mod promote;
mod score;
mod settings;

pub use blocklist::{
    DncInput, DncOut, EraseInput, EraseOut, LiftInput, LiftOut, MAX_PURGE_BATCHES, PURGE_BATCH,
    Purged, RawKey, dnc_lift, do_not_contact, erase, purge,
};
pub use dedupe::Flag;
pub use playbook::{PlaybookOut, playbook};
pub use pool::{
    CheckInput, CheckOut, DuplicateCandidate, GetOut, ListInput, ListOut, NextPage, ProspectOut,
    check, create, get, list, update,
};
pub use promote::{
    MAX_PROMOTE_BATCH, PromoteInput, PromoteOut, PromoteOutcome, ProspectSummary, promote,
};
pub use score::{DecideInput, DecideKind, ScoreOut, decide, rubric_digest, score};
pub use settings::{SettingsInput, SettingsOut, settings_get, settings_set};

use hmac::{Hmac, KeyInit, Mac};
use jt_ledger::Actor;
use jt_prospects::{Key, Prospect, ProspectError, ProspectId, ProspectsPolicy, Recorder};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{LeadsPolicy, TenantRepos};
use crate::usecases::Deps;

/// The `SecretBox::hmac_key` purpose of the blocklist's keyed hashes.
pub const BLOCKLIST_PURPOSE: &str = "prospects.blocklist";

/// The label the blocklist key's fingerprint is the MAC of.
const FINGERPRINT_LABEL: &[u8] = b"jeeta.prospects.blocklist.fingerprint";

/// The prefix that keeps a create's request keys apart from the inbox's.
pub(crate) const REQUEST_KEY_PREFIX: &str = "prospects.create:";

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

/// The workspace's leads policy (its defaults while none is stored), read without the
/// workspace-policy lock: a pool write holding the pool lock never waits for a policy writer.
pub(crate) async fn leads_policy(r: &mut dyn TenantRepos) -> Result<LeadsPolicy, AppError> {
    Ok(r.workspace_policy().read().await?.leads)
}

/// `p` with its purge time under the current `policy` (no purge time is stored).
pub(crate) fn with_purge_after(mut p: Prospect, policy: &ProspectsPolicy) -> Prospect {
    p.purge_after = jt_prospects::purge_after(
        policy,
        p.status,
        p.decision.as_ref().map(|d| d.at),
        p.updated_at,
    );
    p
}

/// Forgets the create requests that recorded prospect `id` (an erasure, a do-not-contact mark, a
/// purge): a replay of one never answers a row that is gone or scrubbed.
pub(crate) async fn forget_requests(
    r: &mut dyn TenantRepos,
    id: ProspectId,
) -> Result<u64, AppError> {
    r.request_keys()
        .forget(REQUEST_KEY_PREFIX, "prospect_id", &id.as_uuid().to_string())
        .await
}

/// The fingerprint of the workspace's blocklist key, stored with each entry it hashed: the
/// first 16 hex digits of its MAC of a fixed label. It names the key without revealing it, so
/// the entries a master-key change would orphan can be counted (a hash cannot be computed
/// again: the value is gone).
pub(crate) fn blocklist_fingerprint(deps: &Deps, ctx: &Ctx) -> Result<String, AppError> {
    let secret = deps.seal.hmac_key(ctx.workspace_id, BLOCKLIST_PURPOSE)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_ref())
        .map_err(|_| AppError::internal("blocklist key unavailable"))?;
    mac.update(FINGERPRINT_LABEL);
    let mut out = String::with_capacity(16);
    for byte in &mac.finalize().into_bytes()[..8] {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
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
