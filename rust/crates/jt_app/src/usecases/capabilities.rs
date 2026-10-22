//! The workspace's capabilities (spec §6): `capability.list`, `capability.get`,
//! `capability.declare`, `capability.verify`, `capability.mark_unreachable`,
//! `capability.set_policy`, `capability.retire`, `capability.link_budget` and
//! `capability.unlink_budget`; and [`UowChannelCatalog`], the channel catalog the strategy reads
//! from them. The groups are in [`super::groups`], the budget items in [`super::budget`].
//!
//! **Who may do what.** Reading needs `workspace.read`. Every change needs `capabilities.manage`,
//! except verifying: an agent (whatever its key's other scopes) may verify a capability reached
//! through an agent or a device with `workspace.read` alone, because the evidence is its own claim
//! about its own hands (spec §6.4); a person needs `capabilities.manage`. A capability reached
//! through a connector is verified by its connector's probe, never by a claim: verifying one is
//! `CONFLICT` for everyone.
//!
//! **Retired is final.** A retired capability keeps its row for the record and can no longer be
//! verified, marked unreachable, given a policy, grouped or linked to a budget item (`CONFLICT`
//! "capability is retired"); retiring it again is `CONFLICT` too. Retiring detaches it from its
//! groups and budget items in the same transaction.
//!
//! **Tenant hosts.** A connector capability may name the hosts its connector reaches in
//! `connector_public.hosts` (an array of `host` or `host:port` strings). Declaring one checks
//! each host with the [`crate::ports::TenantHostRegistry`] before anything is written and allows
//! them once the capability is committed; retiring one revokes, once committed, the hosts that no
//! other live connector capability of the workspace names. A change of the tier that fails after
//! the commit is logged as a warning, not answered as an error: the committed change holds. The
//! hosts of a capability reached otherwise are only public data: the system never reaches them.
//!
//! **Locks.** Every mutation reads the capability through `CapabilityRepo::lock` first, in the
//! bundle that writes, so concurrent mutations of one capability take turns: none writes back a
//! row another changed meanwhile, and none attaches a capability retired meanwhile.
//!
//! **The record.** Each change writes one ledger entry about the capability
//! (`subject.kind = "capability"`), carrying in `strategy_version_id` the strategy version in
//! force, if any. No entry carries evidence text, sealed data or the public connector fields, and
//! no answer carries sealed data: a capability only says whether it has any.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use jt_capability::{
    BudgetItemId, Capability, CapabilityError, CapabilityGroupId, CapabilityId, CapabilityKind,
    DEFAULT_VERIFY_MAX_AGE_DAYS, EffectiveStatus, Evidence, Gap, Hours, KindGroup, NewCapability,
    Policy, Reach, StoredStatus, can_link_budget, effective_status, validate_evidence,
    validate_policy,
};
use jt_ledger::Actor;
use jt_strategy::StrategyVersionId;
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

use super::{Deps, invalid, ledger_entry};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::{CapabilityFilter, ChannelCatalog, TenantRepos, UnitOfWork};

/// The longest reason a capability may be marked unreachable for, in characters.
pub const MAX_REASON_CHARS: usize = 500;

/// The most hosts one connector capability may name in `connector_public.hosts`.
pub const MAX_HOSTS: usize = 20;

const NO_SUCH_CAPABILITY: &str = "no such capability";
const NO_SUCH_BUDGET_ITEM: &str = "no such budget item";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// A capability as the panel and the agent see it: as stored (never its sealed data, only
/// whether it has any), and the status it has at the time of the call.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CapabilityOut {
    pub capability: Capability,
    /// The stored status, but `Stale` once a verification is older than the policy allows.
    pub effective_status: EffectiveStatus,
}

impl CapabilityOut {
    /// `capability` as seen at `now`.
    pub fn at(capability: Capability, now: OffsetDateTime) -> CapabilityOut {
        let effective_status = effective_status(&capability, now);
        CapabilityOut {
            capability,
            effective_status,
        }
    }
}

