#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ports::UnitOfWork,
    usecases::studio::{ads::*, budget::*},
};
use jt_studio::BudgetMoveState;

#[tokio::test]
async fn absolute_budget_is_not_spend() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_daily_budget(Ok(()));
    let out = budget_move(
        &w.d,
        &w.ctx,
        BudgetMoveInput {
            binding_id: b.id,
            daily_budget_minor: 20,
            currency: "TRY".into(),
            request_key: "absolute".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(out.move_.state, BudgetMoveState::Succeeded);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let c = r
        .capabilities()
        .find(b.capability_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        r.budget()
            .spent_between(
                c.budget_item_ids[0],
                time::OffsetDateTime::UNIX_EPOCH,
                jt_capability::END_OF_TIME
            )
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn no_campaign_adset_or_creative_creation() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    let listed = adsets_list(
        &w.d,
        &w.ctx,
        AdSetsQuery {
            capability_id: b.capability_id,
        },
    )
    .await
    .unwrap();
    assert_eq!(listed.len(), 1);
    for row in jt_app::catalog::CATALOG {
        assert!(
            ![
                "studio.campaign_create",
                "studio.adset_create",
                "studio.creative_create"
            ]
            .contains(&row.id)
        );
    }
}

use jt_app::error::ErrorCode;
use jt_studio::SpendOutcome;
use jt_testkit::fakes::{ConnectorCall, FIXED_NOW};

fn move_input(b: &jt_studio::AdSetBinding, key: &str, daily: i64) -> BudgetMoveInput {
    BudgetMoveInput {
        binding_id: b.id,
        daily_budget_minor: daily,
        currency: "TRY".into(),
        request_key: key.into(),
    }
}
fn writes(w: &support::World) -> usize {
    w.ads
        .calls()
        .iter()
        .filter(|c| matches!(c, ConnectorCall::SetDailyBudget { .. }))
        .count()
}
#[tokio::test]
async fn paid_lane_requires_both_account_and_strategy_four_cases() {
    for account in [false, true] {
        for strategy in [false, true] {
            let w = support::world().await;
            let (b, _) = w.paid().await;
            if !account {
                let mut r = w.uow.tenant(w.f.ws).await.unwrap();
                let c = r
                    .capabilities()
                    .find(b.capability_id)
                    .await
                    .unwrap()
                    .unwrap();
                r.capabilities()
                    .set_sealed(c.id, None, FIXED_NOW)
                    .await
                    .unwrap();
                r.commit().await.unwrap();
            }
            if !strategy {
                w.archive().await;
            }
            w.provider_status("PAUSED", 10);
            assert_eq!(
                adsets_list(
                    &w.d,
                    &w.ctx,
                    AdSetsQuery {
                        capability_id: b.capability_id
                    }
                )
                .await
                .is_ok(),
                account && strategy
            );
        }
    }
}
#[tokio::test]
async fn unbound_or_foreign_account_set_cannot_change_budget() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let mut input = move_input(&b, "missing", 20);
    input.binding_id = jt_studio::AdSetBindingId::new_v7();
    assert_eq!(
        budget_move(&w.d, &w.ctx, input).await.unwrap_err().code,
        ErrorCode::NotFound
    );
    w.ads
        .push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
            account_id: "foreign".into(),
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "UTC".into(),
        }));
    assert!(
        budget_move(&w.d, &w.ctx, move_input(&b, "foreign", 20))
            .await
            .is_err()
    );
    assert_eq!(writes(&w), 0);
}
#[tokio::test]
async fn concurrent_reservations_never_exceed_cap() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::reservations_are_atomic_and_settlement_is_idempotent(&uow).await;
}
#[tokio::test]
async fn unknown_write_keeps_reservation() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    w.ads
        .push_set_daily_budget(Err(jt_connector::ConnectorError::unknown("lost")));
    let out = budget_move(&w.d, &w.ctx, move_input(&b, "unknown", 20))
        .await
        .unwrap();
    assert_eq!(out.outcome, BudgetMoveState::Unknown);
    assert_eq!(
        w.uow.snapshot().studio.reservations[0].1,
        Some(SpendOutcome::Unknown)
    );
    let again = budget_move(&w.d, &w.ctx, move_input(&b, "unknown", 20))
        .await
        .unwrap();
    assert_eq!(again.move_, out.move_);
    assert_eq!(writes(&w), 1);
}
#[tokio::test]
async fn over_cap_refuses_without_approval() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let e = budget_move(&w.d, &w.ctx, move_input(&b, "too_much", 100001))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::BudgetCap);
    assert_eq!(writes(&w), 0);
    assert!(w.uow.snapshot().studio.approvals.is_empty());
}
#[test]
fn daily_budget_times_remaining_days_reservation() {
    use time::macros::datetime;
    assert_eq!(
        jt_studio::daily_liability(
            3,
            jt_capability::Period::Total,
            datetime!(2026-10-24 12:00 UTC),
            datetime!(2026-10-26 13:00 UTC)
        )
        .unwrap(),
        9
    );
    assert!(
        jt_studio::daily_liability(
            i64::MAX,
            jt_capability::Period::Monthly,
            datetime!(2026-10-24 12:00 UTC),
            datetime!(2026-11-01 00:00 UTC)
        )
        .is_err()
    );
    assert!(
        jt_studio::daily_liability(
            3,
            jt_capability::Period::Total,
            datetime!(2026-10-24 12:00 UTC),
            datetime!(2026-10-24 11:00 UTC)
        )
        .is_err()
    );
}
#[tokio::test]
async fn repeated_absolute_writes_replace_instead_of_add() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    for (key, daily) in [("first", 3000), ("second", 3000), ("lower", 100)] {
        w.provider_status("PAUSED", 10);
        w.ads.push_set_daily_budget(Ok(()));
        budget_move(&w.d, &w.ctx, move_input(&b, key, daily))
            .await
            .unwrap();
    }
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let rows = r.studio_budget().list_reservations().await.unwrap();
    let (from, until) = jt_capability::period_window(jt_capability::Period::Monthly, FIXED_NOW);
    assert_eq!(
        occupied(
            &rows,
            &[],
            None,
            Some(jt_strategy::LaneKind::Paid),
            None,
            "TRY",
            from,
            until,
            FIXED_NOW
        ),
        i128::from(rows.last().unwrap().0.request.amount_minor)
    );
}
#[tokio::test]
async fn sms_segment_pricing_ascii_and_turkish() {
    for (text, amount) in [
        ("a".repeat(160), 3),
        ("a".repeat(161), 6),
        ("ş".repeat(70), 3),
        ("ğ".repeat(71), 6),
    ] {
        let uow = jt_testkit::fakes::InMemoryUow::new();
        let (f, mut item, _) = jt_testkit::studio_contract::budget_fixture(&uow).await;
        let mut r = uow.tenant(f.ws).await.unwrap();
        item.unit_cost_minor = Some(3);
        r.budget().update_item(item).await.unwrap();
        let c = r
            .capabilities()
            .find(f.slot.capability_id)
            .await
            .unwrap()
            .unwrap();
        let res = reserve_metered(
            r.as_mut(),
            &c,
            None,
            Some(u64::from(jt_inbox::sms_segments(&text))),
            "sms".into(),
            FIXED_NOW,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(res.request.amount_minor, amount);
    }
}
#[tokio::test]
async fn unknown_unit_price_refuses_without_provider_call() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let c = r
        .capabilities()
        .find(b.capability_id)
        .await
        .unwrap()
        .unwrap();
    let mut item = r
        .budget()
        .find_item(c.budget_item_ids[0])
        .await
        .unwrap()
        .unwrap();
    item.unit_cost_minor = None;
    r.budget().update_item(item).await.unwrap();
    assert!(
        reserve_metered(
            r.as_mut(),
            &c,
            None,
            Some(1),
            "unknown-price".into(),
            FIXED_NOW
        )
        .await
        .is_err()
    );
    assert_eq!(writes(&w), 0);
}

