//! `sessions`: panel login sessions, reached through the user bundle. Not a tenant table; its
//! `current_workspace_id` is only a pointer.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{SessionRepo, SessionRow};
use jt_tenancy::{SessionId, UserId, WorkspaceId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::map_sqlx;
use crate::uow::PgUserRepos;

#[derive(sqlx::FromRow)]
struct SessionRecord {
    id: Uuid,
    user_id: Uuid,
    token_hash: String,
    current_workspace_id: Option<Uuid>,
    created_at: OffsetDateTime,
    expires_at: OffsetDateTime,
    revoked_at: Option<OffsetDateTime>,
}

impl From<SessionRecord> for SessionRow {
    fn from(r: SessionRecord) -> SessionRow {
        SessionRow {
            id: SessionId(r.id),
            user_id: UserId(r.user_id),
            token_hash: r.token_hash,
            current_workspace_id: r.current_workspace_id.map(WorkspaceId),
            created_at: r.created_at,
            expires_at: r.expires_at,
            revoked_at: r.revoked_at,
        }
    }
}

#[async_trait]
impl SessionRepo for PgUserRepos {
    async fn insert(&mut self, row: SessionRow) -> Result<(), AppError> {
        let done = sqlx::query(
            "insert into sessions \
             (id, user_id, token_hash, current_workspace_id, created_at, expires_at, revoked_at) \
             values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing",
        )
        .bind(row.id.as_uuid())
        .bind(row.user_id.as_uuid())
        .bind(&row.token_hash)
        .bind(row.current_workspace_id.map(|w| w.as_uuid()))
        .bind(row.created_at)
        .bind(row.expires_at)
        .bind(row.revoked_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert session"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("session token is already taken"));
        }
        Ok(())
    }

    async fn find_by_token_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<SessionRow>, AppError> {
        let record: Option<SessionRecord> = sqlx::query_as(
            "select id, user_id, token_hash, current_workspace_id, created_at, expires_at, \
             revoked_at from sessions where token_hash = $1",
        )
        .bind(token_hash)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find session"))?;
        Ok(record.map(SessionRow::from))
    }

    async fn revoke(&mut self, id: SessionId, at: OffsetDateTime) -> Result<(), AppError> {
        sqlx::query("update sessions set revoked_at = $2 where id = $1 and revoked_at is null")
            .bind(id.as_uuid())
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "revoke session"))?;
        Ok(())
    }

    async fn revoke_all_for_workspace(
        &mut self,
        user_id: UserId,
        workspace_id: WorkspaceId,
        now: OffsetDateTime,
    ) -> Result<(), AppError> {
        sqlx::query(
            "update sessions set revoked_at = $3 \
             where user_id = $1 and current_workspace_id = $2 \
             and revoked_at is null and expires_at > $3",
        )
        .bind(user_id.as_uuid())
        .bind(workspace_id.as_uuid())
        .bind(now)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "revoke sessions"))?;
        Ok(())
    }

    async fn set_current_workspace(
        &mut self,
        id: SessionId,
        ws: Option<WorkspaceId>,
    ) -> Result<(), AppError> {
        sqlx::query("update sessions set current_workspace_id = $2 where id = $1")
            .bind(id.as_uuid())
            .bind(ws.map(|w| w.as_uuid()))
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "set current workspace"))?;
        Ok(())
    }
}
