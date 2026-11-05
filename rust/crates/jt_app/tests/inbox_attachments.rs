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