#[tokio::test]
async fn sms_and_publish_cannot_bypass_connector_spend_gate() {
    let mut w = support::world().await;
    let connector = std::sync::Arc::new(jt_testkit::fakes::ScriptedConnector::new(
        jt_connector::Provider::X,
    ));
    w.d.connectors = std::sync::Arc::new(
        jt_testkit::fakes::ScriptedRegistry::new().with_connector(connector.clone()),
    );
    let item=jt_app::usecases::budget::create_item(&w.d,&w.ctx,serde_json::from_value(serde_json::json!({"name":"metered publish","kind":"cash","unit":{"kind":"currency","value":"TRY"},"cap":1000,"period":"monthly","unit_cost_minor":3})).unwrap()).await.unwrap();
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        r.budget()
            .link(w.f.slot.capability_id, item.item.id)
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    connector.push_publish(Ok(jt_app::ports::connectors::PublishReceipt {
        external_id: "one".into(),
        url: None,
    }));
    assert_eq!(
        jt_app::usecases::studio::publish::publish_due(&w.d, w.f.ws)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        w.uow.snapshot().studio.reservations[0]
            .0
            .request
            .amount_minor,
        3
    );
}

#[tokio::test]
async fn group_removed_before_budget_write_refuses() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    let uow = w.uow.clone();
    let ws = w.f.ws;
    let version = w.current;
    w.ads.push_ad_read_hook(move || async move {
        let mut r = uow.tenant(ws).await.unwrap();
        let mut v = r.strategy().find(version).await.unwrap().unwrap();
        v.sections
            .channels
            .iter_mut()
            .find(|c| c.channel == "meta_ads")
            .unwrap()
            .group_id = Some(uuid::Uuid::new_v4());
        replace_frame(r.as_mut(), v).await;
        r.commit().await.unwrap();
    });
    assert!(
        budget_move(&w.d, &w.ctx, move_input(&b, "removed", 20))
            .await
            .is_err()
    );
    assert_eq!(writes(&w), 0);
}
#[tokio::test]
async fn new_strategy_budget_frame_wins_dispatch_race() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    let uow = w.uow.clone();
    let ws = w.f.ws;
    let version = w.current;
    w.ads.push_ad_read_hook(move || async move {
        let mut r = uow.tenant(ws).await.unwrap();
        let mut v = r.strategy().find(version).await.unwrap().unwrap();
        v.sections
            .budget_frame
            .lanes
            .iter_mut()
            .find(|l| l.lane == jt_strategy::LaneKind::Paid)
            .unwrap()
            .cap_minor = 1;
        replace_frame(r.as_mut(), v).await;
        r.commit().await.unwrap();
    });
    assert_eq!(
        budget_move(&w.d, &w.ctx, move_input(&b, "race", 20))
            .await
            .unwrap_err()
            .code,
        ErrorCode::BudgetCap
    );
    assert_eq!(writes(&w), 0);
}
#[tokio::test]
async fn period_currency_retirement_and_policy_are_enforced() {
    for reason in ["currency", "retired", "policy"] {
        let uow = jt_testkit::fakes::InMemoryUow::new();
        let (f, mut item, mut req) = jt_testkit::studio_contract::budget_fixture(&uow).await;
        let mut r = uow.tenant(f.ws).await.unwrap();
        match reason {
            "currency" => req.currency = "USD".into(),
            "retired" => {
                item.retired_at = Some(FIXED_NOW);
                r.budget().update_item(item).await.unwrap();
            }
            _ => {
                let mut c = r
                    .capabilities()
                    .find(req.capability_id)
                    .await
                    .unwrap()
                    .unwrap();
                c.policy.spend_cap_minor = Some(1);
                r.capabilities().update(c).await.unwrap();
            }
        }
        assert!(reserve_connector_spend(r.as_mut(), req).await.is_err());
    }
}

