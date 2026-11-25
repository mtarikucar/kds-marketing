//! Chat media (migration `0055_message_media`): the images and documents customers send on a chat
//! channel (WhatsApp Cloud today), kept so the people and agents who read a conversation see them.
//!
//! - **Recorded with the message, fetched apart.** When the consumer stores a customer's image or
//!   document message it records the file `pending` with the provider's media id
//!   (`record_inbound`), in the message's own transaction and without calling the provider: an
//!   inbound message is never held up by its file. The `inbox_media` job ([`run_workspace`])
//!   fetches it through the provider's media API by that id, with the capability's own credential
//!   (`MessagingSender::fetch_media`: no address from a webhook is ever followed), outside any
//!   transaction, retrying a failure after a backoff ([`BACKOFF_MINUTES`], at most
//!   [`MAX_ATTEMPTS`] attempts).
//! - **Checked by its bytes.** The declared type is never trusted: an image must be a JPEG, PNG
//!   or WebP by its first bytes, at most [`MAX_IMAGE_BYTES`], at most [`MAX_SIDE`] pixels on a side
//!   and [`MAX_PIXELS`] in all (read from its header, never decoded); a document a PDF, an image,
//!   or an Office file (a ZIP the provider names as one), at most [`MAX_DOCUMENT_BYTES`]
//!   ([`check`]). A workspace keeps at most [`MAX_DAILY_BYTES`] of customers' files a day (a file past it waits, its media id kept). What is
//!   refused is recorded `failed` with why, never stored.
//! - **Kept, then let go.** A stored image keeps its type in the file store (shown inline, through
//!   a short-lived signed address of the workspace's own); a document is kept as
//!   `application/octet-stream` and only ever handed out as a download. A customer's file goes
//!   [`RETENTION`] after it was stored (the inbound attachments' retention, design 2026-10-30
//!   D21/D26), with the person's erasure, or with the store's sweep once no row keeps it. The row
//!   stays `deleted`, so the thread says the file was there and why it is gone.
//! - **Opened under the conversation's permission, recorded.** [`open`] answers a file of a
//!   message to whoever may read the conversation (`inbox.work`): to the panel a signed address
//!   that lives [`URL_MINUTES`] minutes, to an agent the image itself (at most
//!   [`MAX_IMAGE_BYTES`]) or a document's address. Each opening writes `inbox.media.opened`.
//!   A file that is not there to open is `CONFLICT` `media_unavailable`, saying why.
//! - **Older messages.** A WhatsApp image or document message stored before this release has no
//!   row; the first read of its page records one when its event still names the media id
//!   (`backfill`), and the job fetches it if the provider still serves it (`failed` `expired`
//!   when it does not).
//!
//! No log line, ledger entry or error names a file, an address, a token or a media id: codes only.

use std::time::Duration as StdDuration;

use base64::Engine as _;
use jt_capability::{Capability, CapabilityId, StoredStatus};
use jt_connector::ConnectorError;
use jt_inbox::{Direction, Message, MessageId};
use jt_studio::FileId;
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::attachments::{AttachmentKind, AttachmentState, AttachmentView};
use super::consumer::{DOCUMENT_MARKER, IMAGE_MARKER};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::connectors::MediaUpload;
use crate::ports::mail_files::MailFileRow;
use crate::ports::message_media::{
    MAX_PROVIDER_MEDIA_ID, MediaDirection, MediaKind, MediaReason, MediaSource, MediaState,
    MessageMediaRow,
};
use crate::ports::reply_model::ImageType;
use crate::usecases::Deps;
use crate::usecases::connector::{adapter_public, open_credential};
use crate::usecases::files::OCTET_STREAM;

/// The most bytes a customer's image may hold: WhatsApp's own limit for an image, and what an
/// agent is handed as image content.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// The most bytes a customer's document may hold here: an email attachment's limit.
pub const MAX_DOCUMENT_BYTES: u64 = super::attachments::MAX_INBOUND_FILE_BYTES;
/// The longest side an image may have, in pixels.
pub const MAX_SIDE: u32 = 12_000;
/// The most pixels an image may have in all (width times height).
pub const MAX_PIXELS: u64 = 40_000_000;
/// The most bytes of customers' chat files a workspace keeps in a day (the 24 hours before).
pub const MAX_DAILY_BYTES: u64 = super::attachments::MAX_INBOUND_DAILY_BYTES;
/// How long a customer's file is kept once stored (design 2026-10-30 D21/D26: inbound
/// attachments are kept 180 days). The owner may shorten it; nothing keeps a file longer.
pub const RETENTION: Duration = Duration::days(180);
/// How long a file waits when the workspace's day of chat files is spent ([`MAX_DAILY_BYTES`]).
pub const DAILY_LIMIT_WAIT: Duration = Duration::hours(1);
/// The most fetches of one file; then it is `failed` `unavailable`.
pub const MAX_ATTEMPTS: u32 = 5;
/// The wait after each failed fetch, in minutes (the last repeats).
pub const BACKOFF_MINUTES: [i64; 4] = [1, 10, 60, 360];
/// The most files one workspace's turn of the job fetches.
pub const RUN_PER_WORKSPACE: u32 = 20;
/// The most stored files one workspace's turn of the job lets go of past their retention.
pub const PURGE_PER_WORKSPACE: u32 = 200;
/// How long one fetch may take.
pub const FETCH_TIMEOUT: StdDuration = StdDuration::from_secs(30);
/// How long an address [`open`] hands out lives.
pub const URL_MINUTES: i64 = 10;
/// The Office types a document may be (a ZIP by its bytes, named as one of these).
pub const OFFICE_TYPES: [&str; 3] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/// What [`check`] found a file to be.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    /// The type its bytes are.
    pub mime: String,
    /// An image's size in pixels.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// The type `data` is, for a file of `kind` the provider named `declared`: an image must be a
