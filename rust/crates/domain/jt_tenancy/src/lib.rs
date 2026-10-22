//! Tenancy domain: identifiers, email, roles, permissions and workspace status. Pure, no I/O.

mod email;
mod ids;
mod role;
mod workspace;

pub use email::{Email, EmailError};
pub use ids::{
    AgentConnectionId, ApiKeyId, MembershipId, OperatorId, RoleId, SessionId, UserId, WorkspaceId,
};
pub use role::{Permission, RoleDef, SystemRole, TenancyError, can_change_role};
pub use workspace::{MembershipStatus, WorkspaceStatus};
