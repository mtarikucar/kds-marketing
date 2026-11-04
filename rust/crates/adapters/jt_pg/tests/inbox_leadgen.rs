use jt_app::ports::inbox::AttributionReader;
use jt_app::{
    ports::UnitOfWork,
    usecases::{
        Deps,
        inbox::{consumer, erasure},
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, EventKind, InboundEvent, InboundEventId, Provider};
use jt_pg::TenantTx;
use jt_testkit::{
    TestDb,
    fakes::{FIXED_NOW, ScriptedConnector, ScriptedRegistry},
    inbox_contract::Fixture,
};
use serde_json::json;
use std::sync::Arc;
use time::Duration;

struct World {
    db: TestDb,
    deps: Deps,
    f: Fixture,
    connector: Arc<ScriptedConnector>,
}
async fn setup() -> World {
    let db = TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    let connector = Arc::new(ScriptedConnector::new(Provider::Meta));
    deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        f.ws,
        NewCapability {
            kind_key: "facebook_page".into(),
            name: "Page".into(),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.external_id = Some("page".into());
    let credential = Credential::PageToken {
        page_id: "page".into(),
        token: "secret".into(),
    };
    let sealed = deps
        .seal
        .seal(f.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: f.ws,
        capability_id: Some(cap.id),
        provider: Provider::Meta,
        external_id: "leadgen:lead".into(),
        kind: EventKind::LeadGen,
        payload: json!({"leadgen":{"page_id":"page","leadgen_id":"lead","created_time":1790000040}}),
        received_at: FIXED_NOW,
        processed_at: None,
    };
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.inbound_events()
        .insert_if_new(event, Some(b"raw form".to_vec()))
        .await
        .unwrap();
    r.commit().await.unwrap();
    World {
        db,
        deps,
        f,
        connector,
    }
}
async fn run(w: &World) -> jt_app::usecases::jobs::JobReport {
    w.connector
        .push_leadgen(Ok(jt_app::ports::connectors::LeadGenRecord {
            leadgen_id: "lead".into(),
            form_id: None,
            ad_id: Some("ad".into()),
            campaign_id: None,
            campaign_name: None,
            created_time: Some(FIXED_NOW - Duration::days(1)),
            fields: [("email".into(), vec!["lead@example.test".into()])].into(),
        }));
    consumer::consume_workspace(&w.deps, w.f.ws, FIXED_NOW).await
}

#[tokio::test]
async fn leadgen_attribution_written_atomically_once() {
    let w = setup().await;
    // Fail at the last operation, after all domain effects and ledger writes.
    sqlx::raw_sql("create function reject_lead_completion() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$; create trigger reject_lead_completion before update on event_consumption for each row execute function reject_lead_completion();").execute(&w.db.pool).await.unwrap();
    assert_eq!(run(&w).await.failed, 1);
    let mut tx = TenantTx::begin(&w.db.pool, w.f.ws).await.unwrap();
    for table in [
        "people",
        "identities",
        "journeys",
        "journey_events",
        "journey_attribution",
        "tasks",
        "event_consumption",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(count, 0, "rolled back {table}");
    }
    let count: i64 =
        sqlx::query_scalar("select count(*) from ledger_entries where action like 'inbox.%'")
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(count, 0);
    drop(tx);
    sqlx::raw_sql("drop trigger reject_lead_completion on event_consumption; drop function reject_lead_completion();").execute(&w.db.pool).await.unwrap();
    assert_eq!(run(&w).await.changed, 1);
    assert_eq!(
        consumer::consume_workspace(&w.deps, w.f.ws, FIXED_NOW)
            .await
            .touched,
        0
    );
    let rows = w
        .deps
        .attribution()
        .by_ad(w.f.ws, "ad", FIXED_NOW - Duration::days(2), FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].acquired_at, FIXED_NOW - Duration::days(1));
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(r.tasks().list(rows[0].journey_id).await.unwrap().len(), 1);
}

#[tokio::test]
async fn journey_attribution_is_immutable() {
    let w = setup().await;
    assert_eq!(run(&w).await.changed, 1);
    for statement in [
        "update journey_attribution set ad_id='replacement'",
        "delete from journey_attribution",
    ] {
        let mut tx = TenantTx::begin(&w.db.pool, w.f.ws).await.unwrap();
        let err = sqlx::query(statement).execute(tx.conn()).await.unwrap_err();
        assert!(err.to_string().contains("append-only"));
    }
    assert_eq!(
        w.deps
            .attribution()
            .by_ad(w.f.ws, "ad", FIXED_NOW - Duration::days(2), FIXED_NOW)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn attribution_survives_raw_retention_and_erasure() {
    let w = setup().await;
    assert_eq!(run(&w).await.changed, 1);
    let before = w
        .deps
        .attribution()
        .by_ad(w.f.ws, "ad", FIXED_NOW - Duration::days(2), FIXED_NOW)
        .await
        .unwrap();
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    let person = r
        .journeys()
        .get(before[0].journey_id)
        .await
        .unwrap()
        .unwrap()
        .person_id;
    assert_eq!(
        r.inbound_events()
            .purge_raw_before(FIXED_NOW + Duration::days(1))
            .await
            .unwrap(),
        1
    );
    r.commit().await.unwrap();
    let ctx = jt_app::ctx::Ctx {
        workspace_id: w.f.ws,
        actor: jt_ledger::Actor::Human { user_id: w.f.user },
        permissions: jt_tenancy::SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    erasure::erase(&w.deps, &ctx, person, erasure::EraseInput { confirm: true })
        .await
        .unwrap();
    assert_eq!(
        w.deps
            .attribution()
            .by_journey(w.f.ws, before[0].journey_id)
            .await
            .unwrap(),
        Some(before[0].clone())
    );
}

#[tokio::test]
async fn leadgen_split_returns_conflict_ids_and_merge_suggestion() {
    use jt_app::usecases::inbox::{context, people};
    let w = setup().await;
    let ctx = jt_app::ctx::Ctx {
        workspace_id: w.f.ws,
        actor: jt_ledger::Actor::Human { user_id: w.f.user },
        permissions: jt_tenancy::SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    for (channel, value) in [("email", "lead@example.test"), ("phone", "05321234567")] {
        people::create(&w.deps, &ctx, serde_json::from_value(json!({"display_name":"Lead","source":"import","identities":[{"channel":channel,"value":value}]})).unwrap()).await.unwrap();
    }
    for _ in 0..2 {
        w.connector
            .push_leadgen(Ok(jt_app::ports::connectors::LeadGenRecord {
                leadgen_id: "lead".into(),
                form_id: None,
                ad_id: None,
                campaign_id: None,
                campaign_name: None,
                created_time: Some(FIXED_NOW),
                fields: [
                    ("email".into(), vec!["lead@example.test".into()]),
                    ("phone_number".into(), vec!["05321234567".into()]),
                ]
                .into(),
            }));
        assert_eq!(
            consumer::consume_workspace(&w.deps, w.f.ws, FIXED_NOW)
                .await
                .failed,
            1
        );
        let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
        let suggestions = r.merges().list_all().await.unwrap();
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].status, "suggested");
        assert_eq!(
            r.inbound_events()
                .list_for_consumer(consumer::CONSUMER, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        drop(r);
        let pending = context::pending(&w.deps, &ctx).await.unwrap();
        assert_eq!(pending.merges.len(), 1);
        assert!(pending.tasks_due.is_empty());
    }
    assert_eq!(run(&w).await.changed, 1); // the same event with only its email identity
    assert_eq!(
        consumer::consume_workspace(&w.deps, w.f.ws, FIXED_NOW)
            .await
            .touched,
        0
    );
}

#[tokio::test]
async fn deferred_leadgen_claim_is_narrow_and_transactional() {
    let db = TestDb::new().await;
    jt_testkit::compliance_contract::deferred_leadgen_claim_is_narrow_and_transactional(Arc::new(
        jt_pg::PgUnitOfWork::new(db.pool.clone()),
    ))
    .await;
}

#[tokio::test]
async fn deferred_events_retry_with_backoff_then_abandon() {
    let db = TestDb::new().await;
    jt_testkit::compliance_contract::deferred_events_retry_with_backoff_then_abandon(Arc::new(
        jt_pg::PgUnitOfWork::new(db.pool.clone()),
    ))
    .await;
}

#[tokio::test]
async fn deferred_leadgen_reclaimed_once() {
    use jt_app::ports::inbox::ConsumptionOutcome;
    let w = setup().await;
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    let id = r
        .inbound_events()
        .list_for_consumer("inbox@2", None, 10)
        .await
        .unwrap()[0]
        .id;
    assert!(r.consumption().try_claim("inbox@2", id).await.unwrap());
    r.consumption()
        .record(
            "inbox@2",
            id,
            ConsumptionOutcome {
                consumed_at: FIXED_NOW,
                outcome: "deferred".into(),
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(run(&w).await.changed, 1);
    assert_eq!(
        consumer::consume_workspace(&w.deps, w.f.ws, FIXED_NOW)
            .await
            .touched,
        0
    );
    let attribution = w
        .deps
        .attribution()
        .by_ad(w.f.ws, "ad", FIXED_NOW - Duration::days(2), FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(attribution.len(), 1);
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.tasks()
            .list(attribution[0].journey_id)
            .await
            .unwrap()
            .len(),
        1
    );
}
