//! Email attachments (spec 2026-10-30-leads-pool-outreach-design.md §3.15, §4.4): the files of
//! inbound email, kept within caps; the files a person or an agent uploads to attach to a reply,
//! a commercial email or a quote; what the inbox lists of them, the download address, and their
//! retention. The bytes live in the file store
//! (`ports::files::FileStore`), always as `application/octet-stream`, under their `mail_files`
//! row's id; no event payload, intent, ledger entry or log line ever holds them, and no log line
//! names a file.

use std::collections::BTreeSet;

use base64::{Engine, engine::general_purpose::STANDARD};
use jt_capability::{Capability, CapabilityId};
use jt_connector::EventKind;
use jt_inbox::MessageId;
use jt_studio::FileId;
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Duration, OffsetDateTime};

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::connectors::{Attachment, InboundEventDraft, MediaUpload, PolledMail};
use crate::ports::inbox::OutboxRow;
use crate::ports::mail_files::{
    MAX_MAIL_FILE_PAGE, MailFileDirection, MailFileRow, MailFileState, SkipReason,
};
use crate::usecases::files::OCTET_STREAM;
use crate::usecases::webhook::Delivery;
use crate::usecases::{Deps, required};

/// The most bytes one inbound file may hold: the mail adapter's bound on a whole message.
pub const MAX_INBOUND_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// The most files one inbound email keeps; the rest are recorded `skipped`.
pub const MAX_INBOUND_FILES: usize = 20;
/// The most bytes of inbound files a workspace keeps in a day ([`INBOUND_DAY`]).
pub const MAX_INBOUND_DAILY_BYTES: u64 = 500 * 1024 * 1024;
/// The day [`MAX_INBOUND_DAILY_BYTES`] counts over: the 24 hours before the poll (a rolling
/// window, so no time zone decides where a day ends).
pub const INBOUND_DAY: Duration = Duration::hours(24);
/// The longest name a mail file is recorded with, in characters (`mail_files.filename`).
pub const MAX_FILENAME_CHARS: usize = 255;

/// The name a file is recorded and listed with: the email's (or the uploader's) name without
/// control characters, trimmed, at most [`MAX_FILENAME_CHARS`] characters.
pub fn record_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control()).collect();
    clean.trim().chars().take(MAX_FILENAME_CHARS).collect()
}

/// The name the file store keeps a mail file under (the store takes 1 to 255 bytes, no path
/// separator, not `.` or `..`): the recorded name with `/` and `\` as `_`, cut to 255 bytes on a
/// character boundary; `attachment` when nothing is left. A download is named with it.
pub fn store_name(name: &str) -> String {
    let mut out = String::new();
    for c in record_name(name).chars() {
        let c = if matches!(c, '/' | '\\') { '_' } else { c };
        if out.len() + c.len_utf8() > 255 {
            break;
        }
        out.push(c);
    }
    if matches!(out.as_str(), "" | "." | "..") {
        "attachment".into()
    } else {
        out
    }
}

/// The type a file is recorded with: the declared type in lowercase, without control characters
/// or spaces, at most 255 characters; `application/octet-stream` when none is given.
pub fn record_mime(mime: &str) -> String {
    let clean: String = mime
        .chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .take(MAX_FILENAME_CHARS)
        .collect::<String>()
        .to_lowercase();
    if clean.is_empty() {
        OCTET_STREAM.into()
    } else {
        clean.chars().take(MAX_FILENAME_CHARS).collect()
    }
}

/// A mail file as `inbox.messages.list` shows it with its message (spec §3.15).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AttachmentView {
    pub file_id: FileId,
    pub filename: String,
    pub declared_mime: String,
    pub size_bytes: u64,
    pub state: MailFileState,
    /// Why the file was not kept, when it was `skipped`.
    pub skip_reason: Option<SkipReason>,
}

impl From<&MailFileRow> for AttachmentView {
    fn from(row: &MailFileRow) -> Self {
        AttachmentView {
            file_id: row.id,
            filename: row.filename.clone(),
            declared_mime: row.declared_mime.clone(),
            size_bytes: row.size_bytes,
            state: row.state,
            skip_reason: row.skip_reason,
        }
    }
}

/// One email's files as a poll stored them.
struct EmailFiles {
    /// The email's position among the poll's drafts.
    index: usize,
    rows: Vec<MailFileRow>,
}

