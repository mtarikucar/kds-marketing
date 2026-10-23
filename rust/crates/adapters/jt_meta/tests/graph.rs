//! The Meta adapter against the in-process Graph mock: OAuth, assets, proofs, error mapping,
//! probes, the connection step, publishing, counters, messaging, lead-gen, ads and refresh.

mod support;

use std::sync::Arc;
use std::time::Duration as StdDuration;

use jt_app::ports::connectors::{
    AdBudgetWriter, Connector, InsightsReader, LeadGenFetcher, MessagingSender, OAuthApp,
    OAuthProvider, PublishRequest, Publisher,
};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_meta::{
    ContainerPoll, FACEBOOK_SCOPES, INSTAGRAM_SCOPES, META_HOSTS, MetaBases, MetaConnector,
    PAGE_SUBSCRIBED_FIELDS,
};
use jt_outbound::FIXED_HOSTS;
use serde_json::{Value, json};
use support::*;
use time::macros::date;
use time::{Duration, OffsetDateTime};
use url::Url;

const PAGE: &str = "1234567890";
const PAGE_TOKEN: &str = "EAAB-page-1234567890";
const USER_TOKEN: &str = "EAAB-long-test";
const IG: &str = "17841400000000001";
const IG_LOGIN_TOKEN: &str = "IGAA-long-test";
const PHONE: &str = "5555555555";
const WA_TOKEN: &str = "EAAB-wa-test";

fn page_cred() -> Credential {
    Credential::PageToken {
        page_id: PAGE.into(),
        token: PAGE_TOKEN.into(),
    }
}

fn user_cred() -> Credential {
    Credential::OAuth {
        access_token: USER_TOKEN.into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(50)),
        scopes: vec!["ads_read".into()],
    }
}

fn ig_login_cred() -> Credential {
    Credential::OAuth {
        access_token: IG_LOGIN_TOKEN.into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(50)),
        scopes: INSTAGRAM_SCOPES.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// A WhatsApp credential with a system user's token (no expiry).
fn wa_cred(waba: Option<&str>) -> Credential {
    Credential::WhatsAppCloud {
        phone_number_id: PHONE.into(),
        token: WA_TOKEN.into(),
        waba_id: waba.map(str::to_owned),
        expires_at: None,
    }
}

/// The public fields the use cases hand an adapter for a capability of `kind` holding `account`.
fn public(kind: &str, account: Option<&str>) -> Value {
    let mut p = json!({ "provider": "meta", "kind_key": kind });
    if let Some(account) = account {
        p["external_id"] = json!(account);
    }
    p
}

fn redirect() -> Url {
    Url::parse("https://panel.test/api/connectors/oauth/callback/meta").unwrap()
}

fn kind_of<T: std::fmt::Debug>(r: Result<T, ConnectorError>) -> &'static str {
    r.expect_err("an error").kind()
}

// ---------------------------------------------------------------------------------------------
// Hosts and OAuth
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn hosts_are_the_fixed_meta_hosts() {
    let r = rig().await;
    let fixed: Vec<&str> = FIXED_HOSTS
        .iter()
        .filter(|h| h.connector == "meta")
        .map(|h| h.host)
        .collect();
    assert_eq!(r.meta.hosts(), fixed.as_slice());
    assert_eq!(META_HOSTS, fixed.as_slice());
    assert_eq!(r.meta.provider(), Provider::Meta);
    // The production bases reach exactly those hosts (the dialogs are only for browsers).
    let production = MetaBases::production();
    for base in [
        &production.graph,
        &production.instagram_graph,
        &production.instagram_api,
    ] {
        assert!(fixed.contains(&base.host_str().unwrap()), "{base}");
        assert_eq!(base.scheme(), "https");
    }
}

#[tokio::test]
async fn authorize_urls_carry_scopes_or_config_id() {
    let r = rig().await;
    let pairs = |url: &Url| -> Vec<(String, String)> {
        url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    };
    let get = |url: &Url, name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    let fb = r
        .meta
        .authorize_url(&OAuthApp::Meta(meta_app()), &redirect(), "state-1", None);
    assert_eq!(fb.host_str(), Some("www.facebook.com"));
    assert_eq!(fb.path(), "/v19.0/dialog/oauth");
    assert_eq!(get(&fb, "client_id").as_deref(), Some(META_APP_ID));
    assert_eq!(
        get(&fb, "redirect_uri").as_deref(),
        Some(redirect().as_str())
    );
    assert_eq!(get(&fb, "state").as_deref(), Some("state-1"));
    assert_eq!(get(&fb, "response_type").as_deref(), Some("code"));
    assert_eq!(get(&fb, "scope"), Some(FACEBOOK_SCOPES.join(",")));
    assert_eq!(
        get(&fb, "scope").unwrap().split(',').collect::<Vec<_>>(),
        vec![
            "pages_show_list",
            "pages_manage_posts",
            "pages_read_engagement",
            "business_management",
            "pages_messaging",
            "pages_manage_metadata",
            "instagram_basic",
            "instagram_manage_messages",
            "instagram_content_publish",
            "whatsapp_business_management",
            "whatsapp_business_messaging",
            "ads_read",
            "read_insights",
            "instagram_manage_insights",
            "leads_retrieval",
            "ads_management",
        ]
    );
    assert_eq!(get(&fb, "config_id"), None);
    assert!(!fb.as_str().contains(META_APP_SECRET));

    // A login configuration replaces the scopes; the app's Graph version is used.
    let mut configured = meta_app();
    configured.login_config_id = Some("cfg-test".into());
    configured.graph_version = Some("v21.0".into());
    let fb = r
        .meta
        .authorize_url(&OAuthApp::Meta(configured), &redirect(), "s", Some("chal"));
    assert_eq!(fb.path(), "/v21.0/dialog/oauth");
    assert_eq!(get(&fb, "config_id").as_deref(), Some("cfg-test"));
    assert_eq!(get(&fb, "scope"), None);
    assert_eq!(get(&fb, "code_challenge").as_deref(), Some("chal"));
    assert_eq!(get(&fb, "code_challenge_method").as_deref(), Some("S256"));

    let ig = r.meta.authorize_url(
        &OAuthApp::Instagram(instagram_app()),
        &redirect(),
        "state-2",
        None,
    );
    assert_eq!(ig.host_str(), Some("www.instagram.com"));
    assert_eq!(ig.path(), "/oauth/authorize");
    assert_eq!(
        pairs(&ig),
        vec![
            ("client_id".into(), INSTAGRAM_APP_ID.into()),
            ("redirect_uri".into(), redirect().to_string()),
            ("response_type".into(), "code".into()),
            (
                "scope".into(),
                "instagram_business_basic,instagram_business_content_publish".into()
            ),
            ("state".into(), "state-2".into()),
        ]
    );
    assert!(r.mock.recorded().is_empty(), "authorize URLs fetch nothing");
}

#[tokio::test]
async fn facebook_exchange_goes_long_lived_and_reads_granted_scopes() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "GET",
        "/fb/v19.0/oauth/access_token",
        ok(graph_fixture(m, "oauth_short_token")),
    );
    m.on(
        "GET",
        "/fb/v19.0/oauth/access_token",
        ok(graph_fixture(m, "oauth_long_token")),
    );
    m.on(
        "GET",
        "/fb/v19.0/me/permissions",
        ok(graph_fixture(m, "me_permissions")),
    );
    let before = OffsetDateTime::now_utc();
    let cred = r
        .meta
        .exchange(&OAuthApp::Meta(meta_app()), &redirect(), "code-test", None)
        .await
        .unwrap();
    let Credential::OAuth {
        access_token,
        refresh_token,
        expires_at,
        scopes,
    } = &cred
    else {
        panic!("{cred:?}");
    };
    assert_eq!(access_token, "EAAB-long-test");
    assert_eq!(refresh_token, &None);
    let expires = expires_at.unwrap();
    assert!(expires >= before + Duration::seconds(5_183_944));
    assert!(expires <= OffsetDateTime::now_utc() + Duration::seconds(5_183_944));
    assert_eq!(
        scopes,
        &vec!["pages_show_list".to_owned(), "pages_messaging".to_owned()]
    );

    let calls = m.requests("GET", "/fb/v19.0/oauth/access_token");
    assert_eq!(calls.len(), 2);
    let code = &calls[0];
    assert_eq!(code.param("client_id"), Some(META_APP_ID));
    assert_eq!(code.param("client_secret"), Some(META_APP_SECRET));
    assert_eq!(code.param("redirect_uri"), Some(redirect().as_str()));
    assert_eq!(code.param("code"), Some("code-test"));
    assert_eq!(code.param("grant_type"), None);
    assert_eq!(code.header("authorization"), None);
    let long = &calls[1];
    assert_eq!(long.param("grant_type"), Some("fb_exchange_token"));
    assert_eq!(long.param("fb_exchange_token"), Some("EAAB-short-test"));
    assert_eq!(long.param("client_secret"), Some(META_APP_SECRET));
    assert_graph_auth(
        &m.request("GET", "/fb/v19.0/me/permissions"),
        "EAAB-long-test",
    );

    // A refused code is an `Auth` refusal, its reason without the code or the secret.
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v19.0/oauth/access_token",
        status(
            400,
            json!({ "error": {
                "message": "Invalid verification code format. code=code-bad",
                "type": "OAuthException",
            }}),
        ),
    );
    let e = r
        .meta
        .exchange(&OAuthApp::Meta(meta_app()), &redirect(), "code-bad", None)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "auth");
    assert!(!e.to_string().contains("code-bad"), "{e}");
    assert!(!e.to_string().contains(META_APP_SECRET), "{e}");
}