/// JPEG, PNG or WebP by its bytes within the size and pixel bounds; a document a PDF, such an
/// image, or a ZIP named as an Office file. What does not pass answers why.
pub fn check(kind: MediaKind, declared: &str, data: &[u8]) -> Result<Checked, MediaReason> {
    let limit = match kind {
        MediaKind::Image => MAX_IMAGE_BYTES,
        MediaKind::Document => MAX_DOCUMENT_BYTES,
    };
    if data.len() as u64 > limit {
        return Err(MediaReason::TooLarge);
    }
    if let Some(image) = ImageType::sniff(data) {
        let (width, height) = image_size(data).ok_or(MediaReason::NotAllowed)?;
        if width > MAX_SIDE
            || height > MAX_SIDE
            || u64::from(width) * u64::from(height) > MAX_PIXELS
        {
            return Err(MediaReason::TooManyPixels);
        }
        return Ok(Checked {
            mime: image.mime().to_owned(),
            width: Some(width),
            height: Some(height),
        });
    }
    if kind == MediaKind::Image {
        return Err(MediaReason::NotAllowed);
    }
    if data.starts_with(b"%PDF-") {
        return Ok(Checked {
            mime: "application/pdf".into(),
            width: None,
            height: None,
        });
    }
    let declared = declared.trim().to_ascii_lowercase();
    if data.starts_with(b"PK\x03\x04") && OFFICE_TYPES.contains(&declared.as_str()) {
        return Ok(Checked {
            mime: declared,
            width: None,
            height: None,
        });
    }
    Err(MediaReason::NotAllowed)
}

