mod support;
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::inbox::{dictionaries, journeys, people},
};
use jt_inbox::{JourneyId, JourneyStatus, Task, TaskId, TaskStatus};
use jt_tenancy::Permission;
use serde_json::json;
use support::*;

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
fn event(kind: &str, key: &str, payload: serde_json::Value) -> journeys::ReportInput {
    serde_json::from_value(json!({"kind":kind,"idempotency_key":key,"payload":payload})).unwrap()
}
async fn lose(w: &World, id: JourneyId) {
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        id,
        event("lost", "lost-1", json!({"reason_key":"fiyat"})),
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn open_refuses_latest_lost() {
    let (w, id) = setup().await;
    let p = w.uow.snapshot().inbox.journeys[0].person_id;
    assert_eq!(
        journeys::open(&w.deps, &w.owner_ctx, p)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    lose(&w, id).await;
    let e = journeys::open(&w.deps, &w.owner_ctx, p).await.unwrap_err();
    assert_eq!(e.details["reason"], "reopen_required");
}
#[tokio::test]
async fn duplicate_suppresses_effects() {
    let (w, id) = setup().await;
    let task = Task {
        id: TaskId::new_v7(),
        workspace_id: w.ws,
        journey_id: id,
        title: "Call".into(),
        due_at: w.owner_ctx.now,
        assignee: None,
        status: TaskStatus::Open,
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.tasks().insert(task.clone()).await.unwrap();
    r.commit().await.unwrap();
    lose(&w, id).await;
    assert_eq!(
        w.uow.snapshot().inbox.tasks[0].status,
        TaskStatus::Cancelled
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.tasks()
        .set_status(task.id, TaskStatus::Open)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let out = journeys::report(
        &w.deps,
        &w.owner_ctx,
        id,
        event("lost", "lost-1", json!({"reason_key":"fiyat"})),
    )
    .await
    .unwrap();
    assert!(out.duplicate);
    assert!(out.effects.is_empty());
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.tasks[0].status, TaskStatus::Open);
    assert_eq!(s.inbox.events.len(), 1);
    assert!(
        s.ledger
            .iter()
            .any(|e| e.entry.action.as_str() == "inbox.event.duplicate")
    );
}
#[tokio::test]
async fn external_system_event_or_missing_key_rejected() {
    let (w, id) = setup().await;
    for kind in ["replied", "message_received", "quote_sent", "merged"] {
        assert_eq!(
            journeys::report(&w.deps, &w.owner_ctx, id, event(kind, "key", json!({})))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
    }
    let missing = serde_json::from_value(json!({"kind":"meeting_held","payload":{}})).unwrap();
    assert_eq!(
        journeys::report(&w.deps, &w.owner_ctx, id, missing)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    assert!(w.uow.snapshot().inbox.events.is_empty());
}
#[tokio::test]
async fn lost_label_survives_relabel() {
    let (w, id) = setup().await;
    lose(&w, id).await;
    dictionaries::set_lost_reason(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"key":"fiyat","label":"Price changed","active":true}))
            .unwrap(),
    )
    .await
    .unwrap();
    let out = journeys::get(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(out.journey.lost_reason.unwrap().reason_label, "Fiyat");
    assert_eq!(out.events[0].reason_label.as_deref(), Some("Fiyat"));
}
#[tokio::test]
async fn reopen_needs_manage_and_role() {
    let (w, id) = setup().await;
    lose(&w, id).await;
    let mut ctx = w.owner_ctx.clone();
    ctx.permissions.remove(&Permission::InboxManage);
    assert_eq!(
        journeys::report(&w.deps, &ctx, id, event("reopened", "r", json!({})))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    ctx.permissions.insert(Permission::InboxManage);
    ctx.role_key = Some("rep".into());
    assert_eq!(
        journeys::report(&w.deps, &ctx, id, event("reopened", "r", json!({})))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    journeys::report(&w.deps, &w.owner_ctx, id, event("reopened", "r", json!({})))
        .await
        .unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Contacted
    );
}
#[tokio::test]
async fn second_won_new_key_is_terminal() {
    let (w, id) = setup().await;
    let payload = json!({"product":"Plan","amount_minor":100,"currency":"TRY"});
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        id,
        event("won", "w1", payload.clone()),
    )
    .await
    .unwrap();
    assert!(
        journeys::report(
            &w.deps,
            &w.owner_ctx,
            id,
            event("won", "w1", payload.clone())
        )
        .await
        .unwrap()
        .duplicate
    );
    let e = journeys::report(&w.deps, &w.owner_ctx, id, event("won", "w2", payload))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "terminal");
    let p = w.uow.snapshot().inbox.journeys[0].person_id;
    let new = journeys::open(&w.deps, &w.owner_ctx, p).await.unwrap();
    assert_eq!(new.source, jt_inbox::Source::Repeat);
}

#[tokio::test]
async fn report_effect_failure_rolls_back() {
    let (w, id) = setup().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.tasks()
        .insert(Task {
            id: TaskId::new_v7(),
            workspace_id: w.ws,
            journey_id: id,
            title: "Call".into(),
            due_at: w.owner_ctx.now,
            assignee: None,
            status: TaskStatus::Open,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let before = w.uow.snapshot();
    w.uow.fail_inbox_task_status(1);
    let err = journeys::report(
        &w.deps,
        &w.owner_ctx,
        id,
        event("lost", "rollback", json!({"reason_key":"fiyat"})),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.journeys, before.inbox.journeys);
    assert_eq!(after.inbox.tasks, before.inbox.tasks);
    assert_eq!(after.inbox.events, before.inbox.events);
    assert_eq!(after.ledger.len(), before.ledger.len());
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        id,
        event("lost", "rollback", json!({"reason_key":"fiyat"})),
    )
    .await
    .unwrap();
}

#[test]
fn status_labels_cannot_add_status() {
    let labels: dictionaries::StatusLabelsInput =
        serde_json::from_value(json!({"labels":{"custom_stage":"Custom"}})).unwrap();
    assert_eq!(labels.validate().unwrap_err().code, ErrorCode::Validation);
    let labels: dictionaries::StatusLabelsInput =
        serde_json::from_value(json!({"labels":{"new":"Yeni","won":"Kazanıldı"}})).unwrap();
    assert!(labels.validate().is_ok());
}

#[tokio::test]
async fn status_labels_require_manage_preserve_policy_and_ledger_only_keys() {
    use jt_app::ports::WorkspacePolicy;
    let w = world().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.workspace_policy()
        .set(
            WorkspacePolicy {
                agent_checkin_interval_minutes: 60,
                ..WorkspacePolicy::default()
            },
            w.owner_ctx.now,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let input = || serde_json::from_value(json!({"labels":{"new":"Private label"}})).unwrap();
    let mut rep = w.owner_ctx.clone();
    rep.permissions.remove(&Permission::InboxManage);
    assert_eq!(
        dictionaries::set_status_labels(&w.deps, &rep, input())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    let output = dictionaries::set_status_labels(&w.deps, &w.owner_ctx, input())
        .await
        .unwrap();
    assert_eq!(output.labels["new"], "Private label");
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let stored = r.workspace_policy().get().await.unwrap();
    assert_eq!(stored.agent_checkin_interval_minutes, 60);
    assert_eq!(stored.inbox.status_labels, output.labels);
    drop(r);
    let bad = serde_json::from_value(json!({"labels":{"custom":"bad"}})).unwrap();
    assert_eq!(
        dictionaries::set_status_labels(&w.deps, &w.owner_ctx, bad)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    let s = w.uow.snapshot();
    let entries: Vec<_> = s
        .ledger
        .iter()
        .filter(|r| r.entry.action.as_str() == "inbox.status_labels.set")
        .collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].entry.payload, json!({"keys":["new"]}));
    let empty = serde_json::from_value(json!({"labels":{}})).unwrap();
    dictionaries::set_status_labels(&w.deps, &w.owner_ctx, empty)
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        r.workspace_policy()
            .get()
            .await
            .unwrap()
            .inbox
            .status_labels
            .is_empty()
    );
}
