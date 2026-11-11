//! Email attachments in the inbox (spec 2026-10-30-leads-pool-outreach-design.md §3.15): an
//! inbound email's files are stored, within caps, before the poll's transaction (and deleted
//! again when it fails or the email is a duplicate), linked to the message and the person when the
//! email is consumed, listed with the messages, and never put in an event's payload.

mod support;

use std::sync::Arc;

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{InboundAttachment, InboundEventDraft, MailboxCursor, PolledMail};
use jt_app::ports::files::FileMaintenance;
use jt_app::ports::mail_files::{MailFileDirection, MailFileRow, MailFileState, SkipReason};
use jt_app::usecases::inbox::attachments::{
    MAX_INBOUND_DAILY_BYTES, MAX_INBOUND_FILE_BYTES, MAX_INBOUND_FILES,
};
use jt_app::usecases::inbox::conversations::{self, MessagesInput};
use jt_app::usecases::inbox::erasure;
use jt_app::usecases::jobs;
use jt_connector::EventKind;
use jt_inbox::ConversationId;
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::ScriptedConnector;
use jt_testkit::fakes::files::MemoryFiles;
use serde_json::json;
use support::World;
use time::{Duration, OffsetDateTime};

/// A PDF's first bytes, then words that must never reach a payload, a log or the ledger.
const PDF: &[u8] = b"%PDF-1.7 PRIVATE-QUOTE-CONTENT";

/// A mailbox world whose file store is in memory.
async fn setup() -> (
    World,
    ConversationId,
    Arc<ScriptedConnector>,
    Arc<MemoryFiles>,
) {
    let (mut w, c, mail) = support::outbound::setup_channel("mailbox").await;
    let files = Arc::new(MemoryFiles::default());
    w.deps.files = files.clone();
    (w, c, mail, files)
}

fn attachment(filename: &str, mime: &str, bytes: &[u8]) -> InboundAttachment {
    InboundAttachment {
        filename: filename.into(),
        declared_mime: mime.into(),
        bytes: bytes.to_vec(),
    }
}

/// An email from Ada (UID `uid`) with `files`, as a poll gives it: the payload names each file,
/// the bytes come apart.
fn email(uid: u32, files: Vec<InboundAttachment>) -> PolledMail {
    let listed: Vec<_> = files
        .iter()
        .map(|a| json!({"filename": a.filename, "declared_mime": a.declared_mime, "size": a.bytes.len()}))
        .collect();
    PolledMail {
        draft: InboundEventDraft {
            external_id: format!("imap:support@example.com:INBOX:7:{uid}"),
            kind: EventKind::Message,
            payload: json!({
                "from": "ada@example.com",
                "subject": "Teklif",
                "text": "Ekte teklifimiz var",
                "message_id": format!("<m{uid}@example.invalid>"),
                "attachments": listed,
                "mailbox": "INBOX",
            }),
            occurred_at: None,
        },
        attachments: files,
    }
}

/// Polls `mail` once with `polled`; the job's report.
async fn poll(w: &World, mail: &ScriptedConnector, polled: Vec<PolledMail>) -> jobs::JobReport {
    mail.push_mailbox_poll_mail(Ok((polled, MailboxCursor::default())));
    jobs::run_mail_inbox_poll(&w.deps, w.owner_ctx.now).await
}

fn mail_rows(w: &World) -> Vec<MailFileRow> {
    let mut rows: Vec<MailFileRow> = w
        .uow
        .snapshot()
        .mail_files
        .rows
        .into_iter()
        .filter(|(ws, _)| *ws == w.ws)
        .map(|(_, r)| r)
        .collect();
    rows.sort_by_key(|r| (r.created_at, r.filename.clone(), r.id));
    rows
}

