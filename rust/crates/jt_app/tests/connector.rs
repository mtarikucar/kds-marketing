//! The connection use cases over the in-memory fakes and the scripted provider adapters:
//! starting, completing and confirming OAuth flows, entering credentials by hand, probing,
//! health, reconnecting, and what retiring does to a connection. One test per rule.

mod support;

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::connectors::{
    AdBudgetWriter, Asset, AssetPublic, Connector, ConnectorRegistry, ConsentSync, DeliveryReports,
    InsightsReader, LeadGenFetcher, MailSender, MailboxPoller, MessagingSender, OAuthApp,
    OAuthProvider, Publisher, SmsSender, Telephony, Url,
};
use jt_app::ports::{OAuthPendingRow, SecretBox, UnitOfWork};
use jt_app::usecases::Deps;
use jt_app::usecases::auth::{self, LoginInput, Principal};
use jt_app::usecases::capabilities::{self, CapabilityOut, DeclareInput, UpdateCapability};
use jt_app::usecases::connector::{
    self, CompleteOAuth, ConfirmAssets, ConnectorHealth, CredentialInput, OAUTH_STATE_PURPOSE,
    OAuthCallback, PendingAssetsOut, ProbeOut, SetCredentials, StartOAuth, StartOut,
};
use jt_app::usecases::hash_token;
use jt_app::usecases::work::{self, WorkKind};
use jt_capability::{
    Capability, CapabilityId, EffectiveStatus, Evidence, NewCapability, Reach, StoredStatus,
};
use jt_connector::{
    ConnectorError, Credential, OAuthState, ProbeResult, Provider, pkce_challenge_s256,
};
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FakeAppConfig, FixedClock, HostCall, OAuthCall, PlainSecretBox,
    ScriptedConnector, ScriptedOAuth, ScriptedRegistry,
};
use serde_json::json;
use support::*;
use time::Duration;
use time::format_description::well_known::Rfc3339;
use zeroize::Zeroizing;

const META_HOSTS: &[&str] = &["graph.facebook.com", "rupload.facebook.com"];
const NETGSM_HOSTS: &[&str] = &["api.netgsm.com.tr", "crmsntrl.netgsm.com.tr:9111"];
const X_HOSTS: &[&str] = &["api.x.com"];
const TIKTOK_HOSTS: &[&str] = &["open.tiktokapis.com", "open-upload.tiktokapis.com"];
const LINKEDIN_HOSTS: &[&str] = &["api.linkedin.com", "www.linkedin.com"];

/// Every secret the flows below hand to the system; none may come back out.
const SECRETS: &[&str] = &[
    "EAAB-user-1",
    "EAAB-user-2",
    "EAAB-refresh",
    "EAAB-page-1",
    "EAAB-page-2",
    "EAAB-page-1-v2",
    "IGQ-ig-token",
    "netgsm-pass-1",
    "pbx-pass-1",
    "code-1",
    "code-2",
    "meta-app-secret",
    "instagram-app-secret",
    "x-client-secret",
];

// ---------------------------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------------------------

/// The world, its workspace active (as the gate asks of every connection), with every provider
/// app configured and a scripted adapter per provider.
struct Rig {
    w: World,
    meta: Arc<ScriptedConnector>,
    meta_oauth: Arc<ScriptedOAuth>,
    netgsm: Arc<ScriptedConnector>,
    x_oauth: Arc<ScriptedOAuth>,
    tiktok_oauth: Arc<ScriptedOAuth>,
    linkedin_oauth: Arc<ScriptedOAuth>,
}

async fn rig() -> Rig {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let meta = Arc::new(ScriptedConnector::new(Provider::Meta).with_hosts(META_HOSTS));
    let netgsm = Arc::new(ScriptedConnector::new(Provider::Netgsm).with_hosts(NETGSM_HOSTS));
    let x = Arc::new(ScriptedConnector::new(Provider::X).with_hosts(X_HOSTS));
    let tiktok = Arc::new(ScriptedConnector::new(Provider::Tiktok).with_hosts(TIKTOK_HOSTS));
    let linkedin = Arc::new(ScriptedConnector::new(Provider::Linkedin).with_hosts(LINKEDIN_HOSTS));
    let meta_oauth = Arc::new(ScriptedOAuth::new(Provider::Meta));
    let x_oauth = Arc::new(ScriptedOAuth::new(Provider::X));
    let tiktok_oauth = Arc::new(ScriptedOAuth::new(Provider::Tiktok));
    let linkedin_oauth = Arc::new(ScriptedOAuth::new(Provider::Linkedin));
    let registry = ScriptedRegistry::new()
        .with_connector(meta.clone())
        .with_connector(netgsm.clone())
        .with_connector(x)
        .with_connector(tiktok)
        .with_connector(linkedin)
        .with_oauth(meta_oauth.clone())
        .with_oauth(x_oauth.clone())
        .with_oauth(tiktok_oauth.clone())
        .with_oauth(linkedin_oauth.clone());
    w.deps.apps = Arc::new(FakeAppConfig::with_all_apps());
    w.deps.connectors = Arc::new(registry);
    Rig {
        w,
        meta,
        meta_oauth,
        netgsm,
        x_oauth,
        tiktok_oauth,
        linkedin_oauth,
    }
}

fn start(kind: &str) -> StartOAuth {
    StartOAuth {
        kind_key: kind.into(),
    }
}

/// The `state` query parameter of a started flow's authorize URL.
fn state_of(out: &StartOut) -> String {
    query(out, "state").expect("a state")
}

fn query(out: &StartOut, name: &str) -> Option<String> {
    Url::parse(&out.authorize_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// A long-lived Meta user token.
fn user_token(token: &str) -> Credential {
    Credential::OAuth {
        access_token: token.into(),
        refresh_token: Some("EAAB-refresh".into()),
        expires_at: Some(FIXED_NOW + Duration::days(60)),
        scopes: vec!["pages_manage_posts".into()],
    }
}

fn page_asset(id: &str, name: &str, token: &str) -> Asset {
    Asset {
        kind_key: "facebook_page".into(),
        external_id: id.into(),
        name: name.into(),
        credential: Credential::PageToken {
            page_id: id.into(),
            token: token.into(),
        },
        public: json!({ "category": "Cafe" }),
    }
}

/// A probe that succeeded and names `account`.
fn ok_probe(account: &str) -> ProbeResult {
    ProbeResult::success(42, json!({ "account_id": account, "followers": 120 }))
}

fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    err(r).code
}

impl Rig {
    /// The principal behind a fresh session of `email`, an owner the support world registered.
    async fn principal_of(&self, email: &str) -> Principal {
        self.principal_with(email, "correct horse battery").await
    }

    /// The principal behind a fresh session of `email` signing in with `password`.
    async fn principal_with(&self, email: &str, password: &str) -> Principal {
        let session = auth::login(
            &self.w.deps,
            LoginInput {
                email: email.into(),
                password: password.into(),
            },
        )
        .await
        .unwrap();
        auth::resolve_session(&self.w.deps, &session.token)
            .await
            .unwrap()
    }

    async fn owner(&self) -> Principal {
        self.principal_of("owner@acme.example").await
    }

    async fn start(&self, kind: &str) -> StartOut {
        connector::start_oauth(&self.w.deps, &self.w.owner_ctx, start(kind))
            .await
            .unwrap()
    }

    async fn complete_as(
        &self,
        deps: &Deps,
        principal: &Principal,
        state: &str,
        code: &str,
    ) -> Result<PendingAssetsOut, AppError> {
        // The provider's redirect names the app the flow was started with (Meta for a state no
        // flow holds).
        let callback = self
            .pending_rows()
            .into_iter()
            .find(|p| p.state_hash == hash_token(state))
            .map(|p| p.app)
            .unwrap_or(OAuthCallback::Meta);
        connector::complete_oauth(
            deps,
            CompleteOAuth {
                callback,
                state: state.into(),
                code: code.into(),
                principal,
            },
        )
        .await
    }

    /// Starts a Facebook Page flow and completes it as the owner with `assets`.
    async fn completed_with(&self, assets: Vec<Asset>) -> (StartOut, PendingAssetsOut) {
        let out = self.start("facebook_page").await;
        self.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
        self.meta_oauth.push_assets(Ok(assets));
        let owner = self.owner().await;
        let pending = self
            .complete_as(&self.w.deps, &owner, &state_of(&out), "code-1")
            .await
            .unwrap();
        (out, pending)
    }

    async fn confirm(&self, pending: &PendingAssetsOut, selected: &[&str]) -> Vec<CapabilityOut> {
        connector::confirm_assets(
            &self.w.deps,
            &self.w.owner_ctx,
            ConfirmAssets {
                pending_id: pending.pending_id,
                selected: selected.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap()
    }

    /// Connects the page `page-1` ("Kahve") through OAuth, its first probe succeeding.
    async fn connect_page(&self) -> Capability {
        let (_, pending) = self
            .completed_with(vec![page_asset("page-1", "Kahve", "EAAB-page-1")])
            .await;
        self.meta.push_probe(ok_probe("page-1"));
        let mut out = self.confirm(&pending, &["page-1"]).await;
        assert_eq!(out.len(), 1);
        out.remove(0).capability
    }

    async fn probe(&self, id: CapabilityId) -> ProbeOut {
        connector::probe(&self.w.deps, &self.w.owner_ctx, id)
            .await
            .unwrap()
    }

    /// Capability `id` as stored (its derived fields, `has_sealed_config` and the budget links,
    /// are not filled in: [`Rig::stored`] has the sealed bytes).
    fn capability(&self, id: CapabilityId) -> Capability {
        self.stored(id).capability
    }

    fn stored(&self, id: CapabilityId) -> jt_testkit::fakes::StoredCapability {
        self.w
            .uow
            .snapshot()
            .capabilities
            .into_iter()
            .find(|c| c.capability.id == id)
            .expect("the capability")
    }

    /// The credential sealed for capability `id`, opened.
    fn sealed_credential(&self, id: CapabilityId) -> Credential {
        let sealed = self.stored(id).sealed.expect("sealed credentials");
        let plain = PlainSecretBox.open(self.w.ws, &sealed).unwrap();
        serde_json::from_slice(&plain).unwrap()
    }

    fn pending_rows(&self) -> Vec<OAuthPendingRow> {
        self.w.uow.snapshot().oauth_pending
    }
}

/// Asserts that `text` holds none of [`SECRETS`].
fn assert_no_secret(what: &str, text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "{what} leaks {secret}: {text}");
    }
}

// ---------------------------------------------------------------------------------------------
// start_oauth
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn start_oauth_requires_a_configured_app_and_seals_the_pkce_verifier() {
    let r = rig().await;
    let o = &r.w.owner_ctx;

    // Without the provider's app, nothing can start: CONFLICT, nothing written.
    let mut bare = r.w.deps.clone();
    bare.apps = Arc::new(FakeAppConfig::default());
    for kind in [
        "facebook_page",
        "instagram",
        "x",
        "tiktok",
        "linkedin_member",
        "linkedin_page",
    ] {
        let e = err(connector::start_oauth(&bare, o, start(kind)).await);
        assert_eq!(e.code, ErrorCode::Conflict, "{kind}");
        assert_eq!(e.message, "provider app not configured", "{kind}");
        // The reason and the provider are named, so the panel shows its own copy.
        let provider = match kind {
            "x" => "x",
            "tiktok" => "tiktok",
            "linkedin_member" | "linkedin_page" => "linkedin",
            _ => "meta",
        };
        assert_eq!(
            e.details,
            json!({ "reason": "provider_app_not_configured", "provider": provider }),
            "{kind}"
        );
    }
    // Instagram Login runs under the Instagram app; the other Meta kinds under the Meta app.
    let mut no_instagram = FakeAppConfig::with_all_apps();
    no_instagram.instagram = None;
    let mut partial = r.w.deps.clone();
    partial.apps = Arc::new(no_instagram);
    assert_eq!(
        code(connector::start_oauth(&partial, o, start("instagram")).await),
        ErrorCode::Conflict
    );
    assert!(r.pending_rows().is_empty());

    // Only capabilities.manage starts a flow; kinds without an OAuth provider are refused.
    let rep = r.w.member("rep").await;
    assert_forbidden(
        &err(connector::start_oauth(&r.w.deps, &rep, start("facebook_page")).await),
        "capabilities.manage",
    );
    for kind in [
        "nope",
        "sms_line",
        "netgsm_pbx",
        "mailbox",
        "phone",
        "claude_code",
    ] {
        let e = err(connector::start_oauth(&r.w.deps, o, start(kind)).await);
        assert_invalid(&e, "kind_key");
    }
    assert!(r.pending_rows().is_empty());

    // Meta: the URL of its provider for the Meta app, back to the panel's callback, no PKCE.
    let out = r.start("facebook_page").await;
    assert_eq!(out.expires_at, FIXED_NOW + Duration::minutes(10));
    assert_eq!(query(&out, "client_id").as_deref(), Some("meta-app-id"));
    assert_eq!(
        query(&out, "redirect_uri").as_deref(),
        Some("https://panel.test/oauth/callback/meta")
    );
    assert_eq!(query(&out, "code_challenge"), None);
    let state = state_of(&out);
    let key = PlainSecretBox
        .hmac_key(r.w.ws, OAUTH_STATE_PURPOSE)
        .unwrap();
    let signed = OAuthState::verify(&state, &key, FIXED_NOW).unwrap();
    assert_eq!(signed.workspace_id, r.w.ws);
    assert_eq!(signed.provider, Provider::Meta);
    assert_eq!(signed.kind_key, "facebook_page");
    assert_eq!(signed.issued_at, FIXED_NOW);

    let rows = r.pending_rows();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.id, out.pending_id);
    assert_eq!(row.workspace_id, r.w.ws);
    assert_eq!(row.provider, Provider::Meta);
    assert_eq!(row.kind_key, "facebook_page");
    assert_eq!(row.state_hash, hash_token(&state));
    assert_eq!(row.started_by, r.w.owner);
    assert_eq!(row.capability_id, None);
    assert_eq!(row.pkce_verifier_sealed, None);
    assert_eq!(row.assets_sealed, None);
    assert_eq!(row.assets_public, json!([]));
    assert!(row.expires_at >= out.expires_at);

    // Instagram Login uses the Instagram app; Instagram messaging the Meta app.
    let ig = r.start("instagram").await;
    assert_eq!(query(&ig, "client_id").as_deref(), Some("instagram-app-id"));
    let dm = r.start("instagram_dm").await;
    assert_eq!(query(&dm, "client_id").as_deref(), Some("meta-app-id"));

    // X: PKCE; the verifier is sealed with the flow and travels neither in the state nor in
    // the URL, which carries only its S256 challenge.
    let x = r.start("x").await;
    assert_eq!(query(&x, "client_id").as_deref(), Some("x-client-id"));
    assert_eq!(
        query(&x, "redirect_uri").as_deref(),
        Some("https://panel.test/oauth/callback/x")
    );
    assert_eq!(query(&x, "code_challenge_method").as_deref(), Some("S256"));
    let challenge = query(&x, "code_challenge").unwrap();
    let row = r
        .pending_rows()
        .into_iter()
        .find(|p| p.id == x.pending_id)
        .unwrap();
    let verifier: Zeroizing<Vec<u8>> = PlainSecretBox
        .open(r.w.ws, row.pkce_verifier_sealed.as_ref().unwrap())
        .unwrap();
    let verifier = String::from_utf8(verifier.to_vec()).unwrap();
    assert!(!verifier.is_empty());
    assert_eq!(pkce_challenge_s256(&verifier), challenge);
    assert!(!x.authorize_url.contains(&verifier));
    assert!(!state_of(&x).contains(&verifier));
    assert_eq!(r.x_oauth.calls().len(), 1);

    // Each start is ledgered, about its flow.
    let entries = r.w.entries("connector.oauth_started");
    assert_eq!(entries.len(), 4);
    assert_eq!(
        entries[0].payload,
        json!({ "provider": "meta", "kind_key": "facebook_page" })
    );
    let subject = entries[0].subject.as_ref().unwrap();
    assert_eq!(
        (subject.kind.as_str(), subject.id.clone()),
        ("oauth_pending", out.pending_id.to_string())
    );
    assert_eq!(
        entries[3].payload,
        json!({ "provider": "x", "kind_key": "x" })
    );
}

/// The redirect URI of `out`'s authorize URL.
fn redirect_of(out: &StartOut) -> String {
    query(out, "redirect_uri").expect("a redirect URI")
}

