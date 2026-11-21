//! The owner's email notices (migration `0049_owner_notices`): codes and ids only.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::notices::{NoticeKind, NoticeRepo, NoticeRow, NoticeState};
use jt_capability::CapabilityId;
use jt_inbox::ConversationId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored};
use crate::uow::PgTenantRepos;

const COLUMNS: &str = "id, kind, conversation_id, dedupe_key, reason, created_at, state, attempts, \
     next_at, sent_at, mailbox_capability_id";

#[derive(sqlx::FromRow)]
struct NoticeRecord {
    id: Uuid,
    kind: String,
    conversation_id: Uuid,
    dedupe_key: String,
    reason: Option<String>,
    created_at: OffsetDateTime,
    state: String,
    attempts: i32,
    next_at: Option<OffsetDateTime>,
    sent_at: Option<OffsetDateTime>,
    mailbox_capability_id: Option<Uuid>,
}

impl NoticeRecord {
    fn into_row(self) -> Result<NoticeRow, AppError> {
        Ok(NoticeRow {
            id: self.id,
            kind: stored(NoticeKind::parse(&self.kind), "owner_notices.kind")?,
            conversation_id: ConversationId::from(self.conversation_id),
            dedupe_key: self.dedupe_key,
            reason: self.reason,
            created_at: self.created_at,
            state: stored(NoticeState::parse(&self.state), "owner_notices.state")?,
            attempts: u32::try_from(self.attempts)
                .map_err(|_| AppError::internal("stored attempts are negative"))?,
            next_at: self.next_at,
            sent_at: self.sent_at,
            mailbox_capability_id: self.mailbox_capability_id.map(CapabilityId),
        })
    }
}

fn attempts(row: &NoticeRow) -> Result<i32, AppError> {
    i32::try_from(row.attempts).map_err(|_| AppError::internal("attempts are out of range"))
}

#[async_trait]
impl NoticeRepo for PgTenantRepos {
    async fn insert(&mut self, row: &NoticeRow) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "insert into owner_notices (workspace_id, id, kind, conversation_id, dedupe_key, \
             reason, created_at, state, attempts, next_at, sent_at, mailbox_capability_id) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             on conflict (workspace_id, dedupe_key) do nothing",
        )
        .bind(ws.as_uuid())
        .bind(row.id)
        .bind(row.kind.key())
        .bind(row.conversation_id.as_uuid())
        .bind(&row.dedupe_key)
        .bind(&row.reason)
        .bind(row.created_at)
        .bind(row.state.key())
        .bind(attempts(row)?)
        .bind(row.next_at)
        .bind(row.sent_at)
        .bind(row.mailbox_capability_id.map(|c| c.as_uuid()))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store an owner notice"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn count_since(&mut self, since: OffsetDateTime) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from owner_notices where workspace_id = $1 and created_at >= $2 \
             and state <> 'skipped'",
        )
        .bind(ws.as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count owner notices"))?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn get(&mut self, id: Uuid) -> Result<Option<NoticeRow>, AppError> {
        let ws = self.workspace_id();
        let sql =
            format!("select {COLUMNS} from owner_notices where workspace_id = $1 and id = $2");
        let record: Option<NoticeRecord> = sqlx::query_as(&sql)
            .bind(ws.as_uuid())
            .bind(id)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read an owner notice"))?;
        record.map(NoticeRecord::into_row).transpose()
    }

    async fn lock(&mut self, id: Uuid) -> Result<Option<NoticeRow>, AppError> {
        let ws = self.workspace_id();
        let sql = format!(
            "select {COLUMNS} from owner_notices where workspace_id = $1 and id = $2 for update"
        );
        let record: Option<NoticeRecord> = sqlx::query_as(&sql)
            .bind(ws.as_uuid())
            .bind(id)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "lock an owner notice"))?;
        record.map(NoticeRecord::into_row).transpose()
    }

    async fn save(&mut self, row: &NoticeRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update owner_notices set state = $3, attempts = $4, next_at = $5, sent_at = $6, \
             mailbox_capability_id = $7 where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(row.id)
        .bind(row.state.key())
        .bind(attempts(row)?)
        .bind(row.next_at)
        .bind(row.sent_at)
        .bind(row.mailbox_capability_id.map(|c| c.as_uuid()))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save an owner notice"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such notice"));
        }
        Ok(())
    }

    async fn due(&mut self, now: OffsetDateTime, limit: u32) -> Result<Vec<Uuid>, AppError> {
        let ws = self.workspace_id();
        sqlx::query_scalar(
            "select id from owner_notices where workspace_id = $1 and state = 'queued' \
             and (next_at is null or next_at <= $2) order by created_at, id limit $3",
        )
        .bind(ws.as_uuid())
        .bind(now)
        .bind(i64::from(limit.clamp(1, 100)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list due owner notices"))
    }

    async fn settle_sending(&mut self, before: OffsetDateTime) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update owner_notices set state = 'sent' where workspace_id = $1 \
             and state = 'sending' and sent_at < $2",
        )
        .bind(ws.as_uuid())
        .bind(before)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "settle owner notices left sending"))?;
        Ok(u32::try_from(done.rows_affected()).unwrap_or(u32::MAX))
    }
}

/// The workspaces with an owner's notice to send at `now` (a queued one due, or one left
/// `sending`), in id order (see `PlatformRepos::workspaces_with_due_notices`).
pub(crate) async fn workspaces_with_due_notices(
    tx: &mut crate::tx::PlatformTx<'_>,
    now: OffsetDateTime,
) -> Result<Vec<jt_tenancy::WorkspaceId>, AppError> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        // archtest: platform-wide
        "select distinct n.workspace_id from owner_notices n where (n.state = 'queued' and \
         (n.next_at is null or n.next_at <= $1)) or n.state = 'sending' order by n.workspace_id",
    )
    .bind(now)
    .fetch_all(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "list workspaces with owner notices to send"))?;
    Ok(ids.into_iter().map(jt_tenancy::WorkspaceId).collect())
}
