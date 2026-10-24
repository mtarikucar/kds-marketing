#[path = "support/studio.rs"]
mod support;
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, studio::SlotQuery},
    usecases::{
        jobs::Job,
        studio::{planner, trends, work},
    },
};
use jt_strategy::{HypothesisInput, LaneKind};
use jt_studio::SlotState;
use support::*;
use time::{Duration, macros::datetime};

#[tokio::test]
async fn same_and_overlapping_plan_runs_do_not_duplicate_slots() {
    let w = world().await;
    let now = datetime!(2026-10-25 21:00 UTC);
    assert_eq!(planner::plan(&w.d, w.f.ws, now).await.unwrap(), 7);
    assert_eq!(planner::plan(&w.d, w.f.ws, now).await.unwrap(), 0);
    assert_eq!(
        planner::plan(&w.d, w.f.ws, now + Duration::hours(1))
            .await
            .unwrap(),
        1
    );
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let s = r
        .studio()
        .list_slots(SlotQuery {
            from: now,
            until: now + Duration::days(7),
            hypothesis_id: None,
            lane: None,
        })
        .await
        .unwrap();
    assert_eq!(s.len(), 7);
    assert_eq!(
        s.iter()
            .map(|s| s.id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        7
    );
}
#[tokio::test]
async fn istanbul_monday_and_week_end_retirement() {
    let w = world().await;
    let sunday = datetime!(2026-10-25 20:59:59 UTC);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut old = w.f.slot.clone();
    old.id = jt_studio::SlotId::new_v7();
    old.state = SlotState::Planned;
    old.revision = 0;
    r.studio()
        .insert_slots("old", vec![old.clone()])
        .await
        .unwrap();
    r.commit().await.unwrap();
    planner::plan(&w.d, w.f.ws, sunday).await.unwrap();
    assert_eq!(
        w.uow
            .snapshot()
            .studio
            .slots
            .iter()
            .find(|s| s.id == old.id)
            .unwrap()
            .state,
        SlotState::Planned
    );
    planner::plan(&w.d, w.f.ws, sunday + Duration::seconds(1))
        .await
        .unwrap();
    let state = w.uow.snapshot();
    assert_eq!(
        state
            .studio
            .slots
            .iter()
            .find(|s| s.id == old.id)
            .unwrap()
            .state,
        SlotState::Retired
    );
    assert_eq!(
        state
            .studio
            .slots
            .iter()
            .find(|s| s.id == w.f.slot.id)
            .unwrap()
            .state,
        SlotState::Ready
    );
}
#[tokio::test]
async fn trend_recording_does_not_change_selection() {
    let w = world().await;
    let input = trends::TrendInput {
        hypothesis_id: w.f.slot.chain.hypothesis_id,
        channel: "x".into(),
        summary: "Agent observation".into(),
        source_url: None,
        observed_at: w.ctx.now,
        request_key: "trend-1".into(),
    };
    let before = w.uow.snapshot().studio.arms;
    let t = trends::trend_record(&w.d, &w.ctx, input.clone())
        .await
        .unwrap();
    assert_eq!(
        trends::trend_record(&w.d, &w.ctx, input.clone())
            .await
            .unwrap(),
        t
    );
    assert_eq!(w.uow.snapshot().studio.arms, before);
    assert_eq!(w.uow.snapshot().studio.trends.len(), 1);
    let mut changed = input;
    changed.summary = "different".into();
    assert_eq!(
        trends::trend_record(&w.d, &w.ctx, changed)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}
fn proposal(title: &str) -> HypothesisInput {
    HypothesisInput {
        title: title.into(),
        channel: "x".into(),
        metric: "clicks".into(),
        ..Default::default()
    }
}
#[tokio::test]
async fn proposal_enters_draft_not_active_strategy() {
    let w = world().await;
    let out = trends::hypothesis_propose(&w.d, &w.ctx, proposal("new"))
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.strategy().current_approved().await.unwrap().unwrap().id,
        w.current
    );
    assert!(
        !r.hypotheses()
            .list(w.current)
            .await
            .unwrap()
            .iter()
            .any(|h| h.id == out.hypothesis_id)
    );
    assert!(
        r.hypotheses()
            .list(out.draft_version_id)
            .await
            .unwrap()
            .iter()
            .any(|h| h.id == out.hypothesis_id)
    );
}
#[tokio::test]
async fn proposal_preserves_existing_and_draft_hypotheses() {
    let w = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.hypotheses()
        .set_derived_confidence(w.f.slot.chain.hypothesis_id, 0.8, "observed")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let a = trends::hypothesis_propose(&w.d, &w.ctx, proposal("a"))
        .await
        .unwrap();
    let b = trends::hypothesis_propose(&w.d, &w.ctx, proposal("b"))
        .await
        .unwrap();
    assert_eq!(a.draft_version_id, b.draft_version_id);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let h = r.hypotheses().list(a.draft_version_id).await.unwrap();
    assert_eq!(h.len(), 3);
    assert!(h.iter().any(|h| h.id == a.hypothesis_id));
    assert_eq!(
        h.iter()
            .find(|h| h.id == w.f.slot.chain.hypothesis_id)
            .unwrap()
            .derived_confidence,
        Some(0.8)
    );
}
#[tokio::test]
async fn concurrent_proposals_append_both_under_draft_lock() {
    let w = world().await;
    let (a, b) = tokio::join!(
        trends::hypothesis_propose(&w.d, &w.ctx, proposal("a")),
        trends::hypothesis_propose(&w.d, &w.ctx, proposal("b"))
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.hypothesis_id, b.hypothesis_id);
    assert_eq!(a.draft_version_id, b.draft_version_id);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.hypotheses().list(a.draft_version_id).await.unwrap().len(),
        3
    );
}
#[tokio::test]
async fn pending_context_has_brand_rules_and_learning() {
    let w = world().await;
    w.policy(true, 0).await;
    let out = work::slot_get(&w.d, &w.ctx, w.f.slot.id).await.unwrap();
    assert_eq!(out.slot.id, w.f.slot.id);
    assert!(out.piece.is_some());
    assert_eq!(out.learned.id, w.f.slot.chain.arm_id);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let v = r.strategy().find(w.current).await.unwrap().unwrap();
    drop(r);
    assert_eq!(out.brand_rules.identity, v.sections.identity);
    assert_eq!(out.brand_rules.prohibitions, v.sections.prohibitions);
    assert_eq!(
        work::pending(&w.d, &w.ctx).await.unwrap().approvals.len(),
        1
    );
    w.approve().await;
    assert!(
        work::pending(&w.d, &w.ctx)
            .await
            .unwrap()
            .approvals
            .is_empty()
    );
}
#[tokio::test]
async fn planner_runs_hourly() {
    let w = world().await;
    let now = datetime!(2026-10-25 21:00 UTC);
    assert_eq!(Job::StudioPlan.lock_name(), "jeeta.jobs.studio_plan");
    let report = Job::StudioPlan.run(&w.d, now).await;
    assert_eq!(report.failed, 0);
    assert_eq!(report.changed, 7);
    assert_eq!(
        Job::StudioPlan
            .run(&w.d, now + Duration::hours(1))
            .await
            .changed,
        1
    );
}
#[tokio::test]
async fn cancellation_is_revision_bound_and_ledgered() {
    let w = world().await;
    let c = work::CancelSlotInput {
        slot_id: w.f.slot.id,
        expected_revision: 1,
        reason: "changed priorities".into(),
    };
    let out = work::slot_cancel(&w.d, &w.ctx, c.clone()).await.unwrap();
    assert_eq!(out.slot.state, SlotState::Retired);
    assert!(out.piece.is_some());
    assert_eq!(
        work::slot_cancel(&w.d, &w.ctx, c).await.unwrap_err().code,
        ErrorCode::Conflict
    );
}
#[tokio::test]
async fn work_rows_require_permissions_and_current_strategy() {
    let w = world().await;
    let mut ctx = w.ctx.clone();
    ctx.permissions.remove(&jt_tenancy::Permission::StudioWork);
    assert_eq!(
        work::pending(&w.d, &ctx).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    ctx = w.ctx.clone();
    ctx.permissions.remove(&jt_tenancy::Permission::TeamManage);
    assert_eq!(
        trends::hypothesis_propose(&w.d, &ctx, proposal("a"))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    w.archive().await;
    assert_eq!(
        work::pending(&w.d, &w.ctx).await.unwrap_err().code,
        ErrorCode::StrategyRequired
    );
}
#[tokio::test]
async fn planning_stops_on_brake_and_unselected_accounts() {
    let w = world().await;
    w.brake(true, Some(LaneKind::Organic), 0).await;
    assert_eq!(planner::plan(&w.d, w.f.ws, w.ctx.now).await.unwrap(), 0);
}
