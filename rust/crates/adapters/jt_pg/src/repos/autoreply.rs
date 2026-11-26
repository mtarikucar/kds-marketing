//! The inbox's automatic replies (migration `0047_inbox_auto_reply`): `auto_reply_queue`, the
//! debounced work list (one row per conversation), and `auto_reply_runs`, one row per model call
//! with codes and numbers only; and (migration `0050_auto_reply_orders`) `auto_reply_orders`, the
//! orders they asked of the workspace's shop (codes, amounts, the shop's reference and link: no
//! customer details). `workspaces_with_due_auto_replies` is the one platform-wide read.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::reply_model::{
    AutoReplyRepo, OrderRow, OrderState, OwnerItem, QueueRow, RunOutcome, RunRow, Usage,
};
use jt_capability::CapabilityId;
use jt_inbox::{ConversationId, JourneyId, TaskId};
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

/// The workspaces whose automatic replies are on, in id order (see
/// `PlatformRepos::workspaces_with_auto_reply`).
pub(crate) async fn workspaces_with_auto_reply(
    tx: &mut PlatformTx<'_>,
) -> Result<Vec<WorkspaceId>, AppError> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        // archtest: platform-wide
        "select s.workspace_id from knowledge_settings s where s.auto_reply is not null and jsonb_typeof(s.auto_reply -> 'capability_ids') = 'array' and jsonb_array_length(s.auto_reply -> 'capability_ids') > 0 order by s.workspace_id",
    )
    .fetch_all(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "list workspaces with automatic replies"))?;
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
    handled_at: Option<OffsetDateTime>,
    auto_handed_generation: Option<i64>,
    auto_handed_at: Option<OffsetDateTime>,
    told_at: Option<OffsetDateTime>,
    told_reason: Option<String>,
    line_told_at: Option<OffsetDateTime>,
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
            handled_at: self.handled_at,
            auto_handed_generation: self
                .auto_handed_generation
                .map(|g| {
                    u32::try_from(g)
                        .map_err(|_| AppError::internal("stored generation is out of range"))
                })
                .transpose()?,
            auto_handed_at: self.auto_handed_at,
            told_at: self.told_at,
            told_reason: self.told_reason,
            line_told_at: self.line_told_at,
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

const ORDER_COLUMNS: &str = "id, journey_id, conversation_id, quote_id, shop_capability_id, \
     run_id, state, reason, amount_minor, currency, reference, pay_url, created_at, finished_at, \
     confirm_hash, summary_outbox_id, summaries, called_at, generation";

#[derive(sqlx::FromRow)]
struct OrderRecord {
    id: Uuid,
    journey_id: Uuid,
    conversation_id: Uuid,
    quote_id: Uuid,
    shop_capability_id: Uuid,
    run_id: Uuid,
    state: String,
    reason: Option<String>,
    amount_minor: i64,
    currency: String,
    reference: Option<String>,
    pay_url: Option<String>,
    created_at: OffsetDateTime,
    finished_at: Option<OffsetDateTime>,
    confirm_hash: Option<String>,
    summary_outbox_id: Option<Uuid>,
    summaries: i32,
    called_at: Option<OffsetDateTime>,
    generation: Option<i32>,
}

impl OrderRecord {
    fn into_row(self) -> Result<OrderRow, AppError> {
        Ok(OrderRow {
            id: self.id,
            journey_id: JourneyId::from(self.journey_id),
            conversation_id: ConversationId::from(self.conversation_id),
            quote_id: self.quote_id,
            shop_capability_id: CapabilityId(self.shop_capability_id),
            run_id: self.run_id,
            state: stored(OrderState::parse(&self.state), "auto_reply_orders.state")?,
            reason: self.reason,
            amount_minor: self.amount_minor,
            currency: self.currency,
            reference: self.reference,
            pay_url: self.pay_url,
            created_at: self.created_at,
            finished_at: self.finished_at,
            confirm_hash: self.confirm_hash,
            summary_outbox_id: self.summary_outbox_id,
            summaries: u32::try_from(self.summaries)
                .map_err(|_| AppError::internal("stored summaries are negative"))?,
            called_at: self.called_at,
            generation: self
                .generation
                .map(u32::try_from)
                .transpose()
                .map_err(|_| AppError::internal("a stored generation is negative"))?,
        })
    }
}

