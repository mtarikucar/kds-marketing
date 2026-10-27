//! Provider text crossing the real Meta adapter and the connector use cases into public outputs.

mod support;

use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::connectors::{
    AdBudgetWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports, InsightsReader,
    LeadGenFetcher, MailSender, MailboxPoller, MessagingSender, OAuthProvider, Publisher,
    SmsSender, Telephony,
};
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::capabilities::{self, DeclareInput};
use jt_app::usecases::connector::{self, CompleteOAuth, ConfirmAssets, OAuthCallback, StartOAuth};
use jt_capability::Capability;
use jt_connector::{Credential, Provider};
use jt_meta::{MetaConnector, PAGE_LEADGEN_FIELD, PAGE_MESSAGING_FIELDS};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, deps};
use jt_testkit::flows::activate_workspace;
use serde_json::{Value, json};
use support::*;
use url::Url;

/// Both operations resolve to the real adapter; unrelated operations are absent.
struct MetaRegistry(Arc<MetaConnector>);

impl ConnectorRegistry for MetaRegistry {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn Connector>)
    }

    fn oauth(&self, provider: Provider) -> Option<Arc<dyn OAuthProvider>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn OAuthProvider>)
    }

    fn mail_sender(&self, _provider: Provider) -> Option<Arc<dyn MailSender>> {
        None
    }

    fn mailbox_poller(&self, _provider: Provider) -> Option<Arc<dyn MailboxPoller>> {
        None
    }

    fn sms(&self, _: Provider) -> Option<Arc<dyn SmsSender>> {
        None
    }
    fn publisher(&self, _: Provider) -> Option<Arc<dyn Publisher>> {
        None
    }
    fn insights(&self, _: Provider) -> Option<Arc<dyn InsightsReader>> {
        None
    }
    fn messaging(&self, _: Provider) -> Option<Arc<dyn MessagingSender>> {
        None
    }
    fn ads(&self, _: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        None
    }
    fn leadgen(&self, provider: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn LeadGenFetcher>)
    }
    fn telephony(&self, _: Provider) -> Option<Arc<dyn Telephony>> {
        None
    }
    fn consent(&self, _: Provider) -> Option<Arc<dyn ConsentSync>> {
        None
    }
    fn delivery_reports(&self, _: Provider) -> Option<Arc<dyn DeliveryReports>> {
        None
    }
}

const TOKEN: &str = "SENTINEL~echo/token+value==";

fn assert_no_token(shown: &str, encoded: &str) {
    for secret in [TOKEN, encoded, &TOKEN[..8]] {
        assert!(
            !shown.contains(secret),
            "public output leaked {secret:?}: {shown}"
        );
    }
}