#[tokio::test]
async fn instagram_login_exchange_strips_the_fragment_and_goes_long_lived() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/igapi/oauth/access_token",
        ok(graph_fixture(m, "ig_short_token")),
    );
    m.on(
        "GET",
        "/ig/access_token",
        ok(graph_fixture(m, "ig_long_token")),
    );
    let cred = r
        .meta
        .exchange(
            &OAuthApp::Instagram(instagram_app()),
            &redirect(),
            "AQ-code-test#_",
            None,
        )
        .await
        .unwrap();
    let Credential::OAuth {
        access_token,
        scopes,
        expires_at,
        ..
    } = &cred
    else {
        panic!("{cred:?}");
    };
    assert_eq!(access_token, "IGAA-long-test");
    assert_eq!(
        scopes,
        &vec![
            "instagram_business_basic".to_owned(),
            "instagram_business_content_publish".to_owned()
        ]
    );
    assert!(expires_at.unwrap() > OffsetDateTime::now_utc() + Duration::days(59));

    let form = m.request("POST", "/igapi/oauth/access_token").form();
    let field = |name: &str| {
        form.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(
        field("code"),
        Some("AQ-code-test"),
        "the trailing #_ is stripped"
    );
    assert_eq!(field("client_id"), Some(INSTAGRAM_APP_ID));
    assert_eq!(field("client_secret"), Some(INSTAGRAM_APP_SECRET));
    assert_eq!(field("grant_type"), Some("authorization_code"));
    assert_eq!(field("redirect_uri"), Some(redirect().as_str()));
    let long = m.request("GET", "/ig/access_token");
    assert_eq!(long.param("grant_type"), Some("ig_exchange_token"));
    assert_eq!(long.param("access_token"), Some("IGAA-short-test"));
    assert_eq!(long.param("client_secret"), Some(INSTAGRAM_APP_SECRET));
    assert_eq!(long.param("appsecret_proof"), None);
}

// ---------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------

/// Scripts the mock for a full Facebook Login listing.
fn script_listing(m: &Mock) {
    m.on(
        "GET",
        "/fb/v19.0/me/accounts",
        ok(graph_fixture(m, "me_accounts_1")),
    );
    m.on(
        "GET",
        "/fb/v19.0/me/accounts",
        ok(graph_fixture(m, "me_accounts_2")),
    );
    m.on(
        "GET",
        "/fb/v19.0/1234567890",
        ok(graph_fixture(m, "page_instagram")),
    );
    m.on(
        "GET",
        "/fb/v19.0/1234567891",
        ok(graph_fixture(m, "page_no_instagram")),
    );
    m.on(
        "GET",
        "/fb/v19.0/me/adaccounts",
        ok(graph_fixture(m, "me_adaccounts")),
    );
    m.on(
        "GET",
        "/fb/v19.0/me/businesses",
        ok(graph_fixture(m, "me_businesses")),
    );
    m.on(
        "GET",
        "/fb/v19.0/3333333333/owned_whatsapp_business_accounts",
        ok(graph_fixture(m, "owned_wabas")),
    );
    m.on(
        "GET",
        "/fb/v19.0/4444444444/phone_numbers",
        ok(graph_fixture(m, "phone_numbers")),
    );
}

#[tokio::test]
async fn list_assets_composes_pages_instagram_ads_and_whatsapp() {
    let r = rig().await;
    script_listing(&r.mock);
    let user = user_cred();
    let assets = r.meta.list_assets(&user).await.unwrap();
    let listed: Vec<(&str, &str, &str)> = assets
        .iter()
        .map(|a| (a.kind_key.as_str(), a.external_id.as_str(), a.name.as_str()))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("facebook_page", "1234567890", "Test Kahve"),
            ("messenger", "1234567890", "Test Kahve"),
            ("instagram", IG, "test.kahve"),
            ("instagram_dm", IG, "test.kahve"),
            ("facebook_page", "1234567891", "Test Çay"),
            ("messenger", "1234567891", "Test Çay"),
            // Only the active ad account, by its number without act_.
            ("meta_ads", "1111111111", "Test Reklam"),
            ("whatsapp_cloud", PHONE, "Test Kahve"),
        ]
    );
    // Pages and their Instagram accounts carry the Page token; ads the user credential;
    // WhatsApp the user token with its account.
    for asset in &assets[..4] {
        assert_eq!(asset.credential, page_cred(), "{asset:?}");
    }
    assert_eq!(assets[6].credential, user);
    // The WhatsApp number carries the user's token and so its expiry (renewed like it).
    assert_eq!(assets[7].credential, {
        let Credential::OAuth {
            access_token,
            expires_at,
            ..
        } = &user
        else {
            unreachable!()
        };
        Credential::WhatsAppCloud {
            phone_number_id: PHONE.into(),
            token: access_token.clone(),
            waba_id: Some("4444444444".into()),
            expires_at: *expires_at,
        }
    });
    assert_eq!(
        assets[2].public,
        json!({ "username": "test.kahve", "page_id": PAGE, "login": "facebook" })
    );
    assert_eq!(assets[6].public["currency"], "TRY");
    assert_eq!(assets[7].public["quality_rating"], "GREEN");
    // No public fact carries a token.
    let shown = serde_json::to_string(&assets.iter().map(|a| a.public_facts()).collect::<Vec<_>>())
        .unwrap();
    assert!(!shown.contains("EAAB"), "{shown}");

    // The Instagram lookup used each page's own token.
    assert_graph_auth(&r.mock.request("GET", "/fb/v19.0/1234567890"), PAGE_TOKEN);
    assert_graph_auth(
        &r.mock.request("GET", "/fb/v19.0/1234567891"),
        "EAAB-page-1234567891",
    );
}

#[tokio::test]
async fn list_assets_skips_what_the_user_did_not_grant() {
    let r = rig().await;
    let m = &r.mock;
    m.on("GET", "/fb/v19.0/me/accounts", ok(json!({ "data": [] })));
    m.on(
        "GET",
        "/fb/v19.0/me/adaccounts",
        status(403, graph_fixture(m, "error_permission")),
    );
    m.on(
        "GET",
        "/fb/v19.0/me/businesses",
        status(403, graph_fixture(m, "error_permission")),
    );
    assert!(r.meta.list_assets(&user_cred()).await.unwrap().is_empty());

    // An expired token fails the listing instead.
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v19.0/me/accounts",
        status(400, graph_fixture(&r.mock, "error_token_expired")),
    );
    assert_eq!(kind_of(r.meta.list_assets(&user_cred()).await), "auth");
    // A Page token lists nothing.
    assert_eq!(kind_of(r.meta.list_assets(&page_cred()).await), "permanent");
}