fn stored_ids(files: &MemoryFiles, ws: WorkspaceId) -> Vec<FileId> {
    let mut ids: Vec<FileId> = files
        .files
        .lock()
        .unwrap()
        .keys()
        .filter(|(w, _)| *w == ws)
        .map(|(_, id)| *id)
        .collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn attachments_stored_as_octet_stream() {
    let (w, _, mail, files) = setup().await;
    let report = poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![attachment("teklif.pdf", "application/pdf", PDF)],
        )],
    )
    .await;
    assert_eq!(report.failed, 0);
    let rows = mail_rows(&w);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.direction, MailFileDirection::Inbound);
    assert_eq!(row.state, MailFileState::Stored);
    assert_eq!(row.filename, "teklif.pdf");
    assert_eq!(row.declared_mime, "application/pdf");
    assert_eq!(row.size_bytes, PDF.len() as u64);
    assert_eq!(
        row.event_external_id.as_deref(),
        Some("imap:support@example.com:INBOX:7:1")
    );
    assert!(row.sha256.as_deref().is_some_and(|h| h.len() == 64));
    // The store keeps any bytes, whatever the email said they are.
    let kept = files.files.lock().unwrap()[&(w.ws, row.id)].clone();
    assert_eq!(kept.mime, "application/octet-stream");
    assert_eq!(kept.bytes, PDF);
    assert_eq!(kept.filename, "teklif.pdf");
}

#[tokio::test]
async fn caps_skip_with_reason() {
    let (w, _, mail, files) = setup().await;
    // Past the most files an email keeps: the first twenty are kept, the rest skipped.
    let many: Vec<_> = (0..=MAX_INBOUND_FILES)
        .map(|i| attachment(&format!("{i:02}.txt"), "text/plain", b"x"))
        .collect();
    // Larger than one file may be.
    let large = vec![0u8; MAX_INBOUND_FILE_BYTES as usize + 1];
    poll(
        &w,
        &mail,
        vec![
            email(1, many),
            email(
                2,
                vec![attachment("big.bin", "application/octet-stream", &large)],
            ),
        ],
    )
    .await;
    let rows = mail_rows(&w);
    assert_eq!(rows.len(), MAX_INBOUND_FILES + 2);
    let skipped: Vec<_> = rows
        .iter()
        .filter(|r| r.state == MailFileState::Skipped)
        .map(|r| (r.filename.as_str(), r.skip_reason, r.sha256.is_none()))
        .collect();
    assert_eq!(
        skipped,
        [
            ("20.txt", Some(SkipReason::TooManyFiles), true),
            ("big.bin", Some(SkipReason::FileTooLarge), true),
        ]
    );
    assert_eq!(stored_ids(&files, w.ws).len(), MAX_INBOUND_FILES);

    // The workspace's bytes of the last day: a file past them is skipped, a smaller one after it
    // still fits.
    let cap = rows[0].capability_id.unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.mail_files()
        .insert(MailFileRow {
            id: FileId::new_v7(),
            direction: MailFileDirection::Inbound,
            state: MailFileState::Stored,
            skip_reason: None,
            capability_id: Some(cap),
            event_external_id: Some("imap:earlier".into()),
            message_id: None,
            person_id: None,
            filename: "earlier.bin".into(),
            declared_mime: "application/octet-stream".into(),
            size_bytes: MAX_INBOUND_DAILY_BYTES - 100 - MAX_INBOUND_FILES as u64,
            sha256: Some("0".repeat(64)),
            created_at: w.owner_ctx.now - Duration::hours(23),
            expires_at: None,
            deleted_at: None,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    poll(
        &w,
        &mail,
        vec![email(
            3,
            vec![
                attachment("over.pdf", "application/pdf", &[1u8; 101]),
                attachment("fits.pdf", "application/pdf", &[1u8; 100]),
            ],
        )],
    )
    .await;
    let states: Vec<_> = mail_rows(&w)
        .into_iter()
        .filter(|r| r.event_external_id.as_deref() == Some("imap:support@example.com:INBOX:7:3"))
        .map(|r| (r.filename, r.state, r.skip_reason))
        .collect();
    assert_eq!(
        states,
        [
            ("fits.pdf".to_owned(), MailFileState::Stored, None),
            (
                "over.pdf".to_owned(),
                MailFileState::Skipped,
                Some(SkipReason::DailyLimit)
            ),
        ]
    );
}

#[tokio::test]
async fn duplicate_draft_deletes_its_files() {
    let (w, _, mail, files) = setup().await;
    let once = email(1, vec![attachment("teklif.pdf", "application/pdf", PDF)]);
    poll(&w, &mail, vec![once.clone()]).await;
    let first = stored_ids(&files, w.ws);
    assert_eq!(first.len(), 1);
    // The same email again (a poll repeated after a lost answer): its new copy goes.
    let report = poll(&w, &mail, vec![once]).await;
    assert_eq!((report.failed, report.skipped), (0, 1));
    assert_eq!(stored_ids(&files, w.ws), first);
    assert_eq!(mail_rows(&w).len(), 1);
}

#[tokio::test]
async fn failed_transaction_deletes_its_files() {
    let (w, _, mail, files) = setup().await;
    w.uow.fail_mail_cursor(1);
    let report = poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![attachment("teklif.pdf", "application/pdf", PDF)],
        )],
    )
    .await;
    assert_eq!(report.failed, 1);
    assert!(stored_ids(&files, w.ws).is_empty());
    assert!(mail_rows(&w).is_empty());
    assert!(w.uow.snapshot().inbound_events.is_empty());
    // Polled again, the email and its file are kept.
    let report = poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![attachment("teklif.pdf", "application/pdf", PDF)],
        )],
    )
    .await;
    assert_eq!(report.failed, 0);
    assert_eq!(stored_ids(&files, w.ws).len(), 1);
    assert_eq!(mail_rows(&w).len(), 1);
}