async fn replace_frame(
    r: &mut dyn jt_app::ports::TenantRepos,
    mut v: jt_strategy::StrategyVersion,
) {
    let hs = r.hypotheses().list(v.id).await.unwrap();
    r.strategy()
        .set_status(v.id, jt_strategy::VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    v.id = jt_strategy::StrategyVersionId::new_v7();
    v.number += 1;
    r.strategy().insert(v.clone()).await.unwrap();
    for h in hs {
        r.hypotheses().upsert(v.id, h).await.unwrap();
    }
}

fn daily_measurement(
    b: &jt_studio::AdSetBinding,
    date: time::Date,
    revision: u64,
    spend: i64,
) -> jt_studio::Measurement {
    jt_studio::Measurement {
        id: jt_studio::MeasurementId::new_v7(),
        chain: b.chain.clone(),
        evidence_key: format!("daily:{}:{date}:{revision}", b.id),
        publication_id: None,
        binding_id: Some(b.id),
        window: jt_studio::MeasurementWindow::Hours24,
        evidence_revision: revision,
        scheduled_at: Some(date.midnight().assume_utc()),
        account_timezone: Some("UTC".into()),
        minor_unit_exponent: Some(2),
        measured_at: date.midnight().assume_utc() + time::Duration::days(1),
        source: "meta_ads".into(),
        raw_metrics: [
            ("impressions".into(), Some(100)),
            ("clicks".into(), Some(10)),
            ("spend_minor".into(), Some(spend)),
        ]
        .into(),
        metric_scope: "adset".into(),
        date: Some(date),
        currency: Some("TRY".into()),
        status: jt_studio::MeasurementStatus::Complete,
        failure: None,
        rule_version: jt_studio::LEARNING_RULE.into(),
    }
}
#[tokio::test]
async fn spend_reconciliation_is_idempotent() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "daily", 10))
        .await
        .unwrap();
    w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
        FIXED_NOW + time::Duration::days(3),
    ));
    let m = daily_measurement(&b, FIXED_NOW.date() + time::Duration::days(1), 0, 5);
    assert!(
        jt_app::usecases::studio::measure::record(&w.d, m.clone())
            .await
            .unwrap()
    );
    assert!(
        !jt_app::usecases::studio::measure::record(&w.d, m)
            .await
            .unwrap()
    );
    let s = w.uow.snapshot();
    assert_eq!(s.studio.measurements.len(), 1);
    let (from, until) = jt_capability::period_window(jt_capability::Period::Monthly, FIXED_NOW);
    let total = occupied(
        &s.studio.reservations,
        &s.studio.measurements,
        None,
        Some(jt_strategy::LaneKind::Paid),
        None,
        "TRY",
        from,
        until,
        FIXED_NOW + time::Duration::days(3),
    );
    assert_eq!(
        total,
        i128::from(s.studio.reservations[0].0.request.amount_minor) - 10 + 5
    );
}
#[tokio::test]
async fn daily_spend_correction_and_reservation_transfer_are_atomic() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "correct", 10))
        .await
        .unwrap();
    w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
        FIXED_NOW + time::Duration::days(3),
    ));
    for (rev, spend) in [(0, 5), (1, 8), (2, 3)] {
        let m = daily_measurement(&b, FIXED_NOW.date() + time::Duration::days(1), rev, spend);
        jt_app::usecases::studio::measure::record(&w.d, m)
            .await
            .unwrap();
        let s = w.uow.snapshot();
        let (from, until) = jt_capability::period_window(jt_capability::Period::Monthly, FIXED_NOW);
        assert_eq!(
            occupied(
                &s.studio.reservations,
                &s.studio.measurements,
                None,
                Some(jt_strategy::LaneKind::Paid),
                None,
                "TRY",
                from,
                until,
                FIXED_NOW + time::Duration::days(3)
            ),
            i128::from(s.studio.reservations[0].0.request.amount_minor) - 10 + i128::from(spend)
        );
    }
}
#[tokio::test]
async fn external_budget_drift_brakes_lane_and_creates_work() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "authorized", 20))
        .await
        .unwrap();
    w.provider_status("ACTIVE", 200);
    w.ads.push_adset_insights(Ok(vec![]));
    w.provider_status("ACTIVE", 200);
    w.ads.push_set_status(Ok(()));
    jt_app::usecases::studio::measure::measure_due(&w.d, w.f.ws)
        .await
        .unwrap();
    let s = w.uow.snapshot();
    assert!(s.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    assert!(!s.studio.controls[0].is_braked(jt_strategy::LaneKind::Organic));
    let pending = jt_app::usecases::studio::work::pending(&w.d, &w.ctx)
        .await
        .unwrap();
    assert_eq!(pending.paid_alerts.len(), 1);
    assert_eq!(pending.paid_alerts[0]["residual_provider_exposure"], false);
}
#[tokio::test]
async fn period_rollover_rechecks_cap_and_pauses() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "rollover", 10))
        .await
        .unwrap();
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let c = r
            .capabilities()
            .find(b.capability_id)
            .await
            .unwrap()
            .unwrap();
        let mut item = r
            .budget()
            .find_item(c.budget_item_ids[0])
            .await
            .unwrap()
            .unwrap();
        item.cap = 1;
        r.budget().update_item(item).await.unwrap();
        r.commit().await.unwrap();
    }
    w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
        time::macros::datetime!(2026-11-01 01:00 UTC),
    ));
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    recheck_periods(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    assert!(s.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    assert!(s.studio.binding_controls[0].confirmed_paused());
    assert_eq!(writes(&w), 1);
}

#[tokio::test]
async fn confirmed_same_day_reduction_retains_unobserved_partial_day() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    for (at, key, daily) in [
        (time::macros::datetime!(2026-10-31 01:00 UTC), "high", 100),
        (time::macros::datetime!(2026-10-31 12:00 UTC), "low", 1),
    ] {
        w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(at));
        w.provider_status("PAUSED", daily);
        w.ads.push_set_daily_budget(Ok(()));
        budget_move(&w.d, &w.ctx, move_input(&b, key, daily))
            .await
            .unwrap();
    }
    let s = w.uow.snapshot();
    let (from, until) =
        jt_capability::period_window(jt_capability::Period::Monthly, w.d.clock.now());
    assert_eq!(
        occupied(
            &s.studio.reservations,
            &[],
            None,
            Some(jt_strategy::LaneKind::Paid),
            None,
            "TRY",
            from,
            until,
            w.d.clock.now()
        ),
        100
    );
}
#[tokio::test]
async fn linked_item_rollover_refreshes_inside_monthly_lane() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let c = r
            .capabilities()
            .find(b.capability_id)
            .await
            .unwrap()
            .unwrap();
        let mut item = r
            .budget()
            .find_item(c.budget_item_ids[0])
            .await
            .unwrap()
            .unwrap();
        item.period = jt_capability::Period::Daily;
        r.budget().update_item(item).await.unwrap();
        r.commit().await.unwrap();
    }
    w.provider_status("PAUSED", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "before", 10))
        .await
        .unwrap();
    w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
        FIXED_NOW + time::Duration::days(1),
    ));
    assert_eq!(recheck_periods(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(w.uow.snapshot().studio.reservations.len(), 2);
}
#[tokio::test]
async fn externally_activated_binding_without_move_brakes_and_counts_spend() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.ads.push_adset_insights(Ok(vec![]));
    jt_app::usecases::studio::measure::measure_due(&w.d, w.f.ws)
        .await
        .unwrap();
    assert!(w.uow.snapshot().studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    let m = daily_measurement(&b, FIXED_NOW.date(), 0, 100);
    let (from, until) = jt_capability::period_window(jt_capability::Period::Monthly, FIXED_NOW);
    assert_eq!(
        occupied(
            &[],
            &[m],
            None,
            Some(jt_strategy::LaneKind::Paid),
            None,
            "TRY",
            from,
            until,
            FIXED_NOW
        ),
        100
    );
}

#[tokio::test]
async fn resume_recovery_reuses_only_current_period_reservation() {
    for (days, expected) in [(1, 1), (10, 2)] {
        let mut w = support::world().await;
        w.paid().await;
        w.provider_status("ACTIVE", 10);
        w.ads.push_set_status(Ok(()));
        w.brake(true, None, 0).await;
        w.provider_status("PAUSED", 10);
        w.ads
            .push_set_status(Err(jt_connector::ConnectorError::unknown("lost")));
        w.brake(false, None, 1).await;
        let original = w.uow.snapshot().studio.reservations[0].0.clone();
        w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
            FIXED_NOW + time::Duration::days(days),
        ));
        w.provider_status("PAUSED", 10);
        w.ads.push_set_status(Ok(()));
        jt_app::usecases::studio::control::reconcile_bindings(&w.d, w.f.ws)
            .await
            .unwrap();
        let state = w.uow.snapshot();
        assert_eq!(state.studio.reservations.len(), expected);
        assert_eq!(state.studio.reservations[0].0, original);
        assert_eq!(
            state.studio.binding_controls[0].observed,
            Some(jt_studio::AdStatus::Active)
        );
        if days == 10 {
            assert_eq!(state.studio.reservations[0].1, Some(SpendOutcome::Unknown));
        }
    }
}

