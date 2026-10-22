//! `capability_groups` and `capability_group_members`: named sets of the workspace's
//! capabilities.
//!
//! A member row references its group and its capability together with the workspace (composite
//! foreign keys), and member writes check first that both are this workspace's, so another
//! workspace's group or capability is `NOT_FOUND` (Review Focus 3) before a foreign key would
//! refuse it. Deleting a group deletes its member rows with it.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::CapabilityGroupRepo;
use jt_capability::{CapabilityGroup, CapabilityGroupId, CapabilityId};
use jt_tenancy::WorkspaceId;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capabilities::ensure_capability;
use super::{map_sqlx, same_workspace};
use crate::uow::PgTenantRepos;

/// The columns every read selects, with the members gathered in id order. `g` is the groups
/// table.
const COLUMNS: &str = "g.id, g.workspace_id, g.name, g.purpose, \
     array(select m.capability_id from capability_group_members m \
     where m.workspace_id = g.workspace_id and m.group_id = g.id \
     order by m.capability_id) as members";

#[derive(sqlx::FromRow)]
struct GroupRecord {
    id: Uuid,
    workspace_id: Uuid,
    name: String,
    purpose: Option<String>,
    members: Vec<Uuid>,
}

impl GroupRecord {
    fn into_group(self) -> (CapabilityGroup, Vec<CapabilityId>) {
        (
            CapabilityGroup {
                id: CapabilityGroupId(self.id),
                workspace_id: WorkspaceId(self.workspace_id),
                name: self.name,
                purpose: self.purpose,
            },
            self.members.into_iter().map(CapabilityId).collect(),
        )
    }
}

/// `NOT_FOUND` unless group `id` belongs to workspace `ws`.
async fn ensure_group(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: CapabilityGroupId,
) -> Result<(), AppError> {
    let found: Option<i32> =
        sqlx::query_scalar("select 1 from capability_groups where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .fetch_optional(conn)
            .await
            .map_err(|e| map_sqlx(e, "find capability group"))?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such capability group"))
}

#[async_trait]
impl CapabilityGroupRepo for PgTenantRepos {
    /// `on conflict do nothing` covers the id and the name, so a refused group leaves the
    /// transaction usable.
    async fn insert(&mut self, group: CapabilityGroup, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, group.workspace_id)?;
        let done = sqlx::query(
            "insert into capability_groups (id, workspace_id, name, purpose, created_at) \
             values ($1, $2, $3, $4, $5) on conflict do nothing",
        )
        .bind(group.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(&group.name)
        .bind(&group.purpose)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert capability group"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the capability group id or name is already taken",
            ));
        }
        Ok(())
    }

    async fn list(&mut self) -> Result<Vec<(CapabilityGroup, Vec<CapabilityId>)>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<GroupRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from capability_groups g where g.workspace_id = $1 \
             order by g.created_at, g.id"
        ))
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list capability groups"))?;
        Ok(records.into_iter().map(GroupRecord::into_group).collect())
    }

    async fn find(
        &mut self,
        id: CapabilityGroupId,
    ) -> Result<Option<(CapabilityGroup, Vec<CapabilityId>)>, AppError> {
        let ws = self.workspace_id();
        let record: Option<GroupRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from capability_groups g where g.workspace_id = $1 and g.id = $2"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find capability group"))?;
        Ok(record.map(GroupRecord::into_group))
    }

    async fn rename(&mut self, id: CapabilityGroupId, name: &str) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update capability_groups set name = $3 where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(name)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "rename capability group"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such capability group"));
        }
        Ok(())
    }

    async fn delete(&mut self, id: CapabilityGroupId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query("delete from capability_groups where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "remove capability group"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such capability group"));
        }
        Ok(())
    }

    async fn add_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        ensure_group(self.tx.conn(), ws, group).await?;
        ensure_capability(self.tx.conn(), ws, capability).await?;
        sqlx::query(
            "insert into capability_group_members (workspace_id, group_id, capability_id) \
             values ($1, $2, $3) on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(group.as_uuid())
        .bind(capability.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "add capability group member"))?;
        Ok(())
    }

    async fn remove_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "delete from capability_group_members \
             where workspace_id = $1 and group_id = $2 and capability_id = $3",
        )
        .bind(ws.as_uuid())
        .bind(group.as_uuid())
        .bind(capability.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "remove capability group member"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found(
                "the capability is not a member of the group",
            ));
        }
        Ok(())
    }
}
