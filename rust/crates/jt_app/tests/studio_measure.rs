#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ports::{
        UnitOfWork,
        connectors::{PostMetrics, PublishReceipt},
    },
    usecases::studio::{measure::measure_due, publish::publish_due},
};
use jt_connector::Provider;
use jt_studio::SlotState;
use jt_testkit::fakes::{FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry};
use std::sync::Arc;
use time::Duration;
async fn published() -> (support::World, Arc<ScriptedConnector>) {
    let mut w = support::world().await;
    let c = Arc::new(ScriptedConnector::new(Provider::X));
    w.d.connectors = Arc::new(ScriptedRegistry::new().with_connector(c.clone()));
    c.push_publish(Ok(PublishReceipt {
        external_id: "123".into(),
        url: None,
    }));
    publish_due(&w.d, w.f.ws).await.unwrap();
    (w, c)
}
fn metrics(c: &ScriptedConnector, n: i64) {
    c.push_post_metrics(Ok(PostMetrics {
        metrics: [("impressions".into(), 100), ("engagements".into(), n)].into(),
    }));
}
#[tokio::test]
async fn all_three_windows_complete_after_first_measured_state() {
    let (mut w, c) = published().await;
    for (days, n) in [(1, 20), (3, 80), (7, 80)] {
        w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(days)));
        metrics(&c, n);
        assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 1);
    }
    let s = w.uow.snapshot();
    assert_eq!(s.studio.measurements.len(), 3);
    assert_eq!(s.studio.slots[0].state, SlotState::Retired);
    assert!((s.studio.arms[0].alpha - 1.8).abs() < 1e-12);
    assert!((s.studio.arms[0].beta - 1.2).abs() < 1e-12);
}
#[tokio::test]
async fn same_measurement_updates_learning_once() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    measure_due(&w.d, w.f.ws).await.unwrap();
    let before = w.uow.snapshot().studio;
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(w.uow.snapshot().studio.arms, before.arms);
    assert!(
        !jt_app::usecases::studio::measure::record(&w.d, before.measurements[0].clone())
            .await
            .unwrap()
    );
}
#[tokio::test]
async fn failed_read_retries_without_learning() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    c.push_post_metrics(Err(jt_connector::ConnectorError::transient("offline")));
    measure_due(&w.d, w.f.ws).await.unwrap();
    assert!(w.uow.snapshot().studio.learning.is_empty());
    metrics(&c, 20);
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 0);
    w.d.clock = Arc::new(FixedClock(
        FIXED_NOW + Duration::days(1) + Duration::hours(1),
    ));
    measure_due(&w.d, w.f.ws).await.unwrap();
    assert_eq!(w.uow.snapshot().studio.measurements.len(), 1);
    assert!((w.uow.snapshot().studio.arms[0].alpha - 1.2).abs() < 1e-12);
}
/// A provider's permanent refusal of a post's counters (LinkedIn has no member post metrics; a
/// TikTok post with no public id) is recorded once per window and never asked again: no retry
/// storm, no learning, and the publication stays.
#[tokio::test]
async fn permanent_unsupported_metrics_stop_retrying() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    c.push_post_metrics(Err(jt_connector::ConnectorError::permanent(
        "LinkedIn exposes no member post metrics",
    )));
    measure_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.studio.publications.len(), 1);
    assert!(s.studio.learning.is_empty());
    let failed = &s.studio.measurements[0];
    assert_eq!(failed.status, jt_studio::MeasurementStatus::Failed);
    assert_eq!(
        serde_json::to_value(failed).unwrap()["failure"]["category"],
        "permanent"
    );
    // Long after its retry time, the window is not read again (nothing is queued: a read would
    // panic the scripted adapter).
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(2)));
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 0);
    let reads = |c: &ScriptedConnector| {
        c.calls()
            .iter()
            .filter(|call| matches!(call, jt_testkit::fakes::ConnectorCall::PostMetrics { .. }))
            .count()
    };
    assert_eq!(reads(&c), 1);
    // The next window is asked once, and refused once too.
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(3)));
    c.push_post_metrics(Err(jt_connector::ConnectorError::permanent(
        "LinkedIn exposes no member post metrics",
    )));
    measure_due(&w.d, w.f.ws).await.unwrap();
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(5)));
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(reads(&c), 2);
    assert!(w.uow.snapshot().studio.learning.is_empty());
}
/// TikTok's and LinkedIn's counter names feed the reward like the others: views as impressions,
/// likes, comments and shares as engagements.
#[tokio::test]
async fn tiktok_and_linkedin_counter_names_are_read() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    c.push_post_metrics(Ok(PostMetrics {
        metrics: [
            ("view_count".into(), 100),
            ("like_count".into(), 10),
            ("comment_count".into(), 5),
            ("share_count".into(), 5),
        ]
        .into(),
    }));
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    let m = &s.studio.measurements[0];
    assert_eq!(m.status, jt_studio::MeasurementStatus::Complete);
    assert_eq!(m.raw_metrics["impressions"], Some(100));
    assert_eq!(m.raw_metrics["engagements"], Some(20));
}
#[tokio::test]
async fn late_24h_read_cannot_replace_7d_reward() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(7)));
    c.push_post_metrics(Err(jt_connector::ConnectorError::transient("offline")));
    metrics(&c, 40);
    metrics(&c, 80);
    measure_due(&w.d, w.f.ws).await.unwrap();
    metrics(&c, 20);
    w.d.clock = Arc::new(FixedClock(
        FIXED_NOW + Duration::days(7) + Duration::hours(1),
    ));
    measure_due(&w.d, w.f.ws).await.unwrap();
    assert_eq!(
        w.uow
            .snapshot()
            .studio
            .measurements
            .iter()
            .filter(|m| m.status == jt_studio::MeasurementStatus::Complete)
            .count(),
        3
    );
    let a = &w.uow.snapshot().studio.arms[0];
    assert!((a.alpha - 1.8).abs() < 1e-12);
    assert!((a.beta - 1.2).abs() < 1e-12);
}
#[tokio::test]
async fn all_windows_complete_retires_measured_slot() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    measure_due(&w.d, w.f.ws).await.unwrap();
    assert_eq!(w.uow.snapshot().studio.slots[0].state, SlotState::Measured);
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(7)));
    metrics(&c, 40);
    metrics(&c, 80);
    measure_due(&w.d, w.f.ws).await.unwrap();
    assert_eq!(w.uow.snapshot().studio.slots[0].state, SlotState::Retired);
}
#[tokio::test]
async fn archive_then_due_measurement_records_evidence_without_execution() {
    let (mut w, c) = published().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.strategy()
        .set_status(
            w.current,
            jt_strategy::VersionStatus::Archived,
            FIXED_NOW,
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert!(w.permit().await.is_err());
}
#[tokio::test]
async fn derived_confidence_retains_evidence_and_version() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    measure_due(&w.d, w.f.ws).await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let h = r.hypotheses().list(w.current).await.unwrap();
    assert_eq!(h[0].derived_confidence, Some(0.4));
    let m = &w.uow.snapshot().studio.measurements[0];
    assert_eq!(m.chain.born_version_id, w.f.slot.chain.born_version_id);
    assert_eq!(m.scheduled_at, Some(FIXED_NOW + Duration::days(1)));
}
#[tokio::test]
async fn judgment_is_separate_from_measured_result() {
    use jt_app::usecases::studio::learning::*;
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    measure_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot().studio;
    let input = JudgmentInput {
        hypothesis_id: w.f.arm.key.hypothesis_id,
        evidence_ids: vec![s.measurements[0].id],
        text: "Keep experimenting".into(),
        request_key: "judgment-1".into(),
    };
    let out = judgment_record(&w.d, &w.ctx, input.clone()).await.unwrap();
    assert_eq!(
        judgment_record(&w.d, &w.ctx, input).await.unwrap().id,
        out.id
    );
    assert_eq!(w.uow.snapshot().studio.arms, s.arms);
    let results = learned(
        &w.d,
        &w.ctx,
        LearnedQuery {
            hypothesis_id: Some(w.f.arm.key.hypothesis_id),
            lane: None,
            from: FIXED_NOW - Duration::days(1),
            until: FIXED_NOW + Duration::days(8),
        },
    )
    .await
    .unwrap();
    assert_eq!(results.judgments.len(), 1);
    assert_eq!(results.arms[0].evidence[0].id, s.measurements[0].id);
    assert_eq!(results.hypotheses[0].derived_confidence, Some(0.4));
}
#[tokio::test]
async fn open_draft_approval_cannot_reset_new_learning() {
    use jt_strategy::{StrategyVersionId, VersionStatus, next_draft_from};
    let (mut w, c) = published().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut v = r.strategy().find(w.current).await.unwrap().unwrap();
    let h = r.hypotheses().list(v.id).await.unwrap();
    let (sections, inputs) = next_draft_from(&v, &h);
    v.id = StrategyVersionId::new_v7();
    v.number += 1;
    v.status = VersionStatus::Draft;
    v.sections = sections;
    r.strategy().insert(v.clone()).await.unwrap();
    for input in inputs {
        r.hypotheses().upsert(v.id, input).await.unwrap();
    }
    r.commit().await.unwrap();
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    measure_due(&w.d, w.f.ws).await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.strategy()
        .set_status(w.current, VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    r.strategy()
        .set_status(v.id, VersionStatus::Approved, FIXED_NOW, None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.hypotheses().list(v.id).await.unwrap()[0].derived_confidence,
        Some(0.4)
    );
}
#[tokio::test]
async fn draft_replacement_preserves_derived_and_edits_only_prior() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    measure_due(&w.d, w.f.ws).await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut h = r.hypotheses().list(w.current).await.unwrap().remove(0);
    h.prior_confidence = 0.9;
    h.derived_confidence = Some(0.1);
    r.hypotheses().upsert(w.current, h).await.unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let h = r.hypotheses().list(w.current).await.unwrap().remove(0);
    assert_eq!(h.prior_confidence, 0.9);
    assert_eq!(h.derived_confidence, Some(0.4));
}
#[tokio::test]
async fn paid_daily_correction_replaces_reward_and_preserves_currency_exponent() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let c = w.ads.clone();
    for (clicks, spend) in [(20, 100), (80, 200), (80, 200)] {
        c.push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
            account_id: "act_1".into(),
            currency: "JPY".into(),
            minor_unit_exponent: 0,
            timezone: "Asia/Tokyo".into(),
        }));
        c.push_list_adsets(Ok(vec![jt_app::ports::connectors::AdSet {
            id: b.adset_id.clone(),
            name: "set".into(),
            status: "PAUSED".into(),
            campaign_id: b.campaign_id.clone(),
            daily_budget_minor: Some(10),
            lifetime_budget_minor: None,
        }]));
        c.push_adset_insights(Ok(vec![jt_app::ports::connectors::AdSetInsights {
            account_id: "act_1".into(),
            adset_id: b.adset_id.clone(),
            campaign_id: b.campaign_id.clone(),
            date: FIXED_NOW.date(),
            spend_minor: Some(spend),
            impressions: Some(100),
            clicks: Some(clicks),
        }]));
        measure_due(&w.d, w.f.ws).await.unwrap();
    }
    let s = w.uow.snapshot();
    let a = s
        .studio
        .arms
        .iter()
        .find(|a| a.id == b.chain.arm_id)
        .unwrap();
    assert!((a.alpha - 1.8).abs() < 1e-12);
    assert_eq!(s.studio.measurements.len(), 2);
    assert_eq!(s.studio.measurements[1].minor_unit_exponent, Some(0));
    assert_eq!(s.studio.measurements[1].currency.as_deref(), Some("JPY"));
}
#[tokio::test]
async fn shared_campaign_totals_never_credit_two_arms() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut other = b.clone();
    other.id = jt_studio::AdSetBindingId::new_v7();
    other.adset_id = "set_2".into();
    let arm = jt_studio::Arm::new(
        jt_studio::ArmId::new_v7(),
        w.f.ws,
        jt_studio::ArmKey {
            hypothesis_id: b.chain.hypothesis_id,
            content_type: "image".into(),
            channel: "meta_ads".into(),
            lane: jt_strategy::LaneKind::Paid,
        },
    )
    .unwrap();
    other.chain.arm_id = arm.id;
    r.studio().insert_arm(arm).await.unwrap();
    r.studio()
        .bind_adset(other.clone(), "second")
        .await
        .unwrap();
    r.commit().await.unwrap();
    for _ in 0..2 {
        w.ads
            .push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
                account_id: "act_1".into(),
                currency: "TRY".into(),
                minor_unit_exponent: 2,
                timezone: "Europe/Istanbul".into(),
            }));
        w.ads.push_list_adsets(Ok([&b, &other]
            .into_iter()
            .map(|b| jt_app::ports::connectors::AdSet {
                id: b.adset_id.clone(),
                name: "set".into(),
                status: "PAUSED".into(),
                campaign_id: b.campaign_id.clone(),
                daily_budget_minor: Some(10),
                lifetime_budget_minor: None,
            })
            .collect()));
        w.ads
            .push_adset_insights(Ok(vec![jt_app::ports::connectors::AdSetInsights {
                account_id: "act_1".into(),
                adset_id: "set_1".into(),
                campaign_id: b.campaign_id.clone(),
                date: FIXED_NOW.date(),
                spend_minor: Some(10),
                impressions: Some(100),
                clicks: Some(20),
            }]));
    }
    measure_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.studio.measurements.len(), 1);
    assert_eq!(
        s.studio
            .arms
            .iter()
            .find(|a| a.id == other.chain.arm_id)
            .unwrap()
            .alpha,
        1.0
    );
    assert!(
        !w.ads
            .calls()
            .iter()
            .any(|call| matches!(call, jt_testkit::fakes::ConnectorCall::Insights { .. }))
    );
}
#[tokio::test]
async fn measure_runs_every_six_hours_and_reweight_monday() {
    use jt_app::usecases::{
        jobs::Job,
        studio::learning::{reweight_week, week_start},
    };
    let w = support::world().await;
    let start = week_start(FIXED_NOW).to_offset(time::UtcOffset::from_hms(3, 0, 0).unwrap());
    assert_eq!(start.weekday(), time::Weekday::Monday);
    assert_eq!(start.hour(), 0);
    assert_eq!(start.offset().whole_hours(), 3);
    assert!(reweight_week(&w.d, w.f.ws, FIXED_NOW).await.unwrap());
    assert!(
        !reweight_week(&w.d, w.f.ws, FIXED_NOW + Duration::hours(1))
            .await
            .unwrap()
    );
    assert_eq!(Job::StudioMeasure.lock_name(), "jeeta.jobs.studio_measure");
    assert_eq!(
        Job::StudioReweight.lock_name(),
        "jeeta.jobs.studio_reweight"
    );
}

