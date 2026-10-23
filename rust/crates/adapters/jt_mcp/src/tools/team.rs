//! `jeeta.team.list`, `jeeta.team.invite`, `jeeta.team.set_role` and `jeeta.team.remove`.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::team::{self, InviteInput};
use jt_tenancy::{MembershipId, Permission};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "team.list",
            description: "List the workspace's members and open invitations, oldest first, with \
                          each one's membership id, email, role and status. Returns \
                          {members: [...]}. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: list,
        },
        ToolDef {
            use_case: "team.invite",
            description: "Invite an email address into the workspace with one of its roles \
                          (see jeeta.roles.list). Returns the invitation with its one-time invite \
                          token, valid for 7 days, to pass on to the invitee. Only an owner may \
                          invite an owner, and a role may carry only permissions the caller \
                          holds. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<InviteArgs>,
            run: invite,
        },
        ToolDef {
            use_case: "team.set_role",
            description: "Move an active member to another role of the workspace, by membership \
                          id and role key. The last owner cannot be demoted. Returns the updated \
                          member. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<SetRoleArgs>,
            run: set_role,
        },
        ToolDef {
            use_case: "team.remove",
            description: "Remove a member from the workspace, or cancel an open invitation, by \
                          membership id. The last owner cannot be removed. \
                          [risk: DESTRUCTIVE]",
            permission: Permission::TeamManage,
            schema: schema_for::<MembershipArgs>,
            run: remove,
        },
    ]
}

/// Whom to invite, and with which role.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct InviteArgs {
    /// The invitee's email address.
    #[schemars(email)]
    email: String,
    /// The key of one of the workspace's roles, e.g. "rep".
    role_key: String,
}

/// Which membership gets which role.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SetRoleArgs {
    /// The membership id, from jeeta.team.list.
    membership_id: Uuid,
    /// The key of the new role, e.g. "manager".
    role_key: String,
}

/// Which membership.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MembershipArgs {
    /// The membership id, from jeeta.team.list.
    membership_id: Uuid,
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("members", &team::list(deps, ctx).await?)
    })
}

fn invite<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let InviteArgs { email, role_key } = args(raw)?;
        to_json(&team::invite(deps, ctx, InviteInput { email, role_key }).await?)
    })
}

fn set_role<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let SetRoleArgs {
            membership_id,
            role_key,
        } = args(raw)?;
        to_json(&team::set_role(deps, ctx, MembershipId(membership_id), &role_key).await?)
    })
}

fn remove<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let MembershipArgs { membership_id } = args(raw)?;
        team::remove(deps, ctx, MembershipId(membership_id)).await?;
        Ok(json!({ "membership_id": membership_id, "removed": true }))
    })
}
