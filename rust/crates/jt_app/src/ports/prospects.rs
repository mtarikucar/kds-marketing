//! The prospect pool's persistence (spec 2026-10-30-leads-pool-outreach-design.md §4.1, §6.1):
//! prospects with their dedupe keys and score history, research tasks, and the do-not-contact
//! blocklist of keyed hashes. The records and their rules are `jt_prospects`'s.
//!
//! Contracts every adapter keeps beyond the module's:
//! - A hard key (phone, email, Instagram, TikTok) belongs to at most one prospect of a workspace:
//!   a write that would give it a second one answers `DuplicateKey` naming the holder and writes
//!   nothing. Soft keys (domain, name_city) never conflict.
//! - The repositories never read a clock: `purge_after`, `updated_at` and every other time comes
//!   from the caller (the use case computes `purge_after` with `jt_prospects::purge_after`).
//! - A prospect's keys and scores go with it when it is deleted.
//! - Rows hold contact values: log ids and counts, never a row.

use async_trait::async_trait;
use jt_inbox::PersonId;
use jt_prospects::{
    Bucket, EntityKind, FieldName, Key, KeyKind, Promotion, Prospect, ProspectId, ProspectStatus,
    Reason, Recorder, ResearchTask, ResearchTaskId, ScoreSummary, TaskStatus,
};
use jt_strategy::StrategyVersionId;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// The most rows one [`ProspectRepo::list`], [`ProspectRepo::scores`] or
/// [`ResearchTaskRepo::list`] returns.
pub const MAX_PROSPECT_PAGE: u32 = 200;

/// What an insert did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Inserted {
    Ok,
    /// A hard key of the new prospect is another prospect's; nothing was written.
    DuplicateKey {
        kind: KeyKind,
        prospect_id: ProspectId,
    },
}

/// What a revision-checked write did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Updated {
    Ok,
    /// The stored revision is not the expected one; nothing was written.
    Stale,
    /// A hard key the write gives the prospect is another prospect's; nothing was written.
    DuplicateKey {
        kind: KeyKind,
        prospect_id: ProspectId,
    },
}

/// One score a prospect was given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ScoreRow {
    pub id: Uuid,
    pub prospect_id: ProspectId,
    pub score: u8,
    pub reasons: Vec<Reason>,
    pub rubric_digest: String,
    /// The approved strategy version whose rubric it was computed under; `None` for imported
    /// scores.
    pub strategy_version_id: Option<StrategyVersionId>,
    pub recorder: Recorder,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// Where a page of the pool's list ends: the last row's creation time and id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListCursor {
    pub created_at: OffsetDateTime,
    pub id: Uuid,
}

/// A page of rows, newest first; `next` names where the following page starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<ListCursor>,
}

/// Which prospects [`ProspectRepo::list`] reads: every filter given must hold. Ordered by
/// `(created_at desc, id desc)`; `after` continues from a page's `next`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProspectQuery {
    pub status: Option<ProspectStatus>,
    pub research_task_id: Option<ResearchTaskId>,
    /// The stored city, exactly.
    pub city: Option<String>,
    pub segment_key: Option<String>,
    /// The latest score's bucket; unscored prospects are in none.
    pub bucket: Option<Bucket>,
    /// `1..=MAX_PROSPECT_PAGE`.
    pub limit: u32,
    pub after: Option<ListCursor>,
}

/// A prospect as the pool's list shows it: its facts and which fields it holds, without values
/// of contact fields or their evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProspectRow {
    pub id: ProspectId,
    pub status: ProspectStatus,
    pub business_name: String,
    pub entity_kind: EntityKind,
    pub sector: Option<String>,
    pub city: Option<String>,
    pub district: Option<String>,
    pub country: String,
    pub language: Option<String>,
    pub segment_key: Option<String>,
    pub labels: Vec<String>,
    pub research_task_id: Option<ResearchTaskId>,
    pub latest_score: Option<ScoreSummary>,
    pub bucket: Option<Bucket>,
    /// The fields that hold a value.
    pub fields: Vec<FieldName>,
    pub promoted: Option<Promotion>,
    pub revision: u32,
    #[serde(with = "time::serde::rfc3339::option")]
    pub purge_after: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