/// An order's summaries and generation as stored.
fn order_counts(row: &OrderRow) -> Result<(i32, Option<i32>), AppError> {
    let summaries =
        i32::try_from(row.summaries).map_err(|_| AppError::internal("summaries out of range"))?;
    let generation = row
        .generation
        .map(i32::try_from)
        .transpose()
        .map_err(|_| AppError::internal("generation out of range"))?;
    Ok((summaries, generation))
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
            "select conversation_id, first_at, due_at, lease_until, attempts, handed_back_at, \
             handled_at, auto_handed_generation, auto_handed_at, told_at, told_reason, \
             line_told_at from auto_reply_queue where workspace_id = $1 and conversation_id = $2 for update",
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
            "select conversation_id, first_at, due_at, lease_until, attempts, handed_back_at, \
             handled_at, auto_handed_generation, auto_handed_at, told_at, told_reason, \
             line_told_at from auto_reply_queue where workspace_id = $1 and conversation_id = $2",
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
             lease_until, attempts, handed_back_at, handled_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8) \
             on conflict (workspace_id, conversation_id) do update set first_at = excluded.first_at, \
             due_at = excluded.due_at, lease_until = excluded.lease_until, \
             attempts = excluded.attempts, handed_back_at = excluded.handed_back_at, \
             handled_at = excluded.handled_at",
        )
        .bind(ws.as_uuid())
        .bind(row.conversation_id.as_uuid())
        .bind(row.first_at)
        .bind(row.due_at)
        .bind(row.lease_until)
        .bind(attempts)
        .bind(row.handed_back_at)
        .bind(row.handled_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save an automatic reply's queue row"))?;
        Ok(())
    }

    async fn handover_mark(
        &mut self,
        id: ConversationId,
        generation: Option<u32>,
        at: OffsetDateTime,
        told: Option<&str>,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query(
            "insert into auto_reply_queue (workspace_id, conversation_id, first_at, attempts, \
             auto_handed_generation, auto_handed_at, told_at, told_reason) \
             values ($1, $2, $4, 0, $3, $4, case when $5::text is not null then $4 end, $5) \
             on conflict (workspace_id, conversation_id) do update set \
             auto_handed_generation = excluded.auto_handed_generation, \
             auto_handed_at = excluded.auto_handed_at, \
             told_at = case when $5::text is not null then $4 else auto_reply_queue.told_at end, \
             told_reason = coalesce($5, auto_reply_queue.told_reason)",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(generation.map(i64::from))
        .bind(at)
        .bind(told)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "mark an automatic hand-over"))?;
        Ok(())
    }

    async fn told_clear(&mut self, id: ConversationId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query(
            "update auto_reply_queue set told_at = null, told_reason = null, \
             line_told_at = null where workspace_id = $1 and conversation_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "forget a hand-over's notice"))?;
        Ok(())
    }

    async fn line_told(&mut self, id: ConversationId, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query(
            "update auto_reply_queue set line_told_at = $3 \
             where workspace_id = $1 and conversation_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "record a hand-over's line"))?;
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

    async fn queue_unscheduled(
        &mut self,
        capabilities: &[(CapabilityId, OffsetDateTime)],
        newer_than: OffsetDateTime,
        older_than: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ConversationId>, AppError> {
        let ws = self.workspace_id();
        let caps: Vec<Uuid> = capabilities.iter().map(|(c, _)| c.as_uuid()).collect();
        let since: Vec<OffsetDateTime> = capabilities.iter().map(|(_, at)| *at).collect();
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "select c.id from unnest($2::uuid[], $3::timestamptz[]) as s(capability_id, since) \
             join conversations c on c.workspace_id = $1 and c.capability_id = s.capability_id \
             and c.state = 'ours' and c.executor_kind = 'agent' \
             and c.last_inbound_at >= greatest(s.since, $4) and c.last_inbound_at <= $5 \
             left join auto_reply_queue q on q.workspace_id = $1 and q.conversation_id = c.id \
             where q.conversation_id is null or (q.due_at is null and q.lease_until is null \
             and (q.handled_at is null or q.handled_at < c.last_inbound_at)) \
             order by c.last_inbound_at, c.id limit $6",
        )
        .bind(ws.as_uuid())
        .bind(&caps)
        .bind(&since)
        .bind(newer_than)
        .bind(older_than)
        .bind(i64::from(limit))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list the unscheduled customer messages"))?;
        Ok(ids.into_iter().map(ConversationId::from).collect())
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
             and outcome in ('replied', 'quoted', 'ordered') \
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

    async fn runs_with_reason(
        &mut self,
        conversation: ConversationId,
        reason: &str,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from auto_reply_runs where workspace_id = $1 and conversation_id = $2 \
             and reason = $3 and at >= $4",
        )
        .bind(ws.as_uuid())
        .bind(conversation.as_uuid())
        .bind(reason)
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count the automatic replies' runs by reason"))?;
        u32::try_from(n).map_err(|_| AppError::internal("a count is out of range"))
    }

    async fn order_insert(&mut self, row: &OrderRow) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        let (summaries, generation) = order_counts(row)?;
        let done = sqlx::query(
            "insert into auto_reply_orders (workspace_id, id, journey_id, conversation_id, \
             quote_id, shop_capability_id, run_id, state, reason, amount_minor, currency, \
             reference, pay_url, created_at, finished_at, confirm_hash, summary_outbox_id, \
             summaries, called_at, generation) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(row.id)
        .bind(row.journey_id.as_uuid())
        .bind(row.conversation_id.as_uuid())
        .bind(row.quote_id)
        .bind(row.shop_capability_id.as_uuid())
        .bind(row.run_id)
        .bind(row.state.key())
        .bind(row.reason.as_deref())
        .bind(row.amount_minor)
        .bind(&row.currency)
        .bind(row.reference.as_deref())
        .bind(row.pay_url.as_deref())
        .bind(row.created_at)
        .bind(row.finished_at)
        .bind(row.confirm_hash.as_deref())
        .bind(row.summary_outbox_id)
        .bind(summaries)
        .bind(row.called_at)
        .bind(generation)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store an automatic reply's order"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn order_by_journey(&mut self, journey: JourneyId) -> Result<Option<OrderRow>, AppError> {
        let ws = self.workspace_id();
        let sql = format!(
            "select {ORDER_COLUMNS} from auto_reply_orders where workspace_id = $1 and journey_id = $2"
        );
        let record: Option<OrderRecord> = sqlx::query_as(&sql)
            .bind(ws.as_uuid())
            .bind(journey.as_uuid())
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read a journey's order"))?;
        record.map(OrderRecord::into_row).transpose()
    }

    async fn order_get(&mut self, id: Uuid) -> Result<Option<OrderRow>, AppError> {
        let ws = self.workspace_id();
        let sql = format!(
            "select {ORDER_COLUMNS} from auto_reply_orders where workspace_id = $1 and id = $2"
        );
        let record: Option<OrderRecord> = sqlx::query_as(&sql)
            .bind(ws.as_uuid())
            .bind(id)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read an automatic reply's order"))?;
        record.map(OrderRecord::into_row).transpose()
    }

    async fn order_lock(&mut self, id: Uuid) -> Result<Option<OrderRow>, AppError> {
        let ws = self.workspace_id();
        let sql = format!(
            "select {ORDER_COLUMNS} from auto_reply_orders where workspace_id = $1 and id = $2 \
             for update"
        );
        let record: Option<OrderRecord> = sqlx::query_as(&sql)
            .bind(ws.as_uuid())
            .bind(id)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "lock an automatic reply's order"))?;
        record.map(OrderRecord::into_row).transpose()
    }

    async fn order_save(&mut self, row: &OrderRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let (summaries, generation) = order_counts(row)?;
        let done = sqlx::query(
            "update auto_reply_orders set state = $3, reason = $4, reference = $5, pay_url = $6, \
             finished_at = $7, run_id = $8, confirm_hash = $9, summary_outbox_id = $10, \
             summaries = $11, called_at = $12, generation = $13, quote_id = $14, \
             amount_minor = $15, currency = $16 where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(row.id)
        .bind(row.state.key())
        .bind(row.reason.as_deref())
        .bind(row.reference.as_deref())
        .bind(row.pay_url.as_deref())
        .bind(row.finished_at)
        .bind(row.run_id)
        .bind(row.confirm_hash.as_deref())
        .bind(row.summary_outbox_id)
        .bind(summaries)
        .bind(row.called_at)
        .bind(generation)
        .bind(row.quote_id)
        .bind(row.amount_minor)
        .bind(&row.currency)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update an automatic reply's order"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such automatic reply order"));
        }
        Ok(())
    }

    async fn orders_since(
        &mut self,
        shop: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from auto_reply_orders where workspace_id = $1 \
             and shop_capability_id = $2 and state <> 'confirming' \
             and coalesce(called_at, created_at) >= $3",
        )
        .bind(ws.as_uuid())
        .bind(shop.as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count the automatic replies' orders"))?;
        u32::try_from(n).map_err(|_| AppError::internal("a count is out of range"))
    }

    async fn orders_calling_before(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<Uuid>, AppError> {
        let ws = self.workspace_id();
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "select id from auto_reply_orders where workspace_id = $1 and state = 'calling' \
             and coalesce(called_at, created_at) < $2 order by coalesce(called_at, created_at), id \
             limit $3",
        )
        .bind(ws.as_uuid())
        .bind(before)
        .bind(i64::from(limit))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list the interrupted orders"))?;
        Ok(ids)
    }

    async fn orders_forget_links(
        &mut self,
        conversations: &[ConversationId],
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let ids: Vec<Uuid> = conversations.iter().map(|c| c.as_uuid()).collect();
        sqlx::query(
            "update auto_reply_orders set pay_url = null, confirm_hash = null where workspace_id = $1 \
             and conversation_id = any($2)",
        )
        .bind(ws.as_uuid())
        .bind(&ids)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "clear the erased person's payment links"))?;
        Ok(())
    }

    async fn owner_item(
        &mut self,
        conversation: ConversationId,
        reason: &str,
    ) -> Result<Option<OwnerItem>, AppError> {
        let ws = self.workspace_id();
        let record: Option<OwnerItemRecord> = sqlx::query_as(
            "select conversation_id, reason, task_id, created_at, line_outbox_id \
             from auto_reply_owner_items where workspace_id = $1 and conversation_id = $2 \
             and reason = $3",
        )
        .bind(ws.as_uuid())
        .bind(conversation.as_uuid())
        .bind(reason)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read an owner item"))?;
        Ok(record.map(OwnerItemRecord::into_item))
    }

    async fn owner_item_save(&mut self, item: &OwnerItem) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query(
            "insert into auto_reply_owner_items (workspace_id, conversation_id, reason, task_id, \
             created_at, line_outbox_id) values ($1, $2, $3, $4, $5, $6) \
             on conflict (workspace_id, conversation_id, reason) do update set \
             task_id = excluded.task_id, created_at = excluded.created_at, \
             line_outbox_id = excluded.line_outbox_id",
        )
        .bind(ws.as_uuid())
        .bind(item.conversation_id.as_uuid())
        .bind(&item.reason)
        .bind(item.task_id.as_uuid())
        .bind(item.created_at)
        .bind(item.line_outbox_id)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save an owner item"))?;
        Ok(())
    }

    async fn owner_items_open(
        &mut self,
        conversation: ConversationId,
    ) -> Result<Vec<OwnerItem>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<OwnerItemRecord> = sqlx::query_as(
            "select i.conversation_id, i.reason, i.task_id, i.created_at, i.line_outbox_id \
             from auto_reply_owner_items i join tasks t on t.workspace_id = i.workspace_id \
             and t.id = i.task_id where i.workspace_id = $1 and i.conversation_id = $2 \
             and t.status = 'open' order by i.created_at, i.reason",
        )
        .bind(ws.as_uuid())
        .bind(conversation.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list a conversation's open owner items"))?;
        Ok(records
            .into_iter()
            .map(OwnerItemRecord::into_item)
            .collect())
    }

    async fn owner_tasks_open(&mut self) -> Result<Vec<TaskId>, AppError> {
        let ws = self.workspace_id();
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "select distinct i.task_id from auto_reply_owner_items i join tasks t \
             on t.workspace_id = i.workspace_id and t.id = i.task_id \
             where i.workspace_id = $1 and t.status = 'open'",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list the owner items' open tasks"))?;
        Ok(ids.into_iter().map(TaskId::from).collect())
    }

    async fn owner_items_delete(&mut self, conversation: ConversationId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query(
            "delete from auto_reply_owner_items where workspace_id = $1 and conversation_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(conversation.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "remove a conversation's owner items"))?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct OwnerItemRecord {
    conversation_id: Uuid,
    reason: String,
    task_id: Uuid,
    created_at: OffsetDateTime,
    line_outbox_id: Option<Uuid>,
}

impl OwnerItemRecord {
    fn into_item(self) -> OwnerItem {
        OwnerItem {
            conversation_id: ConversationId::from(self.conversation_id),
            reason: self.reason,
            task_id: TaskId::from(self.task_id),
            created_at: self.created_at,
            line_outbox_id: self.line_outbox_id,
        }
    }
}
