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
                    conversation_merged: false,
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

pub async fn coalescing_refuses_moved_queued_outbox_without_undo_resurrection(
    uow: Arc<dyn UnitOfWork>,
) {
    use jt_app::usecases::inbox::replies;
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
    row.state = "queued".into();
    r.outbox().update(row).await.unwrap();
    r.commit().await.unwrap();
    w.apply().await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    let refused = r.outbox().get(moved.id).await.unwrap().unwrap();
    assert_eq!(refused.state, "refused");
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

/// Provider I/O is already underway when a merge moves the outbound message.
/// Reconciliation must preserve the receipt, request response and journey effect, without
/// touching either the survivor or a conversation restored by undo.
pub async fn merge_during_provider_io_reconciles_without_conversation_effects(
    uow: Arc<dyn UnitOfWork>,
) {
    use crate::fakes::{ScriptedConnector, ScriptedRegistry};
    use jt_app::{ports::connectors::SendReceipt, usecases::inbox::replies};
    use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
    use jt_connector::{ConnectorError, Credential, Provider};
    let base_deps = deps(uow.clone());
    for scenario in [
        "sent",
        "failed",
        "unknown",
        "recovered",
        "recovered_failed",
        "recovered_unknown",
        "undone",
    ] {
        let f = Fixture::new(uow.clone()).await;
        let mut deps = base_deps.clone();
        let connector = Arc::new(ScriptedConnector::new(Provider::Netgsm));
        deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
        let source = f.insert_person("Source").await;
        let keeper = f.insert_person("Keeper").await;
        let journey = f.journey(source.id);
        let mut cap = Capability::new(
            CapabilityId::new_v7(),
            f.ws,
            NewCapability {
                kind_key: "sms_line".into(),
                name: "SMS".into(),
                ..Default::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        cap.status = StoredStatus::Verified;
        cap.last_verified_at = Some(FIXED_NOW);
        let sealed = deps
            .seal
            .seal(
                f.ws,
                &serde_json::to_vec(&Credential::NetgsmSms {
                    usercode: "test".into(),
                    password: "secret".into(),
                    msgheader: "ACME".into(),
                })
                .unwrap(),
            )
            .unwrap();
        let mut r = uow.tenant(f.ws).await.unwrap();
        let cid = cap.id;
        r.capabilities().insert(cap, Some(sealed)).await.unwrap();
        r.identities()
            .insert(Identity {
                id: IdentityId::new_v7(),
                workspace_id: f.ws,
                person_id: source.id,
                channel: IdentityChannel::Phone,
                value_normalized: "+905321234567".into(),
                value_display: "test".into(),
                active: true,
                first_seen_at: FIXED_NOW,
            })
            .await
            .unwrap();
        r.strategy()
            .insert(jt_strategy::StrategyVersion {
                id: jt_strategy::StrategyVersionId::new_v7(),
                workspace_id: f.ws,
                number: 1,
                status: jt_strategy::VersionStatus::Approved,
                sections: Default::default(),
                created_at: FIXED_NOW,
                created_by: Actor::Human { user_id: f.user },
                submitted_at: Some(FIXED_NOW),
                approved_at: Some(FIXED_NOW),
                approved_by: Some(f.user),
                archived_at: None,
            })
            .await
            .unwrap();
        f.insert_journey(r.as_mut(), &journey).await.unwrap();
        r.people()
            .set_write_time(FIXED_NOW - Duration::minutes(1))
            .await
            .unwrap();
        let older = r
            .conversations()
            .upsert_on_inbound(f.conversation(keeper.id, cid))
            .await
            .unwrap();
        let snoozed = ConvState::Snoozed {
            until: FIXED_NOW + Duration::days(1),
        };
        r.conversations()
            .update_state(older.id, snoozed.clone(), None)
            .await
            .unwrap();
        r.people().set_write_time(FIXED_NOW).await.unwrap();
        let newer = r
            .conversations()
            .upsert_on_inbound(f.conversation(source.id, cid))
            .await
            .unwrap();
        let row = MergeRow {
            id: MergeId::new_v7(),
            workspace_id: f.ws,
            source_id: source.id,
            target_id: keeper.id,
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
            now: FIXED_NOW,
            agent_connection_id: None,
        };
        let input = || {
            serde_json::from_value(
                json!({"text":"Hello", "intent":"reply", "request_key":"merge-send"}),
            )
            .unwrap()
        };
        let q = match replies::enqueue(&deps, &ctx, newer.id, input())
            .await
            .unwrap()
        {
            replies::Enqueued::New(id) => id,
            _ => panic!("new reply expected"),
        };
        let (hook_deps, hook_ctx) = (deps.clone(), ctx.clone());
        connector.push_send_hook(move || async move {
            merge::apply(
                &hook_deps,
                &hook_ctx,
                row.id,
                merge::ApplyInput { keep: keeper.id },
            )
            .await
            .unwrap();
            let mut r = hook_deps.uow.tenant(hook_ctx.workspace_id).await.unwrap();
            let moved = r.outbox().get(q).await.unwrap().unwrap();
            assert_eq!(moved.state, "sending", "{scenario}");
            assert!(moved.conversation_merged);
            assert_eq!(
                moved.updated_at, FIXED_NOW,
                "merge must not restart recovery timeout"
            );
            assert_eq!(moved.attempts, 1);
            assert_eq!(moved.conversation_id, older.id);
            assert_eq!(
                r.messages()
                    .get(moved.message_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                MsgStatus::Queued
            );
            assert_eq!(
                r.request_keys()
                    .get("merge-send", FIXED_NOW)
                    .await
                    .unwrap()
                    .unwrap()["state"],
                "queued"
            );
            drop(r);
            if scenario.starts_with("recovered") {
                let mut later = hook_ctx.clone();
                later.now += Duration::minutes(3);
                assert!(
                    replies::recover_sending(&hook_deps, &later, q)
                        .await
                        .unwrap()
                );
                assert_eq!(
                    replies::send_step(&hook_deps, &later, q)
                        .await
                        .unwrap()
                        .state,
                    "unknown"
                );
            }
            if scenario == "undone" {
                merge::undo(
                    &hook_deps,
                    &hook_ctx,
                    row.id,
                    merge::UndoInput { confirm: true },
                )
                .await
                .unwrap();
            }
        });
        crate::flows::price_sms(&deps, f.ws).await;
        connector.push_sms(match scenario {
            "failed" | "recovered_failed" => Err(ConnectorError::auth("rejected")),
            "unknown" | "recovered_unknown" => Err(ConnectorError::unknown("uncertain write")),
            _ => Ok(SendReceipt {
                provider_id: "merge-receipt".into(),
                cost_minor: Some(17),
            }),
        });
        let expected = match scenario {
            "failed" | "recovered_failed" => "failed",
            "unknown" | "recovered_unknown" => "unknown",
            _ => "sent",
        };
        let response = replies::send_step(&deps, &ctx, q).await.unwrap();
        assert_eq!(response.state, expected, "{scenario}");
        assert_eq!(connector.calls().len(), 1);
        let mut r = uow.tenant(f.ws).await.unwrap();
        let stored = r.outbox().get(q).await.unwrap().unwrap();
        assert_eq!(stored.state, expected);
        assert_eq!(
            stored.last_error.as_deref(),
            match expected {
                "failed" => Some("auth"),
                "unknown" => Some("unknown"),
                _ => None,
            }
        );
        assert!(
            stored.conversation_merged,
            "merge flag survives receipt, recovery and undo"
        );
        let message = r
            .messages()
            .get(response.message_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            message.status,
            match expected {
                "failed" => MsgStatus::Failed,
                "unknown" => MsgStatus::Unknown,
                _ => MsgStatus::Sent,
            }
        );
        let successful = expected == "sent";
        assert_eq!(
            message.external_id.as_deref(),
            successful.then_some("merge-receipt")
        );
        assert_eq!(message.cost_minor, successful.then_some(17));
        assert_eq!(
            r.request_keys().get("merge-send", FIXED_NOW).await.unwrap(),
            Some(serde_json::to_value(&response).unwrap())
        );
        let j = r.journeys().get(journey.id).await.unwrap().unwrap();
        assert_eq!(
            j.status,
            if successful {
                JourneyStatus::Contacted
            } else {
                JourneyStatus::New
            }
        );
        let events = r.journeys().events(j.id, 20).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.kind == JourneyEventKind::Replied)
                .count(),
            usize::from(successful)
        );
        let survivor = r.conversations().get(older.id).await.unwrap().unwrap();
        assert_eq!(survivor.state, snoozed);
        assert_eq!(survivor.last_outbound_at, None);
        if scenario == "undone" {
            let restored = r.conversations().get(newer.id).await.unwrap().unwrap();
            assert_eq!(restored.state, newer.state);
            assert_eq!(restored.last_outbound_at, None);
        }
        drop(r);
        assert_eq!(replies::send_step(&deps, &ctx, q).await.unwrap(), response);
        let replay = replies::reply(&deps, &ctx, stored.conversation_id, input())
            .await
            .unwrap();
        assert_eq!(replay, response);
        let report =
            jt_app::usecases::jobs::run_outbox_recover(&deps, FIXED_NOW + Duration::minutes(6))
                .await;
        assert_eq!(report.failed, 0);
        assert_eq!(report.touched, 0);
        assert_eq!(connector.calls().len(), 1);
    }
}
