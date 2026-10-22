//! The workspace's capability groups (spec §6.3): `capability.groups.list`,
//! `capability.groups.create`, `capability.groups.rename`, `capability.groups.delete`,
//! `capability.groups.add_member` and `capability.groups.remove_member`.
//!
//! A group is a named set of capabilities (a brand, a branch, a persona, a purpose); a capability
//! may be in many groups and groups do not nest. Listing needs `workspace.read`; every change
//! needs `capabilities.manage`. A name is trimmed, 1 to 64 characters, and unique within the
//! workspace whatever its case ("Marka A" and "marka a" are one name): a taken name is `CONFLICT`.
//! A retired capability cannot join a group (`CONFLICT` "capability is retired"), and a group
//! the strategy narrows a channel to cannot be deleted (`CONFLICT`). Each change
//! writes one ledger entry about the group (`subject.kind = "capability_group"`) under the
//! strategy version in force, if any.

use jt_capability::{CapabilityGroup, CapabilityGroupId, CapabilityId, validate_name};
use jt_strategy::StrategyVersionId;
use jt_tenancy::Permission;
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;

use super::Deps;
use super::capabilities::{
    CapabilityOut, append, capability_error, find, locked, not_retired, version_in_force,
};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{CapabilityFilter, TenantRepos};

const NO_SUCH_GROUP: &str = "no such capability group";

/// A group with its members, each with its status at the time of the call, in id order.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GroupOut {
    pub group: CapabilityGroup,
    pub members: Vec<CapabilityOut>,
}

/// Every group of the workspace with its members, oldest group first. Needs `workspace.read`.
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<Vec<GroupOut>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let groups = repos.capability_groups().list().await?;
    let capabilities = repos
        .capabilities()
        .list(CapabilityFilter::default())
        .await?;
    Ok(groups
        .into_iter()
        .map(|(group, members)| GroupOut {
            group,
            members: members
                .iter()
                .filter_map(|id| capabilities.iter().find(|c| c.id == *id))
                .map(|c| CapabilityOut::at(c.clone(), ctx.now))
                .collect(),
        })
        .collect())
}

/// Creates a group called `name` (trimmed) for `purpose` (trimmed; blank is none) and returns
/// it. Needs `capabilities.manage`.
///
/// A bad name is `VALIDATION` naming `name`, a purpose over 2,000 characters naming `purpose`; a
/// name another group has, in any case, is `CONFLICT`. Writes `capability.groups.create` (payload
/// `name`).
pub async fn create(
    deps: &Deps,
    ctx: &Ctx,
    name: String,
    purpose: Option<String>,
) -> Result<GroupOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let purpose = purpose
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty());
    let group = CapabilityGroup::new(
        CapabilityGroupId(deps.ids.uuid()),
        ctx.workspace_id,
        name,
        purpose,
    )
    .map_err(capability_error)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    name_free(repos.as_mut(), &group.name, None).await?;
    repos
        .capability_groups()
        .insert(group.clone(), ctx.now)
        .await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.groups.create",
        group.id,
        in_force,
        json!({ "name": group.name }),
    )
    .await?;
    repos.commit().await?;
    Ok(GroupOut {
        group,
        members: Vec::new(),
    })
}

/// Renames group `id` to `name` (trimmed) and returns it. Needs `capabilities.manage`.
///
/// A bad name is `VALIDATION` naming `name`; a group that is not this workspace's `NOT_FOUND`; a
/// name another group has, in any case, `CONFLICT` (its own name in another case is fine). Writes
/// `capability.groups.rename` (payload `name`, `previous`).
pub async fn rename(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityGroupId,
    name: String,
) -> Result<GroupOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    validate_name(&name).map_err(capability_error)?;
    let name = name.trim().to_owned();
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let (group, _) = find_group(repos.as_mut(), id).await?;
    name_free(repos.as_mut(), &name, Some(id)).await?;
    repos.capability_groups().rename(id, &name).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.groups.rename",
        id,
        in_force,
        json!({ "name": name, "previous": group.name }),
    )
    .await?;
    let out = reread(repos.as_mut(), id, ctx.now).await?;
    repos.commit().await?;
    Ok(out)
}