/// The redirect URI the last code exchange of `calls` sent.
fn exchanged_redirect(calls: &[OAuthCall]) -> String {
    calls
        .iter()
        .rev()
        .find_map(|c| match c {
            OAuthCall::Exchange { redirect, .. } => Some(redirect.to_string()),
            _ => None,
        })
        .expect("a code exchange")
}

/// Each provider app registers its own redirect URI: the Meta app (Facebook Login) comes back to
/// `/oauth/callback/meta`, the Instagram app (Instagram Login) to `/oauth/callback/instagram`
/// and the X app to `/oauth/callback/x`, and the code exchange sends exactly the URI the flow
/// started with (a provider refuses any other).
#[tokio::test]
async fn each_app_starts_and_exchanges_with_its_own_redirect_uri() {
    let r = rig().await;
    let owner = r.owner().await;
    for (kind, callback, client_id, expected) in [
        (
            "facebook_page",
            OAuthCallback::Meta,
            "meta-app-id",
            "https://panel.test/oauth/callback/meta",
        ),
        (
            "instagram_dm",
            OAuthCallback::Meta,
            "meta-app-id",
            "https://panel.test/oauth/callback/meta",
        ),
        (
            "instagram",
            OAuthCallback::Instagram,
            "instagram-app-id",
            "https://panel.test/oauth/callback/instagram",
        ),
        (
            "x",
            OAuthCallback::X,
            "x-client-id",
            "https://panel.test/oauth/callback/x",
        ),
        (
            "tiktok",
            OAuthCallback::Tiktok,
            "tiktok-client-key",
            "https://panel.test/oauth/callback/tiktok",
        ),
        (
            "linkedin_member",
            OAuthCallback::Linkedin,
            "linkedin-client-id",
            "https://panel.test/oauth/callback/linkedin",
        ),
    ] {
        let out = r.start(kind).await;
        assert_eq!(redirect_of(&out), expected, "{kind}: authorize");
        assert_eq!(
            query(&out, "client_id").as_deref(),
            Some(client_id),
            "{kind}"
        );
        let oauth = match kind {
            "x" => &r.x_oauth,
            "tiktok" => &r.tiktok_oauth,
            "linkedin_member" => &r.linkedin_oauth,
            _ => &r.meta_oauth,
        };
        oauth.push_exchange(Ok(user_token("EAAB-user-1")));
        oauth.push_assets(Ok(Vec::new()));
        let done = connector::complete_oauth(
            &r.w.deps,
            CompleteOAuth {
                callback,
                state: state_of(&out),
                code: "code-1".into(),
                principal: &owner,
            },
        )
        .await;
        assert!(done.is_ok(), "{kind}: {done:?}");
        let calls = oauth.calls();
        assert_eq!(exchanged_redirect(&calls), expected, "{kind}: exchange");
        let exchanged_with = calls.iter().rev().find_map(|c| match c {
            OAuthCall::Exchange { client_id, .. } => Some(client_id.clone()),
            _ => None,
        });
        assert_eq!(exchanged_with.as_deref(), Some(client_id), "{kind}");
    }
    // The callbacks name their segment and their provider.
    let keys: Vec<(&str, Provider)> = OAuthCallback::all()
        .iter()
        .map(|c| (c.key(), c.provider()))
        .collect();
    assert_eq!(
        keys,
        [
            ("meta", Provider::Meta),
            ("instagram", Provider::Meta),
            ("x", Provider::X),
            ("tiktok", Provider::Tiktok),
            ("linkedin", Provider::Linkedin),
        ]
    );
    assert_eq!(OAuthCallback::of_flow(Provider::Netgsm, "sms_line"), None);
    // Both LinkedIn kinds come back to the one LinkedIn callback.
    for kind in ["linkedin_member", "linkedin_page"] {
        assert_eq!(
            OAuthCallback::of_flow(Provider::Linkedin, kind),
            Some(OAuthCallback::Linkedin)
        );
    }
}

/// TikTok and LinkedIn web flows take no PKCE: no challenge rides the authorize URL and no
/// verifier is sealed with the flow, which is kept under its own provider and app.
#[tokio::test]
async fn tiktok_and_linkedin_start_oauth_build_redirect() {
    let r = rig().await;
    for (kind, provider, app) in [
        ("tiktok", Provider::Tiktok, OAuthCallback::Tiktok),
        (
            "linkedin_member",
            Provider::Linkedin,
            OAuthCallback::Linkedin,
        ),
    ] {
        let out = r.start(kind).await;
        assert_eq!(query(&out, "code_challenge"), None, "{kind}");
        assert_eq!(query(&out, "organization_scopes"), None, "{kind}");
        let row = r
            .pending_rows()
            .into_iter()
            .find(|p| p.state_hash == hash_token(&state_of(&out)))
            .expect("a pending flow");
        assert_eq!((row.provider, row.app), (provider, app), "{kind}");
        assert_eq!(row.kind_key, kind);
        assert!(row.pkce_verifier_sealed.is_none(), "{kind}");
    }
    let started = r.w.ledger("connector.oauth_started");
    assert_eq!(started.len(), 2);
    assert_eq!(started[0].payload["provider"], "tiktok");
    assert_eq!(started[1].payload["provider"], "linkedin");
}

/// A LinkedIn page needs the organization scopes, which LinkedIn grants only once it approved
/// the Community Management API for the platform's app: until the operator enables them, a
/// `linkedin_page` flow is `CONFLICT` "provider product not enabled", and nothing is written nor
/// asked of LinkedIn. Once enabled, every LinkedIn flow asks for them (the member's feed too:
/// LinkedIn invalidates earlier tokens when the scopes asked for change).
#[tokio::test]
async fn linkedin_page_refused_without_org_scopes() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let e = err(connector::start_oauth(&r.w.deps, o, start("linkedin_page")).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.message, "provider product not enabled");
    assert_eq!(
        e.details,
        json!({ "reason": "provider_product_not_enabled", "provider": "linkedin" })
    );
    assert!(r.pending_rows().is_empty());
    assert!(r.linkedin_oauth.calls().is_empty());
    assert!(r.w.ledger("connector.").is_empty());
    // The member's own feed connects meanwhile, without the organization scopes.
    let member = r.start("linkedin_member").await;
    assert_eq!(query(&member, "organization_scopes"), None);

    let mut enabled = FakeAppConfig::with_all_apps();
    enabled.linkedin.as_mut().unwrap().organization_scopes = true;
    let mut deps = r.w.deps.clone();
    deps.apps = Arc::new(enabled);
    for kind in ["linkedin_page", "linkedin_member"] {
        let out = connector::start_oauth(&deps, o, start(kind)).await.unwrap();
        assert_eq!(
            query(&out, "organization_scopes").as_deref(),
            Some("true"),
            "{kind}"
        );
        assert_eq!(
            redirect_of(&out),
            "https://panel.test/oauth/callback/linkedin",
            "{kind}"
        );
    }
}

/// Without a configured public base URL there is no redirect URI and no webhook address: starting
/// or reconnecting a flow, completing one, and listing the hook addresses are `CONFLICT` with the
/// reason `public_base_url_not_configured`, before any app is looked at, and nothing is written
/// nor asked of a provider.
#[tokio::test]
async fn hooks_and_start_oauth_conflict_without_public_base_url() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let page = r.connect_page().await;
    // A flow started while the address was configured.
    let started = r.start("facebook_page").await;
    let rows = r.pending_rows().len();
    let started_entries = r.w.entries("connector.oauth_started").len();
    let meta_calls = r.meta_oauth.calls().len();
    let x_calls = r.x_oauth.calls().len();

    let mut unset = r.w.deps.clone();
    unset.apps = Arc::new(FakeAppConfig {
        public_base_url: None,
        ..FakeAppConfig::with_all_apps()
    });
    let assert_unset = |e: AppError, what: &str| {
        assert_eq!(e.code, ErrorCode::Conflict, "{what}: {e:?}");
        assert_eq!(e.message, "public base url not configured", "{what}");
        assert_eq!(
            e.details,
            json!({ "reason": "public_base_url_not_configured" }),
            "{what}"
        );
    };
    for kind in ["facebook_page", "instagram", "x"] {
        assert_unset(
            err(connector::start_oauth(&unset, o, start(kind)).await),
            kind,
        );
    }
    assert_unset(
        err(connector::reconnect(&unset, o, page.id).await),
        "reconnect",
    );
    let owner = r.owner().await;
    assert_unset(
        err(r
            .complete_as(&unset, &owner, &state_of(&started), "code-1")
            .await),
        "complete",
    );
    assert_unset(err(connector::hooks(&unset, o).await), "hooks");
    // Nothing written, no provider asked.
    assert_eq!(r.pending_rows().len(), rows);
    assert_eq!(
        r.w.entries("connector.oauth_started").len(),
        started_entries
    );
    assert_eq!(r.meta_oauth.calls().len(), meta_calls);
    assert_eq!(r.x_oauth.calls().len(), x_calls);

    // The address is named first: without it every OAuth kind is blocked, whichever apps are
    // configured (none here), and so are reconnecting, completing and the hook addresses.
    let mut bare = unset.clone();
    bare.apps = Arc::new(FakeAppConfig {
        public_base_url: None,
        ..FakeAppConfig::default()
    });
    for kind in ["facebook_page", "instagram", "x"] {
        assert_unset(
            err(connector::start_oauth(&bare, o, start(kind)).await),
            &format!("{kind} without apps"),
        );
    }
    assert_unset(
        err(connector::reconnect(&bare, o, page.id).await),
        "reconnect without apps",
    );
    assert_unset(
        err(r
            .complete_as(&bare, &owner, &state_of(&started), "code-1")
            .await),
        "complete without apps",
    );
    assert_unset(err(connector::hooks(&bare, o).await), "hooks without apps");
    // With only the X app, a Meta kind still reads the missing address, not the missing app.
    bare.apps = Arc::new(FakeAppConfig {
        public_base_url: None,
        meta: None,
        instagram: None,
        ..FakeAppConfig::with_all_apps()
    });
    assert_unset(
        err(connector::start_oauth(&bare, o, start("facebook_page")).await),
        "facebook_page with only the X app",
    );
    assert_eq!(r.pending_rows().len(), rows);
    assert_eq!(r.meta_oauth.calls().len(), meta_calls);
    assert_eq!(r.x_oauth.calls().len(), x_calls);

    // With the address, a missing app is named (see
    // `start_oauth_requires_a_configured_app_and_seals_the_pkce_verifier`).
    bare.apps = Arc::new(FakeAppConfig::default());
    let e = err(connector::start_oauth(&bare, o, start("facebook_page")).await);
    assert_eq!(e.details["reason"], "provider_app_not_configured");
}

/// A flow completes only at its own app's callback: an Instagram Login flow brought back to the
/// Meta app's page, a Facebook Login flow to the Instagram app's, or an X flow to either, is
/// `FORBIDDEN` and the provider is not asked; the flow stays usable at its own callback.
#[tokio::test]
async fn callback_path_must_match_the_flows_app() {
    let r = rig().await;
    let owner = r.owner().await;
    let complete = |callback: OAuthCallback, state: String| {
        let deps = r.w.deps.clone();
        let owner = owner.clone();
        async move {
            connector::complete_oauth(
                &deps,
                CompleteOAuth {
                    callback,
                    state,
                    code: "code-1".into(),
                    principal: &owner,
                },
            )
            .await
        }
    };

    let ig = r.start("instagram").await;
    let page = r.start("facebook_page").await;
    let x = r.start("x").await;
    let meta_calls = r.meta_oauth.calls().len();
    let x_calls = r.x_oauth.calls().len();
    for (callback, out) in [
        (OAuthCallback::Meta, &ig),
        (OAuthCallback::X, &ig),
        (OAuthCallback::Instagram, &page),
        (OAuthCallback::X, &page),
        (OAuthCallback::Instagram, &x),
        (OAuthCallback::Meta, &x),
    ] {
        let e = err(complete(callback, state_of(out)).await);
        assert_eq!(e.code, ErrorCode::Forbidden, "{callback:?}");
    }
    assert_eq!(r.meta_oauth.calls().len(), meta_calls, "Meta was not asked");
    assert_eq!(r.x_oauth.calls().len(), x_calls, "X was not asked");
    assert!(r.w.entries("connector.oauth_completed").is_empty());

    // At its own callback, the Instagram Login flow completes with its own redirect URI.
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
    r.meta_oauth
        .push_assets(Ok(vec![instagram_asset("17841400000000001")]));
    let done = complete(OAuthCallback::Instagram, state_of(&ig))
        .await
        .unwrap();
    assert_eq!(done.pending_id, ig.pending_id);
    assert_eq!(done.assets.len(), 1);
    assert_eq!(done.assets[0].kind_key, "instagram");
    assert_eq!(
        exchanged_redirect(&r.meta_oauth.calls()),
        "https://panel.test/oauth/callback/instagram"
    );
}

