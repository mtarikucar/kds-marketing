//! The X adapter against the in-process mock: hosts, OAuth with PKCE, refresh rotation, assets,
//! probes, publishing with media uploads, counters, the error table, waits and retries.

mod support;

use std::time::Duration as StdDuration;

use jt_app::ports::connectors::{
    Connector, InsightsReader, MediaUpload, MetaApp, OAuthApp, OAuthProvider, PublishRequest,
    Publisher,
};
use jt_connector::{ConnectorError, Credential, Provider, pkce_challenge_s256, pkce_pair};
use jt_outbound::FIXED_HOSTS;
use jt_x::{
    IMAGE_MIMES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_RETRY_AFTER, MAX_TEXT_CHARS, READ_ATTEMPTS,
    X_HOSTS, X_SCOPES, XBases,
};
use serde_json::json;
use support::*;
use time::{Duration, OffsetDateTime};
use url::Url;

fn redirect() -> Url {
    Url::parse("https://panel.test/api/connectors/oauth/callback/x").unwrap()
}

fn kind_of<T: std::fmt::Debug>(r: Result<T, ConnectorError>) -> &'static str {
    r.expect_err("an error").kind()
}

fn pairs(url: &Url) -> Vec<(String, String)> {
    url.query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn owned(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// An image of `len` bytes of type `mime`.
fn image(len: usize, mime: &str, filename: &str) -> MediaUpload {
    MediaUpload {
        bytes: (0..len).map(|i| (i % 251) as u8).collect(),
        mime: mime.into(),
        filename: filename.into(),
    }
}

fn png(len: usize) -> MediaUpload {
    image(len, "image/png", "photo.png")
}

fn post(text: &str, media: Vec<MediaUpload>) -> PublishRequest {
    PublishRequest {
        text: text.into(),
        media,
        ..PublishRequest::default()
    }
}

fn scopes() -> Vec<String> {
    X_SCOPES.iter().map(|s| (*s).to_owned()).collect()
}

/// The parts of an `OAuth` credential: access token, refresh token, expiry, scopes.
fn oauth(cred: &Credential) -> (&str, Option<&str>, Option<OffsetDateTime>, &[String]) {
    match cred {
        Credential::OAuth {
            access_token,
            refresh_token,
            expires_at,
            scopes,
        } => (
            access_token.as_str(),
            refresh_token.as_deref(),
            *expires_at,
            scopes.as_slice(),
        ),
        other => panic!("not an OAuth credential: {other:?}"),
    }
}

/// Asserts `at` is `seconds` after some instant between `before` and `after`.
fn assert_expires_in(at: Option<OffsetDateTime>, seconds: i64, before: OffsetDateTime) {
    let after = OffsetDateTime::now_utc();
    let at = at.expect("an expiry");
    assert!(
        at >= before + Duration::seconds(seconds) - Duration::seconds(1)
            && at <= after + Duration::seconds(seconds) + Duration::seconds(1),
        "{at} is not {seconds} s after the call"
    );
}

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn hosts_are_the_fixed_x_hosts() {
    let r = rig().await;
    let fixed: Vec<&str> = FIXED_HOSTS
        .iter()
        .filter(|h| h.connector == "x")
        .map(|h| h.host)
        .collect();
    assert_eq!(r.x.hosts(), fixed.as_slice());
    assert_eq!(X_HOSTS, fixed.as_slice());
    assert_eq!(r.x.provider(), Provider::X);
    // The production bases reach exactly those hosts; the authorize dialog is only for browsers.
    let production = XBases::production();
    assert_eq!(production.api.as_str(), "https://api.twitter.com/");
    assert_eq!(production.upload.as_str(), "https://api.x.com/");
    assert_eq!(production.authorize.as_str(), "https://twitter.com/");
    for base in [&production.api, &production.upload] {
        assert!(fixed.contains(&base.host_str().unwrap()), "{base}");
    }
    assert!(!fixed.contains(&production.authorize.host_str().unwrap()));
}

// ---------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn authorize_url_requires_pkce_and_carries_s256() {
    let r = rig().await;
    let app = OAuthApp::X(x_app());
    let (verifier, challenge) = pkce_pair([7u8; 48]);
    assert_eq!(challenge, pkce_challenge_s256(&verifier));
    let url =
        r.x.authorize_url(&app, &redirect(), "state-1", Some(&challenge))
            .unwrap();
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("twitter.com"));
    assert_eq!(url.path(), "/i/oauth2/authorize");
    assert_eq!(
        pairs(&url),
        owned(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect().as_str()),
            ("scope", &X_SCOPES.join(" ")),
            ("state", "state-1"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ])
    );
    assert_eq!(
        X_SCOPES,
        [
            "tweet.read",
            "tweet.write",
            "users.read",
            "offline.access",
            "media.write"
        ]
    );
    // Spaces between the scopes are percent-encoded, not `+`.
    let query = url.query().unwrap();
    assert!(
        query
            .contains("scope=tweet.read%20tweet.write%20users.read%20offline.access%20media.write"),
        "{query}"
    );
    assert!(!url.as_str().contains(CLIENT_SECRET), "{url}");

    // Without a challenge, or with an empty one: refused.
    for missing in [None, Some(""), Some("  ")] {
        let e =
            r.x.authorize_url(&app, &redirect(), "state-1", missing)
                .unwrap_err();
        assert_eq!((e.kind(), e.reason()), ("permanent", Some("pkce required")));
    }
    // Another provider's app is not X's.
    let meta = OAuthApp::Meta(MetaApp {
        app_id: "meta-app".into(),
        app_secret: "meta-SECRET".into(),
        verify_token: "v".into(),
        login_config_id: None,
        whatsapp_config_id: None,
        graph_version: None,
    });
    assert_eq!(
        kind_of(r.x.authorize_url(&meta, &redirect(), "s", Some(&challenge))),
        "permanent"
    );

    // An exchange without the verifier is refused before any call.
    let e =
        r.x.exchange(&app, &redirect(), CODE, None)
            .await
            .unwrap_err();
    assert_eq!((e.kind(), e.reason()), ("permanent", Some("pkce required")));
    assert_eq!(
        kind_of(r.x.exchange(&meta, &redirect(), CODE, Some(VERIFIER)).await),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn exchange_sends_basic_and_code_verifier() {
    let r = rig().await;
    r.mock.on("POST", TOKEN, answer("token"));
    let before = OffsetDateTime::now_utc();
    let cred =
        r.x.exchange(&OAuthApp::X(x_app()), &redirect(), CODE, Some(VERIFIER))
            .await
            .unwrap();
    let call = r.mock.request("POST", TOKEN);
    assert_eq!(
        call.header("authorization"),
        Some(basic(CLIENT_ID, CLIENT_SECRET).as_str())
    );
    assert_eq!(
        call.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert!(call.query.is_empty(), "{:?}", call.query);
    assert_eq!(
        call.form(),
        owned(&[
            ("grant_type", "authorization_code"),
            ("code", CODE),
            ("redirect_uri", redirect().as_str()),
            ("client_id", CLIENT_ID),
            ("code_verifier", VERIFIER),
        ])
    );
    // The secret travels in the header only.
    assert!(!call.body().contains(CLIENT_SECRET));
    let (access, refresh, expires_at, granted) = oauth(&cred);
    assert_eq!(access, "x-access-test-1");
    assert_eq!(refresh, Some("x-refresh-test-1"));
    assert_expires_in(expires_at, 7200, before);
    assert_eq!(granted, scopes().as_slice());

    // An answer that names no scopes is taken to grant those asked for; one without an access
    // token is refused.
    r.mock.set(
        "POST",
        TOKEN,
        ok(json!({ "access_token": "x-access-test-1", "refresh_token": "x-refresh-test-1" })),
    );
    let cred =
        r.x.exchange(&OAuthApp::X(x_app()), &redirect(), CODE, Some(VERIFIER))
            .await
            .unwrap();
    let (_, _, expires_at, granted) = oauth(&cred);
    assert_eq!(expires_at, None);
    assert_eq!(granted, scopes().as_slice());
    r.mock
        .set("POST", TOKEN, ok(json!({ "token_type": "bearer" })));
    assert_eq!(
        kind_of(
            r.x.exchange(&OAuthApp::X(x_app()), &redirect(), CODE, Some(VERIFIER))
                .await
        ),
        "permanent"
    );
    // A bad or spent code (or a verifier that does not match): `invalid_grant` is `Auth`.
    r.mock
        .set("POST", TOKEN, answer_with(400, "token_invalid_grant"));
    let e =
        r.x.exchange(&OAuthApp::X(x_app()), &redirect(), CODE, Some(VERIFIER))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "auth", "{e}");
    assert!(e.reason().unwrap().contains("invalid_grant"), "{e}");
}

/// The brief's PKCE flow: the challenge in the authorize URL is the S256 of the verifier the
/// exchange sends, and the exchanged token reaches the account it lists.
#[tokio::test]
async fn pkce_flow_bodies() {
    let r = rig().await;
    let app = OAuthApp::X(x_app());
    let (verifier, challenge) = pkce_pair([42u8; 48]);
    let url =
        r.x.authorize_url(&app, &redirect(), "state-2", Some(&challenge))
            .unwrap();
    let sent_challenge = url
        .query_pairs()
        .find(|(k, _)| k == "code_challenge")
        .map(|(_, v)| v.into_owned())
        .unwrap();
    r.mock.on("POST", TOKEN, answer("token"));
    r.mock.on("GET", ME, answer("users_me"));
    let cred =
        r.x.exchange(&app, &redirect(), "code-from-callback", Some(&verifier))
            .await
            .unwrap();
    let form = r.mock.request("POST", TOKEN).form();
    let sent_verifier = form
        .iter()
        .find(|(k, _)| k == "code_verifier")
        .map(|(_, v)| v.clone())
        .unwrap();
    assert_eq!(sent_verifier, verifier);
    assert_eq!(pkce_challenge_s256(&sent_verifier), sent_challenge);
    assert!(
        form.iter()
            .any(|(k, v)| k == "code" && v == "code-from-callback")
    );

    let assets = r.x.list_assets(&cred).await.unwrap();
    assert_eq!(assets.len(), 1);
    let asset = &assets[0];
    assert_eq!(asset.kind_key, "x");
    assert_eq!(asset.external_id, USER_ID);
    assert_eq!(asset.name, "@jeeta_test");
    assert_eq!(asset.credential, cred);
    assert_eq!(
        asset.public,
        json!({ "username": USERNAME, "name": "Jeeta Test" })
    );
    let me = r.mock.request("GET", ME);
    assert_eq!(me.bearer(), Some("x-access-test-1"));
    assert!(me.query.is_empty(), "{:?}", me.query);
}

// ---------------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn refresh_rotation_returns_a_new_credential() {
    let r = rig().await;
    r.mock.on("POST", TOKEN, answer("token_refreshed"));
    // Not expiring for weeks: X rotates on every call all the same.
    let old = Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(30)),
        scopes: scopes(),
    };
    let before = OffsetDateTime::now_utc();
    let new = r.x.refresh(&old).await.unwrap().expect("a new credential");
    let call = r.mock.request("POST", TOKEN);
    assert_eq!(
        call.header("authorization"),
        Some(basic(CLIENT_ID, CLIENT_SECRET).as_str())
    );
    assert_eq!(
        call.form(),
        owned(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", REFRESH_TOKEN),
            ("client_id", CLIENT_ID),
        ])
    );
    let (access, refresh, expires_at, granted) = oauth(&new);
    assert_eq!(access, "x-access-test-2");
    assert_eq!(refresh, Some("x-refresh-test-2"));
    assert_expires_in(expires_at, 7200, before);
    assert_eq!(granted, scopes().as_slice());
    assert_ne!(new, old);
}

