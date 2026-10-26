//! Connecting accounts on the panel, end to end through Postgres, with scripted provider adapters
//! (nothing reaches a network): NetGSM by credentials entered by hand and probed, Meta by an OAuth
//! round trip whose callback the signed-in owner's browser brings back, reconnecting, and the
//! refusals: a state of another workspace or provider, a callback without a session or in a
//! workspace that is not active, and credentials bodies that are not exactly what the route
//! takes, which are refused without repeating a secret.

use std::sync::Arc;

use axum::http::{Method, StatusCode, header};
use axum::response::Response;
use jt_app::catalog::CATALOG;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{Asset, Url};
use jt_connector::{Credential, ProbeResult, Provider};
use jt_tenancy::WorkspaceStatus;
use jt_testkit::fakes::{
    ConnectorCall, FakeAppConfig, OAuthCall, ScriptedConnector, ScriptedOAuth, ScriptedRegistry,
};
use jt_testkit::panel::{Panel, body_json, body_text, expect_error, ok_json, workspace_of};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

const OWNER: &str = "owner@alpha.example";

/// Every secret the tests hand to the system; none may come back out.
const SECRETS: &[&str] = &[
    "netgsm-pass-1",
    "netgsm-pass-2",
    "EAAB-user-1",
    "EAAB-refresh",
    "EAAB-page-1",
    "EAAB-page-2",
    "code-1",
    "meta-app-secret",
];

/// The panel with every provider app configured and a scripted adapter per provider.
struct Rig {
    p: Panel,
    meta: Arc<ScriptedConnector>,
    meta_oauth: Arc<ScriptedOAuth>,
    netgsm: Arc<ScriptedConnector>,
    x_oauth: Arc<ScriptedOAuth>,
}

async fn rig() -> Rig {
    let meta = Arc::new(ScriptedConnector::new(Provider::Meta).with_hosts(&["graph.facebook.com"]));
    let netgsm =
        Arc::new(ScriptedConnector::new(Provider::Netgsm).with_hosts(&["api.netgsm.com.tr"]));
    let x = Arc::new(ScriptedConnector::new(Provider::X).with_hosts(&["api.x.com"]));
    let meta_oauth = Arc::new(ScriptedOAuth::new(Provider::Meta));
    let x_oauth = Arc::new(ScriptedOAuth::new(Provider::X));
    let registry = ScriptedRegistry::new()
        .with_connector(meta.clone())
        .with_connector(netgsm.clone())
        .with_connector(x)
        .with_oauth(meta_oauth.clone())
        .with_oauth(x_oauth.clone());
    let p =
        Panel::with_providers(Arc::new(FakeAppConfig::with_all_apps()), Arc::new(registry)).await;
    Rig {
        p,
        meta,
        meta_oauth,
        netgsm,
        x_oauth,
    }
}

/// `POST path` as `cookie` with a JSON body.
async fn post(p: &Panel, path: &str, cookie: &str, body: Value) -> Response {
    p.send(Method::POST, path, Some(cookie), Some(body)).await
}

/// `POST path` as `cookie` without a body.
async fn post_empty(p: &Panel, path: &str, cookie: &str) -> Response {
    p.send(Method::POST, path, Some(cookie), None).await
}

/// Asserts that `text` holds none of [`SECRETS`].
fn assert_no_secret(what: &str, text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "{what} leaks {secret}: {text}");
    }
}

/// A NetGSM SMS line's credentials as the panel sends them.
fn netgsm_body(password: &str) -> Value {
    json!({
        "kind_key": "sms_line",
        "name": "SMS hattı",
        "credential": {
            "kind": "netgsm_sms",
            "usercode": "8508001234",
            "password": password,
            "msgheader": "ALFA",
        },
    })
}

/// A probe that succeeded and names `account`.
fn ok_probe(account: &str) -> ProbeResult {
    ProbeResult::success(42, json!({ "account_id": account, "balance": 120 }))
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

fn user_token() -> Credential {
    Credential::OAuth {
        access_token: "EAAB-user-1".into(),
        refresh_token: Some("EAAB-refresh".into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(60)),
        scopes: vec!["pages_manage_posts".into()],
    }
}

/// The `name` query parameter of a URL.
fn query_param(url: &str, name: &str) -> String {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| panic!("{url} has no {name}"))
}

