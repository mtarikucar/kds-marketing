mod support;
use jt_app::{
    ports::{UnitOfWork, connectors::InboundEventDraft},
    usecases::{inbox::journeys, jobs},
};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_connector::{EventKind, InboundEvent, InboundEventId, NetgsmPurpose, Provider};
use jt_inbox::*;
use serde_json::json;
use support::*;
use time::Duration;

fn meta(file: &str) -> Vec<InboundEventDraft> {
    let raw = std::fs::read(format!(
        "{}/tests/fixtures/meta/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    jt_meta::webhook::parse(&raw)
        .unwrap()
        .into_iter()
        .map(|p| p.event)
        .collect()
}
fn netgsm(file: &str, purpose: NetgsmPurpose) -> Vec<InboundEventDraft> {
    let raw = std::fs::read(format!(
        "{}/tests/fixtures/netgsm/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    jt_netgsm::webhook::parse(purpose, &raw).unwrap()
}
async fn cap(w: &World, kind: &str) -> CapabilityId {
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: kind.into(),
            name: kind.into(),
            ..Default::default()
        },
        w.owner_ctx.now,
    )
    .unwrap();
    cap.external_id = Some(cap.id.to_string());
    let id = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, None).await.unwrap();
    r.commit().await.unwrap();
    id
}
async fn put(
    w: &World,
    cap: Option<CapabilityId>,
    provider: Provider,
    draft: InboundEventDraft,
    tick: i64,
) -> InboundEventId {
    let id = InboundEventId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id,
                workspace_id: w.ws,
                capability_id: cap,
                provider,
                external_id: draft.external_id,
                kind: draft.kind,
                payload: draft.payload,
                received_at: w.owner_ctx.now + Duration::seconds(tick),
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    id
}
async fn run(w: &World) -> jobs::JobReport {
    jobs::run_inbox_consume(&w.deps, w.owner_ctx.now + Duration::minutes(1)).await
}
async fn first() -> (World, CapabilityId) {
    let w = world().await;
    let c = cap(&w, "whatsapp_cloud").await;
    put(
        &w,
        Some(c),
        Provider::Meta,
        meta("whatsapp_messages").remove(0),
        0,
    )
    .await;
    assert_eq!(run(&w).await.failed, 0);
    (w, c)
}
async fn next(w: &World, c: CapabilityId) {
    put(
        w,
        Some(c),
        Provider::Meta,
        meta("whatsapp_messages").remove(2),
        1,
    )
    .await;
    assert_eq!(run(w).await.failed, 0);
}
async fn terminal(w: &World, kind: &str, payload: serde_json::Value) {
    let j = w.uow.snapshot().inbox.journeys[0].id;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        j,
        serde_json::from_value(json!({"kind":kind,"idempotency_key":kind,"payload":payload}))
            .unwrap(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn national_phone_person_matches_inbound_whatsapp_identity() {
    let w = world().await;
    let created = jt_app::usecases::inbox::people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "National phone",
            "source": "form",
            "identities": [{"channel": "phone", "value": "5321234567"}]
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let identity_id = w.uow.snapshot().inbox.identities[0].id;
    let c = cap(&w, "whatsapp_cloud").await;
    let mut draft = meta("whatsapp_messages").remove(0);
    draft.payload["message"]["from"] = json!("905321234567");
    put(&w, Some(c), Provider::Meta, draft, 0).await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.people.len(), 1);
    assert_eq!(s.people[0].id, created.person.id);
    assert_eq!(s.identities.len(), 1);
    assert_eq!(s.identities[0].id, identity_id);
    assert_eq!(s.identities[0].value_normalized, "+905321234567");
    assert_eq!(s.conversations.len(), 1);
    assert_eq!(s.conversations[0].person_id, created.person.id);
    assert_eq!(s.messages.len(), 1);
    assert_eq!(s.messages[0].conversation_id, s.conversations[0].id);
    assert_eq!(s.message_senders.get(&s.messages[0].id), Some(&identity_id));
    assert_eq!(
        s.conversation_send_states[&s.conversations[0].id].last_inbound_identity_id,
        Some(identity_id)
    );
}

#[tokio::test]
async fn adapter_payloads_decode_without_invented_json() {
    let w = world().await;
    for (kind, file) in [
        ("whatsapp_cloud", "whatsapp_messages"),
        ("messenger", "messenger_messaging"),
        ("instagram_dm", "instagram_messaging"),
    ] {
        let c = cap(&w, kind).await;
        for (i, d) in meta(file).into_iter().enumerate() {
            put(&w, Some(c), Provider::Meta, d, i as i64).await;
        }
    }
    let c = cap(&w, "sms_line").await;
    for file in ["mo_object", "mo_array", "mo_messages", "mo_data"] {
        for d in netgsm(file, NetgsmPurpose::Mo) {
            put(&w, Some(c), Provider::Netgsm, d, 0).await;
        }
    }
    let report = run(&w).await;
    assert_eq!(report.failed, 0);
    let s = w.uow.snapshot();
    assert!(s.inbox.messages.iter().any(|m| m.body == "İkinci"));
    assert!(
        s.inbox
            .identities
            .iter()
            .any(|i| i.value_normalized == "+905000000033")
    );
    assert!(
        s.inbox
            .identities
            .iter()
            .any(|i| i.channel == IdentityChannel::Messenger)
    );
    assert!(
        s.inbox
            .identities
            .iter()
            .any(|i| i.channel == IdentityChannel::InstagramDm)
    );
    let echo = s
        .inbox
        .messages
        .iter()
        .find(|m| m.external_id.as_deref() == Some("m_TEST-ECHO-1"))
        .unwrap();
    assert_eq!(echo.author, Author::System);
    assert_eq!(echo.direction, Direction::Outbound);
    assert_eq!(echo.status, MsgStatus::Delivered);
}
#[tokio::test]
async fn duplicate_provider_event_consumed_once() {
    let (w, c) = first().await;
    let before = w.uow.snapshot().inbox;
    put(
        &w,
        Some(c),
        Provider::Meta,
        meta("whatsapp_messages").remove(0),
        1,
    )
    .await;
    assert_eq!(run(&w).await.touched, 0);
    let after = w.uow.snapshot().inbox;
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.events, before.events);
    assert_eq!(after.conversations, before.conversations);
}
#[tokio::test]
async fn lost_inbound_unassigned_human() {
    let (w, c) = first().await;
    terminal(&w, "lost", json!({"reason_key":"fiyat"})).await;
    let generation = w.uow.snapshot().inbox.conversations[0].executor_generation;
    next(&w, c).await;
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.journeys.len(), 1);
    assert_eq!(s.journeys[0].status, JourneyStatus::Lost);
    assert_eq!(s.conversations[0].state, ConvState::Ours);
    assert_eq!(
        s.conversations[0].executor,
        Executor::Human { user_id: None }
    );
    assert_eq!(s.conversations[0].executor_generation, generation + 1);
    assert!(
        s.events
            .iter()
            .any(|e| e.kind == JourneyEventKind::MessageReceived)
    );
}
#[tokio::test]
async fn won_inbound_opens_repeat() {
    let (w, c) = first().await;
    let touch = w.uow.snapshot().inbox.people[0].first_touch.clone();
    terminal(
        &w,
        "won",
        json!({"product":"Test","amount_minor":100,"currency":"TRY"}),
    )
    .await;
    next(&w, c).await;
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.journeys.len(), 2);
    assert_eq!(s.journeys[0].status, JourneyStatus::Won);
    assert_eq!(s.journeys[1].source, Source::Repeat);
    assert_eq!(s.people[0].first_touch, touch);
}
#[tokio::test]
async fn manual_ack_does_not_skip_consumption() {
    let w = world().await;
    let c = cap(&w, "sms_line").await;
    let id = put(
        &w,
        Some(c),
        Provider::Netgsm,
        netgsm("mo_object", NetgsmPurpose::Mo).remove(0),
        0,
    )
    .await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.inbound_events()
        .mark_processed(id, w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(run(&w).await.changed, 1);
    assert_eq!(w.uow.snapshot().inbox.messages.len(), 1);
}
#[tokio::test]
async fn deferred_reclaimed_by_next_version() {
    let w = world().await;
    let c = cap(&w, "sms_line").await;
    let mut drafts = netgsm("iys", NetgsmPurpose::Iys);
    drafts.extend(meta("page_leadgen"));
    let mut unknown = drafts[0].clone();
    unknown.kind = EventKind::Unknown("future".into());
    unknown.external_id = "future".into();
    drafts.push(unknown);
    for d in drafts {
        put(&w, Some(c), Provider::Netgsm, d, 0).await;
    }
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert!(s.people.is_empty());
    assert!(
        s.consumption
            .iter()
            .all(|c| c.outcome.as_ref().unwrap().outcome == "deferred")
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let candidates = r
        .inbound_events()
        .list_for_consumer("inbox@3", None, 100)
        .await
        .unwrap();
    assert_eq!(candidates.len(), s.consumption.len());
    for e in candidates {
        assert!(r.consumption().try_claim("inbox@3", e.id).await.unwrap());
    }
}
#[tokio::test]
async fn claim_effect_completion_rollback_and_retry() {
    let w = world().await;
    let c = cap(&w, "sms_line").await;
    put(
        &w,
        Some(c),
        Provider::Netgsm,
        netgsm("mo_object", NetgsmPurpose::Mo).remove(0),
        0,
    )
    .await;
    let ledger = w.uow.snapshot().ledger.len();
    w.uow.fail_inbox_consumption(1);
    assert_eq!(run(&w).await.failed, 1);
    let s = w.uow.snapshot();
    assert!(s.inbox.people.is_empty());
    assert!(s.inbox.messages.is_empty());
    assert!(s.inbox.journeys.is_empty());
    assert!(s.inbox.events.is_empty());
    assert!(s.inbox.conversations.is_empty());
    assert!(s.inbox.identities.is_empty());
    assert!(s.inbox.consumption.is_empty());
    assert_eq!(s.ledger.len(), ledger);
    assert_eq!(run(&w).await.changed, 1);
    assert_eq!(w.uow.snapshot().inbox.messages.len(), 1);
}
#[tokio::test]
async fn failure_does_not_starve_later_events() {
    let w = world().await;
    let c = cap(&w, "sms_line").await;
    let mut d = netgsm("mo_object", NetgsmPurpose::Mo).remove(0);
    d.payload["from"] = json!("invalid");
    put(&w, Some(c), Provider::Netgsm, d, 0).await;
    for (i, d) in netgsm("mo_array", NetgsmPurpose::Mo)
        .into_iter()
        .enumerate()
    {
        put(&w, Some(c), Provider::Netgsm, d, 1 + i as i64).await;
    }
    let r = run(&w).await;
    assert_eq!(r.failed, 1);
    assert_eq!(r.changed, 2);
    assert_eq!(w.uow.snapshot().inbox.messages.len(), 2);
}
#[tokio::test]
async fn unrouted_event_does_not_create_person() {
    let w = world().await;
    put(
        &w,
        None,
        Provider::Meta,
        meta("whatsapp_messages").remove(0),
        0,
    )
    .await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert!(s.people.is_empty());
    assert_eq!(
        s.consumption[0].outcome.as_ref().unwrap().outcome,
        "deferred"
    );
}
#[tokio::test]
async fn call_lifecycle_one_attempt() {
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    for (i, d) in netgsm("events", NetgsmPurpose::Events)
        .into_iter()
        .enumerate()
    {
        put(&w, Some(c), Provider::Netgsm, d, i as i64).await;
        assert_eq!(run(&w).await.failed, 0);
        assert_eq!(w.uow.snapshot().inbox.events.len(), usize::from(i >= 2));
    }
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.people.len(), 1);
    assert_eq!(s.events[0].idempotency_key, "call:1700000000.201");
    assert_eq!(
        s.events[0].kind,
        JourneyEventKind::CallMade { connected: true }
    );
}
#[tokio::test]
async fn hangup_connected_iff_answer_seen() {
    for answered in [false, true] {
        let w = world().await;
        let c = cap(&w, "netgsm_pbx").await;
        for (i, d) in netgsm("events", NetgsmPurpose::Events)
            .into_iter()
            .take(3)
            .enumerate()
        {
            if i == 1 && !answered {
                continue;
            }
            put(&w, Some(c), Provider::Netgsm, d, i as i64).await;
        }
        assert_eq!(run(&w).await.failed, 0);
        let s = w.uow.snapshot().inbox;
        assert_eq!(
            s.events[0].kind,
            JourneyEventKind::CallMade {
                connected: answered
            }
        );
        assert_eq!(s.journeys[0].unreachable_attempts, u8::from(!answered));
    }
}
#[tokio::test]
async fn late_pbx_events_are_duplicates() {
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    let drafts = netgsm("events", NetgsmPurpose::Events);
    for i in [0, 2] {
        put(&w, Some(c), Provider::Netgsm, drafts[i].clone(), i as i64).await;
    }
    assert_eq!(run(&w).await.failed, 0);
    let before = w.uow.snapshot().inbox;
    for i in [1, 3] {
        put(
            &w,
            Some(c),
            Provider::Netgsm,
            drafts[i].clone(),
            10 + i as i64,
        )
        .await;
    }
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.events, before.events);
    assert_eq!(s.journeys, before.journeys);
    assert_eq!(s.conversations, before.conversations);
    assert!(
        s.consumption
            .iter()
            .rev()
            .take(2)
            .all(|c| c.outcome.as_ref().unwrap().outcome == "duplicate")
    );
}