/// The width and height a JPEG, PNG or WebP image declares in its header (nothing is decoded);
/// `None` for another type, a header that is cut short, or a side of zero.
pub fn image_size(data: &[u8]) -> Option<(u32, u32)> {
    let be16 = |at: usize| -> Option<u32> {
        Some(u32::from(u16::from_be_bytes(
            data.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let le16 = |at: usize| -> Option<u32> {
        Some(u32::from(u16::from_le_bytes(
            data.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let le24 = |at: usize| -> Option<u32> {
        let b = data.get(at..at + 3)?;
        Some(u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16))
    };
    let size = match ImageType::sniff(data)? {
        ImageType::Png => {
            if data.get(12..16)? != b"IHDR" {
                return None;
            }
            let w = u32::from_be_bytes(data.get(16..20)?.try_into().ok()?);
            let h = u32::from_be_bytes(data.get(20..24)?.try_into().ok()?);
            (w, h)
        }
        ImageType::Webp => match data.get(12..16)? {
            b"VP8 " => {
                if data.get(23..26)? != [0x9d, 0x01, 0x2a] {
                    return None;
                }
                (le16(26)? & 0x3fff, le16(28)? & 0x3fff)
            }
            b"VP8L" => {
                if *data.get(20)? != 0x2f {
                    return None;
                }
                let bits = u32::from_le_bytes(data.get(21..25)?.try_into().ok()?);
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
            }
            b"VP8X" => (le24(24)? + 1, le24(27)? + 1),
            _ => return None,
        },
        ImageType::Jpeg => {
            let mut at = 2;
            loop {
                // A marker: one or more 0xFF, then its code.
                if *data.get(at)? != 0xFF {
                    return None;
                }
                while *data.get(at)? == 0xFF {
                    at += 1;
                }
                let marker = *data.get(at)?;
                at += 1;
                match marker {
                    // Markers without a length.
                    0x01 | 0xD0..=0xD8 => continue,
                    // The start of the scan or the image's end before any frame: no size.
                    0xD9 | 0xDA => return None,
                    // A start of frame (not DHT, JPG or DAC): precision, height, width.
                    0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                        break (be16(at + 5)?, be16(at + 3)?);
                    }
                    _ => {
                        let len = be16(at)? as usize;
                        if len < 2 {
                            return None;
                        }
                        at += len;
                    }
                }
            }
        }
    };
    (size.0 > 0 && size.1 > 0).then_some(size)
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/// What a WhatsApp message's payload names of its file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InboundFile {
    pub kind: MediaKind,
    pub media_id: String,
    pub declared_mime: String,
    pub filename: String,
}

/// The file a WhatsApp message of a customer carries, from its event's payload
/// (`message.image` or `message.document`: its `id`, `mime_type` and a document's `filename`);
/// `None` for any other message, a media id that is not one, or once the sender was erased.
pub(crate) fn inbound_file(payload: &Value) -> Option<InboundFile> {
    let m = &payload["message"];
    if payload["erased_identity"] == true {
        return None;
    }
    let kind = match m["type"].as_str()? {
        "image" => MediaKind::Image,
        "document" => MediaKind::Document,
        _ => return None,
    };
    let body = &m[kind.key()];
    let media_id = body["id"].as_str()?.trim();
    if media_id.is_empty()
        || media_id.len() > MAX_PROVIDER_MEDIA_ID
        || !media_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return None;
    }
    let declared_mime = super::attachments::record_mime(body["mime_type"].as_str().unwrap_or(""));
    let filename = match kind {
        MediaKind::Document => {
            super::attachments::record_name(body["filename"].as_str().unwrap_or(""))
        }
        MediaKind::Image => String::new(),
    };
    Some(InboundFile {
        kind,
        media_id: media_id.to_owned(),
        declared_mime,
        filename,
    })
}

/// Records, in the consumer's transaction, the file the customer's WhatsApp message `message`
/// (on capability `capability`) carries per its event's `payload`: `pending`, at position 0, to be
/// fetched by the job. Nothing for a message without one; a message that holds its row already
/// keeps it. Answers whether a row was written.
pub(crate) async fn record_inbound(
    deps: &Deps,
    r: &mut dyn TenantRepos,
    capability: CapabilityId,
    message: MessageId,
    payload: &Value,
    now: OffsetDateTime,
) -> Result<bool, AppError> {
    let Some(file) = inbound_file(payload) else {
        return Ok(false);
    };
    r.message_media()
        .insert_if_new(&pending_row(
            deps.ids.uuid(),
            capability,
            message,
            file,
            now,
        ))
        .await
}

fn pending_row(
    id: Uuid,
    capability: CapabilityId,
    message: MessageId,
    file: InboundFile,
    now: OffsetDateTime,
) -> MessageMediaRow {
    MessageMediaRow {
        id,
        message_id: message,
        position: 0,
        capability_id: capability,
        direction: MediaDirection::Inbound,
        kind: file.kind,
        source: MediaSource::Provider,
        material_id: None,
        file_id: None,
        provider_media_id: Some(file.media_id),
        declared_mime: file.declared_mime,
        mime: None,
        filename: file.filename,
        size_bytes: None,
        sha256: None,
        width: None,
        height: None,
        state: MediaState::Pending,
        reason: None,
        attempts: 0,
        next_attempt_at: None,
        created_at: now,
        stored_at: None,
        deleted_at: None,
    }
}

/// For the customer's image and document messages among `messages` (inbound, stored with
/// [`IMAGE_MARKER`] or [`DOCUMENT_MARKER`]) that hold no row in `held` (a message stored before
/// chat media were kept): records their file `pending` from their inbound event, when the event
/// is still there and names a media id. Answers how many were recorded; the caller commits.
pub(crate) async fn backfill(
    deps: &Deps,
    r: &mut dyn TenantRepos,
    messages: &[Message],
    held: &[MessageMediaRow],
    now: OffsetDateTime,
) -> Result<u32, AppError> {
    let mut recorded = 0;
    for m in messages {
        if m.direction != Direction::Inbound
            || !(m.body.starts_with(IMAGE_MARKER) || m.body.starts_with(DOCUMENT_MARKER))
            || held.iter().any(|row| row.message_id == m.id)
        {
            continue;
        }
        let Some(external) = m.external_id.as_deref() else {
            continue;
        };
        let Some(event) = r
            .inbound_events()
            .find_external(jt_connector::Provider::Meta, external)
            .await?
        else {
            continue;
        };
        let (Some(capability), Some(file)) = (event.capability_id, inbound_file(&event.payload))
        else {
            continue;
        };
        if r.message_media()
            .insert_if_new(&pending_row(deps.ids.uuid(), capability, m.id, file, now))
            .await?
        {
            recorded += 1;
        }
    }
    Ok(recorded)
}

// ---------------------------------------------------------------------------------------------
// What the inbox shows
// ---------------------------------------------------------------------------------------------

/// What the inbox lists of the files of message `message`: its email's files (oldest first),
/// then its chat files (by position), each with its index among them.
pub(crate) fn views(
    message: MessageId,
    mail: &[MailFileRow],
    media: &[MessageMediaRow],
) -> Vec<AttachmentView> {
    let mail = mail
        .iter()
        .filter(|f| f.message_id == Some(message))
        .map(super::attachments::mail_view);
    let media = media
        .iter()
        .filter(|f| f.message_id == message)
        .map(media_view);
    mail.chain(media)
        .enumerate()
        .map(|(index, mut view)| {
            view.index = u32::try_from(index).unwrap_or(u32::MAX);
            view
        })
        .collect()
}

/// A chat file as the inbox lists it.
fn media_view(row: &MessageMediaRow) -> AttachmentView {
    AttachmentView {
        index: 0,
        kind: match row.kind {
            MediaKind::Image => AttachmentKind::Image,
            MediaKind::Document => AttachmentKind::Document,
        },
        file_id: row.file_id.filter(|_| row.state == MediaState::Stored),
        filename: row.filename.clone(),
        declared_mime: row.declared_mime.clone(),
        mime: row.mime.clone(),
        size_bytes: row.size_bytes,
        width: row.width,
        height: row.height,
        state: match row.state {
            MediaState::Pending => AttachmentState::Pending,
            MediaState::Stored => AttachmentState::Stored,
            MediaState::Failed => AttachmentState::Failed,
            MediaState::Deleted => AttachmentState::Deleted,
        },
        reason: row.reason.map(|r| r.key().to_owned()),
        skip_reason: None,
    }
}

// ---------------------------------------------------------------------------------------------
// Opening a file
// ---------------------------------------------------------------------------------------------

/// `inbox.message_media`'s input (besides the message's id): which of its files, from 0.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaInput {
    #[serde(default)]
    pub index: Option<u32>,
}

/// Whether the caller is handed an address (the panel) or, for an image, the image itself (an
/// agent).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hand {
    Address,
    Content,
}

/// A file [`open`] hands out.
#[derive(Debug, Serialize)]
pub struct Opened {
    pub message_id: MessageId,
    #[serde(flatten)]
    pub attachment: AttachmentView,
    /// A short-lived address of the workspace's own: shown inline for an image the panel asked
    /// for, else a download. Absent when the image itself is handed over.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<OffsetDateTime>,
    /// The image, base64, for an agent (taken out of the answer and handed over as image
    /// content).
    #[serde(skip)]
    pub image: Option<(String, String)>,
}

/// The file at `index` (0 when absent) of message `message`, for a caller who may read its
/// conversation (`inbox.work`); see the module docs. Writes `inbox.media.opened`.
pub async fn open(
    deps: &Deps,
    ctx: &Ctx,
    message: MessageId,
    input: MediaInput,
    hand: Hand,
) -> Result<Opened, AppError> {
    ctx.require(Permission::InboxWork)?;
    let index = input.index.unwrap_or(0);
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let found = r
        .messages()
        .get(message)
        .await?
        .ok_or_else(|| AppError::not_found("no such message"))?;
    r.conversations()
        .get(found.conversation_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such message"))?;
    let mail = r.mail_files().for_messages(&[message]).await?;
    let media = r.message_media().for_messages(&[message]).await?;
    let listed = views(message, &mail, &media);
    let attachment = listed
        .into_iter()
        .find(|a| a.index == index)
        .ok_or_else(|| AppError::not_found("no such file"))?;
    let file = match (attachment.state, attachment.file_id) {
        (
            AttachmentState::Stored | AttachmentState::Attached | AttachmentState::Staged,
            Some(f),
        ) => f,
        _ => return Err(unavailable(&attachment)),
    };
    let image = attachment.kind == AttachmentKind::Image;
    super::record(
        r.as_mut(),
        ctx,
        "inbox.media.opened",
        "message",
        message,
        json!({
            "message_id": message,
            "index": index,
            "kind": attachment.kind,
            "as": match (hand, image) {
                (Hand::Content, true) => "content",
                _ => "address",
            },
        }),
    )
    .await?;
    r.commit().await?;
    let expires = ctx.now + Duration::minutes(URL_MINUTES);
    if hand == Hand::Content && image {
        let upload = deps.files.read(ctx.workspace_id, file).await?;
        let kind = ImageType::sniff(&upload.bytes)
            .filter(|_| upload.bytes.len() as u64 <= MAX_IMAGE_BYTES)
            .ok_or_else(|| AppError::internal("a stored image is not one"))?;
        return Ok(Opened {
            message_id: message,
            attachment,
            url: None,
            expires_at: None,
            image: Some((
                base64::engine::general_purpose::STANDARD.encode(&upload.bytes),
                kind.mime().to_owned(),
            )),
        });
    }
    let url = if image {
        deps.files
            .device_url(ctx.workspace_id, file, expires)
            .await?
    } else {
        deps.files
            .attachment_url(ctx.workspace_id, file, expires)
            .await?
    };
    Ok(Opened {
        message_id: message,
        attachment,
        url: Some(url.to_string()),
        expires_at: Some(expires),
        image: None,
    })
}

/// `CONFLICT` `media_unavailable` for a file that is not there to open: its state and why.
fn unavailable(a: &AttachmentView) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: "the file is not available".into(),
        details: json!({
            "reason": "media_unavailable",
            "state": a.state,
            "why": a.reason,
        }),
    }
}

// ---------------------------------------------------------------------------------------------
// Sending an image
// ---------------------------------------------------------------------------------------------

/// The chat channels an image is sent on (`MessagingSender::send_image`): WhatsApp Cloud today.
pub const IMAGE_CHANNELS: [&str; 1] = ["whatsapp_cloud"];
/// The longest caption an image is sent with, in characters (WhatsApp's own limit).
pub const MAX_CAPTION_CHARS: usize = 1024;
/// The image types a chat image is sent as (WhatsApp takes JPEG and PNG only).
pub const SENT_IMAGE_TYPES: [&str; 2] = ["image/jpeg", "image/png"];
/// How long the address the provider fetches a sent image from lives.
pub const SEND_URL_MINUTES: i64 = 60;

/// The image a reply or a send carries (`inbox.reply`, `inbox.send`): exactly one of a stored
/// file (`jeeta.studio.file_upload`'s id) or a library material.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageInput {
    #[serde(default)]
    pub file_id: Option<FileId>,
    #[serde(default)]
    pub material_id: Option<jt_studio::MaterialId>,
}

/// An image checked to be sent: its file and what was found of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SendableImage {
    pub file_id: FileId,
    pub mime: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub material_id: Option<jt_studio::MaterialId>,
}

