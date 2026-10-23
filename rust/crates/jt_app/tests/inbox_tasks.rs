mod support;

use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, inbox::TaskQueue},
    usecases::inbox::{people, tasks},
};
use jt_inbox::{EventSource, JourneyId, Task, TaskStatus};
use jt_ledger::Actor;
use jt_tenancy::{Permission, UserId};
use serde_json::json;
use support::*;
use time::Duration;

async fn setup() -> (World, JourneyId) {
    let w = world().await;
    let p = people::create(&w.deps, &w.owner_ctx, serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})).unwrap()).await.unwrap();
    let id = w
        .uow
        .tenant(w.ws)
        .await
        .unwrap()
        .journeys()
        .open_for(p.person.id)
        .await
        .unwrap()
        .unwrap()
        .id;
    (w, id)
}

fn input(w: &World) -> tasks::CreateInput {
    tasks::CreateInput {
        title: "Private follow-up title".into(),
        due_at: w.owner_ctx.now,
        assignee: None,
    }
}

async fn queue(w: &World, queue: TaskQueue, assignee: Option<UserId>) -> Vec<Task> {
    tasks::list(&w.deps, &w.owner_ctx, tasks::ListInput { queue, assignee })
        .await
        .unwrap()
}

#[tokio::test]
async fn tasks_due_24h_overdue_all_boundaries() {
    let (w, journey) = setup().await;
    let mut ids = vec![];
    for offset in [-1, 0, 86_400, 86_401] {
        let mut i = input(&w);
        i.due_at += Duration::seconds(offset);
        ids.push(
            tasks::create(&w.deps, &w.owner_ctx, journey, i)
                .await
                .unwrap()
                .id,
        );
    }
    let due = queue(&w, TaskQueue::Due24h, None).await;
    assert_eq!(due.iter().map(|t| t.id).collect::<Vec<_>>(), ids[1..3]);
    assert_eq!(
        queue(&w, TaskQueue::Overdue, None)
            .await
            .iter()
            .map(|t| t.id)
            .collect::<Vec<_>>(),
        vec![ids[0]]
    );
    assert_eq!(queue(&w, TaskQueue::All, None).await.len(), 4);
    tasks::complete(&w.deps, &w.owner_ctx, ids[1])
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.tasks()
        .set_status(ids[0], TaskStatus::Cancelled)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert!(queue(&w, TaskQueue::Overdue, None).await.is_empty());
    assert_eq!(queue(&w, TaskQueue::Due24h, None).await[0].id, ids[2]);
    assert_eq!(queue(&w, TaskQueue::All, None).await.len(), 2);
    let default: tasks::ListInput = serde_json::from_value(json!({})).unwrap();
    assert_eq!(
        tasks::list(&w.deps, &w.owner_ctx, default)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn notes_never_in_ledger_payload() {
    let (w, journey) = setup().await;
    let ctx = at(
        &w.owner_ctx,
        w.uow.snapshot().inbox.people[0].updated_at + Duration::hours(1),
    );
    let note = tasks::add_note(
        &w.deps,
        &ctx,
        journey,
        tasks::NoteInput {
            text: "Private health note".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(note.text, "Private health note");
    assert_eq!(note.author, EventSource::Human(w.owner));
    assert_eq!(note.at, ctx.now);
    let snapshot = w.uow.snapshot();
    assert_eq!(snapshot.inbox.notes, vec![note]);
    assert_eq!(snapshot.inbox.journeys[0].updated_at, ctx.now);
    assert_eq!(snapshot.inbox.people[0].updated_at, ctx.now);
    let entries = w.entries("inbox.note.added");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].payload, json!({"journey_id":journey}));
    assert!(!wire(&entries).contains("Private health note"));
    let task = tasks::create(&w.deps, &ctx, journey, input(&w))
        .await
        .unwrap();
    let entries = w.entries("inbox.task.created");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].payload["journey_id"], json!(journey));
    assert!(!wire(&entries).contains(&task.title));
}