/// The callback route for `provider` with `state` and `code`, as the panel's page calls it.
fn callback(provider: &str, state: &str, code: &str) -> String {
    let mut url = Url::parse("http://panel.test/").unwrap();
    url.set_path(&format!("/api/connectors/oauth/callback/{provider}"));
    url.query_pairs_mut()
        .append_pair("state", state)
        .append_pair("code", code);
    format!("{}?{}", url.path(), url.query().unwrap())
}

/// Starts a Facebook Page flow as `cookie`; returns the answer and its state.
async fn start_page_flow(r: &Rig, cookie: &str) -> (Value, String) {
    let started = ok_json(
        post(
            &r.p,
            "/api/connectors/oauth/start",
            cookie,
            json!({ "kind_key": "facebook_page" }),
        )
        .await,
    )
    .await;
    let state = query_param(started["authorize_url"].as_str().unwrap(), "state");
    (started, state)
}

#[tokio::test]
async fn owner_connects_netgsm_by_credentials_and_probe_marks_verified() {
    let r = rig().await;
    let p = &r.p;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    // The owner enters the line's credentials; the system seals them, runs the connection step
    // and probes them, and the probe's account becomes the line's.
    r.netgsm.push_probe(ok_probe("8508001234"));
    let resp = post(
        p,
        "/api/connectors/credentials",
        &owner,
        netgsm_body("netgsm-pass-1"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let text = body_text(resp).await;
    assert_no_secret("the answer", &text);
    let out: Value = serde_json::from_str(&text).unwrap();
    let c = &out["capability"];
    assert_eq!(c["kind_key"], "sms_line");
    assert_eq!(c["reach"], "connector");
    assert_eq!(c["status"], "verified");
    assert_eq!(out["effective_status"], "verified");
    assert_eq!(c["external_id"], "8508001234");
    assert_eq!(c["has_sealed_config"], true);
    assert_eq!(c["connector_public"]["provider"], "netgsm");
    let id = c["id"].as_str().unwrap().to_owned();
    let calls = r.netgsm.calls();
    assert!(matches!(calls[0], ConnectorCall::OnConnected { .. }));
    assert!(matches!(
        &calls[1],
        ConnectorCall::Probe { credential: Credential::NetgsmSms { password, .. }, .. }
            if password == "netgsm-pass-1"
    ));

    // A probe on demand: the outcome and the status after it.
    r.netgsm.push_probe(ok_probe("8508001234"));
    let probed = ok_json(post_empty(p, &format!("/api/connectors/{id}/probe"), &owner).await).await;
    assert_eq!(probed["status"], "verified");
    assert_eq!(probed["result"]["ok"], true);
    assert_eq!(probed["result"]["latency_ms"], 42);
    assert_eq!(probed["result"]["error_kind"], Value::Null);
    assert_eq!(probed["result"]["facts"]["account_id"], "8508001234");

    // Its health: the last probe succeeded, nothing to reconnect.
    let health = ok_json(p.get("/api/connectors/health", &owner).await).await;
    assert_eq!(health.as_array().unwrap().len(), 1);
    let h = &health[0];
    assert_eq!(h["capability_id"], json!(id));
    assert_eq!(h["provider"], "netgsm");
    assert_eq!(h["status"], "verified");
    assert_eq!(h["ok"], true);
    assert_eq!(h["reconnect_required"], false);
    assert!(h["last_probe_at"].is_string());

    // A probe that fails with Auth marks it unreachable and asks for new credentials, which a
    // second entry gives; the ledger names a person (not an agent) and never a secret.
    r.netgsm.push_probe(ProbeResult::failure(
        30,
        jt_connector::ConnectorError::auth("bad credentials"),
    ));
    let failed = ok_json(post_empty(p, &format!("/api/connectors/{id}/probe"), &owner).await).await;
    assert_eq!(failed["status"], "unreachable");
    assert_eq!(failed["result"]["error_kind"], "auth");
    let health = ok_json(p.get("/api/connectors/health", &owner).await).await;
    assert_eq!(health[0]["reconnect_required"], true);
    r.netgsm.push_probe(ok_probe("8508001234"));
    let body = json!({
        "capability_id": id,
        "credential": {
            "kind": "netgsm_sms",
            "usercode": "8508001234",
            "password": "netgsm-pass-2",
            "msgheader": "ALFA",
        },
    });
    let renewed = ok_json(post(p, "/api/connectors/credentials", &owner, body).await).await;
    assert_eq!(renewed["capability"]["status"], "verified");
    assert_eq!(
        renewed["capability"]["connector_public"]["reconnect_required"],
        false
    );

    let ledger = p.get("/api/ledger?action_prefix=connector.", &owner).await;
    let ledger = body_text(ledger).await;
    assert_no_secret("the ledger", &ledger);
    let ledger: Value = serde_json::from_str(&ledger).unwrap();
    let set: Vec<&Value> = ledger
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["entry"]["action"] == "connector.credentials_set")
        .collect();
    assert_eq!(set.len(), 2);
    for entry in set {
        assert_eq!(
            entry["entry"]["payload"],
            json!({ "kind_key": "sms_line", "by_agent": false })
        );
        assert_eq!(entry["entry"]["actor"]["kind"], "human");
    }

    // A NetGSM line takes credentials by hand, never an OAuth flow.
    let refused = expect_error(
        post(
            p,
            "/api/connectors/oauth/start",
            &owner,
            json!({ "kind_key": "sms_line" }),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(refused["details"]["reason"], "use_set_credentials");
    let refused = expect_error(
        post_empty(p, &format!("/api/connectors/{id}/reconnect"), &owner).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(refused["details"]["reason"], "use_set_credentials");
}

#[tokio::test]
async fn oauth_round_trip_creates_capabilities_from_selected_assets() {
    let r = rig().await;
    let p = &r.p;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    // The owner starts a flow: the provider's authorize URL, sending the browser back to the
    // panel's page (not the API), with a state signed for the workspace.
    let (started, state) = start_page_flow(&r, &owner).await;
    let authorize_url = started["authorize_url"].as_str().unwrap();
    assert_eq!(
        query_param(authorize_url, "redirect_uri"),
        "https://panel.test/oauth/callback/meta"
    );
    assert_eq!(query_param(authorize_url, "client_id"), "meta-app-id");
    assert!(started["pending_id"].is_string());
    assert!(started["expires_at"].is_string());
    assert_no_secret("the start", &started.to_string());

    // The provider sends the browser back; the page calls the callback route with the state
    // and code: the assets the account reaches, for the owner to choose from, never a token.
    r.meta_oauth.push_exchange(Ok(user_token()));
    r.meta_oauth.push_assets(Ok(vec![
        page_asset("page-1", "Kahve", "EAAB-page-1"),
        page_asset("page-2", "Çay", "EAAB-page-2"),
    ]));
    let resp = p.get(&callback("meta", &state, "code-1"), &owner).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let text = body_text(resp).await;
    assert_no_secret("the callback", &text);
    let pending: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(pending["pending_id"], started["pending_id"]);
    assert_eq!(
        pending["assets"],
        json!([
            { "kind_key": "facebook_page", "external_id": "page-1", "name": "Kahve", "public": { "category": "Cafe", "granted_scopes": ["pages_manage_posts"] } },
            { "kind_key": "facebook_page", "external_id": "page-2", "name": "Çay", "public": { "category": "Cafe", "granted_scopes": ["pages_manage_posts"] } },
        ])
    );
    assert!(matches!(
        &r.meta_oauth.calls()[1],
        OAuthCall::Exchange { code, redirect, .. }
            if code == "code-1" && redirect.as_str() == "https://panel.test/oauth/callback/meta"
    ));

    // The confirmation body is read strictly.
    let pending_id = pending["pending_id"].as_str().unwrap();
    let confirm = format!("/api/connectors/oauth/{pending_id}/confirm");
    expect_error(
        post(
            p,
            &confirm,
            &owner,
            json!({ "selected": ["page-1"], "pending_id": pending_id }),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;

    // The owner chooses one of the two pages: one capability, probed and verified.
    r.meta.push_probe(ok_probe("page-1"));
    let resp = post(p, &confirm, &owner, json!({ "selected": ["page-1"] })).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let text = body_text(resp).await;
    assert_no_secret("the confirmation", &text);
    let created: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(created.as_array().unwrap().len(), 1);
    let c = &created[0]["capability"];
    assert_eq!(c["kind_key"], "facebook_page");
    assert_eq!(c["external_id"], "page-1");
    assert_eq!(c["name"], "Kahve");
    assert_eq!(c["status"], "verified");
    let id = c["id"].as_str().unwrap().to_owned();
    let listed = ok_json(p.get("/api/capabilities", &owner).await).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["capability"]["id"], json!(id));

    // The flow is gone once confirmed: confirming it again is NOT_FOUND.
    expect_error(
        post(p, &confirm, &owner, json!({ "selected": ["page-2"] })).await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;

    // Reconnecting the page starts a flow bound to it; the callback keeps only its account.
    let again =
        ok_json(post_empty(p, &format!("/api/connectors/{id}/reconnect"), &owner).await).await;
    let state = query_param(again["authorize_url"].as_str().unwrap(), "state");
    r.meta_oauth.push_exchange(Ok(user_token()));
    r.meta_oauth.push_assets(Ok(vec![
        page_asset("page-1", "Kahve", "EAAB-page-1"),
        page_asset("page-2", "Çay", "EAAB-page-2"),
    ]));
    let pending = ok_json(p.get(&callback("meta", &state, "code-1"), &owner).await).await;
    assert_eq!(pending["assets"].as_array().unwrap().len(), 1);
    assert_eq!(pending["assets"][0]["external_id"], "page-1");

    let ledger = body_text(p.get("/api/ledger?action_prefix=connector.", &owner).await).await;
    assert_no_secret("the ledger", &ledger);
}

/// Instagram Login runs under the platform's Instagram app, which registers its own redirect URI:
/// the provider sends the browser back to the panel's `/oauth/callback/instagram`, the page calls
/// `GET /api/connectors/oauth/callback/instagram`, and the code is exchanged with that same URI.
/// The Meta app's callback does not complete it (nor does `instagram` complete a Facebook Login
/// flow), and the provider is not asked then.
#[tokio::test]
async fn instagram_login_comes_back_to_its_own_callback() {
    let r = rig().await;
    let p = &r.p;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    let started = ok_json(
        post(
            p,
            "/api/connectors/oauth/start",
            &owner,
            json!({ "kind_key": "instagram" }),
        )
        .await,
    )
    .await;
    let authorize_url = started["authorize_url"].as_str().unwrap();
    assert_eq!(
        query_param(authorize_url, "redirect_uri"),
        "https://panel.test/oauth/callback/instagram"
    );
    assert_eq!(query_param(authorize_url, "client_id"), "instagram-app-id");
    let state = query_param(authorize_url, "state");

    // Brought back to the Meta app's callback (or X's), it is refused before the provider is
    // asked.
    for wrong in ["meta", "x"] {
        expect_error(
            p.get(&callback(wrong, &state, "code-1"), &owner).await,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    assert_eq!(r.meta_oauth.calls().len(), 1, "only the authorize URL");

    // A Facebook Login flow is not completed at the Instagram app's callback either.
    let (_, page_state) = start_page_flow(&r, &owner).await;
    expect_error(
        p.get(&callback("instagram", &page_state, "code-1"), &owner)
            .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(r.meta_oauth.calls().len(), 2, "only the two authorize URLs");

    // At its own callback it completes, exchanging the code with its own redirect URI.
    r.meta_oauth.push_exchange(Ok(Credential::OAuth {
        access_token: "IGAA-ig-1".into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(60)),
        scopes: vec!["instagram_business_basic".into()],
    }));
    r.meta_oauth.push_assets(Ok(vec![Asset {
        kind_key: "instagram".into(),
        external_id: "17841400000000001".into(),
        name: "kahveevi".into(),
        credential: Credential::OAuth {
            access_token: "IGAA-ig-1".into(),
            refresh_token: None,
            expires_at: None,
            scopes: vec![],
        },
        public: json!({ "username": "kahveevi" }),
    }]));
    let resp = p
        .get(&callback("instagram", &state, "code-1"), &owner)
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let text = body_text(resp).await;
    assert!(!text.contains("IGAA-ig-1"), "{text}");
    let pending: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(pending["pending_id"], started["pending_id"]);
    assert_eq!(pending["assets"][0]["kind_key"], "instagram");
    assert!(matches!(
        &r.meta_oauth.calls()[2],
        OAuthCall::Exchange { client_id, code, redirect, .. }
            if client_id == "instagram-app-id"
                && code == "code-1"
                && redirect.as_str() == "https://panel.test/oauth/callback/instagram"
    ));
}

#[tokio::test]
async fn callback_with_foreign_state_is_forbidden() {
    let r = rig().await;
    let p = &r.p;
    let (alpha, _) = p.register(OWNER, "Alpha").await;
    let (beta, _) = p.register("owner@beta.example", "Beta").await;
    let (_, state) = start_page_flow(&r, &alpha).await;

    // Beta's owner, signed in to Beta, cannot complete Alpha's flow; the provider is not asked.
    let refused = expect_error(
        p.get(&callback("meta", &state, "code-1"), &beta).await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_no_secret("the refusal", &refused.to_string());
    // Nor can Alpha's owner bring it back to another provider's callback, nor a forged state.
    expect_error(
        p.get(&callback("x", &state, "code-1"), &alpha).await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    let (payload, _) = state.split_once('.').unwrap();
    let forged = format!("{payload}.{}", "0".repeat(64));
    expect_error(
        p.get(&callback("meta", &forged, "code-1"), &alpha).await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(r.meta_oauth.calls().len(), 1, "only the authorize URL");
    assert!(r.x_oauth.calls().is_empty());

    // Alpha's owner completes it.
    r.meta_oauth.push_exchange(Ok(user_token()));
    r.meta_oauth
        .push_assets(Ok(vec![page_asset("page-1", "Kahve", "EAAB-page-1")]));
    let pending = ok_json(p.get(&callback("meta", &state, "code-1"), &alpha).await).await;
    assert_eq!(pending["assets"].as_array().unwrap().len(), 1);

    // Beta cannot confirm Alpha's flow either: it is not Beta's to find.
    let pending_id = pending["pending_id"].as_str().unwrap();
    expect_error(
        post(
            p,
            &format!("/api/connectors/oauth/{pending_id}/confirm"),
            &beta,
            json!({ "selected": ["page-1"] }),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
}

#[tokio::test]
async fn callback_without_session_is_unauthenticated() {
    let r = rig().await;
    let p = &r.p;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let (_, state) = start_page_flow(&r, &owner).await;

    // The state alone completes nothing: the browser must bring the session that started it.
    let resp = p
        .send(Method::GET, &callback("meta", &state, "code-1"), None, None)
        .await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
    assert_eq!(r.meta_oauth.calls().len(), 1, "only the authorize URL");

    // A segment that names no OAuth app (a provider without OAuth among them), and a query
    // naming anything but the state and the code, are refused before the use case runs.
    for segment in ["tiktok", "netgsm", "Meta"] {
        expect_error(
            p.get(&callback(segment, &state, "code-1"), &owner).await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
        )
        .await;
    }
    let extra = format!("{}&scope=x", callback("meta", &state, "code-1"));
    expect_error(
        p.get(&extra, &owner).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let missing = format!("/api/connectors/oauth/callback/meta?state={state}");
    expect_error(
        p.get(&missing, &owner).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(r.meta_oauth.calls().len(), 1);
}

#[tokio::test]
async fn callback_in_a_suspended_workspace_is_refused() {
    let r = rig().await;
    let p = &r.p;
    let (owner, me) = p.register(OWNER, "Alpha").await;
    let (_, state) = start_page_flow(&r, &owner).await;

    // The operator suspends the workspace before the browser comes back: the callback is
    // refused before the provider is asked.
    let mut platform = p.uow.platform().await.unwrap();
    platform
        .workspace_set_status(
            workspace_of(&me),
            WorkspaceStatus::Suspended,
            "test status transition",
            &jt_ledger::Actor::System {
                component: "test".into(),
            },
        )
        .await
        .unwrap();
    platform.commit().await.unwrap();
    let refused = expect_error(
        p.get(&callback("meta", &state, "code-1"), &owner).await,
        StatusCode::LOCKED,
        "WORKSPACE_INACTIVE",
    )
    .await;
    assert_eq!(refused["details"], json!({ "status": "suspended" }));
    assert_eq!(r.meta_oauth.calls().len(), 1, "only the authorize URL");

    // A workspace awaiting payment connects nothing either: every connection route answers 423
    // before its handler runs.
    let (pending, _) = p.register_pending("owner@beta.example", "Beta").await;
    let some_id = "0192f0c4-0000-7000-8000-000000000000";
    let mut checked = 0;
    for uc in CATALOG.iter().filter(|uc| uc.id.starts_with("connector.")) {
        let (method, template) = uc.panel_route.unwrap();
        let path = template
            .split('/')
            .map(|part| match part {
                "{provider}" => "meta",
                p if p.starts_with('{') => some_id,
                p => p,
            })
            .collect::<Vec<_>>()
            .join("/");
        let path = if uc.id == "connector.complete_oauth" {
            format!("{path}?state=s&code=c")
        } else {
            path
        };
        let method = Method::from_bytes(method.as_bytes()).unwrap();
        let body = (method == Method::POST).then(|| json!({}));
        let refused = expect_error(
            p.send(method, &path, Some(&pending), body).await,
            StatusCode::LOCKED,
            "WORKSPACE_INACTIVE",
        )
        .await;
        assert_eq!(
            refused["details"],
            json!({ "status": "pending_payment" }),
            "{}",
            uc.id
        );
        checked += 1;
    }
    assert_eq!(checked, 8);
}

#[tokio::test]
async fn set_credentials_body_is_strict_and_never_echoed() {
    let r = rig().await;
    let p = &r.p;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    // Anything but exactly the route's body is refused, and the refusal repeats no value: an
    // unknown field beside the credential or inside it, a missing field, a field of the wrong
    // type, a credential that is not an object, an unknown credential shape.
    let credential = |extra: Value| {
        let mut c = json!({
            "kind": "netgsm_sms",
            "usercode": "8508001234",
            "password": "netgsm-pass-1",
            "msgheader": "ALFA",
        });
        for (k, v) in extra.as_object().unwrap() {
            c[k] = v.clone();
        }
        c
    };
    let bodies = [
        json!({ "kind_key": "sms_line", "name": "H", "password": "netgsm-pass-1", "credential": credential(json!({})) }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": credential(json!({ "token": "netgsm-pass-1" })) }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm_sms", "usercode": "u", "msgheader": "K" } }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": credential(json!({ "password": 98_765_432 })) }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": "netgsm-pass-1" }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm-pass-1", "password": "x" } }),
        json!({ "kind_key": "sms_line", "name": "H" }),
    ];
    for body in bodies {
        let resp = post(p, "/api/connectors/credentials", &owner, body.clone()).await;
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        let text = body_text(resp).await;
        assert_no_secret("a refusal", &text);
        assert!(!text.contains("98765432"), "{text}");
        let refused: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(refused["code"], "VALIDATION", "{text}");
    }
    // A value refused by the use case names its field, never the value.
    let refused = expect_error(
        post(
            p,
            "/api/connectors/credentials",
            &owner,
            json!({ "kind_key": "sms_line", "name": "H", "credential": credential(json!({ "usercode": "netgsm-pass-1\u{7}x" })) }),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_no_secret("a refusal", &refused.to_string());
    // X connects through OAuth only.
    let refused = expect_error(
        post(
            p,
            "/api/connectors/credentials",
            &owner,
            json!({ "kind_key": "x", "name": "X", "credential": { "kind": "meta_token", "access_token": "EAAB-user-1" } }),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(refused["details"]["field"], "kind_key");
    assert_no_secret("a refusal", &refused.to_string());

    // A rep reads the health and may probe, but enters no credentials and starts no flow.
    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;
    let refused = expect_error(
        post(
            p,
            "/api/connectors/credentials",
            &rep,
            netgsm_body("netgsm-pass-1"),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(
        refused["details"],
        json!({ "permission": "capabilities.manage" })
    );
    expect_error(
        post(
            p,
            "/api/connectors/oauth/start",
            &rep,
            json!({ "kind_key": "facebook_page" }),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(
        ok_json(p.get("/api/connectors/health", &rep).await).await,
        json!([])
    );

    // Nothing was written and no provider was asked.
    assert!(r.netgsm.calls().is_empty());
    assert!(
        ok_json(p.get("/api/capabilities", &owner).await)
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    let ledger = ok_json(p.get("/api/ledger?action_prefix=connector.", &owner).await).await;
    assert_eq!(ledger, json!([]));

    // Well formed, it goes through, and the answer holds no secret either.
    r.netgsm.push_probe(ok_probe("8508001234"));
    let resp = post(
        p,
        "/api/connectors/credentials",
        &owner,
        netgsm_body("netgsm-pass-1"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_no_secret("the answer", &body_text(resp).await);
    let body = body_json(p.get("/api/capabilities", &owner).await).await;
    assert_no_secret("the list", &body.to_string());
}

#[tokio::test]
async fn a_declared_page_connects_through_a_flow_bound_to_it() {
    let r = rig().await;
    let p = &r.p;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    // Declared before any connection: no account yet.
    let declared = ok_json(
        post(
            p,
            "/api/capabilities",
            &owner,
            json!({ "kind_key": "facebook_page", "name": "Kahve sayfası" }),
        )
        .await,
    )
    .await;
    let id = declared["capability"]["id"].as_str().unwrap().to_owned();

    // "Connect" on it is a flow bound to it; the callback offers every page the account reaches.
    let started =
        ok_json(post_empty(p, &format!("/api/connectors/{id}/reconnect"), &owner).await).await;
    let state = query_param(started["authorize_url"].as_str().unwrap(), "state");
    r.meta_oauth.push_exchange(Ok(user_token()));
    r.meta_oauth.push_assets(Ok(vec![
        page_asset("page-1", "Kahve", "EAAB-page-1"),
        page_asset("page-2", "Çay", "EAAB-page-2"),
    ]));
    let pending = ok_json(p.get(&callback("meta", &state, "code-1"), &owner).await).await;
    assert_eq!(pending["assets"].as_array().unwrap().len(), 2);

    // The page chosen first becomes the declared capability, the other a new one: no orphan.
    r.meta.push_probe(ok_probe("page-2"));
    r.meta.push_probe(ok_probe("page-1"));
    let pending_id = pending["pending_id"].as_str().unwrap();
    let confirmed = ok_json(
        post(
            p,
            &format!("/api/connectors/oauth/{pending_id}/confirm"),
            &owner,
            json!({ "selected": ["page-2", "page-1"] }),
        )
        .await,
    )
    .await;
    assert_eq!(confirmed[0]["capability"]["id"], json!(id));
    assert_eq!(confirmed[0]["capability"]["external_id"], "page-2");
    assert_eq!(confirmed[0]["capability"]["name"], "Kahve sayfası");
    assert_eq!(confirmed[0]["capability"]["status"], "verified");
    assert_eq!(confirmed[1]["capability"]["external_id"], "page-1");
    let listed = ok_json(p.get("/api/capabilities", &owner).await).await;
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let ledger = body_text(p.get("/api/ledger?action_prefix=connector.", &owner).await).await;
    assert_no_secret("the ledger", &ledger);
}

#[tokio::test]
async fn iys_provisioning_attaches_to_sms_line_and_refuses_mismatched_usercode() {
    let r = rig().await;
    let (owner, _) = r.p.register(OWNER, "Alpha").await;
    r.netgsm.push_probe(ok_probe("8508001234"));
    let sms = ok_json(
        post(
            &r.p,
            "/api/connectors/credentials",
            &owner,
            netgsm_body("netgsm-pass-1"),
        )
        .await,
    )
    .await;
    let id = sms["capability"]["id"].clone();
    let iys = json!({"capability_id":id,"credential":{"kind":"netgsm_iys","usercode":"8508001234","password":"iys-private","brand_code":"brand-42"}});
    let out = ok_json(post(&r.p, "/api/connectors/credentials", &owner, iys.clone()).await).await;
    assert_eq!(out["capability"]["id"], id);
    assert_eq!(
        out["capability"]["connector_public"]["iys"]["brand_code"],
        "brand-42"
    );
    assert_eq!(out["capability"]["status"], "verified");
    assert!(!out.to_string().contains("iys-private"));
    let mut wrong = iys.clone();
    wrong["credential"]["usercode"] = json!("different");
    let refused = post(&r.p, "/api/connectors/credentials", &owner, wrong).await;
    assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let error = body_json(refused).await;
    assert_eq!(error["details"]["reason"], "iys_usercode_mismatch");
    r.netgsm.push_probe(ok_probe("8508001234"));
    ok_json(
        post_empty(
            &r.p,
            &format!("/api/connectors/{}/probe", id.as_str().unwrap()),
            &owner,
        )
        .await,
    )
    .await;
    assert!(
        matches!(r.netgsm.calls().last().unwrap(),ConnectorCall::Probe { credential:Credential::NetgsmSms {password,..},..} if password=="netgsm-pass-1")
    );
    let mut no_id = iys;
    no_id.as_object_mut().unwrap().remove("capability_id");
    no_id["kind_key"] = json!("sms_line");
    no_id["name"] = json!("IYS");
    assert_eq!(
        post(&r.p, "/api/connectors/credentials", &owner, no_id)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}