#[tokio::test]
async fn provider_counter_names_keep_missing_impressions_explicit() {
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    c.push_post_metrics(Ok(PostMetrics {
        metrics: [
            ("impression_count".into(), 100),
            ("like_count".into(), 15),
            ("reply_count".into(), 5),
        ]
        .into(),
    }));
    measure_due(&w.d, w.f.ws).await.unwrap();
    assert!((w.uow.snapshot().studio.arms[0].alpha - 1.2).abs() < 1e-12);
}
#[tokio::test]
async fn measured_status_drift_brakes_paid_lane_and_keeps_spend_evidence() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_control()
        .save_binding_control(jt_studio::BindingControl {
            binding_id: b.id,
            chain: b.chain.clone(),
            desired: jt_studio::AdStatus::Paused,
            resume_operation_id: None,
            observed: Some(jt_studio::AdStatus::Paused),
            paused_by_brake: false,
            outcome: Some(jt_studio::BindingStatusOutcome::Applied {
                observed: jt_studio::AdStatus::Paused,
            }),
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.ads
        .push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
            account_id: "act_1".into(),
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
        }));
    w.ads
        .push_list_adsets(Ok(vec![jt_app::ports::connectors::AdSet {
            id: b.adset_id.clone(),
            name: "set".into(),
            status: "ACTIVE".into(),
            campaign_id: b.campaign_id.clone(),
            daily_budget_minor: Some(10),
            lifetime_budget_minor: None,
        }]));
    w.ads
        .push_adset_insights(Ok(vec![jt_app::ports::connectors::AdSetInsights {
            account_id: "act_1".into(),
            adset_id: b.adset_id.clone(),
            campaign_id: b.campaign_id.clone(),
            date: FIXED_NOW.date(),
            spend_minor: Some(23),
            impressions: Some(100),
            clicks: Some(20),
        }]));
    measure_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    assert!(
        s.studio
            .controls
            .iter()
            .find(|c| c.workspace_id == w.f.ws)
            .unwrap()
            .is_braked(jt_strategy::LaneKind::Paid)
    );
    assert_eq!(
        s.studio.measurements[0].raw_metrics["spend_minor"],
        Some(23)
    );
    assert!(
        s.ledger
            .iter()
            .any(|e| e.entry.action.as_str() == "studio.external_drift")
    );
}
#[tokio::test]
async fn learned_range_filters_numbers_and_evidence_together() {
    use jt_app::usecases::studio::learning::*;
    let (mut w, c) = published().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
    metrics(&c, 20);
    measure_due(&w.d, w.f.ws).await.unwrap();
    let out = learned(
        &w.d,
        &w.ctx,
        LearnedQuery {
            hypothesis_id: Some(w.f.arm.key.hypothesis_id),
            lane: None,
            from: FIXED_NOW - Duration::days(1),
            until: FIXED_NOW,
        },
    )
    .await
    .unwrap();
    assert!(out.arms[0].evidence.is_empty());
    assert_eq!(out.hypotheses[0].derived_confidence, None);
    assert_eq!(out.arms[0].arm.alpha, 1.0);
}

