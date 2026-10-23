//! Inbox persistence contracts. All reads and writes are tenant scoped. Missing mutation targets
//! return NOT_FOUND; duplicate keys return CONFLICT unless a method explicitly returns a boolean
//! or optional id. Locks last until the enclosing bundle commits or rolls back.

pub use super::compliance::*;

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
/// Fixed reducer stage keys accepted by workspace display labels.
pub const INBOX_STATUS_KEYS: &[&str] = &[
    "new",
    "contacted",
    "unreachable",
    "appointment",
    "met",
    "quoted",
    "pending",
    "won",
    "lost",
];
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
    /// Supply the application clock for aggregate writes in this transaction.
    async fn set_write_time(&mut self, at: OffsetDateTime) -> Result<(), AppError>;
    /// Serialize inbox matching/dictionary/event writes in this workspace until commit.
    /// Acquire before any person/journey locks, including from the inbound consumer.
    async fn lock_workspace(&mut self) -> Result<(), AppError>;
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

/// Filter before applying the cursor and page limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationQueue {
    #[default]
    Ours,
    Unassigned,
    Snoozed,
    All,
}

/// Send metadata deliberately separate from aggregate timestamps and public conversation DTOs.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationSendState {
    pub last_inbound_identity_id: Option<IdentityId>,
    /// Inbound/operator state changes only; never outbound message bookkeeping.
    pub activity_revision: i64,
}

