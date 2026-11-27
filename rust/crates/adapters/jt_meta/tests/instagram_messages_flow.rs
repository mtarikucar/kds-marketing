//! An Instagram Login account gains its direct messages, end to end, on the real Meta adapter
//! (against the Graph mock) and the application's own use cases (in memory), without a Facebook
//! Page anywhere: the account is connected through Instagram Login before the Instagram app's
//! message flag (`JEETA_INSTAGRAM_MESSAGE_SCOPES`) is on; once it is, the owner reconnects the
//! account, the sign-in asks for `instagram_business_manage_messages`, the account's `instagram`
//! capability is renewed in place and its `instagram_dm` created, both subscribing the account to
//! its messages and probed on graph.instagram.com; a direct message Meta delivers (signed with the
//! Instagram app's secret) reaches the inbox through `instagram_dm`, and the reply goes out on
//! graph.instagram.com (`POST /{ig-id}/messages`) with the account's token.

mod support;

use std::sync::Arc;

use hmac::{Hmac, KeyInit, Mac};
use jt_app::ports::connectors::{
    AdBudgetWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports, InsightsReader,
    LeadGenFetcher, MailSender, MailboxPoller, MessagingSender, OAuthProvider, Publisher,
    SmsSender, Telephony,
};
use jt_app::usecases::Deps;
use jt_app::usecases::auth::{self, LoginInput, Principal};
use jt_app::usecases::connector::{
    self, CompleteOAuth, ConfirmAssets, OAuthCallback, PendingAssetsOut, StartOAuth,
};
use jt_app::usecases::inbox::replies;
use jt_app::usecases::jobs;
use jt_app::usecases::webhook::{self, AccountEvent, AccountRoute, Delivery};
use jt_capability::StoredStatus;
use jt_connector::{Credential, Provider};
use jt_meta::{
    INSTAGRAM_MESSAGE_SCOPES, INSTAGRAM_MESSAGES_SCOPE, INSTAGRAM_MESSAGING_FIELDS,
    INSTAGRAM_SCOPES, MetaConnector,
};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use sha2::Sha256;
use support::workspace::workspace;
use support::*;
use url::Url;

/// The Instagram professional account (`user_id`, the id webhooks name).
const IG: &str = "17841400000000009";
/// The person who writes to it (their Instagram-scoped id).
const SENDER: &str = "3000000000000009";

/// The real adapter for connecting, probing and messaging; nothing else.
struct Registry(Arc<MetaConnector>);

