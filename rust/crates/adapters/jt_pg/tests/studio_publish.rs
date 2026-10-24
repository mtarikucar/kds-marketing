use jt_app::ports::{UnitOfWork, studio::PublishOutcome};
use jt_pg::PgUnitOfWork;
use jt_studio::{PublishReceipt, PublishState};
use jt_testkit::{TestDb, fakes::FIXED_NOW, studio_contract::ready};
#[tokio::test]
async fn receipt_checkpoint_survives_restart_and_completion_replay() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let receipt = PublishReceipt {
        external_id: "captured-post".into(),
        url: Some("https://example.com/post?secret=token".parse().unwrap()),
    };
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(
        r.studio()
            .claim_publication_for(jt_studio::SlotId::new_v7(), FIXED_NOW)
            .await
            .unwrap()
            .is_none()
    );
    let a = r
        .studio()
        .claim_publication_for(f.slot.id, FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    r.studio()
        .finish_publication(a.id(), PublishOutcome::Observed(receipt.clone()), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let restarted = PgUnitOfWork::new(db.pool.clone());
    let mut r = restarted.tenant(f.ws).await.unwrap();
    assert!(
        r.studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .is_none()
    );
    let saved = r
        .studio()
        .slot_evidence(f.slot.id)
        .await
        .unwrap()
        .0
        .remove(0);
    assert_eq!(saved.state(), PublishState::Unknown);
    let Some(jt_studio::PublishOutcome::Observed(captured)) = saved.outcome() else {
        panic!("captured receipt")
    };
    assert_eq!(captured.external_id, "captured-post");
    assert_eq!(captured.url.as_ref().unwrap().query(), None);
    for _ in 0..2 {
        r.studio()
            .finish_publication(
                a.id(),
                PublishOutcome::Succeeded(receipt.clone()),
                FIXED_NOW,
            )
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.workspace_id',$1,true)")
        .bind(f.ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("select count(*) from studio_publications where workspace_id=$1")
            .bind(f.ws.0)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

async fn fence_fixture() -> (
    TestDb,
    PgUnitOfWork,
    jt_testkit::studio_contract::Fixture,
    jt_app::usecases::Deps,
    jt_app::ctx::Ctx,
    jt_capability::CapabilityGroupId,
) {
    use jt_capability::{CapabilityGroup, CapabilityGroupId, StoredStatus};
    use jt_ledger::Actor;
    use jt_strategy::{
        ChannelChoice, ContentTypeShare, HypothesisCadence, LaneKind, StrategyVersionId,
        VersionStatus,
    };
    use std::sync::Arc;
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    let mut v = r
        .strategy()
        .find(f.slot.chain.born_version_id)
        .await
        .unwrap()
        .unwrap();
    let user = v.approved_by.unwrap();
    let mut h = r.hypotheses().list(v.id).await.unwrap().remove(0);
    r.strategy()
        .set_status(v.id, VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    let group =
        CapabilityGroup::new(CapabilityGroupId::new_v7(), f.ws, "selected".into(), None).unwrap();
    r.capability_groups()
        .insert(group.clone(), FIXED_NOW)
        .await
        .unwrap();
    r.capability_groups()
        .add_member(group.id, f.slot.capability_id)
        .await
        .unwrap();
    v.id = StrategyVersionId::new_v7();
    v.number = 2;
    v.sections.channels = vec![ChannelChoice {
        channel: "x".into(),
        rationale: "test".into(),
        group_id: Some(group.id.0),
    }];
    h.cadence.insert(
        LaneKind::Organic,
        HypothesisCadence {
            slots_per_week: 1,
            exploration_bps: 0,
            content_types: vec![ContentTypeShare {
                key: "text".into(),
                min_bps: 0,
                max_bps: 10000,
            }],
        },
    );
    r.strategy().insert(v.clone()).await.unwrap();
    r.hypotheses().upsert(v.id, h).await.unwrap();
    let mut c = r
        .capabilities()
        .find(f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.status = StoredStatus::Verified;
    c.last_verified_at = Some(FIXED_NOW);
    c.connector_public = serde_json::json!({"access":{"scopes":["tweet.read","tweet.write"]}});
    r.capabilities().update(c).await.unwrap();
    r.capabilities()
        .set_sealed(f.slot.capability_id, Some(vec![1]), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let ctx = jt_app::ctx::Ctx {
        workspace_id: f.ws,
        actor: Actor::Human { user_id: user },
        permissions: jt_tenancy::SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let d = jt_testkit::fakes::deps(Arc::new(uow.clone()));
    (db, uow, f, d, ctx, group.id)
}
fn execution(
    f: &jt_testkit::studio_contract::Fixture,
) -> jt_app::usecases::studio::chain::ExecutionInput {
    jt_app::usecases::studio::chain::ExecutionInput {
        chain: f.slot.chain.clone(),
        capability_id: f.slot.capability_id,
        target: jt_app::ports::studio::ApprovalTarget::Slot(f.slot.id),
        expected_revision: 1,
    }
}
#[tokio::test]
async fn publication_fence_serializes_consent_and_group_revocation() {
    use jt_app::usecases::{capabilities, groups, studio::chain::authorize_execution_at};
    for mutation_kind in 0..3 {
        let (_db, uow, f, d, ctx, group) = fence_fixture().await;
        let mut fence = uow.tenant(f.ws).await.unwrap();
        authorize_execution_at(fence.as_mut(), execution(&f), FIXED_NOW)
            .await
            .unwrap();
        let cap = f.slot.capability_id;
        let (started, wait) = tokio::sync::oneshot::channel();
        let mut mutation = tokio::spawn(async move {
            started.send(()).unwrap();
            if mutation_kind == 0 {
                capabilities::set_policy(
                    &d,
                    &ctx,
                    cap,
                    jt_capability::Policy {
                        requires_human_approval: true,
                        ..Default::default()
                    },
                )
                .await
                .map(|_| ())
            } else if mutation_kind == 1 {
                groups::remove_member(&d, &ctx, group, cap)
                    .await
                    .map(|_| ())
            } else {
                let mut r = d.uow.tenant(ctx.workspace_id).await?;
                r.capabilities().set_sealed(cap, None, FIXED_NOW).await?;
                r.commit().await
            }
        });
        wait.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), &mut mutation)
                .await
                .is_err(),
            "authorization changed before Sending could commit"
        );
        fence.commit().await.unwrap();
        mutation.await.unwrap().unwrap();
        let mut r = uow.tenant(f.ws).await.unwrap();
        assert!(
            authorize_execution_at(r.as_mut(), execution(&f), FIXED_NOW)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn waiting_for_probe_does_not_block_emergency_brake() {
    use jt_app::usecases::studio::{
        chain::authorize_execution_at,
        control::{BrakeInput, brake},
    };
    let (_db, uow, f, d, ctx, _group) = fence_fixture().await;
    let mut probe = uow.tenant(f.ws).await.unwrap();
    probe
        .capabilities()
        .lock(f.slot.capability_id)
        .await
        .unwrap();
    let input = execution(&f);
    let other = uow.clone();
    let ws = f.ws;
    let worker = tokio::spawn(async move {
        let mut r = other.tenant(ws).await.unwrap();
        authorize_execution_at(r.as_mut(), input, FIXED_NOW).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        brake(
            &d,
            &ctx,
            BrakeInput {
                engaged: true,
                lane: None,
                expected_revision: 0,
            },
        ),
    )
    .await;
    probe.commit().await.unwrap();
    assert!(
        result.is_ok(),
        "a blocked capability must not hold the brake frame"
    );
    result.unwrap().unwrap();
    assert!(worker.await.unwrap().is_err());
}