/// What a capability is declared with. From JSON, an unknown field (in the policy too) is refused
/// rather than ignored: a misspelt policy field could be the human-approval flag.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeclareInput {
    /// One of the `jt_capability::KINDS` keys.
    pub kind_key: String,
    /// Required for the third-party kind `other` (the tool's name), refused for every other kind.
    #[serde(default)]
    pub key_detail: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The provider's id of the account, page or line.
    #[serde(default)]
    pub external_id: Option<String>,
    /// Public connector settings, an object; never a secret. A connector capability may name its
    /// hosts in `hosts`.
    #[serde(default)]
    pub connector_public: Value,
    /// The policy; none is [`Policy::default`].
    #[serde(default, deserialize_with = "strict_policy")]
    pub policy: Option<Policy>,
}

/// Which capabilities [`list`] returns, as a caller names them: every field that is set must
/// match.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityQuery {
    /// A kind group key, e.g. `"messaging"`.
    #[serde(default)]
    pub group: Option<String>,
    /// A kind key, e.g. `"mailbox"`.
    #[serde(default)]
    pub kind: Option<String>,
    /// A stored status key: `declared`, `verified`, `unreachable` or `retired`.
    #[serde(default)]
    pub status: Option<String>,
    /// Members of this capability group only.
    #[serde(default)]
    pub group_id: Option<CapabilityGroupId>,
}