#[tokio::test]
async fn start_oauth_fails_cleanly_when_the_provider_refuses_the_authorize_url() {
    let r = rig().await;
    let o = &r.w.owner_ctx;

    // The provider refuses to build the URL (X without a PKCE challenge): VALIDATION with the
    // provider's reason, and nothing written: no pending flow, no ledger entry.
    r.x_oauth
        .refuse_authorize(ConnectorError::permanent("pkce required"));
    let e = err(connector::start_oauth(&r.w.deps, o, start("x")).await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "provider": "x", "provider_error": "permanent", "reason": "pkce required" })
    );
    assert_eq!(r.x_oauth.calls().len(), 1);
    assert!(r.pending_rows().is_empty());
    assert!(r.w.entries("connector.oauth_started").is_empty());

    // The reason reaches the caller redacted.
    r.meta_oauth.refuse_authorize(ConnectorError::permanent(
        "refused: client_secret=meta-app-secret",
    ));
    let e = err(connector::start_oauth(&r.w.deps, o, start("facebook_page")).await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_no_secret("the refusal", &format!("{e:?} {}", wire(&e.details)));
    assert_eq!(e.details["reason"], "refused: client_secret=***");
    assert!(r.pending_rows().is_empty());
    assert!(r.w.entries("connector.oauth_started").is_empty());

    // A reconnection refused the same way writes nothing either.
    let page = r.connect_page().await;
    let rows = r.pending_rows().len();
    let started = r.w.entries("connector.oauth_started").len();
    r.meta_oauth
        .refuse_authorize(ConnectorError::permanent("not this app"));
    let e = err(connector::reconnect(&r.w.deps, o, page.id).await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(e.details["provider_error"], "permanent", "{e:?}");
    assert_eq!(e.details["reason"], "not this app", "{e:?}");
    assert_eq!(r.pending_rows().len(), rows);
    assert_eq!(r.w.entries("connector.oauth_started").len(), started);

    // With no refusal queued, the next start goes through.
    r.start("x").await;
    assert_eq!(r.pending_rows().len(), rows + 1);
    assert_eq!(r.w.entries("connector.oauth_started").len(), started + 1);
}

// ---------------------------------------------------------------------------------------------
// complete_oauth
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn state_cannot_be_reused_or_completed_by_another_workspace() {
    let r = rig().await;
    let out = r.start("facebook_page").await;
    let state = state_of(&out);

    // Beta's owner, signed in to Beta, cannot complete Acme's flow; the provider is not asked.
    let (beta, _) = r.w.other_workspace().await;
    let stranger = r.principal_of("owner@beta.example").await;
    assert_eq!(stranger.current_workspace, Some(beta));
    let e = err(r.complete_as(&r.w.deps, &stranger, &state, "code-1").await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    // Nor can a session without a current workspace, nor a tampered state.
    let mut adrift = r.owner().await;
    adrift.current_workspace = None;
    assert_eq!(
        code(r.complete_as(&r.w.deps, &adrift, &state, "code-1").await),
        ErrorCode::Forbidden
    );
    let owner = r.owner().await;
    let (payload, _) = state.split_once('.').unwrap();
    let forged = format!("{payload}.{}", "0".repeat(64));
    assert_eq!(
        code(r.complete_as(&r.w.deps, &owner, &forged, "code-1").await),
        ErrorCode::Forbidden
    );
    assert_eq!(
        code(
            r.complete_as(&r.w.deps, &owner, "not-a-state", "code-1")
                .await
        ),
        ErrorCode::Forbidden
    );
    // Nor a callback addressed to another provider than the one the state was signed for.
    let elsewhere = connector::complete_oauth(
        &r.w.deps,
        CompleteOAuth {
            callback: OAuthCallback::X,
            state: state.clone(),
            code: "code-1".into(),
            principal: &owner,
        },
    )
    .await;
    assert_eq!(code(elsewhere), ErrorCode::Forbidden);
    assert!(r.x_oauth.calls().is_empty());
    // A member of Acme without capabilities.manage cannot either.
    r.w.member("rep").await;
    // The support world's members sign in with the password "pw".
    let rep = r.principal_with("rep@acme.example", "pw").await;
    assert_forbidden(
        &err(r.complete_as(&r.w.deps, &rep, &state, "code-1").await),
        "capabilities.manage",
    );
    assert_eq!(r.meta_oauth.calls().len(), 1, "only the authorize URL");

    // The owner completes it once.
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
    r.meta_oauth
        .push_assets(Ok(vec![page_asset("page-1", "Kahve", "EAAB-page-1")]));
    let done = r
        .complete_as(&r.w.deps, &owner, &state, "code-1")
        .await
        .unwrap();
    assert_eq!(done.pending_id, out.pending_id);
    assert_eq!(
        done.assets,
        vec![AssetPublic {
            kind_key: "facebook_page".into(),
            external_id: "page-1".into(),
            name: "Kahve".into(),
            public: json!({ "category": "Cafe", "granted_scopes": ["pages_manage_posts"] }),
        }]
    );
    assert_eq!(
        r.meta_oauth.calls()[1],
        OAuthCall::Exchange {
            client_id: "meta-app-id".into(),
            redirect: Url::parse("https://panel.test/oauth/callback/meta").unwrap(),
            code: "code-1".into(),
            pkce_verifier: None,
        }
    );

    // A second completion of the same state is refused, and the provider is not asked again.
    assert_eq!(
        code(r.complete_as(&r.w.deps, &owner, &state, "code-2").await),
        ErrorCode::Forbidden
    );
    assert_eq!(r.meta_oauth.calls().len(), 3);

    // A state is refused ten minutes after it was issued.
    let late = r.start("facebook_page").await;
    let mut later = r.w.deps.clone();
    later.clock = Arc::new(FixedClock(FIXED_NOW + Duration::minutes(11)));
    assert_eq!(
        code(
            r.complete_as(&later, &owner, &state_of(&late), "code-1")
                .await
        ),
        ErrorCode::Forbidden
    );

    // Once confirmed, the flow is gone: its state cannot be completed again.
    r.meta.push_probe(ok_probe("page-1"));
    r.confirm(&done, &["page-1"]).await;
    assert_eq!(
        code(r.complete_as(&r.w.deps, &owner, &state, "code-2").await),
        ErrorCode::Forbidden
    );
    // Nothing but the confirmed page was ever created.
    assert_eq!(r.w.uow.snapshot().capabilities.len(), 1);
    assert_eq!(r.w.entries("connector.oauth_completed").len(), 1);
    assert_eq!(
        r.w.entries("connector.oauth_completed")[0].payload,
        json!({ "provider": "meta", "assets": 1 })
    );
}

#[tokio::test]
async fn complete_oauth_maps_provider_errors() {
    let r = rig().await;
    let owner = r.owner().await;
    // A refusal by the provider: VALIDATION naming the provider, the error's kind and its
    // redacted reason.
    let refusals = [
        (
            Err(ConnectorError::auth(
                "the code access_token=EAAB-user-1 expired",
            )),
            None,
            "auth",
        ),
        (
            Err(ConnectorError::permission("missing pages_show_list")),
            None,
            "permission",
        ),
        (
            Err(ConnectorError::permanent("app is in development mode")),
            None,
            "permanent",
        ),
        // The exchange succeeds and listing the assets fails.
        (
            Ok(user_token("EAAB-user-1")),
            Some(ConnectorError::permission("missing business_management")),
            "permission",
        ),
    ];
    for (exchange, listing, kind) in refusals {
        let out = r.start("facebook_page").await;
        let failing = exchange
            .as_ref()
            .err()
            .cloned()
            .or(listing.clone())
            .unwrap();
        r.meta_oauth.push_exchange(exchange);
        if let Some(e) = listing {
            r.meta_oauth.push_assets(Err(e));
        }
        let e = err(r
            .complete_as(&r.w.deps, &owner, &state_of(&out), "code-1")
            .await);
        assert_eq!(e.code, ErrorCode::Validation, "{kind}: {e:?}");
        assert_eq!(
            e.details,
            json!({
                "provider": "meta",
                "provider_error": kind,
                "reason": failing.reason(),
            })
        );
        assert_no_secret("the error", &serde_json::to_string(&e).unwrap());
        assert_no_pending_assets(&r, out.pending_id);
    }

    // A busy or unreachable provider: UPSTREAM_UNAVAILABLE, retryable, with how long to wait when
    // the provider said.
    let unavailable = [
        (
            ConnectorError::unknown("access_token=EAAB-user-1"),
            json!({ "provider": "meta", "retryable": false, "reason": "outcome unknown" }),
        ),
        (
            ConnectorError::throttle(Some(Duration::seconds(30))),
            json!({
                "provider": "meta",
                "retryable": true,
                "retry_after_s": 30,
                "reason": "rate limited",
            }),
        ),
        (
            ConnectorError::throttle(None),
            json!({ "provider": "meta", "retryable": true, "reason": "rate limited" }),
        ),
        (
            ConnectorError::transient("connection reset, token=EAAB-user-1"),
            json!({
                "provider": "meta",
                "retryable": true,
                "reason": ConnectorError::transient("connection reset, token=EAAB-user-1")
                    .reason()
                    .unwrap(),
            }),
        ),
    ];
    for (failure, details) in unavailable {
        let out = r.start("facebook_page").await;
        r.meta_oauth.push_exchange(Err(failure));
        let e = err(r
            .complete_as(&r.w.deps, &owner, &state_of(&out), "code-1")
            .await);
        assert_eq!(e.code, ErrorCode::UpstreamUnavailable, "{e:?}");
        assert_eq!(e.code.as_str(), "UPSTREAM_UNAVAILABLE");
        assert_eq!(e.details, details);
        assert_no_secret("the error", &serde_json::to_string(&e).unwrap());
        assert_no_pending_assets(&r, out.pending_id);
    }
    // X: the provider named is the flow's.
    let x = r.start("x").await;
    r.x_oauth
        .push_exchange(Err(ConnectorError::transient("timeout")));
    let e = err(r
        .complete_as(&r.w.deps, &owner, &state_of(&x), "code-1")
        .await);
    assert_eq!(e.details["provider"], "x");
    assert!(r.w.entries("connector.oauth_completed").is_empty());
}

/// Asserts that flow `pending_id` stored no assets.
fn assert_no_pending_assets(r: &Rig, pending_id: jt_app::ports::OAuthPendingId) {
    let row = r
        .pending_rows()
        .into_iter()
        .find(|p| p.id == pending_id)
        .unwrap();
    assert_eq!(row.assets_sealed, None);
}

// ---------------------------------------------------------------------------------------------
// confirm_assets
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn confirm_seals_credentials_and_outputs_never_contain_them() {
    let r = rig().await;
    let started = r.start("facebook_page").await;
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
    r.meta_oauth.push_assets(Ok(vec![
        page_asset("page-1", "Kahve", "EAAB-page-1"),
        page_asset("page-2", "Çay Evi", "EAAB-page-2"),
    ]));
    let owner = r.owner().await;
    let pending = r
        .complete_as(&r.w.deps, &owner, &state_of(&started), "code-1")
        .await
        .unwrap();
    // The assets are stored sealed with the flow; their public facts in the clear.
    let row = r.pending_rows().into_iter().next().unwrap();
    let sealed = PlainSecretBox
        .open(r.w.ws, row.assets_sealed.as_ref().unwrap())
        .unwrap();
    assert!(String::from_utf8_lossy(&sealed).contains("EAAB-page-1"));
    assert_eq!(
        row.assets_public,
        serde_json::to_value(&pending.assets).unwrap()
    );
    assert_no_secret(
        "the pending row's public facts",
        &row.assets_public.to_string(),
    );
    assert_no_secret("the pending row's Debug", &format!("{row:?}"));

    r.meta.push_probe(ok_probe("page-1"));
    r.meta.push_probe(ok_probe("page-2"));
    let created = r.confirm(&pending, &["page-1", "page-2"]).await;
    assert_eq!(created.len(), 2);
    for (out, (id, name, token)) in created.iter().zip([
        ("page-1", "Kahve", "EAAB-page-1"),
        ("page-2", "Çay Evi", "EAAB-page-2"),
    ]) {
        let c = &out.capability;
        assert_eq!(c.kind_key, "facebook_page");
        assert_eq!(c.reach, Reach::Connector);
        assert_eq!(c.external_id.as_deref(), Some(id));
        assert_eq!(c.name, name);
        // Probed at once: verified on the probe's evidence.
        assert_eq!(c.status, StoredStatus::Verified);
        assert_eq!(out.effective_status, EffectiveStatus::Verified);
        assert_eq!(c.last_verified_at, Some(FIXED_NOW));
        assert_eq!(c.evidence.as_ref().unwrap().text, "probe");
        assert!(c.has_sealed_config);
        let public = &c.connector_public;
        assert_eq!(public["provider"], "meta");
        assert_eq!(public["name"], name);
        assert_eq!(public["hosts"], json!(META_HOSTS));
        // The credential's public facts, and the app that issued it (Facebook Login).
        assert_eq!(
            public["access"],
            json!({ "kind": "page_token", "page_id": id, "app": "meta", "scopes": ["pages_manage_posts"] })
        );
        assert_eq!(
            public["asset"],
            json!({ "category": "Cafe", "granted_scopes": ["pages_manage_posts"] })
        );
        assert_eq!(public["health"]["ok"], true);
        assert_eq!(public["reconnect_required"], false);
        assert_eq!(
            r.sealed_credential(c.id),
            Credential::PageToken {
                page_id: id.into(),
                token: token.into(),
            }
        );
    }
    // The probe reached each page with its own credential and public fields (each connection
    // step first).
    let calls: Vec<ConnectorCall> = r
        .meta
        .calls()
        .into_iter()
        .filter(|c| matches!(c, ConnectorCall::Probe { .. }))
        .collect();
    assert_eq!(calls.len(), 2);
    assert!(matches!(
        &calls[0],
        ConnectorCall::Probe { credential: Credential::PageToken { token, .. }, .. }
            if token == "EAAB-page-1"
    ));
    // The flow is gone; the hosts are allowed for the workspace.
    assert!(r.pending_rows().is_empty());
    let allowed: Vec<HostCall> = META_HOSTS
        .iter()
        .map(|h| HostCall::Allow(r.w.ws, (*h).to_owned()))
        .collect();
    assert_eq!(r.w.hosts.calls()[..2], allowed[..]);

    // Each connection is ledgered without a secret.
    let connected = r.w.entries("connector.connected");
    assert_eq!(connected.len(), 2);
    assert_eq!(
        connected[0].payload,
        json!({ "kind_key": "facebook_page", "external_id": "page-1" })
    );
    assert_eq!(
        connected[0].subject.as_ref().unwrap().id,
        created[0].capability.id.to_string()
    );
    assert_eq!(r.w.entries("connector.probe").len(), 2);

    // Nothing that comes out holds a secret.
    let health = connector::health(&r.w.deps, &r.w.owner_ctx).await.unwrap();
    for (what, text) in [
        ("start", wire(&started)),
        ("pending assets", wire(&pending)),
        ("created", wire(&created)),
        ("created Debug", format!("{created:?}")),
        ("health", wire(&health)),
        ("ledger", wire(&r.w.ledger(""))),
    ] {
        assert_no_secret(what, &text);
    }
}

#[tokio::test]
async fn confirm_rejects_unknown_and_duplicate_assets() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let confirm = |pending_id, selected: &[&str]| ConfirmAssets {
        pending_id,
        selected: selected.iter().map(|s| (*s).to_owned()).collect(),
    };

    // Before the provider has called back, there is nothing to confirm.
    let early = r.start("facebook_page").await;
    assert_eq!(
        code(connector::confirm_assets(&r.w.deps, o, confirm(early.pending_id, &["page-1"])).await),
        ErrorCode::Conflict
    );

    let (_, pending) = r
        .completed_with(vec![
            page_asset("page-1", "Kahve", "EAAB-page-1"),
            page_asset("page-2", "Çay Evi", "EAAB-page-2"),
        ])
        .await;
    // Choosing nothing, or an asset the flow did not find.
    assert_invalid(
        &err(connector::confirm_assets(&r.w.deps, o, confirm(pending.pending_id, &[])).await),
        "selected",
    );
    let e = err(connector::confirm_assets(
        &r.w.deps,
        o,
        confirm(pending.pending_id, &["page-1", "page-9"]),
    )
    .await);
    assert_invalid(&e, "selected");
    assert_eq!(e.details["unknown"], json!(["page-9"]));

    // An account a live capability of the kind already holds: CONFLICT, and nothing is created.
    capabilities::declare(
        &r.w.deps,
        o,
        DeclareInput {
            external_id: Some("page-2".into()),
            ..declaring("facebook_page", "Çay Evi elle")
        },
    )
    .await
    .unwrap();
    let e = err(connector::confirm_assets(
        &r.w.deps,
        o,
        confirm(pending.pending_id, &["page-1", "page-2"]),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "kind_key": "facebook_page", "external_id": "page-2" })
    );
    assert_eq!(r.w.uow.snapshot().capabilities.len(), 1);
    assert!(r.w.entries("connector.connected").is_empty());
    assert!(r.meta.calls().is_empty(), "nothing was probed");

    // Only capabilities.manage confirms; an unknown flow is NOT_FOUND.
    let rep = r.w.member("rep").await;
    assert_forbidden(
        &err(
            connector::confirm_assets(&r.w.deps, &rep, confirm(pending.pending_id, &["page-1"]))
                .await,
        ),
        "capabilities.manage",
    );
    assert_eq!(
        code(
            connector::confirm_assets(
                &r.w.deps,
                o,
                confirm(jt_app::ports::OAuthPendingId::new_v7(), &["page-1"])
            )
            .await
        ),
        ErrorCode::NotFound
    );
    // A flow past its time is refused.
    let stale = at(o, FIXED_NOW + Duration::hours(1));
    assert_eq!(
        code(
            connector::confirm_assets(&r.w.deps, &stale, confirm(pending.pending_id, &["page-1"]))
                .await
        ),
        ErrorCode::Conflict
    );

    // The flow survived every refusal: the owner can still confirm what is free, once.
    r.meta.push_probe(ok_probe("page-1"));
    let created = r.confirm(&pending, &["page-1"]).await;
    assert_eq!(created.len(), 1);
    assert_eq!(
        code(
            connector::confirm_assets(&r.w.deps, o, confirm(pending.pending_id, &["page-1"])).await
        ),
        ErrorCode::NotFound
    );
}

// ---------------------------------------------------------------------------------------------
// set_credentials
// ---------------------------------------------------------------------------------------------

fn netgsm_sms(password: &str) -> CredentialInput {
    CredentialInput::NetgsmSms {
        usercode: "8508850000".into(),
        password: password.into(),
        msgheader: "KAHVE".into(),
    }
}

fn creating(kind: &str, name: &str, credential: CredentialInput) -> SetCredentials {
    SetCredentials {
        capability_id: None,
        kind_key: Some(kind.into()),
        name: Some(name.into()),
        external_id: None,
        credential,
    }
}

