//! Permissions, system roles, role definitions and the role-change rule.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ids::RoleId;

/// A single grantable capability. Its `key()` is the stable name stored and sent over the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Permission {
    /// See the workspace.
    #[serde(rename = "workspace.read")]
    WorkspaceRead,
    /// Invite, remove and re-role members.
    #[serde(rename = "team.manage")]
    TeamManage,
    /// Create and revoke API keys.
    #[serde(rename = "api_keys.manage")]
    ApiKeysManage,
    /// Read the workspace ledger.
    #[serde(rename = "ledger.read")]
    LedgerRead,
    /// Declare, verify, retire and group capabilities, set their policies and link them to
    /// budget items.
    #[serde(rename = "capabilities.manage")]
    CapabilitiesManage,
    /// Create budget items.
    #[serde(rename = "budget.manage")]
    BudgetManage,
}

const ALL_PERMISSIONS: &[Permission] = &[
    Permission::WorkspaceRead,
    Permission::TeamManage,
    Permission::ApiKeysManage,
    Permission::LedgerRead,
    Permission::CapabilitiesManage,
    Permission::BudgetManage,
];

impl Permission {
    /// The stable key, e.g. `"team.manage"`.
    pub fn key(&self) -> &'static str {
        match self {
            Permission::WorkspaceRead => "workspace.read",
            Permission::TeamManage => "team.manage",
            Permission::ApiKeysManage => "api_keys.manage",
            Permission::LedgerRead => "ledger.read",
            Permission::CapabilitiesManage => "capabilities.manage",
            Permission::BudgetManage => "budget.manage",
        }
    }

    /// The permission with this key, if any.
    pub fn parse(key: &str) -> Option<Permission> {
        ALL_PERMISSIONS.iter().copied().find(|p| p.key() == key)
    }

    /// Every permission.
    pub fn all() -> &'static [Permission] {
        ALL_PERMISSIONS
    }
}

/// The built-in roles every workspace has.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemRole {
    /// Full control; a workspace always keeps at least one.
    Owner,
    /// Full control, but not counted as an owner.
    Manager,
    /// Read-only member.
    Rep,
}

impl SystemRole {
    /// The stable key, e.g. `"owner"`.
    pub fn key(&self) -> &'static str {
        match self {
            SystemRole::Owner => "owner",
            SystemRole::Manager => "manager",
            SystemRole::Rep => "rep",
        }
    }

    /// The permissions this role grants.
    pub fn permissions(&self) -> BTreeSet<Permission> {
        match self {
            SystemRole::Owner | SystemRole::Manager => Permission::all().iter().copied().collect(),
            SystemRole::Rep => BTreeSet::from([Permission::WorkspaceRead]),
        }
    }
}

/// A role as stored for a workspace: either a seeded system role or a custom one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleDef {
    pub id: RoleId,
    pub key: String,
    pub name: String,
    pub permissions: BTreeSet<Permission>,
    pub is_system: bool,
}

/// A tenancy rule refused the operation.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TenancyError {
    /// The actor lacks the permission the operation needs.
    #[error("forbidden")]
    Forbidden,
    /// The operation would leave the workspace without an owner.
    #[error("the last owner cannot be removed or demoted")]
    LastOwner,
    /// Only an owner may grant the owner role, or change or remove a membership holding it.
    #[error("only an owner can grant, change or remove the owner role")]
    OwnerOnly,
    /// The role given, or the authority the target holds now, carries permissions the actor
    /// does not hold itself.
    #[error("the role carries permissions the actor does not hold")]
    ExceedsOwnAuthority {
        /// The permissions the actor lacks.
        missing: BTreeSet<Permission>,
    },
}

/// What an actor may hand on: its own permissions, and whether its role is `owner`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActorAuthority {
    pub permissions: BTreeSet<Permission>,
    pub is_owner: bool,
}

/// A role about to be given to a membership (by an invitation or a role change).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleGrant {
    /// Whether the role given is the `owner` system role.
    pub role_is_owner: bool,
    /// The permissions of the role given.
    pub role_permissions: BTreeSet<Permission>,
    /// Whether the membership holds the `owner` role now; `false` for a new invitation.
    pub current_role_is_owner: bool,
    /// The permissions of the role the membership holds now; empty for a new invitation.
    pub current_role_permissions: BTreeSet<Permission>,
}