async fn break_access(w: &support::World, kind: &str) {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    match kind {
        "disconnected" => c.status = jt_capability::StoredStatus::Unreachable,
        "expired" => {
            c.connector_public["access"]["expires_at"] = serde_json::json!("2020-01-01T00:00:00Z")
        }
        "rebound" => c.external_id = Some("other_account".into()),
        "permission" => c.connector_public["access"]["scopes"] = serde_json::json!([]),
        _ => unreachable!(),
    }
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
}
fn paid_metrics(w: &support::World, b: &jt_studio::AdSetBinding, date: time::Date) {
    w.ads
        .push_adset_insights(Ok(vec![jt_app::ports::connectors::AdSetInsights {
            account_id: "act_1".into(),
            adset_id: b.adset_id.clone(),
            campaign_id: b.campaign_id.clone(),
            date,
            spend_minor: Some(23),
            impressions: Some(100),
            clicks: Some(20),
        }]));
}
#[tokio::test]
async fn broken_publication_does_not_block_paid_checks() {
    for (kind, category) in [
        ("disconnected", "capability_unavailable"),
        ("expired", "access_expired"),
        ("rebound", "historical_account_changed"),
        ("permission", "credential_scope_missing"),
    ] {
        let mut w = support::world().await;
        let id = w.publish_evidence().await;
        let (b, _) = w.paid().await;
        break_access(&w, kind).await;
        w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::days(1)));
        w.provider_status("ACTIVE", 200);
        paid_metrics(&w, &b, (FIXED_NOW + Duration::days(1)).date());
        w.provider_status("ACTIVE", 200);
        w.ads.push_set_status(Ok(()));
        measure_due(&w.d, w.f.ws).await.unwrap();
        let s = w.uow.snapshot();
        let failed = s
            .studio
            .measurements
            .iter()
            .find(|m| m.publication_id == Some(id))
            .unwrap();
        assert_eq!(failed.status, jt_studio::MeasurementStatus::Failed);
        assert_eq!(
            serde_json::to_value(failed).unwrap()["failure"]["category"],
            category
        );
        assert!(
            s.studio
                .measurements
                .iter()
                .any(|m| m.binding_id == Some(b.id) && m.raw_metrics["spend_minor"] == Some(23))
        );
        assert!(s.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
        assert!(
            s.studio
                .learning
                .iter()
                .all(|l| l.chain.arm_id == b.chain.arm_id)
        );
    }
}
#[tokio::test]
async fn deferred_measurement_backs_off() {
    let (mut w, c) = published().await;
    break_access(&w, "disconnected").await;
    let mut at = FIXED_NOW + Duration::days(1);
    for (attempt, hours) in [(1, 1), (2, 6), (3, 24), (4, 24)] {
        w.d.clock = Arc::new(FixedClock(at));
        measure_due(&w.d, w.f.ws).await.unwrap();
        let s = w.uow.snapshot();
        let m = s
            .studio
            .measurements
            .iter()
            .find(|m| m.window == jt_studio::MeasurementWindow::Hours24)
            .unwrap();
        let failure = serde_json::to_value(m).unwrap()["failure"].clone();
        assert_eq!(failure["attempts"], attempt);
        assert_eq!(
            serde_json::from_value::<time::OffsetDateTime>(failure["retry_at"].clone()).unwrap(),
            at + Duration::hours(hours)
        );
        w.d.clock = Arc::new(FixedClock(at + Duration::minutes(59)));
        assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 0);
        assert_eq!(w.uow.snapshot().studio.measurements, s.studio.measurements);
        at += Duration::hours(hours);
    }
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.status = jt_capability::StoredStatus::Verified;
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    w.d.clock = Arc::new(FixedClock(at));
    metrics(&c, 20);
    metrics(&c, 40); // The 72-hour window is now due too.
    measure_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    let m = s
        .studio
        .measurements
        .iter()
        .find(|m| m.window == jt_studio::MeasurementWindow::Hours24)
        .unwrap();
    assert_eq!(m.status, jt_studio::MeasurementStatus::Complete);
    assert!(serde_json::to_value(m).unwrap()["failure"].is_null());
}
#[tokio::test]
async fn istanbul_account_current_day_bucket_accepted_at_2200_utc() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    w.d.clock = Arc::new(FixedClock(time::macros::datetime!(2026-10-24 22:00 UTC)));
    w.provider_status("PAUSED", 10);
    paid_metrics(&w, &b, time::macros::date!(2026 - 10 - 25));
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(
        s.studio.measurements[0].date,
        Some(time::macros::date!(2026 - 10 - 25))
    );
    assert_eq!(
        s.studio.measurements[0].raw_metrics["spend_minor"],
        Some(23)
    );
    assert!(
        w.ads.calls().iter().any(|call| matches!(call,
        jt_testkit::fakes::ConnectorCall::AdSetInsights { since, until, .. }
        if *since == time::macros::date!(2026-10-18) && *until == time::macros::date!(2026-10-25)))
    );
}

#[tokio::test]
async fn broken_binding_does_not_block_later_binding() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let mut other = b.clone();
    other.id = jt_studio::AdSetBindingId::new_v7();
    other.adset_id = "set_2".into();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .bind_adset(other.clone(), "second")
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.ads
        .push_account_context(Err(jt_connector::ConnectorError::permission(
            "scope revoked",
        )));
    w.ads
        .push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
            account_id: "act_1".into(),
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
        }));
    w.ads
        .push_list_adsets(Ok(vec![jt_app::ports::connectors::AdSet {
            id: other.adset_id.clone(),
            name: "set".into(),
            status: "PAUSED".into(),
            campaign_id: other.campaign_id.clone(),
            daily_budget_minor: Some(10),
            lifetime_budget_minor: None,
        }]));
    paid_metrics(&w, &other, FIXED_NOW.date());
    assert_eq!(measure_due(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.measurements[0].binding_id, Some(other.id));
    assert_eq!(
        s.studio.measurements[0].raw_metrics["spend_minor"],
        Some(23)
    );
    assert!(
        s.ledger
            .iter()
            .any(|e| e.entry.action.as_str() == "studio.measurement.failed"
                && e.entry.payload["category"] == "permission")
    );
}
