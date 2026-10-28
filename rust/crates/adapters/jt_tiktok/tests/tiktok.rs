//! The TikTok adapter against the in-process mock: hosts, Login Kit, refresh near expiry and
//! rotation, assets, probes, publishing (creator info, privacy, video chunks, photos), the status
//! a receipt resolves to, counters, the error table and retries.

mod support;

use std::time::Duration as StdDuration;

use jt_app::ports::connectors::{
    Connector, InsightsReader, MediaUpload, OAuthApp, OAuthProvider, PublishReceipt,
    PublishRequest, PublishResolution, Publisher, TiktokCreator, TiktokPost, XApp,
};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_outbound::FIXED_HOSTS;
use jt_tiktok::{
    CHUNK_BYTES, MAX_DESCRIPTION_UNITS, MAX_PHOTOS, MAX_TITLE_UNITS, PRIVACY_LEVELS, READ_ATTEMPTS,
    REFRESH_AHEAD, TIKTOK_HOSTS, TIKTOK_SCOPES, TiktokBases,
};
use serde_json::json;
use support::*;
use time::{Duration, OffsetDateTime};
use url::Url;

fn redirect() -> Url {
    Url::parse("https://panel.test/oauth/callback/tiktok").unwrap()
}

fn app() -> OAuthApp {
    OAuthApp::Tiktok(tiktok_app())
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

fn scopes() -> Vec<String> {
    TIKTOK_SCOPES.iter().map(|s| (*s).to_owned()).collect()
}

/// A video of `len` bytes.
fn clip(len: usize) -> MediaUpload {
    MediaUpload {
        bytes: (0..len).map(|i| (i % 251) as u8).collect(),
        mime: "video/mp4".into(),
        filename: "clip.mp4".into(),
    }
}

/// A video post as the Studio hands it over: chosen on the posting screen to be public.
fn video_post(text: &str, len: usize) -> PublishRequest {
    PublishRequest {
        text: text.into(),
        media: vec![clip(len)],
        tiktok: Some(choice("PUBLIC_TO_EVERYONE")),
        ..PublishRequest::default()
    }
}

fn photo_urls(n: usize) -> Vec<Url> {
    (0..n)
        .map(|i| Url::parse(&format!("https://media.jeeta.test/p/{i}.jpg")).unwrap())
        .collect()
}

fn photo_post(text: &str, n: usize) -> PublishRequest {
    PublishRequest {
        text: text.into(),
        media_urls: photo_urls(n),
        tiktok: Some(TiktokPost {
            allow_stitch: false,
            ..choice("PUBLIC_TO_EVERYONE")
        }),
        ..PublishRequest::default()
    }
}

/// `request` with the screen's privacy chosen as `privacy`.
fn privately(mut request: PublishRequest, privacy: &str) -> PublishRequest {
    request.privacy = Some(privacy.into());
    if let Some(post) = &mut request.tiktok {
        post.privacy_level = privacy.into();
    }
    request
}

/// `request` with the screen's choice changed by `change`.
fn chosen(mut request: PublishRequest, change: impl FnOnce(&mut TiktokPost)) -> PublishRequest {
    change(request.tiktok.as_mut().expect("a choice"));
    request
}

fn receipt(id: &str) -> PublishReceipt {
    PublishReceipt {
        external_id: id.into(),
        url: None,
    }
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

/// Asserts `at` is `seconds` after some instant between `before` and now.
fn assert_expires_in(at: Option<OffsetDateTime>, seconds: i64, before: OffsetDateTime) {
    let after = OffsetDateTime::now_utc();
    let at = at.expect("an expiry");
    assert!(
        at >= before + Duration::seconds(seconds) - Duration::seconds(1)
            && at <= after + Duration::seconds(seconds) + Duration::seconds(1),
        "{at} is not {seconds} s after the call"
    );
}

const JSON_UTF8: &str = "application/json; charset=UTF-8";

const NOT_OFFERED: &str =
    "privacy level PUBLIC_TO_EVERYONE not available (app not audited or private account)";

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn hosts_are_the_fixed_tiktok_entries() {
    let r = rig().await;
    let fixed: Vec<&str> = FIXED_HOSTS
        .iter()
        .filter(|h| h.connector == "tiktok")
        .map(|h| h.host)
        .collect();
    assert_eq!(TIKTOK_HOSTS, fixed.as_slice());
    assert_eq!(r.tt.hosts(), fixed.as_slice());
    assert_eq!(r.tt.provider(), Provider::Tiktok);
    assert_eq!(Provider::Tiktok.kinds(), ["tiktok"]);
    let production = TiktokBases::production();
    assert_eq!(production.api.as_str(), "https://open.tiktokapis.com/");
    assert_eq!(production.authorize.as_str(), "https://www.tiktok.com/");
    assert!(fixed.contains(&production.api.host_str().unwrap()));
    assert!(fixed.contains(&"open-upload.tiktokapis.com"));
    assert!(fixed.contains(&"open-upload-sg.tiktokapis.com"));
    // The authorize dialog is only for browsers.
    assert!(!fixed.contains(&production.authorize.host_str().unwrap()));
}

// ---------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn authorize_url_uses_client_key_and_comma_scopes() {
    let r = rig().await;
    let url =
        r.tt.authorize_url(&app(), &redirect(), "state-1", None)
            .unwrap();
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("www.tiktok.com"));
    assert_eq!(url.path(), "/v2/auth/authorize/");
    assert_eq!(
        pairs(&url),
        owned(&[
            ("client_key", CLIENT_KEY),
            ("response_type", "code"),
            (
                "scope",
                "user.info.basic,video.publish,video.list,user.info.stats"
            ),
            ("redirect_uri", redirect().as_str()),
            ("state", "state-1"),
        ])
    );
    assert_eq!(
        TIKTOK_SCOPES,
        [
            "user.info.basic",
            "video.publish",
            "video.list",
            "user.info.stats"
        ]
    );
    // The commas stand as TikTok writes them.
    let query = url.query().unwrap();
    assert!(
        query.contains("scope=user.info.basic,video.publish,video.list,user.info.stats&"),
        "{query}"
    );
    assert!(!url.as_str().contains(CLIENT_SECRET), "{url}");

    // The web flow takes no PKCE: a challenge given changes nothing.
    let with_challenge =
        r.tt.authorize_url(&app(), &redirect(), "state-1", Some("challenge-1"))
            .unwrap();
    assert_eq!(with_challenge, url);
    assert!(!with_challenge.as_str().contains("challenge"));

    // Another provider's app is not TikTok's.
    let x = OAuthApp::X(XApp {
        client_id: "x".into(),
        client_secret: "x-SECRET".into(),
    });
    assert_eq!(
        kind_of(r.tt.authorize_url(&x, &redirect(), "s", None)),
        "permanent"
    );
    assert_eq!(
        kind_of(r.tt.exchange(&x, &redirect(), CODE, None).await),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn exchange_builds_oauth_credential_with_expiry() {
    let r = rig().await;
    r.mock.on("POST", TOKEN, answer("token"));
    let before = OffsetDateTime::now_utc();
    // A verifier given is not sent: the web flow takes none.
    let cred =
        r.tt.exchange(&app(), &redirect(), CODE, Some("verifier-unused"))
            .await
            .unwrap();
    let call = r.mock.request("POST", TOKEN);
    assert_eq!(
        call.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(call.header("authorization"), None);
    assert!(call.query.is_empty(), "{:?}", call.query);
    assert_eq!(
        call.form(),
        owned(&[
            ("client_key", CLIENT_KEY),
            ("client_secret", CLIENT_SECRET),
            ("code", CODE),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect().as_str()),
        ])
    );
    let (access, refresh, expires_at, granted) = oauth(&cred);
    assert_eq!(access, "act.tt-access-SECRET-1");
    assert_eq!(refresh, Some("rft.tt-refresh-SECRET-1"));
    assert_expires_in(expires_at, 86_400, before);
    assert_eq!(granted, scopes().as_slice());

    // An answer that names no scopes is taken to grant those asked for; one without an access
    // token is refused.
    r.mock.set(
        "POST",
        TOKEN,
        ok(json!({ "access_token": "act.tt-access-SECRET-1", "refresh_token": "rft.tt-refresh-SECRET-1" })),
    );
    let cred =
        r.tt.exchange(&app(), &redirect(), CODE, None)
            .await
            .unwrap();
    let (_, _, expires_at, granted) = oauth(&cred);
    assert_eq!(expires_at, None);
    assert_eq!(granted, scopes().as_slice());
    r.mock
        .set("POST", TOKEN, ok(json!({ "token_type": "Bearer" })));
    assert_eq!(
        kind_of(r.tt.exchange(&app(), &redirect(), CODE, None).await),
        "permanent"
    );
    // A spent or wrong code: `Auth`; the platform's client refused: the platform's problem.
    for (reply, expected, reason) in [
        (
            answer_with(400, "token_invalid_grant"),
            "auth",
            Some("HTTP 400 invalid_grant: Authorization code is expired."),
        ),
        (
            answer("token_invalid_grant"),
            "auth",
            Some("HTTP 200 invalid_grant: Authorization code is expired."),
        ),
        (
            answer_with(401, "token_invalid_client"),
            "permanent",
            Some("platform client credentials rejected"),
        ),
        (
            answer("token_invalid_client"),
            "permanent",
            Some("platform client credentials rejected"),
        ),
        (
            status(
                400,
                json!({ "error": "invalid_request", "error_description": "Redirect_uri is not matched." }),
            ),
            "permanent",
            Some("HTTP 400 invalid_request: Redirect_uri is not matched."),
        ),
        (
            status(429, json!({ "error": "rate_limited" })),
            "throttle",
            None,
        ),
        (
            raw(502, "<html>bad gateway</html>"),
            "transient",
            Some("HTTP 502 with an unreadable body"),
        ),
    ] {
        r.mock.set("POST", TOKEN, reply.clone());
        let e =
            r.tt.exchange(&app(), &redirect(), CODE, None)
                .await
                .unwrap_err();
        assert_eq!((e.kind(), e.reason()), (expected, reason), "{reply:?}");
    }
    // A blank code is refused before any call.
    r.mock.clear();
    assert_eq!(
        kind_of(r.tt.exchange(&app(), &redirect(), " ", None).await),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn refresh_rotates_refresh_token() {
    let r = rig().await;
    r.mock.on("POST", TOKEN, answer("token_refreshed"));
    let before = OffsetDateTime::now_utc();
    let near = cred_expiring_in(Duration::hours(5));
    let new =
        r.tt.refresh(&near)
            .await
            .unwrap()
            .expect("a new credential");
    let call = r.mock.request("POST", TOKEN);
    assert_eq!(
        call.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(
        call.form(),
        owned(&[
            ("client_key", CLIENT_KEY),
            ("client_secret", CLIENT_SECRET),
            ("grant_type", "refresh_token"),
            ("refresh_token", REFRESH_TOKEN),
        ])
    );
    let (access, refresh, expires_at, granted) = oauth(&new);
    assert_eq!(access, "act.tt-access-SECRET-2");
    // TikTok's new refresh token replaces the one sent.
    assert_eq!(refresh, Some("rft.tt-refresh-SECRET-2"));
    assert_expires_in(expires_at, 86_400, before);
    assert_eq!(granted, ["user.info.basic", "video.publish"]);

    // An answer without a refresh token keeps the one held, and its scopes.
    r.mock.set(
        "POST",
        TOKEN,
        ok(json!({ "access_token": "act.tt-access-SECRET-3", "expires_in": 86400 })),
    );
    let kept = r.tt.refresh(&near).await.unwrap().unwrap();
    let (access, refresh, _, granted) = oauth(&kept);
    assert_eq!(
        (access, refresh),
        ("act.tt-access-SECRET-3", Some(REFRESH_TOKEN))
    );
    assert_eq!(granted, scopes().as_slice());

    // A spent or revoked refresh token: the owner must reconnect.
    for (reply, expected) in [
        (
            status(
                400,
                json!({ "error": "invalid_grant", "error_description": "Refresh token is invalid or expired." }),
            ),
            "auth",
        ),
        (raw(401, "<html>no</html>"), "auth"),
        (answer_with(401, "token_invalid_client"), "permanent"),
        (raw(429, "slow down"), "throttle"),
        (raw(503, "<html>unavailable</html>"), "transient"),
        (
            status(400, json!({ "error": "temporarily_unavailable" })),
            "transient",
        ),
        (
            status(400, json!({ "error": "unsupported_grant_type" })),
            "permanent",
        ),
    ] {
        r.mock.set("POST", TOKEN, reply.clone());
        let e = r.tt.refresh(&near).await.unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
        assert_no_secret(&format!("{e} {e:?}"));
    }
}

#[tokio::test]
async fn refresh_waits_until_near_expiry() {
    let r = rig().await;
    r.mock.on("POST", TOKEN, answer("token_refreshed"));
    assert_eq!(REFRESH_AHEAD, Duration::hours(6));
    // Far from expiry: nothing to do, nothing sent (the job calls every hour).
    for far in [cred(), cred_expiring_in(Duration::hours(7))] {
        assert_eq!(r.tt.refresh(&far).await.unwrap(), None);
    }
    let without = |expires_at: Option<OffsetDateTime>| Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: None,
        expires_at,
        scopes: scopes(),
    };
    assert_eq!(
        r.tt.refresh(&without(Some(
            OffsetDateTime::now_utc() + Duration::hours(12)
        )))
        .await
        .unwrap(),
        None
    );
    assert!(r.mock.recorded().is_empty());

    // Within the window, past it, or without an expiry: renewed.
    let with = |expires_at: Option<OffsetDateTime>| Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at,
        scopes: scopes(),
    };
    let now = OffsetDateTime::now_utc();
    for due in [
        with(Some(now + Duration::hours(5))),
        with(Some(now - Duration::hours(1))),
        with(None),
    ] {
        assert!(r.tt.refresh(&due).await.unwrap().is_some(), "{due:?}");
    }
    assert_eq!(r.mock.requests("POST", TOKEN).len(), 3);

    // Due without a refresh token: reconnect. Not an OAuth credential: refused. No app: refused.
    r.mock.clear();
    for e in [
        r.tt.refresh(&without(None)).await.unwrap_err(),
        r.tt.refresh(&without(Some(now + Duration::hours(1))))
            .await
            .unwrap_err(),
    ] {
        assert_eq!(e.kind(), "auth", "{e}");
    }
    let foreign = Credential::PageToken {
        page_id: "1".into(),
        token: "EAAB-SECRET".into(),
    };
    assert_eq!(kind_of(r.tt.refresh(&foreign).await), "permanent");
    let unconfigured = rig_with(TestApps { tiktok: None }, jt_tiktok::ATTEMPT_TIMEOUT).await;
    assert_eq!(
        kind_of(unconfigured.tt.refresh(&with(None)).await),
        "permanent"
    );
    assert_eq!(unconfigured.tt.refresh(&cred()).await.unwrap(), None);
    assert!(r.mock.recorded().is_empty());
    assert!(unconfigured.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Assets and probe
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn list_assets_offer_the_one_account() {
    let r = rig().await;
    r.mock.on("GET", USER_INFO, answer("user_info"));
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    let assets = r.tt.list_assets(&cred()).await.unwrap();
    assert_eq!(assets.len(), 1);
    let asset = &assets[0];
    assert_eq!(asset.kind_key, "tiktok");
    assert_eq!(asset.external_id, OPEN_ID);
    assert_eq!(asset.name, DISPLAY_NAME);
    // The asset carries the credential it was listed with.
    assert_eq!(oauth(&asset.credential).0, ACCESS_TOKEN);
    assert_eq!(
        asset.public,
        json!({ "username": USERNAME, "display_name": DISPLAY_NAME })
    );
    let call = r.mock.request("GET", USER_INFO);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.query, owned(&[("fields", "open_id,display_name")]));

    // Without a display name the username names it; without the username lookup, no username.
    r.mock.set(
        "GET",
        USER_INFO,
        ok(json!({ "data": { "user": { "open_id": OPEN_ID } }, "error": { "code": "ok" } })),
    );
    let assets = r.tt.list_assets(&cred()).await.unwrap();
    assert_eq!(assets[0].name, "@jeeta_test");
    r.mock
        .set("POST", CREATOR_INFO, answer_with(401, "error_scope"));
    let assets = r.tt.list_assets(&cred()).await.unwrap();
    assert_eq!(assets[0].name, OPEN_ID);
    assert_eq!(assets[0].public, json!({}));
}

#[tokio::test]
async fn probe_binds_open_id_as_account_id() {
    let r = rig().await;
    r.mock.on("GET", USER_INFO, answer("user_info"));
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    // Whatever the capability claims, the probe names the credential's own account.
    let mut claims = public();
    claims["external_id"] = json!("someone-else-open-id");
    let result = r.tt.probe(&cred(), &claims).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(result.error, None);
    assert_eq!(
        result.facts,
        json!({ "account_id": OPEN_ID, "display_name": DISPLAY_NAME, "username": USERNAME })
    );
    assert!(result.facts["account_id"].is_string());
    let call = r.mock.request("GET", USER_INFO);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.param("fields"), Some("open_id,display_name"));
    for call in r.mock.recorded() {
        assert!(!format!("{call:?}").contains("someone-else"), "{call:?}");
    }

    // The username lookup failing (no `video.publish` yet) leaves the username out only.
    r.mock
        .set("POST", CREATOR_INFO, answer_with(401, "error_scope"));
    let result = r.tt.probe(&cred(), &public()).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(
        result.facts,
        json!({ "account_id": OPEN_ID, "display_name": DISPLAY_NAME })
    );

    // An answer without an open id fails; a refused token is `Auth`, with no facts.
    r.mock.set(
        "GET",
        USER_INFO,
        ok(json!({ "data": { "user": { "display_name": "x" } }, "error": { "code": "ok" } })),
    );
    let result = r.tt.probe(&cred(), &public()).await;
    assert!(!result.ok);
    assert_eq!(
        result.error.as_ref().map(ConnectorError::kind),
        Some("permanent")
    );
    r.mock.set("GET", USER_INFO, answer_with(401, "error_auth"));
    let result = r.tt.probe(&cred(), &public()).await;
    assert!(!result.ok);
    assert_eq!(
        result.error.as_ref().map(ConnectorError::kind),
        Some("auth")
    );
    assert_eq!(result.facts, json!({}));

    // No OAuth credential: refused without a call.
    r.mock.clear();
    let foreign = Credential::NetgsmSms {
        usercode: "1".into(),
        password: "pw-SECRET".into(),
        msgheader: "H".into(),
    };
    let result = r.tt.probe(&foreign, &public()).await;
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
async fn creator_info_is_queried_before_every_post() {
    let r = rig().await;
    script_video(&r.mock);
    r.mock.on("POST", CONTENT_INIT, answer("photo_init"));
    for _ in 0..2 {
        r.tt.publish(&cred(), &public(), &video_post("Merhaba", 1_000))
            .await
            .unwrap();
    }
    r.tt.publish(&cred(), &public(), &photo_post("Merhaba", 1))
        .await
        .unwrap();
    assert_eq!(
        r.mock.lines(),
        [
            format!("POST {CREATOR_INFO}"),
            format!("POST {VIDEO_INIT}"),
            format!("PUT {UPLOAD}"),
            format!("POST {CREATOR_INFO}"),
            format!("POST {VIDEO_INIT}"),
            format!("PUT {UPLOAD}"),
            format!("POST {CREATOR_INFO}"),
            format!("POST {CONTENT_INIT}"),
        ]
    );
    for call in r.mock.requests("POST", CREATOR_INFO) {
        assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
        assert_eq!(call.header("content-type"), Some(JSON_UTF8));
        assert!(call.bytes.is_empty(), "{}", call.body());
        assert!(call.query.is_empty());
    }
}

#[tokio::test]
async fn public_privacy_refused_when_not_offered() {
    let r = rig().await;
    // An app TikTok has not audited: SELF_ONLY is all it is offered.
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_self_only"));
    r.mock.on("POST", VIDEO_INIT, video_init(&r.mock));
    r.mock.on("POST", CONTENT_INIT, answer("photo_init"));
    for request in [
        video_post("Merhaba", 1_000),
        photo_post("Merhaba", 2),
        privately(video_post("Merhaba", 1_000), "PUBLIC_TO_EVERYONE"),
    ] {
        let e =
            r.tt.publish(&cred(), &public(), &request)
                .await
                .unwrap_err();
        assert_eq!((e.kind(), e.reason()), ("permission", Some(NOT_OFFERED)));
    }
    let e =
        r.tt.publish(
            &cred(),
            &public(),
            &privately(video_post("Merhaba", 1_000), "MUTUAL_FOLLOW_FRIENDS"),
        )
        .await
        .unwrap_err();
    assert_eq!(
        e.reason(),
        Some(
            "privacy level MUTUAL_FOLLOW_FRIENDS not available (app not audited or private account)"
        )
    );
    // Only the creator's settings were read: nothing was posted, nothing uploaded.
    assert_eq!(r.mock.lines(), vec![format!("POST {CREATOR_INFO}"); 4]);

    // A creator info with no options at all offers nothing.
    r.mock.clear();
    r.mock.set(
        "POST",
        CREATOR_INFO,
        ok(json!({ "data": { "creator_username": USERNAME }, "error": { "code": "ok" } })),
    );
    assert_eq!(
        kind_of(
            r.tt.publish(
                &cred(),
                &public(),
                &privately(video_post("x", 10), "SELF_ONLY")
            )
            .await
        ),
        "permission"
    );
    assert_eq!(r.mock.lines(), [format!("POST {CREATOR_INFO}")]);
}

#[tokio::test]
async fn self_only_is_posted_when_asked_and_offered() {
    let r = rig().await;
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_self_only"));
    r.mock.on("POST", VIDEO_INIT, video_init(&r.mock));
    r.mock.on("PUT", UPLOAD, complete());
    let receipt =
        r.tt.publish(
            &cred(),
            &public(),
            &privately(video_post("Merhaba", 1_000), "SELF_ONLY"),
        )
        .await
        .unwrap();
    assert_eq!(receipt, self::receipt(PUBLISH_ID));
    let init = r.mock.request("POST", VIDEO_INIT).json();
    assert_eq!(
        init["post_info"],
        json!({
            "title": "Merhaba",
            "privacy_level": "SELF_ONLY",
            // On only what the human allowed (comments, stitches) and the creator did not turn
            // off (this creator turned both off).
            "disable_comment": true,
            "disable_duet": true,
            "disable_stitch": true,
            "brand_content_toggle": false,
            "brand_organic_toggle": false,
        })
    );
    assert_eq!(
        PRIVACY_LEVELS,
        [
            "PUBLIC_TO_EVERYONE",
            "MUTUAL_FOLLOW_FRIENDS",
            "FOLLOWER_OF_CREATOR",
            "SELF_ONLY"
        ]
    );
}

#[tokio::test]
async fn nothing_is_posted_without_the_posting_screens_choice() {
    let r = rig().await;
    script_video(&r.mock);
    r.mock.on("POST", CONTENT_INIT, answer("photo_init"));
    for mut request in [video_post("Merhaba", 1_000), photo_post("Merhaba", 1)] {
        // Not even a privacy named alongside: the adapter never picks one.
        request.tiktok = None;
        request.privacy = Some("PUBLIC_TO_EVERYONE".into());
        let e =
            r.tt.publish(&cred(), &public(), &request)
                .await
                .unwrap_err();
        assert_eq!(e.kind(), "permanent");
        assert_eq!(
            e.reason(),
            Some(
                "a TikTok post needs what a human chose on its posting screen (privacy, \
                 interactions, commercial content)"
            )
        );
    }
    assert!(r.mock.recorded().is_empty(), "{:?}", r.mock.lines());
}

#[tokio::test]
async fn the_posting_screens_choice_is_what_is_sent() {
    let r = rig().await;
    script_video(&r.mock);
    r.mock.on("POST", CONTENT_INIT, answer("photo_init"));
    let request = chosen(video_post("Merhaba", 1_000), |post| {
        post.allow_comment = false;
        post.allow_duet = true;
        post.allow_stitch = false;
        post.disclose_commercial = true;
        post.your_brand = true;
        post.branded_content = true;
    });
    r.tt.publish(&cred(), &public(), &request).await.unwrap();
    assert_eq!(
        r.mock.request("POST", VIDEO_INIT).json()["post_info"],
        json!({
            "title": "Merhaba",
            "privacy_level": "PUBLIC_TO_EVERYONE",
            "disable_comment": true,
            // Allowed, but the creator turned duets off: TikTok's settings win.
            "disable_duet": true,
            "disable_stitch": true,
            "brand_content_toggle": true,
            "brand_organic_toggle": true,
        })
    );
    let request = chosen(photo_post("Merhaba", 1), |post| {
        post.privacy_level = "MUTUAL_FOLLOW_FRIENDS".into();
        post.allow_comment = false;
        post.disclose_commercial = true;
        post.your_brand = true;
    });
    r.tt.publish(&cred(), &public(), &request).await.unwrap();
    assert_eq!(
        r.mock.request("POST", CONTENT_INIT).json()["post_info"],
        json!({
            "description": "Merhaba",
            "privacy_level": "MUTUAL_FOLLOW_FRIENDS",
            "disable_comment": true,
            "brand_content_toggle": false,
            "brand_organic_toggle": true,
        })
    );
}

#[tokio::test]
async fn a_choice_tiktok_would_refuse_is_refused_before_anything_is_posted() {
    let r = rig().await;
    script_video(&r.mock);
    let branded_private = chosen(video_post("x", 10), |post| {
        post.privacy_level = "SELF_ONLY".into();
        post.disclose_commercial = true;
        post.branded_content = true;
    });
    let unspecified = chosen(video_post("x", 10), |post| post.disclose_commercial = true);
    let undisclosed = chosen(video_post("x", 10), |post| post.your_brand = true);
    let unchosen = privately(video_post("x", 10), "");
    // `creator_info_public` allows videos of up to 600 s.
    let mut long = video_post("x", 10);
    long.media = vec![mp4(601, 4_096)];
    let mut at_limit = video_post("x", 10);
    at_limit.media = vec![mp4(600, 4_096)];
    for (request, reason) in [
        (
            &branded_private,
            "branded content cannot be private (SELF_ONLY)",
        ),
        (
            &unspecified,
            "the commercial content disclosure names neither your brand nor branded content",
        ),
        (
            &undisclosed,
            "your brand or branded content chosen without the commercial content disclosure",
        ),
        (
            &unchosen,
            "no privacy level was chosen on the posting screen",
        ),
        (
            &long,
            "the video is 601 s long; this TikTok account posts videos of at most 600 s",
        ),
    ] {
        let e = r.tt.publish(&cred(), &public(), request).await.unwrap_err();
        assert_eq!((e.kind(), e.reason()), ("permanent", Some(reason)));
    }
    // Only the creator's settings were read (nothing for the unchosen privacy): nothing posted.
    assert_eq!(r.mock.lines(), vec![format!("POST {CREATOR_INFO}"); 4]);
    r.tt.publish(&cred(), &public(), &at_limit).await.unwrap();
    assert_eq!(r.mock.request("PUT", UPLOAD).bytes, mp4(600, 4_096).bytes);
}

#[tokio::test]
async fn the_posting_screen_reads_the_creator_fresh() {
    let r = rig().await;
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    let expected = TiktokCreator {
        nickname: Some(DISPLAY_NAME.into()),
        username: Some(USERNAME.into()),
        avatar_url: Some(Url::parse("https://p16-sign-va.tiktokcdn.test/avatar.jpeg").unwrap()),
        privacy_level_options: vec![
            "PUBLIC_TO_EVERYONE".into(),
            "MUTUAL_FOLLOW_FRIENDS".into(),
            "SELF_ONLY".into(),
        ],
        comment_disabled: false,
        duet_disabled: true,
        stitch_disabled: false,
        max_video_post_duration_sec: Some(600),
        cannot_post: None,
    };
    for _ in 0..2 {
        assert_eq!(
            r.tt.creator_info(&cred(), &public()).await.unwrap(),
            Some(expected.clone())
        );
    }
    assert_eq!(r.mock.lines(), vec![format!("POST {CREATOR_INFO}"); 2]);
    for call in r.mock.requests("POST", CREATOR_INFO) {
        assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
        assert_eq!(call.header("content-type"), Some(JSON_UTF8));
    }

    // An account that may not post at this moment says why (TikTok answers it with HTTP 200).
    r.mock.set("POST", CREATOR_INFO, answer("error_spam"));
    let busy =
        r.tt.creator_info(&cred(), &public())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        busy.cannot_post.as_deref(),
        Some("spam_risk_too_many_posts")
    );
    for code in [
        "spam_risk_user_banned_from_posting",
        "reached_active_user_cap",
    ] {
        r.mock.set(
            "POST",
            CREATOR_INFO,
            ok(json!({ "data": {}, "error": { "code": code, "message": "" } })),
        );
        let creator =
            r.tt.creator_info(&cred(), &public())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(creator.cannot_post.as_deref(), Some(code));
        assert!(creator.privacy_level_options.is_empty());
    }

    // Only an https avatar is named: the screen shows it as an image.
    let mut body = fixture("creator_info_public");
    body["data"]["creator_avatar_url"] = json!("javascript:alert(1)");
    r.mock.set("POST", CREATOR_INFO, ok(body));
    let creator =
        r.tt.creator_info(&cred(), &public())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(creator.avatar_url, None);
    assert_eq!(creator.nickname.as_deref(), Some(DISPLAY_NAME));

    // A dead token or a missing scope is an error, not an account that may not post.
    r.mock
        .set("POST", CREATOR_INFO, answer_with(401, "error_auth"));
    assert_eq!(kind_of(r.tt.creator_info(&cred(), &public()).await), "auth");
    r.mock
        .set("POST", CREATOR_INFO, answer_with(401, "error_scope"));
    assert_eq!(
        kind_of(r.tt.creator_info(&cred(), &public()).await),
        "permission"
    );
    // Another kind is refused before anything is called.
    r.mock.clear();
    let mut x = public();
    x["kind_key"] = json!("x");
    assert_eq!(kind_of(r.tt.creator_info(&cred(), &x).await), "permanent");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn video_init_then_chunked_upload_content_range() {
    let r = rig().await;
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    r.mock.on("POST", VIDEO_INIT, video_init(&r.mock));
    r.mock.on("PUT", UPLOAD, partial());
    r.mock.on("PUT", UPLOAD, complete());
    let size = 2 * CHUNK_BYTES as usize + 12_345;
    let mut request = video_post("Yeni menü", size);
    request.link = Some(Url::parse("https://jeeta.test/menu").unwrap());
    let receipt = r.tt.publish(&cred(), &public(), &request).await.unwrap();
    assert_eq!(receipt, self::receipt(PUBLISH_ID));
    assert_eq!(
        r.mock.lines(),
        [
            format!("POST {CREATOR_INFO}"),
            format!("POST {VIDEO_INIT}"),
            format!("PUT {UPLOAD}"),
            format!("PUT {UPLOAD}"),
        ]
    );

    let init = r.mock.request("POST", VIDEO_INIT);
    assert_eq!(init.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(init.header("content-type"), Some(JSON_UTF8));
    assert_eq!(
        init.json(),
        json!({
            "post_info": {
                "title": "Yeni menü\n\nhttps://jeeta.test/menu",
                "privacy_level": "PUBLIC_TO_EVERYONE",
                "disable_comment": false,
                "disable_duet": true,
                "disable_stitch": false,
                "brand_content_toggle": false,
                "brand_organic_toggle": false,
            },
            "source_info": {
                "source": "FILE_UPLOAD",
                "video_size": size,
                "chunk_size": CHUNK_BYTES,
                "total_chunk_count": 2,
            },
        })
    );

    let puts = r.mock.requests("PUT", UPLOAD);
    let total = size as u64;
    let ranges = [(0, CHUNK_BYTES - 1), (CHUNK_BYTES, total - 1)];
    let mut sent = Vec::new();
    for (call, (first, last)) in puts.iter().zip(ranges) {
        // The upload URL is used as is, and carries its own authority: no access token.
        assert_eq!(call.param("upload_token"), Some(UPLOAD_TOKEN));
        assert_eq!(call.header("authorization"), None);
        assert_eq!(call.header("content-type"), Some("video/mp4"));
        assert_eq!(
            call.header("content-length"),
            Some((last - first + 1).to_string().as_str())
        );
        assert_eq!(
            call.header("content-range"),
            Some(format!("bytes {first}-{last}/{total}").as_str())
        );
        assert_eq!(call.bytes.len() as u64, last - first + 1);
        sent.extend_from_slice(&call.bytes);
    }
    // The last chunk took the bytes left over.
    assert_eq!(puts[1].bytes.len(), CHUNK_BYTES as usize + 12_345);
    assert_eq!(sent, clip(size).bytes);
}

#[tokio::test]
async fn a_small_video_goes_in_one_chunk() {
    let r = rig().await;
    script_video(&r.mock);
    // No text: no title.
    r.tt.publish(&cred(), &public(), &video_post(" ", 1_000))
        .await
        .unwrap();
    let init = r.mock.request("POST", VIDEO_INIT).json();
    assert!(init["post_info"].get("title").is_none(), "{init}");
    assert_eq!(
        init["source_info"],
        json!({ "source": "FILE_UPLOAD", "video_size": 1000, "chunk_size": 1000, "total_chunk_count": 1 })
    );
    let put = r.mock.request("PUT", UPLOAD);
    assert_eq!(put.header("content-range"), Some("bytes 0-999/1000"));
    assert_eq!(put.bytes, clip(1_000).bytes);

    // The media type is read ignoring case and surrounding space.
    r.mock.clear();
    let mut request = video_post("Merhaba", 64);
    request.media[0].mime = " Video/MP4 ".into();
    r.tt.publish(&cred(), &public(), &request).await.unwrap();
    assert_eq!(
        r.mock.request("PUT", UPLOAD).header("content-type"),
        Some("video/mp4")
    );
}

#[tokio::test]
async fn photo_uses_pull_from_url() {
    let r = rig().await;
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    r.mock.on("POST", CONTENT_INIT, answer("photo_init"));
    let mut request = photo_post("Bugünün menüsü", 2);
    request.link = Some(Url::parse("https://jeeta.test/menu").unwrap());
    let receipt = r.tt.publish(&cred(), &public(), &request).await.unwrap();
    assert_eq!(receipt, self::receipt(PHOTO_PUBLISH_ID));
    let call = r.mock.request("POST", CONTENT_INIT);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.header("content-type"), Some(JSON_UTF8));
    assert_eq!(
        call.json(),
        json!({
            "media_type": "PHOTO",
            "post_mode": "DIRECT_POST",
            "post_info": {
                "description": "Bugünün menüsü\n\nhttps://jeeta.test/menu",
                "privacy_level": "PUBLIC_TO_EVERYONE",
                "disable_comment": false,
                "brand_content_toggle": false,
                "brand_organic_toggle": false,
            },
            "source_info": {
                "source": "PULL_FROM_URL",
                "photo_cover_index": 0,
                "photo_images": [
                    "https://media.jeeta.test/p/0.jpg",
                    "https://media.jeeta.test/p/1.jpg",
                ],
            },
        })
    );
    assert!(r.mock.requests("POST", VIDEO_INIT).is_empty());
    assert!(r.mock.requests("PUT", UPLOAD).is_empty());

    // As many as TikTok takes.
    r.tt.publish(&cred(), &public(), &photo_post("", MAX_PHOTOS))
        .await
        .unwrap();
    let last = r.mock.requests("POST", CONTENT_INIT).pop().unwrap().json();
    assert_eq!(
        last["source_info"]["photo_images"]
            .as_array()
            .unwrap()
            .len(),
        MAX_PHOTOS
    );
    assert!(last["post_info"].get("description").is_none(), "{last}");

    // An accepted init without a publish id may have posted: `Unknown`.
    r.mock.set(
        "POST",
        CONTENT_INIT,
        ok(json!({ "data": {}, "error": { "code": "ok" } })),
    );
    assert_eq!(
        kind_of(r.tt.publish(&cred(), &public(), &photo_post("x", 1)).await),
        "unknown"
    );
    // TikTok's refusal of an unverified media domain is its own words.
    r.mock.set(
        "POST",
        CONTENT_INIT,
        answer_with(403, "error_url_ownership"),
    );
    let e =
        r.tt.publish(&cred(), &public(), &photo_post("x", 1))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(
        e.reason()
            .unwrap()
            .starts_with("HTTP 403 url_ownership_unverified: To use PULL_FROM_URL"),
        "{e}"
    );
}

#[tokio::test]
async fn post_shape_is_checked_before_anything_is_sent() {
    let r = rig().await;
    script_video(&r.mock);
    r.mock.clear();
    let mut both = video_post("x", 10);
    both.media_urls = photo_urls(1);
    let mut two_videos = video_post("x", 10);
    two_videos.media.push(clip(10));
    let mut image_bytes = video_post("x", 10);
    image_bytes.media[0].mime = "image/jpeg".into();
    let mut plain_http = photo_post("x", 1);
    plain_http.media_urls = vec![Url::parse("http://media.jeeta.test/a.jpg").unwrap()];
    let mut long_title = video_post(&"a".repeat(MAX_TITLE_UNITS - 10), 10);
    long_title.link = Some(Url::parse("https://jeeta.test/a-link").unwrap());
    let refused: Vec<(&str, PublishRequest, Option<&str>)> = vec![
        (
            "text alone",
            PublishRequest {
                text: "Merhaba".into(),
                ..PublishRequest::default()
            },
            Some("a TikTok post is a video or photos: text alone cannot be posted"),
        ),
        (
            "a link alone",
            PublishRequest {
                link: Some(Url::parse("https://jeeta.test/").unwrap()),
                ..PublishRequest::default()
            },
            Some("a TikTok post is a video or photos: text alone cannot be posted"),
        ),
        (
            "a video and photos",
            both,
            Some("a TikTok post is one uploaded video or photos by URL, not both"),
        ),
        (
            "two videos",
            two_videos,
            Some("a TikTok post carries one video"),
        ),
        (
            "image bytes",
            image_bytes,
            Some("TikTok takes one video/mp4 upload; photos go by URL"),
        ),
        (
            "an empty video",
            video_post("x", 0),
            Some("the video is empty"),
        ),
        (
            "too many photos",
            photo_post("x", MAX_PHOTOS + 1),
            Some("a TikTok post carries at most 35 photos"),
        ),
        (
            "a plain http photo",
            plain_http,
            Some("TikTok pulls photos over https only"),
        ),
        ("a long title", long_title, None),
        (
            "a long description",
            photo_post(&"ğ".repeat(MAX_DESCRIPTION_UNITS + 1), 1),
            None,
        ),
        (
            "an unknown privacy",
            privately(video_post("x", 10), "FRIENDS"),
            Some("not a TikTok privacy level"),
        ),
        (
            "a privacy named otherwise than TikTok does",
            privately(video_post("x", 10), " self_only "),
            Some("not a TikTok privacy level"),
        ),
    ];
    for (what, request, reason) in &refused {
        let e =
            r.tt.publish(&cred(), &public(), request)
                .await
                .expect_err(what);
        assert_eq!(e.kind(), "permanent", "{what}: {e}");
        if let Some(reason) = reason {
            assert_eq!(e.reason(), Some(*reason), "{what}");
        }
    }
    let e =
        r.tt.publish(&cred(), &public(), &refused[8].1)
            .await
            .unwrap_err();
    assert!(
        e.reason().unwrap().contains("at most 2200 UTF-16 units"),
        "{e}"
    );
    // No OAuth credential.
    let foreign = Credential::PageToken {
        page_id: "1".into(),
        token: "EAAB-SECRET".into(),
    };
    assert_eq!(
        kind_of(
            r.tt.publish(&foreign, &public(), &video_post("x", 10))
                .await
        ),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty(), "{:?}", r.mock.lines());

    // At the limits, it goes: a title of 2200 UTF-16 units (an emoji counts two).
    let at_limit = video_post(&format!("{}😀", "a".repeat(MAX_TITLE_UNITS - 2)), 10);
    r.tt.publish(&cred(), &public(), &at_limit).await.unwrap();
}

#[tokio::test]
async fn an_upload_url_off_the_tiktok_hosts_is_refused() {
    let r = rig().await;
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    let mut init = fixture("video_init");
    init["data"]["upload_url"] =
        json!("https://upload.elsewhere.test/video/?upload_token=tt-upload-SECRET-0");
    r.mock.on("POST", VIDEO_INIT, ok(init));
    let e =
        r.tt.publish(&cred(), &public(), &video_post("x", 10))
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        (
            "permanent",
            Some("the TikTok host is not allowed for the tiktok connector")
        )
    );
    // An init answer without an upload URL can upload nothing.
    r.mock.set(
        "POST",
        VIDEO_INIT,
        ok(json!({ "data": { "publish_id": PUBLISH_ID }, "error": { "code": "ok" } })),
    );
    let e =
        r.tt.publish(&cred(), &public(), &video_post("x", 10))
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        ("permanent", Some("the provider's answer has no upload URL"))
    );
    assert!(r.mock.requests("PUT", UPLOAD).is_empty());
}

#[tokio::test]
async fn a_failed_chunk_stops_the_upload() {
    let r = rig().await;
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    r.mock.on("POST", VIDEO_INIT, video_init(&r.mock));
    let size = 2 * CHUNK_BYTES as usize + 1;
    // An expired upload URL (403): permanent, and the second chunk is never sent.
    r.mock.on("PUT", UPLOAD, raw(403, ""));
    let e =
        r.tt.publish(&cred(), &public(), &video_post("x", size))
            .await
            .unwrap_err();
    assert_eq!((e.kind(), e.reason()), ("permanent", Some("HTTP 403")));
    assert_eq!(r.mock.requests("PUT", UPLOAD).len(), 1);
    // A server error on a chunk: transient (nothing was posted; the next attempt starts over),
    // never sent again.
    r.mock.clear();
    r.mock.set("PUT", UPLOAD, raw(500, "<html>oops</html>"));
    let e =
        r.tt.publish(&cred(), &public(), &video_post("x", size))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "transient", "{e}");
    assert_eq!(r.mock.requests("PUT", UPLOAD).len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn status_processing_is_pending_then_complete_resolves_permalink() {
    let r = rig().await;
    r.mock.on("POST", STATUS, answer("status_processing"));
    r.mock.on("POST", STATUS, answer("status_complete"));
    let receipt = receipt(PUBLISH_ID);
    assert_eq!(
        r.tt.resolve(&cred(), &public(), &receipt).await.unwrap(),
        Some(PublishResolution::Pending)
    );
    assert_eq!(
        r.tt.resolve(&cred(), &public(), &receipt).await.unwrap(),
        Some(PublishResolution::Published(PublishReceipt {
            external_id: VIDEO_ID.into(),
            url: Some(
                Url::parse("https://www.tiktok.com/@jeeta_test/video/7300000000000000001").unwrap()
            ),
        }))
    );
    for call in r.mock.requests("POST", STATUS) {
        assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
        assert_eq!(call.header("content-type"), Some(JSON_UTF8));
        assert_eq!(call.json(), json!({ "publish_id": PUBLISH_ID }));
    }

    // Every processing status, and one TikTok may add later, is pending.
    for state in ["PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "SOMETHING_NEW"] {
        r.mock.set(
            "POST",
            STATUS,
            ok(json!({ "data": { "status": state }, "error": { "code": "ok" } })),
        );
        assert_eq!(
            r.tt.resolve(&cred(), &public(), &receipt).await.unwrap(),
            Some(PublishResolution::Pending),
            "{state}"
        );
    }
    // The username where the use cases keep it; without one, no permalink.
    r.mock.set("POST", STATUS, answer("status_complete"));
    let stored = json!({ "kind_key": "tiktok", "asset": { "username": "jeeta_asset" } });
    let Some(PublishResolution::Published(found)) =
        r.tt.resolve(&cred(), &stored, &receipt).await.unwrap()
    else {
        panic!("not published");
    };
    assert_eq!(
        found.url.as_ref().map(Url::as_str),
        Some("https://www.tiktok.com/@jeeta_asset/video/7300000000000000001")
    );
    let anonymous = json!({ "kind_key": "tiktok" });
    assert_eq!(
        r.tt.resolve(&cred(), &anonymous, &receipt).await.unwrap(),
        Some(PublishResolution::Published(PublishReceipt {
            external_id: VIDEO_ID.into(),
            url: None,
        }))
    );
    // Nobody else may see it: TikTok names no public id, and the receipt keeps the publish id.
    r.mock
        .set("POST", STATUS, answer("status_complete_private"));
    assert_eq!(
        r.tt.resolve(&cred(), &public(), &receipt).await.unwrap(),
        Some(PublishResolution::Published(self::receipt(PUBLISH_ID)))
    );
    // An answer without a status is refused.
    r.mock.set(
        "POST",
        STATUS,
        ok(json!({ "data": {}, "error": { "code": "ok" } })),
    );
    assert_eq!(
        kind_of(r.tt.resolve(&cred(), &public(), &receipt).await),
        "permanent"
    );
}

#[tokio::test]
async fn status_failed_carries_fail_reason() {
    let r = rig().await;
    r.mock.on("POST", STATUS, answer("status_failed"));
    let receipt = receipt(PUBLISH_ID);
    let Some(PublishResolution::Failed(e)) =
        r.tt.resolve(&cred(), &public(), &receipt).await.unwrap()
    else {
        panic!("not failed");
    };
    assert_eq!(
        (e.kind(), e.reason()),
        ("permanent", Some("publish failed: duration_check_failed"))
    );
    // The creator removed the app's access while it processed: reconnect.
    r.mock.set(
        "POST",
        STATUS,
        ok(json!({ "data": { "status": "FAILED", "fail_reason": "auth_removed" }, "error": { "code": "ok" } })),
    );
    assert_eq!(
        r.tt.resolve(&cred(), &public(), &receipt).await.unwrap(),
        Some(PublishResolution::Failed(ConnectorError::auth(
            "publish failed: auth_removed"
        )))
    );
    r.mock.set(
        "POST",
        STATUS,
        ok(json!({ "data": { "status": "FAILED" }, "error": { "code": "ok" } })),
    );
    assert_eq!(
        r.tt.resolve(&cred(), &public(), &receipt).await.unwrap(),
        Some(PublishResolution::Failed(ConnectorError::permanent(
            "publish failed: TikTok gave no reason"
        )))
    );
    // A status call that fails is the error, not a resolution.
    r.mock.set("POST", STATUS, answer_with(401, "error_scope"));
    assert_eq!(
        kind_of(r.tt.resolve(&cred(), &public(), &receipt).await),
        "permission"
    );
    r.mock.set(
        "POST",
        STATUS,
        api_error(400, "invalid_publish_id", "The publish_id does not exist."),
    );
    assert_eq!(
        kind_of(r.tt.resolve(&cred(), &public(), &receipt).await),
        "permanent"
    );
    // A receipt that cannot be a publish id is refused without a call.
    r.mock.clear();
    for bad in ["", "two words", &"x".repeat(65)] {
        assert_eq!(
            kind_of(r.tt.resolve(&cred(), &public(), &self::receipt(bad)).await),
            "permanent",
            "{bad:?}"
        );
    }
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn insights_read_video_query_and_user_stats() {
    let r = rig().await;
    r.mock.on("POST", VIDEO_QUERY, answer("video_query"));
    r.mock.on("GET", USER_INFO, answer("user_info_stats"));
    let post =
        r.tt.post_metrics(&cred(), &public(), VIDEO_ID)
            .await
            .unwrap();
    let expected: Vec<(String, i64)> = [
        ("comment_count", 12),
        ("like_count", 250),
        ("share_count", 7),
        ("view_count", 9400),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), *v))
    .collect();
    assert_eq!(post.metrics.into_iter().collect::<Vec<_>>(), expected);
    let call = r.mock.request("POST", VIDEO_QUERY);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.header("content-type"), Some(JSON_UTF8));
    assert_eq!(
        call.query,
        owned(&[(
            "fields",
            "id,like_count,comment_count,share_count,view_count"
        )])
    );
    assert_eq!(
        call.json(),
        json!({ "filters": { "video_ids": [VIDEO_ID] } })
    );

    let account = r.tt.account_metrics(&cred(), &public()).await.unwrap();
    let expected: Vec<(String, i64)> = [
        ("follower_count", 1200),
        ("following_count", 45),
        ("likes_count", 8700),
        ("video_count", 31),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), *v))
    .collect();
    assert_eq!(account.metrics.into_iter().collect::<Vec<_>>(), expected);
    assert_eq!(
        r.mock.request("GET", USER_INFO).query,
        owned(&[(
            "fields",
            "follower_count,following_count,likes_count,video_count"
        )])
    );

    // A counter that is not a whole number is left out; a video TikTok does not name, or one
    // without counters, is refused.
    r.mock.set(
        "POST",
        VIDEO_QUERY,
        ok(json!({ "data": { "videos": [ { "id": VIDEO_ID, "like_count": 4, "view_count": "many", "share_count": 0.5 } ] }, "error": { "code": "ok" } })),
    );
    let post =
        r.tt.post_metrics(&cred(), &public(), VIDEO_ID)
            .await
            .unwrap();
    assert_eq!(
        post.metrics.into_iter().collect::<Vec<_>>(),
        [("like_count".to_owned(), 4)]
    );
    for videos in [
        json!([]),
        json!([{ "id": "7300000000000000002", "like_count": 1 }]),
        json!([{ "id": VIDEO_ID }]),
    ] {
        r.mock.set(
            "POST",
            VIDEO_QUERY,
            ok(json!({ "data": { "videos": videos }, "error": { "code": "ok" } })),
        );
        assert_eq!(
            kind_of(r.tt.post_metrics(&cred(), &public(), VIDEO_ID).await),
            "permanent",
            "{videos}"
        );
    }
    // A connection made before the scopes were approved reads as a scope gap.
    r.mock
        .set("POST", VIDEO_QUERY, answer_with(401, "error_scope"));
    r.mock
        .set("GET", USER_INFO, answer_with(401, "error_scope"));
    assert_eq!(
        kind_of(r.tt.post_metrics(&cred(), &public(), VIDEO_ID).await),
        "permission"
    );
    assert_eq!(
        kind_of(r.tt.account_metrics(&cred(), &public()).await),
        "permission"
    );

    // An id that is not a video id (a receipt that kept its publish id): refused without a call.
    r.mock.clear();
    for bad in ["", PUBLISH_ID, "12a", "../1"] {
        assert_eq!(
            kind_of(r.tt.post_metrics(&cred(), &public(), bad).await),
            "permanent",
            "{bad:?}"
        );
    }
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn kind_key_must_be_tiktok() {
    let r = rig().await;
    for public in [
        json!({}),
        json!(null),
        json!({ "kind_key": null }),
        json!({ "kind_key": "TIKTOK" }),
        json!({ "kind_key": "tiktok_ads" }),
        json!({ "kind_key": "x" }),
    ] {
        let errors = [
            r.tt.publish(&cred(), &public, &video_post("x", 10))
                .await
                .map(drop),
            r.tt.resolve(&cred(), &public, &receipt(PUBLISH_ID))
                .await
                .map(drop),
            r.tt.post_metrics(&cred(), &public, VIDEO_ID)
                .await
                .map(drop),
            r.tt.account_metrics(&cred(), &public).await.map(drop),
            r.tt.probe(&cred(), &public).await.error.map_or(Ok(()), Err),
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
// Errors
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn error_mapping_auth() {
    let r = rig().await;
    for reply in [
        answer_with(401, "error_auth"),
        // A refusal TikTok sends with HTTP 200 is still a refusal.
        answer("error_auth"),
        api_error(401, "access_token_expired", "expired"),
        api_error(401, "token_revoked", "revoked"),
        raw(401, "<html>no</html>"),
    ] {
        r.mock.set("GET", USER_INFO, reply.clone());
        r.mock.set("POST", CREATOR_INFO, reply.clone());
        r.mock.set("POST", STATUS, reply.clone());
        for e in [
            r.tt.account_metrics(&cred(), &public()).await.unwrap_err(),
            r.tt.publish(&cred(), &public(), &video_post("x", 10))
                .await
                .unwrap_err(),
            r.tt.resolve(&cred(), &public(), &receipt(PUBLISH_ID))
                .await
                .unwrap_err(),
        ] {
            assert_eq!(e.kind(), "auth", "{reply:?}: {e}");
        }
    }
    let e = {
        r.mock.set("GET", USER_INFO, answer_with(401, "error_auth"));
        r.tt.account_metrics(&cred(), &public()).await.unwrap_err()
    };
    assert_eq!(
        e.reason(),
        Some(
            "HTTP 401 access_token_invalid: The access token is invalid or not found in the request."
        )
    );
}

#[tokio::test]
async fn error_mapping_scope() {
    let r = rig().await;
    // `scope_not_authorized` comes with HTTP 401, and is not the credential's death.
    r.mock
        .set("POST", CREATOR_INFO, answer_with(401, "error_scope"));
    let e =
        r.tt.publish(&cred(), &public(), &video_post("x", 10))
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        (
            "permission",
            Some(
                "HTTP 401 scope_not_authorized: The user did not authorize the scope required for completing this request."
            )
        )
    );
    assert!(r.mock.requests("POST", VIDEO_INIT).is_empty());
    for (path, reply) in [
        (
            USER_INFO,
            api_error(400, "scope_permission_missed", "fields need scopes"),
        ),
        (USER_INFO, answer_with(401, "error_scope")),
    ] {
        r.mock.set("GET", path, reply);
        assert_eq!(
            kind_of(r.tt.account_metrics(&cred(), &public()).await),
            "permission"
        );
    }
    // The creator or the app may not post that way.
    r.mock
        .set("POST", CREATOR_INFO, answer("creator_info_public"));
    for reply in [
        answer_with(403, "error_unaudited"),
        api_error(
            403,
            "privacy_level_option_mismatch",
            "privacy_level is missing",
        ),
        api_error(403, "spam_risk_user_banned_from_posting", "banned"),
    ] {
        r.mock.set("POST", VIDEO_INIT, reply.clone());
        r.mock.set("POST", CONTENT_INIT, reply.clone());
        for request in [video_post("x", 10), photo_post("x", 1)] {
            let e =
                r.tt.publish(&cred(), &public(), &request)
                    .await
                    .unwrap_err();
            assert_eq!(e.kind(), "permission", "{reply:?}: {e}");
        }
    }
    assert!(r.mock.requests("PUT", UPLOAD).is_empty());
}

#[tokio::test]
async fn error_mapping_rate() {
    let r = rig().await;
    for reply in [
        answer_with(429, "error_rate"),
        // TikTok names no wait: a Retry-After is not read.
        answer_with(429, "error_rate").with_header("retry-after", "30"),
        raw(429, "slow down"),
        answer_with(403, "error_spam"),
        api_error(403, "reached_active_user_cap", "daily quota"),
    ] {
        r.mock.set("GET", USER_INFO, reply.clone());
        r.mock.set("POST", VIDEO_QUERY, reply.clone());
        assert_eq!(
            r.tt.account_metrics(&cred(), &public()).await.unwrap_err(),
            ConnectorError::throttle(None),
            "{reply:?}"
        );
        assert_eq!(
            r.tt.post_metrics(&cred(), &public(), VIDEO_ID)
                .await
                .unwrap_err(),
            ConnectorError::throttle(None),
            "{reply:?}"
        );
    }
    // The creator's daily post cap, as `creator_info` answers it: HTTP 200; nothing is posted.
    r.mock.set("POST", CREATOR_INFO, answer("error_spam"));
    assert_eq!(
        r.tt.publish(&cred(), &public(), &video_post("x", 10))
            .await
            .unwrap_err(),
        ConnectorError::throttle(None)
    );
    // The init's rate limit (6 a minute) on a write.
    r.mock
        .set("POST", CREATOR_INFO, answer("creator_info_public"));
    r.mock
        .set("POST", VIDEO_INIT, answer_with(429, "error_rate"));
    assert_eq!(
        kind_of(r.tt.publish(&cred(), &public(), &video_post("x", 10)).await),
        "throttle"
    );
    assert!(r.mock.requests("PUT", UPLOAD).is_empty());
    // A throttled read is not tried again: an answer arrived.
    assert_eq!(r.mock.requests("GET", USER_INFO).len(), 5);
    assert_eq!(r.mock.requests("POST", VIDEO_INIT).len(), 1);
}

#[tokio::test]
async fn error_mapping_5xx() {
    let r = rig().await;
    for reply in [
        answer_with(500, "error_internal"),
        answer("error_internal"),
        raw(503, "<html>unavailable</html>"),
        raw(502, ""),
    ] {
        r.mock.set("GET", USER_INFO, reply.clone());
        r.mock.set("POST", STATUS, reply.clone());
        r.mock.set("POST", TOKEN, reply.clone());
        for e in [
            r.tt.account_metrics(&cred(), &public()).await.unwrap_err(),
            r.tt.resolve(&cred(), &public(), &receipt(PUBLISH_ID))
                .await
                .unwrap_err(),
            r.tt.refresh(&cred_expiring_in(Duration::hours(1)))
                .await
                .unwrap_err(),
        ] {
            assert_eq!(e.kind(), "transient", "{reply:?}: {e}");
        }
    }
    // An answer arrived each time: nothing was sent again.
    assert_eq!(r.mock.requests("GET", USER_INFO).len(), 4);
    assert_eq!(r.mock.requests("POST", STATUS).len(), 4);
    assert_eq!(r.mock.requests("POST", TOKEN).len(), 4);
    r.mock
        .set("GET", USER_INFO, answer_with(500, "error_internal"));
    let e = r.tt.account_metrics(&cred(), &public()).await.unwrap_err();
    assert_eq!(
        e.reason(),
        Some("HTTP 500 internal_error: Something is wrong, please try again later.")
    );
}

#[tokio::test]
async fn ok_code_required_on_2xx() {
    let r = rig().await;
    // A 2xx without TikTok's error code is not a success.
    r.mock.set(
        "GET",
        USER_INFO,
        ok(json!({ "data": { "user": { "open_id": OPEN_ID, "follower_count": 1 } } })),
    );
    let e = r.tt.account_metrics(&cred(), &public()).await.unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        ("permanent", Some("HTTP 200 without TikTok's error code"))
    );
    // Nor a 2xx with another code: it maps by the code.
    for (reply, expected) in [
        (answer("error_spam"), "throttle"),
        (answer("error_auth"), "auth"),
        (answer("error_scope"), "permission"),
        (api_error(200, "invalid_params", "bad"), "permanent"),
        (raw(200, "<html>not json</html>"), "permanent"),
    ] {
        r.mock.set("GET", USER_INFO, reply.clone());
        assert_eq!(
            kind_of(r.tt.account_metrics(&cred(), &public()).await),
            expected,
            "{reply:?}"
        );
    }
    // `ok` is a success.
    r.mock.set("GET", USER_INFO, answer("user_info_stats"));
    r.tt.account_metrics(&cred(), &public()).await.unwrap();

    // A photo's init that answers 2xx without the code may have posted: `Unknown`; a video's init
    // cannot have (nothing was uploaded): `Permanent`, and nothing is uploaded.
    r.mock
        .set("POST", CREATOR_INFO, answer("creator_info_public"));
    for reply in [
        ok(json!({ "data": { "publish_id": PHOTO_PUBLISH_ID } })),
        raw(200, "{broken"),
    ] {
        r.mock.set("POST", CONTENT_INIT, reply.clone());
        assert_eq!(
            kind_of(r.tt.publish(&cred(), &public(), &photo_post("x", 1)).await),
            "unknown",
            "{reply:?}"
        );
        r.mock.set("POST", VIDEO_INIT, reply.clone());
        assert_eq!(
            kind_of(r.tt.publish(&cred(), &public(), &video_post("x", 10)).await),
            "permanent",
            "{reply:?}"
        );
    }
    assert!(r.mock.requests("PUT", UPLOAD).is_empty());
}

#[tokio::test]
async fn no_secret_in_errors() {
    let r = rig().await;
    let mut errors: Vec<ConnectorError> = Vec::new();
    // The token endpoint echoes what it was sent.
    let token_error = |error: &str, description: String| {
        status(
            400,
            json!({ "error": error, "error_description": description, "log_id": "l" }),
        )
    };
    for (error, description) in [
        ("invalid_grant", format!("code {CODE} is expired")),
        (
            "invalid_request",
            format!("client {CLIENT_KEY}:{CLIENT_SECRET} with code {CODE}"),
        ),
        (
            "server_error",
            format!("{CODE} {CLIENT_SECRET} could not be checked"),
        ),
    ] {
        r.mock.set("POST", TOKEN, token_error(error, description));
        errors.push(
            r.tt.exchange(&app(), &redirect(), CODE, None)
                .await
                .unwrap_err(),
        );
    }
    let near = cred_expiring_in(Duration::hours(1));
    for (error, description) in [
        (
            "invalid_grant",
            format!("refresh token {REFRESH_TOKEN} was revoked"),
        ),
        (
            "invalid_request",
            format!("client_secret={CLIENT_SECRET}&refresh_token={REFRESH_TOKEN}"),
        ),
    ] {
        r.mock.set("POST", TOKEN, token_error(error, description));
        errors.push(r.tt.refresh(&near).await.unwrap_err());
    }
    // The API echoes the access token.
    for (code, error) in [
        (401, "access_token_invalid"),
        (401, "scope_not_authorized"),
        (400, "invalid_param"),
        (500, "internal_error"),
    ] {
        let echo = api_error(
            code,
            error,
            &format!("token {ACCESS_TOKEN} (Bearer {ACCESS_TOKEN})"),
        );
        for path in [CREATOR_INFO, STATUS, VIDEO_QUERY] {
            r.mock.set("POST", path, echo.clone());
        }
        r.mock.set("GET", USER_INFO, echo.clone());
        errors.push(
            r.tt.publish(&cred(), &public(), &video_post("x", 10))
                .await
                .unwrap_err(),
        );
        errors.push(
            r.tt.resolve(&cred(), &public(), &receipt(PUBLISH_ID))
                .await
                .unwrap_err(),
        );
        errors.push(
            r.tt.post_metrics(&cred(), &public(), VIDEO_ID)
                .await
                .unwrap_err(),
        );
        errors.push(r.tt.account_metrics(&cred(), &public()).await.unwrap_err());
        errors.push(r.tt.probe(&cred(), &public()).await.error.unwrap());
        errors.push(r.tt.list_assets(&cred()).await.unwrap_err());
    }
    // The upload host echoes the upload URL, which carries its own authority.
    r.mock
        .set("POST", CREATOR_INFO, answer("creator_info_public"));
    r.mock.set("POST", VIDEO_INIT, video_init(&r.mock));
    let upload_url = r.mock.upload_url();
    for code in [400, 403, 500] {
        r.mock.set(
            "PUT",
            UPLOAD,
            api_error(
                code,
                "invalid_file_upload",
                &format!("bad upload to {upload_url} ({UPLOAD_TOKEN})"),
            ),
        );
        errors.push(
            r.tt.publish(&cred(), &public(), &video_post("x", 10))
                .await
                .unwrap_err(),
        );
    }
    assert_eq!(errors.len(), 3 + 2 + 4 * 6 + 3);
    let kinds: std::collections::BTreeSet<&str> = errors.iter().map(|e| e.kind()).collect();
    assert_eq!(
        kinds,
        ["auth", "permanent", "permission", "transient"]
            .into_iter()
            .collect()
    );
    for e in &errors {
        let line = jt_app::usecases::failure::failure_reason(Some(Provider::Tiktok), e);
        assert_no_secret(&format!("{e} {e:?} {line}"));
    }
    // The provider's words are still there around the secret.
    assert!(
        errors[0].reason().unwrap().contains("is expired"),
        "{}",
        errors[0]
    );
    let last = errors.last().unwrap().reason().unwrap();
    assert!(
        last.starts_with("HTTP 500 invalid_file_upload: bad upload to"),
        "{last}"
    );

    // Nor in the `Debug` of the adapter, the credential, the app or a request.
    let printed = format!(
        "{:?} {:?} {:?} {:?} {:?}",
        r.tt,
        r.tt.bases(),
        cred(),
        tiktok_app(),
        video_post("x", 64)
    );
    assert_no_secret(&printed);
    assert!(printed.contains("<64 bytes>"), "{printed}");
}

// ---------------------------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------------------------

/// A pause long enough for an attempt to time out, and the attempt timeout that makes it so.
const STALL: StdDuration = StdDuration::from_millis(3_000);
const SHORT_TIMEOUT: StdDuration = StdDuration::from_millis(1_000);

#[tokio::test]
async fn read_retried_once_write_never() {
    assert_eq!(READ_ATTEMPTS, 2);
    // A socket that closes every connection: no answer ever arrives.
    let dropper = Dropper::start().await;
    let tt = connector_at(dropper.addr, TestApps::default(), StdDuration::from_secs(5));
    let count = |before: usize| dropper.accepted() - before;

    // Writes are sent once: a token call that got no answer may have spent its grant.
    let before = dropper.accepted();
    let e = tt
        .exchange(&app(), &redirect(), CODE, None)
        .await
        .unwrap_err();
    assert_eq!((count(before), e.kind()), (1, "unknown"), "{e}");
    let before = dropper.accepted();
    let e = tt
        .refresh(&cred_expiring_in(Duration::hours(1)))
        .await
        .unwrap_err();
    assert_eq!((count(before), e.kind()), (1, "unknown"), "{e}");
    assert!(e.reason().unwrap().contains("outcome is unknown"), "{e}");

    // Reads, `POST` queries included, are tried once more, exactly.
    for (name, outcome) in [
        ("probe", {
            let before = dropper.accepted();
            count_after(
                before,
                &dropper,
                tt.probe(&cred(), &public()).await.error.unwrap(),
            )
        }),
        ("account_metrics", {
            let before = dropper.accepted();
            count_after(
                before,
                &dropper,
                tt.account_metrics(&cred(), &public()).await.unwrap_err(),
            )
        }),
        ("post_metrics", {
            let before = dropper.accepted();
            count_after(
                before,
                &dropper,
                tt.post_metrics(&cred(), &public(), VIDEO_ID)
                    .await
                    .unwrap_err(),
            )
        }),
        ("resolve", {
            let before = dropper.accepted();
            count_after(
                before,
                &dropper,
                tt.resolve(&cred(), &public(), &receipt(PUBLISH_ID))
                    .await
                    .unwrap_err(),
            )
        }),
        // The creator info before a post: a read, and nothing is posted after it fails.
        ("publish", {
            let before = dropper.accepted();
            count_after(
                before,
                &dropper,
                tt.publish(&cred(), &public(), &video_post("x", 10))
                    .await
                    .unwrap_err(),
            )
        }),
        ("list_assets", {
            let before = dropper.accepted();
            count_after(before, &dropper, tt.list_assets(&cred()).await.unwrap_err())
        }),
    ] {
        let (connections, e) = outcome;
        assert_eq!(connections, 2, "{name}");
        assert_eq!(e.kind(), "transient", "{name}: {e}");
        assert!(e.reason().unwrap().contains("no answer"), "{name}: {e}");
    }

    // Against a mock that answers too late.
    let r = rig_with_timeout(SHORT_TIMEOUT).await;
    // A read that timed out is tried again, and its second answer read: the post goes on.
    r.mock.on(
        "POST",
        CREATOR_INFO,
        answer("creator_info_public").delayed(STALL),
    );
    r.mock
        .on("POST", CREATOR_INFO, answer("creator_info_public"));
    r.mock.on("POST", CONTENT_INIT, answer("photo_init"));
    r.tt.publish(&cred(), &public(), &photo_post("x", 1))
        .await
        .unwrap();
    assert_eq!(r.mock.requests("POST", CREATOR_INFO).len(), 2);

    // A photo's init that times out may have posted: `Unknown`, sent once.
    r.mock.clear();
    r.mock
        .set("POST", CONTENT_INIT, answer("photo_init").delayed(STALL));
    let e =
        r.tt.publish(&cred(), &public(), &photo_post("x", 1))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "unknown", "{e}");
    assert!(!e.is_retriable());
    assert_eq!(r.mock.requests("POST", CONTENT_INIT).len(), 1);

    // A video's init that times out cannot have posted (nothing was uploaded): `Transient`, sent
    // once, and nothing uploaded.
    r.mock.clear();
    r.mock
        .set("POST", VIDEO_INIT, video_init(&r.mock).delayed(STALL));
    let e =
        r.tt.publish(&cred(), &public(), &video_post("x", 10))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "transient", "{e}");
    assert!(
        e.reason().unwrap().contains("nothing can have been posted"),
        "{e}"
    );
    assert_eq!(r.mock.requests("POST", VIDEO_INIT).len(), 1);
    assert!(r.mock.requests("PUT", UPLOAD).is_empty());

    // A chunk before the last that times out: `Transient`, the rest never sent.
    r.mock.clear();
    r.mock.set("POST", VIDEO_INIT, video_init(&r.mock));
    r.mock.set("PUT", UPLOAD, partial().delayed(STALL));
    let e =
        r.tt.publish(
            &cred(),
            &public(),
            &video_post("x", 2 * CHUNK_BYTES as usize + 1),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "transient", "{e}");
    assert_eq!(r.mock.requests("PUT", UPLOAD).len(), 1);

    // The last chunk that times out may have completed the post: `Unknown`, sent once.
    r.mock.clear();
    r.mock.set("PUT", UPLOAD, complete().delayed(STALL));
    let e =
        r.tt.publish(&cred(), &public(), &video_post("x", 10))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "unknown", "{e}");
    assert!(e.reason().unwrap().contains("outcome is unknown"), "{e}");
    assert_eq!(r.mock.requests("PUT", UPLOAD).len(), 1);

    // A status read that never answers in time: given up after the second attempt.
    r.mock.clear();
    r.mock
        .set("POST", STATUS, answer("status_complete").delayed(STALL));
    let e =
        r.tt.resolve(&cred(), &public(), &receipt(PUBLISH_ID))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "transient", "{e}");
    assert_eq!(r.mock.requests("POST", STATUS).len(), 2);
}

/// How many connections `dropper` accepted since `before`, with the error `e`.
fn count_after(before: usize, dropper: &Dropper, e: ConnectorError) -> (usize, ConnectorError) {
    (dropper.accepted() - before, e)
}

#[tokio::test]
async fn adapter_values_print_no_secret() {
    let r = rig().await;
    let printed = format!(
        "{:?} {:?} {:?}",
        r.tt,
        r.tt.bases(),
        privately(video_post("Merhaba", 64), "SELF_ONLY")
    );
    assert_no_secret(&printed);
    assert!(printed.contains("TiktokConnector"), "{printed}");
}