#[tokio::test]
async fn refresh_rotates_and_maps_invalid_grant_to_auth() {
    let r = rig().await;
    r.mock.on("POST", TOKEN, answer("token_refreshed"));
    r.mock.on("POST", TOKEN, answer("token_refreshed_again"));
    // Twice in a row: the second refresh sends the refresh token the first one returned.
    let first = r.x.refresh(&cred()).await.unwrap().unwrap();
    let second = r.x.refresh(&first).await.unwrap().unwrap();
    let sent: Vec<String> = r
        .mock
        .requests("POST", TOKEN)
        .iter()
        .map(|c| {
            c.form()
                .into_iter()
                .find(|(k, _)| k == "refresh_token")
                .unwrap()
                .1
        })
        .collect();
    assert_eq!(sent, [REFRESH_TOKEN, "x-refresh-test-2"]);
    let (access, refresh, _, granted) = oauth(&second);
    assert_eq!(access, "x-access-test-3");
    assert_eq!(refresh, Some("x-refresh-test-3"));
    // The scopes are the ones the answer grants.
    assert_eq!(granted, ["tweet.read", "users.read", "offline.access"]);

    // An answer without a refresh token keeps the one the credential had, and its scopes.
    r.mock.set(
        "POST",
        TOKEN,
        ok(json!({ "access_token": "x-access-test-4", "expires_in": 7200 })),
    );
    let kept = r.x.refresh(&cred()).await.unwrap().unwrap();
    let (access, refresh, _, granted) = oauth(&kept);
    assert_eq!((access, refresh), ("x-access-test-4", Some(REFRESH_TOKEN)));
    assert_eq!(granted, scopes().as_slice());

    // A spent or revoked refresh token: the owner must reconnect.
    for (reply, expected) in [
        (answer_with(400, "token_invalid_grant"), "auth"),
        // X answers a spent refresh token with `invalid_request` ("the token was invalid").
        (answer_with(400, "token_invalid_request"), "auth"),
        (answer_with(401, "error_unauthorized"), "auth"),
        // The platform's client refused is the platform's problem, not the tenant's.
        (
            status(
                401,
                json!({ "error": "invalid_client", "error_description": "bad client" }),
            ),
            "permanent",
        ),
        (answer_with(429, "error_rate_limit"), "throttle"),
        (raw(503, "<html>unavailable</html>"), "transient"),
        (
            status(400, json!({ "error": "unsupported_grant_type" })),
            "permanent",
        ),
    ] {
        r.mock.set("POST", TOKEN, reply.clone());
        let e = r.x.refresh(&cred()).await.unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
        assert_no_secret(&format!("{e} {e:?}"));
    }

    // Nothing to refresh with, or nothing to refresh: refused without a call.
    r.mock.clear();
    let without = Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::hours(1)),
        scopes: scopes(),
    };
    assert_eq!(kind_of(r.x.refresh(&without).await), "auth");
    let foreign = Credential::PageToken {
        page_id: "1".into(),
        token: "EAAB-SECRET".into(),
    };
    assert_eq!(kind_of(r.x.refresh(&foreign).await), "permanent");
    let unconfigured = rig_with(TestApps { x: None }, jt_x::ATTEMPT_TIMEOUT).await;
    assert_eq!(kind_of(unconfigured.x.refresh(&cred()).await), "permanent");
    assert!(r.mock.recorded().is_empty());
    assert!(unconfigured.mock.recorded().is_empty());
}

