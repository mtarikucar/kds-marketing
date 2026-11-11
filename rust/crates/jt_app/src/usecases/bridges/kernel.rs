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
//! verifies the capabilities it keeps alive ([`heartbeat`]), declaring one it reports for the
//! first time ([`declare`]; [`of_kind`] and [`held`] find what the workspace already holds):
//! `last_verified_at` is the heartbeat, and what it reported of each is merged into the
//! capability's `connector_public` as the spec's [`FactsMerge`] says. A capability
//! of a kind with a heartbeat (`jt_capability::Heartbeat`) reads stale once its last one is older
//! than the kind's `stale_after`, and a health job marks it unreachable once it is older than the
//! kind's `unreachable_after` ([`silent`], [`mark_unreachable`]). A registration that brings it
//! back from any other status writes the spec's `online_action`; marking it unreachable writes its
//! `offline_action`.
//!
//! **Waiting.** A long-poll ([`wait_for`]) reads, and while it finds nothing waits until it is
//! signalled ([`crate::ports::bridges::BridgeSignals`]) or a [`FALLBACK_TICK`] has passed (what
//! another instance committed, a lease running out), then reads again, until its wait is over.
//!
//! **Leasing.** Each read of a bridge's poll for its commands leases in a transaction of its own,
//! as of when it is made ([`lease`]): the poll's time plus how long it has waited. A command
//! handed out and not acknowledged within the spec's [`BridgeSpec::redeliver_after`] is due
//! again. Which commands a read takes, and how, is the bridge's own.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration as StdDuration;

use jt_capability::{
    Capability, CapabilityId, EffectiveStatus, NewCapability, StoredStatus, effective_status,
};
use jt_ledger::Actor;
use jt_strategy::StrategyVersionId;
use jt_tenancy::Permission;
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::bridges::{BridgeSignals, SignalKey};
use crate::ports::{CapabilityFilter, IdGen, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::api_keys::AgentPrincipal;
use crate::usecases::capabilities::{append, locked, not_retired, version_in_force};

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
    /// How long a command handed out stays the bridge's before it is handed out again, when the
    /// bridge has not acknowledged it ([`lease`]).
    pub redeliver_after: Duration,
    /// How a heartbeat's facts are merged into what a capability kept ([`heartbeat`]).
    pub merge: FactsMerge,
}

/// How what a heartbeat reports of a capability is merged into its `connector_public`
/// ([`merge_facts`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactsMerge {
    /// Each fact (a key of `connector_public`) in place of the one it had; the other keys kept.
    Replace,
    /// As [`FactsMerge::Replace`], except that a fact that is an object is merged into the object
    /// the capability kept under its name, key by key and as deep as both are objects: what a
    /// heartbeat leaves out is kept, never dropped (a bridge that cannot read a phone's model once
    /// does not erase it). Any other value, an array included, replaces the one it had.
    Deep,
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
/// its `connector_public` (merged as the bridge's [`BridgeSpec::merge`] says), and the payload
/// of the `online_action` entry written should this registration bring it back.
#[derive(Clone, Debug, PartialEq)]
pub struct Beat {
    pub capability_id: CapabilityId,
    pub facts: Map<String, Value>,
    pub online: Value,
}

/// Bridge `spec`'s heartbeat on `beat.capability_id`, in the caller's bundle: the capability,
/// locked, reads verified at `ctx.now` (whatever it read before, a person's `mark_unreachable`
/// included) with `beat.facts` merged into its `connector_public` ([`merge_facts`] with
/// `spec.merge`); `spec.online_action` is written
/// (with `beat.online`, under the version in force `in_force`) when it did not read verified until
/// now. The capability as stored. Only `spec`'s own context ([`require_bridge`]); an unknown
/// capability is `NOT_FOUND`, a retired one `CONFLICT` "capability is retired", read under the
/// lock, so a heartbeat never undoes a retirement that won the race to it.
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
    not_retired(&capability)?;
    let before = effective_status(&capability, ctx.now);
    capability.status = StoredStatus::Verified;
    capability.last_verified_at = Some(ctx.now);
    capability.updated_at = ctx.now;
    merge_facts(&mut capability.connector_public, beat.facts, spec.merge);
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

/// Merges `facts` into `public` as `how` says (see [`FactsMerge`]); a `public` that is not an
/// object becomes `facts`.
pub fn merge_facts(public: &mut Value, facts: Map<String, Value>, how: FactsMerge) {
    match public.as_object_mut() {
        Some(kept) => merge_into(kept, facts, how == FactsMerge::Deep),
        None => *public = Value::Object(facts),
    }
}