/// Fails if provider free text is exposed without stripping the token, or if stripping happens
/// after truncation and leaves a token prefix. Covers a probe's successful envelope containing
/// a failed result, and both application error mappings from an OAuth token exchange.
#[tokio::test]
async fn meta_error_text_echoing_the_token_never_reaches_use_case_outputs() {
    let mock = Mock::start().await;
    let apps = Arc::new(TestApps::default());
    let meta = Arc::new(MetaConnector::new(
        egress(&mock),
        bases(&mock),
        apps.clone(),
    ));
    let mut deps = deps(Arc::new(InMemoryUow::new()));
    deps.apps = apps;
    deps.connectors = Arc::new(MetaRegistry(meta));
    let session = auth::register(
        &deps,
        RegisterInput {
            email: "owner@echo.test".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Echo test".into(),
        },
    )
    .await
    .unwrap();
    let ws = session.me.current_workspace.unwrap();
    activate_workspace(&deps, ws).await;
    let principal = auth::resolve_session(&deps, &session.token).await.unwrap();
    let ctx = auth::ctx_for(&principal, ws, FIXED_NOW).unwrap();
    let capability = capabilities::declare(
        &deps,
        &ctx,
        DeclareInput {
            kind_key: "facebook_page".into(),
            name: "Test page".into(),
            external_id: Some("1234567890".into()),
            ..DeclareInput::default()
        },
    )
    .await
    .unwrap();
    let credential = Credential::PageToken {
        page_id: "1234567890".into(),
        token: TOKEN.into(),
    };
    let sealed = deps
        .seal
        .seal(ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let mut repos = deps.uow.tenant(ws).await.unwrap();
    repos
        .capabilities()
        .set_sealed(capability.capability.id, Some(sealed), FIXED_NOW)
        .await
        .unwrap();
    repos.commit().await.unwrap();

    let flow = connector::start_oauth(
        &deps,
        &ctx,
        StartOAuth {
            kind_key: "facebook_page".into(),
        },
    )
    .await
    .unwrap();
    let state = Url::parse(&flow.authorize_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let encoded: String = url::form_urlencoded::byte_serialize(TOKEN.as_bytes()).collect();
    assert_ne!(encoded, TOKEN);

    for (http, code, kind, app_code) in [
        (400, 190, "auth", ErrorCode::Validation),
        (503, 2, "transient", ErrorCode::UpstreamUnavailable),
    ] {
        let prefix = format!("HTTP {http} OAuthException (#{code}): ");
        // Put ten token characters before each cut: checking only the whole token would miss
        // a leaked prefix. Cover the requested 200-character boundary and the adapter's 300.
        for message in [
            format!("The value {TOKEN} is invalid"),
            format!("The value {encoded} is invalid"),
            format!(
                "{}{TOKEN} trailing words",
                "x".repeat(200 - prefix.len() - 10)
            ),
            format!(
                "{}{TOKEN} trailing words",
                "x".repeat(300 - prefix.len() - 10)
            ),
        ] {
            mock.clear();
            let error = status(
                http,
                json!({"error": {
                    "message": message, "type": "OAuthException", "code": code,
                }}),
            );
            mock.set("GET", "/fb/v19.0/me", error.clone());
            let out = connector::probe(&deps, &ctx, capability.capability.id)
                .await
                .unwrap();
            assert!(!out.result.ok);
            assert_eq!(out.result.error_kind.as_deref(), Some(kind));
            let reason = out.result.error_reason.as_deref().expect("provider reason");
            assert!(reason.contains("***"), "{reason}");
            assert_no_token(reason, &encoded);
            assert_no_token(&serde_json::to_string(&out).unwrap(), &encoded);
            assert_no_token(&format!("{out:?}"), &encoded);
            assert_graph_auth(&mock.request("GET", "/fb/v19.0/me"), TOKEN);

            // The code exchange succeeds; the long-lived exchange echoes the short token
            // sent in fb_exchange_token, so the real adapter knows the secret to remove.
            let exchange = "/fb/v19.0/oauth/access_token";
            mock.set("GET", exchange, ok(json!({"access_token": TOKEN})));
            mock.on("GET", exchange, error);
            let err = connector::complete_oauth(
                &deps,
                CompleteOAuth {
                    callback: OAuthCallback::Meta,
                    state: state.clone(),
                    code: "synthetic-authorization-code".into(),
                    principal: &principal,
                },
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, app_code);
            assert_eq!(err.details["provider"], "meta");
            let reason = err.details["reason"].as_str().expect("provider reason");
            assert!(reason.contains("***"), "{reason}");
            assert_no_token(&err.message, &encoded);
            assert_no_token(&err.details.to_string(), &encoded);
            assert_no_token(&serde_json::to_string(&err).unwrap(), &encoded);
            assert_no_token(&err.to_string(), &encoded);
            assert_no_token(&format!("{err:?}"), &encoded);
            let requests = mock.requests("GET", exchange);
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[1].param("fb_exchange_token"), Some(TOKEN));
        }
    }
    assert!(mock.violations().is_empty(), "invalid Graph authentication");
}

/// Connects page `1234567890` through Facebook Login, the real adapter answered by the mock with
/// a grant of `scopes` (`/me/permissions`), and returns the mock and the capabilities the owner's
/// choice of the page connected (its `facebook_page` and its `messenger`).
async fn connect_page_granting(scopes: &[&str]) -> (Mock, Vec<Capability>) {
    let mock = Mock::start().await;
    let exchange = "/fb/v19.0/oauth/access_token";
    mock.on(
        "GET",
        exchange,
        ok(graph_fixture(&mock, "oauth_short_token")),
    );
    mock.on(
        "GET",
        exchange,
        ok(graph_fixture(&mock, "oauth_long_token")),
    );
    let granted: Vec<Value> = scopes
        .iter()
        .map(|s| json!({ "permission": s, "status": "granted" }))
        .collect();
    mock.on(
        "GET",
        "/fb/v19.0/me/permissions",
        ok(json!({ "data": granted })),
    );
    mock.on(
        "GET",
        "/fb/v19.0/me/accounts",
        ok(json!({ "data": [
            { "id": "1234567890", "name": "Test Kahve", "access_token": "EAAB-page-1234567890" }
        ]})),
    );
    mock.on(
        "POST",
        "/fb/v19.0/1234567890/subscribed_apps",
        ok(json!({ "success": true })),
    );
    mock.on(
        "GET",
        "/fb/v19.0/me",
        ok(json!({ "id": "1234567890", "name": "Test Kahve" })),
    );
    let apps = Arc::new(TestApps::default());
    let meta = Arc::new(MetaConnector::new(
        egress(&mock),
        bases(&mock),
        apps.clone(),
    ));
    let mut deps = deps(Arc::new(InMemoryUow::new()));
    deps.apps = apps;
    deps.connectors = Arc::new(MetaRegistry(meta));
    let session = auth::register(
        &deps,
        RegisterInput {
            email: "owner@grant.test".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Grant test".into(),
        },
    )
    .await
    .unwrap();
    let ws = session.me.current_workspace.unwrap();
    activate_workspace(&deps, ws).await;
    let principal = auth::resolve_session(&deps, &session.token).await.unwrap();
    let ctx = auth::ctx_for(&principal, ws, FIXED_NOW).unwrap();
    let flow = connector::start_oauth(
        &deps,
        &ctx,
        StartOAuth {
            kind_key: "facebook_page".into(),
        },
    )
    .await
    .unwrap();
    let state = Url::parse(&flow.authorize_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let pending = connector::complete_oauth(
        &deps,
        CompleteOAuth {
            callback: OAuthCallback::Meta,
            state,
            code: "synthetic-authorization-code".into(),
            principal: &principal,
        },
    )
    .await
    .unwrap();
    let connected = connector::confirm_assets(
        &deps,
        &ctx,
        ConfirmAssets {
            pending_id: pending.pending_id,
            selected: vec!["1234567890".into()],
        },
    )
    .await
    .unwrap();
    let connected = connected.into_iter().map(|c| c.capability).collect();
    (mock, connected)
}

/// The scopes a Facebook Login grant held reach the connection step of the Page token it yields:
/// the page is subscribed to its messages whatever the grant, and to its lead-gen submissions
/// only when the grant holds `leads_retrieval` (Meta refuses the whole subscription otherwise).
#[tokio::test]
async fn a_page_connected_through_facebook_login_subscribes_leadgen_only_with_its_permission() {
    let with_leadgen = format!("{PAGE_MESSAGING_FIELDS},{PAGE_LEADGEN_FIELD}");
    for (scopes, leadgen, fields) in [
        (
            &["pages_messaging", "pages_manage_metadata"][..],
            false,
            PAGE_MESSAGING_FIELDS,
        ),
        (
            &[
                "pages_messaging",
                "pages_manage_metadata",
                "leads_retrieval",
            ][..],
            true,
            with_leadgen.as_str(),
        ),
    ] {
        let (mock, connected) = connect_page_granting(scopes).await;
        let kinds: Vec<&str> = connected.iter().map(|c| c.kind_key.as_str()).collect();
        assert_eq!(kinds, ["facebook_page", "messenger"], "{scopes:?}");
        let calls = mock.requests("POST", "/fb/v19.0/1234567890/subscribed_apps");
        assert_eq!(calls.len(), 2, "one per capability: {scopes:?}");
        for call in &calls {
            assert_eq!(call.param("subscribed_fields"), Some(fields), "{scopes:?}");
            assert_graph_auth(call, "EAAB-page-1234567890");
        }
        for c in &connected {
            let public = &c.connector_public;
            assert_eq!(public["subscribed"], true, "{public}");
            assert_eq!(public["leadgen"], leadgen, "{public}");
            assert!(
                public["health"].get("on_connected_error").is_none(),
                "{public}"
            );
        }
        assert!(mock.violations().is_empty(), "invalid Graph authentication");
    }
}

#[tokio::test]
async fn leadgen_adapter_fields_create_meta_ads_person_and_task() {
    use jt_app::ports::UnitOfWork;
    use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
    use jt_connector::{InboundEvent, InboundEventId};
    let mock = Mock::start().await;
    mock.on(
        "GET",
        "/fb/v19.0/6666666666",
        ok(graph_fixture(&mock, "leadgen")),
    );
    let meta = Arc::new(MetaConnector::new(
        egress(&mock),
        bases(&mock),
        Arc::new(TestApps::default()),
    ));
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = deps(uow.clone());
    deps.connectors = Arc::new(MetaRegistry(meta));
    let f = jt_testkit::inbox_contract::Fixture::new(uow.clone()).await;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        f.ws,
        NewCapability {
            kind_key: "facebook_page".into(),
            name: "Page".into(),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.external_id = Some("1234567890".into());
    let credential = Credential::PageToken {
        page_id: "1234567890".into(),
        token: TOKEN.into(),
    };
    let sealed = deps
        .seal
        .seal(f.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let raw = include_bytes!("fixtures/meta/page_leadgen.json");
    let draft = jt_meta::webhook::parse(raw).unwrap().remove(0).event;
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: f.ws,
        capability_id: Some(cap.id),
        provider: Provider::Meta,
        external_id: draft.external_id,
        kind: draft.kind,
        payload: draft.payload,
        received_at: FIXED_NOW,
        processed_at: None,
    };
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.inbound_events()
        .insert_if_new(event, Some(raw.to_vec()))
        .await
        .unwrap();
    r.commit().await.unwrap();
    let report = jt_app::usecases::inbox::consumer::consume_workspace(&deps, f.ws, FIXED_NOW).await;
    assert_eq!(report.changed, 1);
    assert_eq!(report.failed, 0);
    let s = uow.snapshot();
    assert_eq!(s.inbox.people[0].display_name, "Test Kişi");
    assert_eq!(
        serde_json::to_value(&s.inbox.people[0].first_touch.source).unwrap(),
        "meta_ads"
    );
    assert_eq!(s.inbox.identities[0].value_normalized, "test@example.com");
    assert_eq!(
        s.inbox.attribution[0].campaign_id.as_deref(),
        Some("1212121212")
    );
    assert_eq!(
        s.inbox.attribution[0].acquired_at,
        time::macros::datetime!(2026-10-01 12:00:00 UTC)
    );
    assert_eq!(s.inbox.attribution[0].adset_id, None);
    assert_eq!(
        s.inbox.tasks[0].due_at,
        FIXED_NOW + time::Duration::hours(1)
    );
    assert_graph_auth(&mock.request("GET", "/fb/v19.0/6666666666"), TOKEN);
}