#[tokio::test]
async fn set_credentials_seals_probes_and_binds_the_account() {
    let r = rig().await;
    let o = &r.w.owner_ctx;

    // A new SMS line: no external id given, so the probe's account becomes it.
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let line = connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "SMS hattı", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap();
    let c = &line.capability;
    assert_eq!(c.kind_key, "sms_line");
    assert_eq!(c.name, "SMS hattı");
    assert_eq!(c.external_id.as_deref(), Some("KAHVE"));
    assert_eq!(c.status, StoredStatus::Verified);
    assert!(c.has_sealed_config);
    assert_eq!(c.connector_public["provider"], "netgsm");
    assert_eq!(c.connector_public["hosts"], json!(NETGSM_HOSTS));
    assert_eq!(
        c.connector_public["access"],
        json!({ "kind": "netgsm_sms", "usercode": "8508850000", "msgheader": "KAHVE" })
    );
    assert_eq!(
        r.sealed_credential(c.id),
        Credential::NetgsmSms {
            usercode: "8508850000".into(),
            password: "netgsm-pass-1".into(),
            msgheader: "KAHVE".into(),
        }
    );
    assert_eq!(
        r.w.entries("connector.credentials_set")[0].payload,
        json!({ "kind_key": "sms_line", "by_agent": false })
    );
    assert_eq!(
        r.w.entries("connector.probe")[0].payload,
        json!({ "ok": true })
    );
    for host in NETGSM_HOSTS {
        assert!(
            r.w.hosts
                .calls()
                .contains(&HostCall::Allow(r.w.ws, (*host).to_owned())),
            "{host}"
        );
    }

    // An agent holding capabilities.manage may enter credentials the owner gave it; the ledger
    // says an agent did. A given external id must be the probe's account, else the line is
    // unreachable, never verified.
    let agent = r.w.agent(&["capabilities.manage"]).await;
    r.netgsm.push_probe(ok_probe("OTHER"));
    let mismatched = connector::set_credentials(
        &r.w.deps,
        &agent,
        SetCredentials {
            external_id: Some("KAHVE2".into()),
            ..creating("sms_line", "İkinci hat", netgsm_sms("netgsm-pass-1"))
        },
    )
    .await
    .unwrap();
    assert_eq!(mismatched.capability.status, StoredStatus::Unreachable);
    assert_eq!(mismatched.capability.external_id.as_deref(), Some("KAHVE2"));
    assert_eq!(
        mismatched.capability.connector_public["health"]["error_kind"],
        "permission"
    );
    assert_eq!(
        r.w.entries("connector.credentials_set")[1].payload,
        json!({ "kind_key": "sms_line", "by_agent": true })
    );

    // An account another live capability of the kind holds is not taken over.
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let twin = connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "Kopya hat", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap();
    assert_eq!(twin.capability.status, StoredStatus::Unreachable);
    assert_eq!(twin.capability.external_id, None);

    // A PBX capability declared by hand takes credentials: locked, sealed, probed, updated now.
    let declared = capabilities::declare(
        &r.w.deps,
        o,
        DeclareInput {
            external_id: Some("pbx-user".into()),
            ..declaring("netgsm_pbx", "Santral")
        },
    )
    .await
    .unwrap()
    .capability;
    r.netgsm.push_probe(ok_probe("pbx-user"));
    let later = at(o, FIXED_NOW + Duration::minutes(5));
    let pbx = connector::set_credentials(
        &r.w.deps,
        &later,
        SetCredentials {
            capability_id: Some(declared.id),
            kind_key: None,
            name: None,
            external_id: None,
            credential: CredentialInput::NetgsmPbx {
                username: "pbx-user".into(),
                password: "pbx-pass-1".into(),
                trunk: Some("8508850000".into()),
                pbxnum: None,
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(pbx.capability.id, declared.id);
    assert_eq!(pbx.capability.status, StoredStatus::Verified);
    assert_eq!(pbx.capability.updated_at, FIXED_NOW + Duration::minutes(5));
    assert_eq!(pbx.capability.name, "Santral");
    // A verified capability keeps its credentials: CONFLICT.
    assert_eq!(
        code(
            connector::set_credentials(
                &r.w.deps,
                o,
                SetCredentials {
                    capability_id: Some(declared.id),
                    kind_key: None,
                    name: None,
                    external_id: None,
                    credential: CredentialInput::NetgsmPbx {
                        username: "pbx-user".into(),
                        password: "pbx-pass-1".into(),
                        trunk: None,
                        pbxnum: None,
                    },
                },
            )
            .await
        ),
        ErrorCode::Conflict
    );

    // A pasted Meta page token needs the page id; with it, the page is reached as a page.
    r.meta.push_probe(ok_probe("page-7"));
    let pasted = connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            external_id: Some("page-7".into()),
            ..creating(
                "facebook_page",
                "Yapıştırılan sayfa",
                CredentialInput::MetaToken {
                    access_token: "EAAB-page-2".into(),
                },
            )
        },
    )
    .await
    .unwrap();
    assert_eq!(pasted.capability.status, StoredStatus::Verified);
    assert_eq!(
        r.sealed_credential(pasted.capability.id),
        Credential::PageToken {
            page_id: "page-7".into(),
            token: "EAAB-page-2".into(),
        }
    );
    assert_no_secret("the ledger", &wire(&r.w.ledger("")));
    assert_no_secret(
        "the outputs",
        &wire(&[&line, &mismatched, &twin, &pbx, &pasted]),
    );
}

#[tokio::test]
async fn set_credentials_rejects_malformed_shapes() {
    let r = rig().await;
    let o = &r.w.owner_ctx;

    // From JSON: unknown shapes, unknown and missing fields are refused, and the error never
    // repeats a value.
    for body in [
        json!({"capability_id":CapabilityId::new_v7(),"credential":{"kind":"netgsm_iys","usercode":"u","password":"netgsm-pass-1"}}),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm_unknown", "usercode": "u", "password": "netgsm-pass-1", "brand_code": "b" } }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm_sms", "usercode": "u", "password": "netgsm-pass-1", "msgheader": "K", "extra": "x" } }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm_sms", "usercode": "u", "msgheader": "K" } }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm_sms", "usercode": "u", "password": 98765432, "msgheader": "K" } }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": "netgsm-pass-1" }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "password": "netgsm-pass-1" } }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm-pass-1", "password": "x" } }),
        json!({ "kind_key": "sms_line", "name": "H", "password": "netgsm-pass-1", "credential": { "kind": "netgsm_sms", "usercode": "u", "password": "netgsm-pass-1", "msgheader": "K" } }),
    ] {
        let e: AppError = serde_json::from_value::<SetCredentials>(body.clone())
            .expect_err(&body.to_string())
            .into();
        assert_eq!(e.code, ErrorCode::Validation);
        assert_no_secret("a parse error", &e.message);
        assert!(!e.message.contains("98765432"), "{}", e.message);
    }
    // The same input, well formed, reads; its Debug masks the secret.
    let input: SetCredentials = serde_json::from_value(json!({
        "kind_key": "sms_line",
        "name": "H",
        "credential": { "kind": "netgsm_sms", "usercode": "u", "password": "netgsm-pass-1", "msgheader": "K" }
    }))
    .unwrap();
    assert_no_secret("SetCredentials Debug", &format!("{input:?}"));
    for credential in [
        CredentialInput::NetgsmIys {
            usercode: "u".into(),
            password: "netgsm-pass-1".into(),
            brand_code: "b".into(),
        },
        CredentialInput::NetgsmPbx {
            username: "u".into(),
            password: "pbx-pass-1".into(),
            trunk: None,
            pbxnum: None,
        },
        CredentialInput::MetaToken {
            access_token: "EAAB-page-1".into(),
        },
    ] {
        assert_no_secret("CredentialInput Debug", &format!("{credential:?}"));
    }

    // Values: blank, over-long or control characters, the wrong shape for the kind, a page token
    // without its page, and a target that is neither or both.
    let cases: Vec<(SetCredentials, &str)> = vec![
        (
            creating("sms_line", "H", netgsm_sms("  ")),
            "credential.password",
        ),
        (
            creating("sms_line", "H", netgsm_sms(&"p".repeat(5_000))),
            "credential.password",
        ),
        (
            creating(
                "sms_line",
                "H",
                CredentialInput::NetgsmSms {
                    usercode: "u\nx".into(),
                    password: "netgsm-pass-1".into(),
                    msgheader: "K".into(),
                },
            ),
            "credential.usercode",
        ),
        (
            creating(
                "sms_line",
                "H",
                CredentialInput::MetaToken {
                    access_token: "EAAB-page-1".into(),
                },
            ),
            "credential.kind",
        ),
        (
            creating("netgsm_pbx", "H", netgsm_sms("netgsm-pass-1")),
            "credential.kind",
        ),
        (
            creating(
                "facebook_page",
                "H",
                CredentialInput::MetaToken {
                    access_token: "EAAB-page-1".into(),
                },
            ),
            "external_id",
        ),
        (
            SetCredentials {
                kind_key: None,
                ..creating("sms_line", "H", netgsm_sms("netgsm-pass-1"))
            },
            "kind_key",
        ),
        (
            SetCredentials {
                name: None,
                ..creating("sms_line", "H", netgsm_sms("netgsm-pass-1"))
            },
            "name",
        ),
        (
            SetCredentials {
                capability_id: Some(CapabilityId::new_v7()),
                ..creating("sms_line", "H", netgsm_sms("netgsm-pass-1"))
            },
            "capability_id",
        ),
        (
            creating("sms_line", "  ", netgsm_sms("netgsm-pass-1")),
            "name",
        ),
    ];
    for (input, field) in cases {
        let e = err(connector::set_credentials(&r.w.deps, o, input).await);
        assert_invalid(&e, field);
        assert_no_secret("a refusal", &wire(&e));
    }
    // Only capabilities.manage enters credentials.
    let reader = r.w.agent(&["workspace.read"]).await;
    assert_forbidden(
        &err(connector::set_credentials(
            &r.w.deps,
            &reader,
            creating("sms_line", "H", netgsm_sms("netgsm-pass-1")),
        )
        .await),
        "capabilities.manage",
    );
    // Nothing was written and no provider was asked.
    assert!(r.w.uow.snapshot().capabilities.is_empty());
    assert!(r.netgsm.calls().is_empty());
    assert!(r.meta.calls().is_empty());
    assert!(r.w.ledger("connector.").is_empty());
}

#[tokio::test]
async fn set_credentials_refuses_oauth_only_kinds() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let token = || CredentialInput::MetaToken {
        access_token: "EAAB-page-1".into(),
    };
    // X connects only through OAuth: neither a new capability nor a declared one.
    let e = err(connector::set_credentials(&r.w.deps, o, creating("x", "X hesabı", token())).await);
    assert_invalid(&e, "kind_key");
    assert_eq!(e.message, "this kind connects through OAuth");
    let declared = r.w.declare("x", "X hesabı").await.capability.id;
    let e = err(connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            capability_id: Some(declared),
            kind_key: None,
            name: None,
            external_id: None,
            credential: token(),
        },
    )
    .await);
    assert_invalid(&e, "kind_key");
    // Nor do TikTok and LinkedIn: hand-entered credentials are refused for every OAuth-only kind.
    for kind in ["tiktok", "linkedin_member", "linkedin_page"] {
        let e =
            err(connector::set_credentials(&r.w.deps, o, creating(kind, "Hesap", token())).await);
        assert_invalid(&e, "kind_key");
        assert_eq!(e.message, "this kind connects through OAuth", "{kind}");
    }
    // Mail has its own credential shape; a pasted Meta token cannot configure it.
    let e = err(connector::set_credentials(&r.w.deps, o, creating("mailbox", "H", token())).await);
    assert_invalid(&e, "credential.kind");
    assert_eq!(e.details["expected"], "mailbox");
    // Kinds no provider serves, and capabilities reached otherwise, take no credentials.
    for kind in ["phone", "claude_code", "nope"] {
        let e = err(connector::set_credentials(&r.w.deps, o, creating(kind, "H", token())).await);
        assert_invalid(&e, "kind_key");
    }
    let phone = r.w.declare("phone", "Telefon").await.capability.id;
    let e = err(connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            capability_id: Some(phone),
            kind_key: None,
            name: None,
            external_id: None,
            credential: token(),
        },
    )
    .await);
    assert_invalid(&e, "kind_key");
    // An unknown capability is NOT_FOUND; a retired one CONFLICT.
    let unknown = SetCredentials {
        capability_id: Some(CapabilityId::new_v7()),
        kind_key: None,
        name: None,
        external_id: None,
        credential: netgsm_sms("netgsm-pass-1"),
    };
    assert_eq!(
        code(connector::set_credentials(&r.w.deps, o, unknown).await),
        ErrorCode::NotFound
    );
    let line = r.w.declare("sms_line", "Hat").await.capability.id;
    capabilities::retire(&r.w.deps, o, line, true)
        .await
        .unwrap();
    let retired = SetCredentials {
        capability_id: Some(line),
        kind_key: None,
        name: None,
        external_id: None,
        credential: netgsm_sms("netgsm-pass-1"),
    };
    assert_eq!(
        code(connector::set_credentials(&r.w.deps, o, retired).await),
        ErrorCode::Conflict
    );
    assert!(r.netgsm.calls().is_empty());
    assert!(r.w.ledger("connector.").is_empty());
}

// ---------------------------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn probe_auth_failure_marks_unreachable_and_pending_lists_reconnect() {
    let r = rig().await;
    let page = r.connect_page().await;
    let phone = r.w.declare("phone", "Telefon").await.capability;
    let before = r.w.ledger("").len();

    // The token expired: unreachable, and the owner must reconnect it.
    r.meta.push_probe(ProbeResult::failure(
        55,
        ConnectorError::auth("token expired"),
    ));
    let later = FIXED_NOW + Duration::hours(1);
    let out = connector::probe(&r.w.deps, &at(&r.w.owner_ctx, later), page.id)
        .await
        .unwrap();
    assert_eq!(out.status, StoredStatus::Unreachable);
    assert!(!out.result.ok);
    assert_eq!(out.result.error_kind.as_deref(), Some("auth"));
    assert_eq!(out.result.error_reason.as_deref(), Some("token expired"));
    assert_eq!(out.result.latency_ms, 55);
    let c = r.capability(page.id);
    assert_eq!(c.status, StoredStatus::Unreachable);
    assert_eq!(c.connector_public["reconnect_required"], true);
    assert_eq!(
        c.connector_public["health"],
        json!({
            "ok": false,
            "at": later.format(&Rfc3339).unwrap(),
            "latency_ms": 55,
            "error_kind": "auth",
        })
    );
    // The last verification stands as it was; the credential is kept for the record.
    assert_eq!(c.last_verified_at, Some(FIXED_NOW));
    assert!(r.stored(page.id).sealed.is_some());
    let runs = r.w.uow.snapshot().probe_runs;
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[1].error_kind.as_deref(), Some("auth"));
    assert_eq!(
        r.w.entries("connector.probe").last().unwrap().payload,
        json!({ "ok": false, "error_kind": "auth" })
    );
    // Nothing else changed: one ledger entry, the other capability untouched.
    assert_eq!(r.w.ledger("").len(), before + 1);
    assert_eq!(r.capability(phone.id), phone);

    // What is pending asks for the reconnection, among the most urgent items.
    let pending = work::pending(&r.w.deps, &r.w.owner_ctx).await.unwrap();
    let reconnect = pending
        .items
        .iter()
        .find(|i| matches!(i.kind, WorkKind::ReconnectConnector { .. }))
        .expect("a reconnection is pending");
    assert_eq!(reconnect.priority, 1);
    assert_eq!(
        reconnect.kind,
        WorkKind::ReconnectConnector {
            capability_id: page.id,
            name: "Kahve".into(),
        }
    );

    // The same failure again changes no status: no ledger entry.
    r.meta.push_probe(ProbeResult::failure(
        50,
        ConnectorError::auth("token expired"),
    ));
    r.probe(page.id).await;
    assert_eq!(r.w.entries("connector.probe").len(), 2);

    // A busy provider says nothing about the connection either way.
    r.meta
        .push_probe(ProbeResult::failure(5, ConnectorError::throttle(None)));
    assert_eq!(r.probe(page.id).await.status, StoredStatus::Unreachable);
    assert_eq!(
        r.capability(page.id).connector_public["reconnect_required"],
        true
    );

    // An agent may probe with workspace.read alone; a success clears the reconnection.
    let reader = r.w.agent(&["workspace.read"]).await;
    r.meta.push_probe(ok_probe("page-1"));
    let out = connector::probe(&r.w.deps, &reader, page.id).await.unwrap();
    assert_eq!(out.status, StoredStatus::Verified);
    assert_eq!(out.result.facts["followers"], 120);
    let c = r.capability(page.id);
    assert_eq!(c.connector_public["reconnect_required"], false);
    assert_eq!(
        r.w.entries("connector.probe").last().unwrap().payload,
        json!({ "ok": true })
    );
    let pending = work::pending(&r.w.deps, &r.w.owner_ctx).await.unwrap();
    assert!(
        !pending
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ReconnectConnector { .. }))
    );
    // Without workspace.read, no probe.
    let blind = r.w.agent(&["capabilities.manage"]).await;
    assert_forbidden(
        &err(connector::probe(&r.w.deps, &blind, page.id).await),
        "workspace.read",
    );
}