#[tokio::test]
async fn consumer_links_files_to_message_and_person() {
    let (w, c, mail, _) = setup().await;
    poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![
                attachment("teklif.pdf", "application/pdf", PDF),
                attachment("liste.csv", "text/csv", b"a,b\n"),
            ],
        )],
    )
    .await;
    let s = w.uow.snapshot();
    let message = s
        .inbox
        .messages
        .iter()
        .find(|m| {
            m.conversation_id == c && m.external_id.as_deref() == Some("<m1@example.invalid>")
        })
        .expect("the email is a message")
        .id;
    let person = s
        .inbox
        .conversations
        .iter()
        .find(|x| x.id == c)
        .unwrap()
        .person_id;
    let rows = mail_rows(&w);
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|r| r.message_id == Some(message) && r.person_id == Some(person))
    );
}

#[tokio::test]
async fn messages_list_shows_attachments() {
    let (w, c, mail, _) = setup().await;
    poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![
                attachment("teklif.pdf", "application/pdf", PDF),
                attachment(
                    "big.bin",
                    "application/octet-stream",
                    &vec![0u8; MAX_INBOUND_FILE_BYTES as usize + 1],
                ),
            ],
        )],
    )
    .await;
    let page = conversations::messages(
        &w.deps,
        &w.owner_ctx,
        c,
        MessagesInput {
            cursor: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    let item = page
        .items
        .iter()
        .find(|m| m.message.external_id.as_deref() == Some("<m1@example.invalid>"))
        .unwrap();
    let listed = serde_json::to_value(item).unwrap()["attachments"].clone();
    let rows = mail_rows(&w);
    let stored = rows.iter().find(|r| r.filename == "teklif.pdf").unwrap();
    let skipped = rows.iter().find(|r| r.filename == "big.bin").unwrap();
    assert_eq!(
        listed,
        json!([
            {"file_id": stored.id, "filename": "teklif.pdf", "declared_mime": "application/pdf",
             "size_bytes": PDF.len(), "state": "stored", "skip_reason": null},
            {"file_id": skipped.id, "filename": "big.bin", "declared_mime": "application/octet-stream",
             "size_bytes": MAX_INBOUND_FILE_BYTES + 1, "state": "skipped",
             "skip_reason": "file_too_large"},
        ])
    );
    // A message without files lists none.
    let other = page.items.iter().find(|m| m.message.id != item.message.id);
    if let Some(other) = other {
        assert_eq!(
            serde_json::to_value(other).unwrap()["attachments"],
            json!([])
        );
    }
}

#[tokio::test]
async fn payload_never_holds_bytes() {
    let (w, _, mail, _) = setup().await;
    poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![attachment("teklif.pdf", "application/pdf", PDF)],
        )],
    )
    .await;
    let row = mail_rows(&w).remove(0);
    let events = w.uow.snapshot().inbound_events;
    assert_eq!(events.len(), 1);
    let payload = &events[0].event.payload;
    assert_eq!(
        payload["attachments"],
        json!([{"filename": "teklif.pdf", "declared_mime": "application/pdf",
                "size": PDF.len(), "file_id": row.id}])
    );
    let text = payload.to_string();
    assert!(!text.contains("PRIVATE-QUOTE-CONTENT"), "{text}");
    assert!(events[0].raw.is_none());
    for entry in w.uow.snapshot().ledger {
        assert!(
            !entry
                .entry
                .payload
                .to_string()
                .contains("PRIVATE-QUOTE-CONTENT")
        );
    }
}

