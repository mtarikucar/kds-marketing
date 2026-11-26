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
//! runs. An order the replies create in the workspace's shop (`0050_auto_reply_orders`) is one
//! [`OrderRow`]: its state, the amount, the shop's reference and the payment link; never the
//! customer's name, email, phone or address.
//!
//! **The order tool.** Only when [`ModelRequest::order`] is given (a verified shop with its order
//! template, a quote on the journey) is the model offered a fourth tool, `create_order`
//! ([`ModelTool::CreateOrder`]); otherwise the request is exactly the three tools'.

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::ConversationId;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::error::AppError;

/// The order's details and payment methods, as the model's tool names them.
pub use jt_inbox::order::{OrderFields, PAYMENT_METHODS};
/// How long after a customer's last message the business may still answer it (WhatsApp's
/// customer service window).
pub const REPLY_WINDOW: Duration = Duration::hours(24);
/// The oldest customer message the job's sweep still answers.
pub const RECONCILE_MAX_AGE: Duration = Duration::minutes(15);
/// The most conversations one sweep of a workspace schedules.
pub const RECONCILE_BATCH: u32 = 20;
/// How many times a hand-over of a row that kept failing is tried before the row rests anyway.
pub const GIVE_UP_RETRIES: u32 = 3;

/// A reply goes out this long after the customer's last message, so several messages in a row
/// make one answer.
pub const AUTOREPLY_SETTLE: Duration = Duration::seconds(6);
/// ... but never later than this after the first, however many follow it.
pub const AUTOREPLY_SETTLE_MAX: Duration = Duration::seconds(20);
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

/// The most images of a customer the model is shown at once: the latest ones.
pub const MAX_IMAGES: usize = 4;
/// The largest image the model is shown, in bytes (3.5 MiB: about 4.7 MB in base64); a larger one
/// is left out, and the model told.
pub const MAX_IMAGE_BYTES: usize = 7 << 19;
/// The most bytes of images one request carries, all together (12 MiB); an image past it is left
/// out, and the model told. The request then stays well inside the provider's size limit.
pub const MAX_IMAGES_BYTES: usize = 12 << 20;

/// The image types the model reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageType {
    Jpeg,
    Png,
    Webp,
}

impl ImageType {
    /// The media type, as the model's provider names it.
    pub fn mime(self) -> &'static str {
        match self {
            ImageType::Jpeg => "image/jpeg",
            ImageType::Png => "image/png",
            ImageType::Webp => "image/webp",
        }
    }

    /// The type of `data` by its first bytes; `None` for anything but JPEG, PNG and WebP. A
    /// file's own name for its type is not trusted: the bytes decide.
    pub fn sniff(data: &[u8]) -> Option<ImageType> {
        if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(ImageType::Jpeg)
        } else if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
            Some(ImageType::Png)
        } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
            Some(ImageType::Webp)
        } else {
            None
        }
    }
}

/// An image a customer sent, held in memory for one request: never stored or logged. Its `Debug`
/// shows its type and size alone.
#[derive(Clone, PartialEq, Eq)]
pub struct Image {
    pub kind: ImageType,
    pub data: Vec<u8>,
}

impl std::fmt::Debug for Image {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Image")
            .field("kind", &self.kind)
            .field("bytes", &self.data.len())
            .finish()
    }
}

/// A piece of a turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    Text {
        text: String,
    },
    /// An image the customer sent (only ever in a customer's turn).
    Image {
        image: Image,
    },
}

/// One turn: consecutive messages of one speaker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
    pub speaker: Speaker,
    pub parts: Vec<Part>,
}

/// What the model is asked. `history` starts and ends with a customer's turn and never holds two
/// turns of the same speaker in a row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRequest {
    /// The instructions every workspace shares (a constant of the use case).
    pub system_fixed: String,
    /// The workspace's part: its name and identity, its cards, its rules, its notes, its range.
    pub system_workspace: String,
    /// A note from the server for this call alone (the repair of a refused reply): sent after the
    /// cached system blocks, never cached, never in a customer's turn.
    pub system_note: Option<String>,
    /// The `discount` tool is offered: the workspace allows a bargaining discount. Off, the
    /// request is what it was before the discount existed.
    pub offer_discount: bool,
    pub history: Vec<Turn>,
    pub max_tokens: u32,
    /// The order tool, offered only when given (see the module docs).
    pub order: Option<OrderOffer>,
}