/// `VALIDATION` on field `image` with `reason`: what the panel shows.
pub(crate) fn image_refused(reason: &str) -> AppError {
    AppError::validation(
        "the image cannot be sent",
        json!({"field": "image", "reason": reason}),
    )
}

/// What the rules of a library material read besides the material: the workspace's materials
/// policy (`ai_standalone`), its olays and the time of sending.
pub struct SendContext<'a> {
    pub ai_standalone: bool,
    pub olays: &'a [jt_studio::Olay],
    pub at: OffsetDateTime,
}

/// Why material `m` may not be sent to a customer, if it may not: erased, its share permission
/// unset or refused, a person on it whose sharing only a human may allow and none did, a
/// `product_only` share of a material that shows a person; and, for an AI image, the AI rules
/// publishing holds it to (`jt_studio::check_use`): never unfiled (`ai_image_unfiled`), standing
/// alone only where the materials policy lets an agent's visual do so (`ai_image_not_allowed`),
/// and an olay's AI poster only while its olay is confirmed (`ai_olay_unconfirmed`) and not over
/// (`ai_olay_past`).
///
/// Deliberately not applied: publishing's "quality must be publishable" rule, and the olay and
/// season rules of a real photo. A person sending a customer a plain working photo of their own
/// order in a one-to-one chat is not publishing; the share and person rules cover it.
pub fn material_refusal(m: &jt_studio::Material, cx: &SendContext<'_>) -> Option<&'static str> {
    use jt_studio::{Binding, SharePermission};
    if m.erased_at.is_some() {
        return Some("material_erased");
    }
    match m.share.as_ref().map(|s| s.permission) {
        None => return Some("material_share_unset"),
        Some(SharePermission::NotShareable) => return Some("material_not_shareable"),
        Some(SharePermission::Shareable | SharePermission::ProductOnly) => {}
    }
    if m.needs_human_permission() && m.share.as_ref().is_some_and(|s| s.by.is_none()) {
        return Some("material_needs_human");
    }
    if m.share
        .as_ref()
        .is_some_and(|s| s.permission == SharePermission::ProductOnly)
        && m.is_personal_data()
    {
        return Some("material_shows_person");
    }
    if m.is_ai() {
        match m.binding {
            Binding::Unfiled => return Some("ai_image_unfiled"),
            Binding::Genel if !cx.ai_standalone => return Some("ai_image_not_allowed"),
            Binding::Genel => {}
            Binding::Olay { olay_id } => {
                let Some(o) = cx.olays.iter().find(|o| o.id == olay_id) else {
                    return Some("ai_olay_unconfirmed");
                };
                if !o.is_confirmed() {
                    return Some("ai_olay_unconfirmed");
                }
                if o.has_ended(jt_studio::istanbul_day(cx.at)) {
                    return Some("ai_olay_past");
                }
            }
        }
    }
    None
}

/// Why material `m` may not be sent at `at`, if it may not: [`material_refusal`], then the
/// publication fence (`studio::library::blocked_derivatives`, `material_source_restricted`): a
/// derivative whose source is restricted, erased or unfiled, whatever its own share says.
async fn material_refused(
    r: &mut dyn TenantRepos,
    m: &jt_studio::Material,
    at: OffsetDateTime,
) -> Result<Option<&'static str>, AppError> {
    let ai_standalone = r.studio_materials().material_policy().await?.ai_standalone;
    let olays = r.studio_materials().list_olays().await?;
    let cx = SendContext {
        ai_standalone,
        olays: &olays,
        at,
    };
    if let Some(reason) = material_refusal(m, &cx) {
        return Ok(Some(reason));
    }
    if crate::usecases::studio::library::blocked_derivatives(r)
        .await?
        .contains(&m.id)
    {
        return Ok(Some("material_source_restricted"));
    }
    Ok(None)
}

