//! Customers' chat files in the inbox (`usecases::inbox::media`), end to end over the fakes: a
//! WhatsApp image or document is recorded with its message, fetched by the media job through the
//! provider's media API, checked by its bytes, stored, listed with its message, opened under the
//! conversation's permission (recorded in the ledger), and let go of with the person's erasure or
//! after the retention. Every name, number and file here is invented.

mod support;

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{InboundEventDraft, Media};
use jt_app::ports::files::FileMaintenance;
use jt_app::ports::message_media::{MediaKind, MediaReason, MediaState, MessageMediaRow};
use jt_app::usecases::inbox::conversations::{self, MessagesInput};
use jt_app::usecases::inbox::erasure;
use jt_app::usecases::inbox::media::{
    self, BACKOFF_MINUTES, Hand, MAX_ATTEMPTS, MAX_IMAGE_BYTES, MediaInput, RETENTION,
};
use jt_app::usecases::jobs;
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, InboundEvent, InboundEventId, Provider};
use jt_inbox::{ConversationId, MessageId, PersonId};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::files::MemoryFiles;
use jt_testkit::fakes::{FIXED_NOW, ScriptedConnector, ScriptedRegistry, media_of};
use serde_json::{Value, json};
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

struct T {
    w: World,
    cap: CapabilityId,
    meta: Arc<ScriptedConnector>,
    files: Arc<MemoryFiles>,
}

/// A JPEG's first bytes with a frame header naming 640x480 pixels; the rest is invented.
fn jpeg() -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, b'J', b'F'];
    out.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0xE0, 0x02, 0x80]);
    out.extend_from_slice(b"INVENTED-PIXELS");
    out
}

/// A PDF's first bytes, then words that must never reach a log, the ledger or a payload.
const PDF: &[u8] = b"%PDF-1.7 PRIVATE-OFFER-CONTENT";

fn media(mime: &str, data: &[u8]) -> Media {
    Media {
        mime: mime.into(),
        data: data.to_vec(),
    }
}

fn meta_drafts(file: &str) -> Vec<InboundEventDraft> {
    let raw = std::fs::read(format!(
        "{}/tests/fixtures/meta/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    jt_meta::webhook::parse(&raw)
        .unwrap()
        .into_iter()
        .map(|p| p.event)
        .collect()
}

/// An active workspace with a verified WhatsApp number, the scripted Meta connector and an
/// in-memory file store.
async fn setup() -> T {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let meta = Arc::new(ScriptedConnector::new(Provider::Meta));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(meta.clone()));
    let files = Arc::new(MemoryFiles::default());
    w.deps.files = files.clone();
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "whatsapp_cloud".into(),
            name: "Atölye WhatsApp".into(),
            ..Default::default()
        },
        FIXED_NOW - Duration::days(2),
    )
    .unwrap();
    cap.external_id = Some(cap.id.to_string());
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW - Duration::days(1));
    let cred = Credential::WhatsAppCloud {
        phone_number_id: "line".into(),
        token: "private-token".into(),
        waba_id: None,
        expires_at: None,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    jt_app::usecases::modules::install(&w.deps, &w.owner_ctx, "inbox", Default::default())
        .await
        .unwrap();
    T {
        w,
        cap: id,
        meta,
        files,
    }
}