impl ConnectorRegistry for Registry {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn Connector>)
    }
    fn oauth(&self, provider: Provider) -> Option<Arc<dyn OAuthProvider>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn OAuthProvider>)
    }
    fn messaging(&self, provider: Provider) -> Option<Arc<dyn MessagingSender>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn MessagingSender>)
    }
    fn mail_sender(&self, _: Provider) -> Option<Arc<dyn MailSender>> {
        None
    }
    fn mailbox_poller(&self, _: Provider) -> Option<Arc<dyn MailboxPoller>> {
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

/// The platform's apps, the Instagram app's message flag as `on`.
fn apps(on: bool) -> Arc<TestApps> {
    let mut apps = TestApps::default();
    apps.instagram.as_mut().unwrap().message_scopes = on;
    Arc::new(apps)
}

/// The query parameter `name` of `url`.
fn param(url: &str, name: &str) -> Option<String> {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// Scripts Instagram Login's code exchange: the short-lived token granted `permissions`, then the
/// long-lived `token`, and the account it reaches.
fn script_sign_in(mock: &Mock, permissions: &[&str], token: &str) {
    mock.set(
        "POST",
        "/igapi/oauth/access_token",
        ok(json!({ "data": [{
            "access_token": "IGAA-short-flow",
            "user_id": IG,
            "permissions": permissions.join(","),
        }]})),
    );
    mock.set(
        "GET",
        "/ig/access_token",
        ok(json!({ "access_token": token, "token_type": "bearer", "expires_in": 5183944 })),
    );
    mock.set(
        "GET",
        "/ig/me",
        ok(json!({ "user_id": IG, "username": "test.studio", "id": "9876543210" })),
    );
}

/// Completes the Instagram Login flow `authorize_url` started, as the owner's browser brings
/// Instagram's code back to the panel.
async fn complete(deps: &Deps, owner: &Principal, authorize_url: &str) -> PendingAssetsOut {
    connector::complete_oauth(
        deps,
        CompleteOAuth {
            callback: OAuthCallback::Instagram,
            state: param(authorize_url, "state").unwrap(),
            code: "synthetic-code#_".into(),
            principal: owner,
        },
    )
    .await
    .unwrap()
}

/// `X-Hub-Signature-256` of `body` under `secret`.
fn signature(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    let hex: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256={hex}")
}

#[tokio::test]
async fn an_instagram_login_account_reconnected_with_the_message_flag_takes_its_messages() {
    let w = workspace(&[], &[]).await;
    let mock = &w.mock;
    let meta = Arc::new(MetaConnector::new(egress(mock), bases(mock), apps(true)));
    let mut before = w.deps.clone();
    before.connectors = Arc::new(Registry(meta));
    before.apps = apps(false);
    let mut after = before.clone();
    after.apps = apps(true);
    let session = auth::login(
        &before,
        LoginInput {
            email: "owner@flow.test".into(),
            password: "correct horse battery".into(),
        },
    )
    .await
    .unwrap();
    let owner = auth::resolve_session(&before, &session.token)
        .await
        .unwrap();
    let subscribe = format!("/ig/{IG}/subscribed_apps");
    mock.on("POST", &subscribe, ok(json!({ "success": true })));

    // Before the flag: Instagram Login asks for what it always did, and the account is
    // connected as `instagram` alone, subscribing nothing.
    let started = connector::start_oauth(
        &before,
        &w.owner,
        StartOAuth {
            kind_key: "instagram".into(),
            flow: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        param(&started.authorize_url, "scope"),
        Some(INSTAGRAM_SCOPES.join(","))
    );
    script_sign_in(mock, INSTAGRAM_SCOPES, "IGAA-long-before");
    let pending = complete(&before, &owner, &started.authorize_url).await;
    let kinds: Vec<&str> = pending.assets.iter().map(|a| a.kind_key.as_str()).collect();
    assert_eq!(kinds, ["instagram"]);
    let ig = connector::confirm_assets(
        &before,
        &w.owner,
        ConfirmAssets {
            pending_id: pending.pending_id,
            selected: vec![IG.into()],
        },
    )
    .await
    .unwrap()
    .remove(0)
    .capability;
    assert_eq!(ig.status, StoredStatus::Verified);
    assert!(mock.requests("POST", &subscribe).is_empty());

    // The flag on, the owner reconnects the account: Instagram Login asks for the messages too.
    let started = connector::reconnect(&after, &w.owner, ig.id).await.unwrap();
    let scope = param(&started.authorize_url, "scope").unwrap();
    let expected: Vec<&str> = INSTAGRAM_SCOPES
        .iter()
        .chain(INSTAGRAM_MESSAGE_SCOPES)
        .copied()
        .collect();
    assert_eq!(scope, expected.join(","));
    assert_eq!(
        param(&started.authorize_url, "redirect_uri").as_deref(),
        Some("https://panel.test/oauth/callback/instagram")
    );
    assert_eq!(
        param(&started.authorize_url, "client_id").as_deref(),
        Some(INSTAGRAM_APP_ID)
    );
    script_sign_in(mock, &expected, "IGAA-long-after");
    let pending = complete(&after, &owner, &started.authorize_url).await;
    let kinds: Vec<(&str, &str)> = pending
        .assets
        .iter()
        .map(|a| (a.kind_key.as_str(), a.external_id.as_str()))
        .collect();
    assert_eq!(kinds, [("instagram", IG), ("instagram_dm", IG)]);
    let connected = connector::confirm_assets(
        &after,
        &w.owner,
        ConfirmAssets {
            pending_id: pending.pending_id,
            selected: vec![IG.into()],
        },
    )
    .await
    .unwrap();
    let got: Vec<(&str, StoredStatus)> = connected
        .iter()
        .map(|c| (c.capability.kind_key.as_str(), c.capability.status))
        .collect();
    assert_eq!(
        got,
        [
            ("instagram", StoredStatus::Verified),
            ("instagram_dm", StoredStatus::Verified),
        ]
    );
    assert_eq!(connected[0].capability.id, ig.id, "renewed in place");
    let dm = connected[1].capability.clone();
    for c in &connected {
        let public = &c.capability.connector_public;
        assert_eq!(public["access"]["app"], "instagram", "{public}");
        assert!(
            public["access"]["scopes"]
                .as_array()
                .unwrap()
                .contains(&json!(INSTAGRAM_MESSAGES_SCOPE)),
            "{public}"
        );
        assert_eq!(public["subscribed"], true, "{public}");
        assert!(public.to_string().find("IGAA-").is_none(), "{public}");
    }
    // Both connection steps subscribed the account to its messages, with its token.
    let calls = mock.requests("POST", &subscribe);
    assert_eq!(calls.len(), 2);
    for call in &calls {
        assert_eq!(
            call.param("subscribed_fields"),
            Some(INSTAGRAM_MESSAGING_FIELDS)
        );
        assert_eq!(call.bearer(), Some("IGAA-long-after"));
    }

    // A direct message, as Meta delivers it for an Instagram Login account: signed with the
    // Instagram app's secret, the entry naming the account.
    let sent_at = (FIXED_NOW.unix_timestamp() - 60) * 1000;
    let body = json!({
        "object": "instagram",
        "entry": [{
            "id": IG,
            "time": sent_at,
            "messaging": [{
                "sender": { "id": SENDER },
                "recipient": { "id": IG },
                "timestamp": sent_at,
                "message": { "mid": "aWdfZAG1faXRlbTpGTE9XLTE=", "text": "Fiyat nedir?" },
            }],
        }],
    })
    .to_string();
    let header = signature(INSTAGRAM_APP_SECRET, body.as_bytes());
    let parsed =
        jt_meta::verify_and_parse(INSTAGRAM_APP_SECRET.as_bytes(), body.as_bytes(), &header)
            .unwrap();
    let events = parsed
        .into_iter()
        .map(|p| AccountEvent {
            kind_keys: jt_meta::webhook::kinds_of_hint(p.kind_hint),
            external_account_id: p.external_account_id,
            route: AccountRoute::ExternalId,
            draft: p.event,
        })
        .collect();
    let raw = body.clone().into_bytes();
    let delivered =
        webhook::receive_for_accounts(&after, Provider::Meta, events, &|_| Some(raw.clone()))
            .await
            .unwrap();
    assert!(
        matches!(delivered[..], [Delivery::Stored(_)]),
        "{delivered:?}"
    );

    // The inbox takes it through the account's messages.
    mock.on(
        "GET",
        &format!("/ig/{SENDER}"),
        ok(json!({ "name": "Test Kişi", "username": "test.kisi" })),
    );
    let consumed = jobs::run_inbox_consume(&after, FIXED_NOW).await;
    assert_eq!((consumed.changed, consumed.failed), (1, 0));
    let inbox = w.uow.snapshot().inbox;
    assert_eq!(inbox.conversations.len(), 1);
    assert_eq!(inbox.conversations[0].capability_id, dm.id);
    assert_eq!(inbox.messages.len(), 1);

    // The reply goes out on graph.instagram.com, with the account's token.
    let path = format!("/ig/{IG}/messages");
    mock.on(
        "POST",
        &path,
        ok(json!({ "recipient_id": SENDER, "message_id": "m_ig_flow_reply" })),
    );
    let sent = replies::reply(
        &after,
        &w.owner,
        inbox.conversations[0].id,
        serde_json::from_value(
            json!({ "text": "Merhaba, 100 TL.", "intent": "reply", "request_key": "ig-flow-1" }),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(sent.state, "sent");
    let call = mock.request("POST", &path);
    assert_eq!(call.bearer(), Some("IGAA-long-after"));
    assert_eq!(
        call.json(),
        json!({ "recipient": { "id": SENDER }, "message": { "text": "Merhaba, 100 TL." } })
    );

    // No Facebook Page, nor anything else of the Graph API, was ever asked.
    let facebook: Vec<String> = mock
        .recorded()
        .iter()
        .filter(|r| r.path.starts_with("/fb/"))
        .map(|r| r.line())
        .collect();
    assert!(facebook.is_empty(), "{facebook:?}");
    assert!(mock.violations().is_empty(), "invalid Graph authentication");
    // The sealed credentials are the fresh grant's.
    let sealed: Vec<Credential> = w
        .uow
        .snapshot()
        .capabilities
        .iter()
        .filter(|c| c.capability.external_id.as_deref() == Some(IG))
        .map(|c| {
            let bytes = c.sealed.clone().expect("sealed");
            let plain = jt_app::ports::SecretBox::open(w.deps.seal.as_ref(), w.id, &bytes).unwrap();
            serde_json::from_slice(&plain).unwrap()
        })
        .collect();
    assert_eq!(sealed.len(), 2);
    for credential in sealed {
        let Credential::OAuth { access_token, .. } = credential else {
            panic!("an Instagram Login token");
        };
        assert_eq!(access_token, "IGAA-long-after");
    }
}
