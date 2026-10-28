//! What every bridge does alike, each described by its [`BridgeSpec`] (the voice bridge's is
//! `calls::bridge::VOICE_BRIDGE`).
//!
//! **Who.** A bridge calls with an API key issued with its spec's permission and nothing else
//! ([`ctx_for`]); [`require_bridge`] refuses any other caller, a person or an agent whose key
//! holds every permission included (`FORBIDDEN`, `details.reason = "bridge_key_only"`). It acts as
//! the system (`Actor::System { component }`, the spec's component), never through an agent
//! connection, so its heartbeat never reads as an agent checking in.
//!
//! **Heartbeat.** A bridge registers every [`BridgeSpec::heartbeat_s`] seconds; each registration
//! verifies the capabilities it keeps alive ([`heartbeat`]): `last_verified_at` is the heartbeat,
//! and what it reported of each is merged into the capability's `connector_public`. A capability
//! of a kind with a heartbeat (`jt_capability::Heartbeat`) reads stale once its last one is older
//! than the kind's `stale_after`, and a health job marks it unreachable once it is older than the
//! kind's `unreachable_after` ([`silent`], [`mark_unreachable`]). A registration that brings it
//! back from any other status writes the spec's `online_action`; marking it unreachable writes its
//! `offline_action`.
//!
//! **Waiting.** A long-poll ([`wait_for`]) reads, and while it finds nothing waits until it is
//! signalled ([`crate::ports::bridges::BridgeSignals`]) or a [`FALLBACK_TICK`] has passed (what
//! another instance committed, a lease running out), then reads again, until its wait is over.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration as StdDuration;

use jt_capability::{Capability, CapabilityId, EffectiveStatus, StoredStatus, effective_status};
use jt_ledger::Actor;
use jt_strategy::StrategyVersionId;
use jt_tenancy::Permission;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::bridges::{BridgeSignals, SignalKey};
use crate::ports::{CapabilityFilter, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::api_keys::AgentPrincipal;
use crate::usecases::capabilities::{append, locked, version_in_force};

/// How often a waiting long-poll reads again when no signal woke it: what another server
/// instance committed reaches it within this.
pub const FALLBACK_TICK: StdDuration = StdDuration::from_secs(1);

/// What sets one bridge apart from another in what they do alike.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BridgeSpec {
    /// The system component the bridge acts as, e.g. `"voice_bridge"`.
    pub component: &'static str,
    /// The bridge as a refusal names it, e.g. `"voice bridge"`.
    pub name: &'static str,
    /// The one permission the bridge's key holds.
    pub permission: Permission,
    /// How often the bridge registers, as its registration tells it.
    pub heartbeat_s: u32,
    /// The ledger action of a registration that brings a capability back, e.g.
    /// `"calls.bridge.online"`.
    pub online_action: &'static str,
    /// The ledger action of a capability marked unreachable, e.g. `"calls.bridge.offline"`.
    pub offline_action: &'static str,
}

// ---------------------------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------------------------

/// The context of a call bridge `spec` makes at `now` with the key behind `p`: the system
/// component `spec.component` in the key's workspace, with the key's effective scopes, no role
/// and no agent connection.
pub fn ctx_for(spec: &BridgeSpec, p: &AgentPrincipal, now: OffsetDateTime) -> Ctx {
    Ctx {
        workspace_id: p.workspace_id,
        actor: Actor::System {
            component: spec.component.to_owned(),
        },
        permissions: p.permissions.clone(),
        role_key: None,
        now,
        agent_connection_id: None,
    }
}

/// `Ok` for bridge `spec`'s own context: its permission (else `FORBIDDEN` naming it), held alone
/// by its component (else `FORBIDDEN` with `details.reason = "bridge_key_only"`).
pub fn require_bridge(spec: &BridgeSpec, ctx: &Ctx) -> Result<(), AppError> {
    ctx.require(spec.permission)?;
    let bridge = matches!(&ctx.actor, Actor::System { component } if component == spec.component);
    if bridge && ctx.permissions.len() == 1 {
        return Ok(());
    }
    Err(AppError {
        code: ErrorCode::Forbidden,
        message: format!(
            "only the {}'s own key, holding {} alone, reaches the bridge",
            spec.name,
            spec.permission.key()
        ),
        details: json!({ "reason": "bridge_key_only" }),
    })
}

// ---------------------------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------------------------

/// What one registration reports of a capability its bridge keeps alive: the facts to keep in
/// its `connector_public` (each key in place of the one it had, its other keys kept), and the
/// payload of the `online_action` entry written should this registration bring it back.
#[derive(Clone, Debug, PartialEq)]
pub struct Beat {
    pub capability_id: CapabilityId,
    pub facts: Map<String, Value>,
    pub online: Value,
}