/// Stores the fixture customer's WhatsApp message `wamid` of `kind` (`image`, `document`) with
/// `body` as its file's part, received at `tick` seconds after the fixed time, and consumes it.
async fn inbound(t: &T, wamid: &str, kind: &str, body: Value, tick: i64) {
    let mut draft = meta_drafts("whatsapp_messages").remove(0);
    let received = FIXED_NOW + Duration::seconds(tick);
    let m = &mut draft.payload["message"];
    m["id"] = json!(wamid);
    m["type"] = json!(kind);
    m.as_object_mut().unwrap().remove("text");
    m[kind] = body;
    draft.external_id = wamid.to_owned();
    draft.payload["occurred_at"] = json!(received.format(&Rfc3339).unwrap());
    let mut r = t.w.uow.tenant(t.w.ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: t.w.ws,
                capability_id: Some(t.cap),
                provider: Provider::Meta,
                external_id: draft.external_id,
                kind: draft.kind,
                payload: draft.payload,
                received_at: received,
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let report = jobs::run_inbox_consume(&t.w.deps, received + Duration::seconds(1)).await;
    assert_eq!(report.failed, 0, "{report:?}");
}

fn image(id: &str) -> Value {
    json!({ "id": id, "mime_type": "image/jpeg", "sha256": "invented", "caption": "Bu tarzda" })
}

fn document(id: &str, name: &str) -> Value {
    json!({ "id": id, "mime_type": "application/pdf", "sha256": "invented", "filename": name })
}

fn rows(t: &T) -> Vec<MessageMediaRow> {
    media_of(&t.w.uow.snapshot(), t.w.ws)
}

fn row(t: &T) -> MessageMediaRow {
    let all = rows(t);
    assert_eq!(all.len(), 1, "{all:?}");
    all.into_iter().next().unwrap()
}

fn stored_files(t: &T) -> Vec<(FileId, jt_app::ports::connectors::MediaUpload)> {
    t.files
        .files
        .lock()
        .unwrap()
        .iter()
        .filter(|((ws, _), _)| *ws == t.w.ws)
        .map(|((_, id), u)| (*id, u.clone()))
        .collect()
}

async fn job(t: &T, at: OffsetDateTime) -> jobs::JobReport {
    jobs::run_inbox_media(&t.w.deps, at).await
}

fn conversation(t: &T) -> (ConversationId, PersonId) {
    let c = t.w.uow.snapshot().inbox.conversations[0].clone();
    (c.id, c.person_id)
}

fn message_id(t: &T, wamid: &str) -> MessageId {
    t.w.uow
        .snapshot()
        .inbox
        .messages
        .iter()
        .find(|m| m.external_id.as_deref() == Some(wamid))
        .unwrap()
        .id
}

/// The `attachments` the messages list shows for message `wamid`.
async fn listed(t: &T, wamid: &str) -> Value {
    let (c, _) = conversation(t);
    let page = conversations::messages(
        &t.w.deps,
        &t.w.owner_ctx,
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
        .find(|m| m.message.external_id.as_deref() == Some(wamid))
        .unwrap();
    serde_json::to_value(item).unwrap()["attachments"].clone()
}

fn later(minutes: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(minutes)
}

#[tokio::test]
async fn a_customers_photo_is_recorded_with_its_message_then_fetched_and_shown() {
    let t = setup().await;
    inbound(&t, "wamid.photo1", "image", image("1500000000000001"), 0).await;
    // The message is stored with its marker; the file waits, nothing was asked of the provider.
    assert!(t.meta.media_calls().is_empty());
    let pending = row(&t);
    assert_eq!(pending.state, MediaState::Pending);
    assert_eq!(pending.kind, MediaKind::Image);
    assert_eq!(
        pending.provider_media_id.as_deref(),
        Some("1500000000000001")
    );
    assert_eq!(
        listed(&t, "wamid.photo1").await,
        json!([{"index": 0, "kind": "image", "file_id": null, "filename": "",
                "declared_mime": "image/jpeg", "mime": null, "size_bytes": null,
                "width": null, "height": null, "state": "pending", "reason": null,
                "skip_reason": null}])
    );

    let photo = jpeg();
    t.meta.push_media(Ok(Some(media("image/jpeg", &photo))));
    let report = job(&t, later(1)).await;
    assert_eq!((report.changed, report.failed), (1, 0), "{report:?}");
    // Fetched by its media id, within an image's limit.
    assert_eq!(
        t.meta.media_calls(),
        [("1500000000000001".to_owned(), MAX_IMAGE_BYTES as usize)]
    );
    let kept = row(&t);
    assert_eq!(kept.state, MediaState::Stored);
    assert_eq!(kept.provider_media_id, None);
    assert_eq!((kept.width, kept.height), (Some(640), Some(480)));
    let files = stored_files(&t);
    assert_eq!(files.len(), 1);
    assert_eq!(Some(files[0].0), kept.file_id);
    assert_eq!(files[0].1.mime, "image/jpeg");
    assert_eq!(files[0].1.bytes, photo);
    assert_eq!(
        listed(&t, "wamid.photo1").await,
        json!([{"index": 0, "kind": "image", "file_id": kept.file_id, "filename": "",
                "declared_mime": "image/jpeg", "mime": "image/jpeg",
                "size_bytes": photo.len(), "width": 640, "height": 480, "state": "stored",
                "reason": null, "skip_reason": null}])
    );
    // A later run has nothing to fetch.
    let again = job(&t, later(2)).await;
    assert_eq!(again.touched, 0, "{again:?}");
    assert_eq!(t.meta.media_calls().len(), 1);
}

#[tokio::test]
async fn the_declared_type_is_never_trusted() {
    let t = setup().await;
    inbound(&t, "wamid.fake", "image", image("1500000000000002"), 0).await;
    // Called a JPEG, it is a page.
    t.meta
        .push_media(Ok(Some(media("image/jpeg", b"<html><script>x</script>"))));
    job(&t, later(1)).await;
    let refused = row(&t);
    assert_eq!(
        (refused.state, refused.reason),
        (MediaState::Failed, Some(MediaReason::NotAllowed))
    );
    assert!(stored_files(&t).is_empty());
    let shown = listed(&t, "wamid.fake").await;
    assert_eq!(shown[0]["state"], "failed");
    assert_eq!(shown[0]["reason"], "not_allowed");
}

#[tokio::test]
async fn a_document_is_kept_as_a_download_only() {
    let t = setup().await;
    inbound(
        &t,
        "wamid.doc1",
        "document",
        document("1500000000000003", "teklif.pdf"),
        0,
    )
    .await;
    t.meta.push_media(Ok(Some(media("application/pdf", PDF))));
    job(&t, later(1)).await;
    let kept = row(&t);
    assert_eq!(kept.state, MediaState::Stored);
    assert_eq!(kept.mime.as_deref(), Some("application/pdf"));
    let files = stored_files(&t);
    assert_eq!(files[0].1.mime, "application/octet-stream");
    assert_eq!(files[0].1.filename, "teklif.pdf");
    let shown = listed(&t, "wamid.doc1").await;
    assert_eq!(shown[0]["kind"], "document");
    assert_eq!(shown[0]["filename"], "teklif.pdf");
    // Opened, it is a download address; to an agent too.
    let message = message_id(&t, "wamid.doc1");
    let opened = media::open(
        &t.w.deps,
        &t.w.owner_ctx,
        message,
        MediaInput::default(),
        Hand::Content,
    )
    .await
    .unwrap();
    assert!(opened.image.is_none());
    assert!(opened.url.unwrap().ends_with("purpose=attachment"));
    // Nothing of the file reaches the ledger.
    for entry in t.w.uow.snapshot().ledger {
        assert!(!entry.entry.payload.to_string().contains("PRIVATE-OFFER"));
        assert!(!entry.entry.payload.to_string().contains("teklif"));
    }
}

#[tokio::test]
async fn a_failed_fetch_is_tried_again_then_given_up_with_why() {
    let t = setup().await;
    inbound(&t, "wamid.slow", "image", image("1500000000000004"), 0).await;
    let mut now = later(1);
    for attempt in 1..=MAX_ATTEMPTS {
        t.meta
            .push_media(Err(ConnectorError::transient("provider down")));
        let report = job(&t, now).await;
        assert_eq!(report.failed, 0, "{report:?}");
        let r = row(&t);
        assert_eq!(r.attempts, attempt);
        if attempt < MAX_ATTEMPTS {
            assert_eq!(r.state, MediaState::Pending);
            let wait = BACKOFF_MINUTES[(attempt as usize - 1).min(BACKOFF_MINUTES.len() - 1)];
            assert_eq!(r.next_attempt_at, Some(now + Duration::minutes(wait)));
            // Not due before its time.
            let early = job(&t, now + Duration::minutes(wait) - Duration::seconds(1)).await;
            assert_eq!(early.touched, 0);
            now += Duration::minutes(wait);
        } else {
            assert_eq!(
                (r.state, r.reason),
                (MediaState::Failed, Some(MediaReason::Unavailable))
            );
        }
    }
    assert_eq!(t.meta.media_calls().len(), MAX_ATTEMPTS as usize);
}

#[tokio::test]
async fn an_expired_or_too_large_file_says_so() {
    let t = setup().await;
    inbound(&t, "wamid.old", "image", image("1500000000000005"), 0).await;
    inbound(&t, "wamid.big", "image", image("1500000000000006"), 1).await;
    inbound(&t, "wamid.huge", "image", image("1500000000000007"), 2).await;
    t.meta.push_media(Err(ConnectorError::permanent(
        "HTTP 404 for the media file",
    )));
    t.meta.push_media(Err(ConnectorError::permanent(
        "the media file is too large",
    )));
    let mut oversized = jpeg();
    oversized.resize(MAX_IMAGE_BYTES as usize + 1, 0);
    t.meta.push_media(Ok(Some(media("image/jpeg", &oversized))));
    job(&t, later(1)).await;
    let reasons: Vec<_> = ["wamid.old", "wamid.big", "wamid.huge"]
        .iter()
        .map(|w| {
            let id = message_id(&t, w);
            rows(&t)
                .into_iter()
                .find(|r| r.message_id == id)
                .unwrap()
                .reason
        })
        .collect();
    assert_eq!(
        reasons,
        [
            Some(MediaReason::Expired),
            Some(MediaReason::TooLarge),
            Some(MediaReason::TooLarge)
        ]
    );
    assert!(stored_files(&t).is_empty());
    // The tool says why it cannot open one.
    let e = media::open(
        &t.w.deps,
        &t.w.owner_ctx,
        message_id(&t, "wamid.old"),
        MediaInput::default(),
        Hand::Content,
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(
        e.details,
        json!({"reason": "media_unavailable", "state": "failed", "why": "expired"})
    );
}

#[tokio::test]
async fn opening_needs_the_conversations_permission_and_is_recorded() {
    let t = setup().await;
    inbound(&t, "wamid.photo2", "image", image("1500000000000008"), 0).await;
    let message = message_id(&t, "wamid.photo2");
    // Still being fetched: the tool says so.
    let e = media::open(
        &t.w.deps,
        &t.w.owner_ctx,
        message,
        MediaInput::default(),
        Hand::Address,
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["state"], "pending");
    let photo = jpeg();
    t.meta.push_media(Ok(Some(media("image/jpeg", &photo))));
    job(&t, later(1)).await;

    // Without `inbox.work`: refused, nothing recorded.
    let nobody = human(t.w.ws, t.w.owner, "nobody", BTreeSet::new());
    let e = media::open(
        &t.w.deps,
        &nobody,
        message,
        MediaInput::default(),
        Hand::Address,
    )
    .await
    .unwrap_err();
    assert_forbidden(&e, "inbox.work");
    assert!(t.w.entries("inbox.media.opened").is_empty());

    // The panel gets a short-lived address of the workspace's own.
    let opened = media::open(
        &t.w.deps,
        &t.w.owner_ctx,
        message,
        MediaInput::default(),
        Hand::Address,
    )
    .await
    .unwrap();
    let file = row(&t).file_id.unwrap();
    assert_eq!(
        opened.url.as_deref(),
        Some(format!("https://files.example.com/files/{file}").as_str())
    );
    assert_eq!(
        opened.expires_at,
        Some(t.w.owner_ctx.now + Duration::minutes(10))
    );
    // An agent gets the image itself.
    let agent = t.w.agent(&["inbox.work"]).await;
    let seen = media::open(
        &t.w.deps,
        &agent,
        message,
        MediaInput { index: Some(0) },
        Hand::Content,
    )
    .await
    .unwrap();
    let (data, mime) = seen.image.unwrap();
    assert_eq!(mime, "image/jpeg");
    use base64::Engine as _;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap(),
        photo
    );
    assert!(seen.url.is_none());
    // Both openings are in the ledger, by who opened, without a file or an address.
    let entries = t.w.entries("inbox.media.opened");
    assert_eq!(entries.len(), 2);
    assert!(matches!(entries[0].actor, jt_ledger::Actor::Human { .. }));
    assert!(matches!(entries[1].actor, jt_ledger::Actor::Agent { .. }));
    let text = serde_json::to_string(&entries[1].payload).unwrap();
    assert!(!text.contains("files.example.com"), "{text}");
    assert!(!text.contains(&file.to_string()), "{text}");
    // No such index.
    let e = media::open(
        &t.w.deps,
        &t.w.owner_ctx,
        message,
        MediaInput { index: Some(1) },
        Hand::Address,
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn another_workspace_cannot_open_or_list_a_customers_file() {
    let t = setup().await;
    inbound(&t, "wamid.photo3", "image", image("1500000000000009"), 0).await;
    t.meta.push_media(Ok(Some(media("image/jpeg", &jpeg()))));
    job(&t, later(1)).await;
    let message = message_id(&t, "wamid.photo3");
    let (other, other_ctx) = t.w.other_workspace().await;
    let e = media::open(
        &t.w.deps,
        &other_ctx,
        message,
        MediaInput::default(),
        Hand::Content,
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(media_of(&t.w.uow.snapshot(), other).is_empty());
    assert!(
        t.files
            .files
            .lock()
            .unwrap()
            .keys()
            .all(|(ws, _)| *ws == t.w.ws)
    );
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
        Ok(self
            .0
            .files
            .lock()
            .unwrap()
            .keys()
            .filter(|(w, _)| *w == ws)
            .map(|(_, id)| *id)
            .collect())
    }
}

#[tokio::test]
async fn erasing_the_person_leaves_no_customer_file_behind() {
    let mut t = setup().await;
    t.w.deps.file_maintenance = Arc::new(EveryFile(t.files.clone()));
    inbound(&t, "wamid.photo4", "image", image("1500000000000010"), 0).await;
    inbound(
        &t,
        "wamid.doc2",
        "document",
        document("1500000000000011", "fiyat.pdf"),
        1,
    )
    .await;
    inbound(&t, "wamid.photo5", "image", image("1500000000000012"), 2).await;
    t.meta.push_media(Ok(Some(media("image/jpeg", &jpeg()))));
    t.meta.push_media(Ok(Some(media("application/pdf", PDF))));
    // The third is still pending when the person is erased.
    t.meta.push_media(Err(ConnectorError::transient("down")));
    job(&t, later(1)).await;
    assert_eq!(stored_files(&t).len(), 2);
    // The store's sweep keeps what a row keeps.
    jobs::run_studio_files_cleanup(&t.w.deps).await;
    assert_eq!(stored_files(&t).len(), 2);

    let (_, person) = conversation(&t);
    erasure::erase(
        &t.w.deps,
        &t.w.owner_ctx,
        person,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    assert!(stored_files(&t).is_empty());
    for r in rows(&t) {
        assert_eq!(
            (r.state, r.reason, r.filename.as_str(), r.provider_media_id),
            (MediaState::Deleted, Some(MediaReason::Erased), "", None),
        );
    }
    // Nothing is fetched for an erased person, and nothing can be opened.
    let report = job(&t, later(600)).await;
    assert_eq!(report.touched, 0, "{report:?}");
    let e = media::open(
        &t.w.deps,
        &t.w.owner_ctx,
        message_id(&t, "wamid.photo4"),
        MediaInput::default(),
        Hand::Address,
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["state"], "deleted");
    assert_eq!(e.details["why"], "erased");
}

#[tokio::test]
async fn a_file_no_row_keeps_goes_with_the_store_sweep() {
    // What a workspace's removal leaves to the store: once no row keeps a customer's file (the
    // rows gone, or an erasure whose delete failed), the sweep deletes its bytes.
    let mut t = setup().await;
    t.w.deps.file_maintenance = Arc::new(EveryFile(t.files.clone()));
    inbound(&t, "wamid.photo6", "image", image("1500000000000013"), 0).await;
    t.meta.push_media(Ok(Some(media("image/jpeg", &jpeg()))));
    job(&t, later(1)).await;
    let (file, upload) = stored_files(&t).remove(0);
    let (_, person) = conversation(&t);
    erasure::erase(
        &t.w.deps,
        &t.w.owner_ctx,
        person,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    // The bytes put back, as if the erasure's delete had failed.
    t.files.files.lock().unwrap().insert((t.w.ws, file), upload);
    jobs::run_studio_files_cleanup(&t.w.deps).await;
    assert!(stored_files(&t).is_empty());
}

#[tokio::test]
async fn a_customers_file_goes_after_the_retention() {
    let t = setup().await;
    inbound(&t, "wamid.photo7", "image", image("1500000000000014"), 0).await;
    t.meta.push_media(Ok(Some(media("image/jpeg", &jpeg()))));
    job(&t, later(1)).await;
    // A day before the retention ends: kept.
    job(&t, later(1) + RETENTION - Duration::days(1)).await;
    assert_eq!(stored_files(&t).len(), 1);
    let report = job(&t, later(1) + RETENTION).await;
    assert_eq!(report.changed, 1, "{report:?}");
    assert!(stored_files(&t).is_empty());
    let r = row(&t);
    assert_eq!(
        (r.state, r.reason),
        (MediaState::Deleted, Some(MediaReason::Retention))
    );
    let shown = listed(&t, "wamid.photo7").await;
    assert_eq!(shown[0]["state"], "deleted");
    assert_eq!(shown[0]["reason"], "retention");
}

#[tokio::test]
async fn an_older_message_gets_its_file_on_first_view() {
    let t = setup().await;
    inbound(&t, "wamid.before", "image", image("1500000000000015"), 0).await;
    // As a message stored before chat files were kept: no row.
    t.w.uow.edit(|s| s.message_media.clear());
    assert!(rows(&t).is_empty());
    let shown = listed(&t, "wamid.before").await;
    assert_eq!(shown[0]["state"], "pending");
    let pending = row(&t);
    assert_eq!(
        pending.provider_media_id.as_deref(),
        Some("1500000000000015")
    );
    // A second view records nothing more.
    listed(&t, "wamid.before").await;
    assert_eq!(rows(&t).len(), 1);
    t.meta.push_media(Ok(Some(media("image/jpeg", &jpeg()))));
    job(&t, later(1)).await;
    assert_eq!(row(&t).state, MediaState::Stored);
}

#[tokio::test]
async fn a_workspaces_daily_bytes_are_bounded() {
    let t = setup().await;
    inbound(&t, "wamid.day1", "image", image("1500000000000016"), 0).await;
    inbound(&t, "wamid.day2", "image", image("1500000000000017"), 1).await;
    // The day's bytes are spent by files already kept.
    let first = rows(&t)
        .into_iter()
        .find(|r| r.message_id == message_id(&t, "wamid.day1"))
        .unwrap();
    t.w.uow.edit(|s| {
        for (_, r) in s.message_media.iter_mut() {
            if r.id == first.id {
                r.state = MediaState::Stored;
                r.file_id = Some(FileId::new_v7());
                r.provider_media_id = None;
                r.mime = Some("image/jpeg".into());
                r.sha256 = Some("a".repeat(64));
                r.size_bytes = Some(media::MAX_DAILY_BYTES);
                r.stored_at = Some(later(0));
            }
        }
    });
    job(&t, later(1)).await;
    let second = rows(&t)
        .into_iter()
        .find(|r| r.message_id == message_id(&t, "wamid.day2"))
        .unwrap();
    assert_eq!(
        (second.state, second.reason),
        (MediaState::Failed, Some(MediaReason::DailyLimit))
    );
    assert!(t.meta.media_calls().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Sending an image
// ---------------------------------------------------------------------------------------------

use jt_app::ports::connectors::SendReceipt;
use jt_app::usecases::inbox::media::ImageInput;
use jt_app::usecases::inbox::replies::{self, ReplyInput, SendIntent};
use jt_testkit::fakes::ConnectorCall;

/// A file the workspace's store keeps as studio's upload (`studio.file_upload` writes the same).
async fn studio_file(t: &T, mime: &str, bytes: &[u8]) -> FileId {
    use sha2::Digest as _;
    let id = FileId::new_v7();
    t.files.files.lock().unwrap().insert(
        (t.w.ws, id),
        jt_app::ports::connectors::MediaUpload {
            bytes: bytes.to_vec(),
            mime: mime.into(),
            filename: "ornek.jpg".into(),
        },
    );
    let mut r = t.w.uow.tenant(t.w.ws).await.unwrap();
    r.studio()
        .save_file(jt_app::ports::files::StoredFile {
            id,
            workspace_id: t.w.ws,
            mime: mime.into(),
            filename: "ornek.jpg".into(),
            sha256: sha2::Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            created_at: FIXED_NOW,
            cleanup_due_at: None,
            deleted_at: None,
            size_bytes: bytes.len() as u64,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    id
}

/// A genel material of `file`, freed by the owner, with `share` and `origin`.
async fn material(
    t: &T,
    file: FileId,
    share: Option<jt_studio::SharePermission>,
    origin: jt_studio::Origin,
    erased: bool,
) -> jt_studio::MaterialId {
    let id = jt_studio::MaterialId::new_v7();
    let m = jt_studio::Material {
        id,
        workspace_id: t.w.ws,
        file_id: file,
        mime: "image/jpeg".into(),
        title: "Ornek".into(),
        origin,
        binding: jt_studio::Binding::Genel,
        freed: Some(jt_studio::HumanMark {
            by: t.w.owner,
            at: FIXED_NOW,
        }),
        share: share.map(|permission| jt_studio::ShareDecision {
            permission,
            by: Some(t.w.owner),
            at: FIXED_NOW,
            rule: None,
        }),
        tags: Default::default(),
        tags_reviewed_by: None,
        people: Default::default(),
        captured_at: None,
        created_by: jt_ledger::Actor::Human { user_id: t.w.owner },
        revision: 1,
        created_at: FIXED_NOW,
        erased_at: erased.then_some(FIXED_NOW),
        upload_for: None,
        composition: None,
    };
    let mut r = t.w.uow.tenant(t.w.ws).await.unwrap();
    r.studio_materials().insert_material(m).await.unwrap();
    r.commit().await.unwrap();
    id
}

fn with_image(text: &str, image: ImageInput, key: Option<&str>) -> ReplyInput {
    ReplyInput {
        text: text.into(),
        intent: SendIntent::Reply,
        request_key: key.map(str::to_owned),
        subject: None,
        in_reply_to: None,
        references: vec![],
        item_id: None,
        visibility: None,
        image: Some(image),
    }
}

fn file_image(file: FileId) -> ImageInput {
    ImageInput {
        file_id: Some(file),
        material_id: None,
    }
}

fn sent_images(t: &T) -> Vec<(String, String, String)> {
    t.meta
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            ConnectorCall::SendImage {
                url, mime, caption, ..
            } => Some((url, mime, caption)),
            _ => None,
        })
        .collect()
}

/// A customer's message, so the conversation is open and its window too.
async fn customer_wrote(t: &T) -> ConversationId {
    inbound(t, "wamid.hello", "image", image("1500000000000099"), 0).await;
    conversation(t).0
}

fn receipt(id: &str) -> SendReceipt {
    SendReceipt {
        provider_id: id.into(),
        cost_minor: None,
    }
}

#[tokio::test]
async fn an_owners_photo_goes_out_as_a_whatsapp_image_with_the_text_as_caption() {
    let t = setup().await;
    let c = customer_wrote(&t).await;
    let photo = jpeg();
    let file = studio_file(&t, "image/jpeg", &photo).await;
    t.meta.push_send_text(Ok(receipt("wamid.out1")));
    let out = replies::reply(
        &t.w.deps,
        &t.w.owner_ctx,
        c,
        with_image("Boyle olacak", file_image(file), Some("k1")),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    assert_eq!(
        sent_images(&t),
        [(
            format!("https://files.example.com/files/{file}"),
            "image/jpeg".to_owned(),
            "Boyle olacak".to_owned()
        )]
    );
    // No text went out beside it.
    assert!(
        !t.meta
            .calls()
            .iter()
            .any(|c| matches!(c, ConnectorCall::SendText { .. }))
    );
    let s = t.w.uow.snapshot();
    let message = s
        .inbox
        .messages
        .iter()
        .find(|m| m.id == out.message_id)
        .unwrap();
    assert_eq!(message.body, "[image]\nBoyle olacak");
    let shown = rows(&t)
        .into_iter()
        .find(|r| r.message_id == out.message_id)
        .unwrap();
    assert_eq!(shown.state, MediaState::Stored);
    assert_eq!(shown.file_id, Some(file));
    // The same request key replays the answer: nothing is sent twice.
    let again = replies::reply(
        &t.w.deps,
        &t.w.owner_ctx,
        c,
        with_image("Boyle olacak", file_image(file), Some("k1")),
    )
    .await
    .unwrap();
    assert_eq!(again.message_id, out.message_id);
    assert_eq!(sent_images(&t).len(), 1);
    assert!(!t.w.entries("inbox.reply.queued").is_empty());
}

#[tokio::test]
async fn a_photo_that_may_not_be_shared_is_refused_before_sending() {
    use jt_studio::{Origin, SharePermission};
    let t = setup().await;
    let c = customer_wrote(&t).await;
    let file = studio_file(&t, "image/jpeg", &jpeg()).await;
    let webp = studio_file(&t, "image/webp", b"RIFF\0\0\0\0WEBPVP8 ").await;
    let mut big = jpeg();
    big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
    let large = studio_file(&t, "image/jpeg", &big).await;
    let not_shareable = material(
        &t,
        file,
        Some(SharePermission::NotShareable),
        Origin::Real,
        false,
    )
    .await;
    let other = studio_file(&t, "image/jpeg", &jpeg()).await;
    let unset = material(&t, other, None, Origin::Real, false).await;
    let gone_file = studio_file(&t, "image/jpeg", &jpeg()).await;
    let erased = material(
        &t,
        gone_file,
        Some(SharePermission::Shareable),
        Origin::Real,
        true,
    )
    .await;
    let ai_file = studio_file(&t, "image/jpeg", &jpeg()).await;
    let ai = material(
        &t,
        ai_file,
        Some(SharePermission::Shareable),
        Origin::AiGenerated {
            generator: "test".into(),
        },
        false,
    )
    .await;
    let by_material = |id| ImageInput {
        file_id: None,
        material_id: Some(id),
    };
    for (image, reason) in [
        (by_material(not_shareable), "material_not_shareable"),
        // A material's file named as a file is held to the material's rules.
        (file_image(file), "material_not_shareable"),
        (by_material(unset), "material_share_unset"),
        (by_material(erased), "material_erased"),
        (by_material(ai), "ai_image_not_allowed"),
        (file_image(webp), "image_type_not_supported"),
        (file_image(large), "image_too_large"),
        (file_image(FileId::new_v7()), "image_not_found"),
        (ImageInput::default(), "image_one_of_file_or_material"),
    ] {
        let e = replies::reply(&t.w.deps, &t.w.owner_ctx, c, with_image("x", image, None))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{reason}");
        assert_eq!(e.details["reason"], reason);
        assert_eq!(e.details["field"], "image");
    }
    assert!(sent_images(&t).is_empty());
    assert!(
        t.w.uow
            .snapshot()
            .inbox
            .messages
            .iter()
            .all(|m| m.direction != jt_inbox::Direction::Outbound)
    );
}

#[tokio::test]
async fn an_image_keeps_every_sending_rule() {
    let t = setup().await;
    let c = customer_wrote(&t).await;
    let file = studio_file(&t, "image/jpeg", &jpeg()).await;
    // Outside the customer-service window: refused as a text is.
    let late = at(&t.w.owner_ctx, FIXED_NOW + Duration::hours(25));
    let e = replies::reply(&t.w.deps, &late, c, with_image("x", file_image(file), None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.details["reason"], "reply_window_closed");
    // A person holds the conversation: an agent is refused, as for a text.
    conversations::take_over(&t.w.deps, &t.w.owner_ctx, c)
        .await
        .unwrap();
    let agent = t.w.agent(&["inbox.work"]).await;
    let e = replies::reply(
        &t.w.deps,
        &agent,
        c,
        with_image("x", file_image(file), None),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "human_holds_conversation");
    assert!(sent_images(&t).is_empty());
    // The provider's refusal fails the message, as a text's does.
    t.meta.push_send_text(Err(ConnectorError::permanent(
        "HTTP 400 media download error",
    )));
    let out = replies::reply(
        &t.w.deps,
        &t.w.owner_ctx,
        c,
        with_image("", file_image(file), None),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "failed");
    assert_eq!(sent_images(&t).len(), 1);
    let s = t.w.uow.snapshot();
    assert_eq!(
        s.inbox
            .messages
            .iter()
            .find(|m| m.id == out.message_id)
            .unwrap()
            .body,
        "[image]"
    );
}
