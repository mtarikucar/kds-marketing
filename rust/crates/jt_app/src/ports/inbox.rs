//! Inbox persistence contracts. All reads and writes are tenant scoped. Missing mutation targets
//! return NOT_FOUND; duplicate keys return CONFLICT unless a method explicitly returns a boolean
//! or optional id. Locks last until the enclosing bundle commits or rolls back.

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_connector::InboundEventId;
use jt_inbox::*;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// Maximum page size for inbox reads; requested limits are clamped to 1..=500.
pub const MAX_INBOX_PAGE: u32 = 500;
/// Initial dictionary, shared by registration and the adapters. Migration 0006 backfills the same keys.
pub const LOST_REASON_DEFAULTS: &[(&str, &str)] = &[
    ("fiyat", "Fiyat"),
    ("zaman", "Zaman"),
    ("rakip", "Rakip"),
    ("ulasilamadi", "Ulaşılamadı"),
    ("ilgisiz", "İlgisiz"),
    ("diger", "Diğer"),
];

#[async_trait]
pub trait PersonRepo: Send + Sync {
    async fn insert(&mut self, person: Person) -> Result<(), AppError>;
    async fn get(&mut self, id: PersonId) -> Result<Option<Person>, AppError>;
    async fn lock(&mut self, id: PersonId) -> Result<Option<Person>, AppError>;
    /// Only active identities on people that are neither merged nor erased match.
    async fn find_by_identity(
        &mut self,
        channel: IdentityChannel,
        normalized: &str,
    ) -> Result<Option<Person>, AppError>;
    /// Literal, case-insensitive substring of name/company, ordered by (created_at,id).
    async fn search(&mut self, query: &str, limit: u32) -> Result<Vec<Person>, AppError>;
    /// `None` clears the merge marker during an authorized undo.
    async fn mark_merged(
        &mut self,
        id: PersonId,
        target: Option<PersonId>,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    async fn set_erased(&mut self, id: PersonId, at: OffsetDateTime) -> Result<(), AppError>;
}

#[async_trait]
pub trait IdentityRepo: Send + Sync {
    async fn insert(&mut self, identity: Identity) -> Result<(), AppError>;
    /// Active identities only, ordered by (first_seen_at,id).
    async fn list(&mut self, person: PersonId) -> Result<Vec<Identity>, AppError>;
    async fn deactivate_for(&mut self, person: PersonId) -> Result<(), AppError>;
    /// Move only active identities, leaving inactive tombstones with their original person.
    async fn move_to(&mut self, from: PersonId, to: PersonId) -> Result<(), AppError>;
}

#[async_trait]
pub trait ConversationRepo: Send + Sync {
    async fn get(&mut self, id: ConversationId) -> Result<Option<Conversation>, AppError>;
    async fn lock(&mut self, id: ConversationId) -> Result<Option<Conversation>, AppError>;
    async fn find(
        &mut self,
        person: PersonId,
        capability: CapabilityId,
    ) -> Result<Option<Conversation>, AppError>;
    /// Atomically create or reopen the person/capability conversation, preserving its existing
    /// executor and generation. The proposed id is used only for insertion. Requires
    /// last_inbound_at; clears snooze and returns the stored row.
    async fn upsert_on_inbound(
        &mut self,
        conversation: Conversation,
    ) -> Result<Conversation, AppError>;
    async fn update_state(
        &mut self,
        id: ConversationId,
        state: ConvState,
        outbound_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError>;
    /// Every handover, even to the same executor, increments generation atomically.
    async fn update_executor(
        &mut self,
        id: ConversationId,
        executor: Executor,
    ) -> Result<u32, AppError>;
    async fn list(
        &mut self,
        person: Option<PersonId>,
        limit: u32,
    ) -> Result<Vec<Conversation>, AppError>;
}

#[async_trait]
pub trait MessageRepo: Send + Sync {
    /// A replay of (conversation,external_id) returns None. A conflicting id is CONFLICT.
    async fn insert_if_new(&mut self, message: Message) -> Result<Option<MessageId>, AppError>;
    async fn list(
        &mut self,
        conversation: ConversationId,
        limit: u32,
    ) -> Result<Vec<Message>, AppError>;
    async fn set_status(
        &mut self,
        id: MessageId,
        status: MsgStatus,
        external_id: Option<String>,
        cost_minor: Option<i64>,
    ) -> Result<(), AppError>;
}

#[async_trait]
pub trait JourneyRepo: Send + Sync {
    async fn open_for(&mut self, person: PersonId) -> Result<Option<Journey>, AppError>;
    async fn latest_for(&mut self, person: PersonId) -> Result<Option<Journey>, AppError>;
    async fn lock(&mut self, id: JourneyId) -> Result<Option<Journey>, AppError>;
    /// Insert only initial New state (no closure, loss or attempts). Subsequent state is reducer-owned.
    async fn insert(&mut self, journey: Journey) -> Result<(), AppError>;
    /// Consume a reducer transition and persist its full patch and event atomically. A duplicate
    /// workspace event key is CONFLICT and changes nothing. Call reduce after locking the journey.
    /// Pass exactly the event and locked journey used for reduction; this is a trusted internal
    /// port, not a boundary accepting client-supplied patches or transitions.
    async fn apply_transition(
        &mut self,
        id: JourneyId,
        transition: Transition,
        event: JourneyEvent,
    ) -> Result<(), AppError>;
    async fn get(&mut self, id: JourneyId) -> Result<Option<Journey>, AppError>;
    async fn events(&mut self, id: JourneyId) -> Result<Vec<JourneyEvent>, AppError>;
}

#[async_trait]
pub trait TaskRepo: Send + Sync {
    async fn insert(&mut self, task: Task) -> Result<(), AppError>;
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<Task>, AppError>;
    async fn set_status(&mut self, id: TaskId, status: TaskStatus) -> Result<(), AppError>;
}
#[async_trait]
pub trait NoteRepo: Send + Sync {
    async fn insert(&mut self, note: Note) -> Result<(), AppError>;
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<Note>, AppError>;
}

/// Durable merge audit and the snapshot needed for guarded undo.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MergeRow {
    pub id: MergeId,
    pub workspace_id: WorkspaceId,
    pub source_id: PersonId,
    pub target_id: PersonId,
    pub decision: MergeDecision,
    pub conflicts: Vec<MergeConflict>,
    pub status: String,
    pub moved_snapshot: Value,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub applied_by: Option<UserId>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub undone_at: Option<OffsetDateTime>,
}
#[async_trait]
pub trait MergeRepo: Send + Sync {
    async fn insert(&mut self, row: MergeRow) -> Result<(), AppError>;
    async fn get(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError>;
    async fn lock(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError>;
    async fn list(&mut self, person: PersonId) -> Result<Vec<MergeRow>, AppError>;
    async fn mark_undone(&mut self, id: MergeId, at: OffsetDateTime) -> Result<(), AppError>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LostReasonRow {
    pub workspace_id: WorkspaceId,
    pub key: String,
    pub label: String,
    pub active: bool,
    pub seeded: bool,
}
#[async_trait]
pub trait LostReasonRepo: Send + Sync {
    /// Idempotent registration-time initialization; never overwrites edited defaults.
    async fn initialize(&mut self) -> Result<(), AppError>;
    async fn list(&mut self) -> Result<Vec<LostReasonRow>, AppError>;
    /// Insert or edit a dictionary entry; a previously seeded entry retains its seeded marker.
    async fn set(&mut self, row: LostReasonRow) -> Result<(), AppError>;
}

/// Completion of a claimed event, including a namespaced consumer's deferred disposition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsumptionOutcome {
    pub consumed_at: OffsetDateTime,
    pub outcome: String,
}
#[async_trait]
pub trait ConsumptionRepo: Send + Sync {
    /// Claim within the same transaction as the effects. False on a duplicate. Rollback removes
    /// the claim, permitting retry. Always record before committing; never commit an empty claim.
    async fn try_claim(
        &mut self,
        consumer: &str,
        event_id: InboundEventId,
    ) -> Result<bool, AppError>;
    async fn record(
        &mut self,
        consumer: &str,
        event_id: InboundEventId,
        outcome: ConsumptionOutcome,
    ) -> Result<(), AppError>;
}

#[async_trait]
pub trait RequestKeyRepo: Send + Sync {
    /// Live strictly before at+24h. The supplied time comes from the application's clock.
    async fn get(&mut self, key: &str, now: OffsetDateTime) -> Result<Option<Value>, AppError>;
    /// First writer wins until expiry; an expired entry is replaced atomically. False means
    /// the caller must roll back any effects and return the existing response.
    async fn store(
        &mut self,
        key: &str,
        response: Value,
        now: OffsetDateTime,
    ) -> Result<bool, AppError>;
}

/// Durable outbound intent. Sending/recovery state transitions belong to the send use cases.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OutboxRow {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    pub conversation_id: ConversationId,
    pub message_id: MessageId,
    pub capability_id: CapabilityId,
    pub intent: Value,
    pub expected_generation: u32,
    pub fence_snapshot: Option<Value>,
    pub state: String,
    pub attempts: u32,
    pub last_error: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}
#[async_trait]
pub trait OutboxRepo: Send + Sync {
    async fn insert(&mut self, row: OutboxRow) -> Result<(), AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<OutboxRow>, AppError>;
    async fn lock(&mut self, id: Uuid) -> Result<Option<OutboxRow>, AppError>;
    async fn list_pending(
        &mut self,
        state: &str,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<OutboxRow>, AppError>;
    /// Update only processing state; identity, intent and relationships stay immutable.
    async fn update(&mut self, row: OutboxRow) -> Result<(), AppError>;
}