impl ProspectRow {
    /// The list row of `p`.
    pub fn of(p: &Prospect) -> ProspectRow {
        ProspectRow {
            id: p.id,
            status: p.status,
            business_name: p.business_name.clone(),
            entity_kind: p.entity_kind,
            sector: p.sector.clone(),
            city: p.city.clone(),
            district: p.district.clone(),
            country: p.country.clone(),
            language: p.language.clone(),
            segment_key: p.segment_key.clone(),
            labels: p.labels.clone(),
            research_task_id: p.research_task_id,
            latest_score: p.latest_score.clone(),
            bucket: p
                .latest_score
                .as_ref()
                .map(|s| jt_prospects::bucket(s.score)),
            fields: p.field_names(),
            promoted: p.promoted.clone(),
            revision: p.revision,
            purge_after: p.purge_after,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}

/// Whether `p` passes every filter of `q` but the cursor and the limit: the one predicate both
/// adapters list by.
pub fn prospect_matches(p: &Prospect, q: &ProspectQuery) -> bool {
    q.status.is_none_or(|s| p.status == s)
        && q.research_task_id
            .is_none_or(|t| p.research_task_id == Some(t))
        && q.city.as_ref().is_none_or(|c| p.city.as_ref() == Some(c))
        && q.segment_key
            .as_ref()
            .is_none_or(|s| p.segment_key.as_ref() == Some(s))
        && q.bucket.is_none_or(|b| {
            p.latest_score
                .as_ref()
                .is_some_and(|s| jt_prospects::bucket(s.score) == b)
        })
}

/// The pool's prospects.
#[async_trait]
pub trait ProspectRepo: Send + Sync {
    /// Serialises the workspace's pool writes until commit (a transaction advisory lock). Taken
    /// after the inbox lock (`people().lock_workspace()`) when both are needed.
    async fn lock_pool(&mut self) -> Result<(), AppError>;
    /// Stores a new prospect with its keys. A hard key another prospect holds is
    /// `DuplicateKey` (the first in key order) and nothing is written; a taken id is `CONFLICT`.
    async fn insert(&mut self, p: &Prospect, keys: &[Key]) -> Result<Inserted, AppError>;
    /// Replaces the whole record (columns and data) and its keys when the stored revision is
    /// `expected_revision`; the stored revision becomes `expected_revision + 1` (the revision
    /// `jt_prospects::apply_update` gives `p`). `NOT_FOUND` when no such prospect.
    async fn update(
        &mut self,
        p: &Prospect,
        keys: &[Key],
        expected_revision: u32,
    ) -> Result<Updated, AppError>;
    async fn get(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError>;
    /// [`ProspectRepo::get`], holding the row until commit.
    async fn lock(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError>;
    /// The prospects `q` selects, at most `q.limit` (capped at [`MAX_PROSPECT_PAGE`]).
    async fn list(&mut self, q: &ProspectQuery) -> Result<Page<ProspectRow>, AppError>;
    /// Every prospect holding one of `keys` (hard or soft), with the kind it holds it by;
    /// ordered by kind, then prospect id, each pair once.
    async fn find_by_keys(&mut self, keys: &[Key]) -> Result<Vec<(KeyKind, ProspectId)>, AppError>;
    /// The keys a prospect holds now, in key order.
    async fn keys_of(&mut self, id: ProspectId) -> Result<Vec<Key>, AppError>;
    /// Appends a score and makes it the prospect's latest, in one call. Neither the revision nor
    /// `updated_at` moves: a score is not an edit. `NOT_FOUND` when no such prospect.
    async fn record_score(&mut self, row: &ScoreRow) -> Result<(), AppError>;
    /// The prospect's scores, newest first, at most `limit`.
    async fn scores(&mut self, id: ProspectId, limit: u32) -> Result<Vec<ScoreRow>, AppError>;
    /// Sets the status, the decision (`None` clears it), `purge_after` and `updated_at = at`
    /// when the stored revision is `expected_revision`, which then moves one up. Keys stay.
    /// `NOT_FOUND` when no such prospect.
    async fn set_status(
        &mut self,
        id: ProspectId,
        status: ProspectStatus,
        decision: Option<&jt_prospects::Decision>,
        purge_after: Option<OffsetDateTime>,
        at: OffsetDateTime,
        expected_revision: u32,
    ) -> Result<Updated, AppError>;
    /// Marks the prospect promoted to `promotion`'s person and journey: status `promoted`, no
    /// purge time, the revision one up, `updated_at = promotion.at`. Keys stay (the pool's own
    /// "duplicate" answer). `NOT_FOUND` when no such prospect.
    async fn set_promoted(&mut self, id: ProspectId, promotion: &Promotion)
    -> Result<(), AppError>;
    /// The prospect promoted to `person`, if any.
    async fn by_person(&mut self, person: PersonId) -> Result<Option<Prospect>, AppError>;
    /// Deletes the prospect with its keys and scores; the keys it held. Empty when no such
    /// prospect.
    async fn delete(&mut self, id: ProspectId) -> Result<Vec<Key>, AppError>;
    /// Prospects whose `purge_after` is at or before `now`, earliest first, at most `limit`.
    async fn due_for_purge(
        &mut self,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ProspectId>, AppError>;
    /// Prospects created in `[from, to)`: all of the workspace's, or `task`'s only.
    async fn created_between(
        &mut self,
        task: Option<ResearchTaskId>,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// Prospects promoted in `[from, to)`.
    async fn promoted_between(
        &mut self,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// `new` prospects without a score under `digest`.
    async fn count_unscored(&mut self, digest: &str) -> Result<u32, AppError>;
    /// `qualified` prospects (none of which is promoted yet: promotion moves the status).
    async fn count_qualified_unpromoted(&mut self) -> Result<u32, AppError>;
    /// `new` and `qualified` prospects of `segment_key`.
    async fn backlog(&mut self, segment_key: &str) -> Result<u32, AppError>;
}

/// Which research tasks [`ResearchTaskRepo::list`] reads, newest first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResearchTaskQuery {
    pub status: Option<TaskStatus>,
    /// `1..=MAX_PROSPECT_PAGE`.
    pub limit: u32,
    pub after: Option<ListCursor>,
}

/// The workspace's research tasks.
#[async_trait]
pub trait ResearchTaskRepo: Send + Sync {
    /// Stores a task. `false` (nothing written) when it is a standing task and its ICP entry
    /// already has an open one for the same strategy version; a taken id is `CONFLICT`; a
    /// strategy version not of the workspace is `NOT_FOUND`.
    async fn insert(&mut self, t: &ResearchTask) -> Result<bool, AppError>;
    async fn get(&mut self, id: ResearchTaskId) -> Result<Option<ResearchTask>, AppError>;
    /// [`ResearchTaskRepo::get`], holding the row until commit.
    async fn lock(&mut self, id: ResearchTaskId) -> Result<Option<ResearchTask>, AppError>;
    async fn list(&mut self, q: &ResearchTaskQuery) -> Result<Page<ResearchTask>, AppError>;
    /// The open standing tasks of strategy version `version`.
    async fn open_standing(
        &mut self,
        version: StrategyVersionId,
    ) -> Result<Vec<ResearchTask>, AppError>;
    /// Moves the task to `status`: closed (`closed_at = at`, `close_note = note`) unless it is
    /// `open`. `NOT_FOUND` when no such task.
    async fn set_status(
        &mut self,
        id: ResearchTaskId,
        status: TaskStatus,
        at: OffsetDateTime,
        note: &str,
    ) -> Result<(), AppError>;
    /// Sets (or with `None` clears) the task's advisory claim. `NOT_FOUND` when no such task.
    async fn set_claim(
        &mut self,
        id: ResearchTaskId,
        claim: Option<&jt_prospects::Claim>,
    ) -> Result<(), AppError>;
}

/// Why a key is on the blocklist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockReason {
    /// A purged rejection, remembered until its expiry so agents do not record it again.
    Rejected,
    /// The business objected (or the law says so); a human manager may lift it.
    DoNotContact,
    /// The business's data was erased; never lifted.
    Erased,
}

impl BlockReason {
    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            BlockReason::Rejected => "rejected",
            BlockReason::DoNotContact => "do_not_contact",
            BlockReason::Erased => "erased",
        }
    }

    /// The reason with this key, if any.
    pub fn parse(key: &str) -> Option<BlockReason> {
        [
            BlockReason::Rejected,
            BlockReason::DoNotContact,
            BlockReason::Erased,
        ]
        .into_iter()
        .find(|r| r.key() == key)
    }
}

/// Whether `hash` is a key hash as stored: 64 lowercase hex digits.
pub fn is_key_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The workspace's do-not-contact blocklist: keyed hashes, never values.
#[async_trait]
pub trait BlocklistRepo: Send + Sync {
    /// The reason `(kind, hash)` is blocked at `now`, if it is: a rejection only until it
    /// expires.
    async fn contains(
        &mut self,
        kind: KeyKind,
        hash: &str,
        now: OffsetDateTime,
    ) -> Result<Option<BlockReason>, AppError>;
    /// Blocks `(kind, hash)`. A stronger reason replaces a weaker one (rejected < do-not-contact
    /// < erased; a replaced rejection loses its expiry); a weaker one changes nothing, except
    /// that a second rejection keeps the later expiry. A rejection carries `expires_at`, the
    /// others none, and `hash` is 64 lowercase hex digits: anything else is `INTERNAL`.
    async fn insert(
        &mut self,
        kind: KeyKind,
        hash: &str,
        reason: BlockReason,
        at: OffsetDateTime,
        expires_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError>;
    /// Removes a do-not-contact entry; `false` (nothing changed) for an erased or rejected one,
    /// or none.
    async fn lift(&mut self, kind: KeyKind, hash: &str) -> Result<bool, AppError>;
    /// Deletes the rejections that expired at or before `now`; how many.
    async fn purge_expired(&mut self, now: OffsetDateTime) -> Result<u64, AppError>;
}
