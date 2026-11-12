//! Mail files' persistence (spec 2026-10-30-leads-pool-outreach-design.md §3.15, §4.4, §6.1): one
//! row per email attachment Jeeta keeps or decided not to keep (`0028_mail_files`). The bytes live
//! in the file store (`ports::files::FileStore`) under the row's id; the row holds what the inbox
//! shows of them and where they belong.
//!
//! An inbound file is recorded when its email is polled (`stored`, or `skipped` with a reason when
//! a cap refused it) and linked to its message and person when the email is consumed; an outbound
//! file is uploaded `staged`, with an expiry, and becomes `attached` to the one message that
//! carries it. A file whose bytes went (retention, erasure) stays as a `deleted` row.
//!
//! Contracts every adapter keeps beyond the module's:
//! - An inbound row names its mailbox and its email's event (`capability_id`,
//!   `event_external_id`) and is `stored`, `skipped` or `deleted`; an outbound one is `staged`,
//!   `attached` or `deleted`. A skip reason is there exactly when the row is `skipped`, a deletion
//!   time exactly when it is `deleted`; a row that holds bytes has its hash, a staged one its
//!   expiry, an attached one its message. A row that breaks this, or names a capability, message
//!   or person of no row of the workspace, is `INTERNAL`; a taken id is `CONFLICT`.
//! - Rows only move forward: `staged` → `attached`, and any row holding bytes → `deleted`.
//! - The repositories never read a clock: every time comes from the caller.

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::{MessageId, PersonId};
use jt_studio::FileId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::AppError;

/// The most rows one [`MailFileRepo::due_for_purge`] returns.
pub const MAX_MAIL_FILE_PAGE: u32 = 500;

/// Whether a file came in with an email or goes out with one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailFileDirection {
    Inbound,
    Outbound,
}

impl MailFileDirection {
    pub const ALL: [MailFileDirection; 2] =
        [MailFileDirection::Inbound, MailFileDirection::Outbound];

    /// The stored key (`mail_files.direction`).
    pub fn key(self) -> &'static str {
        match self {
            MailFileDirection::Inbound => "inbound",
            MailFileDirection::Outbound => "outbound",
        }
    }

    pub fn parse(key: &str) -> Option<MailFileDirection> {
        Self::ALL.into_iter().find(|d| d.key() == key)
    }
}

/// Where a mail file stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailFileState {
    /// An inbound file the store holds.
    Stored,
    /// An uploaded outbound file not yet attached to a message; it expires.
    Staged,
    /// An outbound file attached to its one message.
    Attached,
    /// An inbound file a cap refused: the store never held it.
    Skipped,
    /// A file whose bytes went (retention, expiry, erasure); the row stays.
    Deleted,
}

impl MailFileState {
    pub const ALL: [MailFileState; 5] = [
        MailFileState::Stored,
        MailFileState::Staged,
        MailFileState::Attached,
        MailFileState::Skipped,
        MailFileState::Deleted,
    ];

    /// The stored key (`mail_files.state`).
    pub fn key(self) -> &'static str {
        match self {
            MailFileState::Stored => "stored",
            MailFileState::Staged => "staged",
            MailFileState::Attached => "attached",
            MailFileState::Skipped => "skipped",
            MailFileState::Deleted => "deleted",
        }
    }

    pub fn parse(key: &str) -> Option<MailFileState> {
        Self::ALL.into_iter().find(|s| s.key() == key)
    }

    /// Whether a row in this state stands for bytes the store holds.
    pub fn holds_bytes(self) -> bool {
        matches!(
            self,
            MailFileState::Stored | MailFileState::Staged | MailFileState::Attached
        )
    }
}

/// Why an inbound file was not kept (`mail_files.skip_reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// Larger than one file may be.
    FileTooLarge,
    /// Past the most files one email keeps.
    TooManyFiles,
    /// Past the bytes a workspace keeps in a day.
    DailyLimit,
}

impl SkipReason {
    pub const ALL: [SkipReason; 3] = [
        SkipReason::FileTooLarge,
        SkipReason::TooManyFiles,
        SkipReason::DailyLimit,
    ];

    /// The stored key.
    pub fn key(self) -> &'static str {
        match self {
            SkipReason::FileTooLarge => "file_too_large",
            SkipReason::TooManyFiles => "too_many_files",
            SkipReason::DailyLimit => "daily_limit",
        }
    }

    pub fn parse(key: &str) -> Option<SkipReason> {
        Self::ALL.into_iter().find(|r| r.key() == key)
    }
}