#[tokio::test]
async fn an_erased_senders_email_keeps_no_files() {
    let (w, c, mail, files) = setup().await;
    let person = w
        .uow
        .snapshot()
        .inbox
        .conversations
        .iter()
        .find(|x| x.id == c)
        .unwrap()
        .person_id;
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        person,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let report = poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![attachment("teklif.pdf", "application/pdf", PDF)],
        )],
    )
    .await;
    assert_eq!(report.failed, 0);
    assert!(stored_ids(&files, w.ws).is_empty());
    assert!(mail_rows(&w).is_empty());
}

/// Every file of the workspace's store is an orphan candidate (as a day-old file the store's
/// sweep lists).
struct EveryFile(Arc<MemoryFiles>);

#[async_trait::async_trait]
impl FileMaintenance for EveryFile {
    async fn orphan_candidates(
        &self,
        ws: WorkspaceId,
        _: OffsetDateTime,
    ) -> Result<Vec<FileId>, jt_app::error::AppError> {
        Ok(stored_ids(&self.0, ws))
    }
}

#[tokio::test]
async fn the_store_sweep_keeps_mail_files() {
    let (mut w, _, mail, files) = setup().await;
    w.deps.file_maintenance = Arc::new(EveryFile(files.clone()));
    poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![
                attachment("teklif.pdf", "application/pdf", PDF),
                attachment("liste.csv", "text/csv", b"a,b\n"),
            ],
        )],
    )
    .await;
    let rows = mail_rows(&w);
    // The sweep keeps the bytes of every mail file its row holds; once a row is deleted (a crash
    // after its erasure or purge committed, before the bytes went), the sweep deletes them.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.mail_files()
        .mark_deleted(&[rows[1].id], w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    jt_app::usecases::studio::files::cleanup_files(&w.deps, w.ws)
        .await
        .unwrap();
    assert_eq!(stored_ids(&files, w.ws), [rows[0].id]);
}

// ---------------------------------------------------------------------------------------------
// Outbound files, the download address, erasure and retention (plan L6-T3)
// ---------------------------------------------------------------------------------------------

use base64::{Engine, engine::general_purpose::STANDARD};
use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::connectors::SendReceipt;
use jt_app::usecases::inbox::attachments::{
    self, AttachmentOut, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, STAGED_FOR, UploadInput,
};
use jt_app::usecases::inbox::{quotes, replies};
use jt_testkit::fakes::ConnectorCall;

fn accepted() -> Result<SendReceipt, jt_connector::ConnectorError> {
    accepted_as("provider-1")
}

fn accepted_as(id: &str) -> Result<SendReceipt, jt_connector::ConnectorError> {
    Ok(SendReceipt {
        provider_id: id.into(),
        cost_minor: None,
    })
}

fn upload_input(key: &str, filename: &str, mime: &str, bytes: &[u8]) -> UploadInput {
    UploadInput {
        request_key: key.into(),
        filename: filename.into(),
        mime: mime.into(),
        data_base64: STANDARD.encode(bytes),
    }
}

/// Uploads a small PDF named `name` under request key `key`, as the owner.
async fn uploaded(w: &World, key: &str, name: &str) -> AttachmentOut {
    attachments::upload(
        &w.deps,
        &w.owner_ctx,
        upload_input(key, name, "application/pdf", PDF),
    )
    .await
    .unwrap()
}

fn invalid_reason(e: &jt_app::error::AppError) -> &str {
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    e.details["reason"].as_str().unwrap_or_default()
}

fn reply_with(files: &[FileId]) -> replies::ReplyInput {
    serde_json::from_value(
        json!({"text": "Katalog ektedir", "intent": "reply", "attachments": files}),
    )
    .unwrap()
}

