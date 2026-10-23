//! Who is calling, for which workspace, with what permissions, and when.

use std::collections::BTreeSet;

use jt_ledger::Actor;
use jt_tenancy::{
    ActorAuthority, AgentConnectionId, OperatorId, Permission, SystemRole, WorkspaceId,
};
use serde_json::json;
use time::OffsetDateTime;

use crate::error::{AppError, ErrorCode};

/// The context of a tenant-scoped call, built by an adapter after authentication.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ctx {
    pub workspace_id: WorkspaceId,
    pub actor: Actor,
    /// What the caller may do in this workspace (for an agent: its key's effective scopes).
    pub permissions: BTreeSet<Permission>,
    /// The key of the role behind the caller: their own, or for an agent, its issuer's. `None`
    /// when no role is known, which never counts as the owner role.
    pub role_key: Option<String>,
    pub now: OffsetDateTime,
    /// Set when the caller is an agent acting through a connection.
    pub agent_connection_id: Option<AgentConnectionId>,
}

impl Ctx {
    /// `Ok` when the caller holds `p`, else `FORBIDDEN` with `details.permission` set to its key.
    pub fn require(&self, p: Permission) -> Result<(), AppError> {
        if self.permissions.contains(&p) {
            return Ok(());
        }
        Err(AppError {
            code: ErrorCode::Forbidden,
            message: format!("missing permission {}", p.key()),
            details: json!({ "permission": p.key() }),
        })
    }

    /// What the caller may hand on, for the role rules of `jt_tenancy`: its permissions, and
    /// whether its role is `owner`.
    pub fn authority(&self) -> ActorAuthority {
        ActorAuthority {
            permissions: self.permissions.clone(),
            is_owner: self.role_key.as_deref() == Some(SystemRole::Owner.key()),
        }
    }
}

/// The context of a platform-operator call; not tied to any workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlatformCtx {
    pub operator_id: OperatorId,
    pub now: OffsetDateTime,
}

#[cfg(test)]
mod tests {
    use jt_tenancy::UserId;
    use time::macros::datetime;

    use super::*;

    #[test]
    fn require_checks_the_permission_set() {
        let ctx = Ctx {
            workspace_id: WorkspaceId::new_v7(),
            actor: Actor::Human {
                user_id: UserId::new_v7(),
            },
            permissions: SystemRole::Rep.permissions(),
            role_key: Some("rep".into()),
            now: datetime!(2026-10-22 09:30:00 UTC),
            agent_connection_id: None,
        };
        assert!(ctx.require(Permission::WorkspaceRead).is_ok());
        let err = ctx.require(Permission::TeamManage).unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
        assert_eq!(err.details, json!({ "permission": "team.manage" }));
    }

    #[test]
    fn authority_counts_only_the_owner_role_key_as_owner() {
        let mut ctx = Ctx {
            workspace_id: WorkspaceId::new_v7(),
            actor: Actor::Human {
                user_id: UserId::new_v7(),
            },
            permissions: SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now: datetime!(2026-10-22 09:30:00 UTC),
            agent_connection_id: None,
        };
        assert_eq!(
            ctx.authority(),
            ActorAuthority {
                permissions: SystemRole::Owner.permissions(),
                is_owner: true,
            }
        );
        for key in [None, Some("manager".to_owned())] {
            ctx.role_key = key;
            assert!(!ctx.authority().is_owner);
        }
    }
}
