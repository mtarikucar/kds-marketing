//! `memberships`: invitations and members of a workspace, plus the platform-wide lookup by invite
//! token and the user-level reads and writes of registration and of accepting an invitation.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{MemberOut, MembershipRepo, MembershipRow, MembershipView};
use jt_tenancy::{
    MembershipId, MembershipStatus, RoleId, SystemRole, UserId, WorkspaceId, WorkspaceStatus,
};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use super::roles::ensure_in_workspace;
use super::{dangling, map_sqlx, permissions_from, same_workspace, stored, stored_email};
use crate::tx::{PlatformTx, UserTx};
use crate::uow::PgTenantRepos;

#[derive(sqlx::FromRow)]
struct MembershipRecord {
    id: Uuid,
    workspace_id: Uuid,
    user_id: Option<Uuid>,
    role_id: Uuid,
    status: String,
    invited_email: Option<String>,
    invite_token_hash: Option<String>,
    invite_expires_at: Option<OffsetDateTime>,
    invited_by: Option<Uuid>,
    created_at: OffsetDateTime,
}

impl MembershipRecord {
    fn into_row(self) -> Result<MembershipRow, AppError> {
        Ok(MembershipRow {
            id: MembershipId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            user_id: self.user_id.map(UserId),
            role_id: RoleId(self.role_id),
            status: stored(MembershipStatus::parse(&self.status), "memberships.status")?,
            invited_email: self
                .invited_email
                .as_deref()
                .map(|e| stored_email(e, "memberships.invited_email"))
                .transpose()?,
            invite_token_hash: self.invite_token_hash,
            invite_expires_at: self.invite_expires_at,
            invited_by: self.invited_by.map(UserId),
            created_at: self.created_at,
        })
    }
}

/// A membership joined with its user and role, for the team list.
#[derive(sqlx::FromRow)]
struct MemberRecord {
    membership_id: Uuid,
    user_id: Option<Uuid>,
    user_email: Option<String>,
    display_name: Option<String>,
    invited_email: Option<String>,
    role_key: Option<String>,
    role_name: Option<String>,
    status: String,
    created_at: OffsetDateTime,
}

impl MemberRecord {
    fn into_out(self) -> Result<MemberOut, AppError> {
        let (Some(role_key), Some(role_name)) = (self.role_key, self.role_name) else {
            return Err(dangling("memberships.role_id"));
        };
        let email = match (&self.user_email, &self.invited_email) {
            (Some(user), _) => stored_email(user, "users.email")?,
            (None, Some(invited)) => stored_email(invited, "memberships.invited_email")?,
            (None, None) => {
                return Err(AppError::internal(
                    "a membership has neither user nor email",
                ));
            }
        };
        Ok(MemberOut {
            membership_id: MembershipId(self.membership_id),
            user_id: self.user_id.map(UserId),
            email,
            display_name: self.display_name,
            role_key,
            role_name,
            status: stored(MembershipStatus::parse(&self.status), "memberships.status")?,
            created_at: self.created_at,
        })
    }
}

/// A user's membership joined with its workspace and role.
#[derive(sqlx::FromRow)]
struct MembershipViewRecord {
    membership_id: Uuid,
    workspace_id: Uuid,
    workspace_name: String,
    workspace_slug: String,
    workspace_status: String,
    role_key: Option<String>,
    permissions: Option<Vec<String>>,
}

impl MembershipViewRecord {
    fn into_view(self) -> Result<MembershipView, AppError> {
        let (Some(role_key), Some(permissions)) = (self.role_key, self.permissions) else {
            return Err(dangling("memberships.role_id"));
        };
        Ok(MembershipView {
            membership_id: MembershipId(self.membership_id),
            workspace_id: WorkspaceId(self.workspace_id),
            workspace_name: self.workspace_name,
            workspace_slug: self.workspace_slug,
            workspace_status: stored(
                WorkspaceStatus::parse(&self.workspace_status),
                "workspaces.status",
            )?,
            role_key,
            permissions: permissions_from(permissions, "roles.permissions"),
        })
    }
}

