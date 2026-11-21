//! The inbox's automatic replies (migration `0047_inbox_auto_reply`): `auto_reply_queue`, the
//! debounced work list (one row per conversation), and `auto_reply_runs`, one row per model call
//! with codes and numbers only. `workspaces_with_due_auto_replies` is the one platform-wide read.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::reply_model::{AutoReplyRepo, QueueRow, RunRow, Usage};
use jt_capability::CapabilityId;
use jt_inbox::ConversationId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{FOREIGN_KEY_VIOLATION, dangling, map_sqlx};
use crate::tx::PlatformTx;
use crate::uow::PgTenantRepos;

/// What [`QueueRow::takeable`] says, in SQL: due and not held, or held by a run whose lease ran
/// out. `$1` is now.
const TAKEABLE: &str = "((due_at is not null and due_at <= $1 and (lease_until is null or \
     lease_until <= $1)) or (due_at is null and lease_until is not null and lease_until <= $1))";

/// The workspaces with a conversation a run may take at `now`, in id order (see
/// `PlatformRepos::workspaces_with_due_auto_replies`).
pub(crate) async fn workspaces_with_due_auto_replies(
    tx: &mut PlatformTx<'_>,
    now: OffsetDateTime,
) -> Result<Vec<WorkspaceId>, AppError> {
    let sql = format!(
        // archtest: platform-wide
        "select distinct q.workspace_id from auto_reply_queue q where {TAKEABLE} order by q.workspace_id"
    );
    let ids: Vec<Uuid> = sqlx::query_scalar(&sql)
        .bind(now)
        .fetch_all(tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list workspaces with a due automatic reply"))?;
    Ok(ids.into_iter().map(WorkspaceId).collect())
}

#[derive(sqlx::FromRow)]
struct QueueRecord {
    conversation_id: Uuid,
    first_at: OffsetDateTime,
    due_at: Option<OffsetDateTime>,
    lease_until: Option<OffsetDateTime>,
    attempts: i32,
}

impl QueueRecord {
    fn into_row(self) -> Result<QueueRow, AppError> {
        Ok(QueueRow {
            conversation_id: ConversationId::from(self.conversation_id),
            first_at: self.first_at,
            due_at: self.due_at,
            lease_until: self.lease_until,
            attempts: u32::try_from(self.attempts)
                .map_err(|_| AppError::internal("stored attempts are negative"))?,
        })
    }
}

/// A token count as stored.
fn tokens(n: u64) -> Result<i64, AppError> {
    i64::try_from(n).map_err(|_| AppError::internal("a token count is out of range"))
}

#[async_trait]
impl AutoReplyRepo for PgTenantRepos {
    async fn queue_lock(&mut self, id: ConversationId) -> Result<Option<QueueRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<QueueRecord> = sqlx::query_as(
            "select conversation_id, first_at, due_at, lease_until, attempts from \
             auto_reply_queue where workspace_id = $1 and conversation_id = $2 for update",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock an automatic reply's queue row"))?;
        record.map(QueueRecord::into_row).transpose()
    }

    async fn queue_save(&mut self, row: &QueueRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let attempts = i32::try_from(row.attempts)
            .map_err(|_| AppError::internal("attempts are out of range"))?;
        sqlx::query(
            "insert into auto_reply_queue (workspace_id, conversation_id, first_at, due_at, \
             lease_until, attempts) values ($1, $2, $3, $4, $5, $6) \
             on conflict (workspace_id, conversation_id) do update set first_at = excluded.first_at, \
             due_at = excluded.due_at, lease_until = excluded.lease_until, \
             attempts = excluded.attempts",
        )
        .bind(ws.as_uuid())
        .bind(row.conversation_id.as_uuid())
        .bind(row.first_at)
        .bind(row.due_at)
        .bind(row.lease_until)
        .bind(attempts)
        .execute(self.tx.conn())
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.code().as_deref() == Some(FOREIGN_KEY_VIOLATION) => {
                dangling("auto_reply_queue.conversation_id")
            }
            _ => map_sqlx(e, "save an automatic reply's queue row"),
        })?;
        Ok(())
    }

    async fn queue_delete(&mut self, id: ConversationId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query(
            "delete from auto_reply_queue where workspace_id = $1 and conversation_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "remove an automatic reply's queue row"))?;
        Ok(())
    }

    async fn queue_takeable(
        &mut self,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ConversationId>, AppError> {
        let ws = self.workspace_id();
        let sql = format!(
            "select conversation_id from auto_reply_queue where workspace_id = $2 and {TAKEABLE} \
             order by greatest(coalesce(due_at, lease_until), coalesce(lease_until, due_at)), \
             conversation_id limit $3"
        );
        let ids: Vec<Uuid> = sqlx::query_scalar(&sql)
            .bind(now)
            .bind(ws.as_uuid())
            .bind(i64::from(limit))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list the due automatic replies"))?;
        Ok(ids.into_iter().map(ConversationId::from).collect())
    }

    async fn run_insert(&mut self, run: &RunRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let Usage {
            input_tokens,
            output_tokens,
            cache_write_tokens,
            cache_read_tokens,
            cost_micro_usd,
        } = run.usage;
        let done = sqlx::query(
            "insert into auto_reply_runs (workspace_id, id, conversation_id, capability_id, at, \
             model, outcome, reason, input_tokens, output_tokens, cache_write_tokens, \
             cache_read_tokens, cost_micro_usd, outbox_id, quote_id) values ($1, $2, $3, $4, $5, \
             $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(run.id)
        .bind(run.conversation_id.as_uuid())
        .bind(run.capability_id.as_uuid())
        .bind(run.at)
        .bind(&run.model)
        .bind(run.outcome.key())
        .bind(run.reason.as_deref())
        .bind(tokens(input_tokens)?)
        .bind(tokens(output_tokens)?)
        .bind(tokens(cache_write_tokens)?)
        .bind(tokens(cache_read_tokens)?)
        .bind(cost_micro_usd)
        .bind(run.outbox_id)
        .bind(run.quote_id)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store an automatic reply's run"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("duplicate automatic reply run"));
        }
        Ok(())
    }

    async fn runs_sent_since(
        &mut self,
        conversation: Option<ConversationId>,
        capability: Option<CapabilityId>,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from auto_reply_runs where workspace_id = $1 and at >= $2 \
             and outcome in ('replied', 'quoted') \
             and ($3::uuid is null or conversation_id = $3) \
             and ($4::uuid is null or capability_id = $4)",
        )
        .bind(ws.as_uuid())
        .bind(since)
        .bind(conversation.map(|c| c.as_uuid()))
        .bind(capability.map(|c| c.as_uuid()))
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count the automatic replies sent"))?;
        u32::try_from(n).map_err(|_| AppError::internal("a count is out of range"))
    }

    async fn runs_spend_since(&mut self, since: OffsetDateTime) -> Result<i64, AppError> {
        let ws = self.workspace_id();
        let n: Option<i64> = sqlx::query_scalar(
            "select sum(cost_micro_usd)::bigint from auto_reply_runs where workspace_id = $1 \
             and at >= $2",
        )
        .bind(ws.as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "sum the automatic replies' cost"))?;
        Ok(n.unwrap_or(0))
    }
}
