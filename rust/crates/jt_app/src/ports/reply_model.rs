//! The inbox's automatic replies (`usecases::inbox::autoreply`): the model port the server asks
//! for an answer, and what is stored about each reply (`0047_inbox_auto_reply`).
//!
//! **The model.** [`ReplyModel`] is asked once per due conversation with a [`ModelRequest`]: the
//! fixed instructions, the workspace's part (who the business is, its cards, rules and range) and
//! the conversation so far as [`Turn`]s, the customer's and the business's. It answers through
//! exactly one of three tools ([`ModelTool`]): a reply, a quote, or a hand-over to a person. Every
//! detail of a provider's API (its URL, headers, body, tool schema, prices) stays in its adapter;
//! here are only these neutral types. With no model configured
//! (`ConnectorRegistry::reply_model` is `None`) the feature is off everywhere.
//!
//! **What is stored.** The debounced work list ([`QueueRow`], one per conversation waiting for a
//! reply) and one [`RunRow`] per model call: codes and numbers only, never a customer's text, the
//! model's answer, a quote's basis or a hand-over's summary. The day's limits are counted from the
//! runs.

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::ConversationId;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::error::AppError;

/// A reply goes out this long after the customer's last message, so several messages in a row
/// make one answer.
pub const AUTOREPLY_SETTLE: Duration = Duration::seconds(12);
/// ... but never later than this after the first, however many follow it.
pub const AUTOREPLY_SETTLE_MAX: Duration = Duration::seconds(45);
/// How long a run holds its conversation while it asks the model; a run that died is retried
/// after it.
pub const AUTOREPLY_LEASE: Duration = Duration::minutes(2);
/// How many model calls one queue row may take (a retry after a rate limit or an outage, a run
/// that died after its call included) before the conversation goes to a person (`failed`).
pub const AUTOREPLY_MAX_ATTEMPTS: u32 = 3;
/// What a model call that brought back no usage is counted as costing, in millionths of a US
/// dollar: a conservative estimate (a full prompt and a full answer), so failed calls count
/// towards the day's spend ceiling.
pub const FAILED_CALL_ESTIMATE_MICRO_USD: i64 = 5_000;
/// The longest wait before asking again after a rate limit.
pub const AUTOREPLY_RETRY_MAX: Duration = Duration::seconds(60);
/// Model calls per conversation per local day: an answer and its check are two, so this is 12
/// automatic messages.
pub const PER_CONVERSATION_DAILY: u32 = 24;
/// Model calls per workspace per local day (300 automatic messages, each with its check).
pub const PER_WORKSPACE_DAILY: u32 = 600;
/// The most output tokens the check of a text may take (its thinking included).
pub const JUDGE_MAX_TOKENS: u32 = 1_024;
/// How often the job looks for customer messages left without a schedule (a crash between the
/// consumer's commit and the schedule).
pub const RECONCILE_EVERY: std::time::Duration = std::time::Duration::from_secs(60);
/// A customer message is looked for by that sweep only once it is this old (the consumer's own
/// schedule comes first).
pub const RECONCILE_GRACE: Duration = Duration::seconds(30);
/// How long one workspace may take of one run of the job.
pub const AUTOREPLY_WORKSPACE_SHARE: std::time::Duration = std::time::Duration::from_secs(8);
/// The model's cost per workspace per local day, in millionths of a US dollar ($2).
pub const WORKSPACE_DAILY_SPEND_MICRO_USD: i64 = 2_000_000;
/// How many of the conversation's latest messages the model reads.
pub const MAX_HISTORY: u32 = 30;
/// The most output tokens one answer may take (thinking included).
pub const MAX_OUTPUT_TOKENS: u32 = 2_048;
/// The most due conversations one run of the job takes per workspace.
pub const AUTOREPLY_BATCH: u32 = 5;
/// How long one run of the job starts new conversations for; what is left waits for the next.
pub const AUTOREPLY_TICK_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

/// Who wrote a turn of the conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Speaker {
    /// The customer's messages.
    Customer,
    /// What the business sent (the agent's, a person's, the automatic replies', the phone's).
    Business,
}

/// A piece of a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Part {
    Text { text: String },
}

/// One turn: consecutive messages of one speaker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Turn {
    pub speaker: Speaker,
    pub parts: Vec<Part>,
}

/// What the model is asked. `history` starts and ends with a customer's turn and never holds two
/// turns of the same speaker in a row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelRequest {
    /// The instructions every workspace shares (a constant of the use case).
    pub system_fixed: String,
    /// The workspace's part: its name and identity, its cards, its rules, its notes, its range.
    pub system_workspace: String,
    pub history: Vec<Turn>,
    pub max_tokens: u32,
}