#[tokio::test]
async fn token_endpoint_client_rejection_is_the_platforms_not_the_tenants() {
    let r = rig().await;
    let app = OAuthApp::X(x_app());
    // The platform's client id or secret refused: no reconnection can help, so never `Auth`.
    r.mock.set(
        "POST",
        TOKEN,
        status(
            401,
            json!({ "error": "invalid_client", "error_description": "Missing valid authorization header" }),
        ),
    );
    for e in [
        r.x.exchange(&app, &redirect(), CODE, Some(VERIFIER))
            .await
            .unwrap_err(),
        r.x.refresh(&cred()).await.unwrap_err(),
    ] {
        assert_eq!(
            (e.kind(), e.reason()),
            ("permanent", Some("platform client credentials rejected")),
            "{e}"
        );
    }
    // Every other refusal of the token endpoint is the tenant's grant: `Auth`.
    for reply in [
        status(401, json!({ "error": "unauthorized_client" })),
        status(401, json!({ "title": "Unauthorized" })),
        raw(401, "<html>no</html>"),
        answer_with(400, "token_invalid_grant"),
        answer_with(400, "token_invalid_request"),
    ] {
        r.mock.set("POST", TOKEN, reply.clone());
        let e = r.x.refresh(&cred()).await.unwrap_err();
        assert_eq!(e.kind(), "auth", "{reply:?}: {e}");
    }
    // On the API, `invalid_client` in a 401 body is still the token's refusal.
    r.mock
        .set("GET", ME, status(401, json!({ "error": "invalid_client" })));
    assert_eq!(
        kind_of(r.x.account_metrics(&cred(), &public()).await),
        "auth"
    );
}

// ---------------------------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn probe_facts() {
    let r = rig().await;
    r.mock.on("GET", ME, answer("users_me"));
    let result = r.x.probe(&cred(), &public()).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(result.error, None);
    assert_eq!(
        result.facts,
        json!({ "account_id": USER_ID, "username": USERNAME })
    );
    let call = r.mock.request("GET", ME);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert!(call.query.is_empty(), "{:?}", call.query);

    // A failure is a result, with no facts.
    r.mock
        .set("GET", ME, answer_with(401, "error_unauthorized"));
    let result = r.x.probe(&cred(), &public()).await;
    assert!(!result.ok);
    assert_eq!(
        result.error.as_ref().map(ConnectorError::kind),
        Some("auth")
    );
    assert_eq!(result.facts, json!({}));
}

#[tokio::test]
async fn probe_binds_user_id_as_account_id() {
    let r = rig().await;
    r.mock.on("GET", ME, answer("users_me"));
    // Whatever the capability claims, the probe names the credential's own account.
    let mut claims = public();
    claims["external_id"] = json!("1700000000000000999");
    let result = r.x.probe(&cred(), &claims).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(result.facts["account_id"], json!(USER_ID));
    assert!(result.facts["account_id"].is_string());
    // It asked about `me`, never about the claimed id.
    for call in r.mock.recorded() {
        assert_eq!(call.path, ME);
        assert!(!format!("{call:?}").contains("1700000000000000999"));
    }

    // A numeric id is named as a string; an answer without one fails.
    r.mock.set(
        "GET",
        ME,
        ok(json!({ "data": { "id": 1_700_000_000_000_000_002_u64, "username": "jeeta_test" } })),
    );
    let result = r.x.probe(&cred(), &public()).await;
    assert_eq!(result.facts["account_id"], json!("1700000000000000002"));
    r.mock.set(
        "GET",
        ME,
        ok(json!({ "data": { "username": "jeeta_test" } })),
    );
    let result = r.x.probe(&cred(), &public()).await;
    assert!(!result.ok);
    assert_eq!(
        result.error.as_ref().map(ConnectorError::kind),
        Some("permanent")
    );

    // No X kind, or no OAuth credential: refused without a call.
    r.mock.clear();
    for public in [json!({}), json!({ "kind_key": "instagram" })] {
        let result = r.x.probe(&cred(), &public).await;
        let e = result.error.expect("an error");
        assert_eq!(
            (e.kind(), e.reason()),
            ("permanent", Some("kind_key missing"))
        );
    }
    let foreign = Credential::NetgsmSms {
        usercode: "1".into(),
        password: "pw-SECRET".into(),
        msgheader: "H".into(),
    };
    let result = r.x.probe(&foreign, &public()).await;
    assert_eq!(
        result.error.as_ref().map(ConnectorError::kind),
        Some("permanent")
    );
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn post_body() {
    let r = rig().await;
    r.mock.on("POST", TWEETS, answer("tweet_created"));
    let receipt =
        r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
            .await
            .unwrap();
    assert_eq!(receipt.external_id, TWEET_ID);
    let call = r.mock.request("POST", TWEETS);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.header("content-type"), Some("application/json"));
    // Text only: no `media` key at all.
    assert_eq!(call.json(), json!({ "text": "Merhaba" }));
    assert!(r.mock.requests("POST", UPLOAD).is_empty());

    // A link goes on a line of its own after the text.
    r.mock.clear();
    let mut with_link = post("Yeni menü", vec![]);
    with_link.link = Some(Url::parse("https://jeeta.test/menu").unwrap());
    r.x.publish(&cred(), &public(), &with_link).await.unwrap();
    assert_eq!(
        r.mock.request("POST", TWEETS).json(),
        json!({ "text": "Yeni menü\n\nhttps://jeeta.test/menu" })
    );
}

