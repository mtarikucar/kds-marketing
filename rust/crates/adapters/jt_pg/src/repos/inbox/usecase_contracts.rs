//! Contracts needed by Task 4; run against both implementations.
use jt_app::{
    ctx::Ctx,
    ports::UnitOfWork,
    usecases::inbox::{journeys, people},
};
use jt_inbox::{JourneyEventKind, JourneyStatus, ReducePolicy, Task, TaskId, TaskStatus, reduce};
use jt_ledger::Actor;
use jt_tenancy::SystemRole;
use jt_testkit::{
    TestDb,
    fakes::{FIXED_NOW, InMemoryUow, deps},
    inbox_contract::Fixture,
};
use serde_json::json;
use std::sync::Arc;

async fn repository_contract(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = f.insert_person("Ada").await;
    let j = f.journey(p.id);
    let c = f.capability().await;
    let conv = f.conversation(p.id, c);
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.people().lock_workspace().await.unwrap();
    r.journeys().insert(j.clone()).await.unwrap();
    r.conversations()
        .upsert_on_inbound(conv.clone())
        .await
        .unwrap();
    r.journeys().assign_owner(j.id, None).await.unwrap();
    let assigned = r.journeys().get(j.id).await.unwrap().unwrap();
    assert_eq!(assigned.owner, None);
    assert_eq!(assigned.status, JourneyStatus::New);
    assert_eq!(assigned.updated_at, j.updated_at);
    let e = f.event(j.id, "global-key", JourneyEventKind::MeetingHeld);
    let transition = reduce(&j, &e, &ReducePolicy::default()).unwrap();
    r.journeys()
        .apply_transition(j.id, transition, e.clone())
        .await
        .unwrap();
    assert_eq!(
        r.journeys().event_by_key("global-key").await.unwrap(),
        Some(e.clone())
    );
    assert_eq!(
        r.conversations().lock_for_person(p.id).await.unwrap().len(),
        1
    );
    r.commit().await.unwrap();
    let mut other = uow.tenant(f.other).await.unwrap();
    assert!(
        other
            .journeys()
            .event_by_key("global-key")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        other
            .conversations()
            .lock_for_person(p.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(other.journeys().assign_owner(j.id, None).await.is_err());
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.journeys().assign_owner(j.id, Some(f.user)).await.unwrap();
    drop(r);
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(r.journeys().get(j.id).await.unwrap().unwrap().owner, None);
}
#[tokio::test]
async fn task4_repository_contracts_fake_and_pg() {
    repository_contract(Arc::new(InMemoryUow::new())).await;
    let db = TestDb::new().await;
    repository_contract(Arc::new(crate::PgUnitOfWork::new(db.pool.clone()))).await;
}

#[tokio::test]
async fn concurrent_first_contacts_and_event_keys_are_serialized() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("concurrent-inbox").await;
    let uow = Arc::new(crate::PgUnitOfWork::new(db.pool.clone()));
    // Real UUIDs across transactions; deps' counter is shared by all concurrent calls.
    let deps = deps(uow.clone());
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let input = || {
        serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})).unwrap()
    };
    let (a, b) = tokio::join!(
        people::create(&deps, &ctx, input()),
        people::create(&deps, &ctx, input())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a.created, b.created);
    assert_eq!(a.person.id, b.person.id);
    let mut r = uow.tenant(ws).await.unwrap();
    let j = r.journeys().open_for(a.person.id).await.unwrap().unwrap();
    r.tasks()
        .insert(Task {
            id: TaskId::new_v7(),
            workspace_id: ws,
            journey_id: j.id,
            title: "Call".into(),
            due_at: FIXED_NOW,
            assignee: None,
            status: TaskStatus::Open,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let event = || {
        serde_json::from_value(json!({"kind":"won","idempotency_key":"concurrent-win","payload":{"product":"Service","amount_minor":100,"currency":"TRY"}})).unwrap()
    };
    let (a, b) = tokio::join!(
        journeys::report(&deps, &ctx, j.id, event()),
        journeys::report(&deps, &ctx, j.id, event())
    );
    assert_ne!(a.unwrap().duplicate, b.unwrap().duplicate);
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(r.journeys().events(j.id).await.unwrap().len(), 1);
    assert_eq!(
        r.tasks().list(j.id).await.unwrap()[0].status,
        TaskStatus::Done
    );
}

#[tokio::test]
async fn status_labels_policy_contract_fake_and_pg() {
    use jt_app::ports::WorkspacePolicy;
    async fn check(uow: Arc<dyn UnitOfWork>) {
        let f = Fixture::new(uow.clone()).await;
        let policy = WorkspacePolicy {
            agent_checkin_interval_minutes: 60,
            inbox_status_labels: [("new".into(), "Yeni".into())].into(),
        };
        let mut r = uow.tenant(f.ws).await.unwrap();
        assert!(
            r.workspace_policy()
                .get()
                .await
                .unwrap()
                .inbox_status_labels
                .is_empty()
        );
        r.workspace_policy()
            .set(policy.clone(), FIXED_NOW)
            .await
            .unwrap();
        r.commit().await.unwrap();
        let mut r = uow.tenant(f.ws).await.unwrap();
        assert_eq!(r.workspace_policy().get().await.unwrap(), policy);
        let mut edited = policy.clone();
        edited
            .inbox_status_labels
            .insert("won".into(), "Won".into());
        r.workspace_policy().set(edited, FIXED_NOW).await.unwrap();
        drop(r);
        let mut r = uow.tenant(f.ws).await.unwrap();
        assert_eq!(r.workspace_policy().get().await.unwrap(), policy);
        drop(r);
        let mut other = uow.tenant(f.other).await.unwrap();
        assert_eq!(
            other.workspace_policy().get().await.unwrap(),
            WorkspacePolicy::default()
        );
        drop(other);
        let mut r = uow.tenant(f.ws).await.unwrap();
        let mut bad = policy;
        bad.inbox_status_labels
            .insert("custom".into(), "Invalid".into());
        assert!(r.workspace_policy().set(bad, FIXED_NOW).await.is_err());
    }
    check(Arc::new(InMemoryUow::new())).await;
    let db = TestDb::new().await;
    check(Arc::new(crate::PgUnitOfWork::new(db.pool.clone()))).await;
}

#[tokio::test]
async fn concurrent_policy_edits_preserve_unrelated_fields() {
    let db = TestDb::new().await;
    let f = Fixture::new(Arc::new(crate::PgUnitOfWork::new(db.pool.clone()))).await;
    // Exercise both an absent policy row and an existing one.
    for interval in [60, 90] {
        let mut first = f.uow.tenant(f.ws).await.unwrap();
        let mut policy = first.workspace_policy().get().await.unwrap();
        policy.agent_checkin_interval_minutes = interval;
        let mut second = f.uow.tenant(f.ws).await.unwrap();
        let mut policy = {
            let pending = second.workspace_policy().get();
            tokio::pin!(pending);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), &mut pending)
                    .await
                    .is_err()
            );
            first
                .workspace_policy()
                .set(policy, FIXED_NOW)
                .await
                .unwrap();
            first.commit().await.unwrap();
            pending.await.unwrap()
        };
        assert_eq!(policy.agent_checkin_interval_minutes, interval);
        policy
            .inbox_status_labels
            .insert("new".into(), "Yeni".into());
        second
            .workspace_policy()
            .set(policy, FIXED_NOW)
            .await
            .unwrap();
        second.commit().await.unwrap();
        let mut read = f.uow.tenant(f.ws).await.unwrap();
        let policy = read.workspace_policy().get().await.unwrap();
        assert_eq!(policy.agent_checkin_interval_minutes, interval);
        assert_eq!(policy.inbox_status_labels["new"], "Yeni");
    }
}
