#[path = "support/studio.rs"]
mod support;
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, studio::*},
    usecases::studio::{chain::*, control::*},
};
use jt_strategy::{LaneKind, StrategyVersionId, VersionStatus};
use jt_studio::{AdStatus, BindingStatusOutcome};
use jt_testkit::fakes::{ConnectorCall, FIXED_NOW};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Barrier;

#[tokio::test]
async fn default_policy_does_not_wait_for_human() {
    let w = support::world().await;
    let p = w.permit().await.unwrap();
    assert_eq!(p.strategy_version_id, w.current);
    assert_eq!(p.control_revision, 0);
    assert!(w.uow.snapshot().studio.approvals.is_empty());
}
#[tokio::test]
async fn lane_and_capability_approval_compose() {
    for (lane, cap) in [(false, false), (true, false), (false, true), (true, true)] {
        let w = support::world().await;
        if lane {
            w.policy(true, 0).await;
        }
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut c = r
            .capabilities()
            .lock(w.f.slot.capability_id)
            .await
            .unwrap()
            .unwrap();
        c.policy.requires_human_approval = cap;
        r.capabilities().update(c).await.unwrap();
        r.commit().await.unwrap();
        assert_eq!(w.permit().await.is_err(), lane || cap);
        w.approve().await;
        w.permit().await.unwrap();
    }
}
#[tokio::test]
async fn approval_cannot_authorize_changed_payload() {
    let w = support::world().await;
    w.policy(true, 0).await;
    w.approve().await;
    w.permit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut p = w.f.piece.clone();
    p.id = PieceId::new_v7();
    p.revision = 2;
    p.text = "changed".into();
    r.studio()
        .save_piece(w.f.slot.id, 1, p, "piece-v2")
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert!(w.permit().await.is_err());
    let mut input = w.execution();
    input.expected_revision = 2;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        authorize_execution_at(r.as_mut(), input, FIXED_NOW)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn approval_does_not_bypass_new_brake_or_cap() {
    let w = support::world().await;
    w.approve().await;
    w.brake(true, None, 0).await;
    assert_eq!(
        w.permit().await.unwrap_err().details["reason"],
        "studio_braked"
    );
    let (b, m) = w.paid().await;
    approve(
        &w.d,
        &w.ctx,
        ApprovalInput {
            target: ApprovalTarget::BudgetMove(m.id),
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    w.brake(false, None, 1).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .lock(b.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.policy.spend_cap_minor = Some(0);
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        authorize_execution_at(
            r.as_mut(),
            ExecutionInput {
                chain: m.chain,
                capability_id: b.capability_id,
                target: ApprovalTarget::BudgetMove(m.id),
                expected_revision: 1
            },
            FIXED_NOW
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::BudgetCap
    );
}
#[tokio::test]
async fn strategy_change_racing_dispatch_uses_current_frame() {
    let w = Arc::new(support::world().await);
    let barrier = Arc::new(Barrier::new(2));
    let worker = {
        let w = w.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            dispatch_execution(
                &w.d,
                w.execution(),
                |p| async move { Ok(p.strategy_version_id) },
            )
            .await
            .unwrap()
        })
    };
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut v = r.strategy().lock_execution_frame().await.unwrap().unwrap();
    let hs = r.hypotheses().list(v.id).await.unwrap();
    r.strategy()
        .set_status(v.id, VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    v.id = StrategyVersionId::new_v7();
    v.number += 1;
    r.strategy().insert(v.clone()).await.unwrap();
    for h in hs {
        r.hypotheses().upsert(v.id, h).await.unwrap();
    }
    r.commit().await.unwrap();
    barrier.wait().await;
    assert_eq!(worker.await.unwrap(), v.id);
    assert_eq!(
        w.uow.snapshot().studio.slots[0].chain.born_version_id,
        w.f.slot.chain.born_version_id
    );
}
#[tokio::test]
async fn archive_repeat_has_one_cancellation_effect() {
    let w = support::world().await;
    let (_, m) = w.paid().await;
    w.policy(true, 0).await;
    w.archive().await;
    let before = w.uow.snapshot().studio;
    let change = StrategyChange {
        previous: Some(w.current),
        current: None,
        kept: vec![],
        retired: vec![w.f.slot.chain.hypothesis_id],
        added: vec![],
        at: FIXED_NOW,
    };
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.strategy().lock_execution_frame().await.unwrap();
    w.d.transition_hook
        .apply(r.as_mut(), &change)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let after = w.uow.snapshot().studio;
    assert_eq!(before.slots, after.slots);
    assert_eq!(before.arms, after.arms);
    assert_eq!(after.slots[0].state, SlotState::Retired);
    assert_eq!(
        after.moves.iter().find(|r| r.id == m.id).unwrap().state,
        jt_studio::BudgetMoveState::Cancelled
    );
    assert!(w.permit().await.is_err());
}
#[tokio::test]
async fn retired_publications_still_measure() {
    let w = support::world().await;
    let id = w.publish_evidence().await;
    w.archive().await;
    w.brake(true, None, 0).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let p = authorize_measurement_at(r.as_mut(), HistoricalTarget::Publication(id), FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(p.chain, w.f.slot.chain);
    assert!(w.permit().await.is_err());
}
#[tokio::test]
async fn brake_stops_both_lanes_at_iteration_boundary() {
    let w = Arc::new(support::world().await);
    let (b, m) = w.paid().await;
    let entered = Arc::new(Barrier::new(3));
    let finish = Arc::new(Barrier::new(3));
    let calls = Arc::new(AtomicUsize::new(0));
    let inputs = [
        w.execution(),
        ExecutionInput {
            chain: m.chain,
            capability_id: b.capability_id,
            target: ApprovalTarget::BudgetMove(m.id),
            expected_revision: 1,
        },
    ];
    let mut workers = Vec::new();
    for input in inputs {
        let (w, entered, finish, calls) =
            (w.clone(), entered.clone(), finish.clone(), calls.clone());
        workers.push(tokio::spawn(async move {
            dispatch_execution(&w.d, input.clone(), |_| async {
                calls.fetch_add(1, Ordering::SeqCst);
                entered.wait().await;
                finish.wait().await;
                Ok(())
            })
            .await
            .unwrap();
            let second = dispatch_execution(&w.d, input, |_| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
            assert_eq!(second.unwrap_err().details["reason"], "studio_braked");
        }));
    }
    entered.wait().await;
    w.brake(true, None, 0).await;
    finish.wait().await;
    for worker in workers {
        worker.await.unwrap();
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn brake_before_provider_admission_holds_both_workers() {
    let w = Arc::new(support::world().await);
    let (b, m) = w.paid().await;
    let poised = Arc::new(Barrier::new(3));
    let admit = Arc::new(Barrier::new(3));
    let calls = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();
    for input in [
        w.execution(),
        ExecutionInput {
            chain: m.chain,
            capability_id: b.capability_id,
            target: ApprovalTarget::BudgetMove(m.id),
            expected_revision: 1,
        },
    ] {
        let (w, poised, admit, calls) = (w.clone(), poised.clone(), admit.clone(), calls.clone());
        workers.push(tokio::spawn(async move {
            poised.wait().await;
            admit.wait().await;
            assert!(
                dispatch_execution(&w.d, input, |_| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .is_err()
            );
        }));
    }
    poised.wait().await;
    w.brake(true, None, 0).await;
    admit.wait().await;
    for worker in workers {
        worker.await.unwrap();
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
}
#[tokio::test]
async fn brake_survives_restart_and_is_tenant_scoped() {
    let w = support::world().await;
    let other = jt_testkit::studio_contract::ready(&w.uow).await;
    w.brake(true, None, 0).await;
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
    let mut r = restarted.uow.tenant(other.ws).await.unwrap();
    assert!(
        !r.studio_control()
            .lock_control()
            .await
            .unwrap()
            .brake_engaged
    );
    assert!(
        r.studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .is_some()
    );
}
#[tokio::test]
async fn lane_brake_isolated_and_held_queue_resumes() {
    let w = support::world().await;
    let (b, m) = w.paid().await;
    w.brake(true, Some(LaneKind::Organic), 0).await;
    assert!(w.permit().await.is_err());
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    authorize_execution_at(
        r.as_mut(),
        ExecutionInput {
            chain: m.chain,
            capability_id: b.capability_id,
            target: ApprovalTarget::BudgetMove(m.id),
            expected_revision: 1,
        },
        FIXED_NOW,
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    let before = w.uow.snapshot().studio.slots[0].clone();
    w.brake(false, Some(LaneKind::Organic), 1).await;
    w.permit().await.unwrap();
    assert_eq!(w.uow.snapshot().studio.slots[0], before);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
}
#[tokio::test]
async fn active_meta_ads_pause_and_outcomes_persist() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    let saved = w
        .uow
        .snapshot()
        .studio
        .binding_controls
        .into_iter()
        .find(|c| c.binding_id == b.id)
        .unwrap();
    assert!(saved.confirmed_paused());
    assert!(saved.paused_by_brake);
    assert!(w.ads.calls().iter().any(|c| matches!(
        c,
        ConnectorCall::SetAdStatus {
            status: jt_app::ports::connectors::AdStatus::Paused,
            ..
        }
    )));
    assert!(
        w.uow
            .snapshot()
            .ledger
            .iter()
            .any(|e| e.entry.action.as_str() == "studio.binding_status")
    );
}
#[tokio::test]
async fn resume_rechecks_cap_and_does_not_activate_manually_paused_sets() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.provider_status("PAUSED", 10);
    w.brake(true, None, 0).await;
    w.brake(false, None, 1).await;
    assert!(
        !w.ads
            .calls()
            .iter()
            .any(|c| matches!(c, ConnectorCall::SetAdStatus { .. }))
    );
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 2).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .lock(b.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.policy.spend_cap_minor = Some(0);
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    w.provider_status("PAUSED", 10);
    w.brake(false, None, 3).await;
    assert!(!w.ads.calls().iter().any(|c| matches!(
        c,
        ConnectorCall::SetAdStatus {
            status: jt_app::ports::connectors::AdStatus::Active,
            ..
        }
    )));
    assert!(w.uow.snapshot().studio.binding_controls[0].paused_by_brake);
}
#[tokio::test]
async fn successful_release_reserves_and_resumes_only_brake_paused_sets() {
    let w = support::world().await;
    w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(false, None, 1).await;
    let state = w.uow.snapshot();
    assert_eq!(
        state.studio.binding_controls[0].observed,
        Some(AdStatus::Active)
    );
    assert!(!state.studio.binding_controls[0].paused_by_brake);
    assert_eq!(state.studio.reservations.len(), 1);
}
#[tokio::test]
async fn unknown_pause_is_durable_and_restart_reconciles_without_blind_status_write() {
    let w = support::world().await;
    w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads
        .push_set_status(Err(jt_connector::ConnectorError::unknown("response lost")));
    w.brake(true, None, 0).await;
    assert_eq!(
        w.uow.snapshot().studio.binding_controls[0].outcome,
        Some(BindingStatusOutcome::Unknown)
    );
    w.provider_status("PAUSED", 10);
    reconcile_bindings(&w.d, w.f.ws).await.unwrap();
    assert!(w.uow.snapshot().studio.binding_controls[0].confirmed_paused());
    assert_eq!(
        w.ads
            .calls()
            .iter()
            .filter(|c| matches!(c, ConnectorCall::SetAdStatus { .. }))
            .count(),
        1
    );
}
#[tokio::test]
async fn archive_then_due_measurement_records_evidence_without_execution() {
    let w = support::world().await;
    let id = w.publish_evidence().await;
    w.archive().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let permit = authorize_measurement_at(r.as_mut(), HistoricalTarget::Publication(id), FIXED_NOW)
        .await
        .unwrap();
    r.studio()
        .record_measurement(Measurement {
            id: MeasurementId::new_v7(),
            chain: permit.chain,
            evidence_key: "post/24h".into(),
            publication_id: Some(id),
            binding_id: None,
            window: MeasurementWindow::Hours24,
            evidence_revision: 0,
            scheduled_at: None,
            account_timezone: None,
            minor_unit_exponent: None,
            measured_at: FIXED_NOW + time::Duration::days(1),
            source: "x".into(),
            raw_metrics: [("impressions".into(), Some(100))].into(),
            metric_scope: "post".into(),
            date: None,
            currency: None,
            status: MeasurementStatus::Complete,
            rule_version: "v1".into(),
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(w.uow.snapshot().studio.measurements.len(), 1);
    assert!(w.permit().await.is_err());
}
#[tokio::test]
async fn historical_read_rejects_revoked_or_foreign_capability() {
    let w = support::world().await;
    let id = w.publish_evidence().await;
    let other = jt_testkit::studio_contract::fixture(&w.uow).await;
    let mut r = w.uow.tenant(other.ws).await.unwrap();
    assert_eq!(
        authorize_measurement_at(r.as_mut(), HistoricalTarget::Publication(id), FIXED_NOW)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(r);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.capabilities()
        .set_sealed(w.f.slot.capability_id, None, FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        authorize_measurement_at(r.as_mut(), HistoricalTarget::Publication(id), FIXED_NOW)
            .await
            .unwrap_err()
            .details["reason"],
        "capability_unavailable"
    );
}
#[tokio::test]
async fn historical_publication_rejects_rebound_account() {
    let w = support::world().await;
    let id = w.publish_evidence().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .lock(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.external_id = Some("other_account".into());
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        authorize_measurement_at(r.as_mut(), HistoricalTarget::Publication(id), FIXED_NOW)
            .await
            .unwrap_err()
            .details["reason"],
        "historical_account_changed"
    );
}
#[tokio::test]
async fn dispatcher_rejects_missing_registry_adapter() {
    let mut w = support::world().await;
    w.d.connectors = Arc::new(jt_testkit::fakes::ScriptedRegistry::new());
    assert!(
        dispatch_execution(&w.d, w.execution(), |_| async { Ok(()) })
            .await
            .is_err()
    );
}
#[tokio::test]
async fn execution_work_hours_resolve_iana_timezone() {
    let w = support::world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .lock(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.policy.active_hours = Some(jt_capability::Hours {
        tz: "America/New_York".into(),
        from: 4,
        to: 8,
        days: vec![4],
    });
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    w.permit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        authorize_execution_at(
            r.as_mut(),
            w.execution(),
            FIXED_NOW + time::Duration::hours(4)
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn resume_honors_revision_bound_budget_move_consent() {
    let w = support::world().await;
    let (_, m) = w.paid().await;
    policy_set(
        &w.d,
        &w.ctx,
        StudioPolicyInput {
            lane: LaneKind::Paid,
            requires_human_approval: true,
            expected_revision: 0,
        },
    )
    .await
    .unwrap();
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 1).await;
    approve(
        &w.d,
        &w.ctx,
        ApprovalInput {
            target: ApprovalTarget::BudgetMove(m.id),
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    w.provider_status("PAUSED", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(false, None, 2).await;
    assert_eq!(
        w.uow.snapshot().studio.binding_controls[0].observed,
        Some(AdStatus::Active)
    );
}

#[tokio::test]
async fn failed_pause_read_keeps_brake_and_durable_failure() {
    let w = support::world().await;
    let (b, _) = w.paid().await;
    w.ads
        .push_account_context(Err(jt_connector::ConnectorError::permanent(
            "provider unavailable",
        )));
    w.brake(true, None, 0).await;
    let s = w.uow.snapshot();
    assert!(s.studio.controls[0].brake_engaged);
    let control = s
        .studio
        .binding_controls
        .iter()
        .find(|c| c.binding_id == b.id)
        .expect("durable failure");
    assert_eq!(control.outcome, Some(BindingStatusOutcome::Failed));
    assert!(!control.paused_by_brake);
}
#[tokio::test]
async fn safety_pause_normalizes_meta_account_prefix() {
    let w = support::world().await;
    w.paid().await;
    w.ads
        .push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
            account_id: "1".into(),
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
        }));
    w.ads
        .push_list_adsets(Ok(vec![jt_app::ports::connectors::AdSet {
            id: "set_1".into(),
            name: "set".into(),
            status: "ACTIVE".into(),
            campaign_id: None,
            daily_budget_minor: Some(10),
            lifetime_budget_minor: None,
        }]));
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    assert!(
        w.uow
            .snapshot()
            .studio
            .binding_controls
            .iter()
            .any(|c| c.confirmed_paused())
    );
}
#[tokio::test]
async fn resume_recovery_reuses_reservation_after_clock_advance() {
    let mut w = support::world().await;
    w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    w.provider_status("PAUSED", 10);
    w.ads
        .push_set_status(Err(jt_connector::ConnectorError::unknown("lost response")));
    w.brake(false, None, 1).await;
    assert_eq!(w.uow.snapshot().studio.reservations.len(), 1);
    w.d.clock = Arc::new(jt_testkit::fakes::FixedClock(
        FIXED_NOW + time::Duration::days(10),
    ));
    w.provider_status("PAUSED", 10);
    w.ads.push_set_status(Ok(()));
    reconcile_bindings(&w.d, w.f.ws).await.unwrap();
    assert_eq!(w.uow.snapshot().studio.reservations.len(), 1);
    assert_eq!(
        w.uow.snapshot().studio.binding_controls[0].observed,
        Some(AdStatus::Active)
    );
}

#[tokio::test]
async fn budget_execution_refused_after_account_rebind() {
    for change in ["account", "timestamp", "probe", "unverified"] {
        let w = support::world().await;
        let (b, m) = w.paid().await;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut c = r
            .capabilities()
            .lock(b.capability_id)
            .await
            .unwrap()
            .unwrap();
        match change {
            "account" => c.external_id = Some("act_2".into()),
            "timestamp" => c.last_verified_at = Some(FIXED_NOW + time::Duration::seconds(1)),
            "unverified" => {
                c.status = jt_capability::StoredStatus::Declared;
                c.last_verified_at = None;
            }
            _ => {
                c.evidence = Some(jt_capability::Evidence {
                    text: "probe".into(),
                    refs: vec!["new-probe-generation".into()],
                })
            }
        }
        r.capabilities().update(c).await.unwrap();
        r.commit().await.unwrap();
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let err = authorize_execution_at(
            r.as_mut(),
            ExecutionInput {
                chain: m.chain,
                capability_id: b.capability_id,
                target: ApprovalTarget::BudgetMove(m.id),
                expected_revision: 1,
            },
            FIXED_NOW + time::Duration::seconds(2),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(err.details["reason"], "binding_stale");
        drop(r);
        let pending = jt_app::usecases::studio::work::pending(&w.d, &w.ctx)
            .await
            .unwrap();
        assert!(
            pending
                .blockers
                .iter()
                .any(|x| x.target == ApprovalTarget::BudgetMove(m.id)
                    && x.reason == "binding_stale"
                    && x.next_action.as_deref() == Some("rebind_adset"))
        );
        let work = jt_app::usecases::work::pending(&w.d, &w.ctx).await.unwrap();
        assert!(work.items.iter().any(|item| matches!(item.kind, jt_app::usecases::work::WorkKind::StudioBudgetMove { budget_move_id } if budget_move_id == m.id) && item.hint.contains("Rebind the ad set")));
    }
}

#[tokio::test]
async fn resume_reservation_stable_across_control_revisions() {
    let w = support::world().await;
    w.paid().await;
    w.provider_status("ACTIVE", 10);
    w.ads.push_set_status(Ok(()));
    w.brake(true, None, 0).await;
    w.provider_status("PAUSED", 10);
    w.ads
        .push_set_status(Err(jt_connector::ConnectorError::unknown("lost")));
    w.brake(false, None, 1).await;
    let original = w.uow.snapshot().studio.reservations[0].0.clone();
    w.policy(true, 2).await;
    w.provider_status("PAUSED", 10);
    w.ads.push_set_status(Ok(()));
    reconcile_bindings(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.studio.reservations.len(), 1);
    assert_eq!(s.studio.reservations[0].0, original);
    assert_eq!(
        s.studio.binding_controls[0].observed,
        Some(AdStatus::Active)
    );
}

#[tokio::test]
async fn liability_uses_each_item_period() {
    for (period, cap) in [
        (jt_capability::Period::Daily, 10),
        (jt_capability::Period::Monthly, 100),
        (jt_capability::Period::Total, 100),
    ] {
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
            .lock_item(c.budget_item_ids[0])
            .await
            .unwrap()
            .unwrap();
        item.period = period;
        item.cap = cap;
        r.budget().update_item(item).await.unwrap();
        r.commit().await.unwrap();
        w.provider_status("ACTIVE", 10);
        w.ads.push_set_status(Ok(()));
        w.brake(true, None, 0).await;
        w.provider_status("PAUSED", 10);
        w.ads.push_set_status(Ok(()));
        w.brake(false, None, 1).await;
        let s = w.uow.snapshot();
        assert_eq!(
            s.studio.binding_controls[0].observed,
            Some(AdStatus::Active),
            "{period:?}"
        );
        assert_eq!(s.studio.reservations.len(), 1);
    }
}