/// Deletes group `id`; its members are detached and stay. Needs `capabilities.manage`. A group
/// that is not this workspace's is `NOT_FOUND`. A group a channel of the strategy is narrowed to
/// (`ChannelChoice::group_id` of the approved version or of the open draft) is `CONFLICT` "group
/// is referenced by the strategy", listing those versions in `details.version_ids` (the approved
/// one first), and nothing changes: deleting a group stays recoverable only while nothing refers
/// to it. Writes `capability.groups.delete` (payload `name`, `members`: how many it had).
///
/// The draft lock is taken first, as every draft mutation takes it, so a concurrent edit or
/// approval waits for the delete (or the delete for it) and the check reads a settled strategy.
pub async fn delete(deps: &Deps, ctx: &Ctx, id: CapabilityGroupId) -> Result<(), AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let draft = repos.strategy().lock_draft().await?;
    let (group, members) = find_group(repos.as_mut(), id).await?;
    let approved = repos.strategy().current_approved().await?;
    let referencing: Vec<StrategyVersionId> = approved
        .iter()
        .chain(draft.iter())
        .filter(|v| {
            v.sections
                .channels
                .iter()
                .any(|c| c.group_id == Some(id.as_uuid()))
        })
        .map(|v| v.id)
        .collect();
    if !referencing.is_empty() {
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: "group is referenced by the strategy".to_owned(),
            details: json!({ "version_ids": referencing }),
        });
    }
    repos.capability_groups().delete(id).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        "capability.groups.delete",
        id,
        in_force,
        json!({ "name": group.name, "members": members.len() }),
    )
    .await?;
    repos.commit().await
}

/// Adds capability `capability` to group `id` and returns the group; adding a member again
/// changes nothing. Needs `capabilities.manage`. A group or a capability that is not this
/// workspace's is `NOT_FOUND`; a retired capability `CONFLICT`. Writes
/// `capability.groups.add_member` (payload `capability_id`).
pub async fn add_member(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityGroupId,
    capability: CapabilityId,
) -> Result<GroupOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    find_group(repos.as_mut(), id).await?;
    // The capability is locked so that a concurrent retirement cannot slip in between the check
    // and the write; the group row needs no lock (a concurrent delete takes the member with it).
    let member = locked(repos.as_mut(), capability).await?;
    not_retired(&member)?;
    repos.capability_groups().add_member(id, capability).await?;
    member_changed(repos, ctx, "capability.groups.add_member", id, capability).await
}

/// Removes capability `capability` from group `id` and returns the group. Needs
/// `capabilities.manage`. A group that is not this workspace's, or a capability that is not its
/// member, is `NOT_FOUND`. Writes `capability.groups.remove_member` (payload `capability_id`).
pub async fn remove_member(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityGroupId,
    capability: CapabilityId,
) -> Result<GroupOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    find_group(repos.as_mut(), id).await?;
    repos
        .capability_groups()
        .remove_member(id, capability)
        .await?;
    member_changed(
        repos,
        ctx,
        "capability.groups.remove_member",
        id,
        capability,
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------------------------

/// Group `id` with its members, or `NOT_FOUND` when it is not this workspace's.
async fn find_group(
    repos: &mut dyn TenantRepos,
    id: CapabilityGroupId,
) -> Result<(CapabilityGroup, Vec<CapabilityId>), AppError> {
    repos
        .capability_groups()
        .find(id)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_GROUP))
}

/// `CONFLICT` when a group of the workspace other than `except` is called `name`, in any case.
/// Checked before writing, since a refused write aborts a Postgres transaction.
async fn name_free(
    repos: &mut dyn TenantRepos,
    name: &str,
    except: Option<CapabilityGroupId>,
) -> Result<(), AppError> {
    let wanted = name.to_lowercase();
    let taken = repos
        .capability_groups()
        .list()
        .await?
        .iter()
        .any(|(g, _)| Some(g.id) != except && g.name.to_lowercase() == wanted);
    if taken {
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: format!("a capability group called {name:?} already exists"),
            details: json!({ "reason": "name_taken" }),
        });
    }
    Ok(())
}

/// Ledgers a membership change of group `id` and commits; the group as it now stands.
async fn member_changed(
    mut repos: Box<dyn TenantRepos>,
    ctx: &Ctx,
    action: &str,
    id: CapabilityGroupId,
    capability: CapabilityId,
) -> Result<GroupOut, AppError> {
    let in_force = version_in_force(repos.as_mut()).await?;
    record(
        repos.as_mut(),
        ctx,
        action,
        id,
        in_force,
        json!({ "capability_id": capability }),
    )
    .await?;
    let out = reread(repos.as_mut(), id, ctx.now).await?;
    repos.commit().await?;
    Ok(out)
}

/// Writes the ledger entry `action` about group `id`.
async fn record(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    id: CapabilityGroupId,
    in_force: Option<StrategyVersionId>,
    payload: Value,
) -> Result<(), AppError> {
    append(
        repos,
        ctx,
        action,
        "capability_group",
        id,
        in_force,
        payload,
    )
    .await
}

/// Group `id` as it now stands in this bundle, its members seen at `now`.
async fn reread(
    repos: &mut dyn TenantRepos,
    id: CapabilityGroupId,
    now: OffsetDateTime,
) -> Result<GroupOut, AppError> {
    let (group, member_ids) = find_group(repos, id).await?;
    let mut members = Vec::with_capacity(member_ids.len());
    for member in member_ids {
        members.push(CapabilityOut::at(find(repos, member).await?, now));
    }
    Ok(GroupOut { group, members })
}
