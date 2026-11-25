//! Chat media's persistence (`0055_message_media`, `usecases::inbox::media`): one row per image or
//! document a chat message carries. The bytes live in the file store (`ports::files::FileStore`)
//! under the row's `file_id`; the row holds what the inbox shows of them and where they stand.
//!
//! A customer's file (`inbound`, from the `provider`) is recorded `pending` with the provider's
//! media id when its message is consumed, then `stored` once the media job fetched and checked it,
//! or `failed` with why. A file whose bytes went (retention, erasure) stays as a `deleted` row,
//! without its name or media id.
//!
//! Contracts every adapter keeps beyond the module's ([`media_row_valid`]):
//! - A message holds at most one row per position (0 to [`MAX_MEDIA_PER_MESSAGE`] - 1);
//!   [`MessageMediaRepo::insert_if_new`] answers `false` for a taken one and writes nothing.
//! - A row names a message and a capability of its workspace; one that names none, or breaks the
//!   rules, is `INTERNAL`; a taken id is `CONFLICT`.
//! - The repositories never read a clock: every time comes from the caller.

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::{MessageId, PersonId};
use jt_studio::FileId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// The most files one chat message carries here (`message_media.position`).
pub const MAX_MEDIA_PER_MESSAGE: u8 = 10;
/// The most rows one page read ([`MessageMediaRepo::due`], [`MessageMediaRepo::due_for_purge`])
/// returns.
pub const MAX_MEDIA_PAGE: u32 = 200;
/// The longest provider media id kept.
pub const MAX_PROVIDER_MEDIA_ID: usize = 256;

macro_rules! keyed {
    ($(#[$doc:meta])* $name:ident { $($(#[$vdoc:meta])* $variant:ident => $key:literal),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($(#[$vdoc])* $variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The stored key.
            pub fn key(self) -> &'static str {
                match self {
                    $($name::$variant => $key),+
                }
            }

            pub fn parse(key: &str) -> Option<$name> {
                Self::ALL.iter().copied().find(|v| v.key() == key)
            }
        }
    };
}

keyed!(
    /// What a file is: an image shown in the thread, or a document handed out as a download.
    MediaKind {
        Image => "image",
        Document => "document",
    }
);

keyed!(
    /// Whether the file came from the customer or goes out with one of our messages.
    MediaDirection {
        Inbound => "inbound",
        Outbound => "outbound",
    }
);

keyed!(
    /// Where the bytes come from.
    MediaSource {
        /// The provider's media API (a customer's file).
        Provider => "provider",
        /// A file the team uploaded to send.
        Upload => "upload",
        /// A material of the library: its file is the library's, never deleted from here.
        Material => "material",
    }
);

keyed!(
    /// Where a file stands.
    MediaState {
        /// Waiting to be fetched from the provider.
        Pending => "pending",
        /// Held by the file store.
        Stored => "stored",
        /// Never held: see the reason.
        Failed => "failed",
        /// Its bytes went (retention, erasure); the row stays.
        Deleted => "deleted",
    }
);

keyed!(
    /// Why a file is not (or no longer) there to open.
    MediaReason {
        /// The provider no longer serves it (its media expired or is gone).
        Expired => "expired",
        /// Larger than a file of its kind may be.
        TooLarge => "too_large",
        /// Its bytes are not a type the inbox takes.
        NotAllowed => "not_allowed",
        /// An image of more pixels (or a longer side) than is decoded.
        TooManyPixels => "too_many_pixels",
        /// It could not be fetched (the provider failed every attempt, or the capability's
        /// credential is gone).
        Unavailable => "unavailable",
        /// Past the bytes a workspace keeps in a day.
        DailyLimit => "daily_limit",
        /// The person was erased.
        Erased => "erased",
        /// Kept as long as the retention allows, then deleted.
        Retention => "retention",
    }
);

impl MediaReason {
    /// Whether a `failed` row may give this reason (the others are a `deleted` row's).
    pub fn fails(self) -> bool {
        !matches!(self, MediaReason::Erased | MediaReason::Retention)
    }
}

/// One file of a chat message (`message_media`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageMediaRow {
    pub id: Uuid,
    pub message_id: MessageId,
    /// Its place among the message's files, from 0.
    pub position: u8,
    /// The capability the message came in or goes out on.
    pub capability_id: CapabilityId,
    pub direction: MediaDirection,
    pub kind: MediaKind,
    pub source: MediaSource,
    /// The library's material, for a [`MediaSource::Material`] file.
    pub material_id: Option<Uuid>,
    /// The file store's id of the bytes, once held.
    pub file_id: Option<FileId>,
    /// The provider's id of the file while it may be fetched; `None` once held, refused or erased.
    pub provider_media_id: Option<String>,
    /// The type the provider (or the uploader) named: never trusted.
    pub declared_mime: String,
    /// The type its bytes are, once held.
    pub mime: Option<String>,
    /// A document's name; blank for an image and once erased.
    pub filename: String,
    pub size_bytes: Option<u64>,
    /// The bytes' SHA-256 (lowercase hex) once held.
    pub sha256: Option<String>,
    /// An image's size in pixels, once held.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub state: MediaState,
    /// Exactly when `failed` or `deleted`.
    pub reason: Option<MediaReason>,
    /// The fetches tried so far.
    pub attempts: u32,
    /// When a pending file may be fetched (again): `None` at once.
    pub next_attempt_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub stored_at: Option<OffsetDateTime>,
    pub deleted_at: Option<OffsetDateTime>,
}