fn row_of(w: &World, id: FileId) -> MailFileRow {
    mail_rows(w).into_iter().find(|r| r.id == id).unwrap()
}

#[tokio::test]
async fn upload_checks_magic_bytes_and_size() {
    let (w, _, _, files) = setup().await;
    let out = uploaded(&w, "up-1", "katalog.pdf").await;
    let row = row_of(&w, out.attachment.file_id);
    assert_eq!(
        (row.direction, row.state, row.declared_mime.as_str()),
        (
            MailFileDirection::Outbound,
            MailFileState::Staged,
            "application/pdf"
        )
    );
    assert_eq!(row.expires_at, Some(w.owner_ctx.now + STAGED_FOR));
    assert_eq!(out.expires_at, row.expires_at);
    let kept = files.files.lock().unwrap()[&(w.ws, row.id)].clone();
    assert_eq!(
        (kept.mime.as_str(), kept.bytes.as_slice()),
        ("application/octet-stream", PDF)
    );
    // The ledger names the file, its size and type, never its name.
    let entry = w
        .uow
        .snapshot()
        .ledger
        .into_iter()
        .find(|l| l.entry.action.as_str() == "inbox.attachment.uploaded")
        .expect("ledgered");
    assert!(!entry.entry.payload.to_string().contains("katalog"));
    assert_eq!(entry.entry.payload["size_bytes"], PDF.len());

    // The same key replays the same file, storing nothing more.
    let again = uploaded(&w, "up-1", "baska.pdf").await;
    assert_eq!(again, out);
    assert_eq!(stored_ids(&files, w.ws).len(), 1);

    // Every type is checked by its first bytes; the size and the encoding too.
    let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
    let jpeg = [0xffu8, 0xd8, 0xff, 0xe0, 1, 2];
    let zip = b"PK\x03\x04rest".to_vec();
    for (mime, bytes) in [
        ("image/png", png.as_slice()),
        ("image/jpeg", jpeg.as_slice()),
        ("text/plain", "Merhaba dünya".as_bytes()),
        ("text/csv", b"a,b\n1,2\n".as_slice()),
        (attachments::DOCX, zip.as_slice()),
        (attachments::XLSX, zip.as_slice()),
    ] {
        let key = format!("ok-{mime}");
        attachments::upload(&w.deps, &w.owner_ctx, upload_input(&key, "f", mime, bytes))
            .await
            .unwrap_or_else(|e| panic!("{mime}: {e:?}"));
    }
    let large = {
        let mut b = b"%PDF-".to_vec();
        b.resize(MAX_UPLOAD_BYTES as usize + 1, b'0');
        b
    };
    let exact = &large[..MAX_UPLOAD_BYTES as usize];
    attachments::upload(
        &w.deps,
        &w.owner_ctx,
        upload_input("exact", "f.pdf", "application/pdf", exact),
    )
    .await
    .unwrap();
    for (input, field, reason) in [
        (
            upload_input("a", "f.pdf", "application/pdf", &png),
            "data_base64",
            "type_mismatch",
        ),
        (
            upload_input("b", "f.txt", "text/plain", b"a\0b"),
            "data_base64",
            "type_mismatch",
        ),
        (
            upload_input("c", "f.pdf", "application/pdf", b""),
            "data_base64",
            "type_mismatch",
        ),
        (
            upload_input("d", "f.html", "text/html", b"<html>"),
            "mime",
            "unsupported_type",
        ),
        (
            upload_input("e", "f.pdf", "application/pdf", &large),
            "data_base64",
            "file_too_large",
        ),
        (
            upload_input("f", "   ", "application/pdf", PDF),
            "filename",
            "required",
        ),
        (
            UploadInput {
                data_base64: "not base64!".into(),
                ..upload_input("g", "f.pdf", "application/pdf", PDF)
            },
            "data_base64",
            "not_base64",
        ),
    ] {
        let e = attachments::upload(&w.deps, &w.owner_ctx, input)
            .await
            .unwrap_err();
        assert_eq!(invalid_reason(&e), reason);
        assert_eq!(e.details["field"], field);
    }
    // Refused uploads keep nothing.
    assert_eq!(stored_ids(&files, w.ws).len(), 1 + 6 + 1);
    assert_eq!(mail_rows(&w).len(), 1 + 6 + 1);
}

