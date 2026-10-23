use jt_app::{
    ports::UnitOfWork,
    usecases::{Deps, inbox::consumer},
};
use jt_capability::CapabilityId;
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_tenancy::WorkspaceId;
use jt_testkit::{fakes::FIXED_NOW, inbox_contract::Fixture};
use serde_json::{Value, json};
use std::sync::Arc;

fn event(ws: WorkspaceId, cap: CapabilityId, id: &str) -> InboundEvent {
    // Exact Meta adapter payload from the copied provider fixture, varying only the message id.
    let raw: Value = serde_json::from_str(include_str!(
        "../../../jt_app/tests/fixtures/meta/whatsapp_messages.json"
    ))
    .unwrap();
    let value = &raw["entry"][0]["changes"][0]["value"];
    let mut message = value["messages"][0].clone();
    message["id"] = json!(id);
    InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: ws,
        provider: Provider::Meta,
        capability_id: Some(cap),
        external_id: id.into(),
        kind: EventKind::Message,
        payload: json!({"message":message,"contact":value["contacts"][0]}),
        received_at: FIXED_NOW,
        processed_at: None,
    }
}
async fn setup() -> (
    jt_testkit::TestDb,
    Arc<jt_pg::PgUnitOfWork>,
    Deps,
    WorkspaceId,
    CapabilityId,
) {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let cap = jt_capability::Capability::new(
        CapabilityId::new_v7(),
        f.ws,
        jt_capability::NewCapability {
            kind_key: "whatsapp_cloud".into(),
            name: "WA".into(),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    let cid = cap.id;
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capabilities().insert(cap, None).await.unwrap();
    r.commit().await.unwrap();
    let deps = jt_testkit::fakes::deps(uow.clone());
    (db, uow, deps, f.ws, cid)
}
#[tokio::test]
async fn two_concurrent_first_messages_one_person_journey() {
    let (_db, uow, deps, ws, cap) = setup().await;
    let mut r = uow.tenant(ws).await.unwrap();
    for id in ["first", "second"] {
        r.inbound_events()
            .insert_if_new(event(ws, cap, id), None)
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let (a, b) = tokio::join!(
        consumer::consume_workspace(&deps, ws, FIXED_NOW),
        consumer::consume_workspace(&deps, ws, FIXED_NOW)
    );
    assert_eq!(a.failed + b.failed, 0);
    assert_eq!(a.changed + b.changed, 2);
    let mut r = uow.tenant(ws).await.unwrap();
    let people = r.people().search("", 100).await.unwrap();
    assert_eq!(people.len(), 1);
    let p = &people[0];
    assert_eq!(r.identities().list(p.id).await.unwrap().len(), 1);
    let convs = r.conversations().list(Some(p.id), 100).await.unwrap();
    assert_eq!(convs.len(), 1);
    assert_eq!(
        r.conversations()
            .send_state(convs[0].id)
            .await
            .unwrap()
            .last_inbound_identity_id,
        Some(r.identities().list(p.id).await.unwrap()[0].id)
    );
    assert_eq!(r.messages().list(convs[0].id, 100).await.unwrap().len(), 2);
    let j = r.journeys().open_for(p.id).await.unwrap().unwrap();
    assert_eq!(r.journeys().events(j.id, 100).await.unwrap().len(), 2);
    assert!(
        r.inbound_events()
            .list_for_consumer("inbox@2", None, 100)
            .await
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn claim_effect_completion_rollback_and_retry() {
    let (db, uow, deps, ws, cap) = setup().await;
    let mut r = uow.tenant(ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(event(ws, cap, "rollback"), None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    // Fault at completion, after identity, conversation, message, journey and ledger writes.
    sqlx::raw_sql("create function fail_consumption() returns trigger language plpgsql as $$ begin raise exception 'injected completion failure'; end $$; create trigger fail_consumption before update on event_consumption for each row execute function fail_consumption();").execute(&db.pool).await.unwrap();
    assert_eq!(
        consumer::consume_workspace(&deps, ws, FIXED_NOW)
            .await
            .failed,
        1
    );
    let mut tx = jt_pg::TenantTx::begin(&db.pool, ws).await.unwrap();
    for table in [
        "people",
        "identities",
        "conversations",
        "messages",
        "journeys",
        "journey_events",
        "event_consumption",
        "ledger_entries",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(count, 0, "{table} must roll back");
    }
    drop(tx);
    sqlx::raw_sql("drop trigger if exists fail_consumption on event_consumption; drop function if exists fail_consumption();").execute(&db.pool).await.unwrap();
    assert_eq!(
        consumer::consume_workspace(&deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(r.people().search("", 100).await.unwrap().len(), 1);
    assert!(
        r.inbound_events()
            .list_for_consumer("inbox@2", None, 100)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn message_lookup_and_echo_binding_contract() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_contract::message_receipt_lookup_and_echo_binding(Arc::new(
        jt_pg::PgUnitOfWork::new(db.pool.clone()),
    ))
    .await;
}

#[tokio::test]
async fn call_events_are_scoped_bounded_ordered_and_uncapped() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_contract::call_events_are_scoped_bounded_ordered_and_uncapped(
        std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())),
    )
    .await;
}

#[tokio::test]
async fn call_correlation_has_an_indexed_receipt_time_bound() {
    let db = jt_testkit::TestDb::new().await;
    let f = Fixture::new(Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()))).await;
    let mut tx = jt_pg::TenantTx::begin(&db.pool, f.ws).await.unwrap();
    sqlx::query("insert into inbound_events (id,workspace_id,provider,external_id,kind,payload,received_at) select md5(n::text)::uuid,$1,'netgsm',n::text,'call_event',jsonb_build_object('unique_id', case when n=1 then 'target' else n::text end),$2 from generate_series(1,2000) n")
        .bind(f.ws.as_uuid()).bind(FIXED_NOW).execute(tx.conn()).await.unwrap();
    sqlx::query("analyze inbound_events")
        .execute(tx.conn())
        .await
        .unwrap();
    sqlx::query("set local enable_seqscan=off")
        .execute(tx.conn())
        .await
        .unwrap();
    let plan: serde_json::Value = sqlx::query_scalar(
        "explain (format json) select id, payload from inbound_events where workspace_id=$1 and provider='netgsm' and kind='call_event' and call_unique_id=$2 and received_at<=$3 order by received_at,id"
    ).bind(f.ws.as_uuid()).bind("target").bind(FIXED_NOW).fetch_one(tx.conn()).await.unwrap();
    let plan = plan.to_string();
    assert!(plan.contains("inbound_events_call_lookup"), "{plan}");
    assert!(
        plan.contains("Index Cond") && plan.contains("call_unique_id ="),
        "{plan}"
    );
}