/// Each of `facts` into `kept`, in place of what it had; with `deep`, an object into the object
/// it had, the same way.
fn merge_into(kept: &mut Map<String, Value>, facts: Map<String, Value>, deep: bool) {
    for (key, value) in facts {
        match kept.get_mut(&key) {
            Some(Value::Object(old)) if deep && value.is_object() => {
                if let Value::Object(new) = value {
                    merge_into(old, new, true);
                }
            }
            Some(slot) => *slot = value,
            None => {
                kept.insert(key, value);
            }
        }
    }
}

/// The workspace's capabilities of kind `kind_key`, oldest first, retired ones included.
pub async fn of_kind(
    r: &mut dyn TenantRepos,
    kind_key: &'static str,
) -> Result<Vec<Capability>, AppError> {
    r.capabilities()
        .list(CapabilityFilter {
            kind: Some(kind_key),
            ..CapabilityFilter::default()
        })
        .await
}

/// How a workspace holds what a bridge reports under one external id ([`held`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Held<'c> {
    /// The capability that is not retired: the one the bridge keeps alive.
    Live(&'c Capability),
    /// Only retired ones. It is not declared again; what the bridge is told is its own policy.
    Retired,
    /// None: the bridge declares it ([`declare`]).
    Missing,
}

/// How `capabilities` (one kind's, as [`of_kind`] reads them) hold external id `external_id`.
pub fn held<'c>(capabilities: &'c [Capability], external_id: &str) -> Held<'c> {
    let mut of_id = capabilities
        .iter()
        .filter(|c| c.external_id.as_deref() == Some(external_id))
        .peekable();
    if of_id.peek().is_none() {
        return Held::Missing;
    }
    of_id
        .find(|c| c.status != StoredStatus::Retired)
        .map_or(Held::Retired, Held::Live)
}

/// Declares, in the caller's bundle, a capability of kind `kind_key` named `name` with external id
/// `external_id` (its id from `ids`, under the version in force `in_force`), as
/// `capability.declare` would, writing `capability.declare` (`kind_key`, `name`, `external_id`):
/// what a bridge reports for the first time. The caller has checked that the name and the
/// external id are valid ones.
pub async fn declare(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    ids: &dyn IdGen,
    kind_key: &str,
    name: &str,
    external_id: &str,
    in_force: Option<StrategyVersionId>,
) -> Result<CapabilityId, AppError> {
    let mut capability = Capability::new(
        CapabilityId(ids.uuid()),
        ctx.workspace_id,
        NewCapability {
            kind_key: kind_key.into(),
            name: name.into(),
            external_id: Some(external_id.to_owned()),
            ..NewCapability::default()
        },
        ctx.now,
    )
    .map_err(|e| AppError::internal(format!("a {kind_key} cannot be declared: {e}")))?;
    capability.strategy_version_id = in_force.map(|v| v.as_uuid());
    let id = capability.id;
    let payload = json!({
        "kind_key": capability.kind_key,
        "name": capability.name,
        "external_id": external_id,
    });
    r.capabilities().insert(capability, None).await?;
    append(
        r,
        ctx,
        "capability.declare",
        "capability",
        id,
        in_force,
        payload,
    )
    .await?;
    Ok(id)
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

/// What one read of a long-poll returns ([`wait_for`]), and what a lease takes ([`lease`]).
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

// ---------------------------------------------------------------------------------------------
// Leasing
// ---------------------------------------------------------------------------------------------

/// When one read of a bridge's poll leases ([`lease`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lease {
    /// The read's time: the poll's, plus how long it has waited so far.
    pub now: OffsetDateTime,
    /// `now` less the spec's [`BridgeSpec::redeliver_after`]: a command handed out at or before
    /// this, and not acknowledged, is due again.
    pub redeliver_before: OffsetDateTime,
}

/// One read of bridge `spec`'s poll for its commands, `waited` into the wait of the poll made at
/// `ctx.now` (see the module docs): `take` leases in a transaction of its own, committed once it
/// answered, given the repos, the bridge's context at the read's time and the [`Lease`]; `Some`
/// with what it took, `None` when it took nothing. Its error ends the read with nothing committed.
/// Only `spec`'s own context ([`require_bridge`]).
pub async fn lease<T, F>(
    deps: &Deps,
    ctx: &Ctx,
    spec: &BridgeSpec,
    waited: StdDuration,
    take: F,
) -> Result<Option<Vec<T>>, AppError>
where
    T: Send,
    F: for<'r> FnOnce(
            &'r mut dyn TenantRepos,
            &'r Ctx,
            Lease,
        ) -> BoxFuture<'r, Result<Vec<T>, AppError>>
        + Send,
{
    require_bridge(spec, ctx)?;
    let now = ctx.now + Duration::try_from(waited).unwrap_or(Duration::ZERO);
    let at = Ctx { now, ..ctx.clone() };
    let when = Lease {
        now,
        redeliver_before: now - spec.redeliver_after,
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let taken = take(r.as_mut(), &at, when).await?;
    r.commit().await?;
    Ok((!taken.is_empty()).then_some(taken))
}