#[tokio::test]
async fn probe_refuses_an_account_mismatch() {
    let r = rig().await;
    let page = r.connect_page().await;

    // The credential reaches another account: never verified, whatever the provider says.
    r.meta.push_probe(ok_probe("page-2"));
    let out = r.probe(page.id).await;
    assert!(!out.result.ok);
    assert_eq!(out.result.error_kind.as_deref(), Some("permission"));
    assert_eq!(out.result.error_reason.as_deref(), Some("account mismatch"));
    assert_eq!(out.status, StoredStatus::Unreachable);
    let c = r.capability(page.id);
    assert_eq!(c.external_id.as_deref(), Some("page-1"));
    // Not an expired login: no reconnection is asked for.
    assert_eq!(c.connector_public["reconnect_required"], false);
    let run = r.w.uow.snapshot().probe_runs.last().cloned().unwrap();
    assert!(!run.ok);
    assert_eq!(run.error_kind.as_deref(), Some("permission"));

    // A success that names no account, or names it otherwise than as a string, cannot confirm
    // the binding either.
    for facts in [json!({ "followers": 3 }), json!({ "account_id": 1 })] {
        r.meta.push_probe(ProbeResult::success(10, facts));
        let out = r.probe(page.id).await;
        assert!(!out.result.ok);
        assert_eq!(out.result.error_kind.as_deref(), Some("permission"));
        assert_eq!(out.result.error_reason.as_deref(), Some("account mismatch"));
        assert_eq!(out.status, StoredStatus::Unreachable);
    }

    // The right account verifies it again.
    r.meta.push_probe(ok_probe("page-1"));
    assert_eq!(r.probe(page.id).await.status, StoredStatus::Verified);

    // What cannot be probed: an agent or device capability, a connector without credentials,
    // one whose provider has no adapter here, a retired one, an unknown id.
    let o = &r.w.owner_ctx;
    let phone = r.w.declare("phone", "Telefon").await.capability.id;
    assert_eq!(
        code(connector::probe(&r.w.deps, o, phone).await),
        ErrorCode::Conflict
    );
    let bare =
        r.w.declare("facebook_page", "Elle sayfa")
            .await
            .capability
            .id;
    let e = err(connector::probe(&r.w.deps, o, bare).await);
    assert_eq!(
        (e.code, e.message.as_str()),
        (ErrorCode::Conflict, "no credentials")
    );
    let mailbox = r.w.declare("mailbox", "Kutu").await.capability.id;
    assert_eq!(
        code(connector::probe(&r.w.deps, o, mailbox).await),
        ErrorCode::Conflict
    );
    let mut no_adapters = r.w.deps.clone();
    no_adapters.connectors = Arc::new(ScriptedRegistry::new());
    assert_eq!(
        code(connector::probe(&no_adapters, o, page.id).await),
        ErrorCode::Conflict
    );
    assert_eq!(
        code(connector::probe(&r.w.deps, o, CapabilityId::new_v7()).await),
        ErrorCode::NotFound
    );
    capabilities::retire(&r.w.deps, o, page.id, true)
        .await
        .unwrap();
    assert_eq!(
        code(connector::probe(&r.w.deps, o, page.id).await),
        ErrorCode::Conflict
    );
}

// ---------------------------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------------------------

/// A secret box that seals and derives keys as [`PlainSecretBox`] does but refuses to open
/// anything, so a use case that opens a credential fails.
struct NeverOpens;

impl SecretBox for NeverOpens {
    fn seal(&self, ws: WorkspaceId, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
        PlainSecretBox.seal(ws, plaintext)
    }

    fn open(&self, _ws: WorkspaceId, _sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, AppError> {
        panic!("health must not open a sealed credential")
    }

    fn hmac_key(&self, ws: WorkspaceId, purpose: &str) -> Result<Zeroizing<[u8; 32]>, AppError> {
        PlainSecretBox.hmac_key(ws, purpose)
    }
}

#[tokio::test]
async fn health_reads_expiry_from_public_facts_without_opening_secrets() {
    let r = rig().await;
    // An Instagram account connected through Instagram Login: its token expires in 60 days.
    let started = r.start("instagram").await;
    let expires = FIXED_NOW + Duration::days(60);
    let ig_token = Credential::OAuth {
        access_token: "IGQ-ig-token".into(),
        refresh_token: None,
        expires_at: Some(expires),
        scopes: vec!["instagram_business_basic".into()],
    };
    r.meta_oauth.push_exchange(Ok(ig_token.clone()));
    r.meta_oauth.push_assets(Ok(vec![Asset {
        kind_key: "instagram".into(),
        external_id: "ig-1".into(),
        name: "@kahve".into(),
        credential: ig_token,
        public: json!({ "username": "kahve" }),
    }]));
    let owner = r.owner().await;
    let pending = r
        .complete_as(&r.w.deps, &owner, &state_of(&started), "code-1")
        .await
        .unwrap();
    r.meta.push_probe(ok_probe("ig-1"));
    let ig = r.confirm(&pending, &["ig-1"]).await.remove(0).capability;
    assert_eq!(
        ig.connector_public["access"],
        json!({
            "kind": "oauth",
            "app": "instagram",
            "expires_at": expires.format(&Rfc3339).unwrap(),
            "scopes": ["instagram_business_basic"],
        })
    );
    // A page whose last probe failed, a mailbox never probed, a device and a retired page.
    let page = r.connect_page().await;
    r.meta
        .push_probe(ProbeResult::failure(9, ConnectorError::auth("revoked")));
    r.probe(page.id).await;
    let mailbox = r.w.declare("mailbox", "Kutu").await.capability;
    r.w.declare("phone", "Telefon").await;
    let gone = r.w.declare("facebook_page", "Eski").await.capability.id;
    capabilities::retire(&r.w.deps, &r.w.owner_ctx, gone, true)
        .await
        .unwrap();

    let mut deps = r.w.deps.clone();
    deps.seal = Arc::new(NeverOpens);
    let reader = r.w.agent(&["workspace.read"]).await;
    let health = connector::health(&deps, &reader).await.unwrap();
    assert_eq!(
        health,
        vec![
            ConnectorHealth {
                capability_id: ig.id,
                kind_key: "instagram".into(),
                name: "@kahve".into(),
                provider: Some(Provider::Meta),
                status: EffectiveStatus::Verified,
                last_probe_at: Some(FIXED_NOW),
                ok: Some(true),
                error_kind: None,
                token_expires_at: Some(expires),
                reconnect_required: false,
            },
            ConnectorHealth {
                capability_id: page.id,
                kind_key: "facebook_page".into(),
                name: "Kahve".into(),
                provider: Some(Provider::Meta),
                status: EffectiveStatus::Unreachable,
                last_probe_at: Some(FIXED_NOW),
                ok: Some(false),
                error_kind: Some("auth".into()),
                token_expires_at: None,
                reconnect_required: true,
            },
            ConnectorHealth {
                capability_id: mailbox.id,
                kind_key: "mailbox".into(),
                name: "Kutu".into(),
                provider: Some(Provider::Mail),
                status: EffectiveStatus::Declared,
                last_probe_at: None,
                ok: None,
                error_kind: None,
                token_expires_at: None,
                reconnect_required: false,
            },
        ]
    );
    let wire_health = serde_json::to_value(&health[0]).unwrap();
    assert_eq!(
        wire_health["token_expires_at"],
        expires.format(&Rfc3339).unwrap()
    );
    // Reading needs workspace.read.
    let blind = r.w.agent(&["capabilities.manage"]).await;
    assert_forbidden(
        &err(connector::health(&r.w.deps, &blind).await),
        "workspace.read",
    );
}

// ---------------------------------------------------------------------------------------------
// reconnect
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_replaces_the_sealed_credential_on_confirm() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let page = r.connect_page().await;
    r.meta
        .push_probe(ProbeResult::failure(9, ConnectorError::auth("revoked")));
    r.probe(page.id).await;

    // A new flow bound to the capability.
    let out = connector::reconnect(&r.w.deps, o, page.id).await.unwrap();
    let row = r
        .pending_rows()
        .into_iter()
        .find(|p| p.id == out.pending_id)
        .unwrap();
    assert_eq!(row.capability_id, Some(page.id));
    assert_eq!(row.kind_key, "facebook_page");
    assert_eq!(
        r.w.entries("connector.oauth_started")
            .last()
            .unwrap()
            .payload,
        json!({
            "provider": "meta",
            "kind_key": "facebook_page",
            "capability_id": page.id,
        })
    );

    // Signing in again finds the page among others; only the bound page is offered.
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-2")));
    r.meta_oauth.push_assets(Ok(vec![
        page_asset_v2(),
        page_asset("page-3", "Başka", "EAAB-page-2"),
    ]));
    let owner = r.owner().await;
    let pending = r
        .complete_as(&r.w.deps, &owner, &state_of(&out), "code-2")
        .await
        .unwrap();
    assert_eq!(
        pending
            .assets
            .iter()
            .map(|a| a.external_id.as_str())
            .collect::<Vec<_>>(),
        ["page-1"]
    );
    // Choosing another account is refused.
    let e = err(connector::confirm_assets(
        &r.w.deps,
        o,
        ConfirmAssets {
            pending_id: pending.pending_id,
            selected: vec!["page-3".into()],
        },
    )
    .await);
    assert_invalid(&e, "selected");

    // Confirming renews the capability: no new one, the new credential sealed, probed at once.
    r.meta.push_probe(ok_probe("page-1"));
    let renewed = r.confirm(&pending, &["page-1"]).await;
    assert_eq!(renewed.len(), 1);
    assert_eq!(renewed[0].capability.id, page.id);
    assert_eq!(renewed[0].capability.status, StoredStatus::Verified);
    assert_eq!(
        renewed[0].capability.connector_public["reconnect_required"],
        false
    );
    assert_eq!(r.w.uow.snapshot().capabilities.len(), 1);
    assert_eq!(
        r.sealed_credential(page.id),
        Credential::PageToken {
            page_id: "page-1".into(),
            token: "EAAB-page-1-v2".into(),
        }
    );
    assert!(r.pending_rows().iter().all(|p| p.id != pending.pending_id));
    assert_eq!(
        r.w.entries("connector.connected").last().unwrap().payload,
        json!({ "kind_key": "facebook_page", "external_id": "page-1", "reconnected": true })
    );

    // Signing in with an account that does not reach the page: VALIDATION, nothing stored.
    let again = connector::reconnect(&r.w.deps, o, page.id).await.unwrap();
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-2")));
    r.meta_oauth
        .push_assets(Ok(vec![page_asset("page-3", "Başka", "EAAB-page-2")]));
    let e = err(r
        .complete_as(&r.w.deps, &owner, &state_of(&again), "code-2")
        .await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "account_mismatch");

    // NetGSM reconnects by credentials; capabilities reached otherwise, unknown or retired ones
    // cannot be reconnected.
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let line = connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "Hat", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap()
    .capability
    .id;
    let e = err(connector::reconnect(&r.w.deps, o, line).await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "use_set_credentials");
    let phone = r.w.declare("phone", "Telefon").await.capability.id;
    assert_eq!(
        code(connector::reconnect(&r.w.deps, o, phone).await),
        ErrorCode::Conflict
    );
    assert_eq!(
        code(connector::reconnect(&r.w.deps, o, CapabilityId::new_v7()).await),
        ErrorCode::NotFound
    );
    let rep = r.w.member("rep").await;
    assert_forbidden(
        &err(connector::reconnect(&r.w.deps, &rep, page.id).await),
        "capabilities.manage",
    );
    // A reconnection whose capability is retired before the provider calls back is refused
    // without asking the provider.
    let late = connector::reconnect(&r.w.deps, o, page.id).await.unwrap();
    capabilities::retire(&r.w.deps, o, page.id, true)
        .await
        .unwrap();
    let asked = r.meta_oauth.calls().len();
    assert_eq!(
        code(
            r.complete_as(&r.w.deps, &owner, &state_of(&late), "code-2")
                .await
        ),
        ErrorCode::Forbidden
    );
    assert_eq!(r.meta_oauth.calls().len(), asked);
    assert_eq!(
        code(connector::reconnect(&r.w.deps, o, page.id).await),
        ErrorCode::Conflict
    );
}

fn page_asset_v2() -> Asset {
    page_asset("page-1", "Kahve", "EAAB-page-1-v2")
}

/// An Instagram account found by a Meta flow.
fn instagram_asset(id: &str) -> Asset {
    Asset {
        kind_key: "instagram".into(),
        external_id: id.into(),
        name: "kahve".into(),
        credential: user_token("IGQ-ig-token"),
        public: json!({ "username": "kahve" }),
    }
}

impl Rig {
    /// A reconnection flow bound to capability `id`, completed by the owner with `assets`.
    async fn bound_flow(&self, id: CapabilityId, assets: Vec<Asset>) -> PendingAssetsOut {
        let out = connector::reconnect(&self.w.deps, &self.w.owner_ctx, id)
            .await
            .unwrap();
        self.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
        self.meta_oauth.push_assets(Ok(assets));
        let owner = self.owner().await;
        self.complete_as(&self.w.deps, &owner, &state_of(&out), "code-1")
            .await
            .unwrap()
    }

    fn confirming(&self, pending: &PendingAssetsOut, selected: &[&str]) -> ConfirmAssets {
        ConfirmAssets {
            pending_id: pending.pending_id,
            selected: selected.iter().map(|s| (*s).to_owned()).collect(),
        }
    }
}

