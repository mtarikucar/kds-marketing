//! The same behavioral contracts run against PostgreSQL and the transactional fake.
use crate::fakes::FIXED_NOW;
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, UserRow, studio::*},
};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_ledger::Actor;
use jt_strategy::{
    Hypothesis, HypothesisId, HypothesisState, LaneKind, Sections, StrategyVersion,
    StrategyVersionId, VersionStatus,
};
use jt_tenancy::{Email, UserId, WorkspaceId, WorkspaceStatus};
use time::{Duration, OffsetDateTime};

pub struct Fixture {
    pub ws: WorkspaceId,
    pub arm: Arm,
    pub slot: Slot,
    pub piece: Piece,
}
pub async fn fixture(uow: &dyn UnitOfWork) -> Fixture {
    let ws = WorkspaceId::new_v7();
    let user = UserId::new_v7();
    let mut tx = uow.user().await.unwrap();
    tx.users()
        .insert(UserRow {
            id: user,
            email: Email::parse(&format!("{user}@studio.test")).unwrap(),
            password_hash: "test".into(),
            display_name: "test".into(),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    tx.workspaces_create(
        ws,
        "studio",
        &ws.to_string(),
        WorkspaceStatus::Active,
        FIXED_NOW,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let v = StrategyVersion {
        id: StrategyVersionId::new_v7(),
        workspace_id: ws,
        number: 1,
        status: VersionStatus::Approved,
        sections: Sections {
            budget_frame: jt_strategy::BudgetFrame {
                lanes: vec![jt_strategy::Lane {
                    lane: LaneKind::Organic,
                    period: jt_strategy::Period::Monthly,
                    cap_minor: 100,
                    currency: "TRY".into(),
                }],
            },
            ..Sections::default()
        },
        created_at: FIXED_NOW,
        created_by: Actor::Human { user_id: user },
        submitted_at: None,
        approved_at: Some(FIXED_NOW),
        approved_by: Some(user),
        archived_at: None,
    };
    let h = Hypothesis {
        id: HypothesisId::new_v7(),
        title: "test".into(),
        segment_key: "all".into(),
        angle: "help".into(),
        channel: "x".into(),
        metric: "reply".into(),
        prior_confidence: 0.7,
        derived_confidence: None,
        cadence: Default::default(),
        state: HypothesisState::Kept,
    };
    let cap = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "x".into(),
            key_detail: None,
            name: "studio x".into(),
            description: String::new(),
            external_id: Some("account".into()),
            connector_public: serde_json::json!({}),
            policy: Default::default(),
        },
        FIXED_NOW,
    )
    .unwrap();
    let arm = Arm::new(
        ArmId::new_v7(),
        ws,
        ArmKey {
            hypothesis_id: h.id,
            content_type: "text".into(),
            channel: "x".into(),
            lane: LaneKind::Organic,
        },
    )
    .unwrap();
    let slot = Slot {
        id: SlotId::new_v7(),
        chain: Chain {
            workspace_id: ws,
            born_version_id: v.id,
            hypothesis_id: h.id,
            arm_id: arm.id,
        },
        capability_id: cap.id,
        scheduled_at: FIXED_NOW,
        state: SlotState::Planned,
        revision: 0,
    };
    let piece = Piece {
        id: PieceId::new_v7(),
        chain: slot.chain.clone(),
        revision: 1,
        text: "hello".into(),
        media: vec![],
        adaptations: Default::default(),
    };
    let mut tx = uow.tenant(ws).await.unwrap();
    tx.strategy().insert(v.clone()).await.unwrap();
    tx.hypotheses().upsert(v.id, h).await.unwrap();
    tx.capabilities().insert(cap, None).await.unwrap();
    tx.commit().await.unwrap();
    Fixture {
        ws,
        arm,
        slot,
        piece,
    }
}
pub async fn seed(uow: &dyn UnitOfWork) -> Fixture {
    let f = fixture(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio().insert_arm(f.arm.clone()).await.unwrap();
    tx.studio()
        .insert_slots("hypothesis/organic/2030-01-07", vec![f.slot.clone()])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    f
}
pub async fn ready(uow: &dyn UnitOfWork) -> Fixture {
    let f = seed(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio()
        .save_piece(f.slot.id, 0, f.piece.clone(), "piece-1")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    f
}
pub async fn request_key_payload_mismatch_conflicts(uow: &dyn UnitOfWork) {
    let f = seed(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let first = tx
        .studio()
        .save_piece(f.slot.id, 0, f.piece.clone(), "piece-1")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio()
            .save_piece(f.slot.id, 0, f.piece.clone(), "piece-1")
            .await
            .unwrap(),
        first
    );
    tx.commit().await.unwrap();
    let mut changed = f.piece;
    changed.text = "different".into();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio()
            .save_piece(f.slot.id, 0, changed, "piece-1")
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}
pub async fn studio_transaction_rollback_preserves_unstarted_claim(uow: &dyn UnitOfWork) {
    let f = ready(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .is_some()
    );
    drop(tx);
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let attempt = tx
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(attempt.slot_id(), f.slot.id);
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio()
            .claim_publication(FIXED_NOW + Duration::days(30))
            .await
            .unwrap()
            .is_none()
    );
}
pub async fn arm_identity_survives_version_change(uow: &dyn UnitOfWork) {
    let f = seed(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut next = tx
        .strategy()
        .find(f.slot.chain.born_version_id)
        .await
        .unwrap()
        .unwrap();
    let hypothesis = tx.hypotheses().list(next.id).await.unwrap().remove(0);
    tx.strategy()
        .set_status(next.id, VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    next.id = StrategyVersionId::new_v7();
    next.number = 2;
    tx.strategy().insert(next.clone()).await.unwrap();
    tx.hypotheses().upsert(next.id, hypothesis).await.unwrap();
    let mut again = f.arm.clone();
    again.id = ArmId::new_v7();
    assert_eq!(tx.studio().insert_arm(again).await.unwrap(), f.arm);
    let rows = tx
        .studio()
        .list_slots(SlotQuery {
            from: FIXED_NOW,
            until: FIXED_NOW + Duration::seconds(1),
            hypothesis_id: Some(f.arm.key.hypothesis_id),
            lane: Some(LaneKind::Organic),
        })
        .await
        .unwrap();
    assert_eq!(rows, vec![f.slot.clone()]);
    assert!(
        tx.studio()
            .list_slots(SlotQuery {
                from: OffsetDateTime::UNIX_EPOCH,
                until: FIXED_NOW,
                hypothesis_id: None,
                lane: None
            })
            .await
            .unwrap()
            .is_empty()
    );
}
pub async fn concurrent_claim_has_one_owner(uow: &dyn UnitOfWork) {
    let f = ready(uow).await;
    let claim = || async {
        let mut tx = uow.tenant(f.ws).await.unwrap();
        let a = tx.studio().claim_publication(FIXED_NOW).await.unwrap();
        tx.commit().await.unwrap();
        a
    };
    let (a, b) = tokio::join!(claim(), claim());
    assert_eq!(usize::from(a.is_some()) + usize::from(b.is_some()), 1);
}
pub async fn measurement_and_learning_dedupe(uow: &dyn UnitOfWork) {
    let f = seed(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let binding = AdSetBinding {
        verified_at: None,
        verification_evidence: None,
        id: AdSetBindingId::new_v7(),
        chain: f.slot.chain.clone(),
        capability_id: f.slot.capability_id,
        account_id: "external-account".into(),
        adset_id: "external-set".into(),
        campaign_id: Some("shared-campaign".into()),
    };
    tx.studio()
        .bind_adset(binding.clone(), "binding")
        .await
        .unwrap();
    assert_eq!(
        tx.studio()
            .bind_adset(binding.clone(), "binding")
            .await
            .unwrap(),
        binding
    );
    let mut m = Measurement {
        id: MeasurementId::new_v7(),
        chain: f.slot.chain.clone(),
        evidence_key: "set/day/rev1".into(),
        publication_id: None,
        binding_id: Some(binding.id),
        window: MeasurementWindow::Hours24,
        evidence_revision: 0,
        scheduled_at: None,
        account_timezone: None,
        minor_unit_exponent: None,
        measured_at: FIXED_NOW,
        source: "meta".into(),
        raw_metrics: Default::default(),
        metric_scope: "adset".into(),
        date: Some(FIXED_NOW.date()),
        currency: Some("TRY".into()),
        status: MeasurementStatus::Failed,
        failure: None,
        rule_version: "1".into(),
    };
    assert!(tx.studio().record_measurement(m.clone()).await.unwrap());
    tx.commit().await.unwrap();
    let u = LearningUpdate {
        chain: f.slot.chain.clone(),
        evidence_key: m.evidence_key.clone(),
        alpha_delta: 0.5,
        beta_delta: 0.5,
        weight_delta: 0.1,
        derived_confidence: 0.6,
    };
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio()
            .apply_learning(u.clone())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(tx);
    m.status = MeasurementStatus::Complete;
    m.raw_metrics.insert("clicks".into(), Some(2));
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(tx.studio().record_measurement(m.clone()).await.unwrap());
    assert!(!tx.studio().record_measurement(m.clone()).await.unwrap());
    assert!(tx.studio().apply_learning(u.clone()).await.unwrap());
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(!tx.studio().apply_learning(u).await.unwrap());
    let arm = tx.studio().insert_arm(f.arm.clone()).await.unwrap();
    assert_eq!((arm.alpha, arm.beta, arm.weight), (1.5, 1.5, 0.6));
    let h = tx
        .hypotheses()
        .list(f.slot.chain.born_version_id)
        .await
        .unwrap();
    assert_eq!(h[0].derived_confidence, Some(0.6));
    assert_eq!(h[0].prior_confidence, 0.7);
}
pub async fn files_trends_moves_and_retirement_round_trip(uow: &dyn UnitOfWork) {
    let f = seed(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let file = jt_app::ports::files::StoredFile {
        id: FileId::new_v7(),
        workspace_id: f.ws,
        mime: "image/png".into(),
        filename: "asset.png".into(),
        sha256: "a".repeat(64),
        created_at: FIXED_NOW,
        cleanup_due_at: None,
        deleted_at: None,
        size_bytes: 4,
    };
    tx.studio().save_file(file.clone()).await.unwrap();
    assert_eq!(
        tx.studio().get_file(file.id).await.unwrap(),
        Some(file.clone())
    );
    let trend = TrendSignal {
        id: TrendSignalId::new_v7(),
        workspace_id: f.ws,
        born_version_id: f.slot.chain.born_version_id,
        hypothesis_id: f.slot.chain.hypothesis_id,
        channel: "x".into(),
        summary: "agent observation".into(),
        source_url: None,
        observed_at: FIXED_NOW,
        actor: Actor::System {
            component: "test".into(),
        },
    };
    assert_eq!(
        tx.studio()
            .save_trend(trend.clone(), "trend")
            .await
            .unwrap(),
        trend
    );
    assert_eq!(
        tx.studio()
            .save_trend(trend.clone(), "trend")
            .await
            .unwrap(),
        trend
    );
    let b = AdSetBinding {
        verified_at: None,
        verification_evidence: None,
        id: AdSetBindingId::new_v7(),
        chain: f.slot.chain.clone(),
        capability_id: f.slot.capability_id,
        account_id: "account".into(),
        adset_id: "set".into(),
        campaign_id: None,
    };
    tx.studio().bind_adset(b.clone(), "binding").await.unwrap();
    let m = BudgetMove {
        binding_verified_at: None,
        binding_verification_evidence: None,
        id: BudgetMoveId::new_v7(),
        chain: f.slot.chain.clone(),
        binding_id: b.id,
        revision: 1,
        daily_budget_minor: 50,
        currency: "TRY".into(),
        state: jt_studio::BudgetMoveState::Queued,
        approval: None,
        reservation_id: None,
        executed_version_id: None,
    };
    assert_eq!(
        tx.studio()
            .save_budget_move(m.clone(), "move")
            .await
            .unwrap(),
        m
    );
    assert_eq!(
        tx.studio()
            .save_budget_move(m.clone(), "move")
            .await
            .unwrap(),
        m
    );
    let retired = tx
        .studio()
        .retire_slot(f.slot.id, 0, "cancelled")
        .await
        .unwrap();
    assert_eq!(retired.state, SlotState::Retired);
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(tx.studio().get_file(file.id).await.unwrap(), Some(file));
    assert!(
        tx.studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .is_none()
    );
}
pub async fn accepted_publish_response_lost_never_blindly_retries(uow: &dyn UnitOfWork) {
    let f = ready(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let a = tx
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Unknown(jt_app::error::AppError::internal(
                "secret-token provider diagnostic",
            )),
            FIXED_NOW,
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio()
            .claim_publication(FIXED_NOW + Duration::days(1))
            .await
            .unwrap()
            .is_none()
    );
    let receipt = jt_app::ports::connectors::PublishReceipt {
        external_id: "post".into(),
        url: None,
    };
    tx.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Succeeded(receipt.clone()),
            FIXED_NOW,
        )
        .await
        .unwrap();
    tx.studio()
        .finish_publication(a.id(), PublishOutcome::Succeeded(receipt), FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(
        tx.studio()
            .get_slot(f.slot.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        SlotState::Published
    );
    tx.commit().await.unwrap();
}
pub async fn budget_price_and_hypothesis_fields_round_trip(uow: &dyn UnitOfWork) {
    let f = fixture(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut h = tx
        .hypotheses()
        .list(f.slot.chain.born_version_id)
        .await
        .unwrap()
        .remove(0);
    h.cadence=serde_json::from_value(serde_json::json!({"organic":{"slots_per_week":7,"content_types":[{"key":"text","min_bps":0,"max_bps":10000}]}})).unwrap();
    tx.hypotheses()
        .upsert(f.slot.chain.born_version_id, h.clone())
        .await
        .unwrap();
    let mut b = jt_capability::BudgetItem {
        id: jt_capability::BudgetItemId::new_v7(),
        workspace_id: f.ws,
        name: "priced".into(),
        kind: jt_capability::BudgetKind::SmsBudget,
        unit: jt_capability::Unit::Currency("TRY".into()),
        cap: 100,
        unit_cost_minor: Some(3),
        period: jt_capability::Period::Monthly,
        strategy_version_id: Some(f.slot.chain.born_version_id.0),
        created_at: FIXED_NOW,
        retired_at: None,
    };
    tx.budget().insert_item(b.clone()).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(tx.budget().find_item(b.id).await.unwrap(), Some(b.clone()));
    assert_eq!(
        tx.hypotheses()
            .list(f.slot.chain.born_version_id)
            .await
            .unwrap(),
        vec![h]
    );
    b.unit_cost_minor = None;
    tx.budget().update_item(b.clone()).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.budget()
            .find_item(b.id)
            .await
            .unwrap()
            .unwrap()
            .unit_cost_minor,
        None
    );
}
pub async fn preopened_claim_uses_current_strategy(uow: &dyn UnitOfWork) {
    let f = ready(uow).await;
    let mut stale = uow.tenant(f.ws).await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut v = tx
        .strategy()
        .find(f.slot.chain.born_version_id)
        .await
        .unwrap()
        .unwrap();
    let h = tx.hypotheses().list(v.id).await.unwrap().remove(0);
    tx.strategy()
        .set_status(v.id, VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    v.id = StrategyVersionId::new_v7();
    v.number = 2;
    tx.strategy().insert(v.clone()).await.unwrap();
    tx.hypotheses().upsert(v.id, h).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        stale
            .studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .unwrap()
            .executed_version_id(),
        v.id
    );
}
pub async fn budget_fixture(
    uow: &dyn UnitOfWork,
) -> (Fixture, jt_capability::BudgetItem, ReserveSpend) {
    let f = fixture(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let b = jt_capability::BudgetItem {
        id: jt_capability::BudgetItemId::new_v7(),
        workspace_id: f.ws,
        name: "cap".into(),
        kind: jt_capability::BudgetKind::Cash,
        unit: jt_capability::Unit::Currency("TRY".into()),
        cap: 100,
        unit_cost_minor: Some(1),
        period: jt_capability::Period::Monthly,
        strategy_version_id: Some(f.slot.chain.born_version_id.0),
        created_at: FIXED_NOW,
        retired_at: None,
    };
    tx.budget().insert_item(b.clone()).await.unwrap();
    tx.budget().link(f.slot.capability_id, b.id).await.unwrap();
    tx.commit().await.unwrap();
    let r = ReserveSpend {
        binding_id: None,
        chain: None,
        replaces: None,
        daily_budget_minor: None,
        workspace_id: f.ws,
        capability_id: f.slot.capability_id,
        budget_item_ids: vec![b.id],
        lane: LaneKind::Organic,
        executed_version_id: f.slot.chain.born_version_id,
        amount_minor: 60,
        currency: "TRY".into(),
        evidence_key: "reserve1".into(),
        at: FIXED_NOW,
    };
    (f, b, r)
}
pub async fn reservations_are_atomic_and_settlement_is_idempotent(uow: &dyn UnitOfWork) {
    let (f, _, r) = budget_fixture(uow).await;
    let reserve = |key: &str| {
        let mut r = r.clone();
        r.evidence_key = key.into();
        async move {
            let mut tx = uow.tenant(f.ws).await.unwrap();
            let result = tx.studio_budget().reserve(r).await;
            if result.is_ok() {
                tx.commit().await.unwrap();
            }
            result
        }
    };
    let (a, b) = tokio::join!(reserve("a"), reserve("b"));
    let (saved, err) = match (a, b) {
        (Ok(saved), Err(err)) | (Err(err), Ok(saved)) => (saved, err),
        other => panic!("exactly one reservation must succeed: {other:?}"),
    };
    assert_eq!(err.code, ErrorCode::BudgetCap);
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_budget()
            .reserve(saved.request.clone())
            .await
            .unwrap(),
        saved
    );
    tx.studio_budget()
        .settle(saved.id, SpendOutcome::Unknown)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let outcome = SpendOutcome::Settled {
        actual_minor: 30,
        evidence_key: "actual1".into(),
    };
    tx.studio_budget()
        .settle(saved.id, outcome.clone())
        .await
        .unwrap();
    tx.studio_budget().settle(saved.id, outcome).await.unwrap();
    tx.commit().await.unwrap();
    let mut next = r;
    next.amount_minor = 70;
    next.evidence_key = "remaining".into();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio_budget().reserve(next).await.unwrap();
    tx.commit().await.unwrap();
}
pub async fn preopened_reservation_reads_current_cap(uow: &dyn UnitOfWork) {
    let (f, mut b, r) = budget_fixture(uow).await;
    let mut stale = uow.tenant(f.ws).await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    b.cap = 20;
    tx.budget().update_item(b).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        stale.studio_budget().reserve(r).await.unwrap_err().code,
        ErrorCode::BudgetCap
    );
}
pub async fn agent_inherits_issuer_scope_rep_has_no_studio_grants(
    uow: std::sync::Arc<dyn UnitOfWork>,
) {
    use jt_app::usecases::{api_keys, auth};
    use jt_tenancy::{Permission, SystemRole};
    let deps = crate::fakes::deps(uow.clone());
    let session = auth::register(
        &deps,
        auth::RegisterInput {
            email: "studio-owner@example.test".into(),
            password: "test password long".into(),
            display_name: "Owner".into(),
            workspace_name: "Studio".into(),
        },
    )
    .await
    .unwrap();
    let principal = auth::resolve_session(&deps, &session.token).await.unwrap();
    let ws = principal.current_workspace.unwrap();
    crate::flows::activate_workspace(&deps, ws).await;
    let ctx = jt_app::ctx::Ctx {
        workspace_id: ws,
        actor: Actor::Human {
            user_id: principal.user_id,
        },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let key = api_keys::create(
        &deps,
        &ctx,
        api_keys::CreateKey {
            name: "studio agent".into(),
            scopes: vec!["studio.work".into(), "studio.manage".into()],
        },
    )
    .await
    .unwrap();
    let p = api_keys::authenticate(&deps, &key.plaintext).await.unwrap();
    assert_eq!(
        p.permissions,
        std::collections::BTreeSet::from([Permission::StudioWork, Permission::StudioManage])
    );
    let mut tx = uow.tenant(ws).await.unwrap();
    let rep = tx.roles().find_by_key("rep").await.unwrap().unwrap();
    assert!(!rep.permissions.contains(&Permission::StudioWork));
    assert!(!rep.permissions.contains(&Permission::StudioManage));
    let member = tx
        .memberships()
        .find_by_user(principal.user_id)
        .await
        .unwrap()
        .unwrap();
    tx.memberships().set_role(member.id, rep.id).await.unwrap();
    tx.commit().await.unwrap();
    let p = api_keys::authenticate(&deps, &key.plaintext).await.unwrap();
    assert!(p.permissions.is_empty());
}

/// T3 metadata and lifecycle contracts run against the real RLS adapter and the fake.
pub async fn controls_approval_and_transition_are_atomic(uow: &dyn UnitOfWork) {
    let f = ready(uow).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    let v = r.strategy().lock_execution_frame().await.unwrap().unwrap();
    let c = r
        .studio_control()
        .set_policy(0, LaneKind::Organic, true)
        .await
        .unwrap();
    assert_eq!(c.revision, 1);
    let approval = ApprovalReceipt {
        revision: 1,
        by: v.approved_by.unwrap(),
        at: FIXED_NOW,
    };
    r.studio()
        .approve_target(ApprovalTarget::Slot(f.slot.id), approval.clone())
        .await
        .unwrap();
    assert_eq!(
        r.studio()
            .get_approval(ApprovalTarget::Slot(f.slot.id), 1)
            .await
            .unwrap(),
        Some(approval.clone())
    );
    r.commit().await.unwrap();
    let b = AdSetBinding {
        verified_at: None,
        verification_evidence: None,
        id: AdSetBindingId::new_v7(),
        chain: f.slot.chain.clone(),
        capability_id: f.slot.capability_id,
        account_id: "account".into(),
        adset_id: "set".into(),
        campaign_id: None,
    };
    let m = BudgetMove {
        binding_verified_at: None,
        binding_verification_evidence: None,
        id: BudgetMoveId::new_v7(),
        chain: b.chain.clone(),
        binding_id: b.id,
        revision: 1,
        daily_budget_minor: 1,
        currency: "TRY".into(),
        state: jt_studio::BudgetMoveState::Queued,
        approval: None,
        reservation_id: None,
        executed_version_id: None,
    };
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.studio()
        .bind_adset(b.clone(), "control-binding")
        .await
        .unwrap();
    r.studio()
        .save_budget_move(m.clone(), "control-move")
        .await
        .unwrap();
    r.studio()
        .approve_target(ApprovalTarget::BudgetMove(m.id), approval.clone())
        .await
        .unwrap();
    let control = BindingControl {
        resume_operation_id: None,
        binding_id: b.id,
        chain: b.chain.clone(),
        desired: jt_studio::AdStatus::Paused,
        observed: None,
        paused_by_brake: true,
        outcome: Some(jt_studio::BindingStatusOutcome::Unknown),
        at: FIXED_NOW,
    };
    r.studio_control()
        .save_binding_control(control.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.studio_control().binding_control(b.id).await.unwrap(),
        Some(control)
    );
    assert_eq!(r.studio().get_binding(b.id).await.unwrap(), Some(b.clone()));
    assert_eq!(r.studio().list_bindings().await.unwrap(), vec![b]);
    assert_eq!(
        r.studio()
            .get_budget_move(m.id)
            .await
            .unwrap()
            .unwrap()
            .approval,
        Some(approval)
    );
    let change = StrategyChange {
        previous: Some(v.id),
        current: None,
        kept: vec![],
        retired: vec![f.slot.chain.hypothesis_id],
        added: vec![],
        at: FIXED_NOW,
    };
    r.strategy().lock_execution_frame().await.unwrap();
    r.studio().apply_transition(&change).await.unwrap();
    drop(r); // rollback
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.studio().get_slot(f.slot.id).await.unwrap().unwrap().state,
        SlotState::Ready
    );
    r.strategy().lock_execution_frame().await.unwrap();
    r.studio().apply_transition(&change).await.unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    let retired = r.studio().get_slot(f.slot.id).await.unwrap().unwrap();
    assert_eq!(retired.state, SlotState::Retired);
    assert_eq!(
        r.studio()
            .get_budget_move(m.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        jt_studio::BudgetMoveState::Cancelled
    );
    r.studio().apply_transition(&change).await.unwrap();
    assert_eq!(r.studio().get_slot(f.slot.id).await.unwrap(), Some(retired));
    assert_eq!(r.studio().get_arm(f.arm.id).await.unwrap(), Some(f.arm));
    r.commit().await.unwrap();
}

pub async fn reservation_replay_after_archive(uow: &dyn UnitOfWork) {
    let (f, _, request) = budget_fixture(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let saved = tx.studio_budget().reserve(request.clone()).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.strategy()
        .set_status(
            request.executed_version_id,
            jt_strategy::VersionStatus::Archived,
            FIXED_NOW,
            None,
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_budget().reserve(request.clone()).await.unwrap(),
        saved
    );
    let mut changed = request.clone();
    changed.amount_minor += 1;
    assert_eq!(
        tx.studio_budget().reserve(changed).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    drop(tx);
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut fresh = request;
    fresh.evidence_key = "new-after-archive".into();
    assert_eq!(
        tx.studio_budget().reserve(fresh).await.unwrap_err().code,
        ErrorCode::StrategyRequired
    );
}

pub async fn outcome_categories_survive_redaction(uow: &dyn UnitOfWork) {
    use jt_app::error::AppError;
    for (error, category) in [
        (AppError::unauthenticated("secret"), "auth"),
        (AppError::forbidden("secret"), "permission"),
        (
            AppError::upstream_unavailable("x", "secret", Some(2)),
            "throttle",
        ),
        (
            AppError::upstream_unavailable("x", "secret", None),
            "transient",
        ),
        (
            AppError::validation("secret", serde_json::json!({})),
            "permanent",
        ),
        (AppError::internal("secret"), "unknown"),
    ] {
        let f = ready(uow).await;
        let mut tx = uow.tenant(f.ws).await.unwrap();
        let a = tx
            .studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .unwrap();
        tx.studio()
            .finish_publication(a.id(), PublishOutcome::Failed(error.clone()), FIXED_NOW)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = uow.tenant(f.ws).await.unwrap();
        let (attempts, _) = tx.studio().slot_evidence(f.slot.id).await.unwrap();
        let evidence = serde_json::to_value(attempts[0].outcome()).unwrap();
        assert_eq!(evidence["evidence"], category);
        assert!(!evidence.to_string().contains("secret"));
        tx.studio()
            .finish_publication(a.id(), PublishOutcome::Failed(error), FIXED_NOW)
            .await
            .unwrap();
        let different = if category == "auth" {
            AppError::forbidden("other")
        } else {
            AppError::unauthenticated("other")
        };
        assert!(
            tx.studio()
                .finish_publication(a.id(), PublishOutcome::Failed(different), FIXED_NOW)
                .await
                .is_err()
        );
    }
}

pub async fn completion_time_differs_from_claim_time(uow: &dyn UnitOfWork) -> WorkspaceId {
    let f = ready(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let a = tx
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    tx.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Unknown(jt_app::error::AppError::internal("lost")),
            FIXED_NOW + Duration::hours(1),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Succeeded(jt_app::ports::connectors::PublishReceipt {
                external_id: "delayed".into(),
                url: None,
            }),
            FIXED_NOW + Duration::hours(2),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Succeeded(jt_app::ports::connectors::PublishReceipt {
                external_id: "delayed".into(),
                url: None,
            }),
            FIXED_NOW + Duration::hours(3),
        )
        .await
        .unwrap();
    let entries = tx
        .ledger()
        .list(jt_app::ports::LedgerFilter {
            action_prefix: Some("studio.publish.finished".into()),
            actor_kind: None,
            agent_connection_id: None,
            limit: 10,
            before_id: None,
        })
        .await
        .unwrap();
    assert_eq!(entries[0].entry.at, FIXED_NOW + Duration::hours(2));
    let (attempts, _) = tx.studio().slot_evidence(f.slot.id).await.unwrap();
    assert_eq!(attempts[0].claimed_at(), FIXED_NOW);
    assert_eq!(
        attempts[0].observed_at(),
        Some(FIXED_NOW + Duration::hours(2))
    );
    f.ws
}

pub async fn liability_uses_each_item_period(uow: &dyn UnitOfWork) {
    use jt_capability::{BudgetItemId, Period};
    let (f, item, mut request) = budget_fixture(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut version = tx.strategy().current_approved().await.unwrap().unwrap();
    let mut hypothesis = tx.hypotheses().list(version.id).await.unwrap().remove(0);
    tx.strategy()
        .set_status(version.id, VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    version.id = StrategyVersionId::new_v7();
    version.number += 1;
    version.sections.paid_enabled = true;
    version.sections.channels = vec![jt_strategy::ChannelChoice {
        channel: "meta_ads".into(),
        rationale: "paid contract".into(),
        group_id: None,
    }];
    version.sections.budget_frame.lanes[0].lane = LaneKind::Paid;
    hypothesis.channel = "meta_ads".into();
    hypothesis.cadence.insert(
        LaneKind::Paid,
        jt_strategy::HypothesisCadence {
            slots_per_week: 7,
            exploration_bps: 0,
            content_types: vec![jt_strategy::ContentTypeShare {
                key: "text".into(),
                min_bps: 0,
                max_bps: 10000,
            }],
        },
    );
    tx.strategy().insert(version.clone()).await.unwrap();
    tx.hypotheses()
        .upsert(version.id, hypothesis.clone())
        .await
        .unwrap();
    let mut capability=Capability::new(CapabilityId::new_v7(),f.ws,NewCapability{kind_key:"meta_ads".into(),name:"paid".into(),external_id:Some("act_contract".into()),connector_public:serde_json::json!({"access":{"scopes":["ads_read","ads_management"]}}),..Default::default()},FIXED_NOW).unwrap();
    capability.status = jt_capability::StoredStatus::Verified;
    capability.last_verified_at = Some(FIXED_NOW);
    tx.capabilities()
        .insert(capability.clone(), Some(vec![1]))
        .await
        .unwrap();
    tx.budget().link(capability.id, item.id).await.unwrap();
    let arm = Arm::new(
        ArmId::new_v7(),
        f.ws,
        ArmKey {
            hypothesis_id: hypothesis.id,
            content_type: "text".into(),
            channel: "meta_ads".into(),
            lane: LaneKind::Paid,
        },
    )
    .unwrap();
    tx.studio().insert_arm(arm.clone()).await.unwrap();
    let chain = Chain {
        workspace_id: f.ws,
        born_version_id: version.id,
        hypothesis_id: hypothesis.id,
        arm_id: arm.id,
    };
    let binding = AdSetBinding {
        id: AdSetBindingId::new_v7(),
        chain: chain.clone(),
        capability_id: capability.id,
        account_id: "act_contract".into(),
        adset_id: "set_contract".into(),
        campaign_id: None,
        verified_at: Some(FIXED_NOW),
        verification_evidence: None,
    };
    tx.studio()
        .bind_adset(binding.clone(), "paid-liability")
        .await
        .unwrap();
    request.binding_id = Some(binding.id);
    request.chain = Some(chain);
    request.capability_id = capability.id;
    request.lane = LaneKind::Paid;
    request.executed_version_id = version.id;
    let mut daily = item.clone();
    daily.id = BudgetItemId::new_v7();
    daily.period = Period::Daily;
    daily.cap = 10;
    let mut total = item.clone();
    total.id = BudgetItemId::new_v7();
    total.period = Period::Total;
    for b in [&daily, &total] {
        tx.budget().insert_item(b.clone()).await.unwrap();
        tx.budget().link(request.capability_id, b.id).await.unwrap();
        request.budget_item_ids.push(b.id);
    }
    request.daily_budget_minor = Some(10);
    request.amount_minor = 100; // Oct 22 through Oct 31 inclusive.
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let saved = tx.studio_budget().reserve(request.clone()).await.unwrap();
    assert_eq!(saved.item_amounts[&daily.id], 10);
    assert_eq!(saved.item_amounts[&item.id], 100);
    assert_eq!(saved.item_amounts[&total.id], 100);
    tx.studio_budget()
        .settle(saved.id, SpendOutcome::Unknown)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_budget().reserve(request.clone()).await.unwrap(),
        saved
    );
    request.evidence_key = "second-liability".into();
    assert_eq!(
        tx.studio_budget()
            .reserve(request.clone())
            .await
            .unwrap_err()
            .code,
        ErrorCode::BudgetCap
    );
    drop(tx);
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio_budget()
        .settle(saved.id, SpendOutcome::Refused)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio_budget().reserve(request).await.unwrap();
}

pub async fn binding_refresh_invalidates_old_intents(uow: &dyn UnitOfWork) {
    let f = ready(uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut c = tx
        .capabilities()
        .find(f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.external_id = Some("account".into());
    c.last_verified_at = Some(FIXED_NOW);
    tx.capabilities().update(c.clone()).await.unwrap();
    let b = AdSetBinding {
        id: AdSetBindingId::new_v7(),
        chain: f.slot.chain.clone(),
        capability_id: c.id,
        account_id: "account".into(),
        adset_id: "set".into(),
        campaign_id: None,
        verified_at: None,
        verification_evidence: None,
    };
    let original = tx
        .studio()
        .bind_adset(b.clone(), "original-binding")
        .await
        .unwrap();
    let m = BudgetMove {
        binding_verified_at: None,
        binding_verification_evidence: None,
        id: BudgetMoveId::new_v7(),
        chain: b.chain.clone(),
        binding_id: b.id,
        revision: 1,
        daily_budget_minor: 10,
        currency: "TRY".into(),
        state: jt_studio::BudgetMoveState::Queued,
        approval: None,
        reservation_id: None,
        executed_version_id: None,
    };
    tx.studio()
        .save_budget_move(m.clone(), "old-move")
        .await
        .unwrap();
    let v = tx.strategy().lock_execution_frame().await.unwrap().unwrap();
    tx.studio()
        .approve_target(
            ApprovalTarget::BudgetMove(m.id),
            ApprovalReceipt {
                revision: 1,
                by: v.approved_by.unwrap(),
                at: FIXED_NOW,
            },
        )
        .await
        .unwrap();
    tx.studio_control()
        .save_binding_control(BindingControl {
            binding_id: b.id,
            chain: b.chain.clone(),
            desired: jt_studio::AdStatus::Active,
            observed: None,
            paused_by_brake: true,
            outcome: Some(jt_studio::BindingStatusOutcome::Unknown),
            at: FIXED_NOW,
            resume_operation_id: Some(ReservationId::new_v7()),
        })
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    c.last_verified_at = Some(FIXED_NOW + Duration::hours(1));
    tx.capabilities().update(c).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let rebound = tx
        .studio()
        .bind_adset(b.clone(), "explicit-rebind")
        .await
        .unwrap();
    assert_eq!(rebound.verified_at, Some(FIXED_NOW + Duration::hours(1)));
    let old_move = tx.studio().get_budget_move(m.id).await.unwrap().unwrap();
    assert!(old_move.matches_binding_generation(&original));
    assert!(!old_move.matches_binding_generation(&rebound));
    assert!(
        tx.studio()
            .get_approval(ApprovalTarget::BudgetMove(m.id), 1)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        tx.studio_control()
            .binding_control(b.id)
            .await
            .unwrap()
            .is_none()
    );
    let mut changed_identity = rebound.clone();
    changed_identity.account_id = "different-account".into();
    assert!(
        tx.studio()
            .bind_adset(changed_identity, "wrong-identity")
            .await
            .is_err()
    );
    assert_eq!(
        tx.studio()
            .get_budget_move(m.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        jt_studio::BudgetMoveState::Cancelled
    );
    assert_eq!(
        tx.studio()
            .bind_adset(b.clone(), "original-binding")
            .await
            .unwrap(),
        original
    );
    assert_eq!(
        tx.studio().bind_adset(b, "explicit-rebind").await.unwrap(),
        rebound
    );
    assert_eq!(
        tx.studio().get_binding(rebound.id).await.unwrap(),
        Some(rebound)
    );
    tx.commit().await.unwrap();
}