/// One mail file (`mail_files`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailFileRow {
    /// The file store's id of the bytes.
    pub id: FileId,
    pub direction: MailFileDirection,
    pub state: MailFileState,
    /// Exactly when `skipped`.
    pub skip_reason: Option<SkipReason>,
    /// The mailbox an inbound file came in on.
    pub capability_id: Option<CapabilityId>,
    /// The inbound event of the email an inbound file came in (`inbound_events.external_id`).
    pub event_external_id: Option<String>,
    /// The message the file came with or goes with, once known.
    pub message_id: Option<MessageId>,
    /// The person the message is from or to, once known.
    pub person_id: Option<PersonId>,
    /// The name the email gave the file (at most 255 characters); blank once erased.
    pub filename: String,
    /// The type the email or the uploader gave the file; the store keeps every mail file as
    /// `application/octet-stream`.
    pub declared_mime: String,
    pub size_bytes: u64,
    /// The bytes' SHA-256 (lowercase hex) when the store held them.
    pub sha256: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// When a staged file expires unused.
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
    /// When the bytes went.
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
}

/// Whether `row` keeps the rules of the module docs (the adapters refuse one that does not).
pub fn mail_file_row_valid(row: &MailFileRow) -> bool {
    let state_fits = match row.direction {
        MailFileDirection::Inbound => {
            matches!(
                row.state,
                MailFileState::Stored | MailFileState::Skipped | MailFileState::Deleted
            ) && row.capability_id.is_some()
                && row.event_external_id.is_some()
        }
        MailFileDirection::Outbound => matches!(
            row.state,
            MailFileState::Staged | MailFileState::Attached | MailFileState::Deleted
        ),
    };
    let hash_ok = row.sha256.as_deref().is_none_or(|h| {
        h.len() == 64
            && h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    state_fits
        && (row.state == MailFileState::Skipped) == row.skip_reason.is_some()
        && (row.state == MailFileState::Deleted) == row.deleted_at.is_some()
        && (!row.state.holds_bytes() || row.sha256.is_some())
        && (row.state != MailFileState::Staged || row.expires_at.is_some())
        && (row.state != MailFileState::Attached || row.message_id.is_some())
        && row.filename.chars().count() <= 255
        && row.declared_mime.chars().count() <= 255
        && i64::try_from(row.size_bytes).is_ok()
        && hash_ok
}

#[async_trait]
pub trait MailFileRepo: Send + Sync {
    /// Stores `row`.
    async fn insert(&mut self, row: MailFileRow) -> Result<(), AppError>;
    async fn get(&mut self, id: FileId) -> Result<Option<MailFileRow>, AppError>;
    /// [`MailFileRepo::get`], with the row locked until the bundle ends.
    async fn lock(&mut self, id: FileId) -> Result<Option<MailFileRow>, AppError>;
    /// Links the inbound rows of email event `event_external_id` on `capability` that name no
    /// message yet to `message` and `person`; answers how many.
    async fn link_event_to_message(
        &mut self,
        capability: CapabilityId,
        event_external_id: &str,
        message: MessageId,
        person: PersonId,
    ) -> Result<u32, AppError>;
    /// Attaches the `staged` rows among `ids` to `message` to `person`: `attached`, their message
    /// and person set, their expiry cleared. Answers how many (a row that is not staged is left
    /// as it is).
    async fn attach(
        &mut self,
        ids: &[FileId],
        message: MessageId,
        person: PersonId,
    ) -> Result<u32, AppError>;
    /// Every row of `messages` (a page of a conversation's messages: at most a few thousand
    /// rows, an email keeping at most twenty files), oldest first.
    async fn for_messages(&mut self, messages: &[MessageId]) -> Result<Vec<MailFileRow>, AppError>;
    /// At most `limit` (capped at [`MAX_MAIL_FILE_PAGE`]) rows whose bytes are due to go, oldest
    /// first: `stored` inbound files created at `inbound_before` or earlier, and `staged` files
    /// whose expiry is at `now` or earlier.
    async fn due_for_purge(
        &mut self,
        inbound_before: OffsetDateTime,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<MailFileRow>, AppError>;
    /// Marks the rows among `ids` that hold bytes `deleted` at `at` (their names kept); answers
    /// how many.
    async fn mark_deleted(&mut self, ids: &[FileId], at: OffsetDateTime) -> Result<u32, AppError>;
    /// A person's erasure (spec §3.15): every row of `person`, of the people merged into them (and
    /// into those, transitively), and of their conversations' messages, loses its name, and a row
    /// holding bytes becomes `deleted` at `at`. Answers the ids whose bytes the caller deletes
    /// once the bundle commits.
    async fn erase_person(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError>;
    /// [`MailFileRepo::erase_person`] for the inbound rows of email event `event_external_id` on
    /// `capability` that no message holds: an email the consumer made no message of (its sender
    /// erased, a duplicate, ...; D108). A row linked to a message is left as it is.
    async fn erase_event(
        &mut self,
        capability: CapabilityId,
        event_external_id: &str,
        at: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError>;
    /// The ids among `ids` whose rows hold bytes: the files the store keeps for mail.
    async fn kept(&mut self, ids: &[FileId]) -> Result<Vec<FileId>, AppError>;
    /// The bytes of the inbound files stored (held, then or still) since `since`.
    async fn inbound_bytes_since(&mut self, since: OffsetDateTime) -> Result<u64, AppError>;
}