/// What the order tool is offered with: the quote it orders, and the order already created for
/// it, if any (its shop reference).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderOffer {
    pub amount_minor: i64,
    pub currency: String,
    pub valid_until: OffsetDateTime,
    pub done: Option<String>,
}

/// The model's one tool call.
#[derive(Clone, PartialEq, Eq)]
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
    /// The customer accepted the quote and gave what the order needs: the details and a short
    /// line to send with the payment link (empty for none). The first call shows the customer a
    /// summary to confirm; the same details again after an explicit yes create the order. Never
    /// stored or logged: `Debug` masks the details.
    CreateOrder {
        fields: Box<OrderFields>,
        text: String,
    },
    /// The customer bargains over the automatic quote: the server gives the business's next
    /// discount step, at the price it computes. `text` is a short line before the server's own
    /// line stating the new price; it may state no amount. The model names no amount, step or
    /// percent.
    Discount { text: String },
}

impl std::fmt::Debug for ModelTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelTool::Reply { text } => f.debug_struct("Reply").field("text", text).finish(),
            ModelTool::Quote {
                amount,
                basis,
                text,
            } => f
                .debug_struct("Quote")
                .field("amount", amount)
                .field("basis", basis)
                .field("text", text)
                .finish(),
            ModelTool::HandOver {
                reason,
                summary,
                text,
            } => f
                .debug_struct("HandOver")
                .field("reason", reason)
                .field("summary", summary)
                .field("text", text)
                .finish(),
            ModelTool::Discount { text } => f.debug_struct("Discount").field("text", text).finish(),
            // A customer's details: never printed.
            ModelTool::CreateOrder { .. } => f.write_str("CreateOrder(***)"),
        }
    }
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
    /// The server's own facts about this text (the one price a quote may state, or that none
    /// may be stated).
    pub facts: String,
    /// The text to check, alone, between the delimiters the instructions name.
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
    /// The last automatic hand-over (the automatic replies, the server or the response-time
    /// job): the executor generation it wrote and when. While the conversation is still at that
    /// generation and no person wrote since, a person does not hold it: the customer's next
    /// message brings the assistant back. Written only by [`AutoReplyRepo::handover_mark`];
    /// [`AutoReplyRepo::queue_save`] keeps it as stored.
    pub auto_handed_generation: Option<u32>,
    pub auto_handed_at: Option<OffsetDateTime>,
    /// When the owner was last told of an automatic hand-over (its notice) and the customer
    /// its line, and for which reason; kept like the two above.
    pub told_at: Option<OffsetDateTime>,
    pub told_reason: Option<String>,
    /// When the customer was last sent a hand-over's line; kept like the ones above
    /// ([`AutoReplyRepo::line_told`]).
    pub line_told_at: Option<OffsetDateTime>,
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
            auto_handed_generation: None,
            auto_handed_at: None,
            told_at: None,
            told_reason: None,
            line_told_at: None,
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
    /// An order was asked of the shop (or its link sent again): `0050_auto_reply_orders`.
    Ordered,
}

