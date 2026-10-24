use jt_app::{
    ports::{UnitOfWork, studio::*},
    usecases::studio::measure::record,
};
use jt_pg::PgUnitOfWork;
use jt_testkit::{
    TestDb,
    fakes::{FIXED_NOW, FixedClock, deps},
    studio_contract::ready,
};
use std::sync::Arc;
use time::Duration;
#[tokio::test]
async fn measurement_correction_learning_and_retirement_are_atomic_in_postgres() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = ready(uow.as_ref()).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .find(f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.status = jt_capability::StoredStatus::Verified;
    c.last_verified_at = Some(FIXED_NOW);
    c.connector_public = serde_json::json!({"access":{"scopes":["tweet.read","tweet.write"]}});
    r.capabilities().update(c).await.unwrap();
    r.capabilities()
        .set_sealed(f.slot.capability_id, Some(vec![1, 2, 3]), FIXED_NOW)
        .await
        .unwrap();
    let a = r
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    r.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Succeeded(jt_app::ports::connectors::PublishReceipt {
                external_id: "post".into(),
                url: None,
            }),
            FIXED_NOW,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut d = deps(uow.clone());
    d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(8)));
    let mut r = uow.tenant(f.ws).await.unwrap();
    let p = r.studio().list_publications().await.unwrap().remove(0);
    drop(r);
    let mut final_measurement = None;
    for (window, events, rev) in [
        (MeasurementWindow::Hours24, 20, 0),
        (MeasurementWindow::Days7, 80, 0),
        (MeasurementWindow::Hours72, 30, 0),
        (MeasurementWindow::Days7, 60, 1),
    ] {
        let m = Measurement {
            id: MeasurementId::new_v7(),
            chain: p.chain.clone(),
            evidence_key: format!("{}:{window:?}:{rev}", p.id),
            publication_id: Some(p.id),
            binding_id: None,
            window,
            evidence_revision: rev,
            scheduled_at: Some(p.published_at + window.delay()),
            account_timezone: None,
            minor_unit_exponent: None,
            measured_at: d.clock.now(),
            source: "x".into(),
            raw_metrics: [
                ("engagements".into(), Some(events)),
                ("impressions".into(), Some(100)),
            ]
            .into(),
            metric_scope: "post".into(),
            date: None,
            currency: None,
            status: MeasurementStatus::Complete,
            rule_version: "studio-learning-v1".into(),
        };
        assert!(record(&d, m.clone()).await.unwrap());
        assert!(!record(&d, m.clone()).await.unwrap());
        final_measurement = Some(m);
    }
    let m = final_measurement.unwrap();
    let mut changed = m.clone();
    changed.raw_metrics.insert("engagements".into(), Some(99));
    assert!(record(&d, changed).await.is_err());
    let mut r = uow.tenant(f.ws).await.unwrap();
    let a = r.studio().get_arm(f.arm.id).await.unwrap().unwrap();
    assert!((a.alpha - 1.6).abs() < 1e-12);
    assert!((a.beta - 1.4).abs() < 1e-12);
    assert_eq!(r.studio().list_measurements().await.unwrap().len(), 4);
    assert_eq!(
        r.studio().get_slot(f.slot.id).await.unwrap().unwrap().state,
        SlotState::Retired
    );
    assert_eq!(
        r.hypotheses()
            .list(f.slot.chain.born_version_id)
            .await
            .unwrap()[0]
            .derived_confidence,
        Some(1.6f32 / 3.0)
    );
    drop(r);
    let (other, _) = db.seed_workspace("other").await;
    let mut r = uow.tenant(other).await.unwrap();
    assert!(r.studio().list_measurements().await.unwrap().is_empty());
}
