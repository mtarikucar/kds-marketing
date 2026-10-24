//! Offline M3 acceptance: real services and scheduled jobs, scripted providers only.
#[path = "support/studio_acceptance.rs"]
mod scenarios;
use jt_app::{
    ports::UnitOfWork,
    usecases::{
        jobs::Job,
        strategy,
        studio::{measure, planner, publish, views},
    },
};
use jt_testkit::fakes::{FIXED_NOW, FixedClock, InMemoryUow};
use serde_json::json;
use std::sync::Arc;
use time::Duration;

#[tokio::test]
async fn strategy_plan_content_publish_measure_learn_and_project() {
    let (mut w, x) = scenarios::publishing_world().await;
    w.d.channels = Arc::new(jt_app::usecases::capabilities::UowChannelCatalog::new(
        Arc::new(w.uow.clone()),
    ));
    // A real approval transition, preserving the stable hypothesis and earlier birth chain.
    strategy::start_consultation(&w.d, &w.ctx).await.unwrap();
    for (key, value) in [
        ("channels", json!([{"channel":"x","rationale":"smoke"}])),
        ("paid_enabled", json!(false)),
        (
            "identity",
            json!({"product":"Smoke","voice":"plain","positioning":"local","usp":"useful"}),
        ),
        (
            "audience",
            json!([{"key":"all","name":"All","description":"test audience"}]),
        ),
        (
            "goals",
            json!({"objective":"responses","kpis":[{"name":"reply","target":"10"}]}),
        ),
        ("prohibitions", json!(["private data"])),
        (
            "cadence",
            json!({"per_week":7,"channel_mix":[{"channel":"x","share_pct":100}]}),
        ),
    ] {
        strategy::write_section(&w.d, &w.ctx, key.into(), value)
            .await
            .unwrap();
    }
    let draft = strategy::submit(&w.d, &w.ctx).await.unwrap();
    let approved = strategy::approve(
        &w.d,
        &w.ctx,
        strategy::ApproveInput {
            version_id: draft.id,
            submitted_at: draft.submitted_at.unwrap(),
        },
    )
    .await
    .unwrap();
    w.current = approved.id;
    assert_eq!(approved.status, jt_strategy::VersionStatus::Approved);
    let start = time::macros::datetime!(2026-10-25 21:00 UTC);
    assert_eq!(planner::plan(&w.d, w.f.ws, start).await.unwrap(), 7);
    assert_eq!(planner::plan(&w.d, w.f.ws, start).await.unwrap(), 0);
    // Submit the planner's own first slot, not a manually inserted publication.
    let planned = w
        .uow
        .snapshot()
        .studio
        .slots
        .into_iter()
        .find(|s| s.scheduled_at >= start)
        .unwrap();
    w.f.slot = planned.clone();
    let file = jt_app::usecases::studio::files::file_upload(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({
            "request_key":"upload", "filename":"a.png", "mime":"image/png",
            "content":{"kind":"bytes_base64","data":"iVBORw0KGgpzbW9rZQ=="}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let input = jt_app::usecases::studio::pieces::PieceInput {
        slot_id: planned.id,
        expected_revision: 0,
        request_key: "piece".into(),
        text: "supplied by agent".into(),
        media: vec![jt_studio::MediaAsset::File { id: file.id }],
        adaptations: Default::default(),
    };
    jt_app::usecases::studio::pieces::piece_submit(&w.d, &w.ctx, input.clone())
        .await
        .unwrap();
    jt_app::usecases::studio::pieces::piece_submit(&w.d, &w.ctx, input)
        .await
        .unwrap();
    // Retire the unrelated Ready seed, so only the newly planned piece is due.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    for slot in r
        .studio()
        .list_slots(jt_app::ports::studio::SlotQuery {
            from: FIXED_NOW - Duration::days(1),
            until: start,
            hypothesis_id: None,
            lane: None,
        })
        .await
        .unwrap()
    {
        r.studio()
            .retire_slot(slot.id, slot.revision, "cancelled")
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let published_at = planned.scheduled_at;
    w.d.clock = Arc::new(FixedClock(published_at));
    x.push_publish(Ok(scenarios::receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let before = w.uow.snapshot().studio;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .finish_publication(
            before.attempts[0].id(),
            jt_app::ports::studio::PublishOutcome::Succeeded(scenarios::receipt()),
            published_at,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(w.uow.snapshot().studio.publications.len(), 1);
    for days in [1, 3, 7] {
        w.d.clock = Arc::new(FixedClock(published_at + Duration::days(days)));
        scenarios::metrics(&x);
        assert_eq!(
            Job::StudioMeasure.run(&w.d, w.d.clock.now()).await.changed,
            1
        );
        let m = w.uow.snapshot().studio.measurements.last().unwrap().clone();
        assert!(!measure::record(&w.d, m).await.unwrap());
    }
    let snapshot = w.uow.snapshot();
    assert_eq!(snapshot.studio.measurements.len(), 3);
    assert_eq!(snapshot.studio.publications[0].chain, planned.chain);
    assert_eq!(
        snapshot.studio.publications[0].executed_version_id,
        approved.id
    );
    let q = views::StudioQuery {
        hypothesis_id: Some(planned.chain.hypothesis_id),
        lane: None,
        from: published_at - Duration::days(1),
        until: published_at + Duration::days(8),
    };
    let overview = views::overview(&w.d, &w.ctx, q.clone()).await.unwrap();
    assert_eq!(overview.strategy.id, approved.id);
    assert!(overview.lane_support.organic.visible);
    assert!(overview.slots.iter().any(|s| s.id == planned.id));
    assert_eq!(overview.learned.hypotheses[0].derived_confidence, Some(0.4));
    assert_eq!(
        overview
            .learned
            .arms
            .iter()
            .map(|a| a.evidence.len())
            .sum::<usize>(),
        3
    );
    let ledger = views::ledger(
        &w.d,
        &w.ctx,
        views::StudioLedgerQuery {
            hypothesis_id: Some(planned.chain.hypothesis_id),
            lane: None,
            from: FIXED_NOW - Duration::days(1),
            until: q.until,
            before: None,
            limit: 200,
        },
    )
    .await
    .unwrap();
    assert!(!ledger.entries.is_empty());
    assert_eq!(scenarios::sends(&x), 1);
}
#[tokio::test]
async fn externally_seeded_paid_set_budget_intake_join_and_projection() {
    jt_testkit::studio_attribution_contract::paid_smoke(Arc::new(InMemoryUow::new())).await;
}
#[tokio::test]
async fn uncertain_publication_restart_never_resends() {
    scenarios::uncertain_restart().await;
}
#[tokio::test]
async fn archive_allows_due_evidence_but_refuses_execution() {
    scenarios::historical_jobs().await;
}
#[tokio::test]
async fn thirty_day_cleanup_preserves_archived_evidence() {
    scenarios::cleanup_after_archive().await;
}
#[tokio::test]
async fn brake_against_both_predispatch_barriers_survives_restart() {
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        scenarios::brake_at_barriers(),
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn two_consumers_race_the_same_remaining_cap() {
    jt_testkit::studio_contract::reservations_are_atomic_and_settlement_is_idempotent(
        &InMemoryUow::new(),
    )
    .await;
}