/// A reconnection signs in with the app that issued the capability's credential, recorded as
/// `connector_public.access.app` when the flow's assets were confirmed: an `instagram`
/// capability connected through Facebook Login (with its Page's token) comes back through the
/// Meta app, also when no Instagram app is configured; one connected through Instagram Login
/// comes back through the Instagram app, and without that app it cannot. The flow keeps its app
/// to the callback: the other app's callback is `FORBIDDEN`. A capability that names no app (a
/// declared one) signs in with the Meta app when it is configured, else the Instagram app.
#[tokio::test]
async fn reconnect_signs_in_with_the_app_that_issued_the_credential() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let owner = r.owner().await;
    let mut meta_only = r.w.deps.clone();
    meta_only.apps = Arc::new(FakeAppConfig {
        instagram: None,
        ..FakeAppConfig::with_all_apps()
    });
    let mut instagram_only = r.w.deps.clone();
    instagram_only.apps = Arc::new(FakeAppConfig {
        meta: None,
        ..FakeAppConfig::with_all_apps()
    });
    let through_page = |token: &str| Asset {
        kind_key: "instagram".into(),
        external_id: "ig-fb".into(),
        name: "@kahve".into(),
        credential: Credential::PageToken {
            page_id: "page-1".into(),
            token: token.into(),
        },
        public: json!({ "username": "kahve", "page_id": "page-1", "login": "facebook" }),
    };
    let app_of = |id: CapabilityId| r.capability(id).connector_public["access"]["app"].clone();
    let flow_app = |out: &StartOut| {
        r.pending_rows()
            .into_iter()
            .find(|p| p.id == out.pending_id)
            .unwrap()
            .app
    };

    // Through Facebook Login: the Meta app issued it.
    let (_, pending) = r.completed_with(vec![through_page("EAAB-page-1")]).await;
    r.meta.push_probe(ok_probe("ig-fb"));
    let fb = r.confirm(&pending, &["ig-fb"]).await.remove(0).capability;
    assert_eq!(app_of(fb.id), json!("meta"));
    // Its token stops working; only the Meta app is configured: it reconnects through it.
    r.meta
        .push_probe(ProbeResult::failure(9, ConnectorError::auth("revoked")));
    r.probe(fb.id).await;
    let out = connector::reconnect(&meta_only, o, fb.id).await.unwrap();
    assert_eq!(flow_app(&out), OAuthCallback::Meta);
    assert_eq!(redirect_of(&out), "https://panel.test/oauth/callback/meta");
    assert_eq!(query(&out, "client_id").as_deref(), Some("meta-app-id"));
    // Brought back to the Instagram app's callback, it is refused, the provider not asked.
    let calls = r.meta_oauth.calls().len();
    let e = err(connector::complete_oauth(
        &meta_only,
        CompleteOAuth {
            callback: OAuthCallback::Instagram,
            state: state_of(&out),
            code: "code-2".into(),
            principal: &owner,
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(r.meta_oauth.calls().len(), calls);
    // At its own callback it completes, and the renewal stays the Meta app's.
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-2")));
    r.meta_oauth
        .push_assets(Ok(vec![through_page("EAAB-page-1-v2")]));
    let pending = r
        .complete_as(&meta_only, &owner, &state_of(&out), "code-2")
        .await
        .unwrap();
    r.meta.push_probe(ok_probe("ig-fb"));
    let renewed = r.confirm(&pending, &["ig-fb"]).await;
    assert_eq!(renewed[0].capability.id, fb.id);
    assert_eq!(renewed[0].capability.status, StoredStatus::Verified);
    assert_eq!(app_of(fb.id), json!("meta"));

    // Through Instagram Login: the Instagram app issued it.
    let out = r.start("instagram").await;
    r.meta_oauth.push_exchange(Ok(Credential::OAuth {
        access_token: "IGQ-ig-token".into(),
        refresh_token: None,
        expires_at: Some(FIXED_NOW + Duration::days(60)),
        scopes: vec!["instagram_business_basic".into()],
    }));
    r.meta_oauth.push_assets(Ok(vec![Asset {
        kind_key: "instagram".into(),
        external_id: "ig-login".into(),
        name: "@cay".into(),
        credential: Credential::OAuth {
            access_token: "IGQ-ig-token".into(),
            refresh_token: None,
            expires_at: Some(FIXED_NOW + Duration::days(60)),
            scopes: vec!["instagram_business_basic".into()],
        },
        public: json!({ "username": "cay", "login": "instagram" }),
    }]));
    let pending = r
        .complete_as(&r.w.deps, &owner, &state_of(&out), "code-1")
        .await
        .unwrap();
    r.meta.push_probe(ok_probe("ig-login"));
    let ig = r
        .confirm(&pending, &["ig-login"])
        .await
        .remove(0)
        .capability;
    assert_eq!(app_of(ig.id), json!("instagram"));
    let out = connector::reconnect(&r.w.deps, o, ig.id).await.unwrap();
    assert_eq!(flow_app(&out), OAuthCallback::Instagram);
    assert_eq!(
        redirect_of(&out),
        "https://panel.test/oauth/callback/instagram"
    );
    assert_eq!(
        query(&out, "client_id").as_deref(),
        Some("instagram-app-id")
    );
    let out = connector::reconnect(&instagram_only, o, ig.id)
        .await
        .unwrap();
    assert_eq!(flow_app(&out), OAuthCallback::Instagram);
    // Without the Instagram app it cannot: the Meta app did not issue it.
    let e = err(connector::reconnect(&meta_only, o, ig.id).await);
    assert_eq!(e.details["reason"], "provider_app_not_configured");

    // Declared, no app named: the Meta app when it is configured, else the Instagram app.
    let declared = r.w.declare("instagram", "Instagram").await.capability.id;
    let out = connector::reconnect(&r.w.deps, o, declared).await.unwrap();
    assert_eq!(flow_app(&out), OAuthCallback::Meta);
    let out = connector::reconnect(&instagram_only, o, declared)
        .await
        .unwrap();
    assert_eq!(flow_app(&out), OAuthCallback::Instagram);
    // Every other kind keeps its own app.
    let page = r.connect_page().await;
    assert_eq!(app_of(page.id), json!("meta"));
    let out = connector::reconnect(&r.w.deps, o, page.id).await.unwrap();
    assert_eq!(flow_app(&out), OAuthCallback::Meta);
    // The recorded app is a public fact, beside no secret.
    for id in [fb.id, ig.id, page.id] {
        assert_no_secret(
            "the public facts",
            &r.capability(id).connector_public.to_string(),
        );
    }
}

/// A pasted Meta token names the Meta app (`connector_public.access.app = "meta"`), as a
/// Facebook Login token does, so a reconnection signs in with it, also for an `instagram`
/// capability. Hand-entered NetGSM credentials name no app.
#[tokio::test]
async fn pasted_meta_token_records_access_app_meta() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let app_of = |id: CapabilityId| r.capability(id).connector_public["access"]["app"].clone();
    let pasted = |kind: &str, account: &str, token: &str| SetCredentials {
        external_id: Some(account.into()),
        ..creating(
            kind,
            "Yapıştırılan",
            CredentialInput::MetaToken {
                access_token: token.into(),
            },
        )
    };

    // A new capability, and an existing one given a pasted token.
    r.meta.push_probe(ok_probe("page-9"));
    let page = connector::set_credentials(
        &r.w.deps,
        o,
        pasted("facebook_page", "page-9", "EAAB-page-2"),
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(app_of(page.id), json!("meta"));
    let ig = r.w.declare("instagram", "Instagram").await.capability.id;
    r.meta.push_probe(ok_probe("ig-9"));
    connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            capability_id: Some(ig),
            kind_key: None,
            name: None,
            external_id: Some("ig-9".into()),
            credential: CredentialInput::MetaToken {
                access_token: "EAAB-user-2".into(),
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(app_of(ig), json!("meta"));
    // It reconnects through the Meta app, even when the Instagram app is configured.
    let out = connector::reconnect(&r.w.deps, o, ig).await.unwrap();
    let flow = r
        .pending_rows()
        .into_iter()
        .find(|p| p.id == out.pending_id)
        .unwrap();
    assert_eq!(flow.app, OAuthCallback::Meta);

    // NetGSM credentials name no app.
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let line = connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "Hat", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap()
    .capability
    .id;
    assert_eq!(app_of(line), serde_json::Value::Null);
    assert_no_secret(
        "the public facts",
        &r.capability(page.id).connector_public.to_string(),
    );
}

#[tokio::test]
async fn reconnect_accepts_a_declared_capability_without_account() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    // A page declared before any connection: no account yet.
    let declared =
        r.w.declare("facebook_page", "Kahve sayfası")
            .await
            .capability;
    assert_eq!(declared.external_id, None);

    // Connecting it is a flow bound to it.
    let out = connector::reconnect(&r.w.deps, o, declared.id)
        .await
        .unwrap();
    let row = r
        .pending_rows()
        .into_iter()
        .find(|p| p.id == out.pending_id)
        .unwrap();
    assert_eq!(row.capability_id, Some(declared.id));
    assert_eq!(row.kind_key, "facebook_page");

    // The provider's assets are offered as they are: none is the capability's account yet.
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
    r.meta_oauth.push_assets(Ok(vec![
        page_asset("page-1", "Kahve", "EAAB-page-1"),
        page_asset("page-2", "Çay", "EAAB-page-2"),
        instagram_asset("ig-1"),
    ]));
    let owner = r.owner().await;
    let pending = r
        .complete_as(&r.w.deps, &owner, &state_of(&out), "code-1")
        .await
        .unwrap();
    let offered: Vec<&str> = pending
        .assets
        .iter()
        .map(|a| a.external_id.as_str())
        .collect();
    assert_eq!(offered, ["page-1", "page-2", "ig-1"]);

    // An account that reaches nothing of the capability's kind does not reach it.
    let again = connector::reconnect(&r.w.deps, o, declared.id)
        .await
        .unwrap();
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-2")));
    r.meta_oauth.push_assets(Ok(vec![instagram_asset("ig-1")]));
    let e = err(r
        .complete_as(&r.w.deps, &owner, &state_of(&again), "code-2")
        .await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "account_mismatch");

    // Only a declared capability may lack its account: one that lost its connection without
    // ever naming one cannot be reconnected (CONFLICT), nor can a retired one.
    let lost = r.w.declare("instagram", "Kayıp hesap").await.capability;
    capabilities::mark_unreachable(&r.w.deps, o, lost.id, "kapandı".into())
        .await
        .unwrap();
    let e = err(connector::reconnect(&r.w.deps, o, lost.id).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    let retired = r.w.declare("instagram", "Eski hesap").await.capability;
    capabilities::retire(&r.w.deps, o, retired.id, true)
        .await
        .unwrap();
    assert_eq!(
        code(connector::reconnect(&r.w.deps, o, retired.id).await),
        ErrorCode::Conflict
    );
}

#[tokio::test]
async fn bound_confirm_binds_first_asset_and_creates_the_rest() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let declared =
        r.w.declare("facebook_page", "Kahve sayfası")
            .await
            .capability;
    let pending = r
        .bound_flow(
            declared.id,
            vec![
                page_asset("page-1", "Kahve", "EAAB-page-1"),
                page_asset("page-2", "Çay", "EAAB-page-2"),
                page_asset("page-3", "Simit", "EAAB-page-1-v2"),
            ],
        )
        .await;

    // The first chosen asset (in the order chosen, not the flow's) becomes the declared
    // capability; the other chosen ones become new capabilities; nothing is left over.
    r.meta.push_probe(ok_probe("page-2"));
    r.meta.push_probe(ok_probe("page-1"));
    let out = r.confirm(&pending, &["page-2", "page-1"]).await;
    assert_eq!(out.len(), 2);
    let bound = &out[0].capability;
    assert_eq!(bound.id, declared.id);
    assert_eq!(bound.external_id.as_deref(), Some("page-2"));
    assert_eq!(bound.name, "Kahve sayfası", "the owner's name stays");
    assert_eq!(bound.status, StoredStatus::Verified);
    assert_eq!(bound.connector_public["provider"], "meta");
    assert_eq!(bound.connector_public["hosts"], json!(META_HOSTS));
    assert_eq!(
        bound.connector_public["asset"],
        json!({ "category": "Cafe", "granted_scopes": ["pages_manage_posts"] })
    );
    assert_eq!(
        r.sealed_credential(declared.id),
        Credential::PageToken {
            page_id: "page-2".into(),
            token: "EAAB-page-2".into(),
        }
    );
    let created = &out[1].capability;
    assert_ne!(created.id, declared.id);
    assert_eq!(created.external_id.as_deref(), Some("page-1"));
    assert_eq!(created.name, "Kahve");
    assert_eq!(r.w.uow.snapshot().capabilities.len(), 2);
    assert!(r.pending_rows().iter().all(|p| p.id != pending.pending_id));
    let connected: Vec<serde_json::Value> =
        r.w.entries("connector.connected")
            .into_iter()
            .map(|e| e.payload)
            .collect();
    assert_eq!(
        connected,
        [
            json!({ "kind_key": "facebook_page", "external_id": "page-2", "bound": true }),
            json!({ "kind_key": "facebook_page", "external_id": "page-1" }),
        ]
    );
    assert_no_secret("the answer", &serde_json::to_string(&out).unwrap());

    // Another declared page: its first chosen asset must be of its kind ...
    let spare = r.w.declare("facebook_page", "Yedek sayfa").await.capability;
    let pending = r
        .bound_flow(
            spare.id,
            vec![
                page_asset("page-1", "Kahve", "EAAB-page-1"),
                page_asset("page-4", "Börek", "EAAB-page-2"),
                instagram_asset("ig-1"),
            ],
        )
        .await;
    let e =
        err(
            connector::confirm_assets(&r.w.deps, o, r.confirming(&pending, &["ig-1", "page-4"]))
                .await,
        );
    assert_invalid(&e, "selected");
    // ... and an account another live capability holds is CONFLICT, whether it is the one
    // bound or one of the rest; nothing is written.
    for selected in [&["page-1", "page-4"][..], &["page-4", "page-1"][..]] {
        let e =
            err(connector::confirm_assets(&r.w.deps, o, r.confirming(&pending, selected)).await);
        assert_eq!(e.code, ErrorCode::Conflict, "{selected:?}");
        assert_eq!(
            e.details,
            json!({ "kind_key": "facebook_page", "external_id": "page-1" }),
            "{selected:?}"
        );
        assert_eq!(r.capability(spare.id).external_id, None, "{selected:?}");
        assert_eq!(r.w.uow.snapshot().capabilities.len(), 3, "{selected:?}");
    }
    // The flow still stands: a valid choice binds the spare page alone.
    r.meta.push_probe(ok_probe("page-4"));
    let out = r.confirm(&pending, &["page-4"]).await;
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].capability.id, spare.id);
    assert_eq!(out[0].capability.external_id.as_deref(), Some("page-4"));
    assert_eq!(r.w.uow.snapshot().capabilities.len(), 3);
}

// ---------------------------------------------------------------------------------------------
// Retiring, pending work
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn retire_clears_sealed_config() {
    let r = rig().await;
    let page = r.connect_page().await;
    r.meta
        .push_probe(ProbeResult::failure(9, ConnectorError::auth("revoked")));
    r.probe(page.id).await;
    assert!(r.stored(page.id).sealed.is_some());

    let later = at(&r.w.owner_ctx, FIXED_NOW + Duration::hours(2));
    let out = capabilities::retire(&r.w.deps, &later, page.id, true)
        .await
        .unwrap();
    assert_eq!(out.capability.status, StoredStatus::Retired);
    assert!(!out.capability.has_sealed_config);
    assert_eq!(r.stored(page.id).sealed, None);
    assert_eq!(out.capability.updated_at, FIXED_NOW + Duration::hours(2));
    // No reconnection is asked for a retired capability; its health stays for the record.
    assert_eq!(out.capability.connector_public["reconnect_required"], false);
    assert_eq!(
        out.capability.connector_public["health"]["error_kind"],
        "auth"
    );
    // Its hosts leave the tenant tier, since no other capability names them.
    for host in META_HOSTS {
        assert!(
            r.w.hosts
                .calls()
                .contains(&HostCall::Revoke(r.w.ws, (*host).to_owned())),
            "{host}"
        );
    }
    assert!(
        connector::health(&r.w.deps, &r.w.owner_ctx)
            .await
            .unwrap()
            .is_empty()
    );
    let pending = work::pending(&r.w.deps, &r.w.owner_ctx).await.unwrap();
    assert!(
        !pending
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ReconnectConnector { .. }))
    );
    // The retirement's own record is unchanged.
    assert_eq!(
        r.w.entries("capability.retire")[0].payload,
        json!({ "budget_links": 0, "groups": 0, "hosts_revoked": 2 })
    );
}

#[tokio::test]
async fn pending_lists_reconnect_at_priority_one() {
    let r = rig().await;
    let page = r.connect_page().await;
    r.w.declare("phone", "Telefon").await;
    // Marked unreachable by hand: not a login to renew, so no reconnection is asked for.
    let line = r.w.declare("sms_line", "Hat").await.capability.id;
    capabilities::mark_unreachable(&r.w.deps, &r.w.owner_ctx, line, "kapalı".into())
        .await
        .unwrap();
    r.meta
        .push_probe(ProbeResult::failure(9, ConnectorError::auth("revoked")));
    r.probe(page.id).await;

    let pending = work::pending(&r.w.deps, &r.w.owner_ctx).await.unwrap();
    let reconnects: Vec<&WorkKind> = pending
        .items
        .iter()
        .map(|i| &i.kind)
        .filter(|k| matches!(k, WorkKind::ReconnectConnector { .. }))
        .collect();
    assert_eq!(
        reconnects,
        [&WorkKind::ReconnectConnector {
            capability_id: page.id,
            name: "Kahve".into(),
        }]
    );
    // Priority 1, ahead of verifying the phone (2); its wire form is stable.
    let position = pending
        .items
        .iter()
        .position(|i| matches!(i.kind, WorkKind::ReconnectConnector { .. }))
        .unwrap();
    let verify = pending
        .items
        .iter()
        .position(|i| matches!(i.kind, WorkKind::VerifyCapability { .. }))
        .unwrap();
    assert!(position < verify);
    let item = serde_json::to_value(&pending.items[position]).unwrap();
    assert_eq!(item["kind"], "reconnect_connector");
    assert_eq!(item["capability_id"], json!(page.id));
    assert_eq!(item["name"], "Kahve");
    assert_eq!(item["priority"], 1);
    assert!(
        item["hint"]
            .as_str()
            .unwrap()
            .contains("jeeta.connector.reconnect")
    );
    assert_eq!(
        item.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["capability_id", "hint", "kind", "name", "priority"]
    );
}

// ---------------------------------------------------------------------------------------------
// Fix round 1: binding, screening, fresh credentials, racing completions
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_probe_that_names_no_account_never_verifies() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    // A new line without an external id: a probe that names no account (or not as a string)
    // verifies nothing and binds nothing, even with no account to compare against.
    for facts in [
        json!({}),
        json!({ "balance": 10 }),
        json!({ "account_id": 905_550_000 }),
        json!({ "account_id": "" }),
        json!({ "account_id": null }),
    ] {
        r.netgsm.push_probe(ProbeResult::success(7, facts.clone()));
        let out = connector::set_credentials(
            &r.w.deps,
            o,
            creating("sms_line", "Hat", netgsm_sms("netgsm-pass-1")),
        )
        .await
        .unwrap();
        let c = &out.capability;
        assert_eq!(c.status, StoredStatus::Unreachable, "{facts}");
        assert_eq!(c.external_id, None, "{facts}");
        assert_eq!(c.last_verified_at, None, "{facts}");
        assert_eq!(c.evidence, None, "{facts}");
        assert_eq!(c.connector_public["health"]["error_kind"], "permission");
        // And probing it again answers the same.
        r.netgsm.push_probe(ProbeResult::success(3, facts.clone()));
        let again = r.probe(c.id).await;
        assert_eq!(
            again.result.error_reason.as_deref(),
            Some("account mismatch")
        );
        assert_eq!(again.status, StoredStatus::Unreachable);
    }
    // Named as a string, the account binds and verifies.
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let bound = connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "Hat", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(bound.status, StoredStatus::Verified);
    assert_eq!(bound.external_id.as_deref(), Some("KAHVE"));
    assert_eq!(bound.last_verified_at, Some(FIXED_NOW));
}