#[tokio::test]
async fn list_assets_for_an_instagram_login_token() {
    let r = rig().await;
    r.mock
        .on("GET", "/ig/me", ok(graph_fixture(&r.mock, "ig_me")));
    let cred = ig_login_cred();
    let assets = r.meta.list_assets(&cred).await.unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].kind_key, "instagram");
    assert_eq!(assets[0].external_id, "17841400000000009");
    assert_eq!(assets[0].name, "test.studio");
    assert_eq!(assets[0].credential, cred);
    assert_eq!(
        assets[0].public,
        json!({ "username": "test.studio", "login": "instagram" })
    );
    let me = r.mock.request("GET", "/ig/me");
    assert_eq!(me.bearer(), Some(IG_LOGIN_TOKEN));
    assert_eq!(me.param("fields"), Some("user_id,username"));
}

// ---------------------------------------------------------------------------------------------
// appsecret_proof
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn appsecret_proof_present_on_every_call_including_paging() {
    let r = rig().await;
    let m = &r.mock;
    script_listing(m);
    m.on(
        "GET",
        "/fb/v19.0/act_1111111111/insights",
        ok(graph_fixture(m, "ads_insights_1")),
    );
    m.on(
        "GET",
        "/fb/v19.0/act_1111111111/insights",
        ok(graph_fixture(m, "ads_insights_2")),
    );
    r.meta.list_assets(&user_cred()).await.unwrap();
    let rows = r
        .meta
        .insights(
            &user_cred(),
            &public("meta_ads", Some("1111111111")),
            date!(2026 - 10 - 01),
            date!(2026 - 10 - 02),
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);

    let recorded = m.recorded();
    // Both paged reads followed their next link.
    assert_eq!(m.requests("GET", "/fb/v19.0/me/accounts").len(), 2);
    assert_eq!(
        m.requests("GET", "/fb/v19.0/act_1111111111/insights").len(),
        2
    );
    let graph: Vec<_> = recorded
        .iter()
        .filter(|r| r.path.starts_with("/fb/"))
        .collect();
    assert_eq!(graph.len(), recorded.len());
    for call in graph {
        let token = call
            .bearer()
            .expect("every Graph call here carries a token");
        // The token travels in the header only, with its proof (the paging link's stale proof
        // and access_token replaced).
        assert_graph_auth(call, token);
    }
    // The followed links kept their cursors.
    let second = &m.requests("GET", "/fb/v19.0/me/accounts")[1];
    assert_eq!(second.param("after"), Some("QVFTEST2"));
    let second = &m.requests("GET", "/fb/v19.0/act_1111111111/insights")[1];
    assert_eq!(second.param("after"), Some("MQZDZD"));
}

#[tokio::test]
async fn a_paging_link_to_another_origin_is_not_followed() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v19.0/me/accounts",
        ok(json!({ "data": [], "paging": { "next": "https://elsewhere.test/v19.0/me/accounts" } })),
    );
    assert_eq!(kind_of(r.meta.list_assets(&user_cred()).await), "permanent");
    assert_eq!(r.mock.recorded().len(), 1);
}

#[tokio::test]
async fn no_appsecret_proof_on_instagram_graph() {
    let r = rig().await;
    let m = &r.mock;
    m.on("GET", "/ig/me", ok(graph_fixture(m, "ig_me")));
    m.on(
        "POST",
        "/ig/17841400000000009/media",
        ok(json!({ "id": "9100000000" })),
    );
    m.on(
        "GET",
        "/ig/9100000000",
        ok(json!({ "status_code": "FINISHED", "id": "9100000000" })),
    );
    m.on(
        "POST",
        "/ig/17841400000000009/media_publish",
        ok(json!({ "id": "9200000000" })),
    );
    m.on(
        "GET",
        "/ig/9200000000",
        ok(json!({ "permalink": "https://www.instagram.com/p/TEST/" })),
    );
    m.on(
        "GET",
        "/ig/9200000000/insights",
        ok(json!({ "data": [ { "name": "reach", "values": [ { "value": 12 } ] } ] })),
    );
    let cred = ig_login_cred();
    let p = public("instagram", Some("17841400000000009"));
    assert!(r.meta.probe(&cred, &p).await.ok);
    r.meta
        .publish(
            &cred,
            &p,
            &PublishRequest {
                text: "Merhaba".into(),
                media_urls: vec![Url::parse("https://cdn.test/a.jpg").unwrap()],
                link: None,
            },
        )
        .await
        .unwrap();
    r.meta.post_metrics(&cred, &p, "9200000000").await.unwrap();
    let recorded = m.recorded();
    assert!(recorded.len() >= 6);
    for call in recorded {
        assert!(call.path.starts_with("/ig/"), "{}", call.line());
        assert_eq!(call.param("appsecret_proof"), None, "{}", call.line());
        assert_eq!(call.param("access_token"), None, "{}", call.line());
        assert_eq!(call.bearer(), Some(IG_LOGIN_TOKEN), "{}", call.line());
    }
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn error_mapping_table() {
    let r = rig().await;
    let m = &r.mock;
    let cred = page_cred();
    let fetch = || r.meta.fetch(&cred, "6666666666");
    let path = "/fb/v19.0/6666666666";
    for (reply, expected) in [
        (status(400, graph_fixture(m, "error_token_expired")), "auth"),
        (status(401, json!({})), "auth"),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "message": "m" } }),
            ),
            "auth",
        ),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "code": 100, "error_subcode": 458 } }),
            ),
            "auth",
        ),
        (
            status(403, graph_fixture(m, "error_permission")),
            "permission",
        ),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "code": 10 } }),
            ),
            "permission",
        ),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "code": 3 } }),
            ),
            "permission",
        ),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "code": 803 } }),
            ),
            "permission",
        ),
        (status(400, graph_fixture(m, "error_throttle")), "throttle"),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "code": 17 } }),
            ),
            "throttle",
        ),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "code": 32 } }),
            ),
            "throttle",
        ),
        (
            status(
                400,
                json!({ "error": { "type": "OAuthException", "code": 613 } }),
            ),
            "throttle",
        ),
        (status(500, graph_fixture(m, "error_unknown")), "transient"),
        (raw(502, "<html>Bad gateway</html>"), "transient"),
        (raw(503, ""), "transient"),
        (raw(400, "<html>nope</html>"), "permanent"),
        (raw(200, "not json"), "permanent"),
        (
            status(400, graph_fixture(m, "error_invalid_parameter")),
            "permanent",
        ),
        (status(404, json!({})), "permanent"),
        (
            ok(json!({ "error": { "type": "OAuthException", "code": 190 } })),
            "auth",
        ),
    ] {
        m.set("GET", path, reply.clone());
        let got = kind_of(fetch().await);
        assert_eq!(got, expected, "{} {}", reply.status, reply.body);
    }

    // A reason names the Graph error and never holds a token or the app secret.
    m.set(
        "GET",
        path,
        status(
            400,
            json!({ "error": {
                "message": format!("Bad token access_token={PAGE_TOKEN} proof"),
                "type": "OAuthException", "code": 190, "error_subcode": 460,
            }}),
        ),
    );
    let e = fetch().await.unwrap_err();
    let reason = e.reason().unwrap();
    assert!(
        reason.starts_with("HTTP 400 OAuthException (#190/460): "),
        "{reason}"
    );
    assert!(!reason.contains(PAGE_TOKEN), "{reason}");

    // A transport failure (nothing listening) is transient.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = closed.local_addr().unwrap();
    drop(closed);
    let egress = Arc::new(
        jt_outbound::Egress::new(FIXED_HOSTS).with_test_hosts([("meta", addr.to_string())]),
    );
    let dead = MetaConnector::new(
        egress,
        MetaBases {
            graph: Url::parse(&format!("http://{addr}/fb")).unwrap(),
            ..MetaBases::production()
        },
        Arc::new(TestApps::default()),
    );
    assert_eq!(
        kind_of(dead.fetch(&page_cred(), "6666666666").await),
        "transient"
    );
    // A host outside the meta tier is refused without a call, as a permanent error.
    let elsewhere = MetaConnector::new(
        egress_only_fixed(),
        bases(&r.mock),
        Arc::new(TestApps::default()),
    );
    assert_eq!(
        kind_of(elsewhere.fetch(&page_cred(), "6666666666").await),
        "permanent"
    );
}

/// The production fixed tier alone: the mock is not allowed.
fn egress_only_fixed() -> Arc<jt_outbound::Egress> {
    Arc::new(jt_outbound::Egress::new(FIXED_HOSTS))
}

