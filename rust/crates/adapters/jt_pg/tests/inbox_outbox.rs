use jt_app::ports::UnitOfWork;
use jt_testkit::{fakes::FIXED_NOW, inbox_contract::Fixture};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn request_completion_compares_response_and_preserves_expiry() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    let queued = json!({"message_id":"first","state":"queued"});
    let sent = json!({"message_id":"first","state":"sent"});
    assert!(
        r.request_keys()
            .store("reply", queued.clone(), FIXED_NOW)
            .await
            .unwrap()
    );
    assert!(
        !r.request_keys()
            .complete("reply", json!({}), sent.clone())
            .await
            .unwrap()
    );
    assert!(
        r.request_keys()
            .complete("reply", queued, sent.clone())
            .await
            .unwrap()
    );
    assert_eq!(
        r.request_keys().get("reply", FIXED_NOW).await.unwrap(),
        Some(sent)
    );
    assert!(
        r.request_keys()
            .get("reply", FIXED_NOW + time::Duration::hours(24))
            .await
            .unwrap()
            .is_none()
    );
    r.commit().await.unwrap();
}

use jt_app::{
    ctx::Ctx,
    usecases::{Deps, inbox::replies},
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::Permission;
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};

async fn ready(
    uow: Arc<jt_pg::PgUnitOfWork>,
) -> (Deps, Ctx, ConversationId, JourneyId, Arc<ScriptedConnector>) {
    let f = Fixture::new(uow.clone()).await;
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    let connector = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let p = f.insert_person("Recipient").await;
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
    let credential = Credential::NetgsmSms {
        usercode: "user".into(),
        password: "secret".into(),
        msgheader: "ACME".into(),
    };
    let sealed = deps
        .seal
        .seal(f.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let c = f.conversation(p.id, cap.id);
    let j = f.journey(p.id);
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.identities()
        .insert(Identity {
            id: IdentityId::new_v7(),
            workspace_id: f.ws,
            person_id: p.id,
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
            sections: jt_strategy::Sections::default(),
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: f.user },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(f.user),
            archived_at: None,
        })
        .await
        .unwrap();
    f.insert_journey(r.as_mut(), &j).await.unwrap();
    r.conversations()
        .upsert_on_inbound(c.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    let ctx = Ctx {
        workspace_id: f.ws,
        actor: Actor::Human { user_id: f.user },
        permissions: [Permission::InboxWork].into(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    (deps, ctx, c.id, j.id, connector)
}
fn reply_input() -> replies::ReplyInput {
    serde_json::from_value(json!({"text":"Hello","intent":"reply","request_key":"same"})).unwrap()
}
fn receipt() -> Result<jt_app::ports::connectors::SendReceipt, jt_connector::ConnectorError> {
    Ok(jt_app::ports::connectors::SendReceipt {
        provider_id: "sms-job".into(),
        cost_minor: None,
    })
}

#[tokio::test]
async fn provider_io_releases_postgres_locks_and_concurrent_workers_claim_once() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, jid, connector) = ready(uow.clone()).await;
    let q = match replies::enqueue(&deps, &ctx, cid, reply_input())
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        _ => panic!(),
    };
    let ws = ctx.workspace_id;
    let io_uow = uow.clone();
    connector.push_sms(receipt());
    connector.push_send_hook(move || async move {
        tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            let mut r = io_uow.tenant(ws).await.unwrap();
            r.people().lock_workspace().await.unwrap();
            r.conversations().lock(cid).await.unwrap().unwrap();
            r.journeys().lock(jid).await.unwrap().unwrap();
            assert_eq!(r.outbox().lock(q).await.unwrap().unwrap().state, "sending");
            r.conversations()
                .update_executor(cid, Executor::Human { user_id: None })
                .await
                .unwrap();
            r.commit().await.unwrap();
        })
        .await
        .expect("provider I/O must hold no DB lock");
    });
    let (a, b) = tokio::join!(
        replies::send_step(&deps, &ctx, q),
        replies::send_step(&deps, &ctx, q)
    );
    assert!(matches!(a.unwrap().state.as_str(), "sending" | "sent"));
    assert!(matches!(b.unwrap().state.as_str(), "sending" | "sent"));
    assert_eq!(connector.calls().len(), 1);
    let mut r = uow.tenant(ws).await.unwrap();
    let row = r.outbox().get(q).await.unwrap().unwrap();
    assert_eq!(row.state, "sent");
    assert_eq!(row.attempts, 1);
    assert_eq!(r.journeys().events(jid, 50).await.unwrap().len(), 1);
    assert_eq!(
        r.conversations().get(cid).await.unwrap().unwrap().executor,
        Executor::Human { user_id: None }
    );
}

#[tokio::test]
async fn concurrent_request_key_replies_store_one_message_and_one_provider_write() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, _, connector) = ready(uow.clone()).await;
    connector.push_sms(receipt());
    let (a, b) = tokio::join!(
        replies::reply(&deps, &ctx, cid, reply_input()),
        replies::reply(&deps, &ctx, cid, reply_input())
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.message_id, b.message_id);
    assert!(matches!(a.state.as_str(), "sent" | "queued"));
    assert!(matches!(b.state.as_str(), "sent" | "queued"));
    assert_eq!(connector.calls().len(), 1);
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    assert_eq!(r.messages().list(cid, 50).await.unwrap().len(), 1);
    let stored = r
        .request_keys()
        .get("same", FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored["state"], "sent");
}

