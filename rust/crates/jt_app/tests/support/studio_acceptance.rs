//! Cross-module scenarios shared by architecture tests and the offline smoke target.
#![allow(dead_code)]
#[path = "studio.rs"]
pub mod world;
use jt_app::{
    ports::{
        UnitOfWork,
        connectors::{PostMetrics, PublishReceipt},
        studio::ApprovalTarget,
    },
    usecases::{
        jobs::Job,
        studio::{
            chain::{ExecutionInput, dispatch_execution},
            files, measure, pieces, publish,
        },
    },
};
use jt_connector::Provider;
use jt_studio::MediaAsset;
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use time::Duration;

pub async fn publishing_world() -> (world::World, Arc<ScriptedConnector>) {
    let mut w = world::world().await;
    let x = Arc::new(ScriptedConnector::new(Provider::X));
    w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(x.clone())
            .with_connector(w.ads.clone()),
    );
    w.d.files = Arc::new(MemoryFiles::default());
    (w, x)
}
pub fn receipt() -> PublishReceipt {
    PublishReceipt {
        external_id: "smoke-post".into(),
        url: None,
    }
}
pub fn metrics(x: &ScriptedConnector) {
    x.push_post_metrics(Ok(PostMetrics {
        metrics: [("impressions".into(), 100), ("engagements".into(), 20)].into(),
    }));
}
pub fn sends(x: &ScriptedConnector) -> usize {
    x.calls()
        .iter()
        .filter(|c| matches!(c, ConnectorCall::Publish { .. }))
        .count()
}
pub async fn attach_file(w: &world::World) -> jt_app::ports::files::StoredFile {
    let file = files::file_upload(
        &w.d,
        &w.ctx,
        serde_json::from_value(serde_json::json!({
            "request_key":"smoke-upload", "filename":"smoke.png", "mime":"image/png",
            "content":{"kind":"bytes_base64","data":"iVBORw0KGgpzbW9rZQ=="}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    pieces::piece_submit(
        &w.d,
        &w.ctx,
        pieces::PieceInput {
            slot_id: w.f.slot.id,
            expected_revision: 1,
            request_key: "smoke-piece".into(),
            text: "Agent supplied content".into(),
            media: vec![MediaAsset::File { id: file.id }],
            adaptations: Default::default(),
        },
    )
    .await
    .unwrap();
    file
}
pub async fn historical_jobs() {
    let (mut w, x) = publishing_world().await;
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    w.archive().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&x);
    let report = Job::StudioMeasure.run(&w.d, w.d.clock.now()).await;
    assert_eq!((report.changed, report.failed), (1, 0));
    assert_eq!(
        w.uow.snapshot().studio.measurements[0].chain,
        w.f.slot.chain
    );
    assert!(w.permit().await.is_err());
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&x), 1);
    // Historical authority still requires the original account, not a replacement account.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.external_id = Some("replacement-account".into());
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(3)));
    let before = x.calls().len();
    let learning = w.uow.snapshot().studio.arms.clone();
    assert_eq!(measure::measure_due(&w.d, w.f.ws).await.unwrap(), 1);
    let state = w.uow.snapshot();
    assert_eq!(state.studio.arms, learning);
    assert!(state.studio.measurements.iter().any(|m| {
        m.status == jt_studio::MeasurementStatus::Failed
            && m.failure
                .as_ref()
                .is_some_and(|f| f.category == "historical_account_changed")
    }));
    assert_eq!(x.calls().len(), before);
}
pub async fn cleanup_after_archive() {
    let (mut w, x) = publishing_world().await;
    let file = attach_file(&w).await;
    x.push_publish(Ok(receipt()));
    publish::publish_due(&w.d, w.f.ws).await.unwrap();
    w.archive().await;
    let before = w.uow.snapshot();
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(29)));
    assert_eq!(
        Job::StudioFilesCleanup
            .run(&w.d, w.d.clock.now())
            .await
            .changed,
        0
    );
    assert!(w.d.files.read(w.f.ws, file.id).await.is_ok());
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(30)));
    let report = Job::StudioFilesCleanup.run(&w.d, w.d.clock.now()).await;
    assert_eq!((report.changed, report.failed), (1, 0));
    assert!(w.d.files.read(w.f.ws, file.id).await.is_err());
    assert_eq!(
        Job::StudioFilesCleanup
            .run(&w.d, w.d.clock.now())
            .await
            .changed,
        0
    );
    let after = w.uow.snapshot();
    assert_eq!(after.studio.publications, before.studio.publications);
    assert_eq!(after.studio.files[0].sha256, file.sha256);
    for row in before.ledger {
        assert!(after.ledger.iter().any(|r| r.entry == row.entry));
    }
}
pub async fn brake_at_barriers() {
    use tokio::sync::Barrier;
    let w = Arc::new(world::world().await);
    let (binding, movement) = w.paid().await;
    let poised = Arc::new(Barrier::new(3));
    let admit = Arc::new(Barrier::new(3));
    let calls = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();
    for input in [
        w.execution(),
        ExecutionInput {
            chain: movement.chain,
            capability_id: binding.capability_id,
            target: ApprovalTarget::BudgetMove(movement.id),
            expected_revision: 1,
        },
    ] {
        let (w, poised, admit, calls) = (w.clone(), poised.clone(), admit.clone(), calls.clone());
        workers.push(tokio::spawn(async move {
            poised.wait().await;
            admit.wait().await;
            let e = dispatch_execution(&w.d, input, |_| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap_err();
            assert_eq!(e.details["reason"], "studio_braked");
        }));
    }
    poised.wait().await;
    w.brake(true, None, 0).await;
    admit.wait().await;
    for worker in workers {
        worker.await.unwrap();
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let restarted = jt_testkit::fakes::deps(Arc::new(w.uow.clone()));
    let mut r = restarted.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        r.studio_control()
            .lock_control()
            .await
            .unwrap()
            .brake_engaged
    );
    r.commit().await.unwrap();
    let other = jt_testkit::studio_contract::ready(&w.uow).await;
    let mut r = restarted.uow.tenant(other.ws).await.unwrap();
    assert!(
        !r.studio_control()
            .lock_control()
            .await
            .unwrap()
            .brake_engaged
    );
}
pub async fn uncertain_restart() {
    let (mut w, x) = publishing_world().await;
    x.push_publish(Err(jt_connector::ConnectorError::unknown(
        "accepted; response lost",
    )));
    publish::publish_due(&w.d, w.f.ws).await.unwrap();
    let mut restarted = jt_testkit::fakes::deps(Arc::new(w.uow.clone()));
    restarted.connectors = w.d.connectors.clone();
    restarted.clock = Arc::new(FixedClock(FIXED_NOW + Duration::minutes(3)));
    w.d = restarted;
    for _ in 0..3 {
        publish::recover_publications(&w.d, w.f.ws).await.unwrap();
        publish::publish_due(&w.d, w.f.ws).await.unwrap();
    }
    assert_eq!(sends(&x), 1);
    assert_eq!(
        w.uow.snapshot().studio.attempts[0].state(),
        jt_studio::PublishState::Unknown
    );
}