impl RunOutcome {
    pub fn key(self) -> &'static str {
        match self {
            RunOutcome::Replied => "replied",
            RunOutcome::Quoted => "quoted",
            RunOutcome::HandedOver => "handed_over",
            RunOutcome::Skipped => "skipped",
            RunOutcome::Failed => "failed",
            RunOutcome::Ordered => "ordered",
        }
    }

    pub fn parse(key: &str) -> Option<RunOutcome> {
        Some(match key {
            "replied" => RunOutcome::Replied,
            "quoted" => RunOutcome::Quoted,
            "handed_over" => RunOutcome::HandedOver,
            "skipped" => RunOutcome::Skipped,
            "failed" => RunOutcome::Failed,
            "ordered" => RunOutcome::Ordered,
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

/// Where an order of the automatic replies is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OrderState {
    /// The customer was shown the summary and is to confirm it (no shop call yet).
    Confirming,
    /// The shop is being asked (from just before the call until its answer is stored). Found so
    /// later than [`ORDER_CALL_STALE`] (a crash in between), it becomes `Unknown`.
    Calling,
    /// The shop created it: its link was sent (or handed to a person).
    Created,
    /// The shop refused it, or its answer did not pass the server's checks.
    Failed,
    /// The shop was asked but its answer is not known: it may exist there.
    Unknown,
}

impl OrderState {
    pub fn key(self) -> &'static str {
        match self {
            OrderState::Confirming => "confirming",
            OrderState::Calling => "calling",
            OrderState::Created => "created",
            OrderState::Failed => "failed",
            OrderState::Unknown => "unknown",
        }
    }

    pub fn parse(key: &str) -> Option<OrderState> {
        Some(match key {
            "confirming" => OrderState::Confirming,
            "calling" => OrderState::Calling,
            "created" => OrderState::Created,
            "failed" => OrderState::Failed,
            "unknown" => OrderState::Unknown,
            _ => return None,
        })
    }
}

/// While the agent keeps every conversation (`AutoReply::keeps`): what the automatic replies
/// asked the owner about in one conversation, for one reason (`0056_auto_reply_owner_items`). The
/// open item itself is a task on the person's journey ([`OwnerItem::task_id`]); this row ties it to
/// the conversation, so one reason asks once until the task is done. Codes and ids only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerItem {
    pub conversation_id: ConversationId,
    /// The hand-over reason it stands for (`not_covered`, `limit_spend`, …).
    pub reason: String,
    pub task_id: jt_inbox::TaskId,
    pub created_at: OffsetDateTime,
    /// The automatic message that told the customer the team will get back to them on it, once
    /// one was queued.
    pub line_outbox_id: Option<Uuid>,
}

/// An order left `Calling` this long is taken as interrupted.
pub const ORDER_CALL_STALE: Duration = Duration::minutes(2);