/// The inbound files of one mailbox poll (spec §3.15, the Studio staging pattern): stored
/// ([`PolledFiles::store`]) before the poll's transaction; screened against erasure
/// ([`PolledFiles::screen`]) and recorded for the emails stored as new events
/// ([`PolledFiles::record`]) inside it; and, once it is over, deleted from the store when they
/// are not recorded ([`PolledFiles::settle`]): every file when the transaction never reached its
/// commit, a duplicate's and an erased sender's always. A file left by a commit that failed
/// after it began, and recorded by none, goes with the store's daily sweep.
#[derive(Default)]
pub(crate) struct PolledFiles {
    emails: Vec<EmailFiles>,
    /// The ids the store holds for this poll.
    stored: Vec<FileId>,
    /// The emails (by index) whose sender is erased: their files are never recorded.
    erased: BTreeSet<usize>,
    /// The emails (by index) whose rows the transaction holds.
    recorded: BTreeSet<usize>,
    commit_started: bool,
}

impl PolledFiles {
    /// Stores, within the caps, the files of the inbox emails among `polled` (polled on
    /// `capability` of workspace `ws` at `now`), and answers the drafts, their payloads'
    /// `attachments` entries naming each file's id (`file_id`) or why it was not kept
    /// (`skipped`). An email's files past the [`MAX_INBOUND_FILES`] first, a file over
    /// [`MAX_INBOUND_FILE_BYTES`], or one past the workspace's [`MAX_INBOUND_DAILY_BYTES`] of
    /// the last [`INBOUND_DAY`] are recorded `skipped`. A file the store refuses ends the poll
    /// with its error (the files stored so far are deleted by [`PolledFiles::settle`]).
    pub(crate) async fn store(
        &mut self,
        deps: &Deps,
        ws: WorkspaceId,
        capability: CapabilityId,
        polled: Vec<PolledMail>,
        now: OffsetDateTime,
    ) -> Result<Vec<InboundEventDraft>, AppError> {
        let with_files = polled
            .iter()
            .any(|m| m.draft.kind == EventKind::Message && !m.attachments.is_empty());
        let mut used = if with_files {
            let mut r = deps.uow.tenant(ws).await?;
            r.mail_files()
                .inbound_bytes_since(now - INBOUND_DAY)
                .await?
        } else {
            0
        };
        let mut drafts = Vec::with_capacity(polled.len());
        for (index, mail) in polled.into_iter().enumerate() {
            let PolledMail {
                mut draft,
                attachments,
            } = mail;
            if draft.kind != EventKind::Message || attachments.is_empty() {
                drafts.push(draft);
                continue;
            }
            let mut rows = Vec::with_capacity(attachments.len());
            for (position, file) in attachments.into_iter().enumerate() {
                let size = file.bytes.len() as u64;
                let skip = if position >= MAX_INBOUND_FILES {
                    Some(SkipReason::TooManyFiles)
                } else if size > MAX_INBOUND_FILE_BYTES {
                    Some(SkipReason::FileTooLarge)
                } else if used.saturating_add(size) > MAX_INBOUND_DAILY_BYTES {
                    Some(SkipReason::DailyLimit)
                } else {
                    None
                };
                let id = FileId(deps.ids.uuid());
                let sha256 = match skip {
                    Some(_) => None,
                    None => {
                        self.stored.push(id);
                        let kept = deps
                            .files
                            .put(
                                ws,
                                id,
                                MediaUpload {
                                    bytes: file.bytes,
                                    mime: OCTET_STREAM.into(),
                                    filename: store_name(&file.filename),
                                },
                            )
                            .await?;
                        used = used.saturating_add(size);
                        Some(kept.sha256)
                    }
                };
                if let Some(entry) = draft
                    .payload
                    .get_mut("attachments")
                    .and_then(|a| a.get_mut(position))
                    .and_then(|e| e.as_object_mut())
                {
                    match skip {
                        None => entry.insert("file_id".into(), json!(id)),
                        Some(reason) => entry.insert("skipped".into(), json!(reason.key())),
                    };
                }
                rows.push(MailFileRow {
                    id,
                    direction: MailFileDirection::Inbound,
                    state: if skip.is_some() {
                        MailFileState::Skipped
                    } else {
                        MailFileState::Stored
                    },
                    skip_reason: skip,
                    capability_id: Some(capability),
                    event_external_id: Some(draft.external_id.clone()),
                    message_id: None,
                    person_id: None,
                    filename: record_name(&file.filename),
                    declared_mime: record_mime(&file.declared_mime),
                    size_bytes: size,
                    sha256,
                    created_at: now,
                    expires_at: None,
                    deleted_at: None,
                });
            }
            self.emails.push(EmailFiles { index, rows });
            drafts.push(draft);
        }
        Ok(drafts)
    }