/// Whether `actor` may give a membership the role of `grant`.
///
/// Requires `TeamManage` (`Forbidden`); then only an owner may give the owner role or change the
/// role of a membership holding it (`OwnerOnly`); then the role given may carry only permissions
/// the actor holds itself, and, unless the actor is an owner, so may the role the membership
/// holds now, so no one changes a member whose authority exceeds their own
/// (`ExceedsOwnAuthority`, naming every missing permission). The last-owner rule is
/// [`can_change_role`]'s.
pub fn can_grant_role(actor: &ActorAuthority, grant: &RoleGrant) -> Result<(), TenancyError> {
    if !actor.permissions.contains(&Permission::TeamManage) {
        return Err(TenancyError::Forbidden);
    }
    if (grant.role_is_owner || grant.current_role_is_owner) && !actor.is_owner {
        return Err(TenancyError::OwnerOnly);
    }
    within_own_authority(
        actor,
        &[
            &grant.role_permissions,
            target(actor, &grant.current_role_permissions),
        ],
    )
}

/// Whether `actor` may remove a membership (or cancel an invitation); `member_is_owner` says
/// whether it holds the owner role and `member_permissions` are the permissions of its role.
///
/// Requires `TeamManage` (`Forbidden`); only an owner may remove an owner (`OwnerOnly`); and,
/// unless the actor is an owner, the member's permissions must all be the actor's own
/// (`ExceedsOwnAuthority`, naming the missing ones). The last-owner rule is
/// [`can_change_role`]'s.
pub fn can_remove_member(
    actor: &ActorAuthority,
    member_is_owner: bool,
    member_permissions: &BTreeSet<Permission>,
) -> Result<(), TenancyError> {
    can_grant_role(
        actor,
        &RoleGrant {
            role_is_owner: false,
            role_permissions: BTreeSet::new(),
            current_role_is_owner: member_is_owner,
            current_role_permissions: member_permissions.clone(),
        },
    )
}

/// Whether `actor` may create a custom role with `permissions`: requires `TeamManage`
/// (`Forbidden`) and only permissions the actor holds itself (`ExceedsOwnAuthority`, naming the
/// missing ones).
pub fn can_define_role(
    actor: &ActorAuthority,
    permissions: &BTreeSet<Permission>,
) -> Result<(), TenancyError> {
    if !actor.permissions.contains(&Permission::TeamManage) {
        return Err(TenancyError::Forbidden);
    }
    within_own_authority(actor, &[permissions])
}

/// Whether `actor` may change a custom role's permissions from `current` to `new`: as
/// [`can_define_role`] for `new`, and, unless the actor is an owner, `current` must hold only
/// permissions the actor holds too, so no one strips a permission they do not hold themselves
/// from the members of a role (`ExceedsOwnAuthority`, naming every missing permission).
pub fn can_update_role(
    actor: &ActorAuthority,
    current: &BTreeSet<Permission>,
    new: &BTreeSet<Permission>,
) -> Result<(), TenancyError> {
    if !actor.permissions.contains(&Permission::TeamManage) {
        return Err(TenancyError::Forbidden);
    }
    within_own_authority(actor, &[new, target(actor, current)])
}

/// The present authority of a target that the actor must cover: none for an owner, else all of
/// `current`.
fn target<'a>(
    actor: &ActorAuthority,
    current: &'a BTreeSet<Permission>,
) -> &'a BTreeSet<Permission> {
    static NONE: BTreeSet<Permission> = BTreeSet::new();
    if actor.is_owner { &NONE } else { current }
}

/// `Ok` when every permission of `sets` is the actor's, else `ExceedsOwnAuthority` with all the
/// missing ones.
fn within_own_authority(
    actor: &ActorAuthority,
    sets: &[&BTreeSet<Permission>],
) -> Result<(), TenancyError> {
    let missing: BTreeSet<Permission> = sets
        .iter()
        .flat_map(|set| set.difference(&actor.permissions))
        .copied()
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(TenancyError::ExceedsOwnAuthority { missing })
    }
}

/// Whether an actor holding `actor` permissions may change (or remove) a member's role.
///
/// Requires `TeamManage`, and refuses when the target is the workspace's last owner.
pub fn can_change_role(
    actor: &BTreeSet<Permission>,
    target_is_last_owner: bool,
) -> Result<(), TenancyError> {
    if !actor.contains(&Permission::TeamManage) {
        return Err(TenancyError::Forbidden);
    }
    if target_is_last_owner {
        return Err(TenancyError::LastOwner);
    }
    Ok(())
}
