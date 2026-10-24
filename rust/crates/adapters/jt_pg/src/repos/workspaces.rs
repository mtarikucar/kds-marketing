//! `workspaces`: the tenant bundle's own row, the platform-wide reads and status changes, and
//! creation at registration (user bundle).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{WorkspaceRepo, WorkspaceRow};
use jt_tenancy::{Email, SystemRole, WorkspaceId, WorkspaceStatus};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored, stored_email};
use crate::tx::{PlatformTx, UserTx};
use crate::uow::PgTenantRepos;

#[derive(sqlx::FromRow)]
struct WorkspaceRecord {
    id: Uuid,
    name: String,
    slug: String,
    status: String,
    created_at: OffsetDateTime,
}

impl WorkspaceRecord {
    fn into_row(self) -> Result<WorkspaceRow, AppError> {
        Ok(WorkspaceRow {
            id: WorkspaceId(self.id),
            name: self.name,
            slug: self.slug,
            status: stored(WorkspaceStatus::parse(&self.status), "workspaces.status")?,
            created_at: self.created_at,
        })
    }
}

/// Creates a workspace. A taken slug (or id) is `CONFLICT`.
pub(crate) async fn create(
    tx: &mut UserTx<'_>,
    id: WorkspaceId,
    name: &str,
    slug: &str,
    status: WorkspaceStatus,
    created_at: OffsetDateTime,
) -> Result<(), AppError> {
    let done = sqlx::query(
        // archtest: platform-wide
        "insert into workspaces (id, name, slug, status, created_at) \
         values ($1, $2, $3, $4, $5) on conflict do nothing",
    )
    .bind(id.as_uuid())
    .bind(name)
    .bind(slug)
    .bind(status.key())
    .bind(created_at)
    .execute(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "insert workspace"))?;
    if done.rows_affected() == 0 {
        return Err(AppError::conflict("workspace slug is already taken"));
    }
    Ok(())
}

/// Every workspace, oldest first.
pub(crate) async fn list(tx: &mut PlatformTx<'_>) -> Result<Vec<WorkspaceRow>, AppError> {
    let records: Vec<WorkspaceRecord> = sqlx::query_as(
        // archtest: platform-wide
        "select id, name, slug, status, created_at from workspaces order by created_at, id",
    )
    .fetch_all(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "list workspaces"))?;
    records.into_iter().map(WorkspaceRecord::into_row).collect()
}

pub(crate) async fn get(
    tx: &mut PlatformTx<'_>,
    ws: WorkspaceId,
) -> Result<Option<WorkspaceRow>, AppError> {
    let record: Option<WorkspaceRecord> = sqlx::query_as(
        // archtest: platform-wide
        "select id, name, slug, status, created_at from workspaces where id = $1",
    )
    .bind(ws.as_uuid())
    .fetch_optional(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "find workspace"))?;
    record.map(WorkspaceRecord::into_row).transpose()
}

/// Workspace lock shared by tenant activation and platform grant/status writers. NO KEY
/// UPDATE avoids conflicting with unrelated ledger foreign-key KEY SHARE locks.
pub(crate) async fn lock(
    conn: &mut sqlx::PgConnection,
    ws: WorkspaceId,
) -> Result<WorkspaceRow, AppError> {
    let row: Option<WorkspaceRecord> = sqlx::query_as(
        "select id,name,slug,status,created_at from workspaces where id=$1 for no key update",
    )
    .bind(ws.as_uuid())
    .fetch_optional(conn)
    .await
    .map_err(|e| map_sqlx(e, "lock workspace"))?;
    row.ok_or_else(|| AppError::not_found("no such workspace"))?
        .into_row()
}
/// The specified port has no time argument: status audit uses the transaction timestamp.
pub(crate) async fn set_status(
    conn: &mut sqlx::PgConnection,
    ws: WorkspaceId,
    status: WorkspaceStatus,
    reason: &str,
    by: &jt_ledger::Actor,
) -> Result<(), AppError> {
    let row = lock(conn, ws).await?;
    if reason.trim().is_empty() {
        return Err(AppError::validation(
            "reason is required",
            serde_json::json!({"field":"reason"}),
        ));
    }
    if row.status == status {
        return Ok(());
    }
    let at: OffsetDateTime = sqlx::query_scalar("select transaction_timestamp()")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| map_sqlx(e, "status audit time"))?;
    let entry =
        jt_app::usecases::billing::schema::status_entry(ws, row.status, status, reason, by, at)?;
    sqlx::query("update workspaces set status=$2 where id=$1")
        .bind(ws.as_uuid())
        .bind(status.key())
        .execute(&mut *conn)
        .await
        .map_err(|e| map_sqlx(e, "set workspace status"))?;
    super::ledger::insert(conn, &entry).await?;
    Ok(())
}

/// The email of the workspace's oldest active owner.
pub(crate) async fn owner_email(
    tx: &mut PlatformTx<'_>,
    ws: WorkspaceId,
) -> Result<Option<Email>, AppError> {
    let email: Option<String> = sqlx::query_scalar(
        // archtest: platform-wide
        "select u.email from memberships m \
         join roles r on r.id = m.role_id and r.workspace_id = m.workspace_id \
         join users u on u.id = m.user_id \
         where m.workspace_id = $1 and m.status = 'active' and r.is_system and r.key = $2 \
         order by m.created_at, m.id limit 1",
    )
    .bind(ws.as_uuid())
    .bind(SystemRole::Owner.key())
    .fetch_optional(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "find workspace owner"))?;
    email
        .as_deref()
        .map(|e| stored_email(e, "users.email"))
        .transpose()
}

/// Active memberships in the workspace.
pub(crate) async fn member_count(
    tx: &mut PlatformTx<'_>,
    ws: WorkspaceId,
) -> Result<i64, AppError> {
    sqlx::query_scalar(
        // archtest: platform-wide
        "select count(*) from memberships where workspace_id = $1 and status = 'active'",
    )
    .bind(ws.as_uuid())
    .fetch_one(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "count workspace members"))
}

#[async_trait]
impl WorkspaceRepo for PgTenantRepos {
    async fn lock(&mut self) -> Result<WorkspaceRow, AppError> {
        let ws = self.workspace_id();
        lock(self.tx.conn(), ws).await
    }
    async fn set_status(
        &mut self,
        ws: WorkspaceId,
        status: WorkspaceStatus,
        reason: &str,
        by: &jt_ledger::Actor,
    ) -> Result<(), AppError> {
        super::same_workspace(self.workspace_id(), ws)?;
        set_status(self.tx.conn(), ws, status, reason, by).await
    }

    async fn get(&mut self) -> Result<WorkspaceRow, AppError> {
        let ws = self.workspace_id();
        let record: Option<WorkspaceRecord> = sqlx::query_as(
            "select id, name, slug, status, created_at from workspaces where id = $1",
        )
        .bind(ws.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find workspace"))?;
        record
            .ok_or_else(|| AppError::not_found("no such workspace"))?
            .into_row()
    }
}