#[tokio::test]
async fn delivery_reports_and_our_echo_preserve_message_authorship() {
    let w = world().await;
    let c = cap(&w, "messenger").await;
    let drafts = meta("messenger_messaging");
    put(&w, Some(c), Provider::Meta, drafts[0].clone(), 0).await;
    assert_eq!(run(&w).await.failed, 0);
    let conv = w.uow.snapshot().inbox.conversations[0].clone();
    let m = Message {
        id: MessageId::new_v7(),
        workspace_id: w.ws,
        conversation_id: conv.id,
        direction: Direction::Outbound,
        author: Author::Human(w.owner),
        body: "Our sent message".into(),
        external_id: Some("m_TEST-ECHO-1".into()),
        status: MsgStatus::Sent,
        cost_minor: Some(5),
        at: w.owner_ctx.now,
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.messages().insert_if_new(m.clone()).await.unwrap();
    r.commit().await.unwrap();
    for (i, d) in drafts
        .into_iter()
        .enumerate()
        .filter(|(_, d)| matches!(d.kind, EventKind::MessageEcho | EventKind::Status))
    {
        put(&w, Some(c), Provider::Meta, d, i as i64).await;
    }
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.messages.len(), 2);
    let after = s.messages.iter().find(|a| a.id == m.id).unwrap();
    assert_eq!(after.status, MsgStatus::Delivered);
    assert_eq!(after.author, m.author);
    assert_eq!(after.body, m.body);
    assert_eq!(after.cost_minor, Some(5));
    assert_eq!(s.conversations[0].last_inbound_at, conv.last_inbound_at);
}
#[tokio::test]
async fn whatsapp_delivered_and_failed_match_only_outbound_on_the_capability() {
    let (w, c) = first().await;
    let conv = w.uow.snapshot().inbox.conversations[0].clone();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    for id in ["wamid.TEST-SENT-1", "wamid.TEST-SENT-2"] {
        r.messages()
            .insert_if_new(Message {
                id: MessageId::new_v7(),
                workspace_id: w.ws,
                conversation_id: conv.id,
                direction: Direction::Outbound,
                author: Author::Agent,
                body: String::new(),
                external_id: Some(id.into()),
                status: MsgStatus::Sent,
                cost_minor: None,
                at: w.owner_ctx.now,
            })
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let other = cap(&w, "whatsapp_cloud").await;
    for (i, mut d) in meta("whatsapp_statuses").into_iter().enumerate() {
        d.external_id = format!("wrong-account:{}", d.external_id);
        put(&w, Some(other), Provider::Meta, d, i as i64).await;
    }
    assert_eq!(run(&w).await.failed, 0);
    assert!(
        w.uow
            .snapshot()
            .inbox
            .messages
            .iter()
            .filter(|m| m.direction == Direction::Outbound)
            .all(|m| m.status == MsgStatus::Sent)
    );
    for (i, d) in meta("whatsapp_statuses").into_iter().enumerate() {
        put(&w, Some(c), Provider::Meta, d, 10 + i as i64).await;
    }
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(
        s.messages
            .iter()
            .find(|m| m.external_id.as_deref() == Some("wamid.TEST-SENT-1"))
            .unwrap()
            .status,
        MsgStatus::Delivered
    );
    assert_eq!(
        s.messages
            .iter()
            .find(|m| m.external_id.as_deref() == Some("wamid.TEST-SENT-2"))
            .unwrap()
            .status,
        MsgStatus::Failed
    );
}
#[tokio::test]
async fn replayed_message_has_no_reopen_or_executor_effects() {
    let (w, c) = first().await;
    terminal(&w, "lost", json!({"reason_key":"fiyat"})).await;
    let before = w.uow.snapshot().inbox;
    let mut d = meta("whatsapp_messages").remove(0);
    d.external_id = "replayed-envelope".into();
    put(&w, Some(c), Provider::Meta, d, 10).await;
    assert_eq!(run(&w).await.failed, 0);
    let after = w.uow.snapshot().inbox;
    assert_eq!(before.journeys, after.journeys);
    assert_eq!(before.conversations, after.conversations);
    assert_eq!(before.events, after.events);
    assert_eq!(before.messages, after.messages);
}
#[tokio::test]
async fn receiving_workspaces_consume_without_strategy_but_suspended_waits() {
    use jt_tenancy::WorkspaceStatus;
    for (status, count) in [
        (WorkspaceStatus::Active, 1),
        (WorkspaceStatus::PendingPayment, 1),
        (WorkspaceStatus::Suspended, 0),
    ] {
        let w = world().await;
        let c = cap(&w, "sms_line").await;
        put(
            &w,
            Some(c),
            Provider::Netgsm,
            netgsm("mo_object", NetgsmPurpose::Mo).remove(0),
            0,
        )
        .await;
        let mut r = w.uow.platform().await.unwrap();
        r.workspace_set_status(
            w.ws,
            status,
            "test status transition",
            &jt_ledger::Actor::System {
                component: "test".into(),
            },
        )
        .await
        .unwrap();
        r.commit().await.unwrap();
        assert_eq!(run(&w).await.changed, count);
        assert_eq!(w.uow.snapshot().inbox.messages.len(), count as usize);
    }
}
#[tokio::test]
async fn failed_first_page_does_not_starve_next_page() {
    let w = world().await;
    let c = cap(&w, "sms_line").await;
    let draft = netgsm("mo_object", NetgsmPurpose::Mo).remove(0);
    for i in 0..101 {
        let mut d = draft.clone();
        d.external_id = format!("page:{i}");
        if i < 100 {
            d.payload["from"] = json!("invalid");
        }
        put(&w, Some(c), Provider::Netgsm, d, i).await;
    }
    let report = run(&w).await;
    assert_eq!(report.failed, 100);
    assert_eq!(report.changed, 1);
    assert_eq!(report.touched, 101);
    assert_eq!(w.uow.snapshot().inbox.messages.len(), 1);
}

#[tokio::test]
async fn partial_call_activity_is_idempotent_across_consumer_versions() {
    use jt_app::ports::inbox::ConsumptionOutcome;
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    let drafts = netgsm("events", NetgsmPurpose::Events);
    let id = put(&w, Some(c), Provider::Netgsm, drafts[0].clone(), 0).await;
    assert_eq!(run(&w).await.failed, 0);
    assert!(
        w.uow
            .snapshot()
            .inbox
            .consumption
            .iter()
            .any(|row| row.consumer == "inbox.pbx_activity" && row.event_id == id)
    );
    let conv = w.uow.snapshot().inbox.conversations[0].clone();
    let id = put(&w, Some(c), Provider::Netgsm, drafts[1].clone(), 1).await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    // A previous consumer version already applied this Answer, then a user closed the conversation.
    for consumer in ["inbox@0", "inbox.pbx_activity"] {
        assert!(r.consumption().try_claim(consumer, id).await.unwrap());
        r.consumption()
            .record(
                consumer,
                id,
                ConsumptionOutcome {
                    consumed_at: w.owner_ctx.now,
                    outcome: "consumed".into(),
                },
            )
            .await
            .unwrap();
    }
    r.conversations()
        .update_state(conv.id, ConvState::Closed, None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let before = w.uow.snapshot().inbox.conversations;
    assert_eq!(run(&w).await.failed, 0);
    assert_eq!(w.uow.snapshot().inbox.conversations, before);
}

#[tokio::test]
async fn call_on_lost_journey_raises_reopen_question() {
    let w = world().await;
    // `work.pending` lists inbox work in an active workspace.
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let c = cap(&w, "netgsm_pbx").await;
    let drafts = netgsm("events", NetgsmPurpose::Events);
    put(&w, Some(c), Provider::Netgsm, drafts[0].clone(), 0).await;
    assert_eq!(run(&w).await.failed, 0);
    terminal(&w, "lost", json!({"reason_key":"fiyat"})).await;
    // A person closed the conversation; the journey is lost.
    w.uow.edit(|s| {
        for conv in &mut s.inbox.conversations {
            conv.state = ConvState::Closed;
        }
    });
    let before = w.uow.snapshot().inbox;
    for (i, d) in drafts.into_iter().enumerate().skip(1).take(2) {
        put(&w, Some(c), Provider::Netgsm, d, i as i64).await;
    }
    assert_eq!(run(&w).await.failed, 0);
    let after = w.uow.snapshot().inbox;
    // Reopening is a person's decision: no call is applied to the lost journey.
    assert_eq!(after.journeys, before.journeys);
    assert_eq!(after.events, before.events);
    // But the call is not dropped in silence: the conversation is ours again, which on a lost
    // journey is a reopen question for an owner or manager.
    assert_eq!(after.conversations[0].state, ConvState::Ours);
    assert!(
        after
            .consumption
            .iter()
            .filter(|row| row.consumer == "inbox@2")
            .rev()
            .take(2)
            .all(|row| row.outcome.as_ref().unwrap().outcome == "consumed")
    );
    // The conversation's executor is the agent: the agent sees the question.
    let agent = w.agent(&["workspace.read", "inbox.work"]).await;
    let pending = jt_app::usecases::work::pending(&w.deps, &agent)
        .await
        .unwrap();
    assert!(
        pending.items.iter().any(|i| matches!(
            i.kind,
            jt_app::usecases::work::WorkKind::ReopenQuestion { .. }
        )),
        "{:?}",
        pending.items
    );
}

#[tokio::test]
async fn inbound_records_the_exact_sender_for_reply_routing() {
    let (w, _) = first().await;
    let s = w.uow.snapshot().inbox;
    let conv = &s.conversations[0];
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let metadata = r.conversations().send_state(conv.id).await.unwrap();
    let identity = r
        .identities()
        .list(conv.person_id)
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.value_normalized == "+905551111111")
        .unwrap();
    assert_eq!(metadata.last_inbound_identity_id, Some(identity.id));
    assert_eq!(s.message_senders.get(&s.messages[0].id), Some(&identity.id));
}

#[tokio::test]
async fn last_inbound_identity_follows_latest_sender_not_processing_order() {
    use jt_app::usecases::inbox::people;
    let (w, cap) = first().await;
    let conv = w.uow.snapshot().inbox.conversations[0].clone();
    people::add_identity(
        &w.deps,
        &w.owner_ctx,
        conv.person_id,
        people::IdentityInput {
            channel: IdentityChannel::Phone,
            value: "0555 222 22 22".into(),
            capability_id: Some(cap),
        },
    )
    .await
    .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let identities = r.identities().list(conv.person_id).await.unwrap();
    let sender = |number: &str| {
        identities
            .iter()
            .find(|i| i.value_normalized == number)
            .unwrap()
            .id
    };
    let first_sender = sender("+905551111111");
    let second_sender = sender("+905552222222");
    drop(r);

    let drafts = meta("whatsapp_messages");
    // A newer second sender, an older first-sender message arriving late, then a newer first sender.
    for (index, tick, message_sender, latest_sender) in [
        (1, 2, second_sender, second_sender),
        (2, 1, first_sender, second_sender),
        (3, 3, first_sender, first_sender),
    ] {
        let draft = drafts[index].clone();
        let external_id = draft.external_id.clone();
        put(&w, Some(cap), Provider::Meta, draft, tick).await;
        assert_eq!(run(&w).await.failed, 0);
        let state = w.uow.snapshot().inbox;
        assert_eq!(state.people.len(), 1);
        assert_eq!(state.conversations.len(), 1);
        let message = state
            .messages
            .iter()
            .find(|m| m.external_id.as_deref() == Some(&external_id))
            .unwrap();
        assert_eq!(
            state.message_senders.get(&message.id),
            Some(&message_sender)
        );
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        assert_eq!(
            r.conversations()
                .send_state(conv.id)
                .await
                .unwrap()
                .last_inbound_identity_id,
            Some(latest_sender)
        );
    }
    let before = w.uow.snapshot().inbox;
    // A fresh envelope cannot make a replay of the second sender's message the latest inbound.
    let mut replay = drafts[1].clone();
    replay.external_id = "sender-replay-envelope".into();
    put(&w, Some(cap), Provider::Meta, replay, 99).await;
    assert_eq!(run(&w).await.failed, 0);
    let after = w.uow.snapshot().inbox;
    assert_eq!(after.conversations, before.conversations);
    assert_eq!(after.message_senders, before.message_senders);
    assert_eq!(
        after.conversation_send_states,
        before.conversation_send_states
    );
}

#[tokio::test]
async fn unsupported_capability_payload_is_deferred_without_a_person() {
    let w = world().await;
    let c = cap(&w, "mailbox").await;
    put(
        &w,
        Some(c),
        Provider::Meta,
        meta("whatsapp_messages").remove(0),
        0,
    )
    .await;
    let report = run(&w).await;
    assert_eq!(report.failed, 0);
    assert_eq!(report.skipped, 1);
    assert!(w.uow.snapshot().inbox.people.is_empty());
    assert_eq!(
        w.uow.snapshot().inbox.consumption[0]
            .outcome
            .as_ref()
            .unwrap()
            .outcome,
        "deferred"
    );
}
#[tokio::test]
async fn orphan_echo_defers_without_inventing_an_inbound_reply_window() {
    let w = world().await;
    let c = cap(&w, "messenger").await;
    put(
        &w,
        Some(c),
        Provider::Meta,
        meta("messenger_messaging").remove(1),
        0,
    )
    .await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert!(s.conversations.is_empty());
    assert!(s.people.is_empty());
    assert_eq!(
        s.consumption[0].outcome.as_ref().unwrap().outcome,
        "deferred"
    );
}

#[tokio::test]
async fn newer_page_routes_messages_to_live_messaging_sibling() {
    for (page_kind, messaging_kind, file) in [
        ("facebook_page", "messenger", "messenger_messaging"),
        ("instagram", "instagram_dm", "instagram_messaging"),
    ] {
        let w = world().await;
        let messaging = cap(&w, messaging_kind).await;
        let page = cap(&w, page_kind).await;
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        for id in [messaging, page] {
            let mut c = r.capabilities().lock(id).await.unwrap().unwrap();
            c.external_id = Some("shared-account".into());
            c.status = jt_capability::StoredStatus::Verified;
            c.last_verified_at = Some(w.owner_ctx.now);
            r.capabilities().update(c).await.unwrap();
        }
        r.commit().await.unwrap();
        put(&w, Some(page), Provider::Meta, meta(file).remove(0), 0).await;
        assert_eq!(run(&w).await.failed, 0);
        let s = w.uow.snapshot().inbox;
        assert_eq!(s.messages.len(), 1);
        assert_eq!(s.conversations[0].capability_id, messaging);
        assert!(
            s.identities[0]
                .value_normalized
                .starts_with("shared-account:")
        );
    }
}

#[tokio::test]
async fn batched_unanswered_call_correlates_siblings_after_hangup_id() {
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    let drafts = netgsm("events", NetgsmPurpose::Events);
    // store_all sorts provider ids: hangup is allocated before inbound_call, at the same time.
    for index in [2, 0] {
        put(&w, Some(c), Provider::Netgsm, drafts[index].clone(), 0).await;
    }
    let report = run(&w).await;
    assert_eq!(report.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.events.len(), 1);
    assert_eq!(
        s.events[0].kind,
        JourneyEventKind::CallMade { connected: false }
    );
    assert_eq!(s.journeys[0].unreachable_attempts, 1);
}

#[tokio::test]
async fn delayed_occurrence_preserves_reply_window_and_latest_sender() {
    use jt_app::usecases::inbox::people;
    let (w, c) = first().await;
    let conv = w.uow.snapshot().inbox.conversations[0].clone();
    people::add_identity(
        &w.deps,
        &w.owner_ctx,
        conv.person_id,
        people::IdentityInput {
            channel: IdentityChannel::Phone,
            value: "0555 222 22 22".into(),
            capability_id: Some(c),
        },
    )
    .await
    .unwrap();
    let before = w.uow.snapshot().inbox;
    let old_at = w.owner_ctx.now - Duration::hours(48);
    let mut old = meta("whatsapp_messages").remove(1);
    old.payload["occurred_at"] = json!(
        old_at
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    );
    put(&w, Some(c), Provider::Meta, old, 30).await;
    assert_eq!(run(&w).await.failed, 0);
    let after = w.uow.snapshot().inbox;
    assert_eq!(after.conversations[0].last_inbound_at, conv.last_inbound_at);
    assert_eq!(
        after.conversation_send_states[&conv.id].last_inbound_identity_id,
        before.conversation_send_states[&conv.id].last_inbound_identity_id
    );
    assert!(after.messages.iter().any(|m| m.at == old_at));

    // A first contact delivered two days late must also retain its expired activity window.
    let w = world().await;
    let c = cap(&w, "whatsapp_cloud").await;
    let mut old = meta("whatsapp_messages").remove(0);
    old.payload["occurred_at"] = json!(
        old_at
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    );
    put(&w, Some(c), Provider::Meta, old, 0).await;
    assert_eq!(run(&w).await.failed, 0);
    let conv = w.uow.snapshot().inbox.conversations[0].clone();
    assert_eq!(conv.last_inbound_at, Some(old_at));
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut capability = r.capabilities().lock(c).await.unwrap().unwrap();
    capability.status = jt_capability::StoredStatus::Verified;
    capability.last_verified_at = Some(w.owner_ctx.now);
    r.capabilities().update(capability).await.unwrap();
    r.capabilities()
        .set_sealed(c, Some(vec![1]), w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let error = jt_app::usecases::inbox::replies::reply(
        &w.deps,
        &w.owner_ctx,
        conv.id,
        serde_json::from_value(json!({"text":"Late reply", "intent":"reply"})).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.message, "reply_window_closed");
    assert!(w.uow.snapshot().inbox.outbox.is_empty());
}

#[tokio::test]
async fn future_or_invalid_occurrence_falls_back_to_receipt_time() {
    for occurrence in [json!("invalid"), json!("2999-01-01T00:00:00Z")] {
        let w = world().await;
        let c = cap(&w, "whatsapp_cloud").await;
        let mut draft = meta("whatsapp_messages").remove(0);
        draft.payload["occurred_at"] = occurrence;
        put(&w, Some(c), Provider::Meta, draft, 0).await;
        assert_eq!(run(&w).await.failed, 0);
        let s = w.uow.snapshot().inbox;
        assert_eq!(s.messages[0].at, w.owner_ctx.now);
        assert_eq!(s.conversations[0].last_inbound_at, Some(w.owner_ctx.now));
    }
}

async fn echo_receipt_order(echo_first: bool, delivery_first: bool, timeout: bool) {
    use jt_app::{
        ports::connectors::SendReceipt,
        usecases::inbox::{consumer, replies},
    };
    use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
    use std::sync::Arc;
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let c = cap(&w, "messenger").await;
    let cred = jt_connector::Credential::PageToken {
        page_id: c.to_string(),
        token: "test".into(),
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut capability = r.capabilities().lock(c).await.unwrap().unwrap();
    capability.status = jt_capability::StoredStatus::Verified;
    capability.last_verified_at = Some(w.owner_ctx.now);
    r.capabilities().update(capability).await.unwrap();
    r.capabilities()
        .set_sealed(c, Some(sealed), w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    put(
        &w,
        Some(c),
        Provider::Meta,
        meta("messenger_messaging").remove(0),
        0,
    )
    .await;
    assert_eq!(run(&w).await.failed, 0);
    let conv = w.uow.snapshot().inbox.conversations[0].id;
    let connector = Arc::new(ScriptedConnector::new(Provider::Meta));
    connector.push_send_text(if timeout {
        Err(jt_connector::ConnectorError::unknown("test timeout"))
    } else {
        Ok(SendReceipt {
            provider_id: "m_TEST-ECHO-1".into(),
            cost_minor: Some(3),
        })
    });
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    if echo_first {
        put(
            &w,
            Some(c),
            Provider::Meta,
            meta("messenger_messaging").remove(1),
            1,
        )
        .await;
        if delivery_first {
            let delivery = meta("messenger_messaging")
                .into_iter()
                .find(|d| d.kind == EventKind::Status && d.payload["mid"] == "m_TEST-ECHO-1")
                .unwrap();
            put(&w, Some(c), Provider::Meta, delivery, 2).await;
        }
        let deps = w.deps.clone();
        let ws = w.ws;
        let now = w.owner_ctx.now + Duration::minutes(1);
        connector.push_send_hook(move || async move {
            assert_eq!(consumer::consume_workspace(&deps, ws, now).await.failed, 0);
        });
    }
    let result = replies::reply(
        &w.deps,
        &w.owner_ctx,
        conv,
        serde_json::from_value(json!({"text":"Hoş geldiniz","intent":"reply"})).unwrap(),
    )
    .await
    .unwrap();
    let expected_outbox = if timeout { "unknown" } else { "sent" };
    assert_eq!(result.state, expected_outbox);
    if !echo_first {
        put(
            &w,
            Some(c),
            Provider::Meta,
            meta("messenger_messaging").remove(1),
            1,
        )
        .await;
        assert_eq!(run(&w).await.failed, 0);
    }
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.messages.len(), 2);
    let sent = s
        .messages
        .iter()
        .find(|m| m.id == result.message_id)
        .unwrap();
    assert_eq!(sent.author, Author::Human(w.owner));
    assert_eq!(sent.external_id.as_deref(), Some("m_TEST-ECHO-1"));
    assert_eq!(sent.cost_minor, if timeout { None } else { Some(3) });
    assert_eq!(
        sent.status,
        if delivery_first {
            MsgStatus::Delivered
        } else {
            MsgStatus::Sent
        }
    );
    assert_eq!(s.outbox[0].state, expected_outbox);
}
#[tokio::test]
async fn echo_before_receipt_attaches_to_original_outbound() {
    echo_receipt_order(true, false, false).await;
}
#[tokio::test]
async fn receipt_before_echo_preserves_original_outbound() {
    echo_receipt_order(false, false, false).await;
}

#[tokio::test]
async fn message_lookup_and_echo_binding_contract() {
    jt_testkit::inbox_contract::message_receipt_lookup_and_echo_binding(std::sync::Arc::new(
        jt_testkit::fakes::InMemoryUow::default(),
    ))
    .await;
}

#[tokio::test]
async fn sibling_resolution_rejects_missing_retired_and_other_account() {
    for variant in ["missing", "retired", "other_account"] {
        let w = world().await;
        let page = cap(&w, "facebook_page").await;
        if variant != "missing" {
            let messenger = cap(&w, "messenger").await;
            let mut r = w.uow.tenant(w.ws).await.unwrap();
            let mut c = r.capabilities().lock(messenger).await.unwrap().unwrap();
            if variant == "retired" {
                c.external_id = Some(page.to_string());
                c.status = jt_capability::StoredStatus::Retired;
            }
            r.capabilities().update(c).await.unwrap();
            r.commit().await.unwrap();
        }
        put(
            &w,
            Some(page),
            Provider::Meta,
            meta("messenger_messaging").remove(0),
            0,
        )
        .await;
        assert_eq!(run(&w).await.skipped, 1, "{variant}");
        assert!(w.uow.snapshot().inbox.people.is_empty(), "{variant}");
    }
}

#[tokio::test]
async fn occurrence_future_skew_is_bounded_at_five_minutes() {
    for (seconds, accepted) in [(300, true), (301, false)] {
        let w = world().await;
        let c = cap(&w, "whatsapp_cloud").await;
        let mut draft = meta("whatsapp_messages").remove(0);
        let occurred = w.owner_ctx.now + Duration::seconds(seconds);
        draft.payload["occurred_at"] = json!(
            occurred
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        );
        put(&w, Some(c), Provider::Meta, draft, 0).await;
        assert_eq!(run(&w).await.failed, 0);
        let expected = if accepted { occurred } else { w.owner_ctx.now };
        let s = w.uow.snapshot().inbox;
        assert_eq!(s.messages[0].at, expected);
        assert_eq!(s.conversations[0].last_inbound_at, Some(expected));
    }
}

#[tokio::test]
async fn echo_and_delivery_before_receipt_preserve_delivery_status() {
    echo_receipt_order(true, true, false).await;
}

#[tokio::test]
async fn echo_and_delivery_before_timeout_preserve_delivery_status() {
    echo_receipt_order(true, true, true).await;
}

#[tokio::test]
async fn unanswered_pbx_call_uses_workspace_threshold() {
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut policy = r.workspace_policy().get().await.unwrap();
    policy.inbox.unreachable_threshold = 1;
    r.workspace_policy()
        .set(policy, w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    for (i, d) in netgsm("events", NetgsmPurpose::Events)
        .into_iter()
        .take(3)
        .enumerate()
    {
        if i != 1 {
            put(&w, Some(c), Provider::Netgsm, d, i as i64).await;
        }
    }
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.journeys[0].status, JourneyStatus::Unreachable);
    assert_eq!(s.inbox.journeys[0].unreachable_attempts, 1);
}

#[tokio::test]
async fn call_events_are_scoped_bounded_ordered_and_uncapped() {
    jt_testkit::inbox_contract::call_events_are_scoped_bounded_ordered_and_uncapped(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    )
    .await;
}

#[tokio::test]
async fn email_matches_normalized_identity() {
    let w = world().await;
    let c = cap(&w, "mailbox").await;
    for (n, sender) in ["ADA@Example.com", "ada@example.com"].iter().enumerate() {
        put(&w, Some(c), Provider::Mail, InboundEventDraft {
            external_id: format!("imap:account:INBOX:1:{n}"),
            kind: EventKind::Message,
            payload: json!({"from":sender,"to":["support@example.com"],"subject":"Help","text":"Hello","message_id":format!("<in-{n}@example.com>")}),
            occurred_at: None,
        }, n as i64).await;
    }
    let report = run(&w).await;
    assert_eq!(report.failed, 0);
    assert_eq!(report.changed, 2);
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.people.len(), 1);
    assert_eq!(s.inbox.identities[0].value_normalized, "ada@example.com");
    assert_eq!(s.inbox.messages.len(), 2);
    assert_eq!(s.inbox.conversations.len(), 1);
    assert_eq!(run(&w).await.changed, 0);
}

#[tokio::test]
async fn an_email_sender_is_named_by_their_from_display_name() {
    let w = world().await;
    let c = cap(&w, "mailbox").await;
    let raw = b"From: =?UTF-8?B?QXnFn2UgWcSxbG1heg==?= <ayse@example.com>\r\nTo: support@example.com\r\nMessage-ID: <named@example.com>\r\nSubject: Merhaba\r\n\r\nFiyat alabilir miyim?";
    let draft = jt_mail::parse_message("account", "INBOX", 42, 1, raw, false).unwrap();
    put(&w, Some(c), Provider::Mail, draft, 0).await;
    // A second address with no display name stays unnamed rather than borrowing anything.
    put(&w, Some(c), Provider::Mail, InboundEventDraft {
        external_id: "imap:account:INBOX:42:2".into(),
        kind: EventKind::Message,
        payload: json!({"from":"anon@example.com","name":null,"text":"Hello","message_id":"<anon@example.com>"}),
        occurred_at: None,
    }, 1).await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot();
    let mut names: Vec<_> = s
        .inbox
        .people
        .iter()
        .map(|p| p.display_name.clone())
        .collect();
    names.sort();
    assert_eq!(names, vec![String::new(), "Ayşe Yılmaz".to_owned()]);
}

#[tokio::test]
async fn iys_hook_and_bounce_use_adapter_fixtures() {
    let mut w = world().await;
    w.owner_ctx.now += Duration::days(2);
    let c = cap(&w, "sms_line").await;
    let p=jt_app::usecases::inbox::people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"+905000000061"},{"channel":"email","value":"ada@example.com"}],"source":"form"})).unwrap()).await.unwrap().person;
    let mut draft = netgsm("iys", NetgsmPurpose::Iys).remove(0);
    draft.payload["occurred_at"] = json!(
        draft
            .occurred_at
            .unwrap()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    );
    let id = put(&w, Some(c), Provider::Netgsm, draft, 0).await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.consumption().try_claim("inbox@1", id).await.unwrap();
    r.consumption()
        .record(
            "inbox@1",
            id,
            jt_app::ports::inbox::ConsumptionOutcome {
                consumed_at: w.owner_ctx.now,
                outcome: "deferred".into(),
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(run(&w).await.changed, 1);
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let rows = r.consents().list(p.id).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, ConsentKind::Explicit);
    assert_eq!(rows[0].sync_state, SyncState::Sent);
    drop(r);
    let mail = cap(&w, "mailbox").await;
    let raw = include_bytes!("../../adapters/jt_mail/tests/fixtures/withdrawal.eml");
    let draft = jt_mail::parse_message("account", "INBOX", 42, 1, raw, false).unwrap();
    // Fixture sender is retained: create exactly the identity produced by the adapter.
    jt_app::usecases::inbox::people::add_identity(
        &w.deps,
        &w.owner_ctx,
        p.id,
        serde_json::from_value(json!({"channel":"email","value":draft.payload["from"]})).unwrap(),
    )
    .await
    .unwrap();
    put(&w, Some(mail), Provider::Mail, draft, 1).await;
    assert_eq!(run(&w).await.changed, 1);
    assert_eq!(run(&w).await.changed, 0);
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        r.consents()
            .list(p.id)
            .await
            .unwrap()
            .iter()
            .any(|c| c.kind == ConsentKind::Withdrawn && c.channel == Channel::Email)
    );
    assert!(
        r.suppressions()
            .list(p.id)
            .await
            .unwrap()
            .iter()
            .any(|s| s.reason == SuppressionReason::Unsubscribe)
    );
}