impl CapabilityQuery {
    /// The repository filter, or `VALIDATION` naming `group`, `kind` or `status` when it is not a
    /// known key.
    pub fn filter(&self) -> Result<CapabilityFilter, AppError> {
        let group = match &self.group {
            Some(key) => Some(KindGroup::parse(key).ok_or_else(|| {
                invalid("group", &format!("unknown capability kind group {key:?}"))
            })?),
            None => None,
        };
        let kind = match &self.kind {
            Some(key) => Some(
                CapabilityKind::parse(key)
                    .ok_or_else(|| invalid("kind", &format!("unknown capability kind {key:?}")))?
                    .key,
            ),
            None => None,
        };
        let status = match &self.status {
            Some(key) => Some(StoredStatus::parse(key).ok_or_else(|| {
                invalid(
                    "status",
                    &format!(
                        "unknown status {key:?}; expected declared, verified, unreachable or \
                         retired"
                    ),
                )
            })?),
            None => None,
        };
        Ok(CapabilityFilter {
            group,
            kind,
            status,
            group_id: self.group_id,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// The capabilities `query` matches, oldest first, each with its status at `ctx.now`. Needs
/// `workspace.read`; an unknown group, kind or status key is `VALIDATION` naming it.
pub async fn list(
    deps: &Deps,
    ctx: &Ctx,
    query: CapabilityQuery,
) -> Result<Vec<CapabilityOut>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let filter = query.filter()?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let capabilities = repos.capabilities().list(filter).await?;
    Ok(capabilities
        .into_iter()
        .map(|c| CapabilityOut::at(c, ctx.now))
        .collect())
}

/// Capability `id` with its status at `ctx.now`. Needs `workspace.read`; an id that is not this
/// workspace's is `NOT_FOUND`.
pub async fn get(deps: &Deps, ctx: &Ctx, id: CapabilityId) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let capability = find(repos.as_mut(), id).await?;
    Ok(CapabilityOut::at(capability, ctx.now))
}

/// Declares a capability and returns it. Needs `capabilities.manage`.
///
/// The capability is `declared`, reached as its kind is (`CapabilityKind::default_reach`), with
/// the policy given (or the default) and the strategy version in force, if any. Refused with
/// `VALIDATION`: an unknown kind (naming `kind_key`), a missing, malformed or unexpected
/// `key_detail`, a bad `name`, an over-long `description`, a blank or over-long `external_id`
/// (each naming its field); public connector fields that are not an object or hold a
/// secret-looking key, and a policy with gaps (`details.gaps`). For a connector capability,
/// `connector_public.hosts`, when present, must be an array of at most [`MAX_HOSTS`] non-blank
/// strings (`details.gaps`), each of which the tenant host registry accepts (its own
/// `VALIDATION` "host is not public"). An external account another live capability of the kind
/// holds is `CONFLICT`. Nothing is written on a refusal.
///
/// Writes `capability.declare` (payload `kind_key`, `name` and, when given, `external_id`). Once
/// committed, each host is allowed; a host that cannot be allowed then (every one was checked
/// first) is logged as a warning and the declaration is answered all the same, since it holds.
pub async fn declare(
    deps: &Deps,
    ctx: &Ctx,
    input: DeclareInput,
) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let DeclareInput {
        kind_key,
        key_detail,
        name,
        description,
        external_id,
        connector_public,
        policy,
    } = input;
    let mut capability = Capability::new(
        CapabilityId(deps.ids.uuid()),
        ctx.workspace_id,
        NewCapability {
            kind_key,
            key_detail,
            name,
            description,
            external_id,
            connector_public,
            policy: policy.unwrap_or_default(),
        },
        ctx.now,
    )
    .map_err(capability_error)?;
    let hosts = match capability.reach {
        Reach::Connector => hosts_strict(&capability.connector_public)?,
        Reach::Agent | Reach::Device => Vec::new(),
    };
    for host in &hosts {
        deps.hosts.check(host)?;
    }

    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    capability.strategy_version_id = in_force.map(|v| v.as_uuid());
    repos
        .capabilities()
        .insert(capability.clone(), None)
        .await?;
    let mut payload = json!({ "kind_key": capability.kind_key, "name": capability.name });
    if let Some(external_id) = &capability.external_id {
        payload["external_id"] = json!(external_id);
    }
    record(
        repos.as_mut(),
        ctx,
        "capability.declare",
        capability.id,
        in_force,
        payload,
    )
    .await?;
    repos.commit().await?;

    for host in &hosts {
        if let Err(e) = deps.hosts.allow(ctx.workspace_id, host) {
            tracing::warn!(
                workspace_id = %ctx.workspace_id,
                capability_id = %capability.id,
                host,
                error = %e,
                "a declared capability's host could not be allowed"
            );
        }
    }
    Ok(CapabilityOut::at(capability, ctx.now))
}

/// Marks capability `id` verified on the strength of `evidence`, at `ctx.now`, and returns it.
///
/// An agent needs `workspace.read`; anyone else `capabilities.manage`. The evidence is checked
/// (`validate_evidence`; gaps are `VALIDATION` with `details.gaps`) and stored as given, never
/// checked against the world. An unknown id is `NOT_FOUND`; a capability reached through a
/// connector is `CONFLICT` "connector capabilities are verified by their probe"; a retired one
/// `CONFLICT` "capability is retired". Writes `capability.verify` (payload `evidence_refs`: how
/// many references the evidence has; never its text).
pub async fn verify(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    evidence: Evidence,
) -> Result<CapabilityOut, AppError> {
    match ctx.actor {
        // The agent's claim about its own hands: reading the workspace is enough.
        Actor::Agent { .. } => ctx.require(Permission::WorkspaceRead)?,
        Actor::Human { .. } | Actor::System { .. } => {
            ctx.require(Permission::CapabilitiesManage)?;
        }
    }
    let gaps = validate_evidence(&evidence);
    if !gaps.is_empty() {
        return Err(gaps_error("the evidence is not valid", gaps));
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut capability = locked(repos.as_mut(), id).await?;
    if capability.reach == Reach::Connector {
        return Err(AppError::conflict(
            "connector capabilities are verified by their probe",
        ));
    }
    not_retired(&capability)?;
    let refs = evidence.refs.len();
    capability.status = StoredStatus::Verified;
    capability.last_verified_at = Some(ctx.now);
    capability.evidence = Some(evidence);
    capability.updated_at = ctx.now;
    repos.capabilities().update(capability.clone()).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.verify",
        id,
        in_force,
        json!({ "evidence_refs": refs }),
    )
    .await?;
    repos.commit().await?;
    Ok(CapabilityOut::at(capability, ctx.now))
}

/// Marks capability `id` unreachable for `reason` and returns it. Needs `capabilities.manage`.
///
/// The reason is trimmed and must be 1 to [`MAX_REASON_CHARS`] characters, else `VALIDATION`
/// naming `reason`. An unknown id is `NOT_FOUND`; a retired capability `CONFLICT`. Writes
/// `capability.mark_unreachable` (payload `reason`).
pub async fn mark_unreachable(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    reason: String,
) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let reason = reason.trim();
    if reason.is_empty() || reason.chars().count() > MAX_REASON_CHARS {
        return Err(invalid(
            "reason",
            &format!("the reason must be 1 to {MAX_REASON_CHARS} characters"),
        ));
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let capability = locked(repos.as_mut(), id).await?;
    not_retired(&capability)?;
    repos
        .capabilities()
        .set_status(id, StoredStatus::Unreachable, ctx.now)
        .await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.mark_unreachable",
        id,
        in_force,
        json!({ "reason": reason }),
    )
    .await?;
    let out = reread(repos.as_mut(), id, ctx.now).await?;
    repos.commit().await?;
    Ok(out)
}

