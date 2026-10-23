//! No database, socket or live provider: a provider fixture enters the consumer and is answered.
mod support;

use jt_app::{
    ports::{UnitOfWork, connectors::SendReceipt},
    usecases::{
        events,
        inbox::{context, replies},
        jobs,
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, InboundEvent, InboundEventId, Provider};
use jt_inbox::{ConvState, EventSource, JourneyEventKind, JourneyStatus, MsgStatus};
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn scripted_whatsapp_consumer_reply_and_events_ack() {
    let mut w = support::world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let connector = Arc::new(ScriptedConnector::new(Provider::Meta));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "whatsapp_cloud".into(),
            name: "Smoke WhatsApp".into(),
            ..Default::default()
        },
        w.owner_ctx.now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(w.owner_ctx.now);
    cap.external_id = Some("5555555555".into());
    let credential = Credential::WhatsAppCloud {
        phone_number_id: "5555555555".into(),
        token: "test-token".into(),
        waba_id: None,
        expires_at: None,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let parsed = jt_meta::webhook::parse(include_bytes!("fixtures/meta/whatsapp_messages.json"))
        .unwrap()
        .remove(0)
        .event;
    let event_id = InboundEventId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let cap_id = cap.id;
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: event_id,
                workspace_id: w.ws,
                capability_id: Some(cap_id),
                provider: Provider::Meta,
                external_id: parsed.external_id,
                kind: parsed.kind,
                payload: parsed.payload,
                received_at: w.owner_ctx.now,
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let consumed = jobs::run_inbox_consume(&w.deps, w.owner_ctx.now).await;
    assert_eq!((consumed.changed, consumed.failed), (1, 0));
    let snapshot = w.uow.snapshot();
    assert_eq!(snapshot.inbox.people.len(), 1);
    assert_eq!(snapshot.inbox.journeys.len(), 1);
    assert_eq!(snapshot.inbox.conversations.len(), 1);
    assert_eq!(snapshot.inbox.messages.len(), 1);
    let conversation = snapshot.inbox.conversations[0].id;
    let agent = w
        .agent(&["inbox.work", "workspace.read", "capabilities.manage"])
        .await;
    let before = context::context(&w.deps, &agent, conversation)
        .await
        .unwrap();
    assert_eq!(before.person.id, snapshot.inbox.people[0].id);
    assert_eq!(before.journey.unwrap().id, snapshot.inbox.journeys[0].id);
    assert_eq!(before.status_labels.len(), 9);
    connector.push_send_text(Ok(SendReceipt {
        provider_id: "smoke-send-1".into(),
        cost_minor: None,
    }));
    let sent = replies::reply(
        &w.deps,
        &agent,
        conversation,
        serde_json::from_value(
            json!({"text":"Merhaba!", "intent":"reply", "request_key":"smoke-reply"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(sent.state, "sent");
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.messages.len(), 2);
    assert_eq!(after.inbox.messages[1].status, MsgStatus::Sent);
    assert_eq!(after.inbox.conversations[0].state, ConvState::Theirs);
    assert_eq!(after.inbox.journeys[0].status, JourneyStatus::Contacted);
    assert!(
        after
            .inbox
            .events
            .iter()
            .any(|e| e.kind == JourneyEventKind::Replied && e.source == EventSource::System)
    );
    assert_eq!(connector.calls().len(), 1);
    // Consumption has its own cursor: it must not acknowledge the agent's event queue.
    let pending = events::pending(&w.deps, &agent, Default::default())
        .await
        .unwrap();
    assert_eq!(pending.events.len(), 1);
    assert_eq!(pending.events[0].id, event_id);
    assert_eq!(
        events::ack(
            &w.deps,
            &agent,
            events::Ack {
                ids: vec![event_id]
            }
        )
        .await
        .unwrap()
        .acked,
        1
    );
    assert!(
        events::pending(&w.deps, &agent, Default::default())
            .await
            .unwrap()
            .events
            .is_empty()
    );
    assert_eq!(
        jobs::run_inbox_consume(&w.deps, w.owner_ctx.now)
            .await
            .changed,
        0
    );
    assert_eq!(w.uow.snapshot().inbox.messages.len(), 2);
}
