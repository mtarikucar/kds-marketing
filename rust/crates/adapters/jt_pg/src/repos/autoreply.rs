//! The inbox's automatic replies (migration `0047_inbox_auto_reply`): `auto_reply_queue`, the
//! debounced work list (one row per conversation), and `auto_reply_runs`, one row per model call
//! with codes and numbers only. `workspaces_with_due_auto_replies` is the one platform-wide read.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::reply_model::{AutoReplyRepo, QueueRow, RunOutcome, RunRow, Usage};
use jt_capability::CapabilityId;
use jt_inbox::ConversationId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored};
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
    handed_back_at: Option<OffsetDateTime>,
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
            handed_back_at: self.handed_back_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct RunRecord {
    id: Uuid,
    conversation_id: Uuid,
    capability_id: Uuid,
    at: OffsetDateTime,
    model: String,
    outcome: String,
    reason: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_write_tokens: i64,
    cache_read_tokens: i64,
    cost_micro_usd: i64,
    outbox_id: Option<Uuid>,
    quote_id: Option<Uuid>,
}

impl RunRecord {
    fn into_run(self) -> Result<RunRow, AppError> {
        let count = |n: i64| {
            u64::try_from(n).map_err(|_| AppError::internal("a stored token count is negative"))
        };
        Ok(RunRow {
            id: self.id,
            conversation_id: ConversationId::from(self.conversation_id),
            capability_id: CapabilityId(self.capability_id),
            at: self.at,
            model: self.model,
            outcome: stored(RunOutcome::parse(&self.outcome), "auto_reply_runs.outcome")?,
            reason: self.reason,
            usage: Usage {
                input_tokens: count(self.input_tokens)?,
                output_tokens: count(self.output_tokens)?,
                cache_write_tokens: count(self.cache_write_tokens)?,
                cache_read_tokens: count(self.cache_read_tokens)?,
                cost_micro_usd: self.cost_micro_usd,
            },
            outbox_id: self.outbox_id,
            quote_id: self.quote_id,
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
            "select conversation_id, first_at, due_at, lease_until, attempts, handed_back_at from \
             auto_reply_queue where workspace_id = $1 and conversation_id = $2 for update",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock an automatic reply's queue row"))?;
        record.map(QueueRecord::into_row).transpose()
    }

    async fn queue_get(&mut self, id: ConversationId) -> Result<Option<QueueRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<QueueRecord> = sqlx::query_as(
            "select conversation_id, first_at, due_at, lease_until, attempts, handed_back_at from \
             auto_reply_queue where workspace_id = $1 and conversation_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read an automatic reply's queue row"))?;
        record.map(QueueRecord::into_row).transpose()
    }

    async fn queue_save(&mut self, row: &QueueRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let attempts = i32::try_from(row.attempts)
            .map_err(|_| AppError::internal("attempts are out of range"))?;
        sqlx::query(
            "insert into auto_reply_queue (workspace_id, conversation_id, first_at, due_at, \
             lease_until, attempts, handed_back_at) values ($1, $2, $3, $4, $5, $6, $7) \
             on conflict (workspace_id, conversation_id) do update set first_at = excluded.first_at, \
             due_at = excluded.due_at, lease_until = excluded.lease_until, \
             attempts = excluded.attempts, handed_back_at = excluded.handed_back_at",
        )
        .bind(ws.as_uuid())
        .bind(row.conversation_id.as_uuid())
        .bind(row.first_at)
        .bind(row.due_at)
        .bind(row.lease_until)
        .bind(attempts)
        .bind(row.handed_back_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save an automatic reply's queue row"))?;
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

    async fn run_update(&mut self, run: &RunRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let u = run.usage;
        let done = sqlx::query(
            "update auto_reply_runs set outcome = $3, reason = $4, input_tokens = $5, \
             output_tokens = $6, cache_write_tokens = $7, cache_read_tokens = $8, \
             cost_micro_usd = $9, outbox_id = $10, quote_id = $11 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(run.id)
        .bind(run.outcome.key())
        .bind(run.reason.as_deref())
        .bind(tokens(u.input_tokens)?)
        .bind(tokens(u.output_tokens)?)
        .bind(tokens(u.cache_write_tokens)?)
        .bind(tokens(u.cache_read_tokens)?)
        .bind(u.cost_micro_usd)
        .bind(run.outbox_id)
        .bind(run.quote_id)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update an automatic reply's run"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such automatic reply run"));
        }
        Ok(())
    }

    async fn run_by_quote(&mut self, quote: Uuid) -> Result<Option<RunRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<RunRecord> = sqlx::query_as(
            "select id, conversation_id, capability_id, at, model, outcome, reason, input_tokens, \
             output_tokens, cache_write_tokens, cache_read_tokens, cost_micro_usd, outbox_id, \
             quote_id from auto_reply_runs where workspace_id = $1 and quote_id = $2 \
             order by at limit 1",
        )
        .bind(ws.as_uuid())
        .bind(quote)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read an automatic quote's run"))?;
        record.map(RunRecord::into_run).transpose()
    }

    async fn runs_since(
        &mut self,
        conversation: Option<ConversationId>,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from auto_reply_runs where workspace_id = $1 and at >= $2 \
             and ($3::uuid is null or conversation_id = $3)",
        )
        .bind(ws.as_uuid())
        .bind(since)
        .bind(conversation.map(|c| c.as_uuid()))
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count the automatic replies' model calls"))?;
        u32::try_from(n).map_err(|_| AppError::internal("a count is out of range"))
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