    /// Inside the poll's transaction, under the inbox workspace lock: an email whose sender is
    /// erased (what `webhook::store_polled` will mask) keeps no file.
    pub(crate) async fn screen(
        &mut self,
        r: &mut dyn TenantRepos,
        capability: CapabilityId,
        drafts: &[InboundEventDraft],
    ) -> Result<(), AppError> {
        for email in &self.emails {
            let Some(draft) = drafts.get(email.index) else {
                continue;
            };
            let mut payload = draft.payload.clone();
            if super::erasure::scrub_inbound(r, Some(capability), &mut payload).await? {
                self.erased.insert(email.index);
            }
        }
        Ok(())
    }

    /// Inside the poll's transaction, after `webhook::store_polled` answered `deliveries` (in the
    /// drafts' order): records the files of each email stored as a new event whose sender is not
    /// erased.
    pub(crate) async fn record(
        &mut self,
        r: &mut dyn TenantRepos,
        deliveries: &[Delivery],
    ) -> Result<(), AppError> {
        for email in &self.emails {
            if self.erased.contains(&email.index)
                || !matches!(deliveries.get(email.index), Some(Delivery::Stored(_)))
            {
                continue;
            }
            for row in &email.rows {
                r.mail_files().insert(row.clone()).await?;
            }
            self.recorded.insert(email.index);
        }
        Ok(())
    }

    /// Called right before the poll's transaction commits: from here on its recorded files are
    /// kept whatever the commit answers.
    pub(crate) fn commit_started(&mut self) {
        self.commit_started = true;
    }

    /// Once the poll's transaction is over: deletes from the store the files no committed row
    /// records (best effort; the store's daily sweep deletes what is left).
    pub(crate) async fn settle(self, deps: &Deps, ws: WorkspaceId) {
        let kept: BTreeSet<FileId> = if self.commit_started {
            self.emails
                .iter()
                .filter(|e| self.recorded.contains(&e.index))
                .flat_map(|e| e.rows.iter().map(|r| r.id))
                .collect()
        } else {
            BTreeSet::new()
        };
        for id in self.stored.iter().filter(|id| !kept.contains(id)) {
            let _ = deps.files.delete(ws, *id).await;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Outbound files: upload, the download address, sending, retention
// ---------------------------------------------------------------------------------------------

/// The most bytes one uploaded file may hold.
pub const MAX_UPLOAD_BYTES: u64 = 7 * 1024 * 1024;
/// The body the panel's upload route takes: the largest file in base64, with room for the rest
/// of the request.
pub const MAX_UPLOAD_BODY_BYTES: usize = 10 * 1024 * 1024;
/// The most files one email carries.
pub const MAX_ATTACHMENTS: usize = 5;
/// The most bytes one email takes as the mail adapter writes it, its files included (the
/// adapter's bound on a message, `jt_mail`'s `MAX_MESSAGE_BYTES`).
pub const MESSAGE_BOUND_BYTES: u64 = 10 * 1024 * 1024;
/// What [`message_fits`] keeps free for an email's headers and its parts' own headers.
pub const HEADER_ROOM_BYTES: u64 = 64 * 1024;
/// How long an uploaded file waits to be attached before it is deleted unused.
pub const STAGED_FOR: Duration = Duration::days(7);
/// How long a download address lives.
pub const DOWNLOAD_FOR: Duration = Duration::minutes(10);
/// How many batches of [`MAX_MAIL_FILE_PAGE`] rows one workspace's purge takes in a run.
pub const MAX_PURGE_BATCHES: usize = 20;
/// The Office Open XML document type.
pub const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/// The Office Open XML spreadsheet type.
pub const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/// The types an upload takes (spec §3.15), each checked by its first bytes ([`bytes_fit`]).
pub const UPLOAD_TYPES: [&str; 7] = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "text/plain",
    "text/csv",
    DOCX,
    XLSX,
];

/// Whether `bytes` are what type `mime` (one of [`UPLOAD_TYPES`]) begins with: `%PDF-`, the PNG
/// signature, a JPEG's start of image, a ZIP archive's local header for the two Office Open
/// XML types; text (plain or CSV) is UTF-8 without a NUL byte. Never empty.
pub fn bytes_fit(mime: &str, bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && match mime {
            "application/pdf" => bytes.starts_with(b"%PDF-"),
            "image/png" => bytes.starts_with(crate::usecases::files::PNG_SIGNATURE),
            "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "text/plain" | "text/csv" => std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0),
            DOCX | XLSX => bytes.starts_with(b"PK\x03\x04"),
            _ => false,
        }
}

/// The bytes a part of `size` bytes takes once written in base64, 76 characters a line: what an
/// email's text or file costs of [`MESSAGE_BOUND_BYTES`] at most (the mail adapter writes text
/// as quoted-printable or base64, whichever is shorter, and files as base64).
pub fn wire_bytes(size: u64) -> u64 {
    let encoded = size.div_ceil(3) * 4;
    encoded + encoded.div_ceil(76) * 2
}

/// Whether an email of `text_len` bytes of text with files of `sizes` bytes stays within
/// [`MESSAGE_BOUND_BYTES`] as it is written, [`HEADER_ROOM_BYTES`] kept for its headers.
pub fn message_fits(text_len: usize, sizes: &[u64]) -> bool {
    let total = sizes
        .iter()
        .fold(wire_bytes(text_len as u64) + HEADER_ROOM_BYTES, |n, s| {
            n.saturating_add(wire_bytes(*s))
        });
    total <= MESSAGE_BOUND_BYTES
}

fn refused_input(field: &str, reason: &str) -> AppError {
    AppError::validation(
        format!("{field}: {reason}"),
        json!({"field": field, "reason": reason}),
    )
}

/// `inbox.attachments_upload`'s input (spec §3.15).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadInput {
    pub request_key: String,
    pub filename: String,
    /// One of [`UPLOAD_TYPES`].
    pub mime: String,
    /// The file's bytes in standard base64, at most [`MAX_UPLOAD_BYTES`] decoded.
    pub data_base64: String,
}

/// A mail file as `inbox.attachments_upload` and `inbox.attachments_get` answer it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AttachmentOut {
    #[serde(flatten)]
    pub attachment: AttachmentView,
    pub direction: MailFileDirection,
    /// The message it came or goes with, once known.
    pub message_id: Option<MessageId>,
    /// When a staged file expires unused.
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
}

