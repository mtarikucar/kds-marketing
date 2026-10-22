//! Tenancy domain: identifiers, email, roles, permissions and workspace status. Pure, no I/O.

mod email;
mod ids;
mod role;
mod workspace;

pub use email::{Email, EmailError};
pub use ids::{
    AgentConnectionId, ApiKeyId, MembershipId, OperatorId, RoleId, SessionId, UserId, WorkspaceId,
};
pub use role::{
    ActorAuthority, Permission, RoleDef, RoleGrant, SystemRole, TenancyError, can_change_role,
    can_define_role, can_grant_role, can_remove_member,
};
pub use workspace::{MembershipStatus, WorkspaceStatus};