#[tokio::test]
async fn binding_a_new_account_resets_the_verification() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    // A line verified long ago without an account (as an earlier binary could leave it),
    // unreachable since, holding an old credential, evidence and a reconnection request.
    let verified_at = FIXED_NOW - Duration::days(10);
    let mut line = Capability::new(
        CapabilityId::new_v7(),
        r.w.ws,
        NewCapability {
            kind_key: "sms_line".into(),
            name: "Eski hat".into(),
            connector_public: json!({ "reconnect_required": true }),
            ..NewCapability::default()
        },
        verified_at,
    )
    .unwrap();
    line.status = StoredStatus::Unreachable;
    line.last_verified_at = Some(verified_at);
    line.evidence = Some(Evidence {
        text: "probe".into(),
        refs: vec!["old-run".into()],
    });
    let old = Credential::NetgsmSms {
        usercode: "old".into(),
        password: "old-pass".into(),
        msgheader: "ESKI".into(),
    };
    let sealed = PlainSecretBox
        .seal(r.w.ws, &serde_json::to_vec(&old).unwrap())
        .unwrap();
    {
        let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
        t.capabilities()
            .insert(line.clone(), Some(sealed))
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let given = |external_id: &str| SetCredentials {
        capability_id: Some(line.id),
        kind_key: None,
        name: None,
        external_id: Some(external_id.into()),
        credential: netgsm_sms("netgsm-pass-1"),
    };

    // An account another live line holds: CONFLICT naming it, before the provider is asked.
    r.netgsm.push_probe(ok_probe("TAKEN"));
    connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "Dolu hat", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap();
    let asked = r.netgsm.calls().len();
    let e = err(connector::set_credentials(&r.w.deps, o, given("TAKEN")).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(
        e.details,
        json!({ "kind_key": "sms_line", "external_id": "TAKEN" })
    );
    assert_eq!(r.netgsm.calls().len(), asked);
    assert_eq!(r.capability(line.id), line);

    // A new account: the old verification and evidence go, the line reads declared again, the
    // new credential is sealed, no reconnection is asked for; then the new binding is probed (a
    // busy provider leaves it declared).
    let later = at(o, FIXED_NOW + Duration::minutes(1));
    r.netgsm
        .push_probe(ProbeResult::failure(4, ConnectorError::throttle(None)));
    let out = connector::set_credentials(&r.w.deps, &later, given("NEW"))
        .await
        .unwrap()
        .capability;
    assert_eq!(out.external_id.as_deref(), Some("NEW"));
    assert_eq!(out.status, StoredStatus::Declared);
    assert_eq!(out.last_verified_at, None);
    assert_eq!(out.evidence, None);
    assert_eq!(out.connector_public["reconnect_required"], false);
    // The fresh credential's public facts survive the rebinding; the health is this binding's
    // first probe.
    assert_eq!(
        out.connector_public["access"],
        Credential::NetgsmSms {
            usercode: "8508850000".into(),
            password: "netgsm-pass-1".into(),
            msgheader: "KAHVE".into(),
        }
        .redact_for_public()
    );
    assert_eq!(out.connector_public["health"]["error_kind"], "throttle");
    assert_eq!(
        out.connector_public["health"]["at"],
        (FIXED_NOW + Duration::minutes(1)).format(&Rfc3339).unwrap()
    );
    assert_eq!(out.updated_at, FIXED_NOW + Duration::minutes(1));
    assert_eq!(
        r.sealed_credential(line.id),
        Credential::NetgsmSms {
            usercode: "8508850000".into(),
            password: "netgsm-pass-1".into(),
            msgheader: "KAHVE".into(),
        }
    );
    // Only a probe that reaches the new account verifies it.
    r.netgsm.push_probe(ok_probe("NEW"));
    let probed = connector::probe(&r.w.deps, &later, line.id).await.unwrap();
    assert_eq!(probed.status, StoredStatus::Verified);
    assert_eq!(
        r.capability(line.id).last_verified_at,
        Some(FIXED_NOW + Duration::minutes(1))
    );
}

#[tokio::test]
async fn update_external_account_resets_verification_and_drops_credentials() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let page = r.connect_page().await;
    assert_eq!(page.status, StoredStatus::Verified);
    assert!(r.stored(page.id).sealed.is_some());
    // The connection's public facts all describe page-1.
    for key in ["provider", "hosts", "access", "asset", "health", "facts"] {
        assert!(
            page.connector_public.get(key).is_some(),
            "{key}: {}",
            page.connector_public
        );
    }
    let edit = |name: Option<&str>, external_id: Option<&str>| UpdateCapability {
        name: name.map(Into::into),
        description: None,
        external_id: external_id.map(Into::into),
    };

    // A new name alone keeps the connection as it is.
    let out = capabilities::update(&r.w.deps, o, page.id, edit(Some("Kahve Dükkanı"), None))
        .await
        .unwrap();
    assert!(!out.verification_reset);
    assert_eq!(out.current.capability.status, StoredStatus::Verified);
    assert!(out.current.capability.has_sealed_config);
    assert!(r.stored(page.id).sealed.is_some());

    // Another account, given with the whitespace a paste brings (trimmed, as a declaration's
    // is): whatever proved the old binding proves nothing about this one. The capability reads
    // declared again, without verification or evidence, its credential is dropped, and the
    // answer says so; the name changes in the same edit. An account with a control character in
    // it is refused first.
    let later = at(o, FIXED_NOW + Duration::hours(1));
    assert_invalid(
        &err(
            capabilities::update(&r.w.deps, &later, page.id, edit(None, Some("page-2\u{7}"))).await,
        ),
        "external_id",
    );
    let out = capabilities::update(
        &r.w.deps,
        &later,
        page.id,
        edit(Some("Çay"), Some("  page-2 \n")),
    )
    .await
    .unwrap();
    assert!(out.verification_reset);
    let c = &out.current.capability;
    assert_eq!(c.external_id.as_deref(), Some("page-2"));
    assert_eq!(c.name, "Çay");
    assert_eq!(c.status, StoredStatus::Declared);
    assert_eq!(out.current.effective_status, EffectiveStatus::Declared);
    assert_eq!(c.last_verified_at, None);
    assert_eq!(c.evidence, None);
    assert!(!c.has_sealed_config);
    assert_eq!(c.connector_public["reconnect_required"], false);
    assert_eq!(c.updated_at, FIXED_NOW + Duration::hours(1));
    assert_eq!(r.stored(page.id).sealed, None);
    // None of page-1's facts stay: not its last probe, its probe facts, its asset, nor the
    // dropped credential's public facts. The provider and the hosts still hold.
    for key in ["health", "facts", "asset", "account", "access"] {
        assert!(
            c.connector_public.get(key).is_none(),
            "{key}: {}",
            c.connector_public
        );
    }
    assert_eq!(c.connector_public["provider"], "meta");
    assert_eq!(c.connector_public["hosts"], json!(META_HOSTS));
    assert!(
        !serde_json::to_string(&c.connector_public)
            .unwrap()
            .contains("page-1")
    );
    // Health shows the new binding as never probed, with no token.
    let health = connector::health(&r.w.deps, o).await.unwrap();
    let row = health.iter().find(|h| h.capability_id == page.id).unwrap();
    assert_eq!(
        (
            row.ok,
            row.last_probe_at,
            row.error_kind.clone(),
            row.token_expires_at
        ),
        (None, None, None, None)
    );
    assert_eq!(row.status, EffectiveStatus::Declared);
    assert!(!row.reconnect_required);
    let wire = serde_json::to_string(&out).unwrap();
    assert!(wire.contains("\"verification_reset\":true"), "{wire}");
    assert_no_secret("the edit's answer", &wire);
    let entries = r.w.entries("capability.update");
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[1].payload,
        json!({
            "fields": ["name", "external_id"],
            "name": "Çay",
            "external_id": "page-2",
            "rebind": true,
        })
    );
    assert_no_secret("the ledger", &serde_json::to_string(&entries).unwrap());

    // The old credential is gone, so nothing probes the new binding until the account is
    // connected again: the provider is not asked.
    let asked = r.meta.calls().len();
    let e = err(connector::probe(&r.w.deps, &later, page.id).await);
    assert_eq!(
        (e.code, e.message.as_str()),
        (ErrorCode::Conflict, "no credentials")
    );
    assert_eq!(r.meta.calls().len(), asked);
    assert_eq!(r.capability(page.id).status, StoredStatus::Declared);

    // Its token pasted, a probe that reaches page-2 (named verbatim by the provider) verifies
    // the trimmed binding.
    r.meta.push_probe(ok_probe("page-2"));
    let pasted = connector::set_credentials(
        &r.w.deps,
        &later,
        SetCredentials {
            capability_id: Some(page.id),
            kind_key: None,
            name: None,
            external_id: None,
            credential: CredentialInput::MetaToken {
                access_token: "EAAB-page-2".into(),
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(pasted.capability.status, StoredStatus::Verified);
    assert_eq!(
        pasted.capability.connector_public["facts"]["account_id"],
        "page-2"
    );
    let row = connector::health(&r.w.deps, o)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.capability_id == page.id)
        .unwrap();
    assert_eq!(
        (row.ok, row.last_probe_at),
        (Some(true), Some(FIXED_NOW + Duration::hours(1)))
    );

    // The page connected again holds page-1: binding the first one back to it is CONFLICT,
    // and nothing changes.
    let again = r.connect_page().await;
    assert_eq!(again.external_id.as_deref(), Some("page-1"));
    let before = r.stored(page.id);
    let e = err(capabilities::update(&r.w.deps, o, page.id, edit(None, Some("page-1"))).await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "kind_key": "facebook_page", "external_id": "page-1" })
    );
    assert_eq!(r.stored(page.id), before);
    assert_eq!(r.capability(again.id).status, StoredStatus::Verified);
    assert!(r.stored(again.id).sealed.is_some());
    assert_eq!(r.w.entries("capability.update").len(), 2);
    assert_no_secret("the outputs", &serde_json::to_string(&pasted).unwrap());
}

#[tokio::test]
async fn secret_looking_facts_are_dropped_from_every_output() {
    let r = rig().await;
    let started = r.start("facebook_page").await;
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
    let mut asset = page_asset("page-1", "Kahve", "EAAB-page-1");
    asset.public = json!({
        "category": "Cafe",
        "page_access_token": "EAAB-page-2",
        "nested": [{ "token": "x", "fans": 1 }],
    });
    r.meta_oauth.push_assets(Ok(vec![asset]));
    let owner = r.owner().await;
    let pending = r
        .complete_as(&r.w.deps, &owner, &state_of(&started), "code-1")
        .await
        .unwrap();
    let screened_asset = json!({ "category": "Cafe", "granted_scopes": ["pages_manage_posts"], "nested": [{ "fans": 1 }] });
    assert_eq!(pending.assets[0].public, screened_asset);
    assert_eq!(
        r.pending_rows()[0].assets_public[0]["public"],
        screened_asset
    );

    let reported = json!({
        "account_id": "page-1",
        "access_token": "x",
        "nested": { "token": "y", "fans": 3, "Secret_Key": "z" },
    });
    let screened_facts = json!({ "account_id": "page-1", "nested": { "fans": 3 } });
    r.meta.push_probe(ProbeResult::success(5, reported.clone()));
    let page = r.confirm(&pending, &["page-1"]).await.remove(0).capability;
    assert_eq!(page.status, StoredStatus::Verified);
    assert_eq!(page.connector_public["asset"], screened_asset);
    assert_eq!(page.connector_public["facts"], screened_facts);

    r.meta.push_probe(ProbeResult::success(5, reported));
    let out = r.probe(page.id).await;
    assert_eq!(out.result.facts, screened_facts);
    let runs = r.w.uow.snapshot().probe_runs;
    assert!(
        runs.iter()
            .all(|run| run.facts.get("access_token").is_none())
    );
    assert_eq!(runs.last().unwrap().facts, screened_facts);
    assert_no_secret("the pending assets", &wire(&pending));
}

/// Whether what is pending asks for a reconnection.
async fn reconnecting(w: &World) -> bool {
    work::pending(&w.deps, &w.owner_ctx)
        .await
        .unwrap()
        .items
        .iter()
        .any(|i| matches!(i.kind, WorkKind::ReconnectConnector { .. }))
}

#[tokio::test]
async fn a_fresh_credential_clears_the_reconnection() {
    let r = rig().await;
    let o = &r.w.owner_ctx;

    // OAuth: the owner reconnects, and the probe right after is throttled.
    let page = r.connect_page().await;
    r.meta
        .push_probe(ProbeResult::failure(9, ConnectorError::auth("revoked")));
    r.probe(page.id).await;
    assert!(reconnecting(&r.w).await);
    let flow = connector::reconnect(&r.w.deps, o, page.id).await.unwrap();
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-2")));
    r.meta_oauth.push_assets(Ok(vec![page_asset_v2()]));
    let owner = r.owner().await;
    let pending = r
        .complete_as(&r.w.deps, &owner, &state_of(&flow), "code-2")
        .await
        .unwrap();
    r.meta
        .push_probe(ProbeResult::failure(4, ConnectorError::throttle(None)));
    let renewed = r.confirm(&pending, &["page-1"]).await.remove(0).capability;
    assert_eq!(renewed.status, StoredStatus::Unreachable);
    assert_eq!(renewed.connector_public["reconnect_required"], false);
    assert!(!reconnecting(&r.w).await);

    // By hand: a line whose login failed takes new credentials while the provider is busy.
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let line = connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "Hat", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap()
    .capability
    .id;
    r.netgsm.push_probe(ProbeResult::failure(
        9,
        ConnectorError::auth("wrong password"),
    ));
    r.probe(line).await;
    assert_eq!(
        r.capability(line).connector_public["reconnect_required"],
        true
    );
    r.netgsm
        .push_probe(ProbeResult::failure(4, ConnectorError::transient("busy")));
    let out = connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            capability_id: Some(line),
            kind_key: None,
            name: None,
            external_id: None,
            credential: netgsm_sms("netgsm-pass-2"),
        },
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(out.status, StoredStatus::Unreachable);
    assert_eq!(out.connector_public["reconnect_required"], false);
    assert!(!reconnecting(&r.w).await);

    // The next probe that finds the login refused asks again.
    r.netgsm.push_probe(ProbeResult::failure(
        9,
        ConnectorError::auth("wrong password"),
    ));
    r.probe(line).await;
    assert_eq!(
        r.capability(line).connector_public["reconnect_required"],
        true
    );
}

/// An OAuth provider that, on its first exchange, lets a second completion of the same flow run
/// to its end (as a second callback racing the first would), then answers as `inner` does.
struct RacingOAuth {
    inner: Arc<ScriptedOAuth>,
    second: Mutex<Option<(Deps, Principal, String)>>,
    second_result: Mutex<Option<Result<PendingAssetsOut, AppError>>>,
}

#[async_trait]
impl OAuthProvider for RacingOAuth {
    fn authorize_url(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
    ) -> Result<Url, ConnectorError> {
        self.inner
            .authorize_url(app, redirect, state, pkce_challenge)
    }

    async fn exchange(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        code: &str,
        pkce_verifier: Option<&str>,
    ) -> Result<Credential, ConnectorError> {
        let second = self.second.lock().unwrap().take();
        if let Some((deps, principal, state)) = second {
            let out = connector::complete_oauth(
                &deps,
                CompleteOAuth {
                    callback: OAuthCallback::Meta,
                    state,
                    code: "code-2".into(),
                    principal: &principal,
                },
            )
            .await;
            *self.second_result.lock().unwrap() = Some(out);
        }
        self.inner
            .exchange(app, redirect, code, pkce_verifier)
            .await
    }

    async fn list_assets(&self, cred: &Credential) -> Result<Vec<Asset>, ConnectorError> {
        self.inner.list_assets(cred).await
    }
}