/// The membership whose invite token has this hash, in whichever workspace it belongs to.
pub(crate) async fn find_by_invite_hash(
    tx: &mut PlatformTx<'_>,
    token_hash: &str,
) -> Result<Option<MembershipRow>, AppError> {
    let record: Option<MembershipRecord> = sqlx::query_as(
        // archtest: platform-wide
        "select id, workspace_id, user_id, role_id, status, invited_email, invite_token_hash, \
         invite_expires_at, invited_by, created_at from memberships where invite_token_hash = $1",
    )
    .bind(token_hash)
    .fetch_optional(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "find membership by invite"))?;
    record.map(MembershipRecord::into_row).transpose()
}

/// The user's active memberships across workspaces, oldest first.
pub(crate) async fn of_user(
    tx: &mut UserTx<'_>,
    user_id: UserId,
) -> Result<Vec<MembershipView>, AppError> {
    let records: Vec<MembershipViewRecord> = sqlx::query_as(
        // archtest: platform-wide
        "select m.id as membership_id, m.workspace_id, w.name as workspace_name, \
         w.slug as workspace_slug, w.status as workspace_status, r.key as role_key, \
         r.permissions \
         from memberships m \
         join workspaces w on w.id = m.workspace_id \
         left join roles r on r.id = m.role_id and r.workspace_id = m.workspace_id \
         where m.user_id = $1 and m.status = 'active' \
         order by m.created_at, m.id",
    )
    .bind(user_id.as_uuid())
    .fetch_all(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "list memberships of user"))?;
    records
        .into_iter()
        .map(MembershipViewRecord::into_view)
        .collect()
}

/// Stores an `Active` membership. A role outside `workspace_id` is `NOT_FOUND`; a user who is
/// already a member, or a taken id, is `CONFLICT`.
pub(crate) async fn insert_active(
    tx: &mut UserTx<'_>,
    id: MembershipId,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role_id: RoleId,
    created_at: OffsetDateTime,
) -> Result<(), AppError> {
    ensure_in_workspace(tx.conn(), workspace_id, role_id).await?;
    let done = sqlx::query(
        // archtest: platform-wide
        "insert into memberships (id, workspace_id, user_id, role_id, status, created_at) \
         values ($1, $2, $3, $4, 'active', $5) on conflict do nothing",
    )
    .bind(id.as_uuid())
    .bind(workspace_id.as_uuid())
    .bind(user_id.as_uuid())
    .bind(role_id.as_uuid())
    .bind(created_at)
    .execute(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "insert membership"))?;
    if done.rows_affected() == 0 {
        return Err(AppError::conflict(
            "the user is already a member of this workspace",
        ));
    }
    Ok(())
}

/// Binds the open invitation `id` of workspace `ws` to `user_id` and makes it active, clearing
/// its token hash and expiry; see `MembershipRepo::activate` for the contract.
///
/// Shared by the tenant bundle and the user bundle (accepting an invitation); every statement
/// names the workspace, so it stays scoped under either.
pub(crate) async fn activate(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: MembershipId,
    user_id: UserId,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    let invitation: Option<(String, Option<OffsetDateTime>)> = sqlx::query_as(
        // archtest: platform-wide
        "select status, invite_expires_at from memberships \
         where workspace_id = $1 and id = $2 for update",
    )
    .bind(ws.as_uuid())
    .bind(id.as_uuid())
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| map_sqlx(e, "find membership"))?;
    let Some((status, expires_at)) = invitation else {
        return Err(AppError::not_found("no such membership"));
    };
    let open = status == MembershipStatus::Invited.key() && expires_at.is_some_and(|e| e > at);
    if !open {
        return Err(AppError::conflict(
            "the membership is not an open invitation",
        ));
    }
    let live: Option<i32> = sqlx::query_scalar(
        // archtest: platform-wide
        "select 1 from memberships where workspace_id = $1 and user_id = $2 \
         and status <> 'removed' and id <> $3",
    )
    .bind(ws.as_uuid())
    .bind(user_id.as_uuid())
    .bind(id.as_uuid())
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| map_sqlx(e, "find membership by user"))?;
    if live.is_some() {
        return Err(AppError::conflict(
            "the user is already a member of this workspace",
        ));
    }
    sqlx::query(
        // archtest: platform-wide
        "update memberships set user_id = $3, status = 'active', invite_token_hash = null, \
         invite_expires_at = null where workspace_id = $1 and id = $2",
    )
    .bind(ws.as_uuid())
    .bind(id.as_uuid())
    .bind(user_id.as_uuid())
    .execute(&mut *conn)
    .await
    .map_err(|e| map_sqlx(e, "activate membership"))?;
    Ok(())
}