/// Bridge `spec`'s heartbeat on `beat.capability_id`, in the caller's bundle: the capability,
/// locked, reads verified at `ctx.now` (whatever it read before, a person's `mark_unreachable`
/// included) with `beat.facts` merged into its `connector_public`; `spec.online_action` is written
/// (with `beat.online`, under the version in force `in_force`) when it did not read verified until
/// now. The capability as stored. Only `spec`'s own context ([`require_bridge`]); an unknown
/// capability is `NOT_FOUND`.
pub async fn heartbeat(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    spec: &BridgeSpec,
    in_force: Option<StrategyVersionId>,
    beat: Beat,
) -> Result<Capability, AppError> {
    require_bridge(spec, ctx)?;
    let id = beat.capability_id;
    let mut capability = locked(r, id).await?;
    let before = effective_status(&capability, ctx.now);
    capability.status = StoredStatus::Verified;
    capability.last_verified_at = Some(ctx.now);
    capability.updated_at = ctx.now;
    match capability.connector_public.as_object_mut() {
        Some(public) => public.extend(beat.facts),
        None => capability.connector_public = Value::Object(beat.facts),
    }
    r.capabilities().update(capability.clone()).await?;
    if before != EffectiveStatus::Verified {
        append(
            r,
            ctx,
            spec.online_action,
            "capability",
            id,
            in_force,
            beat.online,
        )
        .await?;
    }
    Ok(capability)
}

// ---------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------

/// Whether capability `c` still reads verified although its last heartbeat is older than its
/// kind's `unreachable_after` (or it has none). A kind without a heartbeat never goes silent.
fn is_silent(c: &Capability, now: OffsetDateTime) -> bool {
    let Some(beat) = c.kind().and_then(|k| k.heartbeat()) else {
        return false;
    };
    c.status == StoredStatus::Verified
        && c.last_verified_at
            .is_none_or(|at| now - at > beat.unreachable_after)
}

/// The workspace's capabilities of kind `kind_key`, not retired, that went silent before `now`
/// (their last heartbeat older than their kind's `unreachable_after` while they still read
/// verified), oldest first: what a health job marks unreachable.
pub async fn silent(
    r: &mut dyn TenantRepos,
    kind_key: &'static str,
    now: OffsetDateTime,
) -> Result<Vec<CapabilityId>, AppError> {
    Ok(r.capabilities()
        .list(CapabilityFilter {
            kind: Some(kind_key),
            ..CapabilityFilter::default()
        })
        .await?
        .into_iter()
        .filter(|c| c.status != StoredStatus::Retired && is_silent(c, now))
        .map(|c| c.id)
        .collect())
}

/// Marks capability `id` (of kind `kind_key`) unreachable at `ctx.now` while it is still silent,
/// in a transaction of its own, writing `spec.offline_action` (`capability_id`, `last_seen_at`:
/// its last heartbeat); `false` when it registered (or changed otherwise) meanwhile, or is of
/// another kind.
pub async fn mark_unreachable(
    deps: &Deps,
    ctx: &Ctx,
    spec: &BridgeSpec,
    kind_key: &'static str,
    id: CapabilityId,
) -> Result<bool, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let capability = locked(r.as_mut(), id).await?;
    if capability.kind_key != kind_key || !is_silent(&capability, ctx.now) {
        return Ok(false);
    }
    r.capabilities()
        .set_status(id, StoredStatus::Unreachable, ctx.now)
        .await?;
    let in_force = version_in_force(r.as_mut()).await?;
    let last_seen_at = capability.last_verified_at.and_then(|at| {
        at.format(&time::format_description::well_known::Rfc3339)
            .ok()
    });
    append(
        r.as_mut(),
        ctx,
        spec.offline_action,
        "capability",
        id,
        in_force,
        json!({ "capability_id": id, "last_seen_at": last_seen_at }),
    )
    .await?;
    r.commit().await?;
    Ok(true)
}

// ---------------------------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------------------------

/// What one read of a long-poll returns ([`wait_for`]).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A long-poll on `key` (see the module docs): `poll` reads, told how long the wait has lasted so
/// far, and answers `Some` once it found what is waited for, which is returned at once. While it
/// answers `None` the wait goes on until `signals` wakes it on `key` or a [`FALLBACK_TICK`] has
/// passed, and `poll` reads again; once `wait` is over, `None` (a `wait` of zero reads once). A
/// read's error ends the wait with it.
pub async fn wait_for<'a, T>(
    signals: &dyn BridgeSignals,
    key: SignalKey,
    wait: StdDuration,
    mut poll: impl FnMut(StdDuration) -> BoxFuture<'a, Result<Option<T>, AppError>>,
) -> Result<Option<T>, AppError> {
    let started = tokio::time::Instant::now();
    loop {
        // Watching before reading: what is committed after the read still wakes the wait.
        let watch = signals.watch(key);
        let waited = started.elapsed();
        if let Some(found) = poll(waited).await? {
            return Ok(Some(found));
        }
        if waited >= wait {
            return Ok(None);
        }
        // Woken, or the fallback tick: look again either way.
        let _ = tokio::time::timeout(FALLBACK_TICK.min(wait - waited), watch).await;
    }
}
