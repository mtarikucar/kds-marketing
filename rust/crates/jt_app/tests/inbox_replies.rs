mod support;
use jt_app::{
    ports::{UnitOfWork, connectors::SendReceipt},
    usecases::inbox::{people, replies},
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
use serde_json::json;
use std::sync::Arc;
use support::*;

async fn setup() -> (World, ConversationId, Arc<ScriptedConnector>) {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let connector = Arc::new(ScriptedConnector::new(Provider::Meta));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let p = people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})).unwrap()).await.unwrap().person;
    let now = w.owner_ctx.now;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "whatsapp_cloud".into(),
            name: "Support".into(),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(now);
    let cred = Credential::WhatsAppCloud {
        phone_number_id: "line".into(),
        token: "private-token".into(),
        waba_id: None,
        expires_at: None,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = ConversationId::new_v7();
    let c = Conversation {
        id,
        workspace_id: w.ws,
        person_id: p.id,
        capability_id: cap.id,
        kind_key: cap.kind_key.clone(),
        state: ConvState::Ours,
        executor: Executor::Agent,
        executor_generation: 0,
        last_inbound_at: Some(now),
        last_outbound_at: None,
        created_at: now,
        updated_at: now,
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.conversations().upsert_on_inbound(c).await.unwrap();
    r.commit().await.unwrap();
    (w, id, connector)
}
fn input(key: Option<&str>) -> replies::ReplyInput {
    serde_json::from_value(json!({"text":"Hello","intent":"reply","request_key":key})).unwrap()
}
fn accepted() -> Result<SendReceipt, jt_connector::ConnectorError> {
    Ok(SendReceipt {
        provider_id: "provider-1".into(),
        cost_minor: None,
    })
}

#[tokio::test]
async fn successful_send_atomically_records_replied() {
    let (w, id, c) = setup().await;
    c.push_send_text(accepted());
    let out = replies::reply(&w.deps, &w.owner_ctx, id, input(None))
        .await
        .unwrap();
    assert_eq!(out.state, "sent");
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.messages[0].status, MsgStatus::Sent);
    assert_eq!(
        s.inbox.messages[0].external_id.as_deref(),
        Some("provider-1")
    );
    assert_eq!(s.inbox.outbox[0].state, "sent");
    assert_eq!(s.inbox.events.len(), 1);
    assert_eq!(s.inbox.events[0].kind, JourneyEventKind::Replied);
    assert_eq!(s.inbox.events[0].source, EventSource::System);
    assert_eq!(s.inbox.journeys[0].status, JourneyStatus::Contacted);
    assert_eq!(s.inbox.conversations[0].state, ConvState::Theirs);
    assert_eq!(c.calls().len(), 1);
    match &c.calls()[0] {
        jt_testkit::fakes::ConnectorCall::SendText { public, .. } => {
            assert_eq!(public["kind_key"], "whatsapp_cloud")
        }
        _ => panic!("messaging sender expected"),
    }
}

