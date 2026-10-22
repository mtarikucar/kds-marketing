//! `jeeta.roles.list`, `jeeta.roles.create`, `jeeta.roles.update` and `jeeta.roles.delete`.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::roles::{self, CreateRole};
use jt_tenancy::{Permission, RoleId};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "roles.list",
            description: "List the workspace's roles, the system roles (owner, manager, rep) \
                          and custom ones, with their ids, keys and permissions. Returns \
                          {roles: [...]}. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: list,
        },
        ToolDef {
            use_case: "roles.create",
            description: "Create a custom role with a key (2 to 32 lowercase letters, digits or \
                          underscores), a name and permissions the caller holds itself. Returns \
                          the role. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<CreateArgs>,
            run: create,
        },
        ToolDef {
            use_case: "roles.update",
            description: "Replace the permissions of a custom role, by role id; members holding \
                          it get them from their next request. System roles cannot be changed. \
                          Returns the role. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<UpdateArgs>,
            run: update,
        },
        ToolDef {
            use_case: "roles.delete",
            description: "Delete a custom role that no membership uses, by role id. System \
                          roles cannot be deleted. [risk: DESTRUCTIVE]",
            permission: Permission::TeamManage,
            schema: schema_for::<RoleArgs>,
            run: delete,
        },
    ]
}

/// A new custom role.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CreateArgs {
    /// 2 to 32 lowercase letters, digits or underscores; not owner, manager or rep.
    key: String,
    /// A display name of at most 64 characters.
    name: String,
    /// Permission keys the role grants.
    #[schemars(schema_with = "super::permission_keys_schema")]
    permissions: Vec<String>,
}

/// A custom role's new permissions.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    /// The role id, from jeeta.roles.list.
    role_id: Uuid,
    /// The permission keys the role grants from now on.
    #[schemars(schema_with = "super::permission_keys_schema")]
    permissions: Vec<String>,
}

/// Which role.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RoleArgs {
    /// The role id, from jeeta.roles.list.
    role_id: Uuid,
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("roles", &roles::list(deps, ctx).await?)
    })
}

fn create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let CreateArgs {
            key,
            name,
            permissions,
        } = args(raw)?;
        let input = CreateRole {
            key,
            name,
            permissions,
        };
        to_json(&roles::create(deps, ctx, input).await?)
    })
}

fn update<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let UpdateArgs {
            role_id,
            permissions,
        } = args(raw)?;
        to_json(&roles::update(deps, ctx, RoleId(role_id), permissions).await?)
    })
}

fn delete<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let RoleArgs { role_id } = args(raw)?;
        roles::delete(deps, ctx, RoleId(role_id)).await?;
        Ok(json!({ "role_id": role_id, "deleted": true }))
    })
}