#[async_trait]
impl MembershipRepo for PgTenantRepos {
    async fn list(&mut self) -> Result<Vec<MemberOut>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<MemberRecord> = sqlx::query_as(
            "select m.id as membership_id, m.user_id, u.email as user_email, u.display_name, \
             m.invited_email, r.key as role_key, r.name as role_name, m.status, m.created_at \
             from memberships m \
             left join roles r on r.id = m.role_id and r.workspace_id = m.workspace_id \
             left join users u on u.id = m.user_id \
             where m.workspace_id = $1 and m.status <> 'removed' \
             order by m.created_at, m.id",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list memberships"))?;
        records.into_iter().map(MemberRecord::into_out).collect()
    }

    async fn find(&mut self, id: MembershipId) -> Result<Option<MembershipRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<MembershipRecord> = sqlx::query_as(
            "select id, workspace_id, user_id, role_id, status, invited_email, invite_token_hash, \
             invite_expires_at, invited_by, created_at from memberships \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find membership"))?;
        record.map(MembershipRecord::into_row).transpose()
    }

    async fn find_by_user(&mut self, user_id: UserId) -> Result<Option<MembershipRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<MembershipRecord> = sqlx::query_as(
            "select id, workspace_id, user_id, role_id, status, invited_email, invite_token_hash, \
             invite_expires_at, invited_by, created_at from memberships \
             where workspace_id = $1 and user_id = $2 and status <> 'removed'",
        )
        .bind(ws.as_uuid())
        .bind(user_id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find membership by user"))?;
        record.map(MembershipRecord::into_row).transpose()
    }

    async fn insert_invite(&mut self, row: MembershipRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        ensure_in_workspace(self.tx.conn(), ws, row.role_id).await?;
        let done = sqlx::query(
            "insert into memberships (id, workspace_id, user_id, role_id, status, invited_email, \
             invite_token_hash, invite_expires_at, invited_by, created_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing",
        )
        .bind(row.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(row.user_id.map(|u| u.as_uuid()))
        .bind(row.role_id.as_uuid())
        .bind(row.status.key())
        .bind(row.invited_email.as_ref().map(|e| e.as_str()))
        .bind(&row.invite_token_hash)
        .bind(row.invite_expires_at)
        .bind(row.invited_by.map(|u| u.as_uuid()))
        .bind(row.created_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert invitation"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the membership id, invite token or member is already taken",
            ));
        }
        Ok(())
    }

    async fn activate(
        &mut self,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        activate(self.tx.conn(), ws, id, user_id, at).await
    }

    async fn set_role(&mut self, id: MembershipId, role_id: RoleId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        ensure_in_workspace(self.tx.conn(), ws, role_id).await?;
        let done =
            sqlx::query("update memberships set role_id = $3 where workspace_id = $1 and id = $2")
                .bind(ws.as_uuid())
                .bind(id.as_uuid())
                .bind(role_id.as_uuid())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "set membership role"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such membership"));
        }
        Ok(())
    }

    async fn remove(&mut self, id: MembershipId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update memberships set status = 'removed' where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "remove membership"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such membership"));
        }
        Ok(())
    }

    /// Locks the active owner memberships (`for update of m`) until the transaction ends, then
    /// counts them.
    async fn count_active_owners(&mut self) -> Result<i64, AppError> {
        let ws = self.workspace_id();
        let owners: Vec<Uuid> = sqlx::query_scalar(
            "select m.id from memberships m \
             join roles r on r.id = m.role_id and r.workspace_id = m.workspace_id \
             where m.workspace_id = $1 and m.status = 'active' and r.is_system and r.key = $2 \
             for update of m",
        )
        .bind(ws.as_uuid())
        .bind(SystemRole::Owner.key())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count active owners"))?;
        i64::try_from(owners.len()).map_err(|_| AppError::internal("too many owners to count"))
    }
}