/// Checks `input` for sending at `at`: exactly one of a file and a material; a material that
/// may be sent (`material_refused`); a file the workspace's store keeps (not deleted), a JPEG or
/// PNG of at most [`MAX_IMAGE_BYTES`]. A file that is a material's is held to the material's
/// rules, and so is a file whose bytes are a refused material's (studio's upload gives the same
/// bytes a new id each time, so they are matched by their SHA-256). Each refusal is `VALIDATION`
/// `{field: image, reason}`.
pub(crate) async fn sendable_image(
    r: &mut dyn TenantRepos,
    input: &ImageInput,
    at: OffsetDateTime,
) -> Result<SendableImage, AppError> {
    let (material, file_id) = match (input.material_id, input.file_id) {
        (Some(id), None) => {
            let m = r
                .studio_materials()
                .get_material(id)
                .await?
                .ok_or_else(|| image_refused("image_not_found"))?;
            let file = m.file_id;
            (Some(m), file)
        }
        (None, Some(file)) => {
            let m = r
                .studio_materials()
                .list_materials()
                .await?
                .into_iter()
                .find(|m| m.file_id == file);
            (m, file)
        }
        _ => return Err(image_refused("image_one_of_file_or_material")),
    };
    if let Some(m) = &material
        && let Some(reason) = material_refused(r, m, at).await?
    {
        return Err(image_refused(reason));
    }
    let file = r
        .studio()
        .get_file(file_id)
        .await?
        .filter(|f| f.deleted_at.is_none())
        .ok_or_else(|| image_refused("image_not_found"))?;
    if material.is_none() {
        // The same bytes uploaded again: held to the rules of every material they are.
        let same: Vec<FileId> = r
            .studio()
            .file_usage()
            .await?
            .files
            .into_iter()
            .filter(|f| f.sha256 == file.sha256 && f.id != file.id)
            .map(|f| f.id)
            .collect();
        if !same.is_empty() {
            let twins: Vec<jt_studio::Material> = r
                .studio_materials()
                .list_materials()
                .await?
                .into_iter()
                .filter(|m| same.contains(&m.file_id))
                .collect();
            for m in &twins {
                if let Some(reason) = material_refused(r, m, at).await? {
                    return Err(image_refused(reason));
                }
            }
        }
    }
    if !SENT_IMAGE_TYPES.contains(&file.mime.as_str()) {
        return Err(image_refused("image_type_not_supported"));
    }
    if file.size_bytes == 0 || file.size_bytes > MAX_IMAGE_BYTES {
        return Err(image_refused("image_too_large"));
    }
    Ok(SendableImage {
        file_id: file.id,
        mime: file.mime,
        size_bytes: file.size_bytes,
        sha256: file.sha256,
        material_id: material.map(|m| m.id),
    })
}

/// The row that shows image `image`, sent with outbound message `message` on `capability`, in
/// its thread: stored (the bytes are the library's or the upload's own).
pub(crate) fn outbound_row(
    id: Uuid,
    capability: CapabilityId,
    message: MessageId,
    image: &SendableImage,
    now: OffsetDateTime,
) -> MessageMediaRow {
    MessageMediaRow {
        id,
        message_id: message,
        position: 0,
        capability_id: capability,
        direction: MediaDirection::Outbound,
        kind: MediaKind::Image,
        source: if image.material_id.is_some() {
            MediaSource::Material
        } else {
            MediaSource::Upload
        },
        material_id: image.material_id.map(|m| m.0),
        file_id: Some(image.file_id),
        provider_media_id: None,
        declared_mime: image.mime.clone(),
        mime: Some(image.mime.clone()),
        filename: String::new(),
        size_bytes: Some(image.size_bytes),
        sha256: Some(image.sha256.clone()),
        width: None,
        height: None,
        state: MediaState::Stored,
        reason: None,
        attempts: 0,
        next_attempt_at: None,
        created_at: now,
        stored_at: Some(now),
        deleted_at: None,
    }
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

/// What one workspace's turn of the job did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MediaRun {
    /// Files tried.
    pub fetched: u64,
    /// Files stored.
    pub stored: u64,
    /// Files refused or given up on (`failed`).
    pub refused: u64,
    /// Fetches that failed and wait to be tried again.
    pub retried: u64,
    /// Files past their retention let go of.
    pub purged: u64,
}

fn warn(ws: WorkspaceId, code: &str) {
    tracing::warn!(job = "inbox_media", workspace_id = %ws, code, "a chat file failed");
}