/// Replaces capability `id`'s policy and returns it. Needs `capabilities.manage`.
///
/// A policy with gaps (`validate_policy`) is `VALIDATION` with `details.gaps`. An unknown id is
/// `NOT_FOUND`; a retired capability `CONFLICT`. The capability's strategy version becomes the
/// one in force, if any. Writes `capability.set_policy` (payload `policy`).
pub async fn set_policy(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    policy: Policy,
) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let gaps = validate_policy(&policy);
    if !gaps.is_empty() {
        return Err(gaps_error("the policy is not valid", gaps));
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut capability = locked(repos.as_mut(), id).await?;
    not_retired(&capability)?;
    let in_force = version_in_force(repos.as_mut()).await?;
    let payload = json!({ "policy": policy });
    capability.policy = policy;
    capability.strategy_version_id = in_force.map(|v| v.as_uuid());
    capability.updated_at = ctx.now;
    repos.capabilities().update(capability.clone()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.set_policy",
        id,
        in_force,
        payload,
    )
    .await?;
    repos.commit().await?;
    Ok(CapabilityOut::at(capability, ctx.now))
}

/// Retires capability `id` and returns it. Needs `capabilities.manage` and `confirm` (else
/// `VALIDATION` naming `confirm`).
///
/// An unknown id is `NOT_FOUND`; a capability already retired `CONFLICT`. In one transaction it
/// becomes `retired`, is unlinked from every budget item and removed from every group (both
/// stay), and `capability.retire` is written (payload `budget_links`, `groups`: how many it left,
/// `hosts_revoked`: how many tenant hosts go). Once committed, each host it named that no other
/// live connector capability of the workspace names is revoked; a host that cannot be revoked
/// then is logged as a warning and the retirement is answered all the same, since it holds.
pub async fn retire(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    confirm: bool,
) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    if !confirm {
        return Err(invalid(
            "confirm",
            "confirm must be true to retire a capability",
        ));
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let capability = locked(repos.as_mut(), id).await?;
    if capability.status == StoredStatus::Retired {
        return Err(AppError::conflict("capability is already retired"));
    }
    repos
        .capabilities()
        .set_status(id, StoredStatus::Retired, ctx.now)
        .await?;
    for item in &capability.budget_item_ids {
        repos.budget().unlink(id, *item).await?;
    }
    let groups = repos.capability_groups().list().await?;
    let mut left = 0;
    for (group, members) in &groups {
        if members.contains(&id) {
            repos
                .capability_groups()
                .remove_member(group.id, id)
                .await?;
            left += 1;
        }
    }
    let still_needed: BTreeSet<String> = repos
        .capabilities()
        .list(CapabilityFilter::default())
        .await?
        .iter()
        .filter(|c| c.id != id && c.status != StoredStatus::Retired)
        .flat_map(declared_hosts)
        .map(|h| host_key(&h))
        .collect();
    let revoked: Vec<String> = declared_hosts(&capability)
        .into_iter()
        .filter(|h| !still_needed.contains(&host_key(h)))
        .collect();
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.retire",
        id,
        in_force,
        json!({
            "budget_links": capability.budget_item_ids.len(),
            "groups": left,
            "hosts_revoked": revoked.len(),
        }),
    )
    .await?;
    let out = reread(repos.as_mut(), id, ctx.now).await?;
    repos.commit().await?;

    for host in &revoked {
        if let Err(e) = deps.hosts.revoke(ctx.workspace_id, host) {
            tracing::warn!(
                workspace_id = %ctx.workspace_id,
                capability_id = %id,
                host,
                error = %e,
                "a retired capability's host could not be revoked"
            );
        }
    }
    Ok(out)
}