#[tokio::test]
async fn attach_only_on_email() {
    let (mut w, c, _) = support::outbound::setup_channel("sms_line").await;
    let files = Arc::new(MemoryFiles::default());
    w.deps.files = files.clone();
    let file = uploaded(&w, "sms-file", "katalog.pdf")
        .await
        .attachment
        .file_id;
    let e = replies::reply(&w.deps, &w.owner_ctx, c, reply_with(&[file]))
        .await
        .unwrap_err();
    assert_eq!(invalid_reason(&e), "attachments_require_email");
    assert!(w.uow.snapshot().inbox.outbox.is_empty());
    assert_eq!(row_of(&w, file).state, MailFileState::Staged);
}

#[tokio::test]
async fn attach_at_most_five_and_within_message_bound() {
    let (w, c, mail, _) = setup().await;
    let mut ids = Vec::new();
    for i in 0..=MAX_ATTACHMENTS {
        ids.push(
            uploaded(&w, &format!("k{i}"), &format!("{i}.pdf"))
                .await
                .attachment
                .file_id,
        );
    }
    let refused = |files: Vec<FileId>, ctx: Ctx| {
        let w = &w;
        async move {
            replies::reply(&w.deps, &ctx, c, reply_with(&files))
                .await
                .unwrap_err()
        }
    };
    let e = refused(ids.clone(), w.owner_ctx.clone()).await;
    assert_eq!(invalid_reason(&e), "too_many_attachments");
    let e = refused(vec![ids[0], ids[0]], w.owner_ctx.clone()).await;
    assert_eq!(invalid_reason(&e), "attachment_repeated");
    let e = refused(vec![FileId::new_v7()], w.owner_ctx.clone()).await;
    assert_eq!(invalid_reason(&e), "attachment_not_staged");
    // Two files of 7 MiB are more than an email holds once written.
    let big = {
        let mut b = b"%PDF-".to_vec();
        b.resize(MAX_UPLOAD_BYTES as usize, b'0');
        b
    };
    let mut large = Vec::new();
    for key in ["big-1", "big-2"] {
        let out = attachments::upload(
            &w.deps,
            &w.owner_ctx,
            upload_input(key, "b.pdf", "application/pdf", &big),
        )
        .await
        .unwrap();
        large.push(out.attachment.file_id);
    }
    let e = refused(large.clone(), w.owner_ctx.clone()).await;
    assert_eq!(invalid_reason(&e), "message_too_large");
    // An upload past its seven days is no longer attachable.
    let later = Ctx {
        now: w.owner_ctx.now + STAGED_FOR,
        ..w.owner_ctx.clone()
    };
    let e = refused(vec![ids[0]], later).await;
    assert_eq!(invalid_reason(&e), "attachment_not_staged");
    assert!(w.uow.snapshot().inbox.outbox.is_empty());

    // Five, and one large file, are fine; each goes with one email only.
    mail.push_mail(accepted());
    replies::reply(
        &w.deps,
        &w.owner_ctx,
        c,
        reply_with(&ids[..MAX_ATTACHMENTS]),
    )
    .await
    .unwrap();
    mail.push_mail(accepted_as("provider-2"));
    replies::reply(&w.deps, &w.owner_ctx, c, reply_with(&large[..1]))
        .await
        .unwrap();
    let e = refused(vec![ids[0]], w.owner_ctx.clone()).await;
    assert_eq!(invalid_reason(&e), "attachment_not_staged");
    let sent: Vec<usize> = mail
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            ConnectorCall::SendMail { message, .. } => Some(message.attachments.len()),
            _ => None,
        })
        .collect();
    assert_eq!(sent, [MAX_ATTACHMENTS, 1]);
}