#[tokio::test]
async fn throttle_carries_retry_after() {
    let r = rig().await;
    let m = &r.mock;
    let path = "/fb/v19.0/6666666666";
    let wait = |e: ConnectorError| match e {
        ConnectorError::Throttle { retry_after } => retry_after,
        other => panic!("expected a throttle, got {other:?}"),
    };
    m.set(
        "GET",
        path,
        status(400, graph_fixture(m, "error_throttle")).with_header("retry-after", "120"),
    );
    let e = r.meta.fetch(&page_cred(), "6666666666").await.unwrap_err();
    assert_eq!(wait(e), Some(Duration::seconds(120)));

    m.set(
        "GET",
        path,
        status(400, json!({ "error": { "code": 32, "type": "OAuthException" } })).with_header(
            "x-business-use-case-usage",
            r#"{"1234567890":[{"type":"pages","call_count":100,"total_cputime":10,"total_time":10,"estimated_time_to_regain_access":5}]}"#,
        ),
    );
    let e = r.meta.fetch(&page_cred(), "6666666666").await.unwrap_err();
    assert_eq!(wait(e), Some(Duration::minutes(5)));

    m.set("GET", path, status(429, json!({})));
    let e = r.meta.fetch(&page_cred(), "6666666666").await.unwrap_err();
    assert_eq!(wait(e), None);
}