#[tokio::test]
async fn archived_receipt_replay_cannot_admit_connector_execution() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    let (f, _, req) = jt_testkit::studio_contract::budget_fixture(&uow).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    let saved = reserve_connector_spend(r.as_mut(), req.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.strategy()
        .set_status(
            req.executed_version_id,
            jt_strategy::VersionStatus::Archived,
            FIXED_NOW,
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(r.studio_budget().reserve(req.clone()).await.unwrap(), saved);
    assert_eq!(
        reserve_connector_spend(r.as_mut(), req)
            .await
            .unwrap_err()
            .code,
        ErrorCode::StrategyRequired
    );
}

#[tokio::test]
async fn paid_liability_contract_checks_all_item_periods() {
    jt_testkit::studio_contract::liability_uses_each_item_period(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}

#[tokio::test]
async fn refused_replacement_still_rolls_active_budget() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "first", 10))
        .await
        .unwrap();
    w.provider_status("ACTIVE", 10);
    w.ads
        .push_set_daily_budget(Err(jt_connector::ConnectorError::permanent("rejected")));
    let failed = budget_move(&w.d, &w.ctx, move_input(&b, "second", 20))
        .await
        .unwrap();
    assert_eq!(failed.outcome, BudgetMoveState::Failed);
    w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
        time::macros::datetime!(2026-11-01 01:00 UTC),
    ));
    assert_eq!(
        recheck_periods(&w.d, w.f.ws).await.unwrap(),
        1,
        "the earlier successful active budget still needs a new period reservation"
    );
}

