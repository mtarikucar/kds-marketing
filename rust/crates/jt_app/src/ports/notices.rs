//! The owner's email notices (`usecases::inbox::notices`, migration `0049_owner_notices`): one
//! row per thing the owner is told of by email, through the workspace's own verified mailbox. A
//! row holds codes and ids only: never a customer's name, text or address.

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::ConversationId;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// What a notice tells of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    /// The automatic replies handed a conversation to a person.
    HandedOver,
    /// The automatic replies created an order (written by the orders' release).
    OrderCreated,
}

impl NoticeKind {
    pub fn key(self) -> &'static str {
        match self {
            NoticeKind::HandedOver => "handed_over",
            NoticeKind::OrderCreated => "order_created",
        }
    }

    pub fn parse(key: &str) -> Option<NoticeKind> {
        match key {
            "handed_over" => Some(NoticeKind::HandedOver),
            "order_created" => Some(NoticeKind::OrderCreated),
            _ => None,
        }
    }
}

/// Where a notice is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeState {
    /// Waiting to be sent (from `next_at`).
    Queued,
    /// Being sent: from just before the mail server is asked until its answer is stored. Found so
    /// later (a crash in between), it is taken as sent, never sent again.
    Sending,
    /// Sent (or handed to the mail server without a clear answer: never sent twice).
    Sent,
    /// Given up on.
    Failed,
    /// Not sent: over the day's cap.
    Skipped,
}

impl NoticeState {
    pub fn key(self) -> &'static str {
        match self {
            NoticeState::Queued => "queued",
            NoticeState::Sending => "sending",
            NoticeState::Sent => "sent",
            NoticeState::Failed => "failed",
            NoticeState::Skipped => "skipped",
        }
    }

    pub fn parse(key: &str) -> Option<NoticeState> {
        match key {
            "queued" => Some(NoticeState::Queued),
            "sending" => Some(NoticeState::Sending),
            "sent" => Some(NoticeState::Sent),
            "failed" => Some(NoticeState::Failed),
            "skipped" => Some(NoticeState::Skipped),
            _ => None,
        }
    }
}

/// One notice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoticeRow {
    pub id: Uuid,
    pub kind: NoticeKind,
    pub conversation_id: ConversationId,
    /// One notice per thing told of: `needs_you:{conversation}:{task}` (before the agent kept every
    /// conversation, `handed_over:{conversation}:{generation}`), `order:{order}`.
    pub dedupe_key: String,
    /// The hand-over's reason code, or `daily_cap` for a skipped notice.
    pub reason: Option<String>,
    pub created_at: OffsetDateTime,
    pub state: NoticeState,
    pub attempts: u32,
    /// When a queued notice may be tried (again): none at once.
    pub next_at: Option<OffsetDateTime>,
    /// When it was sent; for `Sending`, when the send began.
    pub sent_at: Option<OffsetDateTime>,
    /// The mailbox it went out through.
    pub mailbox_capability_id: Option<CapabilityId>,
}

/// The workspace's notices.
#[async_trait]
pub trait NoticeRepo: Send + Sync {
    /// Stores `row` and answers `true`, unless the workspace holds a notice with its
    /// `dedupe_key`: then nothing is written and the answer is `false`.
    async fn insert(&mut self, row: &NoticeRow) -> Result<bool, AppError>;
    /// How many notices not `Skipped` were created at or after `since`.
    async fn count_since(&mut self, since: OffsetDateTime) -> Result<u32, AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<NoticeRow>, AppError>;
    /// [`NoticeRepo::get`], locked until the transaction ends.
    async fn lock(&mut self, id: Uuid) -> Result<Option<NoticeRow>, AppError>;
    /// Updates the row's state, attempts, next and sent times and mailbox. An unknown id is
    /// `NOT_FOUND`.
    async fn save(&mut self, row: &NoticeRow) -> Result<(), AppError>;
    /// The queued notices due at `now` (no `next_at`, or one not after `now`), oldest first, at
    /// most `limit`.
    async fn due(&mut self, now: OffsetDateTime, limit: u32) -> Result<Vec<Uuid>, AppError>;
    /// Takes every notice left `Sending` since before `before` as sent; how many.
    async fn settle_sending(&mut self, before: OffsetDateTime) -> Result<u32, AppError>;
}