#[tokio::test]
async fn graph_version_and_secret_come_from_the_meta_app_at_call_time() {
    let mut apps = TestApps::default();
    apps.meta.as_mut().unwrap().graph_version = Some("v21.0".into());
    let r = rig_with(apps).await;
    r.mock.on(
        "GET",
        "/fb/v21.0/6666666666",
        ok(graph_fixture(&r.mock, "leadgen")),
    );
    r.meta.fetch(&page_cred(), "6666666666").await.unwrap();
    assert_graph_auth(&r.mock.request("GET", "/fb/v21.0/6666666666"), PAGE_TOKEN);

    // Without a Meta app, no Graph call is made; an Instagram Login token still works.
    let r = rig_with(TestApps {
        meta: None,
        ..TestApps::default()
    })
    .await;
    assert_eq!(
        kind_of(r.meta.fetch(&page_cred(), "6666666666").await),
        "permanent"
    );
    let probe = r
        .meta
        .probe(&page_cred(), &public("facebook_page", None))
        .await;
    assert_eq!(probe.error.unwrap().kind(), "permanent");
    assert!(r.mock.recorded().is_empty());
    r.mock
        .on("GET", "/ig/me", ok(graph_fixture(&r.mock, "ig_me")));
    assert!(
        r.meta
            .probe(&ig_login_cred(), &public("instagram", None))
            .await
            .ok
    );
    // A NetGSM credential is never sent anywhere.
    let netgsm = Credential::NetgsmSms {
        usercode: "8500000000".into(),
        password: "pw-test".into(),
        msgheader: "TEST".into(),
    };
    let probe = r.meta.probe(&netgsm, &public("facebook_page", None)).await;
    assert_eq!(probe.error.unwrap().kind(), "permanent");
    assert_eq!(r.mock.recorded().len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Probes and the connection step
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn probe_returns_account_id_per_kind() {
    let r = rig().await;
    let m = &r.mock;
    // A Page token reads itself as /me, whatever the credential says its page is.
    m.on(
        "GET",
        "/fb/v19.0/me",
        ok(json!({ "id": PAGE, "name": "Test Kahve" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/me/subscribed_apps",
        ok(json!({ "data": [ { "id": META_APP_ID, "name": "Jeeta", "subscribed_fields": ["messages"] } ] })),
    );
    let lying = Credential::PageToken {
        page_id: "9999999999".into(),
        token: PAGE_TOKEN.into(),
    };
    for kind in ["facebook_page", "messenger"] {
        let p = r
            .meta
            .probe(&lying, &public(kind, Some("9999999999")))
            .await;
        assert!(p.ok, "{p:?}");
        assert_eq!(
            p.facts,
            json!({ "account_id": PAGE, "name": "Test Kahve", "subscribed": true }),
            "{kind}"
        );
    }
    for read in m.requests("GET", "/fb/v19.0/me") {
        assert_eq!(read.param("fields"), Some("id,name"));
        assert_graph_auth(&read, PAGE_TOKEN);
    }

    // Instagram through the page: the account linked to the token's own page.
    let r2 = rig().await;
    r2.mock.on(
        "GET",
        "/fb/v19.0/me",
        ok(json!({ "id": PAGE, "instagram_business_account": { "id": IG, "username": "test.kahve" } })),
    );
    for kind in ["instagram", "instagram_dm"] {
        let p = r2.meta.probe(&page_cred(), &public(kind, Some(IG))).await;
        assert_eq!(
            p.facts,
            json!({ "account_id": IG, "username": "test.kahve", "page_id": PAGE }),
            "{kind}"
        );
    }
    assert_eq!(
        r2.mock.requests("GET", "/fb/v19.0/me")[0].param("fields"),
        Some("id,instagram_business_account{id,username}")
    );

    // An Instagram Login token: its own account on graph.instagram.com.
    r2.mock
        .on("GET", "/ig/me", ok(graph_fixture(&r2.mock, "ig_me")));
    let p = r2
        .meta
        .probe(&ig_login_cred(), &public("instagram", None))
        .await;
    assert_eq!(
        p.facts,
        json!({ "account_id": "17841400000000009", "username": "test.studio" })
    );

    // WhatsApp: the number as Graph names it, read with its token.
    r2.mock.on(
        "GET",
        "/fb/v19.0/5555555555",
        ok(json!({ "id": PHONE, "verified_name": "Test Kahve", "quality_rating": "GREEN", "display_phone_number": "+90 555 000 00 00" })),
    );
    let p = r2
        .meta
        .probe(&wa_cred(None), &public("whatsapp_cloud", Some(PHONE)))
        .await;
    assert_eq!(p.facts["account_id"], PHONE);
    assert_eq!(p.facts["quality_rating"], "GREEN");
    let read = r2.mock.request("GET", "/fb/v19.0/5555555555");
    assert_graph_auth(&read, WA_TOKEN);
    assert_eq!(
        read.param("fields"),
        Some("id,verified_name,quality_rating,display_phone_number")
    );

    // Meta Ads: the ad account's number without act_, by the act_ node.
    r2.mock.on(
        "GET",
        "/fb/v19.0/act_1111111111",
        ok(json!({ "id": "act_1111111111", "account_id": "1111111111", "name": "Test Reklam", "account_status": 1, "currency": "TRY" })),
    );
    let p = r2
        .meta
        .probe(&user_cred(), &public("meta_ads", Some("act_1111111111")))
        .await;
    assert_eq!(
        p.facts,
        json!({ "account_id": "1111111111", "name": "Test Reklam", "account_status": 1, "currency": "TRY" })
    );
    // Without an account named, the token's only active ad account.
    r2.mock.on(
        "GET",
        "/fb/v19.0/me/adaccounts",
        ok(graph_fixture(&r2.mock, "me_adaccounts")),
    );
    let p = r2.meta.probe(&user_cred(), &public("meta_ads", None)).await;
    assert_eq!(p.facts["account_id"], "1111111111");

    // A plain user token: the user, as /me says.
    let r3 = rig().await;
    r3.mock.on(
        "GET",
        "/fb/v19.0/me",
        ok(json!({ "id": "1010101010", "name": "Test Kullanıcı" })),
    );
    r3.mock.on(
        "GET",
        "/fb/v19.0/me/subscribed_apps",
        status(400, graph_fixture(&r3.mock, "error_invalid_parameter")),
    );
    let p = r3
        .meta
        .probe(&user_cred(), &public("review_facebook", None))
        .await;
    assert_eq!(
        p.facts,
        json!({ "account_id": "1010101010", "name": "Test Kullanıcı" })
    );
    // A page probe whose subscription list cannot be read still succeeds, without the fact.
    let p = r3
        .meta
        .probe(&user_cred(), &public("messenger", None))
        .await;
    assert!(p.ok);
    assert!(p.facts.get("subscribed").is_none(), "{}", p.facts);
}

#[tokio::test]
async fn probe_failures_are_results() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "GET",
        "/fb/v19.0/me",
        status(400, graph_fixture(m, "error_token_expired")),
    );
    let p = r
        .meta
        .probe(&page_cred(), &public("facebook_page", Some(PAGE)))
        .await;
    assert!(!p.ok);
    assert_eq!(p.error.as_ref().unwrap().kind(), "auth");
    assert_eq!(p.facts, json!({}));

    // A page with no linked Instagram account cannot be an Instagram capability.
    let r = rig().await;
    r.mock.on("GET", "/fb/v19.0/me", ok(json!({ "id": PAGE })));
    let p = r
        .meta
        .probe(&page_cred(), &public("instagram", Some(IG)))
        .await;
    assert_eq!(p.error.unwrap().kind(), "permanent");
    // Two ad accounts and none named: the probe cannot choose.
    r.mock.on(
        "GET",
        "/fb/v19.0/me/adaccounts",
        ok(json!({ "data": [
            { "account_id": "1", "account_status": 1 }, { "account_id": "2", "account_status": 1 }
        ]})),
    );
    let p = r.meta.probe(&user_cred(), &public("meta_ads", None)).await;
    assert_eq!(p.error.unwrap().kind(), "permanent");
}

#[tokio::test]
async fn on_connected_subscribes_page_fields() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/fb/v19.0/1234567890/subscribed_apps",
        ok(json!({ "success": true })),
    );
    for kind in ["facebook_page", "messenger", "instagram_dm"] {
        let facts = r
            .meta
            .on_connected(&page_cred(), &public(kind, Some(PAGE)))
            .await
            .unwrap();
        assert_eq!(facts, json!({ "subscribed": true }), "{kind}");
    }
    let calls = m.requests("POST", "/fb/v19.0/1234567890/subscribed_apps");
    assert_eq!(calls.len(), 3);
    for call in &calls {
        assert_eq!(
            call.param("subscribed_fields"),
            Some(PAGE_SUBSCRIBED_FIELDS)
        );
        assert_graph_auth(call, PAGE_TOKEN);
    }
    assert_eq!(
        PAGE_SUBSCRIBED_FIELDS,
        "messages,message_echoes,messaging_postbacks,message_reactions,leadgen"
    );
    // Kinds without a connection step do nothing.
    m.clear();
    for (cred, kind) in [
        (page_cred(), "instagram"),
        (user_cred(), "meta_ads"),
        (ig_login_cred(), "instagram"),
    ] {
        assert_eq!(
            r.meta
                .on_connected(&cred, &public(kind, None))
                .await
                .unwrap(),
            Value::Null
        );
    }
    assert!(m.recorded().is_empty());
    // A refused subscription is the error (the use case records it, never fatal).
    m.set(
        "POST",
        "/fb/v19.0/1234567890/subscribed_apps",
        status(403, graph_fixture(m, "error_permission")),
    );
    let e = r
        .meta
        .on_connected(&page_cred(), &public("messenger", Some(PAGE)))
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permission");
}

#[tokio::test]
async fn on_connected_subscribes_and_registers_whatsapp_best_effort() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/fb/v19.0/4444444444/subscribed_apps",
        ok(json!({ "success": true })),
    );
    m.on(
        "POST",
        "/fb/v19.0/5555555555/register",
        ok(json!({ "success": true })),
    );
    let facts = r
        .meta
        .on_connected(
            &wa_cred(Some("4444444444")),
            &public("whatsapp_cloud", Some(PHONE)),
        )
        .await
        .unwrap();
    assert_eq!(facts, json!({ "subscribed": true, "registered": true }));
    let register = m.request("POST", "/fb/v19.0/5555555555/register");
    assert_eq!(
        register.json(),
        json!({ "messaging_product": "whatsapp", "pin": "000000" })
    );
    assert_graph_auth(&register, WA_TOKEN);
    assert_graph_auth(
        &m.request("POST", "/fb/v19.0/4444444444/subscribed_apps"),
        WA_TOKEN,
    );

    // Without the account's id there is nothing to subscribe; a refused registration is a fact.
    let r = rig().await;
    r.mock.on(
        "POST",
        "/fb/v19.0/5555555555/register",
        status(400, json!({ "error": { "code": 133_005, "type": "OAuthException", "message": "pin mismatch" } })),
    );
    let facts = r
        .meta
        .on_connected(&wa_cred(None), &public("whatsapp_cloud", Some(PHONE)))
        .await
        .unwrap();
    assert_eq!(facts, json!({ "subscribed": false, "registered": false }));
    assert_eq!(r.mock.recorded().len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

fn post(text: &str, media: &[&str], link: Option<&str>) -> PublishRequest {
    PublishRequest {
        text: text.into(),
        media_urls: media.iter().map(|m| Url::parse(m).unwrap()).collect(),
        link: link.map(|l| Url::parse(l).unwrap()),
    }
}

#[tokio::test]
async fn facebook_publish_feed_photos_and_video() {
    let r = rig().await;
    let m = &r.mock;
    let p = public("facebook_page", Some(PAGE));
    // Text and link: the feed.
    m.on(
        "POST",
        "/fb/v19.0/1234567890/feed",
        ok(json!({ "id": "1234567890_111" })),
    );
    let receipt = r
        .meta
        .publish(
            &page_cred(),
            &p,
            &post("Merhaba", &[], Some("https://kahve.test/menu")),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, "1234567890_111");
    assert_eq!(
        receipt.url.unwrap().as_str(),
        "https://www.facebook.com/1234567890_111"
    );
    let feed = m.request("POST", "/fb/v19.0/1234567890/feed");
    assert_eq!(
        feed.json(),
        json!({ "message": "Merhaba", "link": "https://kahve.test/menu" })
    );
    assert_graph_auth(&feed, PAGE_TOKEN);
    m.clear();

    // One image: a photo post.
    m.on(
        "POST",
        "/fb/v19.0/1234567890/photos",
        ok(json!({ "id": "222", "post_id": "1234567890_222" })),
    );
    let receipt = r
        .meta
        .publish(
            &page_cred(),
            &p,
            &post("Foto", &["https://cdn.test/a.jpg"], None),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, "1234567890_222");
    assert_eq!(
        m.request("POST", "/fb/v19.0/1234567890/photos").json(),
        json!({ "url": "https://cdn.test/a.jpg", "caption": "Foto" })
    );
    m.clear();

    // Several images: unpublished photos, then one feed post attaching them.
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/fb/v19.0/1234567890/photos",
        ok(json!({ "id": "301" })),
    );
    m.on(
        "POST",
        "/fb/v19.0/1234567890/photos",
        ok(json!({ "id": "302" })),
    );
    m.on(
        "POST",
        "/fb/v19.0/1234567890/feed",
        ok(json!({ "id": "1234567890_303" })),
    );
    let receipt = r
        .meta
        .publish(
            &page_cred(),
            &p,
            &post(
                "Albüm",
                &["https://cdn.test/a.jpg", "https://cdn.test/b.png"],
                Some("https://kahve.test"),
            ),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, "1234567890_303");
    let photos = m.requests("POST", "/fb/v19.0/1234567890/photos");
    assert_eq!(
        photos.iter().map(Recorded::json).collect::<Vec<_>>(),
        vec![
            json!({ "url": "https://cdn.test/a.jpg", "published": false }),
            json!({ "url": "https://cdn.test/b.png", "published": false }),
        ]
    );
    assert_eq!(
        m.request("POST", "/fb/v19.0/1234567890/feed").json(),
        json!({
            "message": "Albüm\n\nhttps://kahve.test/",
            "attached_media": [ { "media_fbid": "301" }, { "media_fbid": "302" } ],
        })
    );

    // A video: Meta fetches the file.
    m.on(
        "POST",
        "/fb/v19.0/1234567890/videos",
        ok(json!({ "id": "404" })),
    );
    let receipt = r
        .meta
        .publish(
            &page_cred(),
            &p,
            &post("Video", &["https://cdn.test/v.MP4"], None),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, "404");
    assert_eq!(
        m.request("POST", "/fb/v19.0/1234567890/videos").json(),
        json!({ "file_url": "https://cdn.test/v.MP4", "description": "Video" })
    );

    // A video with anything else, more than ten media, another kind: refused without a call.
    m.clear();
    for (request, kind) in [
        (
            post(
                "x",
                &["https://cdn.test/v.mp4", "https://cdn.test/a.jpg"],
                None,
            ),
            "facebook_page",
        ),
        (
            post("x", &["https://cdn.test/a.jpg"; 11], None),
            "facebook_page",
        ),
        (post("x", &[], None), "meta_ads"),
    ] {
        assert_eq!(
            kind_of(
                r.meta
                    .publish(&page_cred(), &public(kind, Some(PAGE)), &request)
                    .await
            ),
            "permanent"
        );
    }
    assert!(m.recorded().is_empty());
}