/// Workspace `ws`'s turn of the `inbox_media` job at `now`, until `deadline`: the customers'
/// files past [`RETENTION`] go first, then at most [`RUN_PER_WORKSPACE`] due files are fetched,
/// one after the other.
pub async fn run_workspace(
    deps: &Deps,
    ws: WorkspaceId,
    now: OffsetDateTime,
    deadline: std::time::Instant,
) -> Result<MediaRun, AppError> {
    let mut run = MediaRun {
        purged: purge(deps, ws, now).await?,
        ..MediaRun::default()
    };
    let due = {
        let mut r = deps.uow.tenant(ws).await?;
        r.message_media().due(now, RUN_PER_WORKSPACE).await?
    };
    for id in due {
        if std::time::Instant::now() >= deadline {
            break;
        }
        match fetch_one(deps, ws, id, now).await {
            Ok(Fetched::Stored) => {
                run.fetched += 1;
                run.stored += 1;
            }
            Ok(Fetched::Refused) => {
                run.fetched += 1;
                run.refused += 1;
            }
            Ok(Fetched::Retry) => {
                run.fetched += 1;
                run.retried += 1;
            }
            Ok(Fetched::NotDue) => {}
            Err(e) => {
                run.retried += 1;
                warn(ws, e.code.as_str());
            }
        }
    }
    Ok(run)
}