#[tokio::test]
async fn intraday_snapshot_does_not_release_full_day() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "first", 10))
        .await
        .unwrap();
    let s = w.uow.snapshot();
    let date = FIXED_NOW.date() + time::Duration::days(1);
    let mut m = daily_measurement(&b, date, 0, 0);
    m.measured_at = date.midnight().assume_utc() + time::Duration::hours(12);
    let (from, until) = jt_capability::period_window(jt_capability::Period::Monthly, FIXED_NOW);
    let before = occupied(
        &s.studio.reservations,
        &[m.clone()],
        None,
        Some(jt_strategy::LaneKind::Paid),
        None,
        "TRY",
        from,
        until,
        m.measured_at,
    );
    let after = occupied(
        &s.studio.reservations,
        &[m.clone()],
        None,
        Some(jt_strategy::LaneKind::Paid),
        None,
        "TRY",
        from,
        until,
        m.measured_at + time::Duration::days(1),
    );
    assert_eq!(
        before, after,
        "advancing the clock without new provider evidence must not release liability"
    );
}

#[tokio::test]
async fn applied_daily_item_resets_at_midnight() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let c = r
            .capabilities()
            .find(b.capability_id)
            .await
            .unwrap()
            .unwrap();
        let mut item = r
            .budget()
            .find_item(c.budget_item_ids[0])
            .await
            .unwrap()
            .unwrap();
        item.period = jt_capability::Period::Daily;
        item.cap = 10;
        r.budget().update_item(item).await.unwrap();
        r.commit().await.unwrap();
    }
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "first", 10))
        .await
        .unwrap();
    w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
        FIXED_NOW + time::Duration::days(1),
    ));
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    assert_eq!(
        recheck_periods(&w.d, w.f.ws).await.unwrap(),
        1,
        "new daily cap should not count yesterday's applied liability"
    );
}