#[tokio::test]
async fn mail_subject_is_the_newest_received_mail_of_the_capability() {
    jt_testkit::inbox_contract::mail_subject_is_the_newest_received_mail_of_the_capability(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// Deferred consumption is retried, then abandoned (C5); placed calls follow the PBX (V0-T3)
// ---------------------------------------------------------------------------------------------

async fn run_at(w: &World, at: time::OffsetDateTime) -> jobs::JobReport {
    jobs::run_inbox_consume(&w.deps, at).await
}

fn consumption_of(w: &World, id: InboundEventId) -> jt_testkit::fakes::StoredConsumption {
    w.uow
        .snapshot()
        .inbox
        .consumption
        .into_iter()
        .find(|c| c.consumer == "inbox@2" && c.event_id == id)
        .expect("a consumption row")
}

#[tokio::test]
async fn deferred_event_is_retried_with_backoff() {
    let w = world().await;
    let id = put(
        &w,
        None,
        Provider::Meta,
        meta("whatsapp_messages").remove(0),
        0,
    )
    .await;
    let t0 = w.owner_ctx.now + Duration::minutes(1);
    run_at(&w, t0).await;
    let row = consumption_of(&w, id);
    assert_eq!(row.outcome.as_ref().unwrap().outcome, "deferred");
    assert_eq!(
        (row.attempts, row.retry_at),
        (1, Some(t0 + Duration::hours(1)))
    );
    // Not due yet: left alone.
    run_at(&w, t0 + Duration::minutes(30)).await;
    assert_eq!(consumption_of(&w, id).attempts, 1);
    // Due: tried again and deferred again, now two hours on.
    let t1 = t0 + Duration::hours(1);
    run_at(&w, t1).await;
    let row = consumption_of(&w, id);
    assert_eq!(row.outcome.as_ref().unwrap().outcome, "deferred");
    assert_eq!(
        (row.attempts, row.retry_at),
        (2, Some(t1 + Duration::hours(2)))
    );
    // The backoff never exceeds a day.
    assert_eq!(
        jt_app::ports::inbox::deferral_due(t0, 30),
        t0 + Duration::hours(24)
    );
}

#[tokio::test]
async fn deferred_is_abandoned_after_seven_days() {
    let w = world().await;
    let id = put(
        &w,
        None,
        Provider::Meta,
        meta("whatsapp_messages").remove(0),
        0,
    )
    .await;
    run_at(&w, w.owner_ctx.now + Duration::minutes(1)).await;
    run_at(&w, w.owner_ctx.now + Duration::days(8)).await;
    let row = consumption_of(&w, id);
    assert_eq!(row.outcome.as_ref().unwrap().outcome, "abandoned");
    assert_eq!(row.retry_at, None);
    let abandoned = w.entries("inbox.event.abandoned");
    assert_eq!(abandoned.len(), 1);
    assert_eq!(abandoned[0].payload, json!({ "event_id": id }));
    // Abandoned is final.
    run_at(&w, w.owner_ctx.now + Duration::days(9)).await;
    assert_eq!(w.entries("inbox.event.abandoned").len(), 1);
}

#[tokio::test]
async fn netgsm_event_attaches_after_capability_connects() {
    let w = world().await;
    // An SMS arrived while no SMS line was live: stored without a capability, deferred.
    let sms = netgsm("mo_object", NetgsmPurpose::Mo).remove(0);
    let id = put(&w, None, Provider::Netgsm, sms, 0).await;
    let t0 = w.owner_ctx.now + Duration::minutes(1);
    run_at(&w, t0).await;
    assert_eq!(consumption_of(&w, id).outcome.unwrap().outcome, "deferred");
    assert!(w.uow.snapshot().inbox.people.is_empty());
    // The line connects; within the hour the event is consumed through it.
    cap(&w, "sms_line").await;
    run_at(&w, t0 + Duration::hours(1)).await;
    assert_eq!(consumption_of(&w, id).outcome.unwrap().outcome, "consumed");
    assert_eq!(w.uow.snapshot().inbox.people.len(), 1);
}

#[tokio::test]
async fn voice_report_is_consumed_not_deferred() {
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    let mut ids = Vec::new();
    for (i, d) in netgsm("voice_report", NetgsmPurpose::VoiceReport)
        .into_iter()
        .enumerate()
    {
        ids.push(put(&w, Some(c), Provider::Netgsm, d, i as i64).await);
    }
    assert_eq!(run(&w).await.failed, 0);
    assert_eq!(
        consumption_of(&w, ids[0]).outcome.unwrap().outcome,
        "consumed"
    );
    let reports = w.entries("inbox.netgsm_report");
    assert!(!reports.is_empty());
    assert_eq!(reports[0].payload["report"], "voice-report");
    assert!(
        w.uow.snapshot().inbox.events.is_empty(),
        "no journey effect"
    );
}

/// A rep's call placed through `pbx`, its PBX correlation id `crm`, as `calls.place` leaves it.
async fn placed_call(
    w: &World,
    pbx: CapabilityId,
    crm: &str,
    recording: bool,
) -> jt_app::ports::calls::CallId {
    use jt_app::ports::calls::*;
    let session = CallSession {
        id: CallId::new_v7(),
        workspace_id: w.ws,
        capability_id: pbx,
        direction: CallDirection::Outbound,
        purpose: CallPurpose::Service,
        person_id: None,
        journey_id: None,
        mode: CallMode::Human {
            rep_extension: "101".into(),
        },
        state: CallState::Dialing,
        plan: None,
        counterpart_e164: "+905000000051".into(),
        bridge_call_id: None,
        pbx_unique_id: None,
        crm_id: Some(crm.into()),
        agent_connection_id: None,
        placed_by: jt_ledger::Actor::Human { user_id: w.owner },
        started_at: w.owner_ctx.now,
        answered_at: None,
        ended_at: None,
        end_cause: None,
        outcome: None,
        summary: None,
        duration_s: None,
        cost_minor: None,
        recording: if recording {
            RecordingState::Recording { file_ref: None }
        } else {
            RecordingState::Off
        },
        metrics: CallMetrics::default(),
        clock: TurnClock::default(),
        phrases: Default::default(),
    };
    let id = session.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.calls().insert(session, w.owner_ctx.now).await.unwrap();
    r.commit().await.unwrap();
    id
}

fn call_event(scenario: &str, extra: serde_json::Value) -> InboundEventDraft {
    let mut payload = json!({
        "scenario": scenario,
        "unique_id": "1700000000.301",
        "customer_num": "905000000051",
        "internal_num": "101",
    });
    for (k, v) in extra.as_object().unwrap() {
        payload[k] = v.clone();
    }
    InboundEventDraft {
        external_id: format!("netgsm-call:1700000000.301:{scenario}"),
        kind: EventKind::CallEvent,
        payload,
        occurred_at: None,
    }
}

fn session_of(w: &World, id: jt_app::ports::calls::CallId) -> jt_app::ports::calls::CallSession {
    w.uow
        .snapshot()
        .calls
        .sessions
        .into_iter()
        .find(|s| s.id == id)
        .unwrap()
}

#[tokio::test]
async fn hangup_event_ends_human_session() {
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    let call = placed_call(&w, c, "crm-301", false).await;
    let answer = call_event("answer", json!({ "crm_id": "crm-301" }));
    put(&w, Some(c), Provider::Netgsm, answer, 5).await;
    let hangup = call_event("hangup", json!({ "crm_id": "crm-301", "duration_sec": 42 }));
    put(&w, Some(c), Provider::Netgsm, hangup, 50).await;
    assert_eq!(run(&w).await.failed, 0);
    let session = session_of(&w, call);
    assert_eq!(session.state, jt_app::ports::calls::CallState::Ended);
    assert_eq!(session.pbx_unique_id.as_deref(), Some("1700000000.301"));
    assert_eq!(
        session.answered_at,
        Some(w.owner_ctx.now + Duration::seconds(5))
    );
    assert_eq!(session.duration_s, Some(42));
    assert_eq!(
        session.end_cause,
        Some(jt_app::ports::calls::EndCause::CallerHangup)
    );
    // The journey heard of it once, connected.
    let events = w.uow.snapshot().inbox.events;
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].kind,
        JourneyEventKind::CallMade { connected: true }
    );
}

