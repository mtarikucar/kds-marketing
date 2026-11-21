//! The in-memory automatic replies (`0047_inbox_auto_reply`): one queue row per conversation of
//! the workspace (a conversation of another workspace, or none, spoils the bundle as the foreign
//! key does), and the runs, with the outcomes the table's check allows.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::reply_model::{AutoReplyRepo, QueueRow, RunOutcome, RunRow};
use jt_capability::CapabilityId;
use jt_inbox::ConversationId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;

use super::state::{MemBundle, exists};
use super::tenant::MemTenant;

/// The workspaces' automatic replies, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemAutoReply {
    pub queue: Vec<(WorkspaceId, QueueRow)>,
    pub runs: Vec<(WorkspaceId, RunRow)>,
}

/// Whether a run queued an automatic message (a reply or a quote).
fn sent(run: &RunRow) -> bool {
    matches!(run.outcome, RunOutcome::Replied | RunOutcome::Quoted)
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
            exists(
                this.state()
                    .inbox
                    .conversations
                    .iter()
                    .any(|c| c.workspace_id == ws && c.id == row.conversation_id),
                "auto_reply_queue.conversation_id",
            )?;
            this.tx.write(move |s| {
                s.auto_reply
                    .queue
                    .retain(|(w, r)| !(*w == ws && r.conversation_id == row.conversation_id));
                s.auto_reply.queue.push((ws, row.clone()));
            });
            Ok(())
        })
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
}