#[tokio::test]
async fn rebind_preserves_brake_pause_ownership() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    assert!(w.uow.snapshot().studio.binding_controls[0].paused_by_brake);
    w.provider_status("PAUSED", 10);
    adset_bind(
        &w.d,
        &w.ctx,
        BindAdSetInput {
            hypothesis_id: b.chain.hypothesis_id,
            arm_id: b.chain.arm_id,
            capability_id: b.capability_id,
            adset_id: b.adset_id,
            request_key: "refresh".into(),
        },
    )
    .await
    .unwrap();
    assert!(
        w.uow.snapshot().studio.binding_controls[0].paused_by_brake,
        "refresh must not turn a safety pause into a manual pause"
    );
}

#[tokio::test]
async fn unchanged_intraday_spend_is_refreshed_after_bucket_close() {
    let mut w = support::world().await;
    let (b, _) = w.paid().await;
    let row = jt_app::ports::connectors::AdSetInsights {
        account_id: b.account_id.clone(),
        adset_id: b.adset_id.clone(),
        campaign_id: b.campaign_id.clone(),
        date: FIXED_NOW.date(),
        spend_minor: Some(0),
        impressions: Some(100),
        clicks: Some(10),
    };
    for at in [FIXED_NOW, FIXED_NOW + time::Duration::days(1)] {
        w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(at));
        w.provider_status("PAUSED", 10);
        w.ads.push_adset_insights(Ok(vec![row.clone()]));
        assert_eq!(
            jt_app::usecases::studio::measure::measure_due(&w.d, w.f.ws)
                .await
                .unwrap(),
            1
        );
    }
    let state = w.uow.snapshot();
    assert_eq!(state.studio.measurements.len(), 2);
    let latest = state
        .studio
        .measurements
        .iter()
        .max_by_key(|m| m.evidence_revision)
        .unwrap();
    assert_eq!(latest.evidence_revision, 1);
    assert_eq!(latest.measured_at, w.d.clock.now());
    assert_eq!(latest.raw_metrics["spend_minor"], Some(0));
}

async fn observed_overspend_with_execution_disabled(outside_hours: bool) {
    // Exercise lane and item caps independently; neither may be hidden by eligibility.
    for item_cap in [false, true] {
        let w = support::world().await;
        let (b, _) = w.paid().await;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut c = r
            .capabilities()
            .find(b.capability_id)
            .await
            .unwrap()
            .unwrap();
        if outside_hours {
            c.policy.active_hours = Some(
                serde_json::from_value(serde_json::json!({
                    "tz":"UTC", "days":[1,2,3,4,5,6,7], "from":0, "to":1
                }))
                .unwrap(),
            );
        } else {
            c.policy.daily_ops_cap = Some(0);
        }
        let mut item = r
            .budget()
            .find_item(c.budget_item_ids[0])
            .await
            .unwrap()
            .unwrap();
        item.cap = if item_cap { 50 } else { 200_000 };
        r.budget().update_item(item).await.unwrap();
        r.capabilities().update(c).await.unwrap();
        r.commit().await.unwrap();
        let spend = if item_cap { 51 } else { 100_001 };
        w.provider_status("ACTIVE", 10);
        w.ads.push_set_status(Ok(()));
        let m = daily_measurement(&b, FIXED_NOW.date(), 0, spend);
        jt_app::usecases::studio::measure::record(&w.d, m.clone())
            .await
            .unwrap();
        let state = w.uow.snapshot();
        assert_eq!(state.studio.measurements, vec![m]);
        assert!(state.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
        assert!(state.studio.binding_controls[0].confirmed_paused());
        assert!(w.ads.calls().iter().any(|call| matches!(call,
            ConnectorCall::SetAdStatus { entity_id, status: jt_app::ports::connectors::AdStatus::Paused, .. }
                if entity_id == &b.adset_id)));
        let pending = jt_app::usecases::studio::work::pending(&w.d, &w.ctx)
            .await
            .unwrap();
        assert_eq!(pending.paid_alerts.len(), 1);
        assert_eq!(pending.paid_alerts[0]["residual_provider_exposure"], false);
        assert_eq!(
            writes(&w),
            0,
            "safety pauses must never change the daily budget"
        );
    }
}

#[tokio::test]
async fn over_cap_spend_outside_work_hours_engages_brake() {
    observed_overspend_with_execution_disabled(true).await;
}

#[tokio::test]
async fn zero_daily_ops_does_not_hide_overspend() {
    observed_overspend_with_execution_disabled(false).await;
}

fn bind_input(b: &jt_studio::AdSetBinding, key: &str) -> BindAdSetInput {
    BindAdSetInput {
        hypothesis_id: b.chain.hypothesis_id,
        arm_id: b.chain.arm_id,
        capability_id: b.capability_id,
        adset_id: b.adset_id.clone(),
        request_key: key.into(),
    }
}

#[tokio::test]
async fn interrupted_bind_never_leaves_unbraked_binding() {
    let w = support::world().await;
    let (mut b, _) = w.paid().await;
    b.adset_id = "new_set".into();
    w.ads
        .push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
            account_id: b.account_id.clone(),
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "UTC".into(),
        }));
    w.ads
        .push_list_adsets(Ok(vec![jt_app::ports::connectors::AdSet {
            id: b.adset_id.clone(),
            name: "new".into(),
            status: "ACTIVE".into(),
            campaign_id: b.campaign_id.clone(),
            daily_budget_minor: Some(10),
            lifetime_budget_minor: None,
        }]));
    w.uow.fail_studio_brake(1);
    let input = bind_input(&b, "interrupted");
    let error = adset_bind(&w.d, &w.ctx, input.clone()).await.unwrap_err();
    assert!(error.message.contains("injected brake write failure"));
    let state = w.uow.snapshot();
    assert!(
        !state
            .studio
            .bindings
            .iter()
            .any(|row| row.adset_id == "new_set"),
        "a failed safety write must roll back the new binding"
    );
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        r.studio()
            .request_replay(
                "studio.adset_bind",
                "interrupted",
                &serde_json::to_value(input).unwrap()
            )
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn replay_reasserts_missing_brake() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let input = bind_input(&b, "replay-brake");
    w.provider_status("ACTIVE", 10);
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    let saved = adset_bind(&w.d, &w.ctx, input.clone()).await.unwrap();
    // Simulate a lost brake from an older committed receipt, without authorizing any spend.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let flags = r.studio_control().lock_control().await.unwrap();
    r.studio_control()
        .set_brake(flags.revision, Some(jt_strategy::LaneKind::Paid), false)
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    assert_eq!(adset_bind(&w.d, &w.ctx, input).await.unwrap(), saved);
    let state = w.uow.snapshot();
    assert!(state.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    assert!(state.studio.binding_controls[0].confirmed_paused());
    assert!(state.studio.reservations.is_empty());
}

