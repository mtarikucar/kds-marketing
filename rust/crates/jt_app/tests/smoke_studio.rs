//! Offline M3 acceptance: real services and scheduled jobs, scripted providers only.
#[path = "support/studio_acceptance.rs"]
mod scenarios;
use jt_app::{
    ports::UnitOfWork,
    usecases::{
        jobs::Job,
        strategy,
        studio::{measure, planner, posts, publish, views},
    },
};
use jt_testkit::fakes::{FIXED_NOW, FixedClock, InMemoryUow};
use serde_json::json;
use std::sync::Arc;
use time::Duration;

#[tokio::test]
async fn strategy_plan_content_publish_measure_learn_and_project() {
    run_acceptance().await;
}

/// Shared unchanged M2/M3 acceptance flow for the M4 aggregate.
pub async fn run_acceptance() {
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
    // The owner gives a material: a human makes an upload a material of a confirmed olay (spec
    // 2026-11-03 D1). Everything else follows from it.
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
    let olay = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let material = jt_testkit::studio_contract::eligible_material(&olay, file.id);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials()
        .insert_olay(olay.clone())
        .await
        .unwrap();
    r.studio_materials()
        .insert_material(material.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    // The planner asks agents for a package once the olay's materials settle; it never creates
    // a post, and it retires the weekly quotas' ready seed (D34).
    let start = time::macros::datetime!(2026-10-25 21:00 UTC);
    let seed = w.f.slot.id;
    planner::plan(&w.d, w.f.ws, start).await.unwrap();
    planner::plan(&w.d, w.f.ws, start + Duration::minutes(10))
        .await
        .unwrap();
    let mut ctx = w.ctx.clone();
    ctx.now = start;
    let requests = posts::package_requests(&w.d, &ctx, Default::default())
        .await
        .unwrap();
    // One request per olay: the new one's lists the new material.
    let request = requests
        .iter()
        .find(|q| q.olay_id == Some(olay.id))
        .unwrap()
        .clone();
    assert_eq!(request.material_ids, vec![material.id]);
    let snapshot = w.uow.snapshot();
    assert!(snapshot.posts.posts.is_empty());
    assert_eq!(
        snapshot
            .studio
            .slots
            .iter()
            .find(|s| s.id == seed)
            .unwrap()
            .state,
        jt_studio::SlotState::Retired
    );
    // The agent answers with one post on the X account; it is materialized at once.
    let package = posts::package_propose(
        &w.d,
        &ctx,
        serde_json::from_value(json!({
            "request_id": request.id, "request_key": "package",
            "posts": [{"format":"feed_post","capability_id":w.f.slot.capability_id,
                "publish_at":"2026-10-28T07:00:00Z","material_ids":[material.id],
                "subject":{"kind":"olay","olay_id":olay.id},
                "hypothesis_id":w.f.slot.chain.hypothesis_id}]
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let planned = package.posts[0].slot.clone();
    w.f.slot = planned.clone();
    // From its preparation start the agent submits the piece, about the post's subject.
    ctx.now = package.posts[0].post.prep_start_at;
    let input = jt_app::usecases::studio::pieces::PieceInput {
        slot_id: planned.id,
        expected_revision: 0,
        request_key: "piece".into(),
        text: "supplied by agent".into(),
        media: vec![jt_studio::MediaAsset::File { id: file.id }],
        adaptations: Default::default(),
        subject: None,
    };
    jt_app::usecases::studio::pieces::piece_submit(&w.d, &ctx, input.clone())
        .await
        .unwrap();
    jt_app::usecases::studio::pieces::piece_submit(&w.d, &ctx, input)
        .await
        .unwrap();
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