impl From<&MailFileRow> for AttachmentOut {
    fn from(row: &MailFileRow) -> Self {
        AttachmentOut {
            attachment: row.into(),
            direction: row.direction,
            message_id: row.message_id,
            expires_at: row.expires_at,
        }
    }
}

/// `inbox.attachments_get`'s answer: the file and, while the store holds it, an address that
/// downloads it ([`DOWNLOAD_FOR`], signed for the `attachment` purpose: served only as a
/// download).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AttachmentGetOut {
    #[serde(flatten)]
    pub file: AttachmentOut,
    pub download_url: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub download_expires_at: Option<OffsetDateTime>,
}

/// The file a request key recorded, read again (a request key stores `{file_id}` only).
async fn replay(
    r: &mut dyn TenantRepos,
    key: &str,
    now: OffsetDateTime,
) -> Result<Option<AttachmentOut>, AppError> {
    let Some(stored) = r.request_keys().get(key, now).await? else {
        return Ok(None);
    };
    let id: FileId = stored
        .get("file_id")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| AppError::conflict("request key belongs to another operation"))?;
    let row = r
        .mail_files()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("the file this request recorded is gone"))?;
    Ok(Some((&row).into()))
}

/// `inbox.attachments_upload` (spec §3.15): stores a file to attach to an email, `staged` for
/// [`STAGED_FOR`]. Needs `inbox.work`. The type must be one of [`UPLOAD_TYPES`] and the bytes
/// what it begins with ([`bytes_fit`]), at most [`MAX_UPLOAD_BYTES`]; the name, without control
/// characters, 1 to 255 characters. The bytes go to the store (as `application/octet-stream`)
/// before the transaction that records them, and are deleted again when it does not commit. A
/// request key replays the file it recorded. Ledger `inbox.attachment.uploaded {file_id,
/// size_bytes, declared_mime}` (never the name).
pub async fn upload(deps: &Deps, ctx: &Ctx, input: UploadInput) -> Result<AttachmentOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let key = required("request_key", &input.request_key)?;
    if key.len() > 200 {
        return Err(refused_input("request_key", "too_long"));
    }
    {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        if let Some(out) = replay(r.as_mut(), &key, ctx.now).await? {
            return Ok(out);
        }
    }
    let filename = record_name(&input.filename);
    if filename.is_empty() {
        return Err(refused_input("filename", "required"));
    }
    let mime = input.mime.trim().to_ascii_lowercase();
    if !UPLOAD_TYPES.contains(&mime.as_str()) {
        return Err(refused_input("mime", "unsupported_type"));
    }
    let data = input.data_base64.trim();
    if data.len() as u64 > MAX_UPLOAD_BYTES.div_ceil(3) * 4 {
        return Err(refused_input("data_base64", "file_too_large"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| refused_input("data_base64", "not_base64"))?;
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err(refused_input("data_base64", "file_too_large"));
    }
    if !bytes_fit(&mime, &bytes) {
        return Err(refused_input("data_base64", "type_mismatch"));
    }
    let id = FileId(deps.ids.uuid());
    let size = bytes.len() as u64;
    let kept = deps
        .files
        .put(
            ctx.workspace_id,
            id,
            MediaUpload {
                bytes,
                mime: OCTET_STREAM.into(),
                filename: store_name(&filename),
            },
        )
        .await?;
    let mut committing = false;
    let recorded = async {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.people().lock_workspace().await?;
        // A racing request with the same key recorded its file first: answer that one.
        if let Some(out) = replay(r.as_mut(), &key, ctx.now).await? {
            return Ok((out, false));
        }
        let row = MailFileRow {
            id,
            direction: MailFileDirection::Outbound,
            state: MailFileState::Staged,
            skip_reason: None,
            capability_id: None,
            event_external_id: None,
            message_id: None,
            person_id: None,
            filename,
            declared_mime: mime.clone(),
            size_bytes: size,
            sha256: Some(kept.sha256.clone()),
            created_at: ctx.now,
            expires_at: Some(ctx.now + STAGED_FOR),
            deleted_at: None,
        };
        r.mail_files().insert(row.clone()).await?;
        if !r
            .request_keys()
            .store(&key, json!({ "file_id": id }), ctx.now)
            .await?
        {
            return Err(AppError::conflict("request key changed while uploading"));
        }
        super::record(
            r.as_mut(),
            ctx,
            "inbox.attachment.uploaded",
            "mail_file",
            id,
            json!({"file_id": id, "size_bytes": size, "declared_mime": mime}),
        )
        .await?;
        committing = true;
        r.commit().await?;
        Ok::<_, AppError>(((&row).into(), true))
    }
    .await;
    match recorded {
        Ok((out, true)) => Ok(out),
        Ok((out, false)) => {
            let _ = deps.files.delete(ctx.workspace_id, id).await;
            Ok(out)
        }
        Err(e) => {
            // Before the commit nothing records the file; after it began, the store's daily
            // sweep deletes it when the commit did not hold.
            if !committing {
                let _ = deps.files.delete(ctx.workspace_id, id).await;
            }
            Err(e)
        }
    }
}

