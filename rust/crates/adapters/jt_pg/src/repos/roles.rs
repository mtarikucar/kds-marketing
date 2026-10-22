//! `roles`: a workspace's system and custom roles. Permissions are stored as `text[]` of
//! `Permission::key()`.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::RoleRepo;
use jt_tenancy::{Permission, RoleDef, RoleId, SystemRole, WorkspaceId};
use sqlx::PgConnection;
use uuid::Uuid;

use super::{FOREIGN_KEY_VIOLATION, map_sqlx, permission_keys, permissions_from};
use crate::tx::UserTx;
use crate::uow::PgTenantRepos;

#[derive(sqlx::FromRow)]
struct RoleRecord {
    id: Uuid,
    key: String,
    name: String,
    permissions: Vec<String>,
    is_system: bool,
}

impl From<RoleRecord> for RoleDef {
    fn from(r: RoleRecord) -> RoleDef {
        RoleDef {
            id: RoleId(r.id),
            key: r.key,
            name: r.name,
            permissions: permissions_from(r.permissions, "roles.permissions"),
            is_system: r.is_system,
        }
    }
}

/// `NOT_FOUND` unless role `id` belongs to workspace `ws`.
///
/// Foreign keys ignore row-level security, so `memberships.role_id` alone would accept another
/// workspace's role; every write that sets a role checks it here first.
pub(crate) async fn ensure_in_workspace(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: RoleId,
) -> Result<(), AppError> {
    let found: Option<i32> =
        sqlx::query_scalar("select 1 from roles where id = $1 and workspace_id = $2")
            .bind(id.as_uuid())
            .bind(ws.as_uuid())
            .fetch_optional(conn)
            .await
            .map_err(|e| map_sqlx(e, "find role"))?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such role"))
}

/// Stores the system roles of a newly created workspace, with `is_system` set whatever the
/// input says. A taken key or id is `CONFLICT`; an unknown workspace is `NOT_FOUND`.
pub(crate) async fn create_system(
    tx: &mut UserTx<'_>,
    ws: WorkspaceId,
    roles: &[RoleDef],
) -> Result<(), AppError> {
    for role in roles {
        let done = sqlx::query(
            // archtest: platform-wide
            "insert into roles (id, workspace_id, key, name, permissions, is_system) \
             values ($1, $2, $3, $4, $5, true) on conflict do nothing",
        )
        .bind(role.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(&role.key)
        .bind(&role.name)
        .bind(permission_keys(&role.permissions))
        .execute(tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert system role"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("role key is already taken"));
        }
    }
    Ok(())
}

#[async_trait]
impl RoleRepo for PgTenantRepos {
    async fn list(&mut self) -> Result<Vec<RoleDef>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<RoleRecord> = sqlx::query_as(
            "select id, key, name, permissions, is_system from roles \
             where workspace_id = $1 order by id",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list roles"))?;
        Ok(records.into_iter().map(RoleDef::from).collect())
    }

    async fn find_by_key(&mut self, key: &str) -> Result<Option<RoleDef>, AppError> {
        let ws = self.workspace_id();
        let record: Option<RoleRecord> = sqlx::query_as(
            "select id, key, name, permissions, is_system from roles \
             where workspace_id = $1 and key = $2",
        )
        .bind(ws.as_uuid())
        .bind(key)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find role by key"))?;
        Ok(record.map(RoleDef::from))
    }

    async fn find(&mut self, id: RoleId) -> Result<Option<RoleDef>, AppError> {
        let ws = self.workspace_id();
        let record: Option<RoleRecord> = sqlx::query_as(
            "select id, key, name, permissions, is_system from roles \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find role"))?;
        Ok(record.map(RoleDef::from))
    }

    /// Stores a custom role. A role marked `is_system` is refused with `INTERNAL`: system roles
    /// are created only with their workspace.
    async fn insert(&mut self, role: RoleDef) -> Result<(), AppError> {
        if role.is_system {
            return Err(AppError::internal(
                "system roles are created only with their workspace",
            ));
        }
        let ws = self.workspace_id();
        let done = sqlx::query(
            "insert into roles (id, workspace_id, key, name, permissions, is_system) \
             values ($1, $2, $3, $4, $5, false) on conflict do nothing",
        )
        .bind(role.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(&role.key)
        .bind(&role.name)
        .bind(permission_keys(&role.permissions))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert role"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("role key is already taken"));
        }
        Ok(())
    }

    async fn update_permissions(
        &mut self,
        id: RoleId,
        permissions: BTreeSet<Permission>,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done =
            sqlx::query("update roles set permissions = $3 where workspace_id = $1 and id = $2")
                .bind(ws.as_uuid())
                .bind(id.as_uuid())
                .bind(permission_keys(&permissions))
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "update role permissions"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such role"));
        }
        Ok(())
    }

    async fn delete_custom(&mut self, id: RoleId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        // Locking the role makes a concurrent membership insert referencing it wait for us.
        let is_system: Option<bool> = sqlx::query_scalar(
            "select is_system from roles where workspace_id = $1 and id = $2 for update",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find role"))?;
        match is_system {
            None => return Err(AppError::not_found("no such role")),
            Some(true) => return Err(AppError::forbidden("a system role cannot be deleted")),
            Some(false) => {}
        }
        if self.count_memberships_using(id).await? > 0 {
            return Err(AppError::conflict("the role is still in use"));
        }
        // Removed memberships keep their last role, and the foreign key would refuse the delete
        // while they do: move them to the system `rep` role first. (`team.remove` recorded the
        // role they held in its ledger entry.)
        let rep: Option<Uuid> = sqlx::query_scalar(
            "select id from roles where workspace_id = $1 and key = $2 and is_system",
        )
        .bind(ws.as_uuid())
        .bind(SystemRole::Rep.key())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find the rep role"))?;
        let rep = rep.ok_or_else(|| AppError::internal("the workspace has no system rep role"))?;
        sqlx::query(
            "update memberships set role_id = $3 \
             where workspace_id = $1 and role_id = $2 and status = 'removed'",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(rep)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "move removed memberships to the rep role"))?;
        let deleted =
            sqlx::query("delete from roles where workspace_id = $1 and id = $2 and not is_system")
                .bind(ws.as_uuid())
                .bind(id.as_uuid())
                .execute(self.tx.conn())
                .await;
        match deleted {
            Ok(_) => Ok(()),
            // A membership this transaction cannot see (row-level security) still references it.
            Err(e)
                if e.as_database_error().and_then(|d| d.code()).as_deref()
                    == Some(FOREIGN_KEY_VIOLATION) =>
            {
                Err(AppError::conflict("the role is still in use"))
            }
            Err(e) => Err(map_sqlx(e, "delete role")),
        }
    }

    async fn count_memberships_using(&mut self, id: RoleId) -> Result<i64, AppError> {
        let ws = self.workspace_id();
        sqlx::query_scalar(
            "select count(*) from memberships \
             where workspace_id = $1 and role_id = $2 and status <> 'removed'",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count memberships using role"))
    }
}
