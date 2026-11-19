//! The knowledge base's persistence (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4.2,
//! `0046_knowledge_base`): one settings row per workspace, the cards, their append-only history,
//! the notes and the proposals. The rules are `jt_knowledge`'s; this is where they are kept.
//!
//! Contracts every adapter keeps beyond the module's:
//! - Nothing here reads a clock: every time comes from the caller.
//! - The `lock_*` reads lock what they read until the bundle ends. A use case that changes a row
//!   reads it through its lock first, in the one order of design §4.10.13: the draft and the
//!   execution frame (`StrategyRepo`) when the write may write a frame, then
//!   [`KnowledgeRepo::lock_settings`], then the row it changes.
//! - An insert that meets a row it would duplicate is `CONFLICT` and leaves the transaction
//!   usable (`on conflict do nothing`): the settings of a workspace
//!   ([`KnowledgeRepo::insert_settings`] answers `false` instead), a card's id or key, a
//!   revision's id or its `(subject, card, revision)`, a note's id, a proposal's id or a second
//!   pending proposal of the same kind, card and body.
//! - A row the database's checks refuse (a text over its limit, a closed note without its close
//!   time, a decided proposal without its decision time, a revision of a card that is not the
//!   workspace's) is `INTERNAL`: the use cases check first.
//! - A save of a row that does not exist is `NOT_FOUND`.
//! - The history is append-only: there is no way here to change or remove a revision.

use async_trait::async_trait;
use jt_knowledge::{
    Card, KnowledgeCardId, KnowledgeNoteId, KnowledgeProposalId, KnowledgeSettings, Note,
    NoteStatus, Proposal, ProposalStatus, Revision, Subject,
};
use jt_tenancy::AgentConnectionId;
use time::OffsetDateTime;

use crate::error::AppError;

/// The knowledge base of the bundle's workspace.
#[async_trait]
pub trait KnowledgeRepo: Send + Sync {
    /// The settings; none before the workspace is seeded.
    async fn settings(&mut self) -> Result<Option<KnowledgeSettings>, AppError>;
    /// The settings, locked.
    async fn lock_settings(&mut self) -> Result<Option<KnowledgeSettings>, AppError>;
    /// Stores the settings of a workspace that has none, and answers `true`; answers `false`
    /// and writes nothing when the workspace has them already (a concurrent insert is waited
    /// for, and wins only if it commits). Whoever gets `true` seeds the workspace.
    async fn insert_settings(&mut self, settings: &KnowledgeSettings) -> Result<bool, AppError>;
    /// Replaces the settings whole.
    async fn save_settings(&mut self, settings: &KnowledgeSettings) -> Result<(), AppError>;

    /// Every card, removed ones too, by position (ties by creation, then id).
    async fn cards(&mut self) -> Result<Vec<Card>, AppError>;
    async fn card(&mut self, id: KnowledgeCardId) -> Result<Option<Card>, AppError>;
    /// The card, locked.
    async fn lock_card(&mut self, id: KnowledgeCardId) -> Result<Option<Card>, AppError>;
    async fn insert_card(&mut self, card: &Card) -> Result<(), AppError>;
    /// Replaces the card's title, body, attachments, position, revision, update and removal; its
    /// key and creation never change.
    async fn save_card(&mut self, card: &Card) -> Result<(), AppError>;

    /// Appends one revision row.
    async fn append_revision(&mut self, revision: &Revision) -> Result<(), AppError>;
    /// The revisions of `subject` (of `card_id` for a card's), newest first (by revision),
    /// before the revision `before` when given, at most `limit`.
    async fn revisions(
        &mut self,
        subject: Subject,
        card_id: Option<KnowledgeCardId>,
        before: Option<u64>,
        limit: u32,
    ) -> Result<Vec<Revision>, AppError>;

    /// The notes in `status` (every status when none), newest first (ties by id), at most
    /// `limit`.
    async fn notes(
        &mut self,
        status: Option<NoteStatus>,
        limit: u32,
    ) -> Result<Vec<Note>, AppError>;
    async fn note(&mut self, id: KnowledgeNoteId) -> Result<Option<Note>, AppError>;
    /// The note, locked.
    async fn lock_note(&mut self, id: KnowledgeNoteId) -> Result<Option<Note>, AppError>;
    async fn insert_note(&mut self, note: &Note) -> Result<(), AppError>;
    /// Replaces the note's status, claim, revision, close and outcome; its text, links, files and
    /// creation never change.
    async fn save_note(&mut self, note: &Note) -> Result<(), AppError>;

    /// The proposals in `status` (every status when none), newest first (ties by id).
    async fn proposals(
        &mut self,
        status: Option<ProposalStatus>,
    ) -> Result<Vec<Proposal>, AppError>;
    async fn proposal(&mut self, id: KnowledgeProposalId) -> Result<Option<Proposal>, AppError>;
    /// The proposal, locked.
    async fn lock_proposal(
        &mut self,
        id: KnowledgeProposalId,
    ) -> Result<Option<Proposal>, AppError>;
    async fn insert_proposal(&mut self, proposal: &Proposal) -> Result<(), AppError>;
    /// Replaces the proposal's status, decision and applied revision; what it proposes never
    /// changes.
    async fn save_proposal(&mut self, proposal: &Proposal) -> Result<(), AppError>;
    /// How many proposals the agent connection `connection` made at `since` or later, whatever
    /// became of them.
    async fn proposals_by(
        &mut self,
        connection: AgentConnectionId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// Marks every pending proposal whose `expires_at` is at or before `now` expired (decided at
    /// `now`, by nobody); how many.
    async fn expire_proposals(&mut self, now: OffsetDateTime) -> Result<u64, AppError>;
}