#[tokio::test]
async fn prepare_reads_bytes_and_intent_holds_ids_only() {
    let (w, c, mail, _) = setup().await;
    let file = uploaded(&w, "cat", "katalog.pdf").await.attachment.file_id;
    mail.push_mail(accepted());
    let out = replies::reply(&w.deps, &w.owner_ctx, c, reply_with(&[file]))
        .await
        .unwrap();
    assert_eq!(out.state, "sent");
    let s = w.uow.snapshot();
    let row = s
        .inbox
        .outbox
        .iter()
        .find(|o| o.message_id == out.message_id)
        .unwrap();
    assert_eq!(row.intent["mail"]["attachment_files"], json!([file]));
    assert!(
        row.intent["mail"]
            .get("attachments")
            .is_none_or(|a| a == &json!([]))
    );
    let intent = row.intent.to_string();
    assert!(!intent.contains("PRIVATE-QUOTE-CONTENT") && !intent.contains(&STANDARD.encode(PDF)));
    // The provider got the bytes, read from the store at send time.
    let message = mail
        .calls()
        .into_iter()
        .find_map(|call| match call {
            ConnectorCall::SendMail { message, .. } => Some(message),
            _ => None,
        })
        .unwrap();
    assert_eq!(message.attachments.len(), 1);
    let a = &message.attachments[0];
    assert_eq!(
        (a.filename.as_str(), a.mime.as_str(), a.bytes.as_slice()),
        ("katalog.pdf", "application/pdf", PDF)
    );
    // The file is the message's now, and the inbox lists it with it.
    let attached = row_of(&w, file);
    assert_eq!(attached.state, MailFileState::Attached);
    assert_eq!(attached.message_id, Some(out.message_id));
    assert_eq!(attached.expires_at, None);
    let page = conversations::messages(
        &w.deps,
        &w.owner_ctx,
        c,
        MessagesInput {
            cursor: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    let item = page
        .items
        .iter()
        .find(|m| m.message.id == out.message_id)
        .unwrap();
    assert_eq!(item.attachments.len(), 1);
    assert_eq!(item.attachments[0].state, MailFileState::Attached);
}

#[tokio::test]
async fn quote_with_attachment_sets_file_ref() {
    let (w, _, mail, _) = setup().await;
    let journey = w.uow.snapshot().inbox.journeys[0].id;
    let file = uploaded(&w, "quote-file", "teklif.pdf")
        .await
        .attachment
        .file_id;
    let input = |file_ref: Option<&str>, key: &str| -> quotes::SendInput {
        serde_json::from_value(json!({
            "amount_minor": 12300, "currency": "TRY",
            "valid_until": (w.owner_ctx.now + Duration::days(3))
                .format(&time::format_description::well_known::Rfc3339).unwrap(),
            "file_ref": file_ref, "channel": "email", "text": "Teklifimiz ektedir",
            "intent": "reply", "request_key": key, "attachments": [file],
        }))
        .unwrap()
    };
    let e = quotes::send(
        &w.deps,
        &w.owner_ctx,
        journey,
        input(Some("opaque:x"), "q1"),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid_reason(&e), "file_ref_and_attachments");
    mail.push_mail(accepted());
    let out = quotes::send(&w.deps, &w.owner_ctx, journey, input(None, "q2"))
        .await
        .unwrap();
    assert_eq!(
        out.quote.quote.file_ref,
        Some(format!("mail_file:{}", file.0))
    );
    assert_eq!(row_of(&w, file).state, MailFileState::Attached);
    let sent = mail
        .calls()
        .into_iter()
        .find_map(|call| match call {
            ConnectorCall::SendMail { message, .. } => Some(message),
            _ => None,
        })
        .unwrap();
    assert_eq!(sent.attachments[0].bytes, PDF);
}

#[tokio::test]
async fn get_answers_a_download_address() {
    let (w, _, _, _) = setup().await;
    let file = uploaded(&w, "g", "katalog.pdf").await.attachment.file_id;
    let got = attachments::get(&w.deps, &w.owner_ctx, file).await.unwrap();
    assert_eq!(got.file.attachment.filename, "katalog.pdf");
    assert_eq!(got.file.attachment.state, MailFileState::Staged);
    let url = got.download_url.unwrap();
    assert!(url.ends_with("?purpose=attachment"), "{url}");
    assert_eq!(
        got.download_expires_at,
        Some(w.owner_ctx.now + Duration::minutes(10))
    );
    // Once its bytes went, the file is described and no address is given.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.mail_files()
        .mark_deleted(&[file], w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let got = attachments::get(&w.deps, &w.owner_ctx, file).await.unwrap();
    assert_eq!(got.file.attachment.state, MailFileState::Deleted);
    assert_eq!((got.download_url, got.download_expires_at), (None, None));
    let e = attachments::get(&w.deps, &w.owner_ctx, FileId::new_v7())
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn erasure_deletes_files() {
    let (w, c, mail, files) = setup().await;
    poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![attachment("teklif.pdf", "application/pdf", PDF)],
        )],
    )
    .await;
    let sent = uploaded(&w, "out", "katalog.pdf").await.attachment.file_id;
    mail.push_mail(accepted());
    replies::reply(&w.deps, &w.owner_ctx, c, reply_with(&[sent]))
        .await
        .unwrap();
    let unrelated = uploaded(&w, "other", "fiyat.pdf").await.attachment.file_id;
    let person = w
        .uow
        .snapshot()
        .inbox
        .conversations
        .iter()
        .find(|x| x.id == c)
        .unwrap()
        .person_id;
    assert_eq!(stored_ids(&files, w.ws).len(), 3);
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        person,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    // The person's files, in and out, lose their names and their bytes; the rows stay.
    for row in mail_rows(&w).into_iter().filter(|r| r.id != unrelated) {
        assert_eq!(
            (row.state, row.filename.as_str(), row.deleted_at),
            (MailFileState::Deleted, "", Some(w.owner_ctx.now)),
            "{row:?}"
        );
    }
    assert_eq!(stored_ids(&files, w.ws), [unrelated]);
    assert_eq!(row_of(&w, unrelated).state, MailFileState::Staged);
}

#[tokio::test]
async fn purge_respects_retention_and_staging() {
    let (w, _, mail, files) = setup().await;
    let now = w.owner_ctx.now;
    poll(
        &w,
        &mail,
        vec![email(
            1,
            vec![attachment("eski.pdf", "application/pdf", PDF)],
        )],
    )
    .await;
    let old = mail_rows(&w)[0].clone();
    let expired = uploaded(&w, "expired", "a.pdf").await.attachment.file_id;
    let attached = uploaded(&w, "attached", "b.pdf").await.attachment.file_id;
    mail.push_mail(accepted());
    let conversation = w.uow.snapshot().inbox.conversations[0].id;
    replies::reply(&w.deps, &w.owner_ctx, conversation, reply_with(&[attached]))
        .await
        .unwrap();
    // Thirty days of retention: the inbound file is due after them, the upload after its seven.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.workspace_policy()
        .patch_leads(json!({"attachments": {"retention_days": 30}}), now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let report = jobs::run_mail_files_purge(&w.deps, now + Duration::days(6)).await;
    assert_eq!((report.changed, report.failed), (0, 0));
    let report = jobs::run_mail_files_purge(&w.deps, now + STAGED_FOR).await;
    assert_eq!((report.changed, report.failed), (1, 0));
    assert_eq!(row_of(&w, expired).state, MailFileState::Deleted);
    assert_eq!(row_of(&w, old.id).state, MailFileState::Stored);
    let report = jobs::run_mail_files_purge(&w.deps, now + Duration::days(30)).await;
    assert_eq!((report.changed, report.failed), (1, 0));
    let gone = row_of(&w, old.id);
    assert_eq!(
        (gone.state, gone.deleted_at, gone.filename.as_str()),
        (
            MailFileState::Deleted,
            Some(now + Duration::days(30)),
            "eski.pdf"
        )
    );
    // A file attached to a sent email stays; nothing is due a second time.
    assert_eq!(row_of(&w, attached).state, MailFileState::Attached);
    assert_eq!(stored_ids(&files, w.ws), [attached]);
    let report = jobs::run_mail_files_purge(&w.deps, now + Duration::days(400)).await;
    assert_eq!((report.changed, report.failed), (0, 0));
    assert_eq!(jobs::Job::MailFilesPurge.name(), "mail_files_purge");
}

#[tokio::test]
async fn attachments_require_inbox_work() {
    let (w, _, _, _) = setup().await;
    let file = uploaded(&w, "mine", "katalog.pdf").await.attachment.file_id;
    let outsider = support::human(w.ws, w.owner, "rep", Default::default());
    let e = attachments::upload(
        &w.deps,
        &outsider,
        upload_input("theirs", "x.pdf", "application/pdf", PDF),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = attachments::get(&w.deps, &outsider, file)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
}
