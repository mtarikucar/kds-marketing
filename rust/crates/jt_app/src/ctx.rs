//! Who is calling, for which workspace, with what permissions, and when.

use std::collections::BTreeSet;

use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, OperatorId, Permission, WorkspaceId};
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
}

/// The context of a platform-operator call; not tied to any workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlatformCtx {
    pub operator_id: OperatorId,
    pub now: OffsetDateTime,
}

#[cfg(test)]
mod tests {
    use jt_tenancy::{SystemRole, UserId};
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
            now: datetime!(2026-10-22 09:30:00 UTC),
            agent_connection_id: None,
        };
        assert!(ctx.require(Permission::WorkspaceRead).is_ok());
        let err = ctx.require(Permission::TeamManage).unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
        assert_eq!(err.details, json!({ "permission": "team.manage" }));
    }
}