/// One order the automatic replies asked of the workspace's shop: one per quote and one per
/// journey. Codes, amounts, the shop's reference and the payment link only: never the customer's
/// name, email, phone or address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderRow {
    /// Also the order's reference at the shop (`jeeta_ref`).
    pub id: Uuid,
    pub journey_id: jt_inbox::JourneyId,
    pub conversation_id: ConversationId,
    pub quote_id: Uuid,
    pub shop_capability_id: CapabilityId,
    pub run_id: Uuid,
    pub state: OrderState,
    /// Why it failed or is unknown (an `order_*` code).
    pub reason: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
    pub reference: Option<String>,
    /// Cleared when the person is erased.
    pub pay_url: Option<String>,
    pub created_at: OffsetDateTime,
    pub finished_at: Option<OffsetDateTime>,
    /// A keyed hash of the details and the amount the customer was shown (never the details).
    pub confirm_hash: Option<String>,
    /// The outbox row of the summary the customer is to confirm.
    pub summary_outbox_id: Option<Uuid>,
    /// How many summaries the journey was shown.
    pub summaries: u32,
    /// When the shop was asked (from `Calling` on).
    pub called_at: Option<OffsetDateTime>,
    /// The executor generation the order was asked under.
    pub generation: Option<u32>,
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
    /// Inserts or replaces the queue row of its conversation, but for its automatic hand-over and
    /// told times, which stay as stored ([`AutoReplyRepo::handover_mark`]).
    async fn queue_save(&mut self, row: &QueueRow) -> Result<(), AppError>;
    /// Records an automatic hand-over of conversation `id` at `at` (making its queue row when
    /// there is none): `generation`, the executor generation it wrote, when the assistant may come
    /// back from it (none: a person finishes it); with `told`, that the owner was told of it then,
    /// for that reason.
    async fn handover_mark(
        &mut self,
        id: ConversationId,
        generation: Option<u32>,
        at: OffsetDateTime,
        told: Option<&str>,
    ) -> Result<(), AppError>;
    /// Forgets that the customer and the owner were told of a hand-over (a person handed the
    /// conversation back).
    async fn told_clear(&mut self, id: ConversationId) -> Result<(), AppError>;
    /// Records that the customer of conversation `id` was sent a hand-over's line at `at` (its
    /// queue row exists: the hand-over marked it).
    async fn line_told(&mut self, id: ConversationId, at: OffsetDateTime) -> Result<(), AppError>;
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
    /// The job's sweep, in one bounded query: the conversations `ours` and the agent's on one of
    /// `capabilities` (each with the time it was turned on) whose latest customer message is at
    /// or after both that time and `newer_than`, at or before `older_than`, and newer than their
    /// queue row's `handled_at`, with nothing due or leased; the oldest message first, at most
    /// `limit`.
    async fn queue_unscheduled(
        &mut self,
        capabilities: &[(CapabilityId, OffsetDateTime)],
        newer_than: OffsetDateTime,
        older_than: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ConversationId>, AppError>;
    /// How many runs of conversation `conversation` at `since` or later came to reason `reason`.
    async fn runs_with_reason(
        &mut self,
        conversation: ConversationId,
        reason: &str,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// Stores order `row` and answers `true`, unless the workspace holds an order of its quote or
    /// of its journey: then nothing is written and the answer is `false`.
    async fn order_insert(&mut self, row: &OrderRow) -> Result<bool, AppError>;
    /// The order of journey `journey`, if any.
    async fn order_by_journey(
        &mut self,
        journey: jt_inbox::JourneyId,
    ) -> Result<Option<OrderRow>, AppError>;
    async fn order_get(&mut self, id: Uuid) -> Result<Option<OrderRow>, AppError>;
    /// [`AutoReplyRepo::order_get`], locked until the bundle ends.
    async fn order_lock(&mut self, id: Uuid) -> Result<Option<OrderRow>, AppError>;
    /// Updates the order's state, reason, reference, link, finish time, run, confirmation fields,
    /// call time, generation and the quote it orders (its id, amount and currency); `NOT_FOUND`
    /// for an unknown id.
    async fn order_save(&mut self, row: &OrderRow) -> Result<(), AppError>;
    /// How many orders shop `shop` was asked for at `since` or later: every row but those still
    /// `Confirming` (the shop never asked), counted from when the shop was asked.
    async fn orders_since(
        &mut self,
        shop: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// The orders left `Calling` since before `before` (by their call time), oldest first, at
    /// most `limit`.
    async fn orders_calling_before(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<Uuid>, AppError>;
    /// Clears the payment link and the confirmation hash of every order of conversations
    /// `conversations` (erasure: the reference and the amount stay, as a financial record's do).
    async fn orders_forget_links(
        &mut self,
        conversations: &[ConversationId],
    ) -> Result<(), AppError>;
    /// Conversation `conversation`'s owner item for reason `reason`, if one was ever made (its
    /// task open or not).
    async fn owner_item(
        &mut self,
        conversation: ConversationId,
        reason: &str,
    ) -> Result<Option<OwnerItem>, AppError>;
    /// Inserts or replaces the owner item of its conversation and reason.
    async fn owner_item_save(&mut self, item: &OwnerItem) -> Result<(), AppError>;
    /// Conversation `conversation`'s owner items whose task is still open, oldest first.
    async fn owner_items_open(
        &mut self,
        conversation: ConversationId,
    ) -> Result<Vec<OwnerItem>, AppError>;
    /// The tasks of the workspace's owner items that are still open, in no particular order.
    async fn owner_tasks_open(&mut self) -> Result<Vec<jt_inbox::TaskId>, AppError>;
    /// Removes conversation `conversation`'s owner items (erasure); their tasks stay, as the
    /// journey's other tasks do.
    async fn owner_items_delete(&mut self, conversation: ConversationId) -> Result<(), AppError>;
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
            auto_handed_generation: None,
            auto_handed_at: None,
            told_at: None,
            told_reason: None,
            line_told_at: None,
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