impl MessageMediaRow {
    /// Whether the file store holds this row's bytes for the inbox: a stored customer's file
    /// (from the provider). A file the team sent (an upload or a library material) is the
    /// business's own and is kept by its own record.
    pub fn owns_bytes(&self) -> bool {
        self.state == MediaState::Stored && self.source == MediaSource::Provider
    }
}

/// Whether `row` keeps the rules of the migration's checks (the adapters refuse one that does
/// not).
pub fn media_row_valid(row: &MessageMediaRow) -> bool {
    let hash_ok = row.sha256.as_deref().is_none_or(|h| {
        h.len() == 64
            && h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    let source_ok = match row.direction {
        MediaDirection::Inbound => row.source == MediaSource::Provider,
        MediaDirection::Outbound => {
            matches!(row.source, MediaSource::Upload | MediaSource::Material)
        }
    };
    let reason_ok = match (row.state, row.reason) {
        (MediaState::Pending | MediaState::Stored, None) => true,
        (MediaState::Failed, Some(r)) => r.fails(),
        (MediaState::Deleted, Some(r)) => !r.fails(),
        _ => false,
    };
    row.position < MAX_MEDIA_PER_MESSAGE
        && source_ok
        && (row.source == MediaSource::Material) == row.material_id.is_some()
        && (row.state != MediaState::Pending || row.provider_media_id.is_some())
        && (row.state != MediaState::Stored
            || (row.file_id.is_some()
                && row.sha256.is_some()
                && row.size_bytes.is_some()
                && row.mime.is_some()
                && row.stored_at.is_some()))
        && reason_ok
        && (row.state == MediaState::Deleted) == row.deleted_at.is_some()
        && row
            .provider_media_id
            .as_deref()
            .is_none_or(|id| !id.is_empty() && id.chars().count() <= MAX_PROVIDER_MEDIA_ID)
        && row.declared_mime.chars().count() <= 255
        && row.mime.as_deref().is_none_or(|m| m.chars().count() <= 255)
        && row.filename.chars().count() <= 255
        && row.size_bytes.is_none_or(|s| i64::try_from(s).is_ok())
        && row.width.is_none_or(|w| w > 0 && i32::try_from(w).is_ok())
        && row.height.is_none_or(|h| h > 0 && i32::try_from(h).is_ok())
        && i32::try_from(row.attempts).is_ok()
        && hash_ok
}

#[async_trait]
pub trait MessageMediaRepo: Send + Sync {
    /// Stores `row` and answers `true`, unless its message holds a row at its position: then
    /// nothing is written and the answer is `false`.
    async fn insert_if_new(&mut self, row: &MessageMediaRow) -> Result<bool, AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<MessageMediaRow>, AppError>;
    /// [`MessageMediaRepo::get`], with the row locked until the bundle ends.
    async fn lock(&mut self, id: Uuid) -> Result<Option<MessageMediaRow>, AppError>;
    /// Writes the row's file, types, name, size, hash, pixels, state, reason, attempts and times
    /// over the stored one (its message, position, capability, direction, kind and source stay).
    /// An unknown id is `NOT_FOUND`.
    async fn save(&mut self, row: &MessageMediaRow) -> Result<(), AppError>;
    /// Every row of `messages` (a page of a conversation's messages, each with at most
    /// [`MAX_MEDIA_PER_MESSAGE`] rows), by message and position.
    async fn for_messages(
        &mut self,
        messages: &[MessageId],
    ) -> Result<Vec<MessageMediaRow>, AppError>;
    /// The ids of at most `limit` (capped at [`MAX_MEDIA_PAGE`]) pending rows due at `now` (no
    /// next attempt time, or one not after `now`), oldest first.
    async fn due(&mut self, now: OffsetDateTime, limit: u32) -> Result<Vec<Uuid>, AppError>;
    /// At most `limit` (capped at [`MAX_MEDIA_PAGE`]) stored inbound rows stored at `before` or
    /// earlier, oldest first: the customer files past their retention.
    async fn due_for_purge(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<MessageMediaRow>, AppError>;
    /// The bytes of the inbound files stored at `since` or later.
    async fn inbound_bytes_since(&mut self, since: OffsetDateTime) -> Result<u64, AppError>;
    /// A person's erasure: every row of the messages of the conversations of `person` and of the
    /// people merged into them (transitively) loses its name and media id; a row not yet
    /// `deleted` becomes `deleted` at `at` (reason `erased`), its file and types cleared. Answers
    /// the file ids whose bytes the caller deletes once the bundle commits: the customer's own
    /// files ([`MessageMediaRow::owns_bytes`]), never a file the team sent.
    async fn erase_person(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError>;
    /// The ids among `ids` a stored row names: the files the store keeps for chat messages.
    async fn kept(&mut self, ids: &[FileId]) -> Result<Vec<FileId>, AppError>;
}