#[tokio::test]
async fn media_upload_multipart_shape() {
    let r = rig().await;
    r.mock.on("POST", UPLOAD, answer("media_upload"));
    // The older answer shape names the id as `media_id_string`.
    r.mock.on("POST", UPLOAD, answer("media_upload_v1"));
    r.mock.on("POST", TWEETS, answer("tweet_created"));
    let first = png(1024);
    let second = image(2048, "image/jpeg", "menu.jpg");
    let receipt =
        r.x.publish(
            &cred(),
            &public(),
            &post("Bugünün menüsü", vec![first.clone(), second.clone()]),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, TWEET_ID);

    let uploads = r.mock.requests("POST", UPLOAD);
    assert_eq!(uploads.len(), 2);
    for (call, media) in uploads.iter().zip([&first, &second]) {
        assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
        assert!(call.query.is_empty(), "{:?}", call.query);
        let parts = call.parts();
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert_eq!(parts[0].name, "media");
        assert_eq!(parts[0].filename.as_deref(), Some(media.filename.as_str()));
        assert_eq!(parts[0].content_type.as_deref(), Some(media.mime.as_str()));
        assert_eq!(parts[0].data, media.bytes);
        assert_eq!(parts[1].name, "media_category");
        assert_eq!(parts[1].filename, None);
        assert_eq!(parts[1].data, b"tweet_image");
    }
    // The post carries the uploaded ids, in order, and comes after both uploads.
    let lines: Vec<String> = r.mock.recorded().iter().map(|c| c.line()).collect();
    assert_eq!(
        lines,
        [
            format!("POST {UPLOAD}"),
            format!("POST {UPLOAD}"),
            format!("POST {TWEETS}"),
        ]
    );
    assert_eq!(
        r.mock.request("POST", TWEETS).json(),
        json!({
            "text": "Bugünün menüsü",
            "media": { "media_ids": ["1900000000000000001", "1900000000000000002"] },
        })
    );

    // Media alone (no text): no `text` key. A file name that could break the part headers is
    // replaced.
    r.mock.clear();
    let mut odd = png(16);
    odd.filename = "a\"b\r\nX-Evil: 1.png".into();
    r.x.publish(&cred(), &public(), &post("", vec![odd]))
        .await
        .unwrap();
    let parts = r.mock.request("POST", UPLOAD).parts();
    let name = parts[0].filename.clone().unwrap();
    assert!(
        name.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)),
        "{name}"
    );
    assert_eq!(
        r.mock.request("POST", TWEETS).json(),
        json!({ "media": { "media_ids": ["1900000000000000002"] } })
    );

    // An upload that fails stops the post: nothing is posted without its media.
    r.mock.clear();
    r.mock
        .set("POST", UPLOAD, answer_with(400, "error_invalid_request"));
    assert_eq!(
        kind_of(
            r.x.publish(&cred(), &public(), &post("Merhaba", vec![png(8)]))
                .await
        ),
        "permanent"
    );
    assert!(r.mock.requests("POST", TWEETS).is_empty());
}

