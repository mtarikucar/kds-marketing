//! The workspace's roles: `roles.list`, `roles.create`, `roles.update` and `roles.delete`.
//!
//! Every workspace has the three system roles (`owner`, `manager`, `rep`), created with it and
//! immutable. Custom roles carry a set of permissions under a key of [`KEY_MIN`] to [`KEY_MAX`]
//! lowercase letters, digits or underscores that is not a system role's. A caller may give a
//! custom role only permissions it holds itself (`can_define_role`), and, unless it is an owner,
//! may change only a role whose present permissions it holds too (`can_update_role`), so it
//! cannot strip from the role's members a permission it does not hold; else `FORBIDDEN`,
//! `details.reason = "exceeds_own_authority"` with the missing keys in `details.missing`.

use jt_tenancy::{Permission, RoleDef, RoleId, SystemRole, can_define_role, can_update_role};
use serde::Deserialize;
use serde_json::json;

use super::{Deps, invalid, ledger_entry, parse_permissions, permission_keys, refusal, required};
use crate::ctx::Ctx;
use crate::error::AppError;

/// The shortest custom role key, in characters.
pub const KEY_MIN: usize = 2;
/// The longest custom role key, in characters.
pub const KEY_MAX: usize = 32;
/// The longest role name, in characters.
pub const NAME_MAX: usize = 64;

const NO_SUCH_ROLE: &str = "no such role";

/// What creating a custom role asks for. `permissions` are permission keys such as
/// `"team.manage"`; duplicates collapse.
#[derive(Clone, Debug, Deserialize)]
pub struct CreateRole {
    pub key: String,
    pub name: String,
    pub permissions: Vec<String>,
}

/// The workspace's roles, system and custom. Needs `workspace.read`.
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<Vec<RoleDef>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos.roles().list().await
}

/// Creates a custom role. Needs `team.manage`.
///
/// A key outside `[a-z0-9_]{2,32}`, or a system role's key, is `VALIDATION` with
/// `details.field = "key"`; a name that is empty once trimmed or longer than [`NAME_MAX`]
/// characters, `VALIDATION` with `details.field = "name"`; unknown permission keys, `VALIDATION`
/// listing them in `details.unknown`. Permissions the caller does not hold are `FORBIDDEN` (see
/// the module docs). A key the workspace already has is `CONFLICT`. Writes `roles.create`
/// (payload `key`, `name`, `permissions`).
pub async fn create(deps: &Deps, ctx: &Ctx, input: CreateRole) -> Result<RoleDef, AppError> {
    ctx.require(Permission::TeamManage)?;
    if !is_valid_key(&input.key) {
        return Err(invalid(
            "key",
            &format!(
                "a role key is {KEY_MIN} to {KEY_MAX} lowercase letters, digits or underscores"
            ),
        ));
    }
    if is_system_key(&input.key) {
        return Err(invalid("key", "this key belongs to a system role"));
    }
    let name = required("name", &input.name)?;
    if name.chars().count() > NAME_MAX {
        return Err(invalid(
            "name",
            &format!("name must be at most {NAME_MAX} characters"),
        ));
    }
    let permissions = parse_permissions(&input.permissions)?;
    can_define_role(&ctx.authority(), &permissions).map_err(|e| refusal(ctx, e))?;

    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    if repos.roles().find_by_key(&input.key).await?.is_some() {
        return Err(AppError::conflict("role key is already taken"));
    }
    let role = RoleDef {
        id: RoleId(deps.ids.uuid()),
        key: input.key,
        name,
        permissions,
        is_system: false,
    };
    repos.roles().insert(role.clone()).await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "roles.create",
            "role",
            role.id,
            json!({
                "key": role.key,
                "name": role.name,
                "permissions": permission_keys(&role.permissions),
            }),
        )?)
        .await?;
    repos.commit().await?;
    Ok(role)
}

/// Replaces a custom role's permissions and returns the role. Needs `team.manage`.
///
/// Unknown permission keys are `VALIDATION` listing them in `details.unknown`; new permissions
/// the caller does not hold are `FORBIDDEN` (see the module docs); a role that is not this
/// workspace's is `NOT_FOUND`; a system role is `FORBIDDEN`; a role whose present permissions
/// the caller does not all hold is `FORBIDDEN` unless the caller is an owner (see the module
/// docs). Members holding the role get the new permissions from their next request. Writes
/// `roles.update` (payload `key`, `permissions`).
pub async fn update(
    deps: &Deps,
    ctx: &Ctx,
    role_id: RoleId,
    permissions: Vec<String>,
) -> Result<RoleDef, AppError> {
    ctx.require(Permission::TeamManage)?;
    let permissions = parse_permissions(&permissions)?;
    can_define_role(&ctx.authority(), &permissions).map_err(|e| refusal(ctx, e))?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let role = repos
        .roles()
        .find(role_id)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_ROLE))?;
    if role.is_system {
        return Err(AppError::forbidden("a system role cannot be changed"));
    }
    can_update_role(&ctx.authority(), &role.permissions, &permissions)
        .map_err(|e| refusal(ctx, e))?;
    repos
        .roles()
        .update_permissions(role_id, permissions.clone())
        .await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "roles.update",
            "role",
            role_id,
            json!({ "key": role.key, "permissions": permission_keys(&permissions) }),
        )?)
        .await?;
    repos.commit().await?;
    Ok(RoleDef {
        permissions,
        ..role
    })
}

/// Deletes a custom role. Needs `team.manage`.
///
/// A role that is not this workspace's is `NOT_FOUND`; a system role is `FORBIDDEN`; a role a
/// member or an open invitation holds is `CONFLICT`. Removed memberships do not hold it: those
/// that still reference it are moved to the system `rep` role (the role each held stays on
/// record in its `team.remove` ledger entry). Writes `roles.delete` (payload `key`).
pub async fn delete(deps: &Deps, ctx: &Ctx, role_id: RoleId) -> Result<(), AppError> {
    ctx.require(Permission::TeamManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let role = repos
        .roles()
        .find(role_id)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_ROLE))?;
    if role.is_system {
        return Err(AppError::forbidden("a system role cannot be deleted"));
    }
    if repos.roles().count_memberships_using(role_id).await? > 0 {
        return Err(AppError::conflict("the role is still in use"));
    }
    repos.roles().delete_custom(role_id).await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "roles.delete",
            "role",
            role_id,
            json!({ "key": role.key }),
        )?)
        .await?;
    repos.commit().await
}

/// Whether `key` is `[a-z0-9_]{2,32}`.
fn is_valid_key(key: &str) -> bool {
    (KEY_MIN..=KEY_MAX).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn is_system_key(key: &str) -> bool {
    [SystemRole::Owner, SystemRole::Manager, SystemRole::Rep]
        .iter()
        .any(|r| r.key() == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_two_to_thirty_two_lowercase_letters_digits_or_underscores() {
        for ok in ["ab", "sales_lead", "a1", "__", &"z".repeat(32)] {
            assert!(is_valid_key(ok), "{ok:?}");
        }
        for bad in ["", "a", "Ab", "a-b", "a b", "ä1", &"z".repeat(33)] {
            assert!(!is_valid_key(bad), "{bad:?}");
        }
    }
}