/// `inbox.attachments_get` (spec §3.15): mail file `id` of the workspace, and, while the store
/// holds it, an address that downloads it for [`DOWNLOAD_FOR`]. Needs `inbox.work`.
pub async fn get(deps: &Deps, ctx: &Ctx, id: FileId) -> Result<AttachmentGetOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let row = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.mail_files()
            .get(id)
            .await?
            .ok_or_else(|| AppError::not_found("no such mail file"))?
    };
    let (download_url, download_expires_at) = if row.state.holds_bytes() {
        let until = ctx.now + DOWNLOAD_FOR;
        let url = deps
            .files
            .attachment_url(ctx.workspace_id, id, until)
            .await?;
        (Some(url.to_string()), Some(until))
    } else {
        (None, None)
    };
    Ok(AttachmentGetOut {
        file: (&row).into(),
        download_url,
        download_expires_at,
    })
}

/// The staged files `ids` an email on capability `cap` attaches (spec §3.15), locked, in order:
/// email only (`attachments_require_email`), at most [`MAX_ATTACHMENTS`]
/// (`too_many_attachments`), each once (`attachment_repeated`), each an outbound file of this
/// workspace still staged and not expired (`attachment_not_staged`, naming it). `VALIDATION
/// {field: attachments, reason}` otherwise; nothing for none.
pub(crate) async fn staged_for_send(
    r: &mut dyn TenantRepos,
    cap: &Capability,
    ids: &[FileId],
    now: OffsetDateTime,
) -> Result<Vec<MailFileRow>, AppError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if cap.kind_key != "mailbox" {
        return Err(refused_input("attachments", "attachments_require_email"));
    }
    if ids.len() > MAX_ATTACHMENTS {
        return Err(refused_input("attachments", "too_many_attachments"));
    }
    if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err(refused_input("attachments", "attachment_repeated"));
    }
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        let row = r.mail_files().lock(*id).await?.filter(|row| {
            row.direction == MailFileDirection::Outbound
                && row.state == MailFileState::Staged
                && row.expires_at.is_some_and(|e| e > now)
        });
        match row {
            Some(row) => rows.push(row),
            None => {
                return Err(AppError::validation(
                    "attachments: attachment_not_staged",
                    json!({"field": "attachments", "reason": "attachment_not_staged", "file_id": id}),
                ));
            }
        }
    }
    Ok(rows)
}

