//! The in-memory automatic replies (`0047_inbox_auto_reply`): one queue row per conversation of
//! the workspace (a conversation of another workspace, or none, spoils the bundle as the foreign
//! key does), and the runs, with the outcomes the table's check allows; and the orders
//! (`0050_auto_reply_orders`), unique per quote and per journey.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::reply_model::{
    AutoReplyRepo, OrderRow, OrderState, QueueRow, RunOutcome, RunRow,
};
use jt_capability::CapabilityId;
use jt_inbox::{ConversationId, JourneyId};
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::state::MemBundle;
use super::tenant::MemTenant;

/// The workspaces' automatic replies, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemAutoReply {
    pub queue: Vec<(WorkspaceId, QueueRow)>,
    pub runs: Vec<(WorkspaceId, RunRow)>,
    pub orders: Vec<(WorkspaceId, OrderRow)>,
}

/// Whether a run queued an automatic message (a reply, a quote or an order's link).
fn sent(run: &RunRow) -> bool {
    matches!(
        run.outcome,
        RunOutcome::Replied | RunOutcome::Quoted | RunOutcome::Ordered
    )
}

fn order_of(rows: &[(WorkspaceId, OrderRow)], ws: WorkspaceId, id: Uuid) -> Option<OrderRow> {
    rows.iter()
        .find(|(w, o)| *w == ws && o.id == id)
        .map(|(_, o)| o.clone())
}