/// Links capability `id` to budget item `item`, the one it spends from, and returns it; linking
/// again changes nothing. Needs `capabilities.manage`.
///
/// A capability or an item that is not this workspace's is `NOT_FOUND`; a retired capability
/// `CONFLICT`; a capability whose kind may not spend from the item's kind (`can_link_budget`)
/// `VALIDATION` with `details.reason = "kind_mismatch"`. Writes `capability.link_budget`
/// (payload `budget_item_id`).
pub async fn link_budget(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    item: BudgetItemId,
) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let capability = locked(repos.as_mut(), id).await?;
    let budget_item = repos
        .budget()
        .find_item(item)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_BUDGET_ITEM))?;
    not_retired(&capability)?;
    let fits = capability
        .kind()
        .is_some_and(|kind| can_link_budget(kind, budget_item.kind));
    if !fits {
        return Err(AppError::validation(
            format!(
                "a {} capability cannot spend from a {} budget item",
                capability.kind_key,
                budget_item.kind.key()
            ),
            json!({ "reason": "kind_mismatch" }),
        ));
    }
    repos.budget().link(id, item).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.link_budget",
        id,
        in_force,
        json!({ "budget_item_id": item }),
    )
    .await?;
    let out = reread(repos.as_mut(), id, ctx.now).await?;
    repos.commit().await?;
    Ok(out)
}

/// Unlinks capability `id` from budget item `item` and returns it. Needs `capabilities.manage`.
/// A capability that is not this workspace's, or a pair that is not linked, is `NOT_FOUND`.
/// Writes `capability.unlink_budget` (payload `budget_item_id`).
pub async fn unlink_budget(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    item: BudgetItemId,
) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    locked(repos.as_mut(), id).await?;
    repos.budget().unlink(id, item).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.unlink_budget",
        id,
        in_force,
        json!({ "budget_item_id": item }),
    )
    .await?;
    let out = reread(repos.as_mut(), id, ctx.now).await?;
    repos.commit().await?;
    Ok(out)
}

/// The policy in `value`, read strictly: an unknown field, in the policy or in its hours, or a
/// field of the wrong type is `VALIDATION`; a missing field is its default (no hours, no caps, no
/// human approval, a verification lasting `DEFAULT_VERIFY_MAX_AGE_DAYS` days; hours need every
/// field but `tz`, which defaults to `UTC`). Whether the values keep the policy rules is
/// `validate_policy`'s to say, when the policy is written.
pub fn parse_policy_strict(value: &Value) -> Result<Policy, AppError> {
    PolicyInput::deserialize(value)
        .map(Policy::from)
        .map_err(|e| {
            AppError::validation(format!("invalid policy: {e}"), json!({ "field": "policy" }))
        })
}

// ---------------------------------------------------------------------------------------------
// The channel catalog
// ---------------------------------------------------------------------------------------------

/// The channel catalog over the capability registry: the kind keys of a workspace's capabilities
/// that are not retired, read in a tenant transaction of its own.
#[derive(Clone)]
pub struct UowChannelCatalog {
    pub uow: Arc<dyn UnitOfWork>,
}

impl UowChannelCatalog {
    /// The catalog over `uow`.
    pub fn new(uow: Arc<dyn UnitOfWork>) -> UowChannelCatalog {
        UowChannelCatalog { uow }
    }
}

#[async_trait]
impl ChannelCatalog for UowChannelCatalog {
    async fn kinds_in_use(&self, ws: WorkspaceId) -> Result<BTreeSet<String>, AppError> {
        let mut repos = self.uow.tenant(ws).await?;
        repos.capabilities().kinds_in_use().await
    }
}