#[tokio::test]
async fn postgres_inbound_sender_is_durable_latest_and_unambiguous() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, _, connector) = ready(uow.clone()).await;
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    let conversation = r.conversations().get(cid).await.unwrap().unwrap();
    let original = r.identities().list(conversation.person_id).await.unwrap()[0].id;
    let sender = IdentityId::new_v7();
    r.identities()
        .insert(Identity {
            id: sender,
            workspace_id: ctx.workspace_id,
            person_id: conversation.person_id,
            channel: IdentityChannel::Phone,
            value_normalized: "+905551234567".into(),
            value_display: "second".into(),
            active: true,
            first_seen_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let error = replies::reply(&deps, &ctx, cid, reply_input())
        .await
        .unwrap_err();
    assert_eq!(error.code, jt_app::error::ErrorCode::Validation);
    assert_eq!(error.details["reason"], "ambiguous_reply_recipient");
    assert!(connector.calls().is_empty());
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    let latest = Message {
        id: MessageId::new_v7(),
        workspace_id: ctx.workspace_id,
        conversation_id: cid,
        direction: Direction::Inbound,
        author: Author::Customer,
        body: "latest".into(),
        external_id: Some("latest".into()),
        status: MsgStatus::Received,
        cost_minor: None,
        at: FIXED_NOW,
    };
    r.messages().insert_if_new(latest.clone()).await.unwrap();
    r.messages()
        .record_inbound_sender(latest.id, sender)
        .await
        .unwrap();
    let mut old = latest.clone();
    old.id = MessageId::new_v7();
    old.at -= time::Duration::minutes(1);
    old.external_id = Some("older".into());
    r.messages().insert_if_new(old.clone()).await.unwrap();
    r.messages()
        .record_inbound_sender(old.id, original)
        .await
        .unwrap();
    assert_eq!(
        r.conversations()
            .send_state(cid)
            .await
            .unwrap()
            .last_inbound_identity_id,
        Some(sender)
    );
    r.commit().await.unwrap();
    // Equal timestamps are ordered by message id, even if ingestion runs out of order.
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    r.conversations()
        .upsert_on_inbound(conversation.clone())
        .await
        .unwrap();
    let mut tied = latest.clone();
    tied.id = MessageId::from(uuid::Uuid::nil());
    tied.external_id = Some("same-time-older-id".into());
    r.messages().insert_if_new(tied.clone()).await.unwrap();
    r.messages()
        .record_inbound_sender(tied.id, original)
        .await
        .unwrap();
    assert_eq!(
        r.conversations()
            .send_state(cid)
            .await
            .unwrap()
            .last_inbound_identity_id,
        Some(sender)
    );
    r.commit().await.unwrap();
    // A committed sender binding cannot subsequently be rewritten.
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.messages()
            .record_inbound_sender(latest.id, original)
            .await
            .unwrap_err()
            .code,
        jt_app::error::ErrorCode::Conflict
    );
    drop(r);
    connector.push_sms(receipt());
    assert_eq!(
        replies::reply(&deps, &ctx, cid, reply_input())
            .await
            .unwrap()
            .state,
        "sent"
    );
    match &connector.calls()[0] {
        jt_testkit::fakes::ConnectorCall::SendSms { to, .. } => assert_eq!(to, "+905551234567"),
        other => panic!("unexpected call {other:?}"),
    }
}

#[tokio::test]
async fn postgres_overlapping_replies_share_activity_revision() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, _, connector) = ready(uow.clone()).await;
    let a_started = Arc::new(tokio::sync::Notify::new());
    let b_started = Arc::new(tokio::sync::Notify::new());
    let a_recorded = Arc::new(tokio::sync::Notify::new());
    let (a, b) = (a_started.clone(), b_started.clone());
    connector.push_send_hook(move || async move {
        a.notify_one();
        b.notified().await;
    });
    let (a, b) = (a_recorded.clone(), b_started.clone());
    connector.push_send_hook(move || async move {
        b.notify_one();
        a.notified().await;
    });
    for provider_id in ["a", "b"] {
        connector.push_sms(Ok(jt_app::ports::connectors::SendReceipt {
            provider_id: provider_id.into(),
            cost_minor: None,
        }));
    }
    let (d, c) = (deps.clone(), ctx.clone());
    let a = tokio::spawn(async move { replies::reply(&d, &c, cid, reply_input()).await.unwrap() });
    a_started.notified().await;
    let (d, c) = (deps.clone(), ctx.clone());
    let b = tokio::spawn(async move {
        let mut input = reply_input();
        input.request_key = Some("second".into());
        replies::reply(&d, &c, cid, input).await.unwrap()
    });
    assert_eq!(a.await.unwrap().state, "sent");
    a_recorded.notify_one();
    assert_eq!(b.await.unwrap().state, "sent");
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.conversations().get(cid).await.unwrap().unwrap().state,
        ConvState::Theirs
    );
    assert!(
        r.messages()
            .list(cid, 50)
            .await
            .unwrap()
            .iter()
            .all(|m| m.status == MsgStatus::Sent)
    );
}