#[tokio::test]
async fn publish_refuses_more_than_four_images_or_oversize_or_long_text_before_calling() {
    let r = rig().await;
    assert_eq!(MAX_IMAGES, 4);
    assert_eq!(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
    assert_eq!(MAX_TEXT_CHARS, 280);
    assert_eq!(
        IMAGE_MIMES,
        ["image/jpeg", "image/png", "image/gif", "image/webp"]
    );
    let with_urls = PublishRequest {
        text: "Merhaba".into(),
        media_urls: vec![Url::parse("https://cdn.test/a.png").unwrap()],
        ..PublishRequest::default()
    };
    let refused: Vec<(&str, PublishRequest)> = vec![
        (
            "five images",
            post("Merhaba", (0..5).map(|_| png(8)).collect()),
        ),
        (
            "an oversize image",
            post("Merhaba", vec![png(MAX_IMAGE_BYTES + 1)]),
        ),
        ("an empty image", post("Merhaba", vec![png(0)])),
        (
            "a bitmap",
            post("Merhaba", vec![image(8, "image/bmp", "a.bmp")]),
        ),
        (
            "a video",
            post("Merhaba", vec![image(8, "video/mp4", "a.mp4")]),
        ),
        ("281 characters", post(&"a".repeat(281), vec![])),
        ("281 wide characters", post(&"ğ".repeat(281), vec![])),
        ("nothing to post", post("  ", vec![])),
        (
            "a GIF with an image",
            post("Merhaba", vec![image(8, "image/gif", "a.gif"), png(8)]),
        ),
        (
            "two GIFs",
            post(
                "Merhaba",
                vec![
                    image(8, "image/gif", "a.gif"),
                    image(8, "image/gif", "b.gif"),
                ],
            ),
        ),
        (
            "more bytes than URLs",
            PublishRequest {
                media: vec![png(8), png(8)],
                ..with_urls.clone()
            },
        ),
        ("media URLs without bytes", with_urls),
    ];
    for (what, request) in &refused {
        let e =
            r.x.publish(&cred(), &public(), request)
                .await
                .expect_err(what);
        assert_eq!(e.kind(), "permanent", "{what}: {e}");
    }
    let e =
        r.x.publish(&cred(), &public(), &refused.last().unwrap().1)
            .await
            .unwrap_err();
    assert_eq!(e.reason(), Some("x needs media bytes"));
    let e =
        r.x.publish(&cred(), &public(), &refused[refused.len() - 2].1)
            .await
            .unwrap_err();
    assert_eq!(e.reason(), Some("media bytes and urls disagree"));
    // A link counts as X counts it, 23 characters, after a blank line.
    let mut long_with_link = post(&"a".repeat(MAX_TEXT_CHARS - 24), vec![]);
    long_with_link.link = Some(Url::parse("https://jeeta.test/a").unwrap());
    assert_eq!(
        kind_of(r.x.publish(&cred(), &public(), &long_with_link).await),
        "permanent"
    );
    // No X kind, or no OAuth credential.
    assert_eq!(
        kind_of(
            r.x.publish(&cred(), &json!({}), &post("Merhaba", vec![]))
                .await
        ),
        "permanent"
    );
    let foreign = Credential::PageToken {
        page_id: "1".into(),
        token: "EAAB-SECRET".into(),
    };
    assert_eq!(
        kind_of(
            r.x.publish(&foreign, &public(), &post("Merhaba", vec![]))
                .await
        ),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty(), "nothing is sent");

    // At the limits, it goes: 280 characters (560 bytes of them), four images, one of 5 MB, and
    // a link that fits by X's count.
    r.mock.on("POST", UPLOAD, answer("media_upload"));
    r.mock.on("POST", TWEETS, answer("tweet_created"));
    let wide = "ş".repeat(MAX_TEXT_CHARS);
    assert_eq!(wide.len(), 2 * MAX_TEXT_CHARS);
    r.x.publish(&cred(), &public(), &post(&wide, vec![]))
        .await
        .unwrap();
    let mut images: Vec<MediaUpload> = (0..3).map(|_| png(8)).collect();
    images.push(image(MAX_IMAGE_BYTES, "image/webp", "big.webp"));
    r.x.publish(&cred(), &public(), &post("Merhaba", images))
        .await
        .unwrap();
    assert_eq!(r.mock.requests("POST", UPLOAD).len(), 4);
    let mut fits = post(&"a".repeat(MAX_TEXT_CHARS - 25), vec![]);
    fits.link = Some(Url::parse(&format!("https://jeeta.test/{}", "b".repeat(200))).unwrap());
    r.x.publish(&cred(), &public(), &fits).await.unwrap();
    // Media types are read ignoring case and surrounding space.
    r.x.publish(
        &cred(),
        &public(),
        &post("Merhaba", vec![image(8, " Image/JPEG ", "a.jpg")]),
    )
    .await
    .unwrap();
    assert_eq!(r.mock.requests("POST", TWEETS).len(), 4);

    // As many bytes as URLs: the bytes are what is uploaded (the URLs are where they came from).
    r.mock.clear();
    let both = PublishRequest {
        text: "Merhaba".into(),
        media_urls: vec![Url::parse("https://cdn.test/a.png").unwrap()],
        media: vec![png(32)],
        ..PublishRequest::default()
    };
    r.x.publish(&cred(), &public(), &both).await.unwrap();
    let parts = r.mock.request("POST", UPLOAD).parts();
    assert_eq!(parts[0].data, png(32).bytes);
    assert!(
        r.mock
            .recorded()
            .iter()
            .all(|c| !c.body().contains("cdn.test")),
        "no URL is handed to X"
    );
}

#[tokio::test]
async fn gifs_upload_as_tweet_gif_and_go_alone() {
    let r = rig().await;
    r.mock.on("POST", UPLOAD, answer("media_upload"));
    r.mock.on("POST", TWEETS, answer("tweet_created"));
    let gif = image(64, " IMAGE/GIF", "loop.gif");
    r.x.publish(&cred(), &public(), &post("Merhaba", vec![gif.clone()]))
        .await
        .unwrap();
    let parts = r.mock.request("POST", UPLOAD).parts();
    assert_eq!(parts[0].content_type.as_deref(), Some("image/gif"));
    assert_eq!(parts[0].data, gif.bytes);
    assert_eq!(parts[1].name, "media_category");
    assert_eq!(parts[1].data, b"tweet_gif");
    // Every other image type stays `tweet_image`.
    for (mime, name) in [
        ("image/png", "a.png"),
        ("image/jpeg", "a.jpg"),
        ("image/webp", "a.webp"),
    ] {
        r.mock.clear();
        r.x.publish(
            &cred(),
            &public(),
            &post("Merhaba", vec![image(8, mime, name)]),
        )
        .await
        .unwrap();
        let parts = r.mock.request("POST", UPLOAD).parts();
        assert_eq!(parts[1].data, b"tweet_image", "{mime}");
    }
    // A GIF goes alone: with another image it is refused before anything is sent.
    r.mock.clear();
    let e =
        r.x.publish(&cred(), &public(), &post("Merhaba", vec![png(8), gif]))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn urls_in_the_text_count_as_23() {
    let r = rig().await;
    r.mock.on("POST", TWEETS, answer("tweet_created"));
    // 300 characters, 59 of them a URL: X counts 240 + 1 + 23 = 264.
    let url = format!("https://jeeta.test/{}", "m".repeat(40));
    assert_eq!(url.chars().count(), 59);
    let text = format!("{} {url}", "a".repeat(240));
    assert_eq!(text.chars().count(), 300);
    r.x.publish(&cred(), &public(), &post(&text, vec![]))
        .await
        .unwrap();
    // Sent as written: X shortens it itself.
    assert_eq!(
        r.mock.request("POST", TWEETS).json(),
        json!({ "text": text })
    );

    // Every URL counts, `http` too, wherever it stands; what is left over still counts in full.
    r.mock.clear();
    let two = format!(
        "{}\nhttp://a.test/{} (https://b.test/{})",
        "a".repeat(230),
        "x".repeat(60),
        "y".repeat(60)
    );
    // 230 + 1 + 23 + 2 + 23 = 279 by X's count (the `)` goes with its URL); `over` is two more
    // characters of text.
    r.x.publish(&cred(), &public(), &post(&two, vec![]))
        .await
        .unwrap();
    let over = format!("bb{two}");
    assert_eq!(
        kind_of(r.x.publish(&cred(), &public(), &post(&over, vec![])).await),
        "permanent"
    );
    // A short URL still counts 23, as X counts it.
    let short = format!("{} https://a.b", "a".repeat(257));
    assert_eq!(short.chars().count(), 269);
    assert_eq!(
        kind_of(r.x.publish(&cred(), &public(), &post(&short, vec![])).await),
        "permanent"
    );
    // Text without a URL is counted character by character, as before.
    assert_eq!(
        kind_of(
            r.x.publish(&cred(), &public(), &post(&"a".repeat(281), vec![]))
                .await
        ),
        "permanent"
    );
    assert_eq!(r.mock.requests("POST", TWEETS).len(), 1);
}

#[tokio::test]
async fn publish_receipt_url_uses_username() {
    let r = rig().await;
    r.mock.on("POST", TWEETS, answer("tweet_created"));
    let receipt =
        r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
            .await
            .unwrap();
    assert_eq!(
        receipt.url.as_ref().map(Url::as_str),
        Some("https://x.com/jeeta_test/status/1800000000000000001")
    );
    // Without a username, or with one that is not an X handle: the id-only permalink.
    let mut anonymous = public();
    anonymous.as_object_mut().unwrap().remove("username");
    for public in [
        anonymous.clone(),
        json!({ "kind_key": "x", "username": "../../evil" }),
        json!({ "kind_key": "x", "username": "" }),
        json!({ "kind_key": "x", "username": 7 }),
    ] {
        let receipt =
            r.x.publish(&cred(), &public, &post("Merhaba", vec![]))
                .await
                .unwrap();
        assert_eq!(
            receipt.url.as_ref().map(Url::as_str),
            Some("https://x.com/i/status/1800000000000000001"),
            "{public}"
        );
    }
    // As the use cases hand it over: the handle the last probe found, else the OAuth asset's.
    let stored = json!({
        "kind_key": "x",
        "external_id": USER_ID,
        "facts": { "account_id": USER_ID, "username": "jeeta_probed" },
        "asset": { "username": USERNAME, "name": "Jeeta Test" },
    });
    let receipt =
        r.x.publish(&cred(), &stored, &post("Merhaba", vec![]))
            .await
            .unwrap();
    assert_eq!(
        receipt.url.as_ref().map(Url::as_str),
        Some("https://x.com/jeeta_probed/status/1800000000000000001")
    );
    let receipt =
        r.x.publish(
            &cred(),
            &json!({ "kind_key": "x", "asset": { "username": USERNAME } }),
            &post("Merhaba", vec![]),
        )
        .await
        .unwrap();
    assert_eq!(
        receipt.url.as_ref().map(Url::as_str),
        Some("https://x.com/jeeta_test/status/1800000000000000001")
    );
    // An answer without a post id is refused.
    r.mock.set("POST", TWEETS, ok(json!({ "data": {} })));
    assert_eq!(
        kind_of(
            r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
                .await
        ),
        "permanent"
    );
}

// ---------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn insights_read_public_metrics() {
    let r = rig().await;
    r.mock.on("GET", &tweet(TWEET_ID), answer("tweet_metrics"));
    r.mock.on("GET", ME, answer("users_me_metrics"));
    let post =
        r.x.post_metrics(&cred(), &public(), TWEET_ID)
            .await
            .unwrap();
    let expected: Vec<(String, i64)> = [
        ("bookmark_count", 2),
        ("impression_count", 940),
        ("like_count", 25),
        ("quote_count", 0),
        ("reply_count", 1),
        ("retweet_count", 3),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), *v))
    .collect();
    assert_eq!(post.metrics.into_iter().collect::<Vec<_>>(), expected);
    let call = r.mock.request("GET", &tweet(TWEET_ID));
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.query, owned(&[("tweet.fields", "public_metrics")]));

    let account = r.x.account_metrics(&cred(), &public()).await.unwrap();
    let expected: Vec<(String, i64)> = [
        ("followers_count", 120),
        ("following_count", 45),
        ("like_count", 87),
        ("listed_count", 2),
        ("media_count", 12),
        ("tweet_count", 310),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), *v))
    .collect();
    assert_eq!(account.metrics.into_iter().collect::<Vec<_>>(), expected);
    let call = r.mock.request("GET", ME);
    assert_eq!(call.query, owned(&[("user.fields", "public_metrics")]));

    // A counter that is not a whole number is left out; an answer without counters is refused.
    r.mock.set(
        "GET",
        &tweet(TWEET_ID),
        ok(json!({ "data": { "id": TWEET_ID, "public_metrics": {
            "like_count": 4, "odd": "many", "ratio": 0.5,
        }}})),
    );
    let post =
        r.x.post_metrics(&cred(), &public(), TWEET_ID)
            .await
            .unwrap();
    assert_eq!(
        post.metrics.into_iter().collect::<Vec<_>>(),
        [("like_count".to_owned(), 4)]
    );
    r.mock.set(
        "GET",
        &tweet(TWEET_ID),
        ok(json!({ "data": { "id": TWEET_ID } })),
    );
    assert_eq!(
        kind_of(r.x.post_metrics(&cred(), &public(), TWEET_ID).await),
        "permanent"
    );
    // A deleted post: 200 with only `errors`.
    r.mock
        .set("GET", &tweet(TWEET_ID), answer("tweet_not_found"));
    let e =
        r.x.post_metrics(&cred(), &public(), TWEET_ID)
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(e.reason().unwrap().contains("Could not find tweet"), "{e}");

    // An id that is not a post id, no X kind: refused without a call.
    r.mock.clear();
    let long = "1".repeat(40);
    for bad in ["", "../1", "12a", "1/2", long.as_str()] {
        assert_eq!(
            kind_of(r.x.post_metrics(&cred(), &public(), bad).await),
            "permanent",
            "{bad:?}"
        );
    }
    assert_eq!(
        kind_of(r.x.post_metrics(&cred(), &json!({}), TWEET_ID).await),
        "permanent"
    );
    assert_eq!(
        kind_of(r.x.account_metrics(&cred(), &json!({})).await),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn a_missing_or_foreign_kind_is_refused_without_a_call() {
    let r = rig().await;
    for public in [
        json!({}),
        json!(null),
        json!({ "kind_key": null }),
        json!({ "kind_key": "X" }),
        json!({ "kind_key": "facebook_page" }),
    ] {
        let errors = [
            r.x.publish(&cred(), &public, &post("Merhaba", vec![]))
                .await
                .map(drop),
            r.x.post_metrics(&cred(), &public, TWEET_ID).await.map(drop),
            r.x.account_metrics(&cred(), &public).await.map(drop),
            r.x.probe(&cred(), &public).await.error.map_or(Ok(()), Err),
        ];
        for e in errors {
            let e = e.expect_err("refused");
            assert_eq!(
                (e.kind(), e.reason()),
                ("permanent", Some("kind_key missing")),
                "{public}"
            );
        }
    }
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Errors and waits
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn error_mapping_incl_429_retry_after() {
    let r = rig().await;
    for (reply, expected, quoted) in [
        (
            answer_with(401, "error_unauthorized"),
            "auth",
            Some("Unauthorized"),
        ),
        (
            answer_with(403, "error_forbidden"),
            "permission",
            Some("You are not permitted"),
        ),
        (answer_with(429, "error_rate_limit"), "throttle", None),
        (raw(429, "slow down"), "throttle", None),
        (raw(500, "<html>oops</html>"), "transient", Some("HTTP 500")),
        (
            answer_with(503, "error_rate_limit"),
            "transient",
            Some("HTTP 503"),
        ),
        (
            answer_with(400, "error_invalid_request"),
            "permanent",
            Some("Invalid Request: One or more parameters to your request was invalid."),
        ),
        (
            answer_with(400, "error_invalid_request"),
            "permanent",
            Some("Your media IDs are invalid."),
        ),
        (
            answer_with(404, "error_not_found"),
            "permanent",
            Some("HTTP 404"),
        ),
        (raw(400, "<html>bad</html>"), "permanent", Some("HTTP 400")),
        (
            raw(200, "<html>not json</html>"),
            "permanent",
            Some("HTTP 200"),
        ),
        (raw(302, ""), "permanent", Some("HTTP 302")),
    ] {
        r.mock.set("POST", TWEETS, reply.clone());
        let e =
            r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
                .await
                .unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
        if let Some(quoted) = quoted {
            assert!(e.reason().unwrap().contains(quoted), "{quoted}: {e}");
        }
        // Reads map the same way.
        r.mock.set("GET", ME, reply.clone());
        let e = r.x.account_metrics(&cred(), &public()).await.unwrap_err();
        assert_eq!(e.kind(), expected, "GET {reply:?}: {e}");
    }

    // 429 carries the wait the headers name.
    r.mock.set(
        "POST",
        TWEETS,
        answer_with(429, "error_rate_limit").with_header("retry-after", "30"),
    );
    assert_eq!(
        r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err(),
        ConnectorError::throttle(Some(Duration::seconds(30)))
    );
    r.mock
        .set("POST", TWEETS, answer_with(429, "error_rate_limit"));
    assert_eq!(
        r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err(),
        ConnectorError::throttle(None)
    );
    // A provider error on a call that got an answer is never sent again.
    assert_eq!(r.mock.requests("GET", ME).len(), 12);
}

#[tokio::test]
async fn throttle_wait_from_rate_limit_reset_capped() {
    let r = rig().await;
    let wait = |reply: Reply| {
        let r = &r;
        async move {
            r.mock.set("GET", ME, reply);
            match r.x.account_metrics(&cred(), &public()).await {
                Err(ConnectorError::Throttle { retry_after }) => retry_after,
                other => panic!("not a throttle: {other:?}"),
            }
        }
    };
    let limited = || answer_with(429, "error_rate_limit");
    let now = OffsetDateTime::now_utc().unix_timestamp();

    // The reset instant, in epoch seconds, minus now.
    let got = wait(limited().with_header("x-rate-limit-reset", &(now + 90).to_string()))
        .await
        .expect("a wait");
    assert!(
        got <= Duration::seconds(90) && got >= Duration::seconds(85),
        "{got}"
    );
    // Capped at an hour (a 24-hour limit's reset is far away).
    let got = wait(limited().with_header("x-rate-limit-reset", &(now + 36_000).to_string())).await;
    assert_eq!(got, Some(MAX_RETRY_AFTER));
    assert_eq!(MAX_RETRY_AFTER, Duration::hours(1));
    let got = wait(limited().with_header("x-rate-limit-reset", &i64::MAX.to_string())).await;
    assert_eq!(got, Some(MAX_RETRY_AFTER));
    // The reset wins over Retry-After.
    let got = wait(
        limited()
            .with_header("x-rate-limit-reset", &(now + 600).to_string())
            .with_header("retry-after", "5"),
    )
    .await
    .unwrap();
    assert!(got > Duration::seconds(590), "{got}");
    // A reset already past (or unreadable) leaves Retry-After to decide.
    let got = wait(
        limited()
            .with_header("x-rate-limit-reset", &(now - 60).to_string())
            .with_header("retry-after", "15"),
    )
    .await;
    assert_eq!(got, Some(Duration::seconds(15)));
    let got = wait(
        limited()
            .with_header("x-rate-limit-reset", "soon")
            .with_header("retry-after", "99999999"),
    )
    .await;
    assert_eq!(got, Some(MAX_RETRY_AFTER));
    let got = wait(limited().with_header("x-rate-limit-reset", &(now - 60).to_string())).await;
    assert_eq!(got, None);
    assert_eq!(wait(limited()).await, None);

    // The 24-hour caps (posts) reset the same way; the largest wait ahead wins, capped.
    let at = |offset: i64| (now + offset).to_string();
    let got = wait(
        limited()
            .with_header("x-rate-limit-reset", &at(60))
            .with_header("x-app-limit-24hour-reset", &at(300)),
    )
    .await
    .unwrap();
    assert!(
        got <= Duration::seconds(300) && got >= Duration::seconds(295),
        "{got}"
    );
    let got = wait(
        limited()
            .with_header("x-rate-limit-reset", &at(60))
            .with_header("x-app-limit-24hour-reset", &at(120))
            .with_header("x-user-limit-24hour-reset", &at(900)),
    )
    .await
    .unwrap();
    assert!(
        got <= Duration::seconds(900) && got >= Duration::seconds(895),
        "{got}"
    );
    let got = wait(limited().with_header("x-user-limit-24hour-reset", &at(20 * 3600))).await;
    assert_eq!(got, Some(MAX_RETRY_AFTER));
    // A 24-hour reset already past does not shorten a window's wait.
    let got = wait(
        limited()
            .with_header("x-rate-limit-reset", &at(200))
            .with_header("x-user-limit-24hour-reset", &at(-5)),
    )
    .await
    .unwrap();
    assert!(got >= Duration::seconds(195), "{got}");
    // ... nor does it beat Retry-After when it is the only reset given.
    let got = wait(
        limited()
            .with_header("x-app-limit-24hour-reset", &at(-5))
            .with_header("retry-after", "7"),
    )
    .await;
    assert_eq!(got, Some(Duration::seconds(7)));
    // A throttled read is not tried again: an answer arrived.
    assert_eq!(r.mock.requests("GET", ME).len(), 13);
}

#[tokio::test]
async fn no_secret_in_any_error_text() {
    let r = rig().await;
    let mut errors: Vec<ConnectorError> = Vec::new();
    // The token endpoint echoes what it was sent.
    let token_error = |description: String| {
        status(
            400,
            json!({ "error": "invalid_request", "error_description": description }),
        )
    };
    for description in [
        format!("code {CODE} with verifier {VERIFIER} is invalid"),
        format!("client {CLIENT_ID}:{CLIENT_SECRET} refused (verifier {VERIFIER})"),
    ] {
        r.mock.set("POST", TOKEN, token_error(description));
        errors.push(
            r.x.exchange(&OAuthApp::X(x_app()), &redirect(), CODE, Some(VERIFIER))
                .await
                .unwrap_err(),
        );
    }
    for description in [
        format!("refresh token {REFRESH_TOKEN} was revoked"),
        format!("client secret {CLIENT_SECRET} does not match"),
    ] {
        r.mock.set("POST", TOKEN, token_error(description));
        errors.push(r.x.refresh(&cred()).await.unwrap_err());
    }
    // A server error at the token endpoint that echoes everything it was sent.
    let unavailable = |echo: String| {
        status(
            503,
            json!({
                "error": "temporarily_unavailable",
                "error_description": format!("{echo} could not be checked"),
            }),
        )
    };
    r.mock.set(
        "POST",
        TOKEN,
        unavailable(format!("{CODE} {VERIFIER} {CLIENT_SECRET}")),
    );
    errors.push(
        r.x.exchange(&OAuthApp::X(x_app()), &redirect(), CODE, Some(VERIFIER))
            .await
            .unwrap_err(),
    );
    r.mock.set(
        "POST",
        TOKEN,
        unavailable(format!("{REFRESH_TOKEN} {CLIENT_SECRET}")),
    );
    errors.push(r.x.refresh(&cred()).await.unwrap_err());
    // The API echoes the access token.
    for (code, body) in [
        (
            401,
            json!({ "title": "Unauthorized", "detail": format!("token {ACCESS_TOKEN} expired") }),
        ),
        (
            403,
            json!({ "title": "Forbidden", "detail": format!("Bearer {ACCESS_TOKEN}") }),
        ),
        (
            400,
            json!({
                "title": "Invalid Request",
                "detail": "bad",
                "errors": [ { "message": format!("token={ACCESS_TOKEN} is not valid") } ],
            }),
        ),
        (
            404,
            json!({ "title": "Not Found Error", "detail": format!("{{\"access_token\":\"{ACCESS_TOKEN}\"}}") }),
        ),
        (
            503,
            json!({ "title": "Service Unavailable", "detail": format!("upstream saw {ACCESS_TOKEN}") }),
        ),
    ] {
        r.mock.set("POST", TWEETS, status(code, body.clone()));
        r.mock.set("POST", UPLOAD, status(code, body.clone()));
        r.mock
            .set("GET", &tweet(TWEET_ID), status(code, body.clone()));
        r.mock.set("GET", ME, status(code, body));
        errors.push(
            r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
                .await
                .unwrap_err(),
        );
        errors.push(
            r.x.publish(&cred(), &public(), &post("Merhaba", vec![png(8)]))
                .await
                .unwrap_err(),
        );
        errors.push(r.x.account_metrics(&cred(), &public()).await.unwrap_err());
        errors.push(
            r.x.post_metrics(&cred(), &public(), TWEET_ID)
                .await
                .unwrap_err(),
        );
        errors.push(r.x.probe(&cred(), &public()).await.error.unwrap());
        errors.push(r.x.list_assets(&cred()).await.unwrap_err());
    }
    // A 200 that carries only `errors`, quoting the token in every field it has.
    let only_errors = ok(json!({ "errors": [ {
        "title": format!("Not Found Error {ACCESS_TOKEN}"),
        "detail": format!("token {ACCESS_TOKEN}"),
        "message": format!("Bearer {ACCESS_TOKEN}"),
        "value": ACCESS_TOKEN,
    } ] }));
    r.mock.set("GET", &tweet(TWEET_ID), only_errors.clone());
    r.mock.set("GET", ME, only_errors.clone());
    r.mock.set("POST", TWEETS, only_errors);
    errors.push(
        r.x.post_metrics(&cred(), &public(), TWEET_ID)
            .await
            .unwrap_err(),
    );
    errors.push(r.x.account_metrics(&cred(), &public()).await.unwrap_err());
    errors.push(
        r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err(),
    );
    assert_eq!(errors.len(), 4 + 2 + 5 * 6 + 3);
    // Every path was taken: token refusals, server errors, client errors, the 200-with-errors.
    let kinds: std::collections::BTreeSet<&str> = errors.iter().map(|e| e.kind()).collect();
    assert_eq!(
        kinds,
        ["auth", "permanent", "permission", "transient"]
            .into_iter()
            .collect()
    );
    for e in &errors {
        let text = format!("{e} {e:?}");
        assert_no_secret(&text);
    }
    // The provider's words are still there around the secret.
    assert!(
        errors[0].reason().unwrap().contains("is invalid"),
        "{}",
        errors[0]
    );

    // Nor in the `Debug` of the adapter, the credential or the app.
    let printed = format!("{:?} {:?} {:?}", r.x, cred(), x_app());
    assert_no_secret(&printed);
}

// ---------------------------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------------------------

/// A pause long enough for an attempt to time out, and the attempt timeout that makes it so.
const STALL: StdDuration = StdDuration::from_millis(3_000);
const SHORT_TIMEOUT: StdDuration = StdDuration::from_millis(1_000);

#[tokio::test]
async fn post_write_transport_failure_is_unknown() {
    // A socket that closes every connection: no answer ever arrives.
    let dropper = Dropper::start().await;
    let x = connector_at(dropper.addr, TestApps::default(), StdDuration::from_secs(5));
    let count = |before: usize| dropper.accepted() - before;

    let before = dropper.accepted();
    let e = x
        .publish(&cred(), &public(), &post("Merhaba", vec![]))
        .await
        .unwrap_err();
    assert_eq!(count(before), 1, "a post is sent once");
    assert_eq!(e.kind(), "unknown", "{e}");
    assert!(!e.is_retriable());
    assert!(e.reason().unwrap().contains("outcome is unknown"), "{e}");

    let before = dropper.accepted();
    let e = x
        .publish(&cred(), &public(), &post("Merhaba", vec![png(8)]))
        .await
        .unwrap_err();
    assert_eq!(
        count(before),
        1,
        "an upload is sent once, and nothing is posted after it"
    );
    assert!(e.reason().unwrap().contains("outcome is unknown"), "{e}");

    let before = dropper.accepted();
    assert!(
        x.exchange(&OAuthApp::X(x_app()), &redirect(), CODE, Some(VERIFIER))
            .await
            .is_err()
    );
    assert_eq!(count(before), 1, "a code exchange is sent once");
    let before = dropper.accepted();
    assert!(x.refresh(&cred()).await.is_err());
    assert_eq!(count(before), 1, "a refresh is sent once");

    // Reads are tried once more, exactly.
    assert_eq!(READ_ATTEMPTS, 2);
    for (name, outcome) in [
        ("probe", {
            let before = dropper.accepted();
            let e = x.probe(&cred(), &public()).await.error.unwrap();
            (count(before), e)
        }),
        ("account_metrics", {
            let before = dropper.accepted();
            let e = x.account_metrics(&cred(), &public()).await.unwrap_err();
            (count(before), e)
        }),
        ("post_metrics", {
            let before = dropper.accepted();
            let e = x
                .post_metrics(&cred(), &public(), TWEET_ID)
                .await
                .unwrap_err();
            (count(before), e)
        }),
        ("list_assets", {
            let before = dropper.accepted();
            let e = x.list_assets(&cred()).await.unwrap_err();
            (count(before), e)
        }),
    ] {
        let (connections, e) = outcome;
        assert_eq!(connections, 2, "{name}");
        assert_eq!(e.kind(), "transient", "{name}: {e}");
        assert!(e.reason().unwrap().contains("no answer"), "{name}: {e}");
    }

    // A post that times out is not sent again either; nor one that got an error answer.
    let r = rig_with_timeout(SHORT_TIMEOUT).await;
    r.mock
        .on("POST", TWEETS, answer("tweet_created").delayed(STALL));
    let e =
        r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "unknown", "{e}");
    assert!(!e.is_retriable());
    assert!(e.reason().unwrap().contains("outcome is unknown"), "{e}");
    assert_eq!(r.mock.requests("POST", TWEETS).len(), 1);
    r.mock.clear();
    r.mock.set("POST", TWEETS, raw(500, "<html>oops</html>"));
    assert_eq!(
        kind_of(
            r.x.publish(&cred(), &public(), &post("Merhaba", vec![]))
                .await
        ),
        "transient"
    );
    assert_eq!(r.mock.requests("POST", TWEETS).len(), 1);
}

#[tokio::test]
async fn reads_retry_once_when_no_answer_arrived() {
    // A read that timed out is tried again, and the second answer is read.
    let r = rig_with_timeout(SHORT_TIMEOUT).await;
    r.mock.on("GET", ME, answer("users_me").delayed(STALL));
    r.mock.on("GET", ME, answer("users_me"));
    let result = r.x.probe(&cred(), &public()).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(r.mock.requests("GET", ME).len(), 2);

    // Twice without an answer: given up after the second.
    r.mock.clear();
    r.mock.set("GET", ME, answer("users_me").delayed(STALL));
    let e = r.x.account_metrics(&cred(), &public()).await.unwrap_err();
    assert_eq!(e.kind(), "transient", "{e}");
    assert_eq!(r.mock.requests("GET", ME).len(), 2);
}

#[tokio::test]
async fn adapter_values_print_no_secret() {
    let r = rig().await;
    let request = post("Merhaba", vec![png(64)]);
    let printed = format!("{:?} {:?} {request:?}", r.x, r.x.bases());
    assert_no_secret(&printed);
    assert!(printed.contains("<64 bytes>"), "{printed}");
}

#[tokio::test]
async fn broken_response_body_preserves_write_uncertainty() {
    let addr = broken_response(true).await;
    let x = connector_at(addr, TestApps::default(), StdDuration::from_secs(5));
    for media in [vec![], vec![png(8)]] {
        let e = x
            .publish(&cred(), &public(), &post("hello", media))
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "unknown", "{e}");
        assert!(!e.is_retriable());
    }
    assert_eq!(
        x.probe(&cred(), &public()).await.error.unwrap().kind(),
        "transient"
    );
}