/// The model's one tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelTool {
    /// A message to the customer.
    Reply { text: String },
    /// A quote: `amount` in whole units of the workspace's currency, what it rests on, and the
    /// message stating it.
    Quote {
        amount: i64,
        basis: String,
        text: String,
    },
    /// The conversation goes to a person: why (a code of [`HAND_OVER_REASONS`]), a summary for
    /// the person, and a line for the customer when the model wrote one.
    HandOver {
        reason: String,
        summary: String,
        text: Option<String>,
    },
}

/// The model's hand-over reasons, as its tool lists them.
pub const HAND_OVER_REASONS: &[&str] = &[
    "out_of_standard",
    "bulk_or_corporate",
    "complaint",
    "payment_problem",
    "asks_for_person",
    "not_covered",
    "other",
];

/// Why the model stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelStop {
    /// It called a tool.
    ToolUse,
    /// It declined to answer.
    Refusal,
    /// It ran out of output tokens.
    MaxTokens,
    /// It answered with no usable tool call.
    NoTool,
}

/// What one call used and cost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    /// In millionths of a US dollar, at the adapter's prices for its model.
    pub cost_micro_usd: i64,
}

/// The model's answer: its tool call (none unless `stop` is [`ModelStop::ToolUse`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelAnswer {
    pub tool: Option<ModelTool>,
    pub stop: ModelStop,
    pub usage: Usage,
}

/// Why the model gave no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelError {
    /// Over the provider's limits; ask again after `retry_after` when it says.
    RateLimited { retry_after: Option<Duration> },
    /// The provider or the network failed (a `5xx`, an overload, a timeout).
    Unavailable { status: Option<u16> },
    /// The provider refused the request itself (the key, the request's shape): asking again
    /// changes nothing.
    Rejected { status: Option<u16> },
}

/// A second, independent check of a text the rules let through: whether it states, implies or
/// promises anything of money, a free item, a payment term or a delivery the cards do not hold.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JudgeRequest {
    /// The instructions (a constant of the use case).
    pub system: String,
    /// The workspace's cards, the only facts the text may rest on.
    pub cards: String,
    /// The text to check, with the one price a quote states, when it is a quote's.
    pub text: String,
    pub max_tokens: u32,
}

/// The check's answer: `allowed` only from a clear tool call (none on a refusal, a cut answer or
/// no tool call).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JudgeAnswer {
    pub allowed: Option<bool>,
    pub usage: Usage,
}

/// The model the automatic replies ask.
#[async_trait]
pub trait ReplyModel: Send + Sync {
    /// The model's id, recorded on each run.
    fn model(&self) -> &str;
    async fn answer(&self, request: &ModelRequest) -> Result<ModelAnswer, ModelError>;
    /// The check of a text ([`JudgeRequest`]).
    async fn judge(&self, request: &JudgeRequest) -> Result<JudgeAnswer, ModelError>;
}

/// A conversation waiting for an automatic reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueRow {
    pub conversation_id: ConversationId,
    /// The first customer message of the burst.
    pub first_at: OffsetDateTime,
    /// When the reply is due; none while a run holds it.
    pub due_at: Option<OffsetDateTime>,
    /// Until when a run holds it.
    pub lease_until: Option<OffsetDateTime>,
    /// How many model calls it took in its current burst.
    pub attempts: u32,
    /// When a person last handed the conversation back to the agent: a person's message before
    /// it no longer keeps the automatic replies out.
    pub handed_back_at: Option<OffsetDateTime>,
    /// When the customer's messages were last looked at for a schedule (each customer message
    /// up to then is handled); the job's sweep schedules a newer one left without.
    pub handled_at: Option<OffsetDateTime>,
}

impl QueueRow {
    /// A row with nothing due, for conversation `id`.
    pub fn idle(id: ConversationId, now: OffsetDateTime) -> QueueRow {
        QueueRow {
            conversation_id: id,
            first_at: now,
            due_at: None,
            lease_until: None,
            attempts: 0,
            handed_back_at: None,
            handled_at: None,
        }
    }

    /// Whether nothing is due and no run holds it.
    pub fn is_idle(&self) -> bool {
        self.due_at.is_none() && self.lease_until.is_none()
    }

    /// Whether a run may take it at `now`: due and not held, or held by a run whose lease ran out.
    pub fn takeable(&self, now: OffsetDateTime) -> bool {
        let lease_free = self.lease_until.is_none_or(|l| l <= now);
        match self.due_at {
            Some(due) => due <= now && lease_free,
            None => self.lease_until.is_some_and(|l| l <= now),
        }
    }

    /// When it can next be taken.
    pub fn next_at(&self) -> Option<OffsetDateTime> {
        match (self.due_at, self.lease_until) {
            (Some(d), Some(l)) => Some(d.max(l)),
            (Some(d), None) => Some(d),
            (None, l) => l,
        }
    }
}