#[async_trait]
pub trait ConversationRepo: Send + Sync {
    /// Create an outbound-only conversation without inbound activity. Existing pair is a conflict.
    async fn insert_for_send(&mut self, conversation: Conversation) -> Result<(), AppError>;
    async fn send_state(&mut self, id: ConversationId) -> Result<ConversationSendState, AppError>;
    /// Set Theirs/clear snooze only when no newer inbound/operator activity occurred. Always
    /// record the greatest outbound time. Does not advance activity_revision.
    async fn record_outbound(
        &mut self,
        id: ConversationId,
        expected_activity_revision: i64,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;

    /// Stable ascending (created_at,id) keyset page; queue filtering precedes the limit.
    async fn page(
        &mut self,
        queue: ConversationQueue,
        after: Option<(OffsetDateTime, ConversationId)>,
        limit: u32,
    ) -> Result<Vec<Conversation>, AppError>;
    /// All conversations for terminal/snooze effects, locked in id order; never page effects.
    async fn lock_for_person(&mut self, person: PersonId) -> Result<Vec<Conversation>, AppError>;
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
    /// Indexed workspace/capability lookup; provider ids are scoped to the messaging account.
    /// If historical duplicates exist across conversations, returns the earliest (at,id).
    async fn find_by_external_id(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<Message>, AppError>;
    /// At most two outbound messages with matching text, no external id and an outbox row
    /// in sending, or sent no earlier than five minutes before receipt. The recorded send_at
    /// must precede receipt; an earlier enqueue alone is not evidence that we sent the echo.
    /// Callers must defer ambiguous matches, never guess authorship. Hold the workspace lock.
    async fn echo_candidates(
        &mut self,
        conversation: ConversationId,
        body: &str,
        received_at: OffsetDateTime,
    ) -> Result<Vec<Message>, AppError>;

    /// Latest messages in chronological order.
    async fn recent(&mut self, id: ConversationId, limit: u32) -> Result<Vec<Message>, AppError>;
    /// Consumer contract: after a NEW inbound insert, call in the SAME transaction with the
    /// normalized/scoped identity that matched its sender. Stores sender_identity_id on the
    /// message and updates the conversation's last_inbound_identity_id only for its latest
    /// inbound (at,id). Older messages cannot replace the latest sender; replays are immutable.
    async fn record_inbound_sender(
        &mut self,
        message: MessageId,
        sender: IdentityId,
    ) -> Result<(), AppError>;

    async fn get(&mut self, id: MessageId) -> Result<Option<Message>, AppError>;
    /// Stable ascending (at,id) keyset page.
    async fn page(
        &mut self,
        conversation: ConversationId,
        after: Option<(OffsetDateTime, MessageId)>,
        limit: u32,
    ) -> Result<Vec<Message>, AppError>;
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
    /// All open journeys of a departing owner, without a page cap.
    async fn open_owned_by(&mut self, user: UserId) -> Result<Vec<Journey>, AppError>;
    /// Advances only when a reducer transition is persisted, never for notes/tasks/owner edits
    /// or historical receipts. Read while holding the journey lock.
    async fn reducer_revision(&mut self, id: JourneyId) -> Result<i64, AppError>;

    /// Append only a system Replied receipt whose original send predates newer journey changes.
    /// Records current from/to status, preserving every reducer-owned field; unique event key.
    async fn append_historical_reply(&mut self, event: JourneyEvent) -> Result<(), AppError>;

    /// Durable workspace-wide key lookup, including events on other journeys.
    async fn event_by_key(&mut self, key: &str) -> Result<Option<JourneyEvent>, AppError>;
    /// Change only the commission owner, never reducer-owned fields.
    async fn assign_owner(&mut self, id: JourneyId, owner: Option<UserId>) -> Result<(), AppError>;
    async fn open_for(&mut self, person: PersonId) -> Result<Option<Journey>, AppError>;
    async fn latest_for(&mut self, person: PersonId) -> Result<Option<Journey>, AppError>;
    async fn lock(&mut self, id: JourneyId) -> Result<Option<Journey>, AppError>;
    /// Persist only a domain-created initial journey; arbitrary stored rows are not creation proofs.
    async fn insert_initial(&mut self, initial: InitialJourney) -> Result<(), AppError>;
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
    async fn events(&mut self, id: JourneyId, limit: u32) -> Result<Vec<JourneyEvent>, AppError>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskQueue {
    #[default]
    #[serde(rename = "due_24h")]
    Due24h,
    Overdue,
    All,
}

#[async_trait]
pub trait TaskRepo: Send + Sync {
    async fn get(&mut self, id: TaskId) -> Result<Option<Task>, AppError>;
    /// Open tasks, ordered by (due_at,id), without a hidden page cap.
    async fn query(
        &mut self,
        queue: TaskQueue,
        assignee: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<Task>, AppError>;
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
/// Private restoration data: no message, note or identity text is copied into the ledger.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MergeSnapshot {
    /// Maximum timestamp of the locked aggregates; merge checkpoints must advance it.
    #[serde(with = "time::serde::rfc3339")]
    pub latest_write_at: OffsetDateTime,
    pub people: [PersonId; 2],
    pub version: u32,
    pub identities: Vec<IdentityParent>,
    pub journeys: Vec<JourneyParent>,
    pub conversations: Vec<Conversation>,
    pub messages: Vec<MessageParent>,
    pub tasks: Vec<TaskParent>,
    pub notes: Vec<NoteParent>,
    pub outbox: Vec<OutboxParent>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IdentityParent {
    pub id: IdentityId,
    pub person_id: PersonId,
    pub active: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JourneyParent {
    pub id: JourneyId,
    pub person_id: PersonId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageParent {
    pub id: MessageId,
    pub conversation_id: ConversationId,
    pub external_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TaskParent {
    pub id: TaskId,
    pub journey_id: JourneyId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NoteParent {
    pub id: NoteId,
    pub journey_id: JourneyId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OutboxParent {
    pub id: Uuid,
    pub conversation_id: ConversationId,
}

#[async_trait]
pub trait MergeRepo: Send + Sync {
    async fn list_all(&mut self) -> Result<Vec<MergeRow>, AppError>;
    /// Lock child aggregates in id order, after both people have been locked in id order.
    async fn snapshot(&mut self, a: PersonId, b: PersonId) -> Result<MergeSnapshot, AppError>;
    /// Move the snapshotted graph, preserving every message even when external IDs collide.
    async fn apply_snapshot(
        &mut self,
        snapshot: &MergeSnapshot,
        keep: PersonId,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// Called only after the app has checked time, confirmation and aggregate edit guards.
    async fn restore_snapshot(
        &mut self,
        snapshot: &MergeSnapshot,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    async fn edited_since(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    async fn save(&mut self, row: MergeRow) -> Result<(), AppError>;
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
    /// Replace only the matching response without extending the original 24-hour expiry.
    /// A completion for an expired/reused key cannot overwrite the new request's response.
    async fn complete(
        &mut self,
        key: &str,
        expected: Value,
        response: Value,
    ) -> Result<bool, AppError>;
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
    /// Set by merge when an in-flight/uncertain send moves; persists across undo and recovery.
    /// Receipt reconciliation remains valid but must never affect a conversation.
    #[serde(default)]
    pub conversation_merged: bool,
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

impl MergeSnapshot {
    /// Stable original-to-survivor mapping; the oldest conversation keeps its state/executor.
    pub fn conversation_targets(
        &self,
    ) -> std::collections::BTreeMap<ConversationId, ConversationId> {
        self.conversations
            .iter()
            .map(|c| {
                let keep = self
                    .conversations
                    .iter()
                    .filter(|other| other.capability_id == c.capability_id)
                    .min_by_key(|other| (other.created_at, other.id))
                    .expect("conversation itself");
                (c.id, keep.id)
            })
            .collect()
    }
}
