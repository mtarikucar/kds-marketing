mod support;
use jt_app::{ports::UnitOfWork, usecases::inbox::consumer};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, InboundEvent, InboundEventId, Provider};
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
use std::sync::Arc;
use support::*;
use time::Duration;

/// A messaging capability of `kind` holding `account`, sealed with a Page token, and the Meta
/// adapter that answers for it.
async fn setup(kind: &str, account: &str) -> (World, CapabilityId, Arc<ScriptedConnector>) {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let connector = Arc::new(ScriptedConnector::new(Provider::Meta));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
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
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(w.owner_ctx.now);
    cap.external_id = Some(account.into());
    let cred = Credential::PageToken {
        page_id: account.into(),
        token: "secret-page-token".into(),
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    (w, id, connector)
}
async fn put(w: &World, cap: CapabilityId, file: &str, index: usize, tick: i64) {
    let raw = std::fs::read(format!(
        "{}/tests/fixtures/meta/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let draft = jt_meta::webhook::parse(&raw).unwrap().remove(index).event;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: w.ws,
                capability_id: Some(cap),
                provider: Provider::Meta,
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
}
async fn run(w: &World) -> jt_app::usecases::jobs::JobReport {
    consumer::consume_workspace(&w.deps, w.ws, w.owner_ctx.now + Duration::minutes(1)).await
}

#[tokio::test]
async fn a_new_messenger_sender_is_named_once_from_the_provider() {
    let (w, cap, connector) = setup("messenger", "1234567890").await;
    connector.push_sender_name(Ok(Some("  Ada\u{7} Messenger ".into())));
    put(&w, cap, "messenger_messaging", 0, 0).await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.people.len(), 1);
    assert_eq!(s.people[0].display_name, "Ada Messenger");
    assert_eq!(connector.sender_name_calls(), ["2000000000000001"]);
    // The same sender again (a postback): the person is known, so the provider is not asked.
    put(&w, cap, "messenger_messaging", 2, 1).await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.people.len(), 1);
    assert_eq!(s.messages.len(), 2);
    assert_eq!(connector.sender_name_calls().len(), 1);
    // The name never reaches the ledger.
    let ledger = serde_json::to_string(&w.uow.snapshot().ledger).unwrap();
    assert!(!ledger.contains("Ada Messenger"));
    assert!(!ledger.contains("secret-page-token"));
}

#[tokio::test]
async fn an_instagram_sender_is_named_from_the_provider() {
    let (w, cap, connector) = setup("instagram_dm", "17841400000000001").await;
    connector.push_sender_name(Ok(Some("ada.ig".into())));
    put(&w, cap, "instagram_messaging", 0, 0).await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.people[0].display_name, "ada.ig");
    assert_eq!(connector.sender_name_calls(), ["3000000000000001"]);
}

#[tokio::test]
async fn a_failed_or_empty_lookup_never_blocks_the_message() {
    for answer in [
        Err(ConnectorError::transient("graph down")),
        Ok(None),
        Ok(Some("   ".into())),
    ] {
        let (w, cap, connector) = setup("messenger", "1234567890").await;
        connector.push_sender_name(answer);
        put(&w, cap, "messenger_messaging", 0, 0).await;
        let report = run(&w).await;
        assert_eq!((report.failed, report.changed), (0, 1));
        let s = w.uow.snapshot().inbox;
        assert_eq!(s.people.len(), 1);
        assert_eq!(s.people[0].display_name, "");
        assert_eq!(s.messages.len(), 1);
    }
}

#[tokio::test]
async fn whatsapp_keeps_the_webhook_name_without_a_lookup() {
    let (w, cap, connector) = setup("whatsapp_cloud", "5555555555").await;
    put(&w, cap, "whatsapp_messages", 0, 0).await;
    assert_eq!(run(&w).await.failed, 0);
    let s = w.uow.snapshot().inbox;
    assert_eq!(s.people[0].display_name, "Test Kişi");
    assert!(connector.sender_name_calls().is_empty());
}
