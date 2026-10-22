//! The caller's workspace: `workspace.info`.

use std::collections::BTreeSet;

use jt_ledger::Actor;
use jt_tenancy::{MembershipStatus, Permission, WorkspaceId, WorkspaceStatus};
use serde::Serialize;

use super::Deps;
use crate::ctx::Ctx;
use crate::error::AppError;

/// The workspace as its members (and their agents) see it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceOut {
    pub id: WorkspaceId,
    pub name: String,
    pub slug: String,
    pub status: WorkspaceStatus,
    /// The key of the role behind the caller: their own, or for an agent, its issuer's.
    pub my_role: String,
    /// What the caller may do here (for an agent: its key's effective scopes).
    pub my_permissions: BTreeSet<Permission>,
}

/// The context's workspace with the caller's role and permissions there. Needs
/// `workspace.read`; a caller without an active membership behind them (the human, or the user
/// who issued the agent's key) is `FORBIDDEN`.
pub async fn info(deps: &Deps, ctx: &Ctx) -> Result<WorkspaceOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let user_id = match &ctx.actor {
        Actor::Human { user_id } | Actor::Agent { user_id, .. } => *user_id,
        Actor::System { .. } => return Err(not_a_member()),
    };
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let workspace = repos.workspace().get().await?;
    let membership = repos
        .memberships()
        .find_by_user(user_id)
        .await?
        .filter(|m| m.status == MembershipStatus::Active)
        .ok_or_else(not_a_member)?;
    let role = repos
        .roles()
        .find(membership.role_id)
        .await?
        .ok_or_else(|| AppError::internal("membership refers to a missing role"))?;
    Ok(WorkspaceOut {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        status: workspace.status,
        my_role: role.key,
        my_permissions: ctx.permissions.clone(),
    })
}

fn not_a_member() -> AppError {
    AppError::forbidden("not an active member of this workspace")
}