#[tokio::test]
async fn recheck_covers_unreserved_bindings() {
    let w = support::world().await;
    w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    recheck_periods(&w.d, w.f.ws).await.unwrap();
    let state = w.uow.snapshot();
    assert!(state.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    assert!(state.studio.binding_controls[0].confirmed_paused());
    assert!(state.studio.reservations.is_empty());
    assert_eq!(
        jt_app::usecases::studio::work::pending(&w.d, &w.ctx)
            .await
            .unwrap()
            .paid_alerts
            .len(),
        1
    );
}

#[tokio::test]
async fn disabled_execution_under_cap_keeps_measurement_without_braking() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .find(b.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.policy.daily_ops_cap = Some(0);
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    let m = daily_measurement(&b, FIXED_NOW.date(), 0, 50);
    jt_app::usecases::studio::measure::record(&w.d, m.clone())
        .await
        .unwrap();
    let state = w.uow.snapshot();
    assert_eq!(state.studio.measurements, vec![m]);
    assert!(!state.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    assert!(w.ads.calls().is_empty());
}

#[tokio::test]
async fn overspend_without_write_scope_keeps_brake_and_residual_work_item() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .find(b.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.connector_public["access"]["scopes"] = serde_json::json!(["ads_read"]);
    c.policy.daily_ops_cap = Some(0);
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    let m = daily_measurement(&b, FIXED_NOW.date(), 0, 100_001);
    jt_app::usecases::studio::measure::record(&w.d, m.clone())
        .await
        .unwrap();
    let state = w.uow.snapshot();
    assert_eq!(state.studio.measurements, vec![m]);
    assert!(state.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    assert!(
        w.ads.calls().is_empty(),
        "measurement read access must not authorize a pause"
    );
    let pending = jt_app::usecases::studio::work::pending(&w.d, &w.ctx)
        .await
        .unwrap();
    assert_eq!(pending.paid_alerts.len(), 1);
    assert_eq!(pending.paid_alerts[0]["residual_provider_exposure"], true);
}

#[tokio::test]
async fn replay_does_not_accept_historical_authorization() {
    for refresh_generation in [false, true] {
        let mut w = support::world().await;
        let (b, _) = w.paid().await;
        w.provider_status("ACTIVE", 10);
        w.ads.push_set_daily_budget(Ok(()));
        budget_move(&w.d, &w.ctx, move_input(&b, "old-authorization", 10))
            .await
            .unwrap();
        let now = if refresh_generation {
            FIXED_NOW + time::Duration::seconds(1)
        } else {
            time::macros::datetime!(2026-11-01 01:00 UTC)
        };
        w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(now));
        if refresh_generation {
            let mut r = w.uow.tenant(w.f.ws).await.unwrap();
            let mut c = r
                .capabilities()
                .find(b.capability_id)
                .await
                .unwrap()
                .unwrap();
            c.last_verified_at = Some(now);
            r.capabilities().update(c).await.unwrap();
            r.commit().await.unwrap();
        }
        let input = bind_input(&b, "active-rebind");
        w.provider_status("ACTIVE", 10);
        w.provider_status("ACTIVE", 10);
        w.ads.push_set_status(Ok(()));
        let saved = adset_bind(&w.d, &w.ctx, input.clone()).await.unwrap();
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let flags = r.studio_control().lock_control().await.unwrap();
        r.studio_control()
            .set_brake(flags.revision, Some(jt_strategy::LaneKind::Paid), false)
            .await
            .unwrap();
        r.commit().await.unwrap();
        w.provider_status("ACTIVE", 10);
        w.ads.push_set_status(Ok(()));
        assert_eq!(adset_bind(&w.d, &w.ctx, input).await.unwrap(), saved);
        let state = w.uow.snapshot();
        assert!(
            state.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid),
            "historical authorization must not suppress replay recovery (refresh={refresh_generation})"
        );
        assert!(state.studio.binding_controls[0].confirmed_paused());
        assert_eq!(state.studio.reservations.len(), 1);
    }
}

#[tokio::test]
async fn replay_preserves_current_move_rollover_and_resume_authorization() {
    for mode in ["move", "rollover", "resume"] {
        let mut w = support::world().await;
        let (b, _) = w.paid().await;
        let input = bind_input(&b, "authorized-replay");
        w.provider_status("ACTIVE", 10);
        w.provider_status("ACTIVE", 10);
        w.ads.push_set_status(Ok(()));
        adset_bind(&w.d, &w.ctx, input.clone()).await.unwrap();
        if mode == "resume" {
            w.provider_status("PAUSED", 10);
            w.ads.push_set_status(Ok(()));
            w.brake(false, Some(jt_strategy::LaneKind::Paid), 1).await;
        } else {
            let mut r = w.uow.tenant(w.f.ws).await.unwrap();
            let flags = r.studio_control().lock_control().await.unwrap();
            r.studio_control()
                .set_brake(flags.revision, Some(jt_strategy::LaneKind::Paid), false)
                .await
                .unwrap();
            r.commit().await.unwrap();
            w.provider_status("ACTIVE", 10);
            w.ads.push_set_daily_budget(Ok(()));
            budget_move(&w.d, &w.ctx, move_input(&b, "current-authorization", 10))
                .await
                .unwrap();
            if mode == "rollover" {
                w.d.clock = std::sync::Arc::new(jt_testkit::fakes::FixedClock(
                    time::macros::datetime!(2026-11-01 01:00 UTC),
                ));
                assert_eq!(recheck_periods(&w.d, w.f.ws).await.unwrap(), 1);
            }
        }
        let before = w.ads.calls();
        adset_bind(&w.d, &w.ctx, input).await.unwrap();
        assert!(
            !w.uow.snapshot().studio.controls[0].is_braked(jt_strategy::LaneKind::Paid),
            "current authorization must survive receipt replay ({mode})"
        );
        assert_eq!(w.ads.calls(), before);
    }
}

#[tokio::test]
async fn external_increase_after_resume_is_detected() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(false, None, 1).await;
    let s = w.uow.snapshot();
    assert!(
        s.studio
            .moves
            .iter()
            .all(|m| m.state != BudgetMoveState::Succeeded)
    );
    let (reservation, outcome) = s.studio.reservations.last().unwrap();
    assert_eq!(reservation.request.binding_id, Some(b.id));
    assert_eq!(reservation.request.daily_budget_minor, Some(10));
    assert!(matches!(outcome, Some(SpendOutcome::Applied { .. })));
    w.provider_status("ACTIVE", 10);
    w.ads.push_adset_insights(Ok(vec![]));
    jt_app::usecases::studio::measure::measure_due(&w.d, w.f.ws)
        .await
        .unwrap();
    assert!(!w.uow.snapshot().studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    w.provider_status("ACTIVE", 200);
    w.ads.push_adset_insights(Ok(vec![]));
    w.provider_status("ACTIVE", 200);
    w.ads.push_set_status(Ok(()));
    jt_app::usecases::studio::measure::measure_due(&w.d, w.f.ws)
        .await
        .unwrap();
    let s = w.uow.snapshot();
    assert!(s.studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
    assert!(s.studio.binding_controls[0].confirmed_paused());
    let pending = jt_app::usecases::studio::work::pending(&w.d, &w.ctx)
        .await
        .unwrap();
    assert_eq!(pending.paid_alerts.len(), 1);
    assert_eq!(pending.paid_alerts[0]["residual_provider_exposure"], false);
}

#[tokio::test]
async fn latest_resume_supersedes_older_budget_move_for_drift() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_daily_budget(Ok(()));
    budget_move(&w.d, &w.ctx, move_input(&b, "old-move", 20))
        .await
        .unwrap();
    w.provider_status("ACTIVE", 20);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(false, None, 1).await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_adset_insights(Ok(vec![]));
    jt_app::usecases::studio::measure::measure_due(&w.d, w.f.ws)
        .await
        .unwrap();
    assert!(!w.uow.snapshot().studio.controls[0].is_braked(jt_strategy::LaneKind::Paid));
}