#[tokio::test]
async fn ig_publish_polls_until_finished_and_gives_up_after_limit() {
    let r = rig().await;
    let m = &r.mock;
    let p = public("instagram", Some(IG));
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "500" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/500",
        ok(json!({ "status_code": "IN_PROGRESS" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/500",
        ok(json!({ "status_code": "IN_PROGRESS" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/500",
        ok(json!({ "status_code": "FINISHED" })),
    );
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media_publish",
        ok(json!({ "id": "600" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/600",
        ok(json!({ "permalink": "https://www.instagram.com/p/TEST600/", "id": "600" })),
    );
    let receipt = r
        .meta
        .publish(
            &page_cred(),
            &p,
            &post(
                "Yeni reel",
                &["https://cdn.test/reel.mov"],
                Some("https://kahve.test"),
            ),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, "600");
    assert_eq!(
        receipt.url.unwrap().as_str(),
        "https://www.instagram.com/p/TEST600/"
    );
    assert_eq!(
        m.request("POST", "/fb/v19.0/17841400000000001/media")
            .json(),
        json!({
            "media_type": "REELS",
            "video_url": "https://cdn.test/reel.mov",
            "caption": "Yeni reel\n\nhttps://kahve.test/",
        })
    );
    let reads = m.requests("GET", "/fb/v19.0/500");
    assert_eq!(reads.len(), 3, "read until FINISHED, then no more");
    assert_eq!(reads[0].param("fields"), Some("status_code,status"));
    for read in &reads {
        assert_graph_auth(read, PAGE_TOKEN);
    }
    assert_eq!(
        m.request("POST", "/fb/v19.0/17841400000000001/media_publish")
            .json(),
        json!({ "creation_id": "500" })
    );

    // Never finishing: exactly the configured number of reads, then a transient failure and no
    // publish.
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "501" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/501",
        ok(json!({ "status_code": "IN_PROGRESS" })),
    );
    let e = r
        .meta
        .publish(
            &page_cred(),
            &p,
            &post("x", &["https://cdn.test/a.jpg"], None),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "transient");
    assert_eq!(m.requests("GET", "/fb/v19.0/501").len(), 30);
    assert!(
        m.requests("POST", "/fb/v19.0/17841400000000001/media_publish")
            .is_empty()
    );

    // A container in error: permanent, at once.
    m.set(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "502" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/502",
        ok(json!({ "status_code": "ERROR", "status": "Error: unsupported image" })),
    );
    let e = r
        .meta
        .publish(
            &page_cred(),
            &p,
            &post("x", &["https://cdn.test/a.jpg"], None),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(e.reason().unwrap().contains("unsupported image"));
    assert_eq!(m.requests("GET", "/fb/v19.0/502").len(), 1);

    // The pause between reads is the configured interval.
    let r = rig().await;
    let paced = MetaConnector::new(
        egress(&r.mock),
        bases(&r.mock),
        Arc::new(TestApps::default()),
    )
    .with_container_poll(ContainerPoll {
        interval: StdDuration::from_millis(40),
        attempts: 3,
    });
    r.mock.on(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "503" })),
    );
    r.mock.on(
        "GET",
        "/fb/v19.0/503",
        ok(json!({ "status_code": "IN_PROGRESS" })),
    );
    let started = std::time::Instant::now();
    let e = paced
        .publish(
            &page_cred(),
            &p,
            &post("x", &["https://cdn.test/a.jpg"], None),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "transient");
    assert_eq!(r.mock.requests("GET", "/fb/v19.0/503").len(), 3);
    assert!(
        started.elapsed() >= StdDuration::from_millis(80),
        "two pauses"
    );
}

#[tokio::test]
async fn ig_carousels_and_the_linked_account() {
    let r = rig().await;
    let m = &r.mock;
    // No account named: the page's linked one.
    m.on(
        "GET",
        "/fb/v19.0/me",
        ok(json!({ "instagram_business_account": { "id": IG }, "id": PAGE })),
    );
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "701" })),
    );
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "702" })),
    );
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "703" })),
    );
    for id in ["701", "702", "703"] {
        m.on(
            "GET",
            &format!("/fb/v19.0/{id}"),
            ok(json!({ "status_code": "FINISHED" })),
        );
    }
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media_publish",
        ok(json!({ "id": "704" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/704",
        status(400, graph_fixture(m, "error_invalid_parameter")),
    );
    let receipt = r
        .meta
        .publish(
            &page_cred(),
            &public("instagram", None),
            &post(
                "Karusel",
                &["https://cdn.test/a.jpg", "https://cdn.test/b.mp4"],
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, "704");
    assert_eq!(receipt.url, None, "the permalink is best effort");
    let created: Vec<Value> = m
        .requests("POST", "/fb/v19.0/17841400000000001/media")
        .iter()
        .map(Recorded::json)
        .collect();
    assert_eq!(
        created,
        vec![
            json!({ "image_url": "https://cdn.test/a.jpg", "is_carousel_item": true }),
            json!({ "media_type": "VIDEO", "video_url": "https://cdn.test/b.mp4", "is_carousel_item": true }),
            json!({ "media_type": "CAROUSEL", "children": "701,702", "caption": "Karusel" }),
        ]
    );
    // An Instagram post needs media.
    assert_eq!(
        kind_of(
            r.meta
                .publish(
                    &page_cred(),
                    &public("instagram", Some(IG)),
                    &post("x", &[], None)
                )
                .await
        ),
        "permanent"
    );
}

#[tokio::test]
async fn ig_login_publish_goes_to_instagram_graph() {
    let r = rig().await;
    let m = &r.mock;
    m.on("POST", "/ig/me/media", ok(json!({ "id": "801" })));
    m.on("GET", "/ig/801", ok(json!({ "status_code": "FINISHED" })));
    m.on("POST", "/ig/me/media_publish", ok(json!({ "id": "802" })));
    m.on(
        "GET",
        "/ig/802",
        ok(json!({ "permalink": "https://www.instagram.com/p/TEST802/" })),
    );
    let receipt = r
        .meta
        .publish(
            &ig_login_cred(),
            &public("instagram", None),
            &post("Merhaba", &["https://cdn.test/a.jpg"], None),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, "802");
    assert_eq!(
        m.request("POST", "/ig/me/media").json(),
        json!({ "image_url": "https://cdn.test/a.jpg", "caption": "Merhaba" })
    );
    assert!(m.recorded().iter().all(|c| c.path.starts_with("/ig/")));
}

// ---------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn insights_read_post_and_account_counters() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "GET",
        "/fb/v19.0/1234567890_111/insights",
        ok(json!({ "data": [
            { "name": "post_impressions_unique", "period": "lifetime", "values": [ { "value": 1500 } ] },
            { "name": "post_reactions_like_total", "values": [ { "value": 42 } ] },
            { "name": "post_clicks", "values": [ { "value": { "link clicks": 3 } } ] },
        ]})),
    );
    let metrics = r
        .meta
        .post_metrics(
            &page_cred(),
            &public("facebook_page", Some(PAGE)),
            "1234567890_111",
        )
        .await
        .unwrap();
    assert_eq!(
        metrics.metrics.into_iter().collect::<Vec<_>>(),
        vec![
            ("post_impressions_unique".to_owned(), 1500),
            ("post_reactions_like_total".to_owned(), 42),
        ]
    );
    let read = m.request("GET", "/fb/v19.0/1234567890_111/insights");
    assert_eq!(
        read.param("metric"),
        Some("post_impressions_unique,post_reactions_like_total,post_clicks")
    );

    m.on(
        "GET",
        "/fb/v19.0/1234567890",
        ok(json!({ "followers_count": 900, "fan_count": "850", "id": PAGE })),
    );
    let account = r
        .meta
        .account_metrics(&page_cred(), &public("facebook_page", Some(PAGE)))
        .await
        .unwrap();
    assert_eq!(account.metrics["followers_count"], 900);
    assert_eq!(account.metrics["fan_count"], 850);

    m.on(
        "GET",
        "/fb/v19.0/17841400000000001",
        ok(json!({ "followers_count": 300, "follows_count": 20, "media_count": 41 })),
    );
    let ig = r
        .meta
        .account_metrics(&page_cred(), &public("instagram", Some(IG)))
        .await
        .unwrap();
    assert_eq!(ig.metrics.len(), 3);
    m.on(
        "GET",
        "/fb/v19.0/17900000000000001/insights",
        ok(json!({ "data": [ { "name": "reach", "values": [ { "value": 77 } ] }, { "name": "likes", "total_value": { "value": 5 } } ] })),
    );
    let media = r
        .meta
        .post_metrics(
            &page_cred(),
            &public("instagram", Some(IG)),
            "17900000000000001",
        )
        .await
        .unwrap();
    assert_eq!(media.metrics["reach"], 77);
    assert_eq!(media.metrics["likes"], 5);
    assert_eq!(
        m.request("GET", "/fb/v19.0/17900000000000001/insights")
            .param("metric"),
        Some("reach,likes,comments,saved,shares,total_interactions")
    );
}