#[tokio::test]
async fn cdr_event_backfills_session_duration_and_recording() {
    let w = world().await;
    let c = cap(&w, "netgsm_pbx").await;
    let call = placed_call(&w, c, "crm-302", true).await;
    let hangup = call_event("hangup", json!({ "crm_id": "crm-302" }));
    put(&w, Some(c), Provider::Netgsm, hangup, 30).await;
    // The call record carries no crm id: correlated by the PBX's call id the hangup taught.
    let record = call_event(
        "cdr",
        json!({ "duration_sec": 61, "recording": "https://dosya.example.invalid/kayit/301.wav" }),
    );
    put(&w, Some(c), Provider::Netgsm, record, 3600).await;
    let report = run_at(&w, w.owner_ctx.now + Duration::hours(2)).await;
    assert_eq!(report.failed, 0);
    let session = session_of(&w, call);
    assert_eq!(session.duration_s, Some(61));
    assert_eq!(
        session.recording,
        jt_app::ports::calls::RecordingState::Recording {
            file_ref: Some("https://dosya.example.invalid/kayit/301.wav".into())
        }
    );
    // A call record never adds a second journey event.
    let made = w
        .uow
        .snapshot()
        .inbox
        .events
        .iter()
        .filter(|e| matches!(e.kind, JourneyEventKind::CallMade { .. }))
        .count();
    assert_eq!(made, 1);
}