/// Lets go of the customers' files stored before `now - RETENTION`: marked `deleted`
/// (`retention`) in one transaction, their bytes deleted once it is committed (best effort: the
/// store's sweep deletes what is left). How many.
async fn purge(deps: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> Result<u64, AppError> {
    let mut r = deps.uow.tenant(ws).await?;
    let due = r
        .message_media()
        .due_for_purge(now - RETENTION, PURGE_PER_WORKSPACE)
        .await?;
    if due.is_empty() {
        return Ok(0);
    }
    let mut gone = Vec::with_capacity(due.len());
    for mut row in due {
        if let Some(file) = row.file_id.filter(|_| row.owns_bytes()) {
            gone.push(file);
        }
        row.state = MediaState::Deleted;
        row.reason = Some(MediaReason::Retention);
        row.deleted_at = Some(now);
        row.file_id = None;
        row.provider_media_id = None;
        row.filename = String::new();
        r.message_media().save(&row).await?;
    }
    r.commit().await?;
    let purged = gone.len() as u64;
    for file in gone {
        if deps.files.delete(ws, file).await.is_err() {
            warn(ws, "purge_delete_failed");
        }
    }
    Ok(purged)
}

enum Fetched {
    Stored,
    Refused,
    Retry,
    NotDue,
}

/// When a file that failed its `attempts`th fetch is tried again: `None` once they are spent.
fn next_attempt(attempts: u32, now: OffsetDateTime) -> Option<OffsetDateTime> {
    if attempts >= MAX_ATTEMPTS {
        return None;
    }
    let wait = BACKOFF_MINUTES[(attempts.max(1) as usize - 1).min(BACKOFF_MINUTES.len() - 1)];
    Some(now + Duration::minutes(wait))
}

/// What a failed fetch makes of a file: `Ok(reason)` to give up with, `Err(())` to try again.
fn classify(e: &ConnectorError) -> Result<MediaReason, ()> {
    match e {
        ConnectorError::Permanent { reason, .. } if reason.contains("too large") => {
            Ok(MediaReason::TooLarge)
        }
        ConnectorError::Permanent { .. } => Ok(MediaReason::Expired),
        _ => Err(()),
    }
}

/// Fetches pending file `id`: the attempt is counted (and the next one timed) before the provider
/// is called, so a crash never turns into a fetch loop; the fetch runs outside any transaction;
/// what it brought is checked, stored, and recorded under the row's lock.
async fn fetch_one(
    deps: &Deps,
    ws: WorkspaceId,
    id: Uuid,
    now: OffsetDateTime,
) -> Result<Fetched, AppError> {
    let (row, access) = {
        let mut r = deps.uow.tenant(ws).await?;
        let Some(mut row) = r.message_media().lock(id).await? else {
            return Ok(Fetched::NotDue);
        };
        if row.state != MediaState::Pending || row.next_attempt_at.is_some_and(|at| at > now) {
            return Ok(Fetched::NotDue);
        }
        if r.message_media()
            .inbound_bytes_since(now - Duration::hours(24))
            .await?
            >= MAX_DAILY_BYTES
        {
            // Past the day's bytes: the file waits (its media id kept, no attempt counted) and is
            // fetched once the day's window lets it, while the provider still serves it.
            row.next_attempt_at = Some(now + DAILY_LIMIT_WAIT);
            r.message_media().save(&row).await?;
            r.commit().await?;
            return Ok(Fetched::Retry);
        }
        let capability = r.capabilities().find(row.capability_id).await?;
        let access = match capability.filter(|c| c.status != StoredStatus::Retired) {
            Some(c) => r
                .capabilities()
                .read_sealed(c.id)
                .await?
                .and_then(|sealed| open_credential(deps, ws, &sealed).ok())
                .map(|credential| (credential, c)),
            None => None,
        };
        row.attempts += 1;
        row.next_attempt_at = next_attempt(row.attempts, now);
        if access.is_none() {
            // No credential to fetch with (yet): tried again after the backoff, then given up.
            if row.next_attempt_at.is_none() {
                give_up(&mut row, MediaReason::Unavailable);
                r.message_media().save(&row).await?;
                r.commit().await?;
                return Ok(Fetched::Refused);
            }
            r.message_media().save(&row).await?;
            r.commit().await?;
            warn(ws, "no_credential");
            return Ok(Fetched::Retry);
        }
        r.message_media().save(&row).await?;
        r.commit().await?;
        (row, access)
    };
    let Some((credential, capability)) = access else {
        return Ok(Fetched::Retry);
    };
    let fetched = fetch(deps, &capability, &credential, &row).await;
    let outcome = match fetched {
        Ok(media) => match check(row.kind, &row.declared_mime, &media.data) {
            Ok(checked) => Ok((media.data, checked)),
            Err(reason) => Err(Some(reason)),
        },
        Err(e) => match classify(&e) {
            Ok(reason) => Err(Some(reason)),
            Err(()) => Err(None),
        },
    };
    let (bytes, checked) = match outcome {
        Ok(found) => found,
        Err(reason) => {
            let mut r = deps.uow.tenant(ws).await?;
            let Some(mut current) = r.message_media().lock(id).await? else {
                return Ok(Fetched::NotDue);
            };
            if current.state != MediaState::Pending {
                return Ok(Fetched::NotDue);
            }
            let reason = reason.or_else(|| {
                current
                    .next_attempt_at
                    .is_none()
                    .then_some(MediaReason::Unavailable)
            });
            let fetched = match reason {
                Some(reason) => {
                    give_up(&mut current, reason);
                    Fetched::Refused
                }
                None => Fetched::Retry,
            };
            r.message_media().save(&current).await?;
            r.commit().await?;
            if matches!(fetched, Fetched::Retry) {
                warn(ws, "fetch_failed");
            }
            return Ok(fetched);
        }
    };
    let file = FileId(deps.ids.uuid());
    let (mime, name) = match row.kind {
        MediaKind::Image => (checked.mime.clone(), image_name(&checked.mime)),
        MediaKind::Document => (
            OCTET_STREAM.to_owned(),
            super::attachments::store_name(&row.filename),
        ),
    };
    let size = bytes.len() as u64;
    let kept = deps
        .files
        .put(
            ws,
            file,
            MediaUpload {
                bytes,
                mime,
                filename: name,
            },
        )
        .await?;
    let saved = async {
        let mut r = deps.uow.tenant(ws).await?;
        let Some(mut current) = r.message_media().lock(id).await? else {
            return Ok(false);
        };
        // Erased (or settled) while it was fetched: the bytes are not kept.
        if current.state != MediaState::Pending {
            return Ok(false);
        }
        current.state = MediaState::Stored;
        current.file_id = Some(file);
        current.provider_media_id = None;
        current.mime = Some(checked.mime.clone());
        current.size_bytes = Some(size);
        current.sha256 = Some(kept.sha256.clone());
        current.width = checked.width;
        current.height = checked.height;
        current.next_attempt_at = None;
        current.stored_at = Some(now);
        r.message_media().save(&current).await?;
        r.commit().await?;
        Ok::<bool, AppError>(true)
    }
    .await;
    match saved {
        Ok(true) => Ok(Fetched::Stored),
        other => {
            let _ = deps.files.delete(ws, file).await;
            other.map(|_| Fetched::NotDue)
        }
    }
}

/// The name a stored image is kept under (the store takes a name; no customer's).
fn image_name(mime: &str) -> String {
    match mime {
        "image/png" => "image.png",
        "image/webp" => "image.webp",
        _ => "image.jpg",
    }
    .into()
}

/// A file given up on with `reason`: `failed`, its media id gone, nothing left to try.
fn give_up(row: &mut MessageMediaRow, reason: MediaReason) {
    row.state = MediaState::Failed;
    row.reason = Some(reason);
    row.provider_media_id = None;
    row.next_attempt_at = None;
}

/// Fetches `row`'s file from capability `capability`'s provider, within [`FETCH_TIMEOUT`] and
/// its kind's size limit. A provider that gives no media is a permanent refusal (`expired`).
async fn fetch(
    deps: &Deps,
    capability: &Capability,
    credential: &jt_connector::Credential,
    row: &MessageMediaRow,
) -> Result<crate::ports::connectors::Media, ConnectorError> {
    let provider = jt_connector::provider_for_kind(&capability.kind_key)
        .ok_or_else(|| ConnectorError::permanent("the capability has no provider"))?;
    let sender = deps
        .connectors
        .messaging(provider)
        .ok_or_else(|| ConnectorError::transient("no messaging adapter"))?;
    let media_id = row
        .provider_media_id
        .as_deref()
        .ok_or_else(|| ConnectorError::permanent("no media id"))?;
    let limit = match row.kind {
        MediaKind::Image => MAX_IMAGE_BYTES,
        MediaKind::Document => MAX_DOCUMENT_BYTES,
    } as usize;
    let public = adapter_public(capability);
    match tokio::time::timeout(
        FETCH_TIMEOUT,
        sender.fetch_media(credential, &public, media_id, limit),
    )
    .await
    {
        Ok(Ok(Some(media))) => Ok(media),
        Ok(Ok(None)) => Err(ConnectorError::permanent("the provider gives no media")),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(ConnectorError::transient("the media fetch timed out")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        out.extend_from_slice(&w.to_be_bytes());
        out.extend_from_slice(&h.to_be_bytes());
        out.extend_from_slice(&[8, 6, 0, 0, 0]);
        out
    }

    fn jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, b'J', b'F'];
        // A DHT segment before the frame, skipped by its length.
        out.extend_from_slice(&[0xFF, 0xC4, 0x00, 0x03, 0x00]);
        out.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        out.extend_from_slice(&h.to_be_bytes());
        out.extend_from_slice(&w.to_be_bytes());
        out.extend_from_slice(&[0x03, 0x01, 0x22, 0x00]);
        out
    }

    fn webp_vp8x(w: u32, h: u32) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        out.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
        out.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
        out
    }

    fn webp_vp8(w: u16, h: u16) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a".to_vec();
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out
    }

    fn webp_vp8l(w: u32, h: u32) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        let bits = (w - 1) | ((h - 1) << 14);
        out.extend_from_slice(&bits.to_le_bytes());
        out
    }

    #[test]
    fn image_sizes_are_read_from_the_header() {
        assert_eq!(image_size(&png(640, 480)), Some((640, 480)));
        assert_eq!(image_size(&jpeg(1024, 768)), Some((1024, 768)));
        assert_eq!(image_size(&webp_vp8x(4000, 3000)), Some((4000, 3000)));
        assert_eq!(image_size(&webp_vp8(320, 200)), Some((320, 200)));
        assert_eq!(image_size(&webp_vp8l(17, 9)), Some((17, 9)));
        // Cut short, zero-sized, or not an image: no size.
        assert_eq!(image_size(&png(640, 480)[..18]), None);
        assert_eq!(image_size(&png(0, 480)), None);
        assert_eq!(image_size(&jpeg(1024, 768)[..12]), None);
        assert_eq!(image_size(b"%PDF-1.7"), None);
        assert_eq!(image_size(&[0xFF, 0xD8, 0xFF, 0xD9]), None);
    }

    #[test]
    fn an_image_is_what_its_bytes_are_never_what_it_is_called() {
        let ok = check(MediaKind::Image, "application/pdf", &png(10, 10)).unwrap();
        assert_eq!(ok.mime, "image/png");
        assert_eq!((ok.width, ok.height), (Some(10), Some(10)));
        assert_eq!(
            check(MediaKind::Image, "image/jpeg", b"%PDF-1.7 hello"),
            Err(MediaReason::NotAllowed)
        );
        assert_eq!(
            check(MediaKind::Image, "image/jpeg", b"<html><script>"),
            Err(MediaReason::NotAllowed)
        );
        // A header the size cannot be read from is refused too.
        assert_eq!(
            check(MediaKind::Image, "image/png", b"\x89PNG\r\n\x1a\n"),
            Err(MediaReason::NotAllowed)
        );
    }

    #[test]
    fn sizes_and_pixels_are_bounded() {
        let mut big = png(10, 10);
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        assert_eq!(
            check(MediaKind::Image, "image/png", &big),
            Err(MediaReason::TooLarge)
        );
        let mut at_limit = png(10, 10);
        at_limit.resize(MAX_IMAGE_BYTES as usize, 0);
        assert!(check(MediaKind::Image, "image/png", &at_limit).is_ok());
        assert_eq!(
            check(MediaKind::Image, "image/png", &png(MAX_SIDE + 1, 10)),
            Err(MediaReason::TooManyPixels)
        );
        // Within the side, over the pixels.
        assert_eq!(
            check(MediaKind::Image, "image/png", &png(8000, 8000)),
            Err(MediaReason::TooManyPixels)
        );
        assert!(check(MediaKind::Image, "image/png", &png(8000, 5000)).is_ok());
        let mut doc = b"%PDF-1.7".to_vec();
        doc.resize(MAX_DOCUMENT_BYTES as usize + 1, b' ');
        assert_eq!(
            check(MediaKind::Document, "application/pdf", &doc),
            Err(MediaReason::TooLarge)
        );
    }

    #[test]
    fn documents_are_pdfs_images_or_named_office_files() {
        let pdf = check(MediaKind::Document, "text/html", b"%PDF-1.4 x").unwrap();
        assert_eq!(pdf.mime, "application/pdf");
        let image = check(MediaKind::Document, "", &jpeg(20, 30)).unwrap();
        assert_eq!(image.mime, "image/jpeg");
        let office = check(MediaKind::Document, OFFICE_TYPES[0], b"PK\x03\x04rest").unwrap();
        assert_eq!(office.mime, OFFICE_TYPES[0]);
        // A ZIP not named as an Office file, HTML, an executable, plain text: refused.
        for (declared, data) in [
            ("application/zip", &b"PK\x03\x04rest"[..]),
            ("text/html", b"<html>"),
            ("application/pdf", b"MZ\x90\x00"),
            ("text/plain", b"hello"),
            ("application/pdf", b""),
        ] {
            assert_eq!(
                check(MediaKind::Document, declared, data),
                Err(MediaReason::NotAllowed),
                "{declared}"
            );
        }
    }

    #[test]
    fn the_payload_names_the_file() {
        let image = json!({"message": {"type": "image", "image": {"id": "1500000000000001", "mime_type": "image/jpeg", "sha256": "x"}}});
        assert_eq!(
            inbound_file(&image),
            Some(InboundFile {
                kind: MediaKind::Image,
                media_id: "1500000000000001".into(),
                declared_mime: "image/jpeg".into(),
                filename: String::new(),
            })
        );
        let doc = json!({"message": {"type": "document", "document": {"id": "77", "mime_type": "Application/PDF", "filename": "teklif\u{0}.pdf"}}});
        let file = inbound_file(&doc).unwrap();
        assert_eq!(file.kind, MediaKind::Document);
        assert_eq!(file.declared_mime, "application/pdf");
        assert_eq!(file.filename, "teklif.pdf");
        // Text, an erased sender, an id that is not one: nothing.
        assert_eq!(
            inbound_file(&json!({"message": {"type": "text", "text": {"body": "x"}}})),
            None
        );
        let mut erased = image.clone();
        erased["erased_identity"] = json!(true);
        assert_eq!(inbound_file(&erased), None);
        let bad = json!({"message": {"type": "image", "image": {"id": "../me"}}});
        assert_eq!(inbound_file(&bad), None);
        let url = json!({"message": {"type": "image", "image": {"id": "https://evil.example/x"}}});
        assert_eq!(inbound_file(&url), None);
    }

    #[test]
    fn failures_back_off_then_give_up() {
        let now = OffsetDateTime::UNIX_EPOCH;
        assert_eq!(next_attempt(1, now), Some(now + Duration::minutes(1)));
        assert_eq!(next_attempt(2, now), Some(now + Duration::minutes(10)));
        assert_eq!(next_attempt(4, now), Some(now + Duration::minutes(360)));
        assert_eq!(next_attempt(MAX_ATTEMPTS, now), None);
        assert_eq!(
            classify(&ConnectorError::permanent("the media file is too large")),
            Ok(MediaReason::TooLarge)
        );
        assert_eq!(
            classify(&ConnectorError::permanent("HTTP 404")),
            Ok(MediaReason::Expired)
        );
        assert_eq!(classify(&ConnectorError::transient("down")), Err(()));
        assert_eq!(classify(&ConnectorError::throttle(None)), Err(()));
        assert_eq!(classify(&ConnectorError::auth("revoked")), Err(()));
    }
}
