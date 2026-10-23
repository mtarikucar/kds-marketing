//! Provider text crossing the real Meta adapter and the connector use cases into public outputs.

mod support;

use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::connectors::{
    AdBudgetWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports, InsightsReader,
    LeadGenFetcher, MessagingSender, OAuthProvider, Publisher, SmsSender, Telephony,
};
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::capabilities::{self, DeclareInput};
use jt_app::usecases::connector::{self, CompleteOAuth, OAuthCallback, StartOAuth};
use jt_connector::{Credential, Provider};
use jt_meta::MetaConnector;
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, deps};
use jt_testkit::flows::activate_workspace;
use serde_json::json;
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
    fn leadgen(&self, _: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        None
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
