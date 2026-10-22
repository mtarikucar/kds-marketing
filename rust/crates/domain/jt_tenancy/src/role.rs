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
}

const ALL_PERMISSIONS: &[Permission] = &[
    Permission::WorkspaceRead,
    Permission::TeamManage,
    Permission::ApiKeysManage,
    Permission::LedgerRead,
];

impl Permission {
    /// The stable key, e.g. `"team.manage"`.
    pub fn key(&self) -> &'static str {
        match self {
            Permission::WorkspaceRead => "workspace.read",
            Permission::TeamManage => "team.manage",
            Permission::ApiKeysManage => "api_keys.manage",
            Permission::LedgerRead => "ledger.read",
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TenancyError {
    /// The actor lacks the permission the operation needs.
    #[error("forbidden")]
    Forbidden,
    /// The operation would leave the workspace without an owner.
    #[error("the last owner cannot be removed or demoted")]
    LastOwner,
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