#[tokio::test]
async fn tasks_and_notes_require_inbox_work() {
    let (w, journey) = setup().await;
    let task = tasks::create(&w.deps, &w.owner_ctx, journey, input(&w))
        .await
        .unwrap();
    let mut ctx = w.owner_ctx.clone();
    ctx.permissions.remove(&Permission::InboxWork);
    assert_forbidden(
        &err(tasks::create(&w.deps, &ctx, journey, input(&w)).await),
        "inbox.work",
    );
    assert_forbidden(
        &err(tasks::complete(&w.deps, &ctx, task.id).await),
        "inbox.work",
    );
    assert_forbidden(
        &err(tasks::list(
            &w.deps,
            &ctx,
            tasks::ListInput {
                queue: TaskQueue::All,
                assignee: None,
            },
        )
        .await),
        "inbox.work",
    );
    assert_forbidden(
        &err(tasks::add_note(
            &w.deps,
            &ctx,
            journey,
            tasks::NoteInput {
                text: "note".into(),
            },
        )
        .await),
        "inbox.work",
    );
    assert_eq!(w.uow.snapshot().inbox.tasks[0].status, TaskStatus::Open);
    assert!(w.uow.snapshot().inbox.notes.is_empty());
}

#[tokio::test]
async fn tasks_and_notes_hide_other_tenant_targets() {
    let (w, journey) = setup().await;
    let task = tasks::create(&w.deps, &w.owner_ctx, journey, input(&w))
        .await
        .unwrap();
    let (_, other) = w.other_workspace().await;
    let before = w.uow.snapshot();
    assert_eq!(
        err(tasks::create(&w.deps, &other, journey, input(&w)).await).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(tasks::complete(&w.deps, &other, task.id).await).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(tasks::add_note(
            &w.deps,
            &other,
            journey,
            tasks::NoteInput {
                text: "note".into()
            }
        )
        .await)
        .code,
        ErrorCode::NotFound
    );
    assert!(
        tasks::list(
            &w.deps,
            &other,
            tasks::ListInput {
                queue: TaskQueue::All,
                assignee: None
            }
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert_eq!(w.uow.snapshot().inbox.tasks, before.inbox.tasks);
    assert_eq!(w.uow.snapshot().ledger.len(), before.ledger.len());
}

#[tokio::test]
async fn task_assignee_must_be_active_member_and_filters_queue() {
    let (w, journey) = setup().await;
    let (_, other) = w.other_workspace().await;
    let foreign = match other.actor {
        Actor::Human { user_id } => user_id,
        _ => unreachable!(),
    };
    let member = w.member("rep").await;
    let member_id = match member.actor {
        Actor::Human { user_id } => user_id,
        _ => unreachable!(),
    };
    let mut i = input(&w);
    i.assignee = Some(member_id);
    let task = tasks::create(&w.deps, &w.owner_ctx, journey, i)
        .await
        .unwrap();
    tasks::create(&w.deps, &w.owner_ctx, journey, input(&w))
        .await
        .unwrap();
    assert_eq!(queue(&w, TaskQueue::All, Some(member_id)).await, vec![task]);
    assert!(queue(&w, TaskQueue::All, Some(w.owner)).await.is_empty());
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let membership = r
        .memberships()
        .find_by_user(member_id)
        .await
        .unwrap()
        .unwrap();
    r.memberships().remove(membership.id).await.unwrap();
    r.commit().await.unwrap();
    for invalid in [foreign, member_id, UserId::new_v7()] {
        let mut i = input(&w);
        i.assignee = Some(invalid);
        assert_eq!(
            err(tasks::create(&w.deps, &w.owner_ctx, journey, i).await).code,
            ErrorCode::NotFound
        );
    }
    assert_eq!(w.uow.snapshot().inbox.tasks.len(), 2);
}

#[tokio::test]
async fn task_completion_is_idempotent_and_cannot_revive_cancelled_work() {
    let (w, journey) = setup().await;
    let task = tasks::create(&w.deps, &w.owner_ctx, journey, input(&w))
        .await
        .unwrap();
    let ctx = at(
        &w.owner_ctx,
        w.uow.snapshot().inbox.people[0].updated_at + Duration::hours(2),
    );
    let done = tasks::complete(&w.deps, &ctx, task.id).await.unwrap();
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(w.uow.snapshot().inbox.tasks[0], done);
    assert_eq!(w.uow.snapshot().inbox.journeys[0].updated_at, ctx.now);
    assert_eq!(w.uow.snapshot().inbox.people[0].updated_at, ctx.now);
    assert_eq!(tasks::complete(&w.deps, &ctx, task.id).await.unwrap(), done);
    assert_eq!(w.entries("inbox.task.completed").len(), 1);
    let cancelled = tasks::create(&w.deps, &ctx, journey, input(&w))
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.tasks()
        .set_status(cancelled.id, TaskStatus::Cancelled)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        err(tasks::complete(&w.deps, &ctx, cancelled.id).await).code,
        ErrorCode::Conflict
    );
}

#[tokio::test]
async fn blank_titles_and_notes_are_rejected_without_writes() {
    let (w, journey) = setup().await;
    let mut i = input(&w);
    i.title = " \n\t ".into();
    assert_invalid(
        &err(tasks::create(&w.deps, &w.owner_ctx, journey, i).await),
        "title",
    );
    assert_invalid(
        &err(tasks::add_note(
            &w.deps,
            &w.owner_ctx,
            journey,
            tasks::NoteInput {
                text: " \n\t ".into(),
            },
        )
        .await),
        "text",
    );
    assert!(w.uow.snapshot().inbox.tasks.is_empty());
    assert!(w.uow.snapshot().inbox.notes.is_empty());
}

#[test]
fn task_and_note_inputs_reject_unknown_fields() {
    assert!(
        serde_json::from_value::<tasks::CreateInput>(
            json!({"title":"Call","due_at":"2026-10-23T12:00:00Z","status":"done"})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<tasks::NoteInput>(json!({"text":"Note","author":"system"}))
            .is_err()
    );
    assert!(
        serde_json::from_value::<tasks::ListInput>(
            json!({"queue":"all","workspace_id":"elsewhere"})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<tasks::ListInput>(json!({"queue":"unknown"})).is_err());
}

#[tokio::test]
async fn failed_task_completion_rolls_back_status_and_ledger() {
    let (w, journey) = setup().await;
    let task = tasks::create(&w.deps, &w.owner_ctx, journey, input(&w))
        .await
        .unwrap();
    let before = w.uow.snapshot();
    w.uow.fail_inbox_task_status(1);
    assert_eq!(
        err(tasks::complete(&w.deps, &w.owner_ctx, task.id).await).code,
        ErrorCode::Internal
    );
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.tasks, before.inbox.tasks);
    assert_eq!(after.inbox.journeys, before.inbox.journeys);
    assert_eq!(after.inbox.people, before.inbox.people);
    assert_eq!(after.ledger.len(), before.ledger.len());
    assert_eq!(
        tasks::complete(&w.deps, &w.owner_ctx, task.id)
            .await
            .unwrap()
            .status,
        TaskStatus::Done
    );
}

#[tokio::test]
async fn note_author_comes_from_calling_principal() {
    let (w, journey) = setup().await;
    let agent = w.agent(&["inbox.work"]).await;
    let note = tasks::add_note(
        &w.deps,
        &agent,
        journey,
        tasks::NoteInput {
            text: "Agent observation".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(note.author, EventSource::Agent);
    let mut system = w.owner_ctx.clone();
    system.actor = Actor::System {
        component: "inbox-worker".into(),
    };
    let note = tasks::add_note(
        &w.deps,
        &system,
        journey,
        tasks::NoteInput {
            text: "System observation".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(note.author, EventSource::System);
}

#[tokio::test]
async fn creating_task_updates_aggregate_at_the_supplied_time() {
    let (w, journey) = setup().await;
    let ctx = at(
        &w.owner_ctx,
        w.uow.snapshot().inbox.people[0].updated_at + Duration::hours(3),
    );
    let task = tasks::create(&w.deps, &ctx, journey, input(&w))
        .await
        .unwrap();
    assert_eq!(task.workspace_id, w.ws);
    assert_eq!(task.journey_id, journey);
    assert_eq!(task.status, TaskStatus::Open);
    let snapshot = w.uow.snapshot();
    assert_eq!(snapshot.inbox.journeys[0].updated_at, ctx.now);
    assert_eq!(snapshot.inbox.people[0].updated_at, ctx.now);
    assert_eq!(snapshot.inbox.tasks[0], task);
}