// ---------------------------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn messenger_send_body() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/fb/v19.0/me/messages",
        ok(json!({ "recipient_id": "2000000000000001", "message_id": "m_TEST-SENT-1" })),
    );
    for kind in ["messenger", "instagram_dm"] {
        let receipt = r
            .meta
            .send_text(
                &page_cred(),
                &public(kind, Some(PAGE)),
                "2000000000000001",
                "Merhaba!",
            )
            .await
            .unwrap();
        assert_eq!(receipt.provider_id, "m_TEST-SENT-1");
    }
    let sent = m.requests("POST", "/fb/v19.0/me/messages");
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent[0].json(),
        json!({
            "recipient": { "id": "2000000000000001" },
            "messaging_type": "RESPONSE",
            "message": { "text": "Merhaba!" },
        })
    );
    assert_graph_auth(&sent[0], PAGE_TOKEN);
    // Nothing to send, an empty recipient, too long a text, another kind: refused, no call.
    m.clear();
    let long = "a".repeat(2001);
    for (to, text, kind) in [
        ("1", " ", "messenger"),
        ("", "x", "messenger"),
        ("1", long.as_str(), "messenger"),
        ("1", "x", "meta_ads"),
    ] {
        assert_eq!(
            kind_of(
                r.meta
                    .send_text(&page_cred(), &public(kind, None), to, text)
                    .await
            ),
            "permanent"
        );
    }
    assert!(m.recorded().is_empty());
}

#[tokio::test]
async fn whatsapp_send_body() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/fb/v19.0/5555555555/messages",
        ok(json!({
            "messaging_product": "whatsapp",
            "contacts": [ { "input": "905551111111", "wa_id": "905551111111" } ],
            "messages": [ { "id": "wamid.TEST-SENT-9" } ],
        })),
    );
    let receipt = r
        .meta
        .send_text(
            &wa_cred(Some("4444444444")),
            &public("whatsapp_cloud", Some(PHONE)),
            "905551111111",
            "Siparişiniz hazır",
        )
        .await
        .unwrap();
    assert_eq!(receipt.provider_id, "wamid.TEST-SENT-9");
    let sent = m.request("POST", "/fb/v19.0/5555555555/messages");
    assert_eq!(
        sent.json(),
        json!({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": "905551111111",
            "type": "text",
            "text": { "preview_url": false, "body": "Siparişiniz hazır" },
        })
    );
    assert_graph_auth(&sent, WA_TOKEN);
    // A refusal maps like any other Graph error.
    m.set(
        "POST",
        "/fb/v19.0/5555555555/messages",
        status(400, json!({ "error": { "code": 131_056, "type": "OAuthException", "message": "pair rate limit" } })),
    );
    assert_eq!(
        kind_of(
            r.meta
                .send_text(
                    &wa_cred(None),
                    &public("whatsapp_cloud", Some(PHONE)),
                    "1",
                    "x"
                )
                .await
        ),
        "throttle"
    );
}

// ---------------------------------------------------------------------------------------------
// Lead-gen and ads
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn leadgen_fetch_reads_every_field() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v19.0/6666666666",
        ok(graph_fixture(&r.mock, "leadgen")),
    );
    let lead = r.meta.fetch(&page_cred(), "6666666666").await.unwrap();
    assert_eq!(lead.leadgen_id, "6666666666");
    assert_eq!(lead.form_id.as_deref(), Some("7777777777"));
    assert_eq!(lead.ad_id.as_deref(), Some("8888888888"));
    assert_eq!(lead.campaign_id.as_deref(), Some("1212121212"));
    assert_eq!(lead.campaign_name.as_deref(), Some("Test Kampanya"));
    assert_eq!(
        lead.created_time,
        Some(time::macros::datetime!(2026-10-01 12:00:00 UTC))
    );
    assert_eq!(lead.fields["email"], vec!["test@example.com".to_owned()]);
    assert_eq!(
        lead.fields["interests"],
        vec!["kahve".to_owned(), "çay".to_owned()]
    );
    let read = r.mock.request("GET", "/fb/v19.0/6666666666");
    assert_eq!(
        read.param("fields"),
        Some("field_data,form_id,ad_id,campaign_id,campaign_name,created_time")
    );
    assert_graph_auth(&read, PAGE_TOKEN);
    // An id that would change the path is refused before any call.
    assert_eq!(
        kind_of(r.meta.fetch(&page_cred(), "../me").await),
        "permanent"
    );
    assert_eq!(r.mock.recorded().len(), 1);
}

