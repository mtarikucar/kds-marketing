use jt_app::usecases::studio::files::validate_upload;
use jt_studio::MediaUpload;
#[test]
fn media_mime_and_25mb_200mb_boundaries() {
    for (mime, header, limit) in [
        ("image/png", b"\x89PNG\r\n\x1a\n".as_slice(), 25_000_000),
        ("video/mp4", b"\0\0\0\x18ftypisom".as_slice(), 200_000_000),
    ] {
        let mut bytes = vec![0; limit];
        bytes[..header.len()].copy_from_slice(header);
        let mut u = MediaUpload {
            bytes,
            mime: mime.into(),
            filename: "asset".into(),
        };
        assert!(validate_upload(&u).is_ok());
        u.bytes.push(0);
        assert!(validate_upload(&u).is_err());
        u.bytes.truncate(32);
        u.mime = "image/jpeg".into();
        assert!(validate_upload(&u).is_err());
    }
}
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ports::{UnitOfWork, files::FileStore, studio::*},
    usecases::studio::{
        files::{cleanup_files, file_upload},
        pieces::piece_submit,
    },
};
use jt_testkit::fakes::{FIXED_NOW, FixedClock, files::MemoryFiles};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use time::Duration;
async fn uploaded() -> (support::World, jt_app::ports::files::StoredFile) {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut w = support::world().await;
    w.d.files = Arc::new(MemoryFiles::default());
    let i=serde_json::from_value(json!({"request_key":"upload","filename":"a.png","mime":"image/png","content":{"kind":"bytes_base64","data":STANDARD.encode(b"\x89PNG\r\n\x1a\nprivate-bytes")}})).unwrap();
    let f = file_upload(&w.d, &w.ctx, i).await.unwrap();
    let p=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"piece","text":"text","media":[{"kind":"file","id":f.id}],"adaptations":{}})).unwrap();
    piece_submit(&w.d, &w.ctx, p).await.unwrap();
    (w, f)
}
async fn publish(w: &support::World, at: time::OffsetDateTime, key: &str) {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let a = r.studio().claim_publication(at).await.unwrap().unwrap();
    r.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Succeeded(jt_app::ports::connectors::PublishReceipt {
                external_id: key.into(),
                url: None,
            }),
            at,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
}
#[tokio::test]
async fn cleanup_job_waits_30_days_after_last_publish() {
    let (mut w, f) = uploaded().await;
    publish(&w, FIXED_NOW, "first").await;
    // A second publication of the same file extends retention.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut slot = w.f.slot.clone();
    slot.id = SlotId::new_v7();
    slot.state = SlotState::Planned;
    slot.revision = 0;
    slot.scheduled_at = FIXED_NOW;
    r.studio()
        .insert_slots("second", vec![slot.clone()])
        .await
        .unwrap();
    let mut p = w.f.piece.clone();
    p.id = PieceId::new_v7();
    p.media = vec![MediaAsset::File { id: f.id }];
    p.revision = 1;
    r.studio()
        .save_piece(slot.id, 0, p, "second")
        .await
        .unwrap();
    r.commit().await.unwrap();
    publish(&w, FIXED_NOW + Duration::days(2), "second").await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(30)));
    assert_eq!(cleanup_files(&w.d, w.f.ws).await.unwrap(), 0);
    assert!(w.d.files.read(w.f.ws, f.id).await.is_ok());
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(32)));
    assert_eq!(cleanup_files(&w.d, w.f.ws).await.unwrap(), 1);
    assert!(w.d.files.read(w.f.ws, f.id).await.is_err());
    assert_eq!(w.uow.snapshot().studio.publications.len(), 2);
    assert_eq!(w.uow.snapshot().studio.files[0].sha256, f.sha256);
    assert_eq!(
        jt_app::usecases::jobs::Job::StudioFilesCleanup.lock_name(),
        "jeeta.jobs.studio_files_cleanup"
    );
}
#[tokio::test]
async fn cleanup_retains_pending_unknown_and_permanent_evidence() {
    let (mut w, f) = uploaded().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(90)));
    assert_eq!(cleanup_files(&w.d, w.f.ws).await.unwrap(), 0);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let a = r
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(cleanup_files(&w.d, w.f.ws).await.unwrap(), 0);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Unknown(jt_app::error::AppError::internal("lost")),
            FIXED_NOW,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.archive().await;
    assert_eq!(cleanup_files(&w.d, w.f.ws).await.unwrap(), 0);
    assert!(w.d.files.read(w.f.ws, f.id).await.is_ok());
    assert_eq!(w.uow.snapshot().studio.attempts.len(), 1);
}
struct CrashAfterDelete {
    inner: Arc<dyn FileStore>,
    crash: AtomicBool,
}
#[async_trait::async_trait]
impl FileStore for CrashAfterDelete {
    async fn put(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
        u: MediaUpload,
    ) -> Result<jt_app::ports::files::StoredFile, jt_app::error::AppError> {
        self.inner.put(w, i, u).await
    }
    async fn read(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
    ) -> Result<MediaUpload, jt_app::error::AppError> {
        self.inner.read(w, i).await
    }
    async fn provider_url(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
        e: time::OffsetDateTime,
    ) -> Result<url::Url, jt_app::error::AppError> {
        self.inner.provider_url(w, i, e).await
    }
    async fn delete(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
    ) -> Result<(), jt_app::error::AppError> {
        self.inner.delete(w, i).await?;
        if self.crash.swap(false, Ordering::SeqCst) {
            Err(jt_app::error::AppError::internal("simulated crash"))
        } else {
            Ok(())
        }
    }
}
#[tokio::test]
async fn cleanup_crash_and_repeat_are_idempotent() {
    let (mut w, f) = uploaded().await;
    publish(&w, FIXED_NOW, "post").await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(30)));
    w.d.files = Arc::new(CrashAfterDelete {
        inner: w.d.files.clone(),
        crash: AtomicBool::new(true),
    });
    assert!(cleanup_files(&w.d, w.f.ws).await.is_err());
    assert!(w.uow.snapshot().studio.files[0].deleted_at.is_none());
    assert!(w.d.files.read(w.f.ws, f.id).await.is_err());

    // A new slot cannot adopt bytes removed by the interrupted cleanup.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut slot = w.f.slot.clone();
    slot.id = SlotId::new_v7();
    slot.state = SlotState::Planned;
    slot.revision = 0;
    r.studio()
        .insert_slots("after-crash", vec![slot.clone()])
        .await
        .unwrap();
    r.commit().await.unwrap();
    let i=serde_json::from_value(json!({"slot_id":slot.id,"expected_revision":0,"request_key":"after-crash","text":"text","media":[{"kind":"file","id":f.id}],"adaptations":{}})).unwrap();
    assert!(piece_submit(&w.d, &w.ctx, i).await.is_err());
    assert_eq!(cleanup_files(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(cleanup_files(&w.d, w.f.ws).await.unwrap(), 0);
    assert!(w.uow.snapshot().studio.files[0].deleted_at.is_some());
}
struct PausedPut {
    inner: Arc<MemoryFiles>,
    barrier: Arc<tokio::sync::Barrier>,
}
#[async_trait::async_trait]
impl FileStore for PausedPut {
    async fn put(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
        u: MediaUpload,
    ) -> Result<jt_app::ports::files::StoredFile, jt_app::error::AppError> {
        let f = self.inner.put(w, i, u).await?;
        self.barrier.wait().await;
        self.barrier.wait().await;
        Ok(f)
    }
    async fn read(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
    ) -> Result<MediaUpload, jt_app::error::AppError> {
        self.inner.read(w, i).await
    }
    async fn provider_url(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
        e: time::OffsetDateTime,
    ) -> Result<url::Url, jt_app::error::AppError> {
        self.inner.provider_url(w, i, e).await
    }
    async fn delete(
        &self,
        w: jt_tenancy::WorkspaceId,
        i: FileId,
    ) -> Result<(), jt_app::error::AppError> {
        self.inner.delete(w, i).await
    }
}
struct DueCandidates(Arc<MemoryFiles>);
#[async_trait::async_trait]
impl jt_app::ports::files::FileMaintenance for DueCandidates {
    async fn orphan_candidates(
        &self,
        w: jt_tenancy::WorkspaceId,
        before: time::OffsetDateTime,
    ) -> Result<Vec<FileId>, jt_app::error::AppError> {
        assert!(before > FIXED_NOW);
        Ok(self
            .0
            .files
            .lock()
            .unwrap()
            .keys()
            .filter(|(ws, _)| *ws == w)
            .map(|(_, id)| *id)
            .collect())
    }
}
#[tokio::test]
async fn paused_upload_cannot_commit_after_orphan_cleanup() {
    let mut w = support::world().await;
    let inner = Arc::new(MemoryFiles::default());
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    w.d.files = Arc::new(PausedPut {
        inner: inner.clone(),
        barrier: barrier.clone(),
    });
    w.d.file_maintenance = Arc::new(DueCandidates(inner.clone()));
    let deps = w.d.clone();
    let ctx = w.ctx.clone();
    let pending = tokio::spawn(async move {
        file_upload(&deps,&ctx,serde_json::from_value(json!({"request_key":"paused","filename":"a.png","mime":"image/png","content":{"kind":"bytes_base64","data":"iVBORw0KGgphc3NldA=="}})).unwrap()).await
    });
    barrier.wait().await;
    assert_eq!(inner.files.lock().unwrap().len(), 1);
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::hours(25)));
    cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(inner.files.lock().unwrap().is_empty());
    barrier.wait().await;
    assert!(pending.await.unwrap().is_err());
    assert!(w.uow.snapshot().studio.files.is_empty());
}