#[tokio::test]
async fn postgres_historical_acceptance_preserves_newer_journey() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, jid, connector) = ready(uow.clone()).await;
    connector.push_sms(Err(jt_connector::ConnectorError::unknown("after write")));
    let q = match replies::enqueue(&deps, &ctx, cid, reply_input())
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        _ => panic!(),
    };
    let response = replies::send_step(&deps, &ctx, q).await.unwrap();
    let mut later = ctx.clone();
    later.now += time::Duration::minutes(10);
    for n in 0..3 {
        jt_app::usecases::inbox::journeys::report(&deps,&later,jid,serde_json::from_value(json!({"kind":"call_made","idempotency_key":format!("failed-{n}"),"payload":{"connected":false}})).unwrap()).await.unwrap();
    }
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    let before = r.journeys().get(jid).await.unwrap().unwrap();
    drop(r);
    replies::record_result(&deps, &later, q, receipt())
        .await
        .unwrap();
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    let after = r.journeys().get(jid).await.unwrap().unwrap();
    assert_eq!(after.unreachable_attempts, 3);
    assert_eq!(after.status, JourneyStatus::Unreachable);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(
        r.messages()
            .get(response.message_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        MsgStatus::Sent
    );
    let events = r.journeys().events(jid, 50).await.unwrap();
    let event = events
        .iter()
        .find(|e| e.kind == JourneyEventKind::Replied)
        .unwrap();
    assert_eq!(event.at, ctx.now);
}

#[tokio::test]
async fn postgres_note_during_send_does_not_suppress_reply_transition() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, jid, connector) = ready(uow.clone()).await;
    let (d, c) = (deps.clone(), ctx.clone());
    connector.push_sms(receipt());
    connector.push_send_hook(move || async move {
        jt_app::usecases::inbox::tasks::add_note(
            &d,
            &c,
            jid,
            jt_app::usecases::inbox::tasks::NoteInput {
                text: "Internal note".into(),
            },
        )
        .await
        .unwrap();
    });
    assert_eq!(
        replies::reply(&deps, &ctx, cid, reply_input())
            .await
            .unwrap()
            .state,
        "sent"
    );
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.journeys().get(jid).await.unwrap().unwrap().status,
        JourneyStatus::Contacted
    );
}

#[tokio::test]
async fn coalesced_late_reply_preserves_survivor_snooze_despite_equal_revisions() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, _, connector) = ready(uow.clone()).await;
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    let source = r.conversations().get(cid).await.unwrap().unwrap();
    // Source send will capture revision 2; the survivor will reach 2 during merge.
    for _ in 0..2 {
        r.conversations()
            .upsert_on_inbound(source.clone())
            .await
            .unwrap();
    }
    let mut keeper = r.people().get(source.person_id).await.unwrap().unwrap();
    keeper.id = PersonId::new_v7();
    keeper.created_at -= time::Duration::hours(1);
    keeper.updated_at = keeper.created_at;
    r.people().insert(keeper.clone()).await.unwrap();
    let mut survivor = source.clone();
    survivor.id = ConversationId::new_v7();
    survivor.person_id = keeper.id;
    r.people().set_write_time(keeper.created_at).await.unwrap();
    r.conversations()
        .upsert_on_inbound(survivor.clone())
        .await
        .unwrap();
    let snoozed = ConvState::Snoozed {
        until: ctx.now + time::Duration::hours(2),
    };
    r.conversations()
        .update_state(survivor.id, snoozed.clone(), None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let q = match replies::enqueue(&deps, &ctx, cid, reply_input())
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        _ => panic!(),
    };
    connector.push_sms(Err(jt_connector::ConnectorError::unknown("after write")));
    replies::send_step(&deps, &ctx, q).await.unwrap();
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    r.people().lock_workspace().await.unwrap();
    let snap = r
        .merges()
        .snapshot(source.person_id, keeper.id)
        .await
        .unwrap();
    r.merges()
        .apply_snapshot(&snap, keeper.id, ctx.now + time::Duration::minutes(1))
        .await
        .unwrap();
    let moved = r.outbox().get(q).await.unwrap().unwrap();
    assert_eq!(moved.conversation_id, survivor.id);
    assert_eq!(
        moved.fence_snapshot.as_ref().unwrap()["activity_revision"],
        r.conversations()
            .send_state(survivor.id)
            .await
            .unwrap()
            .activity_revision
    );
    r.commit().await.unwrap();
    let mut later = ctx.clone();
    later.now += time::Duration::minutes(2);
    assert_eq!(
        replies::record_result(&deps, &later, q, receipt())
            .await
            .unwrap()
            .state,
        "sent"
    );
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.conversations()
            .get(survivor.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        snoozed
    );
}
