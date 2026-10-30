//! Public items' persistence (spec 2026-10-30-inbox-comments-marketplace-design.md §6.1): the
//! comments and marketplace questions the inbox answers, the posts and products they are about,
//! and where each polled surface's next poll starts. Re-exported from [`super::inbox`]; scoped and
//! answered like every inbox repo (see its module docs). An item holds ids, states and times
//! only: its text is its inbound message's.
//!
//! The database's bounds are an adapter's to keep: an external id of 1 to 512 characters, a
//! subject's title, links and facts within 0019's checks, and an item's conversation and subject
//! on its own capability; breaking one is a programming error (`INTERNAL`).

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::{
    ConversationId, MessageId, PublicItem, PublicItemId, PublicSubject, PublicSubjectId,
};
use serde_json::Value;
use time::OffsetDateTime;

use crate::error::AppError;

#[async_trait]
pub trait PublicItemRepo: Send + Sync {
    /// Stores a new item. `false`, and nothing written, when its capability already holds an item
    /// with the same external id (a replay). Its capability, conversation, message, and subject
    /// and private reply when set, must exist in the workspace (`NOT_FOUND`); its conversation
    /// and its subject must be on its capability, its external id 1 to
    /// [`jt_inbox::public::MAX_EXTERNAL_ID_CHARS`] characters (`INTERNAL`).
    async fn insert(&mut self, item: PublicItem) -> Result<bool, AppError>;
    async fn get(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError>;
    /// [`PublicItemRepo::get`], the row locked until the bundle ends.
    async fn lock(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError>;
    async fn find_by_external(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<PublicItem>, AppError>;
    /// The item whose inbound message (its latest revision) is `message`, if any.
    async fn item_for_message(
        &mut self,
        message: MessageId,
    ) -> Result<Option<PublicItem>, AppError>;
    /// Writes what changes over an item's life: its message (an edit's revision), subject,
    /// deadline, private-reply window, answer, moderation, private reply, `agent_answers`,
    /// `checked_at` and `updated_at`. The identity, the thread, `live` and the conversation stay
    /// (a merge moves items with its snapshot). `NOT_FOUND` when the item, or a message or subject
    /// it names, is missing; `INTERNAL` for a subject of another capability.
    async fn update(&mut self, item: PublicItem) -> Result<(), AppError>;
    /// A conversation's items, by `(created_at, id)`.
    async fn for_conversation(
        &mut self,
        conversation: ConversationId,
    ) -> Result<Vec<PublicItem>, AppError>;
    /// The items of one thread (every author's), by `(created_at, id)`, at most `limit` (clamped
    /// to `1..=MAX_INBOX_PAGE`).
    async fn thread(
        &mut self,
        capability: CapabilityId,
        root_external_id: &str,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError>;
    /// Items whose deadline is before `before` and whose answer is awaiting, rejected or pending,
    /// soonest deadline first (then id), at most `limit` (clamped to `1..=MAX_INBOX_PAGE`). Every
    /// such item, whatever its moderation and including those in review: a caller wanting the
    /// owed ones keeps those for which [`PublicItem::awaiting`] holds.
    async fn due_before(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError>;
    /// A capability's items whose answer is awaiting, rejected or pending, the least recently
    /// reconciled first (`checked_at` nulls first, then id), at most `limit` (clamped to
    /// `1..=MAX_INBOX_PAGE`). After [`PublicItemRepo::mark_checked`] the next call starts with
    /// the next ones: a sweep rotates, it never pins to the oldest N.
    async fn to_reconcile(
        &mut self,
        capability: CapabilityId,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError>;
    /// Sets `checked_at = at` on the workspace's items among `ids` (others are ignored);
    /// `updated_at` stays, so it remains the item's compare-and-swap version.
    async fn mark_checked(
        &mut self,
        ids: &[PublicItemId],
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
}

#[async_trait]
pub trait PublicSubjectRepo: Send + Sync {
    /// Stores a subject by its `(capability, external_id)`: a new one as given, a known one
    /// refreshed (kind, title, links, facts, `updated_at`) keeping its id, its `first_seen_at` and
    /// a publication link this write does not name. Returns what is stored. Its capability, and
    /// its Studio publication when set, must exist in the workspace (`NOT_FOUND`); its external
    /// id, title, links and facts must be within 0019's bounds (`INTERNAL`): callers cut a title
    /// to [`jt_inbox::public::MAX_SUBJECT_TITLE_CHARS`] and drop an over-long link.
    async fn upsert(&mut self, subject: PublicSubject) -> Result<PublicSubject, AppError>;
    async fn get(&mut self, id: PublicSubjectId) -> Result<Option<PublicSubject>, AppError>;
    async fn find_by_external(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<PublicSubject>, AppError>;
}

#[async_trait]
pub trait PublicCursorRepo: Send + Sync {
    /// Where the capability's next poll starts; `None` before its first poll.
    async fn get(&mut self, capability: CapabilityId) -> Result<Option<Value>, AppError>;
    /// Replaces the capability's cursor, a JSON object (`INTERNAL` otherwise). The capability must
    /// exist in the workspace (`NOT_FOUND`).
    async fn store(
        &mut self,
        capability: CapabilityId,
        cursor: Value,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
}
