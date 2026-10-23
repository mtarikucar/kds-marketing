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
    r.people().set_write_time(FIXED_NOW).await.unwrap();
    f.insert_journey(r.as_mut(), &j).await.unwrap();
    r.conversations()
        .upsert_on_inbound(conv.clone())
        .await
        .unwrap();
    let assigned_at = FIXED_NOW + time::Duration::seconds(30);
    r.people().set_write_time(assigned_at).await.unwrap();
    r.journeys().assign_owner(j.id, None).await.unwrap();
    let assigned = r.journeys().get(j.id).await.unwrap().unwrap();
    assert_eq!(assigned.owner, None);
    assert_eq!(assigned.status, JourneyStatus::New);
    assert_eq!(assigned.updated_at, assigned_at);
    assert_eq!(
        r.people().get(p.id).await.unwrap().unwrap().updated_at,
        assigned_at
    );
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
async fn bounded_journey_events_fake_and_pg() {
    async fn check(uow: Arc<dyn UnitOfWork>) {
        let f = Fixture::new(uow.clone()).await;
        let p = f.insert_person("Event history").await;
        let mut journey = f.journey(p.id);
        let mut r = uow.tenant(f.ws).await.unwrap();
        r.people().set_write_time(FIXED_NOW).await.unwrap();
        f.insert_journey(r.as_mut(), &journey).await.unwrap();
        let mut expected = Vec::new();
        // Equal timestamps and reversed IDs make insertion order an invalid tie-breaker.
        for index in 0..505_u128 {
            let mut event = f.event(
                journey.id,
                &format!("bounded-{index}"),
                JourneyEventKind::MeetingHeld,
            );
            event.id = uuid::Uuid::from_u128(505 - index).into();
            event.at = FIXED_NOW + time::Duration::seconds((index / 100) as i64);
            let transition = reduce(&journey, &event, &ReducePolicy::default()).unwrap();
            journey.status = transition.to();
            journey.updated_at = event.at;
            r.journeys()
                .apply_transition(journey.id, transition, event.clone())
                .await
                .unwrap();
            expected.push(event);
        }
        expected.sort_by_key(|event| (event.at, event.id));
        for (limit, count) in [(0, 1), (1, 1), (50, 50), (500, 500), (u32::MAX, 500)] {
            assert_eq!(
                r.journeys().events(journey.id, limit).await.unwrap(),
                expected[expected.len() - count..],
                "limit {limit} must retain the newest events in chronological order"
            );
        }
        assert!(
            r.journeys()
                .events(jt_inbox::JourneyId::new_v7(), 50)
                .await
                .unwrap()
                .is_empty()
        );
        r.commit().await.unwrap();
        let mut foreign = uow.tenant(f.other).await.unwrap();
        assert!(
            foreign
                .journeys()
                .events(journey.id, 50)
                .await
                .unwrap()
                .is_empty()
        );
        drop(foreign);
        let ctx = Ctx {
            workspace_id: f.ws,
            actor: Actor::Human { user_id: f.user },
            permissions: SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now: FIXED_NOW,
            agent_connection_id: None,
        };
        let result = journeys::get(&deps(uow), &ctx, journey.id).await.unwrap();
        assert_eq!(result.events, expected[expected.len() - 50..]);
    }
    check(Arc::new(InMemoryUow::new())).await;
    let db = TestDb::new().await;
    check(Arc::new(crate::PgUnitOfWork::new(db.pool.clone()))).await;
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
    let original_task = TaskId::new_v7();
    r.tasks()
        .insert(Task {
            id: original_task,
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
    assert_eq!(r.journeys().events(j.id, 50).await.unwrap().len(), 1);
    let tasks = r.tasks().list(j.id).await.unwrap();
    assert_eq!(tasks.len(), 2);
    assert_eq!(
        tasks.iter().find(|t| t.id == original_task).unwrap().status,
        TaskStatus::Done
    );
    let commissions = r.commissions().list().await.unwrap();
    assert_eq!(commissions.len(), 1);
    let commission = &commissions[0];
    assert_eq!(commission.commission.journey_id, j.id);
    assert_eq!(
        commission.commission.state,
        jt_inbox::CommissionState::NoPayee
    );
    assert_eq!(commission.commission.payee, None);
    let followup = tasks
        .iter()
        .find(|t| t.id == TaskId::from(commission.id))
        .unwrap();
    assert_eq!(followup.status, TaskStatus::Open);
    assert_eq!(followup.assignee, None);
}

#[tokio::test]
async fn status_labels_policy_contract_fake_and_pg() {
    use jt_app::ports::WorkspacePolicy;
    async fn check(uow: Arc<dyn UnitOfWork>) {
        let f = Fixture::new(uow.clone()).await;
        let policy = WorkspacePolicy {
            agent_checkin_interval_minutes: 60,
            inbox: jt_app::ports::InboxPolicy {
                status_labels: [("new".into(), "Yeni".into())].into(),
                unreachable_threshold: 5,
                max_response_s: [("sms".into(), 42)].into(),
            },
        };
        let mut r = uow.tenant(f.ws).await.unwrap();
        assert!(
            r.workspace_policy()
                .get()
                .await
                .unwrap()
                .inbox
                .status_labels
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
            .inbox
            .status_labels
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
        bad.inbox
            .status_labels
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
            .inbox
            .status_labels
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
        assert_eq!(policy.inbox.status_labels["new"], "Yeni");
    }
}

#[tokio::test]
async fn child_writes_advance_aggregate_timestamps() {
    use jt_app::ports::TenantRepos;
    use jt_inbox::*;
    use time::OffsetDateTime;
    async fn stamps(
        r: &mut dyn TenantRepos,
        p: PersonId,
        c: ConversationId,
        j: JourneyId,
    ) -> (OffsetDateTime, OffsetDateTime, OffsetDateTime) {
        (
            r.people().get(p).await.unwrap().unwrap().updated_at,
            r.conversations().get(c).await.unwrap().unwrap().updated_at,
            r.journeys().get(j).await.unwrap().unwrap().updated_at,
        )
    }
    async fn check(uow: Arc<dyn UnitOfWork>) {
        let f = Fixture::new(uow.clone()).await;
        let p = f.insert_person("Aggregate").await;
        let target = f.insert_person("Identity destination").await;
        let capability = f.capability().await;
        let conversation = f.conversation(p.id, capability);
        let journey = f.journey(p.id);
        let mut r = uow.tenant(f.ws).await.unwrap();
        // All mutations intentionally share the same clock, so each must still advance.
        r.people().set_write_time(FIXED_NOW).await.unwrap();
        f.insert_journey(r.as_mut(), &journey).await.unwrap();
        assert!(r.people().get(p.id).await.unwrap().unwrap().updated_at > p.updated_at);
        let after_journey = r.people().get(p.id).await.unwrap().unwrap().updated_at;
        r.conversations()
            .upsert_on_inbound(conversation.clone())
            .await
            .unwrap();
        assert!(r.people().get(p.id).await.unwrap().unwrap().updated_at > after_journey);
        let mut before = stamps(r.as_mut(), p.id, conversation.id, journey.id).await;
        macro_rules! advanced {
            ($conversation:expr, $journey:expr) => {{
                let after = stamps(r.as_mut(), p.id, conversation.id, journey.id).await;
                assert!(after.0 > before.0, "person timestamp must advance");
                if $conversation {
                    assert!(after.1 > before.1, "conversation timestamp must advance");
                } else {
                    assert_eq!(after.1, before.1);
                }
                if $journey {
                    assert!(after.2 > before.2, "journey timestamp must advance");
                } else {
                    assert_eq!(after.2, before.2);
                }
                before = after;
            }};
        }
        r.identities()
            .insert(Identity {
                id: IdentityId::new_v7(),
                workspace_id: f.ws,
                person_id: p.id,
                channel: IdentityChannel::Email,
                value_normalized: "timestamp@example.test".into(),
                value_display: "timestamp@example.test".into(),
                active: true,
                first_seen_at: FIXED_NOW,
            })
            .await
            .unwrap();
        advanced!(false, false);
        r.identities().move_to(p.id, target.id).await.unwrap();
        advanced!(false, false);
        assert!(r.people().get(target.id).await.unwrap().unwrap().updated_at > target.updated_at);
        r.identities().move_to(target.id, p.id).await.unwrap();
        advanced!(false, false);
        r.identities().deactivate_for(p.id).await.unwrap();
        advanced!(false, false);
        r.conversations()
            .update_state(conversation.id, ConvState::Ours, None)
            .await
            .unwrap();
        advanced!(true, false);
        r.conversations()
            .update_executor(conversation.id, Executor::Agent)
            .await
            .unwrap();
        advanced!(true, false);
        let mut repeated = conversation.clone();
        repeated.created_at = FIXED_NOW + time::Duration::days(1);
        let reopened = r.conversations().upsert_on_inbound(repeated).await.unwrap();
        assert_eq!(reopened.created_at, conversation.created_at);
        advanced!(true, false);
        let message = f.message(conversation.id);
        r.messages().insert_if_new(message.clone()).await.unwrap();
        advanced!(true, false);
        assert!(
            r.messages()
                .insert_if_new(message.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            stamps(r.as_mut(), p.id, conversation.id, journey.id).await,
            before
        );
        r.messages()
            .set_status(message.id, MsgStatus::Received, None, None)
            .await
            .unwrap();
        advanced!(true, false);
        r.journeys()
            .assign_owner(journey.id, journey.owner)
            .await
            .unwrap();
        advanced!(false, true);
        let event = f.event(
            journey.id,
            "timestamp-transition",
            JourneyEventKind::MeetingHeld,
        );
        let current = r.journeys().get(journey.id).await.unwrap().unwrap();
        let transition = reduce(&current, &event, &ReducePolicy::default()).unwrap();
        r.journeys()
            .apply_transition(journey.id, transition, event)
            .await
            .unwrap();
        advanced!(false, true);
        let task = Task {
            id: TaskId::new_v7(),
            workspace_id: f.ws,
            journey_id: journey.id,
            title: "Call".into(),
            due_at: FIXED_NOW,
            assignee: None,
            status: TaskStatus::Open,
        };
        r.tasks().insert(task.clone()).await.unwrap();
        advanced!(false, true);
        r.tasks()
            .set_status(task.id, TaskStatus::Open)
            .await
            .unwrap();
        advanced!(false, true);
        r.notes()
            .insert(Note {
                id: NoteId::new_v7(),
                workspace_id: f.ws,
                journey_id: journey.id,
                author: EventSource::System,
                text: "Follow up".into(),
                at: FIXED_NOW,
            })
            .await
            .unwrap();
        advanced!(false, true);
        r.commit().await.unwrap();
        let mut rolled_back = uow.tenant(f.ws).await.unwrap();
        rolled_back
            .people()
            .set_write_time(FIXED_NOW + time::Duration::days(1))
            .await
            .unwrap();
        rolled_back
            .tasks()
            .set_status(task.id, TaskStatus::Done)
            .await
            .unwrap();
        rolled_back
            .messages()
            .set_status(message.id, MsgStatus::Delivered, None, None)
            .await
            .unwrap();
        drop(rolled_back);
        let mut r = uow.tenant(f.ws).await.unwrap();
        assert_eq!(
            stamps(r.as_mut(), p.id, conversation.id, journey.id).await,
            before
        );
        assert_eq!(
            r.tasks().get(task.id).await.unwrap().unwrap().status,
            TaskStatus::Open
        );
    }
    check(Arc::new(InMemoryUow::new())).await;
    let db = TestDb::new().await;
    check(Arc::new(crate::PgUnitOfWork::new(db.pool.clone()))).await;
}

#[tokio::test]
async fn task_queries_boundaries_assignees_and_unbounded_all_fake_and_pg() {
    use jt_app::ports::inbox::TaskQueue;
    use time::Duration;
    async fn check(uow: Arc<dyn UnitOfWork>) {
        let f = Fixture::new(uow.clone()).await;
        let p = f.insert_person("Task queues").await;
        let journey = f.journey(p.id);
        let mut r = uow.tenant(f.ws).await.unwrap();
        r.people().set_write_time(FIXED_NOW).await.unwrap();
        f.insert_journey(r.as_mut(), &journey).await.unwrap();
        let mut tasks = Vec::new();
        for index in 0..511_u128 {
            let task = Task {
                // Reverse IDs ensure equal due times sort independently of insertion order.
                id: uuid::Uuid::from_u128(511 - index).into(),
                workspace_id: f.ws,
                journey_id: journey.id,
                title: format!("Task {index}"),
                due_at: match index {
                    0 => FIXED_NOW - Duration::microseconds(1),
                    1 | 4 | 5 => FIXED_NOW,
                    2 => FIXED_NOW + Duration::hours(24),
                    3 => FIXED_NOW + Duration::hours(24) + Duration::microseconds(1),
                    _ => FIXED_NOW + Duration::hours(48),
                },
                assignee: matches!(index, 1 | 3 | 4 | 5).then_some(f.user),
                status: match index {
                    4 => TaskStatus::Done,
                    5 => TaskStatus::Cancelled,
                    _ => TaskStatus::Open,
                },
            };
            r.tasks().insert(task.clone()).await.unwrap();
            tasks.push(task);
        }
        for index in [0, 1, 4, 5, 510] {
            assert_eq!(
                r.tasks().get(tasks[index].id).await.unwrap(),
                Some(tasks[index].clone())
            );
        }
        assert!(r.tasks().get(TaskId::new_v7()).await.unwrap().is_none());
        assert_eq!(
            r.tasks()
                .query(TaskQueue::Overdue, None, FIXED_NOW)
                .await
                .unwrap(),
            vec![tasks[0].clone()]
        );
        assert_eq!(
            r.tasks()
                .query(TaskQueue::Due24h, None, FIXED_NOW)
                .await
                .unwrap(),
            vec![tasks[1].clone(), tasks[2].clone()]
        );
        assert_eq!(
            r.tasks()
                .query(TaskQueue::Due24h, Some(f.user), FIXED_NOW)
                .await
                .unwrap(),
            vec![tasks[1].clone()]
        );
        assert!(
            r.tasks()
                .query(TaskQueue::Overdue, Some(f.user), FIXED_NOW)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            r.tasks()
                .query(TaskQueue::All, Some(f.user), FIXED_NOW)
                .await
                .unwrap(),
            vec![tasks[1].clone(), tasks[3].clone()]
        );
        let mut all = tasks[..4].to_vec();
        all.extend_from_slice(&tasks[6..]);
        all.sort_by_key(|task| (task.due_at, task.id));
        assert_eq!(all.len(), 509);
        assert_eq!(
            r.tasks()
                .query(TaskQueue::All, None, FIXED_NOW)
                .await
                .unwrap(),
            all
        );
        r.commit().await.unwrap();
        let mut foreign = uow.tenant(f.other).await.unwrap();
        assert!(foreign.tasks().get(tasks[1].id).await.unwrap().is_none());
        for queue in [TaskQueue::Overdue, TaskQueue::Due24h, TaskQueue::All] {
            assert!(
                foreign
                    .tasks()
                    .query(queue, None, FIXED_NOW)
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(
                foreign
                    .tasks()
                    .query(queue, Some(f.user), FIXED_NOW)
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
    }
    check(Arc::new(InMemoryUow::new())).await;
    let db = TestDb::new().await;
    check(Arc::new(crate::PgUnitOfWork::new(db.pool.clone()))).await;
}
