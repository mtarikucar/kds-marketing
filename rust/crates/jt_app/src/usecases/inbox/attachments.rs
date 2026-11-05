//! Email attachments (spec 2026-10-30-leads-pool-outreach-design.md §3.15, §4.4): the files of
//! inbound email, kept within caps; what the inbox lists of them. The bytes live in the file store
//! (`ports::files::FileStore`), always as `application/octet-stream`, under their `mail_files`
//! row's id; no event payload, intent, ledger entry or log line ever holds them, and no log line
//! names a file.

use std::collections::BTreeSet;

use jt_capability::CapabilityId;
use jt_connector::EventKind;
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use serde::Serialize;
use serde_json::json;
use time::{Duration, OffsetDateTime};

use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::ports::connectors::{InboundEventDraft, MediaUpload, PolledMail};
use crate::ports::mail_files::{MailFileDirection, MailFileRow, MailFileState, SkipReason};
use crate::usecases::Deps;
use crate::usecases::files::OCTET_STREAM;
use crate::usecases::webhook::Delivery;

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
