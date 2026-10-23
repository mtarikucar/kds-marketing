//! Reversible merge use cases exercised unchanged by fake and PostgreSQL tests.
use crate::{
    fakes::{FIXED_NOW, deps},
    inbox_contract::Fixture,
};
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{
        UnitOfWork,
        inbox::{MergeRow, MergeSnapshot},
    },
    usecases::{
        Deps,
        inbox::{merge, tasks},
    },
};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::SystemRole;
use serde_json::json;
use std::sync::Arc;
use time::Duration;

pub struct MergeFixture {
    pub f: Fixture,
    pub deps: Deps,
    pub ctx: Ctx,
    pub keep: Person,
    pub source: Person,
    pub row: MergeRow,
    pub journey: Journey,
    pub older: Conversation,
    pub newer: Conversation,
}
impl MergeFixture {
    pub async fn new(uow: Arc<dyn UnitOfWork>) -> Self {
        let f = Fixture::new(uow.clone()).await;
        let keep = f.insert_person("Keeper").await;
        let source = f.insert_person("Source").await;
        let journey = f.journey(source.id);
        let cap = f.capability().await;
        let mut r = uow.tenant(f.ws).await.unwrap();
        r.people().set_write_time(FIXED_NOW).await.unwrap();
        f.insert_journey(r.as_mut(), &journey).await.unwrap();
        let older = r
            .conversations()
            .upsert_on_inbound(f.conversation(source.id, cap))
            .await
            .unwrap();
        r.conversations()
            .update_state(
                older.id,
                ConvState::Snoozed {
                    until: FIXED_NOW + Duration::days(3),
                },
                None,
            )
            .await
            .unwrap();
        r.conversations()
            .update_executor(
                older.id,
                Executor::Human {
                    user_id: Some(f.user),
                },
            )
            .await
            .unwrap();
        let older = r.conversations().get(older.id).await.unwrap().unwrap();
        r.people()
            .set_write_time(FIXED_NOW + Duration::hours(1))
            .await
            .unwrap();
        let newer = r
            .conversations()
            .upsert_on_inbound(f.conversation(keep.id, cap))
            .await
            .unwrap();
        r.conversations()
            .update_state(newer.id, ConvState::Closed, None)
            .await
            .unwrap();
        let newer = r.conversations().get(newer.id).await.unwrap().unwrap();
        for c in [&older, &newer] {
            let m = f.message(c.id);
            r.messages().insert_if_new(m.clone()).await.unwrap();
            r.outbox()
                .insert(jt_app::ports::inbox::OutboxRow {
                    id: uuid::Uuid::now_v7(),
                    workspace_id: f.ws,
                    conversation_id: c.id,
                    message_id: m.id,
                    capability_id: cap,
                    intent: json!({"text":"Private intent"}),
                    expected_generation: c.executor_generation,
                    fence_snapshot: None,
                    state: "queued".into(),
                    attempts: 0,
                    last_error: None,
                    created_at: FIXED_NOW,
                    updated_at: FIXED_NOW,
                })
                .await
                .unwrap();
        }
        // Inactive duplicate identities must remain inactive and return to the original person.
        for (person, active, channel, value) in [
            (source.id, false, IdentityChannel::Phone, "+905550000000"),
            (keep.id, true, IdentityChannel::Phone, "+905550000000"),
            (
                source.id,
                true,
                IdentityChannel::Email,
                "source@example.test",
            ),
        ] {
            r.identities()
                .insert(Identity {
                    id: IdentityId::new_v7(),
                    workspace_id: f.ws,
                    person_id: person,
                    channel,
                    value_normalized: value.into(),
                    value_display: value.into(),
                    active,
                    first_seen_at: FIXED_NOW,
                })
                .await
                .unwrap();
        }
        r.tasks()
            .insert(Task {
                id: TaskId::new_v7(),
                workspace_id: f.ws,
                journey_id: journey.id,
                title: "Private task".into(),
                due_at: FIXED_NOW,
                assignee: Some(f.user),
                status: TaskStatus::Open,
            })
            .await
            .unwrap();
        r.notes()
            .insert(Note {
                id: NoteId::new_v7(),
                workspace_id: f.ws,
                journey_id: journey.id,
                author: EventSource::Human(f.user),
                text: "Private note".into(),
                at: FIXED_NOW,
            })
            .await
            .unwrap();
        let row = MergeRow {
            id: MergeId::new_v7(),
            workspace_id: f.ws,
            source_id: source.id,
            target_id: keep.id,
            decision: MergeDecision::Suggest(vec![MergeConflict::DisplayName]),
            conflicts: vec![MergeConflict::DisplayName],
            status: "suggested".into(),
            moved_snapshot: json!({}),
            at: FIXED_NOW,
            applied_by: None,
            undone_at: None,
        };
        r.merges().insert(row.clone()).await.unwrap();
        r.commit().await.unwrap();
        let ctx = Ctx {
            workspace_id: f.ws,
            actor: Actor::Human { user_id: f.user },
            permissions: SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now: FIXED_NOW + Duration::hours(2),
            agent_connection_id: None,
        };
        Self {
            f,
            deps: deps(uow),
            ctx,
            keep,
            source,
            row,
            journey,
            older,
            newer,
        }
    }
    pub async fn apply(&self) -> MergeRow {
        merge::apply(
            &self.deps,
            &self.ctx,
            self.row.id,
            merge::ApplyInput { keep: self.keep.id },
        )
        .await
        .unwrap()
    }
    pub async fn undo(&self) -> MergeRow {
        merge::undo(
            &self.deps,
            &self.ctx,
            self.row.id,
            merge::UndoInput { confirm: true },
        )
        .await
        .unwrap()
    }
}
pub async fn merge_snapshot_restores_conversation_collisions(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    // Exercise unbounded mutation snapshots, not the capped message display API.
    for n in 0..501 {
        let mut m = w.f.message(w.older.id);
        m.external_id = Some(format!("extra-{n}"));
        r.messages().insert_if_new(m).await.unwrap();
    }
    r.commit().await.unwrap();
    let row = w.apply().await;
    let saved: MergeSnapshot = serde_json::from_value(row.moved_snapshot).unwrap();
    assert_eq!(saved.messages.len(), 503);
    assert_eq!(saved.tasks.len(), 1);
    assert_eq!(saved.notes.len(), 1);
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert!(r.conversations().get(w.newer.id).await.unwrap().is_none());
    let survivor = r.conversations().get(w.older.id).await.unwrap().unwrap();
    assert_eq!(survivor.person_id, w.keep.id);
    assert_eq!(survivor.state, w.older.state);
    assert_eq!(survivor.executor, w.older.executor);
    assert_eq!(
        r.journeys()
            .get(w.journey.id)
            .await
            .unwrap()
            .unwrap()
            .person_id,
        w.keep.id
    );
    let moved = r.merges().snapshot(w.source.id, w.keep.id).await.unwrap();
    assert_eq!(moved.messages.len(), 503);
    assert_eq!(
        moved
            .messages
            .iter()
            .filter(|m| m.external_id.is_none())
            .count(),
        1
    );
    drop(r);
    let undone = w.undo().await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    let restored = r.merges().snapshot(w.source.id, w.keep.id).await.unwrap();
    assert_eq!(restored.outbox, saved.outbox);
    assert_eq!(saved.outbox.len(), 2);
    assert_eq!(restored.messages, saved.messages);
    assert_eq!(restored.identities, saved.identities);
    assert_eq!(restored.journeys, saved.journeys);
    assert_eq!(restored.tasks, saved.tasks);
    assert_eq!(restored.notes, saved.notes);
    for original in saved.conversations {
        let mut expected = original.clone();
        expected.updated_at = undone.undone_at.unwrap();
        assert_eq!(
            r.conversations().get(original.id).await.unwrap(),
            Some(expected)
        );
    }
    assert!(
        r.people()
            .get(w.source.id)
            .await
            .unwrap()
            .unwrap()
            .merged_into
            .is_none()
    );
}
pub async fn undo_restores_active_identities(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    w.apply().await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert!(r.identities().list(w.source.id).await.unwrap().is_empty());
    assert_eq!(r.identities().list(w.keep.id).await.unwrap().len(), 2);
    drop(r);
    w.undo().await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    let snapshot = r.merges().snapshot(w.source.id, w.keep.id).await.unwrap();
    assert_eq!(
        snapshot
            .identities
            .iter()
            .filter(|i| !i.active && i.person_id == w.source.id)
            .count(),
        1
    );
    assert_eq!(r.identities().list(w.source.id).await.unwrap().len(), 1);
    assert_eq!(r.identities().list(w.keep.id).await.unwrap().len(), 1);
}
pub async fn keeper_first_touch_preserved(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    w.apply().await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.people()
            .get(w.keep.id)
            .await
            .unwrap()
            .unwrap()
            .first_touch,
        w.keep.first_touch
    );
    drop(r);
    w.undo().await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.people()
            .get(w.keep.id)
            .await
            .unwrap()
            .unwrap()
            .first_touch,
        w.keep.first_touch
    );
}
pub async fn undo_requires_confirm(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    w.apply().await;
    let err = merge::undo(
        &w.deps,
        &w.ctx,
        w.row.id,
        merge::UndoInput { confirm: false },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.merges().get(w.row.id).await.unwrap().unwrap().status,
        "applied"
    );
}
pub async fn undo_refuses_after_thirty_days_or_aggregate_edit(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    w.apply().await;
    let mut expired = w.ctx.clone();
    expired.now += Duration::days(30) + Duration::microseconds(1);
    assert_eq!(
        merge::undo(
            &w.deps,
            &expired,
            w.row.id,
            merge::UndoInput { confirm: true }
        )
        .await
        .unwrap_err()
        .details["reason"],
        "undo_expired"
    );
    expired.now -= Duration::microseconds(1);
    merge::undo(
        &w.deps,
        &expired,
        w.row.id,
        merge::UndoInput { confirm: true },
    )
    .await
    .unwrap();
    for kind in ["identity", "message", "executor", "owner", "task", "note"] {
        let w = MergeFixture::new(uow.clone()).await;
        w.apply().await;
        let mut ctx = w.ctx.clone();
        ctx.now += Duration::seconds(1);
        let mut r = uow.tenant(w.f.ws).await.unwrap();
        r.people().set_write_time(ctx.now).await.unwrap();
        match kind {
            "identity" => r
                .identities()
                .insert(Identity {
                    id: IdentityId::new_v7(),
                    workspace_id: w.f.ws,
                    person_id: w.keep.id,
                    channel: IdentityChannel::Email,
                    value_normalized: "new@example.test".into(),
                    value_display: String::new(),
                    active: true,
                    first_seen_at: ctx.now,
                })
                .await
                .unwrap(),
            "message" => {
                let mut m = w.f.message(w.older.id);
                m.external_id = Some("after-merge".into());
                r.messages().insert_if_new(m).await.unwrap();
            }
            "executor" => {
                r.conversations()
                    .update_executor(w.older.id, Executor::Agent)
                    .await
                    .unwrap();
            }
            "owner" => r.journeys().assign_owner(w.journey.id, None).await.unwrap(),
            "task" => {
                let task = r.tasks().list(w.journey.id).await.unwrap().remove(0);
                r.tasks()
                    .set_status(task.id, TaskStatus::Done)
                    .await
                    .unwrap();
            }
            "note" => r
                .notes()
                .insert(Note {
                    id: NoteId::new_v7(),
                    workspace_id: w.f.ws,
                    journey_id: w.journey.id,
                    author: EventSource::System,
                    text: "New note".into(),
                    at: ctx.now,
                })
                .await
                .unwrap(),
            _ => unreachable!(),
        }
        r.commit().await.unwrap();
        let err = merge::undo(&w.deps, &ctx, w.row.id, merge::UndoInput { confirm: true })
            .await
            .unwrap_err();
        assert_eq!(err.details["reason"], "edited_after_merge", "{kind}");
        let mut r = uow.tenant(w.f.ws).await.unwrap();
        assert_eq!(
            r.merges().get(w.row.id).await.unwrap().unwrap().status,
            "applied"
        );
    }
}
pub async fn merge_permissions_tenant_refusal_and_replays(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    let mut ctx = w.ctx.clone();
    ctx.workspace_id = w.f.other;
    assert_eq!(
        merge::apply(
            &w.deps,
            &ctx,
            w.row.id,
            merge::ApplyInput { keep: w.keep.id }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );
    ctx = w.ctx.clone();
    ctx.permissions.remove(&jt_tenancy::Permission::InboxManage);
    assert_eq!(
        merge::list(&w.deps, &ctx).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        merge::refuse(&w.deps, &ctx, w.row.id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        merge::refuse(&w.deps, &w.ctx, w.row.id)
            .await
            .unwrap()
            .status,
        "refused"
    );
    assert_eq!(
        merge::apply(
            &w.deps,
            &w.ctx,
            w.row.id,
            merge::ApplyInput { keep: w.keep.id }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    let w = MergeFixture::new(uow.clone()).await;
    w.apply().await;
    assert_eq!(
        merge::apply(
            &w.deps,
            &w.ctx,
            w.row.id,
            merge::ApplyInput { keep: w.keep.id }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    w.undo().await;
    assert_eq!(
        merge::undo(
            &w.deps,
            &w.ctx,
            w.row.id,
            merge::UndoInput { confirm: true }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    // The task interface remains usable after restore.
    assert_eq!(
        tasks::list(
            &w.deps,
            &w.ctx,
            serde_json::from_value(json!({"queue":"all"})).unwrap()
        )
        .await
        .unwrap()
        .len(),
        1
    );
}

pub async fn later_merge_cannot_erase_an_earlier_edit_guard(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    w.apply().await;
    let third = w.f.insert_person("Third").await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    r.people().set_write_time(w.ctx.now).await.unwrap();
    r.conversations()
        .update_state(w.older.id, ConvState::Theirs, None)
        .await
        .unwrap();
    let mut next = w.row.clone();
    next.id = MergeId::new_v7();
    next.source_id = third.id;
    r.merges().insert(next.clone()).await.unwrap();
    r.commit().await.unwrap();
    let second = merge::apply(
        &w.deps,
        &w.ctx,
        next.id,
        merge::ApplyInput { keep: w.keep.id },
    )
    .await
    .unwrap();
    assert!(second.at > w.ctx.now);
    let err = merge::undo(
        &w.deps,
        &w.ctx,
        w.row.id,
        merge::UndoInput { confirm: true },
    )
    .await
    .unwrap_err();
    assert_eq!(err.details["reason"], "edited_after_merge");
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.conversations()
            .get(w.older.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        ConvState::Theirs
    );
}

pub async fn merge_and_undo_late_failures_roll_back(uow: Arc<dyn UnitOfWork>) {
    let w = MergeFixture::new(uow.clone()).await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    let before = r.merges().snapshot(w.source.id, w.keep.id).await.unwrap();
    drop(r);
    // The actor FK is checked when saving the applied row, after graph mutation.
    let mut bad_actor = w.ctx.clone();
    bad_actor.actor = Actor::Human {
        user_id: jt_tenancy::UserId::new_v7(),
    };
    assert!(
        merge::apply(
            &w.deps,
            &bad_actor,
            w.row.id,
            merge::ApplyInput { keep: w.keep.id }
        )
        .await
        .is_err()
    );
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.merges().snapshot(w.source.id, w.keep.id).await.unwrap(),
        before
    );
    assert_eq!(
        r.merges().get(w.row.id).await.unwrap().unwrap().status,
        "suggested"
    );
    drop(r);
    let mut applied = w.apply().await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    let merged = r.merges().snapshot(w.source.id, w.keep.id).await.unwrap();
    // Simulate a damaged restoration reference: PG discovers this after restoring conversations.
    applied.moved_snapshot["tasks"][0]["id"] = json!(TaskId::new_v7());
    r.merges().save(applied).await.unwrap();
    r.commit().await.unwrap();
    assert!(
        merge::undo(
            &w.deps,
            &w.ctx,
            w.row.id,
            merge::UndoInput { confirm: true }
        )
        .await
        .is_err()
    );
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.merges().snapshot(w.source.id, w.keep.id).await.unwrap(),
        merged
    );
    assert_eq!(
        r.merges().get(w.row.id).await.unwrap().unwrap().status,
        "applied"
    );
    assert_eq!(
        r.people()
            .get(w.source.id)
            .await
            .unwrap()
            .unwrap()
            .merged_into,
        Some(w.keep.id)
    );
}

pub async fn coalescing_refuses_moved_live_outbox_without_undo_resurrection(
    uow: Arc<dyn UnitOfWork>,
) {
    use jt_app::usecases::inbox::replies;
    for state in ["queued", "sending"] {
        let w = MergeFixture::new(uow.clone()).await;
        let mut r = uow.tenant(w.f.ws).await.unwrap();
        let snapshot = r.merges().snapshot(w.source.id, w.keep.id).await.unwrap();
        let moved = snapshot
            .outbox
            .iter()
            .find(|o| o.conversation_id == w.newer.id)
            .unwrap();
        let retained = snapshot
            .outbox
            .iter()
            .find(|o| o.conversation_id == w.older.id)
            .unwrap();
        let mut row = r.outbox().get(moved.id).await.unwrap().unwrap();
        row.state = state.into();
        r.outbox().update(row).await.unwrap();
        r.commit().await.unwrap();
        w.apply().await;
        let mut r = uow.tenant(w.f.ws).await.unwrap();
        let refused = r.outbox().get(moved.id).await.unwrap().unwrap();
        assert_eq!(refused.state, "refused", "{state}");
        assert_eq!(refused.last_error.as_deref(), Some("conversation_merged"));
        assert_eq!(
            r.messages()
                .get(refused.message_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            MsgStatus::Refused {
                reason: "conversation_merged".into()
            }
        );
        assert_eq!(
            r.outbox().get(retained.id).await.unwrap().unwrap().state,
            "queued"
        );
        let ledger = r
            .ledger()
            .list(jt_app::ports::LedgerFilter {
                action_prefix: Some("inbox.reply.result".into()),
                actor_kind: None,
                agent_connection_id: None,
                limit: 10,
                before_id: None,
            })
            .await
            .unwrap();
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].entry.payload["reason"], "conversation_merged");
        drop(r);
        assert_eq!(
            replies::send_step(&w.deps, &w.ctx, moved.id)
                .await
                .unwrap()
                .state,
            "refused"
        );
        assert!(
            !replies::recover_sending(&w.deps, &w.ctx, moved.id)
                .await
                .unwrap()
        );
        w.undo().await;
        let mut r = uow.tenant(w.f.ws).await.unwrap();
        let restored = r.outbox().get(moved.id).await.unwrap().unwrap();
        assert_eq!(restored.conversation_id, w.newer.id);
        assert_eq!(restored.state, "refused");
        assert_eq!(
            r.messages()
                .get(restored.message_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            MsgStatus::Refused {
                reason: "conversation_merged".into()
            }
        );
    }
}