#[async_trait]
impl AutoReplyRepo for MemTenant {
    async fn queue_lock(&mut self, id: ConversationId) -> Result<Option<QueueRow>, AppError> {
        self.tx.journal_lock("auto_reply_queue");
        self.tx.lock_studio().await;
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .queue
            .iter()
            .find(|(w, r)| *w == ws && r.conversation_id == id)
            .map(|(_, r)| r.clone()))
    }

    async fn queue_get(&mut self, id: ConversationId) -> Result<Option<QueueRow>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .queue
            .iter()
            .find(|(w, r)| *w == ws && r.conversation_id == id)
            .map(|(_, r)| r.clone()))
    }

    async fn queue_save(&mut self, row: &QueueRow) -> Result<(), AppError> {
        let row = row.clone();
        self.call(|this| {
            let ws = this.ws;
            this.tx.write(move |s| {
                let mut row = row.clone();
                // The automatic hand-over and told times stay as stored (`handover_mark`).
                if let Some((_, old)) = s
                    .auto_reply
                    .queue
                    .iter()
                    .find(|(w, r)| *w == ws && r.conversation_id == row.conversation_id)
                {
                    row.auto_handed_generation = old.auto_handed_generation;
                    row.auto_handed_at = old.auto_handed_at;
                    row.told_at = old.told_at;
                    row.told_reason = old.told_reason.clone();
                    row.line_told_at = old.line_told_at;
                } else {
                    row.auto_handed_generation = None;
                    row.auto_handed_at = None;
                    row.told_at = None;
                    row.told_reason = None;
                    row.line_told_at = None;
                }
                s.auto_reply
                    .queue
                    .retain(|(w, r)| !(*w == ws && r.conversation_id == row.conversation_id));
                s.auto_reply.queue.push((ws, row));
            });
            Ok(())
        })
    }

    async fn handover_mark(
        &mut self,
        id: ConversationId,
        generation: Option<u32>,
        at: OffsetDateTime,
        told: Option<&str>,
    ) -> Result<(), AppError> {
        let ws = self.ws;
        let told = told.map(str::to_owned);
        self.tx.write(move |s| {
            match s
                .auto_reply
                .queue
                .iter_mut()
                .find(|(w, r)| *w == ws && r.conversation_id == id)
            {
                Some((_, row)) => {
                    row.auto_handed_generation = generation;
                    row.auto_handed_at = Some(at);
                    if let Some(reason) = &told {
                        row.told_at = Some(at);
                        row.told_reason = Some(reason.clone());
                    }
                }
                None => {
                    let mut row = QueueRow::idle(id, at);
                    row.auto_handed_generation = generation;
                    row.auto_handed_at = Some(at);
                    row.told_at = told.as_ref().map(|_| at);
                    row.told_reason = told.clone();
                    s.auto_reply.queue.push((ws, row));
                }
            }
        });
        Ok(())
    }

    async fn told_clear(&mut self, id: ConversationId) -> Result<(), AppError> {
        let ws = self.ws;
        self.tx.write(move |s| {
            for (w, row) in &mut s.auto_reply.queue {
                if *w == ws && row.conversation_id == id {
                    row.told_at = None;
                    row.told_reason = None;
                    row.line_told_at = None;
                }
            }
        });
        Ok(())
    }

    async fn line_told(&mut self, id: ConversationId, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.ws;
        self.tx.write(move |s| {
            for (w, row) in &mut s.auto_reply.queue {
                if *w == ws && row.conversation_id == id {
                    row.line_told_at = Some(at);
                }
            }
        });
        Ok(())
    }

    async fn queue_delete(&mut self, id: ConversationId) -> Result<(), AppError> {
        let ws = self.ws;
        self.tx.write(move |s| {
            s.auto_reply
                .queue
                .retain(|(w, r)| !(*w == ws && r.conversation_id == id));
        });
        Ok(())
    }

    async fn queue_takeable(
        &mut self,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ConversationId>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<&QueueRow> = self
            .state()
            .auto_reply
            .queue
            .iter()
            .filter(|(w, r)| *w == ws && r.takeable(now))
            .map(|(_, r)| r)
            .collect();
        rows.sort_by_key(|r| (r.next_at(), r.conversation_id));
        Ok(rows
            .into_iter()
            .take(limit as usize)
            .map(|r| r.conversation_id)
            .collect())
    }

    async fn run_insert(&mut self, run: &RunRow) -> Result<(), AppError> {
        let run = run.clone();
        let ws = self.ws;
        self.call(|this| {
            if this
                .state()
                .auto_reply
                .runs
                .iter()
                .any(|(w, r)| *w == ws && r.id == run.id)
            {
                return Err(AppError::conflict("duplicate automatic reply run"));
            }
            if run.usage.cost_micro_usd < 0 {
                return Err(AppError::internal("check constraint: cost_micro_usd"));
            }
            this.tx
                .write(move |s| s.auto_reply.runs.push((ws, run.clone())));
            Ok(())
        })
    }

    async fn run_update(&mut self, run: &RunRow) -> Result<(), AppError> {
        let run = run.clone();
        let ws = self.ws;
        self.call(|this| {
            if !this
                .state()
                .auto_reply
                .runs
                .iter()
                .any(|(w, r)| *w == ws && r.id == run.id)
            {
                return Err(AppError::not_found("no such automatic reply run"));
            }
            this.tx.write(move |s| {
                for (w, r) in &mut s.auto_reply.runs {
                    if *w == ws && r.id == run.id {
                        *r = run.clone();
                    }
                }
            });
            Ok(())
        })
    }

    async fn run_by_quote(&mut self, quote: uuid::Uuid) -> Result<Option<RunRow>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .runs
            .iter()
            .find(|(w, r)| *w == ws && r.quote_id == Some(quote))
            .map(|(_, r)| r.clone()))
    }

    async fn runs_since(
        &mut self,
        conversation: Option<ConversationId>,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .runs
            .iter()
            .filter(|(w, r)| {
                *w == ws && r.at >= since && conversation.is_none_or(|c| r.conversation_id == c)
            })
            .count() as u32)
    }

    async fn queue_unscheduled(
        &mut self,
        capabilities: &[(CapabilityId, OffsetDateTime)],
        newer_than: OffsetDateTime,
        older_than: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ConversationId>, AppError> {
        let ws = self.ws;
        let state = self.state();
        let mut found: Vec<(OffsetDateTime, ConversationId)> = state
            .inbox
            .conversations
            .iter()
            .filter(|c| {
                c.workspace_id == ws
                    && c.state == jt_inbox::ConvState::Ours
                    && c.executor == jt_inbox::Executor::Agent
            })
            .filter_map(|c| {
                let since = capabilities
                    .iter()
                    .find(|(cap, _)| *cap == c.capability_id)
                    .map(|(_, at)| *at)?;
                let last = c.last_inbound_at?;
                let row = state
                    .auto_reply
                    .queue
                    .iter()
                    .find(|(w, q)| *w == ws && q.conversation_id == c.id)
                    .map(|(_, q)| q);
                let open = row.is_none_or(|q| q.is_idle() && q.handled_at.is_none_or(|h| h < last));
                (last >= since.max(newer_than) && last <= older_than && open)
                    .then_some((last, c.id))
            })
            .collect();
        found.sort();
        Ok(found
            .into_iter()
            .take(limit as usize)
            .map(|(_, id)| id)
            .collect())
    }

    async fn runs_sent_since(
        &mut self,
        conversation: Option<ConversationId>,
        capability: Option<CapabilityId>,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .runs
            .iter()
            .filter(|(w, r)| {
                *w == ws
                    && r.at >= since
                    && sent(r)
                    && conversation.is_none_or(|c| r.conversation_id == c)
                    && capability.is_none_or(|c| r.capability_id == c)
            })
            .count() as u32)
    }

    async fn runs_spend_since(&mut self, since: OffsetDateTime) -> Result<i64, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .runs
            .iter()
            .filter(|(w, r)| *w == ws && r.at >= since)
            .map(|(_, r)| r.usage.cost_micro_usd)
            .sum())
    }

    async fn runs_with_reason(
        &mut self,
        conversation: ConversationId,
        reason: &str,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .runs
            .iter()
            .filter(|(w, r)| {
                *w == ws
                    && r.conversation_id == conversation
                    && r.at >= since
                    && r.reason.as_deref() == Some(reason)
            })
            .count() as u32)
    }

    async fn order_insert(&mut self, row: &OrderRow) -> Result<bool, AppError> {
        let row = row.clone();
        let ws = self.ws;
        self.call(|this| {
            if this.state().auto_reply.orders.iter().any(|(w, o)| {
                *w == ws
                    && (o.id == row.id
                        || o.quote_id == row.quote_id
                        || o.journey_id == row.journey_id)
            }) {
                return Ok(false);
            }
            this.tx
                .write(move |s| s.auto_reply.orders.push((ws, row.clone())));
            Ok(true)
        })
    }

    async fn order_by_journey(&mut self, journey: JourneyId) -> Result<Option<OrderRow>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .orders
            .iter()
            .find(|(w, o)| *w == ws && o.journey_id == journey)
            .map(|(_, o)| o.clone()))
    }

    async fn order_get(&mut self, id: Uuid) -> Result<Option<OrderRow>, AppError> {
        Ok(order_of(&self.state().auto_reply.orders, self.ws, id))
    }

    async fn order_lock(&mut self, id: Uuid) -> Result<Option<OrderRow>, AppError> {
        self.tx.journal_lock("auto_reply_orders");
        self.tx.lock_studio().await;
        Ok(order_of(&self.state().auto_reply.orders, self.ws, id))
    }

    async fn order_save(&mut self, row: &OrderRow) -> Result<(), AppError> {
        let row = row.clone();
        self.call(|this| {
            let ws = this.ws;
            if order_of(&this.state().auto_reply.orders, ws, row.id).is_none() {
                return Err(AppError::not_found("no such automatic reply order"));
            }
            this.tx.write(move |s| {
                for (w, o) in &mut s.auto_reply.orders {
                    if *w == ws && o.id == row.id {
                        o.state = row.state;
                        o.reason = row.reason.clone();
                        o.reference = row.reference.clone();
                        o.pay_url = row.pay_url.clone();
                        o.finished_at = row.finished_at;
                        o.run_id = row.run_id;
                        o.confirm_hash = row.confirm_hash.clone();
                        o.summary_outbox_id = row.summary_outbox_id;
                        o.summaries = row.summaries;
                        o.called_at = row.called_at;
                        o.generation = row.generation;
                        o.quote_id = row.quote_id;
                        o.amount_minor = row.amount_minor;
                        o.currency = row.currency.clone();
                    }
                }
            });
            Ok(())
        })
    }

    async fn orders_since(
        &mut self,
        shop: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .auto_reply
            .orders
            .iter()
            .filter(|(w, o)| {
                *w == ws
                    && o.shop_capability_id == shop
                    && o.state != OrderState::Confirming
                    && o.called_at.unwrap_or(o.created_at) >= since
            })
            .count() as u32)
    }

    async fn orders_calling_before(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<Uuid>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<&OrderRow> = self
            .state()
            .auto_reply
            .orders
            .iter()
            .filter(|(w, o)| {
                *w == ws
                    && o.state == OrderState::Calling
                    && o.called_at.unwrap_or(o.created_at) < before
            })
            .map(|(_, o)| o)
            .collect();
        rows.sort_by_key(|o| (o.called_at.unwrap_or(o.created_at), o.id));
        Ok(rows
            .into_iter()
            .take(limit as usize)
            .map(|o| o.id)
            .collect())
    }

    async fn orders_forget_links(
        &mut self,
        conversations: &[ConversationId],
    ) -> Result<(), AppError> {
        let ws = self.ws;
        let conversations = conversations.to_vec();
        self.tx.write(move |s| {
            for (w, o) in &mut s.auto_reply.orders {
                if *w == ws && conversations.contains(&o.conversation_id) {
                    o.pay_url = None;
                    o.confirm_hash = None;
                }
            }
        });
        Ok(())
    }
}