/// What a run came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Replied,
    Quoted,
    HandedOver,
    Skipped,
    Failed,
}

impl RunOutcome {
    pub fn key(self) -> &'static str {
        match self {
            RunOutcome::Replied => "replied",
            RunOutcome::Quoted => "quoted",
            RunOutcome::HandedOver => "handed_over",
            RunOutcome::Skipped => "skipped",
            RunOutcome::Failed => "failed",
        }
    }

    pub fn parse(key: &str) -> Option<RunOutcome> {
        Some(match key {
            "replied" => RunOutcome::Replied,
            "quoted" => RunOutcome::Quoted,
            "handed_over" => RunOutcome::HandedOver,
            "skipped" => RunOutcome::Skipped,
            "failed" => RunOutcome::Failed,
            _ => return None,
        })
    }
}

/// One model call: codes and numbers only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRow {
    pub id: Uuid,
    pub conversation_id: ConversationId,
    pub capability_id: CapabilityId,
    pub at: OffsetDateTime,
    pub model: String,
    pub outcome: RunOutcome,
    pub reason: Option<String>,
    pub usage: Usage,
    /// The automatic message it queued, if any (a hand-over's line included).
    pub outbox_id: Option<Uuid>,
    pub quote_id: Option<Uuid>,
}

/// The automatic replies' rows of the bundle's workspace.
#[async_trait]
pub trait AutoReplyRepo: Send + Sync {
    /// Conversation `id`'s queue row, locked until the bundle ends. A row stays once made (idle
    /// while nothing is due, [`QueueRow::is_idle`]): it keeps when a person handed the
    /// conversation back.
    async fn queue_lock(&mut self, id: ConversationId) -> Result<Option<QueueRow>, AppError>;
    /// Conversation `id`'s queue row, without a lock.
    async fn queue_get(&mut self, id: ConversationId) -> Result<Option<QueueRow>, AppError>;
    /// Inserts or replaces the queue row of its conversation.
    async fn queue_save(&mut self, row: &QueueRow) -> Result<(), AppError>;
    /// Removes conversation `id`'s queue row, if any.
    async fn queue_delete(&mut self, id: ConversationId) -> Result<(), AppError>;
    /// The conversations a run may take at `now` ([`QueueRow::takeable`]), the longest waiting
    /// first, at most `limit`.
    async fn queue_takeable(
        &mut self,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ConversationId>, AppError>;
    async fn run_insert(&mut self, run: &RunRow) -> Result<(), AppError>;
    /// Replaces run `run.id`'s outcome, reason, usage, outbox and quote; `NOT_FOUND` when the
    /// workspace has no such run.
    async fn run_update(&mut self, run: &RunRow) -> Result<(), AppError>;
    /// The run that queued quote `quote`, if an automatic reply did.
    async fn run_by_quote(&mut self, quote: Uuid) -> Result<Option<RunRow>, AppError>;
    /// How many model calls (runs of any outcome) were made at `since` or later, in conversation
    /// `conversation` when given.
    async fn runs_since(
        &mut self,
        conversation: Option<ConversationId>,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// How many runs at `since` or later queued an automatic message (a reply or a quote; a
    /// hand-over's line does not count): of conversation `conversation` when given, on capability
    /// `capability` when given.
    async fn runs_sent_since(
        &mut self,
        conversation: Option<ConversationId>,
        capability: Option<CapabilityId>,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// The cost of every run at `since` or later, in millionths of a US dollar.
    async fn runs_spend_since(&mut self, since: OffsetDateTime) -> Result<i64, AppError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(due: Option<i64>, lease: Option<i64>) -> QueueRow {
        let at = |s| OffsetDateTime::UNIX_EPOCH + Duration::seconds(s);
        QueueRow {
            conversation_id: ConversationId::new_v7(),
            first_at: at(0),
            due_at: due.map(at),
            lease_until: lease.map(at),
            attempts: 0,
            handed_back_at: None,
            handled_at: None,
        }
    }

    #[test]
    fn a_row_is_taken_when_due_and_free_or_when_its_lease_ran_out() {
        let now = OffsetDateTime::UNIX_EPOCH + Duration::seconds(10);
        assert!(row(Some(10), None).takeable(now));
        assert!(!row(Some(11), None).takeable(now));
        assert!(!row(Some(5), Some(20)).takeable(now));
        assert!(row(Some(5), Some(10)).takeable(now));
        assert!(!row(None, Some(20)).takeable(now));
        assert!(row(None, Some(9)).takeable(now));
        assert!(!row(None, None).takeable(now));
        assert_eq!(
            row(Some(5), Some(20)).next_at(),
            Some(OffsetDateTime::UNIX_EPOCH + Duration::seconds(20))
        );
    }
}
