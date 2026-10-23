#[tokio::test]
async fn request_keys_workspace_scope_and_24h_expiry() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::request_keys_workspace_scope_and_24h_expiry(uow).await;
}

#[tokio::test]
async fn consumer_filters_before_limit_ignores_ack() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::consumer_filters_before_limit_ignores_ack(uow).await;
}

#[tokio::test]
async fn people_identities_and_tombstones() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::people_identities_and_tombstones(uow).await;
}

#[tokio::test]
async fn conversations_and_message_dedupe() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::conversations_and_message_dedupe(uow).await;
}

#[tokio::test]
async fn reducer_patch_and_event_are_atomic() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::reducer_patch_and_event_are_atomic(uow).await;
}

#[tokio::test]
async fn tasks_notes_merges_and_outbox() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::tasks_notes_merges_and_outbox(uow).await;
}

#[tokio::test]
async fn lost_defaults_existing_and_new_workspaces() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::lost_defaults_existing_and_new_workspaces(uow).await;
}

#[tokio::test]
async fn concurrent_request_keys_wait_and_replace_expired_rows_atomically() {
    use jt_app::ports::UnitOfWork;
    use jt_testkit::{fakes::FIXED_NOW, inbox_contract::Fixture};
    use serde_json::json;
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    for (key, commit) in [("commit", true), ("rollback", false)] {
        let mut a = uow.tenant(f.ws).await.unwrap();
        let mut b = uow.tenant(f.ws).await.unwrap();
        assert!(
            a.request_keys()
                .store(key, json!(1), FIXED_NOW)
                .await
                .unwrap()
        );
        let pending = b.request_keys().store(key, json!(2), FIXED_NOW);
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut pending)
                .await
                .is_err()
        );
        if commit {
            a.commit().await.unwrap();
        } else {
            drop(a);
        }
        assert_eq!(pending.await.unwrap(), !commit);
    }
    let mut a = uow.tenant(f.ws).await.unwrap();
    let mut b = uow.tenant(f.ws).await.unwrap();
    let later = FIXED_NOW + time::Duration::hours(24);
    assert!(
        a.request_keys()
            .store("commit", json!(3), later)
            .await
            .unwrap()
    );
    let pending = b.request_keys().store("commit", json!(4), later);
    tokio::pin!(pending);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut pending)
            .await
            .is_err()
    );
    a.commit().await.unwrap();
    assert!(!pending.await.unwrap());
}

#[tokio::test]
async fn concurrent_consumer_claims_wait_for_commit_or_rollback() {
    use jt_app::ports::{UnitOfWork, inbox::ConsumptionOutcome};
    use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
    use jt_testkit::{fakes::FIXED_NOW, inbox_contract::Fixture};
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    for commit in [true, false] {
        let id = InboundEventId::new_v7();
        let mut seed = uow.tenant(f.ws).await.unwrap();
        seed.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id,
                    workspace_id: f.ws,
                    provider: Provider::Meta,
                    capability_id: None,
                    external_id: id.to_string(),
                    kind: EventKind::Message,
                    payload: serde_json::json!({}),
                    received_at: FIXED_NOW,
                    processed_at: None,
                },
                None,
            )
            .await
            .unwrap();
        seed.commit().await.unwrap();
        let mut a = uow.tenant(f.ws).await.unwrap();
        let mut b = uow.tenant(f.ws).await.unwrap();
        assert!(a.consumption().try_claim("inbox@1", id).await.unwrap());
        let pending = b.consumption().try_claim("inbox@1", id);
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut pending)
                .await
                .is_err()
        );
        if commit {
            a.consumption()
                .record(
                    "inbox@1",
                    id,
                    ConsumptionOutcome {
                        consumed_at: FIXED_NOW,
                        outcome: "completed".into(),
                    },
                )
                .await
                .unwrap();
            a.commit().await.unwrap();
        } else {
            drop(a);
        }
        assert_eq!(pending.await.unwrap(), !commit);
    }
}

#[tokio::test]
async fn concurrent_inbound_upserts_preserve_executor_and_return_one_conversation() {
    use jt_app::ports::UnitOfWork;
    use jt_testkit::inbox_contract::Fixture;
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let p = f.insert_person("Person").await;
    let cap = f.capability().await;
    let mut a = uow.tenant(f.ws).await.unwrap();
    let mut b = uow.tenant(f.ws).await.unwrap();
    let first = a
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    a.conversations()
        .update_executor(first.id, jt_inbox::Executor::Human { user_id: None })
        .await
        .unwrap();
    let second = b
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap));
    tokio::pin!(second);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut second)
            .await
            .is_err()
    );
    a.commit().await.unwrap();
    let second = second.await.unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(second.executor_generation, 1);
    assert_eq!(second.executor, jt_inbox::Executor::Human { user_id: None });
}

#[tokio::test]
async fn concurrent_first_contacts_leave_one_person_and_journey() {
    use jt_app::{error::ErrorCode, ports::UnitOfWork};
    use jt_inbox::{Identity, IdentityChannel, IdentityId};
    use jt_testkit::{fakes::FIXED_NOW, inbox_contract::Fixture};
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let p = f.person("First");
    let q = f.person("Second");
    let mut a = uow.tenant(f.ws).await.unwrap();
    let mut b = uow.tenant(f.ws).await.unwrap();
    a.people().insert(p.clone()).await.unwrap();
    b.people().insert(q.clone()).await.unwrap();
    a.journeys().insert(f.journey(p.id)).await.unwrap();
    b.journeys().insert(f.journey(q.id)).await.unwrap();
    let first = Identity {
        id: IdentityId::new_v7(),
        workspace_id: f.ws,
        person_id: p.id,
        channel: IdentityChannel::Phone,
        value_normalized: "+905550000000".into(),
        value_display: "phone".into(),
        active: true,
        first_seen_at: FIXED_NOW,
    };
    a.identities().insert(first.clone()).await.unwrap();
    {
        let second = b.identities().insert(Identity {
            id: IdentityId::new_v7(),
            person_id: q.id,
            ..first
        });
        tokio::pin!(second);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut second)
                .await
                .is_err()
        );
        a.commit().await.unwrap();
        assert_eq!(second.await.unwrap_err().code, ErrorCode::Conflict);
    }
    drop(b);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.people().search("", 10).await.unwrap(), vec![p.clone()]);
    assert!(t.journeys().open_for(p.id).await.unwrap().is_some());
    assert!(t.journeys().open_for(q.id).await.unwrap().is_none());
}

#[tokio::test]
async fn missing_user_references_are_not_found() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::missing_user_references_are_not_found(uow).await;
}

#[tokio::test]
async fn conversation_upsert_uses_the_natural_key() {
    let db = jt_testkit::TestDb::new().await;
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::inbox_contract::conversation_upsert_uses_the_natural_key(uow).await;
}
