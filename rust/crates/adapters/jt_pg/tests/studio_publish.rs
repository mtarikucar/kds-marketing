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
async fn probe_publication_and_brake_follow_frame_then_capability_order() {
    use jt_app::usecases::studio::{
        chain::authorize_execution_at,
        control::{BrakeInput, brake},
    };
    let (db, uow, f, d, ctx, _group) = fence_fixture().await;
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
    wait_for_lock(&db, "%select 1 from capabilities%for no key update%").await;
    let braking = tokio::spawn(async move {
        brake(
            &d,
            &ctx,
            BrakeInput {
                engaged: true,
                lane: None,
                expected_revision: 0,
            },
        )
        .await
    });
    wait_for_lock(&db, "%select id from workspaces%for no key update%").await;
    probe.commit().await.unwrap();
    worker.await.unwrap().unwrap();
    braking.await.unwrap().unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        authorize_execution_at(r.as_mut(), execution(&f), FIXED_NOW)
            .await
            .unwrap_err()
            .details["reason"],
        "studio_braked"
    );
}

async fn wait_for_lock(db: &TestDb, query: &str) {
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("select exists(select 1 from pg_stat_activity where datname=current_database() and pid <> pg_backend_pid() and wait_event_type='Lock' and query like $1)")
                .bind(query).fetch_one(&db.pool).await.unwrap();
            if waiting { break; }
            tokio::task::yield_now().await;
        }
    }).await;
    if result.is_err() {
        let activity: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as("select query,state,wait_event_type from pg_stat_activity where datname=current_database()")
            .fetch_all(&db.pool).await.unwrap();
        panic!("worker did not reach {query}: {activity:?}");
    }
}

#[tokio::test]
async fn publish_and_plan_never_deadlock() {
    use jt_app::usecases::studio::{planner::plan, publish::publish_due};
    use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
    use std::sync::Arc;
    let (db, uow, f, mut d, _, _) = fence_fixture().await;
    let connector = Arc::new(ScriptedConnector::new(jt_connector::Provider::X));
    connector.push_publish(Ok(PublishReceipt {
        external_id: "published".into(),
        url: None,
    }));
    d.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector));
    d.clock = Arc::new(jt_testkit::fakes::FixedClock(
        FIXED_NOW + time::Duration::seconds(1),
    ));
    let cred = jt_connector::Credential::OAuth {
        access_token: "test".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec!["tweet.write".into(), "tweet.read".into()],
    };
    let sealed = d
        .seal
        .seal(f.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capabilities()
        .set_sealed(f.slot.capability_id, Some(sealed), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    // Pause the real planner after it acquires the workspace frame, before slot insertion.
    let mut blocker = uow.tenant(f.ws).await.unwrap();
    blocker.studio_control().lock_control().await.unwrap();
    let d = Arc::new(d);
    let ws = f.ws;
    let planning = {
        let d = d.clone();
        tokio::spawn(async move { plan(&d, ws, FIXED_NOW).await })
    };
    wait_for_lock(&db, "%studio_control%").await;
    let publishing = {
        let d = d.clone();
        tokio::spawn(async move { publish_due(&d, ws).await })
    };
    wait_for_lock(&db, "%select id from workspaces%for no key update%").await;
    blocker.commit().await.unwrap();
    let (planned, published) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(planning, publishing)
    })
    .await
    .expect("planner and publisher must finish without deadlock");
    assert!(planned.unwrap().unwrap() > 0);
    assert_eq!(published.unwrap().unwrap(), 1);
}

#[tokio::test]
async fn daily_ops_cap_limits_claims() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .find(f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.policy.daily_ops_cap = Some(1);
    r.capabilities().update(cap).await.unwrap();
    let mut second = f.slot.clone();
    second.id = jt_studio::SlotId::new_v7();
    r.studio()
        .insert_slots("second", vec![second.clone()])
        .await
        .unwrap();
    let mut piece = f.piece.clone();
    piece.id = jt_studio::PieceId::new_v7();
    r.studio()
        .save_piece(second.id, 0, piece, "second")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let now = FIXED_NOW.date().with_hms(20, 59, 59).unwrap().assume_utc();
    let mut first = uow.tenant(f.ws).await.unwrap();
    let a = first
        .studio()
        .claim_publication_for(f.slot.id, now)
        .await
        .unwrap()
        .unwrap();
    let other = uow.clone();
    let ws = f.ws;
    let contender = tokio::spawn(async move {
        let mut r = other.tenant(ws).await.unwrap();
        r.studio().claim_publication_for(second.id, now).await
    });
    wait_for_lock(&db, "%select id from workspaces%for no key update%").await;
    first.commit().await.unwrap();
    assert_eq!(
        contender.await.unwrap().unwrap_err().details["reason"],
        "daily_ops_cap"
    );
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.studio()
        .finish_publication(
            a.id(),
            PublishOutcome::Succeeded(PublishReceipt {
                external_id: "first".into(),
                url: None,
            }),
            now,
        )
        .await
        .unwrap();
    assert_eq!(
        r.studio()
            .claim_publication_for(second.id, now)
            .await
            .unwrap_err()
            .details["reason"],
        "daily_ops_cap"
    );
    assert_eq!(
        r.studio().get_slot(second.id).await.unwrap().unwrap().state,
        jt_studio::SlotState::Ready
    );
    assert!(
        r.studio()
            .claim_publication_for(second.id, now + time::Duration::seconds(1))
            .await
            .unwrap()
            .is_some()
    );
    r.commit().await.unwrap();
}