// ---------------------------------------------------------------------------------------------
// Strict policy input
// ---------------------------------------------------------------------------------------------

/// [`Policy`] as written: the same fields and defaults, but an unknown field is an error.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyInput {
    #[serde(default)]
    active_hours: Option<HoursInput>,
    #[serde(default)]
    daily_ops_cap: Option<u32>,
    #[serde(default)]
    spend_cap_minor: Option<i64>,
    #[serde(default)]
    requires_human_approval: bool,
    #[serde(default = "default_verify_max_age_days")]
    verify_max_age_days: u16,
}

/// [`Hours`] as written: every field but `tz` is required, and an unknown field is an error.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HoursInput {
    #[serde(default = "utc")]
    tz: String,
    from: u8,
    to: u8,
    days: Vec<u8>,
}

fn default_verify_max_age_days() -> u16 {
    DEFAULT_VERIFY_MAX_AGE_DAYS
}

fn utc() -> String {
    "UTC".to_owned()
}

impl From<PolicyInput> for Policy {
    fn from(input: PolicyInput) -> Policy {
        // Built field by field, so a new `Policy` field fails to compile here until it is read.
        let PolicyInput {
            active_hours,
            daily_ops_cap,
            spend_cap_minor,
            requires_human_approval,
            verify_max_age_days,
        } = input;
        Policy {
            active_hours: active_hours.map(|h| Hours {
                tz: h.tz,
                from: h.from,
                to: h.to,
                days: h.days,
            }),
            daily_ops_cap,
            spend_cap_minor,
            requires_human_approval,
            verify_max_age_days,
        }
    }
}

/// `DeclareInput::policy` read strictly, as [`parse_policy_strict`] does.
fn strict_policy<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Policy>, D::Error> {
    Ok(Option::<PolicyInput>::deserialize(d)?.map(Policy::from))
}

// ---------------------------------------------------------------------------------------------
// Shared steps (the groups and budget use cases use them too)
// ---------------------------------------------------------------------------------------------

/// The `AppError` for a refusal by a `jt_capability` rule: `VALIDATION` naming the field
/// (`kind_key`, `key_detail`, `name`, `description`, `external_id`, `purpose`, `reference`,
/// `unit`, `cap` or `amount`), or with `details.gaps` for the public connector fields and the
/// policy.
pub(crate) fn capability_error(e: CapabilityError) -> AppError {
    let message = e.to_string();
    let field = match e {
        CapabilityError::InvalidConnectorPublic(gaps) | CapabilityError::InvalidPolicy(gaps) => {
            return gaps_error(&message, gaps);
        }
        CapabilityError::UnknownKind(_) => "kind_key",
        CapabilityError::KeyDetailRequired
        | CapabilityError::InvalidKeyDetail(_)
        | CapabilityError::KeyDetailNotAllowed(_) => "key_detail",
        CapabilityError::BlankName
        | CapabilityError::NameTooLong { .. }
        | CapabilityError::NameHasControlCharacter => "name",
        CapabilityError::TextTooLong { field, .. } => field,
        CapabilityError::BlankExternalId => "external_id",
        CapabilityError::InvalidCurrency(_) | CapabilityError::InvalidUnitLabel(_) => "unit",
        CapabilityError::NegativeCap(_) => "cap",
        CapabilityError::NonPositiveAmount(_) => "amount",
    };
    invalid(field, &message)
}

/// `VALIDATION` with `message`, listing `gaps` in `details.gaps`.
pub(crate) fn gaps_error(message: &str, gaps: Vec<Gap>) -> AppError {
    AppError::validation(message, json!({ "gaps": gaps }))
}

/// Capability `id`, or `NOT_FOUND` when it is not this workspace's.
pub(crate) async fn find(
    repos: &mut dyn TenantRepos,
    id: CapabilityId,
) -> Result<Capability, AppError> {
    repos
        .capabilities()
        .find(id)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_CAPABILITY))
}