async fn queued(w: &World, id: ConversationId) -> uuid::Uuid {
    match replies::enqueue(&w.deps, &w.owner_ctx, id, input(Some("key")))
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        _ => panic!("new intent expected"),
    }
}
async fn lose(w: &World) {
    let id = w.uow.snapshot().inbox.journeys[0].id;
    jt_app::usecases::inbox::journeys::report(
        &w.deps,
        &w.owner_ctx,
        id,
        serde_json::from_value(
            json!({"kind":"lost","idempotency_key":"lost","payload":{"reason_key":"fiyat"}}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn executor_change_between_enqueue_and_send_refuses() {
    let (w, id, c) = setup().await;
    let agent = w.agent(&["inbox.work"]).await;
    let q = match replies::enqueue(&w.deps, &agent, id, input(None))
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        _ => panic!(),
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .update_executor(
            id,
            Executor::Human {
                user_id: Some(w.owner),
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        replies::send_step(&w.deps, &agent, q).await.unwrap().state,
        "refused"
    );
    assert!(c.calls().is_empty());
    assert_eq!(
        w.uow.snapshot().inbox.messages[0].status,
        MsgStatus::Refused {
            reason: "executor_changed".into()
        }
    );
}
#[tokio::test]
async fn lost_between_enqueue_and_send_refuses() {
    let (w, id, c) = setup().await;
    let q = queued(&w, id).await;
    lose(&w).await;
    assert_eq!(
        replies::send_step(&w.deps, &w.owner_ctx, q)
            .await
            .unwrap()
            .state,
        "refused"
    );
    assert!(c.calls().is_empty());
    assert_eq!(
        w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("journey_lost")
    );
}
#[tokio::test]
async fn human_reply_ignores_holder() {
    let (w, id, c) = setup().await;
    for executor in [
        Executor::Agent,
        Executor::Human { user_id: None },
        Executor::Human {
            user_id: Some(w.owner),
        },
    ] {
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        r.conversations()
            .update_executor(id, executor)
            .await
            .unwrap();
        r.commit().await.unwrap();
        let before = w.uow.snapshot().inbox.conversations[0].clone();
        c.push_send_text(Ok(SendReceipt {
            provider_id: uuid::Uuid::new_v4().to_string(),
            cost_minor: None,
        }));
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap();
        let after = w.uow.snapshot().inbox.conversations[0].clone();
        assert_eq!(after.executor, before.executor);
        assert_eq!(after.executor_generation, before.executor_generation);
    }
}
#[tokio::test]
async fn reply_window_24h_timezone_boundary() {
    use time::{Duration, UtcOffset};
    let (w, id, c) = setup().await;
    c.push_send_text(accepted());
    let at_limit = at(
        &w.owner_ctx,
        (w.owner_ctx.now + Duration::hours(24)).to_offset(UtcOffset::from_hms(3, 0, 0).unwrap()),
    );
    assert_eq!(
        replies::reply(&w.deps, &at_limit, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
    let late = at(&at_limit, at_limit.now + Duration::nanoseconds(1));
    let e = replies::reply(&w.deps, &late, id, input(None))
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Forbidden);
    assert_eq!(e.details["reason"], "reply_window_closed");
    assert_eq!(c.calls().len(), 1);
}
#[tokio::test]
async fn result_replay_has_one_effect() {
    let (w, id, c) = setup().await;
    c.push_send_text(accepted());
    replies::reply(&w.deps, &w.owner_ctx, id, input(None))
        .await
        .unwrap();
    let before = w.uow.snapshot();
    let q = before.inbox.outbox[0].id;
    replies::record_result(&w.deps, &w.owner_ctx, q, accepted())
        .await
        .unwrap();
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.events, before.inbox.events);
    assert_eq!(after.inbox.conversations, before.inbox.conversations);
    assert_eq!(after.ledger.len(), before.ledger.len());
    assert_eq!(c.calls().len(), 1);
}
#[tokio::test]
async fn provider_io_holds_no_locks() {
    let (w, id, c) = setup().await;
    let uow = w.uow.clone();
    let ws = w.ws;
    c.push_send_text(accepted());
    c.push_send_hook(move || async move {
        assert_eq!(
            uow.snapshot().inbox.outbox[0].state,
            "sending",
            "claim committed before provider I/O"
        );
        let mut r = uow.tenant(ws).await.unwrap();
        r.people().lock_workspace().await.unwrap();
        r.conversations().lock(id).await.unwrap();
        r.conversations()
            .update_executor(id, Executor::Human { user_id: None })
            .await
            .unwrap();
        r.commit().await.unwrap();
    });
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
    assert_eq!(
        w.uow.snapshot().inbox.conversations[0].executor,
        Executor::Human { user_id: None }
    );
}
#[tokio::test]
async fn sent_after_terminal_is_ledgered_without_transition() {
    let (w, id, c) = setup().await;
    let deps = w.deps.clone();
    let ctx = w.owner_ctx.clone();
    let jid = w.uow.snapshot().inbox.journeys[0].id;
    c.push_send_text(accepted());
    c.push_send_hook(move || async move {
        jt_app::usecases::inbox::journeys::report(
            &deps,
            &ctx,
            jid,
            serde_json::from_value(
                json!({"kind":"lost","idempotency_key":"race","payload":{"reason_key":"fiyat"}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    });
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.journeys[0].status, JourneyStatus::Lost);
    assert_eq!(s.inbox.conversations[0].state, ConvState::Closed);
    assert_eq!(s.inbox.messages[0].status, MsgStatus::Sent);
    assert_eq!(w.entries("inbox.sent_after_terminal").len(), 1);
    assert_eq!(s.inbox.events.len(), 2);
}
#[tokio::test]
async fn reply_request_key_returns_stored_response() {
    let (w, id, c) = setup().await;
    c.push_send_text(accepted());
    let first = replies::reply(&w.deps, &w.owner_ctx, id, input(Some("request")))
        .await
        .unwrap();
    lose(&w).await;
    let repeat = replies::reply(&w.deps, &w.owner_ctx, id, input(Some("request")))
        .await
        .unwrap();
    assert_eq!(repeat, first);
    assert_eq!(c.calls().len(), 1);
    assert_eq!(w.uow.snapshot().inbox.messages.len(), 1);
}
#[tokio::test]
async fn crash_after_provider_write_becomes_unknown_never_resends() {
    let (w, id, c) = setup().await;
    c.push_send_hook(|| async { panic!("crash after write") });
    let deps = w.deps.clone();
    let ctx = w.owner_ctx.clone();
    let crash =
        tokio::spawn(async move { replies::reply(&deps, &ctx, id, input(Some("crashed"))).await })
            .await;
    assert!(crash.unwrap_err().is_panic());
    assert_eq!(c.calls().len(), 1);
    assert_eq!(w.uow.snapshot().inbox.outbox[0].state, "sending");
    let later = w.owner_ctx.now + time::Duration::minutes(3);
    let report = jt_app::usecases::jobs::run_outbox_recover(&w.deps, later).await;
    assert_eq!(report.failed, 0);
    assert_eq!(report.changed, 1);
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.outbox[0].state, "unknown");
    assert_eq!(s.inbox.messages[0].status, MsgStatus::Unknown);
    assert!(s.inbox.events.is_empty());
    jt_app::usecases::jobs::run_outbox_recover(&w.deps, later + time::Duration::minutes(10)).await;
    let out = replies::reply(
        &w.deps,
        &at(&w.owner_ctx, later),
        id,
        input(Some("crashed")),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "unknown");
    assert_eq!(c.calls().len(), 1);
}
#[tokio::test]
async fn abandoned_queue_recovers_once() {
    let (w, id, c) = setup().await;
    queued(&w, id).await;
    c.push_send_text(accepted());
    let now = w.owner_ctx.now + time::Duration::minutes(6);
    let first = jt_app::usecases::jobs::run_outbox_recover(&w.deps, now).await;
    assert_eq!(first.failed, 0);
    assert_eq!(first.changed, 1);
    let second = jt_app::usecases::jobs::run_outbox_recover(&w.deps, now).await;
    assert_eq!(second.touched, 0);
    assert_eq!(c.calls().len(), 1);
    assert_eq!(w.uow.snapshot().inbox.events.len(), 1);
}
#[tokio::test]
async fn sms_optional_cost() {
    let (mut w, id, _) = setup().await;
    let sms = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(sms.clone()));
    // A distinct SMS conversation shares the phone identity but uses its own capability.
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "sms_line".into(),
            name: "SMS".into(),
            ..Default::default()
        },
        w.owner_ctx.now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(w.owner_ctx.now);
    let credential = Credential::NetgsmSms {
        usercode: "user".into(),
        password: "private".into(),
        msgheader: "ACME".into(),
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut c = r.conversations().get(id).await.unwrap().unwrap();
    c.id = ConversationId::new_v7();
    c.capability_id = cap.id;
    c.kind_key = "sms_line".into();
    let id = c.id;
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.conversations().upsert_on_inbound(c).await.unwrap();
    r.commit().await.unwrap();
    sms.push_sms(accepted());
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.messages[0].cost_minor, None);
    match &sms.calls()[0] {
        jt_testkit::fakes::ConnectorCall::SendSms { reference, to, .. } => {
            assert_eq!(
                reference.as_deref(),
                Some(s.inbox.outbox[0].id.to_string().as_str())
            );
            assert_eq!(to, "+905321234567");
        }
        _ => panic!(),
    }
}
#[tokio::test]
async fn unsnooze_and_outbound_clear_snooze() {
    let (w, id, c) = setup().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .update_state(
            id,
            ConvState::Snoozed {
                until: w.owner_ctx.now + time::Duration::days(1),
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    c.push_send_text(accepted());
    replies::reply(&w.deps, &w.owner_ctx, id, input(None))
        .await
        .unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.conversations[0].state,
        ConvState::Theirs
    );
}
#[tokio::test]
async fn uncertain_and_definite_failures_have_no_success_effect() {
    for unknown in [true, false] {
        let (w, id, c) = setup().await;
        c.push_send_text(Err(if unknown {
            jt_connector::ConnectorError::unknown("write uncertain")
        } else {
            jt_connector::ConnectorError::auth("denied")
        }));
        let out = replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap();
        assert_eq!(out.state, if unknown { "unknown" } else { "failed" });
        let s = w.uow.snapshot();
        assert!(s.inbox.events.is_empty());
        assert_eq!(s.inbox.conversations[0].state, ConvState::Ours);
    }
}

#[tokio::test]
async fn recovery_rechecks_strategy_approval() {
    let (w, id, c) = setup().await;
    queued(&w, id).await;
    let version = w
        .uow
        .tenant(w.ws)
        .await
        .unwrap()
        .strategy()
        .current_approved()
        .await
        .unwrap()
        .unwrap();
    jt_app::usecases::strategy::archive(
        &w.deps,
        &w.owner_ctx,
        jt_app::usecases::strategy::ArchiveInput {
            version_id: version.id,
            confirm: true,
        },
    )
    .await
    .unwrap();
    c.push_send_text(accepted());
    let report = jt_app::usecases::jobs::run_outbox_recover(
        &w.deps,
        w.owner_ctx.now + time::Duration::minutes(6),
    )
    .await;
    assert_eq!(report.failed, 0);
    assert!(c.calls().is_empty());
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.outbox[0].state, "refused");
    assert_eq!(
        s.inbox.outbox[0].last_error.as_deref(),
        Some("strategy_required")
    );
}

#[tokio::test]
async fn late_acceptance_preserves_newer_conversation_activity() {
    for activity in ["inbound", "close", "snooze", "none"] {
        let (w, id, c) = setup().await;
        c.push_send_text(Err(jt_connector::ConnectorError::unknown(
            "timeout after write",
        )));
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap();
        let mut expected = ConvState::Theirs;
        let later = w.owner_ctx.now + time::Duration::minutes(10);
        if activity != "none" {
            let mut r = w.uow.tenant(w.ws).await.unwrap();
            r.people().set_write_time(later).await.unwrap();
            if activity == "inbound" {
                let mut c = r.conversations().get(id).await.unwrap().unwrap();
                c.last_inbound_at = Some(later);
                r.conversations().upsert_on_inbound(c).await.unwrap();
                expected = ConvState::Ours;
            } else {
                expected = if activity == "close" {
                    ConvState::Closed
                } else {
                    ConvState::Snoozed {
                        until: later + time::Duration::hours(2),
                    }
                };
                r.conversations()
                    .update_state(id, expected.clone(), None)
                    .await
                    .unwrap();
            }
            r.commit().await.unwrap();
        }
        let q = w.uow.snapshot().inbox.outbox[0].id;
        let out = replies::record_result(
            &w.deps,
            &at(&w.owner_ctx, later + time::Duration::minutes(1)),
            q,
            accepted(),
        )
        .await
        .unwrap();
        assert_eq!(out.state, "sent");
        let s = w.uow.snapshot();
        assert_eq!(s.inbox.conversations[0].state, expected, "{activity}");
        assert_eq!(
            s.inbox.conversations[0].last_outbound_at,
            Some(w.owner_ctx.now)
        );
        assert_eq!(s.inbox.events.len(), 1);
    }
}

#[tokio::test]
async fn overlapping_successful_replies_end_theirs() {
    let (w, id, c) = setup().await;
    let a_started = Arc::new(tokio::sync::Notify::new());
    let b_started = Arc::new(tokio::sync::Notify::new());
    let a_recorded = Arc::new(tokio::sync::Notify::new());
    let (a, b) = (a_started.clone(), b_started.clone());
    c.push_send_hook(move || async move {
        a.notify_one();
        b.notified().await;
    });
    let (b, a) = (b_started.clone(), a_recorded.clone());
    c.push_send_hook(move || async move {
        b.notify_one();
        a.notified().await;
    });
    for provider_id in ["one", "two"] {
        c.push_send_text(Ok(SendReceipt {
            provider_id: provider_id.into(),
            cost_minor: None,
        }));
    }
    let (deps, ctx) = (w.deps.clone(), w.owner_ctx.clone());
    let a =
        tokio::spawn(async move { replies::reply(&deps, &ctx, id, input(None)).await.unwrap() });
    a_started.notified().await;
    let (deps, ctx) = (w.deps.clone(), w.owner_ctx.clone());
    let b =
        tokio::spawn(async move { replies::reply(&deps, &ctx, id, input(None)).await.unwrap() });
    assert_eq!(a.await.unwrap().state, "sent");
    a_recorded.notify_one();
    assert_eq!(b.await.unwrap().state, "sent");
    let s = w.uow.snapshot();
    assert!(s.inbox.outbox.iter().all(|o| o.state == "sent"));
    assert_eq!(s.inbox.conversations[0].state, ConvState::Theirs);
}

#[tokio::test]
async fn late_acceptance_preserves_three_newer_failed_calls() {
    let (w, id, c) = setup().await;
    c.push_send_text(Err(jt_connector::ConnectorError::unknown("after write")));
    replies::reply(&w.deps, &w.owner_ctx, id, input(None))
        .await
        .unwrap();
    let s = w.uow.snapshot();
    let q = s.inbox.outbox[0].id;
    let j = s.inbox.journeys[0].id;
    let later = at(&w.owner_ctx, w.owner_ctx.now + time::Duration::minutes(10));
    for n in 0..3 {
        jt_app::usecases::inbox::journeys::report(&w.deps,&later,j,serde_json::from_value(json!({"kind":"call_made","idempotency_key":format!("failed-{n}"),"payload":{"connected":false}})).unwrap()).await.unwrap();
    }
    replies::record_result(&w.deps, &later, q, accepted())
        .await
        .unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.journeys[0].unreachable_attempts, 3);
    assert_eq!(s.inbox.journeys[0].status, JourneyStatus::Unreachable);
    assert_eq!(s.inbox.messages[0].status, MsgStatus::Sent);
    let event = s
        .inbox
        .events
        .iter()
        .find(|e| e.kind == JourneyEventKind::Replied)
        .unwrap();
    assert_eq!(event.at, w.owner_ctx.now);
}

async fn add_second_phone(w: &World, id: ConversationId) -> IdentityId {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let p = r.conversations().get(id).await.unwrap().unwrap().person_id;
    let identity = Identity {
        id: IdentityId::new_v7(),
        workspace_id: w.ws,
        person_id: p,
        channel: IdentityChannel::Phone,
        value_normalized: "+905551234567".into(),
        value_display: "second".into(),
        active: true,
        first_seen_at: w.owner_ctx.now + time::Duration::seconds(1),
    };
    r.identities().insert(identity.clone()).await.unwrap();
    r.commit().await.unwrap();
    identity.id
}
#[tokio::test]
async fn ambiguous_legacy_recipient_is_validation() {
    let (w, id, c) = setup().await;
    add_second_phone(&w, id).await;
    c.push_send_text(accepted());
    let e = replies::reply(&w.deps, &w.owner_ctx, id, input(None))
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Validation);
    assert_eq!(e.details["reason"], "ambiguous_reply_recipient");
    assert!(c.calls().is_empty());
}
#[tokio::test]
async fn reply_reaches_last_inbound_sender_with_two_phone_identities() {
    let (w, id, c) = setup().await;
    let sender = add_second_phone(&w, id).await;
    let m = Message {
        id: MessageId::new_v7(),
        workspace_id: w.ws,
        conversation_id: id,
        direction: Direction::Inbound,
        author: Author::Customer,
        body: "second number".into(),
        external_id: Some("inbound-second".into()),
        status: MsgStatus::Received,
        cost_minor: None,
        at: w.owner_ctx.now,
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.messages().insert_if_new(m.clone()).await.unwrap();
    r.messages()
        .record_inbound_sender(m.id, sender)
        .await
        .unwrap();
    r.commit().await.unwrap();
    c.push_send_text(accepted());
    replies::reply(&w.deps, &w.owner_ctx, id, input(None))
        .await
        .unwrap();
    match &c.calls()[0] {
        jt_testkit::fakes::ConnectorCall::SendText { recipient_id, .. } => {
            assert_eq!(recipient_id, "+905551234567")
        }
        _ => panic!(),
    }
}

#[tokio::test]
async fn note_during_send_does_not_suppress_reply_transition() {
    let (w, id, connector) = setup().await;
    let (deps, ctx) = (w.deps.clone(), w.owner_ctx.clone());
    let jid = w.uow.snapshot().inbox.journeys[0].id;
    connector.push_send_text(accepted());
    connector.push_send_hook(move || async move {
        jt_app::usecases::inbox::tasks::add_note(
            &deps,
            &ctx,
            jid,
            jt_app::usecases::inbox::tasks::NoteInput {
                text: "Internal note".into(),
            },
        )
        .await
        .unwrap();
    });
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Contacted
    );
}

#[tokio::test]
async fn immediate_reply_tolerates_validated_provider_clock_skew() {
    let (w, id, connector) = setup().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut conv = r.conversations().get(id).await.unwrap().unwrap();
    conv.last_inbound_at = Some(w.owner_ctx.now + time::Duration::minutes(5));
    r.conversations().upsert_on_inbound(conv).await.unwrap();
    r.commit().await.unwrap();
    connector.push_send_text(accepted());
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
}

#[tokio::test]
async fn merged_open_journey_wins_over_newer_lost_for_reply_context_and_pending() {
    use jt_app::usecases::inbox::{context, journeys, merge};
    let (w, id, connector) = setup().await;
    let original = w.uow.snapshot().inbox.journeys[0].clone();
    let later = at(&w.owner_ctx, w.owner_ctx.now + time::Duration::seconds(1));
    let other = people::create(&w.deps, &later, serde_json::from_value(json!({
        "display_name":"Other", "identities":[{"channel":"phone","value":"05321234568"}], "source":"form"
    })).unwrap()).await.unwrap();
    let lost = w
        .uow
        .snapshot()
        .inbox
        .journeys
        .iter()
        .find(|j| j.person_id == other.person.id)
        .unwrap()
        .id;
    journeys::report(
        &w.deps,
        &later,
        lost,
        serde_json::from_value(json!({
            "kind":"lost", "idempotency_key":"other-lost", "payload":{"reason_key":"fiyat"}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    people::add_identity(
        &w.deps,
        &later,
        original.person_id,
        serde_json::from_value(json!({
            "channel":"phone", "value":"05321234568"
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let row = merge::list(&w.deps, &later).await.unwrap().remove(0);
    merge::apply(
        &w.deps,
        &later,
        row.id,
        merge::ApplyInput {
            keep: original.person_id,
        },
    )
    .await
    .unwrap();
    let ctx = context::context(&w.deps, &later, id).await.unwrap();
    assert_eq!(ctx.journey.unwrap().id, original.id);
    assert!(!ctx.prohibitions.iter().any(|p| p == "lost"));
    let agent = w.agent(&["inbox.work"]).await;
    let pending = context::pending(&w.deps, &agent).await.unwrap();
    assert_eq!(
        pending.ours.iter().map(|c| c.id).collect::<Vec<_>>(),
        vec![id]
    );
    assert!(pending.reopen_questions.is_empty());
    // Bind the original inbound sender now that the merged person has two numbers.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let sender = r
        .identities()
        .list(original.person_id)
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.value_normalized == "+905321234567")
        .unwrap();
    let message = Message {
        id: MessageId::new_v7(),
        workspace_id: w.ws,
        conversation_id: id,
        direction: Direction::Inbound,
        author: Author::Customer,
        body: "Hi".into(),
        external_id: Some("before-merge".into()),
        status: MsgStatus::Received,
        cost_minor: None,
        at: w.owner_ctx.now,
    };
    r.messages().insert_if_new(message.clone()).await.unwrap();
    r.messages()
        .record_inbound_sender(message.id, sender.id)
        .await
        .unwrap();
    r.commit().await.unwrap();
    connector.push_send_text(accepted());
    assert_eq!(
        replies::reply(&w.deps, &later, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
    let s = w.uow.snapshot();
    assert_eq!(
        s.inbox
            .journeys
            .iter()
            .find(|j| j.id == original.id)
            .unwrap()
            .status,
        JourneyStatus::Contacted
    );
    assert_eq!(
        s.inbox
            .journeys
            .iter()
            .find(|j| j.id == lost)
            .unwrap()
            .status,
        JourneyStatus::Lost
    );
}

#[tokio::test]
async fn inbound_during_provider_io_still_contacts_new_journey() {
    let (w, id, connector) = setup().await;
    let (deps, ctx) = (w.deps.clone(), w.owner_ctx.clone());
    let cap = w.uow.snapshot().inbox.conversations[0].capability_id;
    connector.push_send_text(accepted());
    connector.push_send_hook(move || async move {
        let received_at = ctx.now + time::Duration::seconds(1);
        let mut r = deps.uow.tenant(ctx.workspace_id).await.unwrap();
        r.inbound_events().insert_if_new(jt_connector::InboundEvent {
            id: jt_connector::InboundEventId::new_v7(), workspace_id: ctx.workspace_id,
            capability_id: Some(cap), provider: Provider::Meta, external_id: "during-send".into(),
            kind: jt_connector::EventKind::Message,
            payload: json!({"message":{"id":"during-send", "from":"905321234567", "type":"text", "text":{"body":"Another question"}}}),
            received_at, processed_at: None,
        }, None).await.unwrap();
        r.commit().await.unwrap();
        let report = jt_app::usecases::inbox::consumer::consume_workspace(&deps, ctx.workspace_id, received_at).await;
        assert_eq!(report.failed, 0);
        assert_eq!(report.changed, 1);
    });
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, input(None))
            .await
            .unwrap()
            .state,
        "sent"
    );
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.journeys[0].status, JourneyStatus::Contacted);
    assert_eq!(s.inbox.conversations[0].state, ConvState::Ours);
    assert_eq!(
        s.inbox
            .events
            .iter()
            .filter(|e| e.kind == JourneyEventKind::Replied)
            .count(),
        1
    );
}

#[tokio::test]
async fn takeover_then_merge_into_older_agent_never_revives_queued_reply() {
    use jt_app::usecases::inbox::merge;
    let (w, source_id, connector) = setup().await;
    let agent = w.agent(&["inbox.work"]).await;
    let queued = match replies::enqueue(&w.deps, &agent, source_id, input(Some("merge-fence")))
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        _ => panic!("new reply expected"),
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let source = r.conversations().get(source_id).await.unwrap().unwrap();
    let mut keeper = r.people().get(source.person_id).await.unwrap().unwrap();
    keeper.id = PersonId::new_v7();
    r.people().insert(keeper.clone()).await.unwrap();
    let mut older = source.clone();
    older.id = ConversationId::new_v7();
    older.person_id = keeper.id;
    older.created_at -= time::Duration::minutes(1);
    r.people().set_write_time(older.created_at).await.unwrap();
    r.conversations()
        .upsert_on_inbound(older.clone())
        .await
        .unwrap();
    r.people().set_write_time(w.owner_ctx.now).await.unwrap();
    r.conversations()
        .update_executor(
            source_id,
            Executor::Human {
                user_id: Some(w.owner),
            },
        )
        .await
        .unwrap();
    let row = jt_app::ports::inbox::MergeRow {
        id: MergeId::new_v7(),
        workspace_id: w.ws,
        source_id: source.person_id,
        target_id: keeper.id,
        decision: MergeDecision::Suggest(vec![MergeConflict::DisplayName]),
        conflicts: vec![MergeConflict::DisplayName],
        status: "suggested".into(),
        moved_snapshot: json!({}),
        at: w.owner_ctx.now,
        applied_by: None,
        undone_at: None,
    };
    r.merges().insert(row.clone()).await.unwrap();
    r.commit().await.unwrap();
    merge::apply(
        &w.deps,
        &w.owner_ctx,
        row.id,
        merge::ApplyInput { keep: keeper.id },
    )
    .await
    .unwrap();
    connector.push_send_text(accepted());
    assert_eq!(
        replies::send_step(&w.deps, &agent, queued)
            .await
            .unwrap()
            .state,
        "refused"
    );
    let report = jt_app::usecases::jobs::run_outbox_recover(
        &w.deps,
        w.owner_ctx.now + time::Duration::minutes(6),
    )
    .await;
    assert_eq!(report.failed, 0);
    assert_eq!(report.touched, 0);
    assert!(connector.calls().is_empty());
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.conversations.len(), 1);
    assert_eq!(s.inbox.conversations[0].id, older.id);
    assert_eq!(s.inbox.conversations[0].executor, Executor::Agent);
    assert_eq!(s.inbox.conversations[0].executor_generation, 0);
    assert_eq!(s.inbox.outbox[0].expected_generation, 0);
    assert_eq!(
        s.inbox.outbox[0].last_error.as_deref(),
        Some("conversation_merged")
    );
    assert_eq!(w.entries("inbox.reply.result").len(), 1);
    merge::undo(
        &w.deps,
        &w.owner_ctx,
        row.id,
        merge::UndoInput { confirm: true },
    )
    .await
    .unwrap();
    let replay = replies::reply(&w.deps, &agent, source_id, input(Some("merge-fence")))
        .await
        .unwrap();
    assert_eq!(replay.state, "refused");
    assert!(connector.calls().is_empty());
}

#[tokio::test]
async fn late_receipt_after_closure_and_reopen_preserves_newer_attempts() {
    use jt_app::usecases::inbox::journeys;
    let (w, id, connector) = setup().await;
    let jid = w.uow.snapshot().inbox.journeys[0].id;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        jid,
        serde_json::from_value(json!({
            "kind":"call_made", "idempotency_key":"contact", "payload":{"connected":true}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    connector.push_send_text(Err(jt_connector::ConnectorError::unknown("after write")));
    replies::reply(&w.deps, &w.owner_ctx, id, input(None))
        .await
        .unwrap();
    let q = w.uow.snapshot().inbox.outbox[0].id;
    let later = at(&w.owner_ctx, w.owner_ctx.now + time::Duration::minutes(1));
    for (kind, key, payload) in [
        ("lost", "close", json!({"reason_key":"fiyat"})),
        ("reopened", "reopen", json!({})),
        ("call_made", "failed-1", json!({"connected":false})),
        ("call_made", "failed-2", json!({"connected":false})),
        ("call_made", "failed-3", json!({"connected":false})),
    ] {
        journeys::report(
            &w.deps,
            &later,
            jid,
            serde_json::from_value(json!({
                "kind":kind, "idempotency_key":key, "payload":payload
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    }
    let before = w.uow.snapshot().inbox.journeys[0].clone();
    assert_eq!(
        replies::record_result(&w.deps, &later, q, accepted())
            .await
            .unwrap()
            .state,
        "sent"
    );
    let after = w.uow.snapshot().inbox.journeys[0].clone();
    assert_eq!(after, before);
    assert_eq!(after.status, JourneyStatus::Unreachable);
    assert_eq!(after.unreachable_attempts, 3);
}