/// `inner`, but Meta's OAuth flow is `oauth`.
struct RacingRegistry {
    inner: ScriptedRegistry,
    oauth: Arc<RacingOAuth>,
}

impl ConnectorRegistry for RacingRegistry {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        self.inner.connector(provider)
    }

    fn oauth(&self, provider: Provider) -> Option<Arc<dyn OAuthProvider>> {
        (provider == Provider::Meta).then(|| self.oauth.clone() as Arc<dyn OAuthProvider>)
    }

    fn mail_sender(&self, _provider: Provider) -> Option<Arc<dyn MailSender>> {
        None
    }

    fn mailbox_poller(&self, _provider: Provider) -> Option<Arc<dyn MailboxPoller>> {
        None
    }

    fn sms(&self, provider: Provider) -> Option<Arc<dyn SmsSender>> {
        self.inner.sms(provider)
    }

    fn publisher(&self, provider: Provider) -> Option<Arc<dyn Publisher>> {
        self.inner.publisher(provider)
    }

    fn insights(&self, provider: Provider) -> Option<Arc<dyn InsightsReader>> {
        self.inner.insights(provider)
    }

    fn messaging(&self, provider: Provider) -> Option<Arc<dyn MessagingSender>> {
        self.inner.messaging(provider)
    }

    fn ads(&self, provider: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        self.inner.ads(provider)
    }

    fn leadgen(&self, provider: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        self.inner.leadgen(provider)
    }

    fn telephony(&self, provider: Provider) -> Option<Arc<dyn Telephony>> {
        self.inner.telephony(provider)
    }

    fn consent(&self, provider: Provider) -> Option<Arc<dyn ConsentSync>> {
        self.inner.consent(provider)
    }

    fn delivery_reports(&self, provider: Provider) -> Option<Arc<dyn DeliveryReports>> {
        self.inner.delivery_reports(provider)
    }
}

#[tokio::test]
async fn a_second_completion_racing_the_first_is_forbidden() {
    let r = rig().await;
    let racing = Arc::new(RacingOAuth {
        inner: r.meta_oauth.clone(),
        second: Mutex::new(None),
        second_result: Mutex::new(None),
    });
    let mut deps = r.w.deps.clone();
    deps.connectors = Arc::new(RacingRegistry {
        inner: ScriptedRegistry::new().with_connector(r.meta.clone()),
        oauth: racing.clone(),
    });
    let started = r.start("facebook_page").await;
    let state = state_of(&started);
    let owner = r.owner().await;
    *racing.second.lock().unwrap() = Some((deps.clone(), owner.clone(), state.clone()));
    // The second completion asks first (inside the first's exchange); both reach the provider.
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-2")));
    r.meta_oauth
        .push_assets(Ok(vec![page_asset("page-2", "Çay Evi", "EAAB-page-2")]));
    r.meta_oauth.push_exchange(Ok(user_token("EAAB-user-1")));
    r.meta_oauth
        .push_assets(Ok(vec![page_asset("page-1", "Kahve", "EAAB-page-1")]));

    let first = r.complete_as(&deps, &owner, &state, "code-1").await;
    let second = racing.second_result.lock().unwrap().take().unwrap();
    // The one that stored its assets first wins; the other is refused although the provider
    // answered it.
    let stored = second.unwrap();
    assert_eq!(stored.assets[0].external_id, "page-2");
    assert_eq!(code(first), ErrorCode::Forbidden);
    let exchanges = r
        .meta_oauth
        .calls()
        .iter()
        .filter(|c| matches!(c, OAuthCall::Exchange { .. }))
        .count();
    assert_eq!(exchanges, 2);
    assert_eq!(r.w.entries("connector.oauth_completed").len(), 1);
    assert_eq!(
        r.pending_rows()[0].assets_public,
        serde_json::to_value(&stored.assets).unwrap()
    );
}

#[tokio::test]
async fn on_connected_facts_are_merged_and_failures_are_not_fatal() {
    let r = rig().await;
    let o = &r.w.owner_ctx;

    // OAuth: the adapter's connection step reports facts. Its object is merged into the public
    // fields, but never over a connector-owned or connection key, and never a secret-looking key.
    // The adapter is handed the capability's kind and account, which are not stored.
    r.meta.push_on_connected(Ok(json!({
        "subscribed": true,
        "workspace_id": jt_tenancy::WorkspaceId::new_v7(),
        "health": { "ok": false },
        "kind_key": "messenger",
        "hosts": ["evil.example"],
        "external_id": "page-9",
        "name": "Başka",
        "page_access_token": "EAAB-page-2",
        "nested": { "api_key": "z", "fields": 5 },
    })));
    let page = r.connect_page().await;
    assert_eq!(page.status, StoredStatus::Verified);
    let public = &page.connector_public;
    assert_eq!(public["subscribed"], true);
    assert_eq!(public["nested"], json!({ "fields": 5 }));
    assert!(
        public.get("kind_key").is_none(),
        "secret-looking: never stored"
    );
    assert!(public.get("external_id").is_none());
    assert_eq!(public["name"], "Kahve");
    assert_eq!(page.external_id.as_deref(), Some("page-1"));
    assert_eq!(public["hosts"], json!(META_HOSTS));
    assert_eq!(public["health"]["ok"], true, "the probe's health stands");
    assert!(public["health"].get("on_connected_error").is_none());
    assert!(public.get("page_access_token").is_none());
    // The step ran with the sealed credential, before the probe, and saw the capability's kind
    // and account; the probe saw them too.
    let calls = r.meta.calls();
    assert_eq!(calls.len(), 2);
    match &calls[0] {
        ConnectorCall::OnConnected {
            credential: Credential::PageToken { token, .. },
            public,
        } => {
            assert_eq!(token, "EAAB-page-1");
            assert_eq!(public["kind_key"], "facebook_page");
            assert_eq!(public["workspace_id"], json!(r.w.ws));
            assert_eq!(public["external_id"], "page-1");
        }
        other => panic!("expected the connection step first, got {other:?}"),
    }
    match &calls[1] {
        ConnectorCall::Probe { public, .. } => {
            assert_eq!(public["kind_key"], "facebook_page");
            assert_eq!(public["workspace_id"], json!(r.w.ws));
            assert_eq!(public["external_id"], "page-1");
        }
        other => panic!("expected the probe second, got {other:?}"),
    }

    // A later probe does not run the connection step again.
    r.meta.push_probe(ok_probe("page-1"));
    r.probe(page.id).await;
    assert!(matches!(
        r.meta.calls().last(),
        Some(ConnectorCall::Probe { .. })
    ));
    assert_eq!(r.meta.calls().len(), 3);
    match r.meta.calls().last().unwrap() {
        ConnectorCall::Probe { public, .. } => assert_eq!(
            public["workspace_id"],
            json!(r.w.ws),
            "stored metadata cannot choose a foreign workspace"
        ),
        other => panic!("expected a probe, got {other:?}"),
    }

    // By hand: the step fails. The line is still connected and probed; the failure is recorded
    // in its health, redacted, and outlives the probe that follows it.
    r.netgsm.push_on_connected(Err(ConnectorError::permission(
        "subscription refused: token=netgsm-pass-1",
    )));
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let line = connector::set_credentials(
        &r.w.deps,
        o,
        creating("sms_line", "Hat", netgsm_sms("netgsm-pass-1")),
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(line.status, StoredStatus::Verified);
    match &r.netgsm.calls()[0] {
        ConnectorCall::OnConnected { public, .. } => {
            assert_eq!(public["kind_key"], "sms_line");
            assert_eq!(public["workspace_id"], json!(r.w.ws));
            assert!(public.get("external_id").is_none(), "no account yet");
        }
        other => panic!("expected the connection step first, got {other:?}"),
    }
    let recorded = line.connector_public["health"]["on_connected_error"]
        .as_str()
        .expect("the failure is recorded")
        .to_owned();
    assert!(recorded.starts_with("permission denied"), "{recorded}");
    assert_eq!(line.connector_public["health"]["ok"], true);
    assert!(matches!(
        r.netgsm.calls()[0],
        ConnectorCall::OnConnected { .. }
    ));
    r.netgsm.push_probe(ok_probe("KAHVE"));
    r.probe(line.id).await;
    assert_eq!(
        r.capability(line.id).connector_public["health"]["on_connected_error"],
        json!(recorded)
    );
    assert_no_secret("the line", &wire(&r.capability(line.id)));

    // Nothing scripted: the step merges nothing, and a success clears an earlier failure.
    r.netgsm
        .push_probe(ProbeResult::failure(3, ConnectorError::auth("expired")));
    r.probe(line.id).await;
    r.netgsm.push_probe(ok_probe("KAHVE"));
    let again = connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            capability_id: Some(line.id),
            kind_key: None,
            name: None,
            external_id: None,
            credential: netgsm_sms("netgsm-pass-1"),
        },
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(again.status, StoredStatus::Verified);
    assert!(
        again.connector_public["health"]
            .get("on_connected_error")
            .is_none(),
        "{}",
        again.connector_public
    );
}

#[tokio::test]
async fn set_credentials_checks_the_account_before_the_connection_step() {
    let r = rig().await;
    let o = &r.w.owner_ctx;
    let page = r.connect_page().await;
    let asked = r.meta.calls().len();

    // A new capability for an account another live capability holds: refused before the
    // provider is asked anything (no connection step, no probe).
    let e = err(connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            external_id: Some("page-1".into()),
            ..creating(
                "facebook_page",
                "Kopya",
                CredentialInput::MetaToken {
                    access_token: "EAAB-page-2".into(),
                },
            )
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(
        e.details,
        json!({ "kind_key": "facebook_page", "external_id": "page-1" })
    );
    // An existing capability bound to it by hand: likewise.
    let other = capabilities::declare(&r.w.deps, o, declaring("facebook_page", "Boş"))
        .await
        .unwrap()
        .capability;
    let e = err(connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            capability_id: Some(other.id),
            kind_key: None,
            name: None,
            external_id: Some("page-1".into()),
            credential: CredentialInput::MetaToken {
                access_token: "EAAB-page-2".into(),
            },
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(r.meta.calls().len(), asked, "the provider was not asked");
    assert_eq!(r.capability(page.id).status, StoredStatus::Verified);
}

#[tokio::test]
async fn meta_ads_external_ids_drop_the_act_prefix() {
    let r = rig().await;
    let o = &r.w.owner_ctx;

    // Declared by hand with Graph's node id: held by its number, as its probe names it.
    let ads = capabilities::declare(
        &r.w.deps,
        o,
        DeclareInput {
            external_id: Some(" act_1111 ".into()),
            ..declaring("meta_ads", "Reklam")
        },
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(ads.external_id.as_deref(), Some("1111"));

    // Edited: the same.
    let edited = capabilities::update(
        &r.w.deps,
        o,
        ads.id,
        UpdateCapability {
            name: None,
            description: None,
            external_id: Some("act_2222".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        edited.current.capability.external_id.as_deref(),
        Some("2222")
    );
    assert!(edited.verification_reset);
    // The same account again, written either way, changes nothing.
    let same = capabilities::update(
        &r.w.deps,
        o,
        ads.id,
        UpdateCapability {
            name: None,
            description: None,
            external_id: Some("2222".into()),
        },
    )
    .await
    .unwrap();
    assert!(!same.verification_reset);

    // Credentials entered by hand for it, the account given with act_: the probe's number
    // verifies it.
    r.meta.push_probe(ok_probe("2222"));
    let verified = connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            capability_id: Some(ads.id),
            kind_key: None,
            name: None,
            external_id: Some("act_2222".into()),
            credential: CredentialInput::MetaToken {
                access_token: "EAAB-user-1".into(),
            },
        },
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(verified.status, StoredStatus::Verified);
    assert_eq!(verified.external_id.as_deref(), Some("2222"));

    // A new one likewise; the adapter is handed the bare number.
    r.meta.push_probe(ok_probe("3333"));
    let created = connector::set_credentials(
        &r.w.deps,
        o,
        SetCredentials {
            external_id: Some("act_3333".into()),
            ..creating(
                "meta_ads",
                "Reklam 2",
                CredentialInput::MetaToken {
                    access_token: "EAAB-user-2".into(),
                },
            )
        },
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(created.external_id.as_deref(), Some("3333"));
    assert_eq!(created.status, StoredStatus::Verified);
    match r.meta.calls().last() {
        Some(ConnectorCall::Probe { public, .. }) => assert_eq!(public["external_id"], "3333"),
        other => panic!("{other:?}"),
    }

    // Nothing but the prefix is no account; another kind keeps its id as given.
    let e = err(capabilities::declare(
        &r.w.deps,
        o,
        DeclareInput {
            external_id: Some("act_".into()),
            ..declaring("meta_ads", "Boş")
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation);
    let page = capabilities::declare(
        &r.w.deps,
        o,
        DeclareInput {
            external_id: Some("act_5".into()),
            ..declaring("facebook_page", "Sayfa")
        },
    )
    .await
    .unwrap()
    .capability;
    assert_eq!(page.external_id.as_deref(), Some("act_5"));
}

#[test]
fn mailbox_credentials_are_typed_and_secret_free() {
    let input: SetCredentials = serde_json::from_value(json!({
        "kind_key":"mailbox", "name":"Support",
        "credential":{"kind":"mailbox", "smtp_host":"smtp.example.com", "smtp_port":465,
        "imap_host":"imap.example.com", "imap_port":993, "username":"support@example.com",
        "password":"mail-private-password", "from_address":"support@example.com", "tls":"implicit"}
    }))
    .unwrap();
    assert_eq!(input.credential.kind(), "mailbox");
    assert!(!format!("{input:?}").contains("mail-private-password"));
}

#[tokio::test]
async fn mailbox_rebind_revokes_hosts_and_resets_cursor() {
    use jt_app::ports::connectors::{MailboxCursor, MailboxPosition};
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let mail = Arc::new(ScriptedConnector::new(Provider::Mail));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(mail.clone()));
    capabilities::declare(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"kind_key":"notion","name":"Agent tool","connector_public":{"hosts":["agent-only.example.com"]}})).unwrap()).await.unwrap();
    mail.push_probe(ok_probe("support@example.com"));
    let out = connector::set_credentials(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"kind_key":"mailbox","name":"Mail","credential":{"kind":"mailbox","smtp_host":"smtp.example.com","smtp_port":465,"imap_host":"imap.example.com","imap_port":993,"username":"support@example.com","password":"secret","from_address":"support@example.com","tls":"implicit"}})).unwrap()).await.unwrap();
    let id = out.capability.id;
    assert!(w.hosts.calls().iter().all(|c| !matches!(c, HostCall::Rebuild(_, hosts) if hosts.iter().any(|h| h == "agent-only.example.com"))));
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.mail_cursors()
        .store(
            id,
            MailboxCursor {
                mailboxes: [
                    (
                        "INBOX".into(),
                        MailboxPosition {
                            uidvalidity: 7,
                            last_uid: 100,
                        },
                    ),
                    (
                        "Sent".into(),
                        MailboxPosition {
                            uidvalidity: 7,
                            last_uid: 50,
                        },
                    ),
                ]
                .into_iter()
                .collect(),
                read_history: false,
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    capabilities::update(
        &w.deps,
        &w.owner_ctx,
        id,
        UpdateCapability {
            name: None,
            description: None,
            external_id: Some("other@example.com".into()),
        },
    )
    .await
    .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let cursor = r.mail_cursors().get(id).await.unwrap();
    assert!(
        cursor
            .mailboxes
            .values()
            .all(|p| p.uidvalidity == 0 && p.last_uid == 0)
    );
    assert_eq!(
        w.hosts.calls().last(),
        Some(&HostCall::Rebuild(w.ws, vec![]))
    );
    let c = r.capabilities().find(id).await.unwrap().unwrap();
    assert!(c.connector_public.get("hosts").is_none());
}

#[tokio::test]
async fn host_mutations_wait_for_workspace_guard() {
    let w = world().await;
    let guard = w
        .deps
        .job_lock
        .try_acquire(&format!("jeeta.hosts.{}", w.ws))
        .await
        .unwrap()
        .unwrap();
    let pending = capabilities::declare(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"kind_key":"mailbox","name":"Mailbox","connector_public":{"hosts":["imap.example.com"]}})).unwrap());
    tokio::pin!(pending);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), &mut pending)
            .await
            .is_err()
    );
    assert!(w.hosts.calls().is_empty());
    guard.release().await.unwrap();
    pending.await.unwrap();
    assert!(
        w.hosts
            .calls()
            .contains(&HostCall::Allow(w.ws, "imap.example.com".into()))
    );
}