/// Capability `id`, locked until the bundle ends (see `CapabilityRepo::lock`: every mutation
/// reads the capability through it first), or `NOT_FOUND` when it is not this workspace's.
pub(crate) async fn locked(
    repos: &mut dyn TenantRepos,
    id: CapabilityId,
) -> Result<Capability, AppError> {
    repos
        .capabilities()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_CAPABILITY))
}

/// `CONFLICT` "capability is retired" for a retired capability.
pub(crate) fn not_retired(capability: &Capability) -> Result<(), AppError> {
    if capability.status == StoredStatus::Retired {
        return Err(AppError::conflict("capability is retired"));
    }
    Ok(())
}

/// The id of the strategy version in force, if any.
pub(crate) async fn version_in_force(
    repos: &mut dyn TenantRepos,
) -> Result<Option<StrategyVersionId>, AppError> {
    Ok(repos.strategy().current_approved().await?.map(|v| v.id))
}

/// Writes the ledger entry `action` about the `kind` with this `id`, under the version in force
/// `in_force`.
pub(crate) async fn append(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    kind: &str,
    id: impl std::fmt::Display,
    in_force: Option<StrategyVersionId>,
    payload: Value,
) -> Result<(), AppError> {
    let mut entry = ledger_entry(ctx, action, kind, id, payload)?;
    entry.strategy_version_id = in_force.map(|v| v.as_uuid());
    repos.ledger().append(entry).await?;
    Ok(())
}

/// [`append`] about a capability.
async fn record(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    id: CapabilityId,
    in_force: Option<StrategyVersionId>,
    payload: Value,
) -> Result<(), AppError> {
    append(repos, ctx, action, "capability", id, in_force, payload).await
}

/// Capability `id` as it now stands in this bundle, seen at `now`.
async fn reread(
    repos: &mut dyn TenantRepos,
    id: CapabilityId,
    now: OffsetDateTime,
) -> Result<CapabilityOut, AppError> {
    let capability =
        repos.capabilities().find(id).await?.ok_or_else(|| {
            AppError::internal("a capability written in this transaction is missing")
        })?;
    Ok(CapabilityOut::at(capability, now))
}

/// The hosts in public connector fields being declared: none without a `hosts` field; else every
/// gap under `connector_public.hosts` (not an array, more than [`MAX_HOSTS`], an entry that is
/// not a non-blank string) is `VALIDATION` with `details.gaps`. Each host is trimmed.
fn hosts_strict(connector_public: &Value) -> Result<Vec<String>, AppError> {
    let gap = |field: String, message: &str| Gap {
        field,
        message: message.to_owned(),
    };
    let Some(hosts) = connector_public.get("hosts") else {
        return Ok(Vec::new());
    };
    let Some(entries) = hosts.as_array() else {
        return Err(gaps_error(
            "the hosts are not valid",
            vec![gap(
                "connector_public.hosts".into(),
                "the hosts must be an array of host names",
            )],
        ));
    };
    if entries.len() > MAX_HOSTS {
        return Err(gaps_error(
            "the hosts are not valid",
            vec![gap(
                "connector_public.hosts".into(),
                &format!("at most {MAX_HOSTS} hosts, got {}", entries.len()),
            )],
        ));
    }
    let mut gaps = Vec::new();
    let mut out = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        match entry.as_str().map(str::trim) {
            Some(host) if !host.is_empty() => out.push(host.to_owned()),
            _ => gaps.push(gap(
                format!("connector_public.hosts[{i}]"),
                "a host must be a non-blank string such as imap.example.com or host:port",
            )),
        }
    }
    if gaps.is_empty() {
        Ok(out)
    } else {
        Err(gaps_error("the hosts are not valid", gaps))
    }
}

/// The hosts a stored capability's connector reaches: the non-blank strings of
/// `connector_public.hosts`, trimmed, for a capability reached through a connector; none for any
/// other, or when there are none.
fn declared_hosts(capability: &Capability) -> Vec<String> {
    if capability.reach != Reach::Connector {
        return Vec::new();
    }
    capability.connector_public["hosts"]
        .as_array()
        .map(|hosts| {
            hosts
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Two spellings of a host that the allowlist treats as one compare equal under this key.
fn host_key(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}