/// The files queued email `row` names (`intent.mail.attachment_files`), as its claim finds
/// them: each still attached to its message and holding its bytes. `Err` with `FORBIDDEN
/// attachment_unavailable` (as the claim refuses) when one is not: an erasure took it.
pub(crate) async fn attached_for_claim(
    r: &mut dyn TenantRepos,
    row: &OutboxRow,
) -> Result<Result<Vec<MailFileRow>, AppError>, AppError> {
    let ids: Vec<FileId> = match row.intent.pointer("/mail/attachment_files") {
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|_| AppError::internal("invalid stored attachment files"))?,
        None => Vec::new(),
    };
    let mut files = Vec::with_capacity(ids.len());
    for id in ids {
        match r.mail_files().get(id).await? {
            Some(f)
                if f.state == MailFileState::Attached && f.message_id == Some(row.message_id) =>
            {
                files.push(f)
            }
            _ => {
                return Ok(Err(AppError {
                    code: ErrorCode::Forbidden,
                    message: "attachment_unavailable".into(),
                    details: json!({"reason": "attachment_unavailable"}),
                }));
            }
        }
    }
    Ok(Ok(files))
}

/// The bytes of `files` (claimed with their email) as the provider takes them, read from the
/// store after the claim and before the call (spec §3.15), each checked against its row's size
/// and hash; `None` when one is missing or changed.
pub(crate) async fn read_for_send(
    deps: &Deps,
    ws: WorkspaceId,
    files: &[MailFileRow],
) -> Option<Vec<Attachment>> {
    use sha2::{Digest, Sha256};
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let read = deps.files.read(ws, f.id).await.ok()?;
        let hash = hex_of(&Sha256::digest(&read.bytes));
        if read.bytes.len() as u64 != f.size_bytes || f.sha256.as_deref() != Some(hash.as_str()) {
            return None;
        }
        out.push(Attachment {
            filename: store_name(&f.filename),
            mime: f.declared_mime.clone(),
            bytes: read.bytes,
        });
    }
    Some(out)
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The mail files' purge of workspace `ws` at `now` (the `mail_files_purge` job's body, spec
/// §3.15, §6.4): inbound files stored more than the leads policy's `attachments.retention_days`
/// (at least one) ago, and staged files past their expiry, are marked `deleted` (their rows
/// stay), in batches of [`MAX_MAIL_FILE_PAGE`], each in its own transaction under the inbox
/// lock, at most [`MAX_PURGE_BATCHES`] a run; each batch's bytes are deleted once it commits (a
/// crash in between leaves them to the store's daily sweep). Answers how many files went.
pub async fn purge(deps: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> Result<u64, AppError> {
    let mut total = 0u64;
    for _ in 0..MAX_PURGE_BATCHES {
        let ids: Vec<FileId> = {
            let mut r = deps.uow.tenant(ws).await?;
            r.people().lock_workspace().await?;
            let days = r
                .workspace_policy()
                .read()
                .await?
                .leads
                .attachments
                .retention_days;
            let before = now - Duration::days(i64::from(days.max(1)));
            let due = r
                .mail_files()
                .due_for_purge(before, now, MAX_MAIL_FILE_PAGE)
                .await?;
            if due.is_empty() {
                break;
            }
            let ids: Vec<FileId> = due.iter().map(|f| f.id).collect();
            r.mail_files().mark_deleted(&ids, now).await?;
            r.commit().await?;
            ids
        };
        for id in &ids {
            let _ = deps.files.delete(ws, *id).await;
        }
        total += ids.len() as u64;
        if ids.len() < MAX_MAIL_FILE_PAGE as usize {
            break;
        }
    }
    Ok(total)
}