#[tokio::test]
async fn ads_adsets_budgets_and_insights_follow_paging() {
    let r = rig().await;
    let m = &r.mock;
    let p = public("meta_ads", Some("1111111111"));
    m.on(
        "GET",
        "/fb/v19.0/act_1111111111/adsets",
        ok(graph_fixture(m, "adsets")),
    );
    let sets = r.meta.list_adsets(&user_cred(), &p).await.unwrap();
    assert_eq!(sets.len(), 2);
    assert_eq!(sets[0].id, "1313131313");
    assert_eq!(sets[0].status, "ACTIVE");
    assert_eq!(sets[0].campaign_id.as_deref(), Some("1212121212"));
    assert_eq!(sets[0].daily_budget_minor, Some(15_000));
    assert_eq!(sets[0].lifetime_budget_minor, None, "0 reads as none");
    assert_eq!(sets[1].lifetime_budget_minor, Some(500_000));
    assert_eq!(
        m.request("GET", "/fb/v19.0/act_1111111111/adsets")
            .param("fields"),
        Some("id,name,status,campaign_id,daily_budget,lifetime_budget")
    );

    m.on(
        "POST",
        "/fb/v19.0/1313131313",
        ok(json!({ "success": true })),
    );
    r.meta
        .set_daily_budget(&user_cred(), "1313131313", 25_000)
        .await
        .unwrap();
    let write = m.request("POST", "/fb/v19.0/1313131313");
    assert_eq!(write.json(), json!({ "daily_budget": 25_000 }));
    assert_graph_auth(&write, USER_TOKEN);
    assert_eq!(
        kind_of(r.meta.set_daily_budget(&user_cred(), "1313131313", 0).await),
        "permanent"
    );
    assert_eq!(
        kind_of(r.meta.set_daily_budget(&page_cred(), "1313131313", 1).await),
        "permanent"
    );

    m.on(
        "GET",
        "/fb/v19.0/act_1111111111/insights",
        ok(graph_fixture(m, "ads_insights_1")),
    );
    m.on(
        "GET",
        "/fb/v19.0/act_1111111111/insights",
        ok(graph_fixture(m, "ads_insights_2")),
    );
    let rows = r
        .meta
        .insights(
            &user_cred(),
            &p,
            date!(2026 - 10 - 01),
            date!(2026 - 10 - 02),
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].date, date!(2026 - 10 - 01));
    assert_eq!(rows[0].spend_minor, 12_345);
    assert_eq!(rows[0].impressions, 10_000);
    assert_eq!(rows[0].clicks, 250);
    assert_eq!(rows[1].spend_minor, 700);
    let first = &m.requests("GET", "/fb/v19.0/act_1111111111/insights")[0];
    assert_eq!(first.param("level"), Some("campaign"));
    assert_eq!(first.param("time_increment"), Some("1"));
    assert_eq!(first.param("limit"), Some("500"));
    assert_eq!(
        first.param("time_range"),
        Some(r#"{"since":"2026-10-01","until":"2026-10-02"}"#)
    );
    // No ad account named, or a range backwards: refused without a call.
    m.clear();
    assert_eq!(
        kind_of(
            r.meta
                .list_adsets(&user_cred(), &public("meta_ads", None))
                .await
        ),
        "permanent"
    );
    assert_eq!(
        kind_of(
            r.meta
                .insights(
                    &user_cred(),
                    &p,
                    date!(2026 - 10 - 02),
                    date!(2026 - 10 - 01)
                )
                .await
        ),
        "permanent"
    );
    assert!(m.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn refresh_renews_only_expiring_tokens() {
    let r = rig().await;
    let m = &r.mock;
    let soon = Some(OffsetDateTime::now_utc() + Duration::days(3));

    // An expiring Instagram Login token: refresh_access_token, its token in the query.
    m.on(
        "GET",
        "/ig/refresh_access_token",
        ok(json!({ "access_token": "IGAA-refreshed-test", "token_type": "bearer", "expires_in": 5183944 })),
    );
    let ig = Credential::OAuth {
        access_token: IG_LOGIN_TOKEN.into(),
        refresh_token: None,
        expires_at: soon,
        scopes: vec!["instagram_business_basic".into()],
    };
    let renewed = r.meta.refresh(&ig).await.unwrap().unwrap();
    let Credential::OAuth {
        access_token,
        expires_at,
        scopes,
        ..
    } = &renewed
    else {
        panic!("{renewed:?}");
    };
    assert_eq!(access_token, "IGAA-refreshed-test");
    assert!(expires_at.unwrap() > OffsetDateTime::now_utc() + Duration::days(59));
    assert_eq!(scopes, &vec!["instagram_business_basic".to_owned()]);
    let call = m.request("GET", "/ig/refresh_access_token");
    assert_eq!(call.param("grant_type"), Some("ig_refresh_token"));
    assert_eq!(call.param("access_token"), Some(IG_LOGIN_TOKEN));

    // An expiring Facebook user token: fb_exchange_token with the platform app.
    m.on(
        "GET",
        "/fb/v19.0/oauth/access_token",
        ok(json!({ "access_token": "EAAB-renewed-test", "expires_in": 5183944 })),
    );
    let fb = Credential::OAuth {
        access_token: USER_TOKEN.into(),
        refresh_token: None,
        expires_at: soon,
        scopes: vec!["ads_read".into()],
    };
    let renewed = r.meta.refresh(&fb).await.unwrap().unwrap();
    assert!(
        matches!(&renewed, Credential::OAuth { access_token, .. } if access_token == "EAAB-renewed-test")
    );
    let call = m.request("GET", "/fb/v19.0/oauth/access_token");
    assert_eq!(call.param("grant_type"), Some("fb_exchange_token"));
    assert_eq!(call.param("fb_exchange_token"), Some(USER_TOKEN));
    assert_eq!(call.param("client_id"), Some(META_APP_ID));

    // A WhatsApp token from a Facebook Login user, expiring: renewed like the user's token,
    // the number and its account kept.
    m.set(
        "GET",
        "/fb/v19.0/oauth/access_token",
        ok(json!({ "access_token": "EAAB-wa-renewed-test", "expires_in": 5183944 })),
    );
    let wa_user = Credential::WhatsAppCloud {
        phone_number_id: PHONE.into(),
        token: WA_TOKEN.into(),
        waba_id: Some("4444444444".into()),
        expires_at: soon,
    };
    let renewed = r.meta.refresh(&wa_user).await.unwrap().unwrap();
    let Credential::WhatsAppCloud {
        phone_number_id,
        token,
        waba_id,
        expires_at,
    } = &renewed
    else {
        panic!("{renewed:?}");
    };
    assert_eq!(
        (phone_number_id.as_str(), token.as_str(), waba_id.as_deref()),
        (PHONE, "EAAB-wa-renewed-test", Some("4444444444"))
    );
    assert!(expires_at.unwrap() > OffsetDateTime::now_utc() + Duration::days(59));
    let call = &m.requests("GET", "/fb/v19.0/oauth/access_token")[1];
    assert_eq!(call.param("grant_type"), Some("fb_exchange_token"));
    assert_eq!(call.param("fb_exchange_token"), Some(WA_TOKEN));

    // Not expiring soon, no known expiry, a Page token, a system user's WhatsApp token: nothing
    // to do.
    m.clear();
    let wa_later = Credential::WhatsAppCloud {
        phone_number_id: PHONE.into(),
        token: WA_TOKEN.into(),
        waba_id: Some("4444444444".into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(40)),
    };
    let pasted = Credential::OAuth {
        access_token: USER_TOKEN.into(),
        refresh_token: None,
        expires_at: None,
        scopes: Vec::new(),
    };
    for cred in [
        user_cred(),
        ig_login_cred(),
        wa_later,
        pasted,
        page_cred(),
        wa_cred(None),
    ] {
        assert_eq!(r.meta.refresh(&cred).await.unwrap(), None, "{cred:?}");
    }
    assert!(m.recorded().is_empty());
    // A refused renewal is the provider's error.
    m.set(
        "GET",
        "/ig/refresh_access_token",
        status(400, graph_fixture(m, "error_token_expired")),
    );
    assert_eq!(kind_of(r.meta.refresh(&ig).await), "auth");
}

// ---------------------------------------------------------------------------------------------
// The kind is never guessed
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_missing_or_foreign_kind_is_refused_without_a_call() {
    let r = rig().await;
    let request = post("x", &["https://cdn.test/a.jpg"], None);
    let missing = json!({ "provider": "meta", "external_id": PAGE });
    let foreign = public("sms_line", Some(PAGE));
    for p in [&missing, &foreign] {
        for cred in [page_cred(), user_cred(), ig_login_cred(), wa_cred(None)] {
            let reason = |e: ConnectorError| e.reason().map(str::to_owned);
            let e = r.meta.publish(&cred, p, &request).await.unwrap_err();
            assert_eq!(reason(e).as_deref(), Some("kind_key missing"), "{p}");
            let e = r
                .meta
                .post_metrics(&cred, p, "1234567890_1")
                .await
                .unwrap_err();
            assert_eq!(reason(e).as_deref(), Some("kind_key missing"), "{p}");
            let e = r.meta.account_metrics(&cred, p).await.unwrap_err();
            assert_eq!(reason(e).as_deref(), Some("kind_key missing"), "{p}");
            let e = r.meta.send_text(&cred, p, "1", "x").await.unwrap_err();
            assert_eq!(reason(e).as_deref(), Some("kind_key missing"), "{p}");
            let e = r.meta.on_connected(&cred, p).await.unwrap_err();
            assert_eq!(reason(e).as_deref(), Some("kind_key missing"), "{p}");
            let probe = r.meta.probe(&cred, p).await;
            assert!(!probe.ok);
            assert_eq!(
                probe
                    .error
                    .and_then(|e| e.reason().map(str::to_owned))
                    .as_deref(),
                Some("kind_key missing"),
                "{p}"
            );
        }
    }
    assert!(r.mock.recorded().is_empty(), "nothing was sent");
}

#[tokio::test]
async fn a_refused_media_publish_surfaces_the_mapped_error() {
    let r = rig().await;
    let m = &r.mock;
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media",
        ok(json!({ "id": "900" })),
    );
    m.on(
        "GET",
        "/fb/v19.0/900",
        ok(json!({ "status_code": "FINISHED" })),
    );
    m.on(
        "POST",
        "/fb/v19.0/17841400000000001/media_publish",
        status(400, graph_fixture(m, "error_throttle")),
    );
    let e = r
        .meta
        .publish(
            &page_cred(),
            &public("instagram", Some(IG)),
            &post("x", &["https://cdn.test/a.jpg"], None),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "throttle");
    m.set(
        "POST",
        "/fb/v19.0/17841400000000001/media_publish",
        status(400, graph_fixture(m, "error_token_expired")),
    );
    let e = r
        .meta
        .publish(
            &page_cred(),
            &public("instagram", Some(IG)),
            &post("x", &["https://cdn.test/a.jpg"], None),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "auth");
}
