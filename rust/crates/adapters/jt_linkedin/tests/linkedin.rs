//! The LinkedIn adapter against the in-process mock: hosts, OAuth (member and page scopes),
//! refresh, assets, probes, publishing (text, articles, images, video), counters, the error
//! table, waits and retries.

mod support;

use std::time::Duration as StdDuration;

use jt_app::ports::connectors::{
    Connector, InsightsReader, LinkedinApp, MediaUpload, OAuthApp, OAuthProvider, PublishRequest,
    Publisher, XApp,
};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_linkedin::{
    ACL_PAGE_SIZE, DEFAULT_API_VERSION, IMAGE_MIMES, LINKEDIN_HOSTS, LinkedinBases,
    MAX_COMMENTARY_CHARS, MAX_IMAGES, MEMBER_SCOPES, MIN_VIDEO_BYTES, ORGANIZATION_SCOPES,
    READ_ATTEMPTS, VIDEO_MIME,
};
use jt_outbound::FIXED_HOSTS;
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};
use url::Url;

fn redirect() -> Url {
    Url::parse("https://panel.test/oauth/callback/linkedin").unwrap()
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

/// A file of `len` bytes of type `mime`.
fn file(len: usize, mime: &str, filename: &str) -> MediaUpload {
    MediaUpload {
        bytes: (0..len).map(|i| (i % 251) as u8).collect(),
        mime: mime.into(),
        filename: filename.into(),
    }
}

fn png(len: usize) -> MediaUpload {
    file(len, "image/png", "photo.png")
}

fn jpeg(len: usize) -> MediaUpload {
    file(len, "image/jpeg", "photo.jpg")
}

fn mp4(len: usize) -> MediaUpload {
    file(len, "video/mp4", "clip.mp4")
}

fn post(text: &str, media: Vec<MediaUpload>) -> PublishRequest {
    PublishRequest {
        text: text.into(),
        media,
        ..PublishRequest::default()
    }
}

fn with_link(mut request: PublishRequest, link: &str) -> PublishRequest {
    request.link = Some(Url::parse(link).unwrap());
    request
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

/// The body every post shares, with `author`, `commentary` and `content` (when given).
fn post_body(author: &str, commentary: &str, content: Option<Value>) -> Value {
    let mut body = json!({
        "author": author,
        "commentary": commentary,
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": false,
    });
    if let Some(content) = content {
        body["content"] = content;
    }
    body
}

fn member_author() -> String {
    format!("urn:li:person:{SUB}")
}

fn page_author() -> String {
    format!("urn:li:organization:{ORG}")
}

fn apps_with_version(version: &str) -> TestApps {
    TestApps {
        linkedin: Some(LinkedinApp {
            api_version: Some(version.into()),
            ..linkedin_app(false)
        }),
    }
}

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn hosts_are_the_fixed_linkedin_entries() {
    let r = rig().await;
    let fixed: Vec<&str> = FIXED_HOSTS
        .iter()
        .filter(|h| h.connector == "linkedin")
        .map(|h| h.host)
        .collect();
    assert_eq!(r.li.hosts(), fixed.as_slice());
    assert_eq!(LINKEDIN_HOSTS, fixed.as_slice());
    assert_eq!(LINKEDIN_HOSTS, ["api.linkedin.com", "www.linkedin.com"]);
    assert_eq!(r.li.provider(), Provider::Linkedin);
    assert_eq!(
        Provider::Linkedin.kinds(),
        ["linkedin_member", "linkedin_page"]
    );
    // The production bases reach exactly those hosts.
    let production = LinkedinBases::production();
    assert_eq!(production.api.as_str(), "https://api.linkedin.com/");
    assert_eq!(production.oauth.as_str(), "https://www.linkedin.com/");
    assert_eq!(production.authorize.as_str(), "https://www.linkedin.com/");
    for base in [&production.api, &production.oauth] {
        assert!(fixed.contains(&base.host_str().unwrap()), "{base}");
    }
    assert_eq!(DEFAULT_API_VERSION, "202610");
}

// ---------------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn authorize_url_member_scopes_vs_page_scopes() {
    let r = rig().await;
    let member = OAuthApp::Linkedin(linkedin_app(false));
    let url =
        r.li.authorize_url(&member, &redirect(), "state-1", None)
            .unwrap();
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("www.linkedin.com"));
    assert_eq!(url.path(), "/oauth/v2/authorization");
    assert_eq!(MEMBER_SCOPES, ["openid", "profile", "w_member_social"]);
    assert_eq!(
        pairs(&url),
        owned(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect().as_str()),
            ("state", "state-1"),
            ("scope", "openid profile w_member_social"),
        ])
    );
    // Spaces between the scopes are percent-encoded, not `+`.
    let query = url.query().unwrap();
    assert!(
        query.contains("scope=openid%20profile%20w_member_social"),
        "{query}"
    );
    assert!(!url.as_str().contains(CLIENT_SECRET), "{url}");

    // A page flow's app asks for the organization scopes too.
    assert_eq!(
        ORGANIZATION_SCOPES,
        [
            "r_organization_social",
            "w_organization_social",
            "rw_organization_admin"
        ]
    );
    let page = OAuthApp::Linkedin(linkedin_app(true));
    let url =
        r.li.authorize_url(&page, &redirect(), "state-2", None)
            .unwrap();
    let scope = pairs(&url)
        .into_iter()
        .find(|(k, _)| k == "scope")
        .unwrap()
        .1;
    assert_eq!(
        scope,
        "openid profile w_member_social r_organization_social w_organization_social \
         rw_organization_admin"
    );

    // A PKCE challenge handed in is not sent (LinkedIn's PKCE is a native-app flow).
    let url =
        r.li.authorize_url(&member, &redirect(), "state-3", Some("challenge-x"))
            .unwrap();
    assert!(!url.as_str().contains("challenge"), "{url}");
    // Another provider's app is not LinkedIn's.
    let x = OAuthApp::X(XApp {
        client_id: "x-id".into(),
        client_secret: "x-SECRET".into(),
    });
    assert_eq!(
        kind_of(r.li.authorize_url(&x, &redirect(), "s", None)),
        "permanent"
    );
    assert_eq!(
        kind_of(r.li.exchange(&x, &redirect(), CODE, None).await),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn page_flow_refused_without_org_scopes() {
    let r = rig().await;
    r.mock.on("GET", USERINFO, r.mock.answer("userinfo"));
    r.mock
        .on("GET", ACLS, r.mock.answer("organization_acls_other"));
    // A member flow never asks for an organization scope...
    let url =
        r.li.authorize_url(
            &OAuthApp::Linkedin(linkedin_app(false)),
            &redirect(),
            "s",
            None,
        )
        .unwrap();
    for scope in ORGANIZATION_SCOPES {
        assert!(!url.as_str().contains(scope), "{url}");
    }
    // ... and its credential lists the member alone: no organization is asked about.
    let cred = member_cred();
    let assets = r.li.list_assets(&cred).await.unwrap();
    assert_eq!(assets.len(), 1, "{assets:?}");
    let member = &assets[0];
    assert_eq!(member.kind_key, "linkedin_member");
    assert_eq!(member.external_id, SUB);
    assert_eq!(member.name, "Jeeta Test");
    assert_eq!(member.credential, cred);
    assert_eq!(
        member.public,
        json!({
            "name": "Jeeta Test",
            "picture": "https://media.licdn.test/dms/image/synthetic/profile-displayphoto-shrink_100_100/0/",
        })
    );
    assert_eq!(r.mock.lines(), [format!("GET {USERINFO}")]);
    // OpenID userinfo is unversioned.
    let call = r.mock.request("GET", USERINFO);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.header("linkedin-version"), None);
    assert_eq!(call.header("x-restli-protocol-version"), None);

    // A credential granted neither OpenID scope nor the organization one: nothing is asked.
    r.mock.clear();
    let bare = Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec!["w_member_social".into()],
    };
    assert!(r.li.list_assets(&bare).await.unwrap().is_empty());
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn exchange_sets_60d_expiry_and_optional_refresh() {
    let r = rig().await;
    let member = OAuthApp::Linkedin(linkedin_app(false));
    let page = OAuthApp::Linkedin(linkedin_app(true));
    r.mock.on("POST", TOKEN, r.mock.answer("token"));
    let before = OffsetDateTime::now_utc();
    let cred =
        r.li.exchange(&member, &redirect(), CODE, None)
            .await
            .unwrap();
    let call = r.mock.request("POST", TOKEN);
    assert_eq!(
        call.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    // The client is in the form, as LinkedIn takes it: no authorization header.
    assert_eq!(call.header("authorization"), None);
    assert!(call.raw_query.is_empty(), "{}", call.raw_query);
    assert_eq!(
        call.form(),
        owned(&[
            ("grant_type", "authorization_code"),
            ("code", CODE),
            ("redirect_uri", redirect().as_str()),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
        ])
    );
    let (access, refresh, expires_at, granted) = oauth(&cred);
    assert_eq!(access, "li-access-test-1");
    // No programmatic refresh: no refresh token.
    assert_eq!(refresh, None);
    assert_expires_in(expires_at, 60 * 24 * 3600, before);
    // The granted scopes, comma-separated in the answer.
    assert_eq!(granted, member_scopes().as_slice());

    // A verifier handed in is not sent.
    r.mock.clear();
    r.li.exchange(&member, &redirect(), CODE, Some("verifier-x"))
        .await
        .unwrap();
    let form = r.mock.request("POST", TOKEN).form();
    assert!(form.iter().all(|(k, _)| k != "code_verifier"), "{form:?}");

    // An app with programmatic refresh gets a refresh token: kept.
    r.mock
        .set("POST", TOKEN, r.mock.answer("token_with_refresh"));
    let before = OffsetDateTime::now_utc();
    let cred = r.li.exchange(&page, &redirect(), CODE, None).await.unwrap();
    let (_, refresh, expires_at, granted) = oauth(&cred);
    assert_eq!(refresh, Some("li-refresh-test-1"));
    assert_expires_in(expires_at, 5_184_000, before);
    assert_eq!(granted, page_scopes().as_slice());

    // An answer naming no scope is taken to grant those asked for.
    r.mock.set(
        "POST",
        TOKEN,
        ok(json!({ "access_token": "li-access-test-1", "expires_in": 5_184_000 })),
    );
    let cred = r.li.exchange(&page, &redirect(), CODE, None).await.unwrap();
    assert_eq!(oauth(&cred).3, page_scopes().as_slice());
    let cred =
        r.li.exchange(&member, &redirect(), CODE, None)
            .await
            .unwrap();
    assert_eq!(oauth(&cred).3, member_scopes().as_slice());

    // An expired or spent code: the owner must start again (`Auth`); the platform's client
    // refused: the platform's problem.
    for (reply, expected) in [
        (
            r.mock.answer_with(400, "token_invalid_redirect_uri"),
            "auth",
        ),
        (
            status(
                401,
                json!({
                    "error": "invalid_request",
                    "error_description": "Unable to retrieve access token: authorization code not found",
                }),
            ),
            "auth",
        ),
        (status(400, json!({ "error": "invalid_grant" })), "auth"),
        (
            status(
                400,
                json!({ "error": "invalid_request", "error_description": "A required parameter \"code\" is missing" }),
            ),
            "permanent",
        ),
        (r.mock.answer_with(401, "token_invalid_client"), "permanent"),
        (ok(json!({ "token_type": "Bearer" })), "permanent"),
    ] {
        r.mock.set("POST", TOKEN, reply.clone());
        let e =
            r.li.exchange(&member, &redirect(), CODE, None)
                .await
                .unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
        assert_no_secret(&format!("{e} {e:?}"));
    }
    r.mock.set(
        "POST",
        TOKEN,
        r.mock.answer_with(401, "token_invalid_client"),
    );
    let e =
        r.li.exchange(&member, &redirect(), CODE, None)
            .await
            .unwrap_err();
    assert_eq!(e.reason(), Some("platform client credentials rejected"));
}

#[tokio::test]
async fn refresh_without_token_is_none() {
    let r = rig().await;
    // No refresh token (no programmatic refresh): nothing to renew with.
    assert_eq!(r.li.refresh(&member_cred()).await.unwrap(), None);
    let blank = Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some("  ".into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(1)),
        scopes: member_scopes(),
    };
    assert_eq!(r.li.refresh(&blank).await.unwrap(), None);
    // Not a LinkedIn credential.
    let foreign = Credential::PageToken {
        page_id: "1".into(),
        token: "EAAB-SECRET".into(),
    };
    assert_eq!(kind_of(r.li.refresh(&foreign).await), "permanent");
    assert!(r.mock.recorded().is_empty());

    // Without the app: still nothing to renew; with a refresh token, refused before any call.
    let unconfigured = rig_with(TestApps { linkedin: None }, jt_linkedin::ATTEMPT_TIMEOUT).await;
    assert_eq!(unconfigured.li.refresh(&member_cred()).await.unwrap(), None);
    assert_eq!(
        kind_of(unconfigured.li.refresh(&page_cred()).await),
        "permanent"
    );
    assert!(unconfigured.mock.recorded().is_empty());
}

#[tokio::test]
async fn refresh_with_token_renews() {
    let r = rig().await;
    r.mock.on("POST", TOKEN, r.mock.answer("token_refreshed"));
    let before = OffsetDateTime::now_utc();
    let new =
        r.li.refresh(&page_cred())
            .await
            .unwrap()
            .expect("a new credential");
    let call = r.mock.request("POST", TOKEN);
    assert_eq!(call.header("authorization"), None);
    assert_eq!(
        call.form(),
        owned(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", REFRESH_TOKEN),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
        ])
    );
    let (access, refresh, expires_at, granted) = oauth(&new);
    assert_eq!(access, "li-access-test-2");
    assert_eq!(refresh, Some("li-refresh-test-2"));
    assert_expires_in(expires_at, 5_184_000, before);
    assert_eq!(granted, page_scopes().as_slice());

    // An answer without a refresh token keeps the one held, and the scopes held.
    r.mock.set(
        "POST",
        TOKEN,
        ok(json!({ "access_token": "li-access-test-2", "expires_in": 5_184_000 })),
    );
    let kept = r.li.refresh(&page_cred()).await.unwrap().unwrap();
    let (access, refresh, _, granted) = oauth(&kept);
    assert_eq!((access, refresh), ("li-access-test-2", Some(REFRESH_TOKEN)));
    assert_eq!(granted, page_scopes().as_slice());

    // A refresh token that is invalid, expired or revoked: the owner must reconnect.
    for (reply, expected) in [
        (r.mock.answer_with(400, "token_invalid_request"), "auth"),
        (status(400, json!({ "error": "invalid_grant" })), "auth"),
        (r.mock.answer_with(401, "error_401"), "auth"),
        (r.mock.answer_with(401, "token_invalid_client"), "permanent"),
        (r.mock.answer_with(400, "token_invalid_client"), "permanent"),
        (r.mock.answer_with(429, "error_429"), "throttle"),
        (raw(503, "<html>unavailable</html>"), "transient"),
        (
            status(400, json!({ "error": "unsupported_grant_type" })),
            "permanent",
        ),
    ] {
        r.mock.set("POST", TOKEN, reply.clone());
        let e = r.li.refresh(&page_cred()).await.unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
        assert_no_secret(&format!("{e} {e:?}"));
    }
}

// ---------------------------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn userinfo_probe_binds_sub() {
    let r = rig().await;
    r.mock.on("GET", USERINFO, r.mock.answer("userinfo"));
    // Whatever the capability claims, the probe names the credential's own member.
    let mut claims = member_public();
    claims["external_id"] = json!("zzOther99");
    let result = r.li.probe(&member_cred(), &claims).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(result.error, None);
    assert_eq!(
        result.facts,
        json!({ "account_id": SUB, "name": "Jeeta Test" })
    );
    for call in r.mock.recorded() {
        assert_eq!(call.path, USERINFO);
        assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
        assert!(call.raw_query.is_empty());
        assert!(!format!("{call:?}").contains("zzOther99"));
    }

    // A `sub` that cannot be a member id, or none: refused.
    for answer in [
        json!({ "sub": "a/b", "name": "x" }),
        json!({ "sub": "", "name": "x" }),
        json!({ "name": "x" }),
    ] {
        r.mock.set("GET", USERINFO, ok(answer.clone()));
        let result = r.li.probe(&member_cred(), &member_public()).await;
        assert!(!result.ok, "{answer}");
        assert_eq!(
            result.error.as_ref().map(ConnectorError::kind),
            Some("permanent")
        );
    }
    // A failure is a result, with no facts.
    r.mock
        .set("GET", USERINFO, r.mock.answer_with(401, "error_401"));
    let result = r.li.probe(&member_cred(), &member_public()).await;
    assert!(!result.ok);
    assert_eq!(
        result.error.as_ref().map(ConnectorError::kind),
        Some("auth")
    );
    assert_eq!(result.facts, json!({}));
}

#[tokio::test]
async fn page_probe_binds_admin_acl_org() {
    let r = rig().await;
    r.mock.on("GET", ACLS, r.mock.answer("organization_acls"));
    r.mock
        .on("GET", ORGANIZATION, r.mock.answer("organization"));
    let result = r.li.probe(&page_cred(), &page_public()).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(
        result.facts,
        json!({ "account_id": ORG, "name": "Jeeta Test Kahve" })
    );
    // The first page named it: the access list is not read on.
    let acl = r.mock.request("GET", ACLS);
    assert_eq!(acl.bearer(), Some(ACCESS_TOKEN));
    acl.assert_rest_headers(DEFAULT_API_VERSION);
    assert_eq!(acl.param("q"), Some("roleAssignee"));
    assert_eq!(acl.param("role"), Some("ADMINISTRATOR"));
    assert_eq!(acl.param("state"), Some("APPROVED"));
    assert_eq!(acl.param("start"), Some("0"));
    assert_eq!(acl.param("count"), Some(ACL_PAGE_SIZE.to_string().as_str()));
    r.mock
        .request("GET", ORGANIZATION)
        .assert_rest_headers(DEFAULT_API_VERSION);

    // An organization on the second page: read on to it. Its name is best effort: the lookup
    // fails (unscripted), the probe does not.
    r.mock.clear();
    r.mock.set("GET", ACLS, r.mock.answer("organization_acls"));
    r.mock
        .on("GET", ACLS, r.mock.answer("organization_acls_page2"));
    let mut second = page_public();
    second["external_id"] = json!(ORG_2);
    let result = r.li.probe(&page_cred(), &second).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(result.facts, json!({ "account_id": ORG_2, "name": null }));
    let starts: Vec<String> = r
        .mock
        .requests("GET", ACLS)
        .iter()
        .map(|c| c.param("start").unwrap().to_owned())
        .collect();
    assert_eq!(starts, ["0", "3"]);
    assert!(result.facts["account_id"].is_string());
}

#[tokio::test]
async fn page_probe_refuses_org_not_administered() {
    let r = rig().await;
    // ORG is there only revoked or as an analyst; ORG_2 is administered.
    r.mock
        .on("GET", ACLS, r.mock.answer("organization_acls_other"));
    r.mock
        .on("GET", ORGANIZATION, r.mock.answer("organization"));
    let result = r.li.probe(&page_cred(), &page_public()).await;
    assert!(!result.ok, "{result:?}");
    let e = result.error.expect("an error");
    assert_eq!(
        (e.kind(), e.reason()),
        (
            "permission",
            Some("the credential administers no such organization")
        )
    );
    assert_eq!(result.facts, json!({}));
    // The organization lookup (which LinkedIn may answer to a non-administrator) never stands in.
    assert!(r.mock.requests("GET", ORGANIZATION).is_empty());

    // A token without the organization scope: LinkedIn refuses the list.
    r.mock
        .set("GET", ACLS, r.mock.answer_with(403, "error_403"));
    let e =
        r.li.probe(&page_cred(), &page_public())
            .await
            .error
            .unwrap();
    assert_eq!(e.kind(), "permission");

    // No organization number in `public`: refused without a call.
    r.mock.clear();
    for external_id in [json!(null), json!("urn:li:organization:1"), json!("12a")] {
        let mut public = page_public();
        public["external_id"] = external_id;
        let e = r.li.probe(&page_cred(), &public).await.error.unwrap();
        assert_eq!(e.kind(), "permanent", "{public}");
    }
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn organization_acls_yield_one_page_asset_each() {
    let r = rig().await;
    r.mock.on("GET", USERINFO, r.mock.answer("userinfo"));
    r.mock.on("GET", ACLS, r.mock.answer("organization_acls"));
    r.mock
        .on("GET", ACLS, r.mock.answer("organization_acls_page2"));
    r.mock
        .on("GET", ORGANIZATIONS, r.mock.answer("organizations"));
    let cred = page_cred();
    let assets = r.li.list_assets(&cred).await.unwrap();
    let shown: Vec<(&str, &str, &str)> = assets
        .iter()
        .map(|a| (a.kind_key.as_str(), a.external_id.as_str(), a.name.as_str()))
        .collect();
    // Once each: the REQUESTED entry and the repeated one are not pages.
    assert_eq!(
        shown,
        [
            ("linkedin_member", SUB, "Jeeta Test"),
            ("linkedin_page", ORG, "Jeeta Test Kahve"),
            ("linkedin_page", ORG_2, "Jeeta Test Fırın"),
        ]
    );
    assert!(assets.iter().all(|a| a.credential == cred));
    assert_eq!(
        assets[1].public,
        json!({
            "organization_urn": "urn:li:organization:90000001",
            "name": "Jeeta Test Kahve",
            "vanity_name": "jeeta-test-kahve",
        })
    );
    assert_eq!(
        r.mock.lines(),
        [
            format!("GET {USERINFO}"),
            format!("GET {ACLS}"),
            format!("GET {ACLS}"),
            format!("GET {ORGANIZATIONS}"),
        ]
    );
    let lookup = r.mock.request("GET", ORGANIZATIONS);
    assert_eq!(lookup.raw_query, "ids=List(90000001,90000002)");
    lookup.assert_rest_headers(DEFAULT_API_VERSION);

    // Names that cannot be read leave the numbers as names.
    r.mock.clear();
    r.mock
        .set("GET", ACLS, r.mock.answer("organization_acls_other"));
    r.mock
        .set("GET", ORGANIZATIONS, r.mock.answer_with(403, "error_403"));
    let assets = r.li.list_assets(&cred).await.unwrap();
    let pages: Vec<(&str, &str)> = assets
        .iter()
        .filter(|a| a.kind_key == "linkedin_page")
        .map(|a| (a.external_id.as_str(), a.name.as_str()))
        .collect();
    assert_eq!(pages, [(ORG_2, ORG_2)]);
    // A short page without a `next` link ends the list.
    assert_eq!(r.mock.requests("GET", ACLS).len(), 1);

    // A failure of the access list itself fails the listing.
    r.mock.set("GET", ACLS, raw(500, "<html>oops</html>"));
    assert_eq!(kind_of(r.li.list_assets(&cred).await), "transient");
    r.mock.set("GET", ACLS, ok(json!({ "paging": {} })));
    assert_eq!(kind_of(r.li.list_assets(&cred).await), "permanent");
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn post_text_sends_rest_posts_with_version_headers_and_reads_restli_id() {
    let r = rig().await;
    r.mock.on("POST", POSTS, created(SHARE));
    let mut request = post("Merhaba LinkedIn", vec![]);
    // LinkedIn has no such setting: ignored.
    request.privacy = Some("SELF_ONLY".into());
    let receipt =
        r.li.publish(&member_cred(), &member_public(), &request)
            .await
            .unwrap();
    assert_eq!(receipt.external_id, SHARE);
    assert_eq!(
        receipt.url.as_ref().map(Url::as_str),
        Some("https://www.linkedin.com/feed/update/urn:li:share:7100000000000000001/")
    );
    let call = r.mock.request("POST", POSTS);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(call.header("content-type"), Some("application/json"));
    call.assert_rest_headers(DEFAULT_API_VERSION);
    assert!(call.raw_query.is_empty());
    assert_eq!(
        call.json(),
        post_body(&member_author(), "Merhaba LinkedIn", None)
    );

    // A page posts as its organization; a `ugcPost` id is a post id too.
    r.mock.clear();
    r.mock.set("POST", POSTS, created(UGC_POST));
    let receipt =
        r.li.publish(&page_cred(), &page_public(), &post("Merhaba", vec![]))
            .await
            .unwrap();
    assert_eq!(receipt.external_id, UGC_POST);
    assert_eq!(
        r.mock.request("POST", POSTS).json()["author"],
        json!(page_author())
    );

    // Accepted without a post id the adapter can read: it may well be live.
    for reply in [
        raw(201, ""),
        created("urn:li:image:C4E10AQtestimage1"),
        created("urn:li:share:1/../2"),
        raw(201, "not json"),
    ] {
        r.mock.set("POST", POSTS, reply.clone());
        let e =
            r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
                .await
                .unwrap_err();
        assert_eq!(e.kind(), "unknown", "{reply:?}: {e}");
    }
}

#[tokio::test]
async fn commentary_is_little_text_escaped() {
    let r = rig().await;
    r.mock.on("POST", POSTS, created(SHARE));
    let text =
        "Yeni menü (bugün) @kahve #taze 50% *indirim* _yalnızca_ [bugün] {x} <y> a|b ~c \\d # yok";
    r.li.publish(&member_cred(), &member_public(), &post(text, vec![]))
        .await
        .unwrap();
    assert_eq!(
        r.mock.request("POST", POSTS).json()["commentary"],
        json!(
            "Yeni menü \\(bugün\\) \\@kahve #taze 50% \\*indirim\\* \\_yalnızca\\_ \\[bugün\\] \
             \\{x\\} \\<y\\> a\\|b \\~c \\\\d \\# yok"
        )
    );
    // A would-be mention is text, and the length is counted before escaping.
    r.mock.clear();
    let longest = "(".repeat(MAX_COMMENTARY_CHARS);
    r.li.publish(&member_cred(), &member_public(), &post(&longest, vec![]))
        .await
        .unwrap();
    assert_eq!(
        r.mock.request("POST", POSTS).json()["commentary"],
        json!("\\(".repeat(MAX_COMMENTARY_CHARS))
    );
    r.mock.clear();
    let too_long = "a".repeat(MAX_COMMENTARY_CHARS + 1);
    assert_eq!(
        kind_of(
            r.li.publish(&member_cred(), &member_public(), &post(&too_long, vec![]))
                .await
        ),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn link_becomes_article() {
    let r = rig().await;
    r.mock.on("POST", POSTS, created(SHARE));
    let link = "https://jeeta.test/menu";
    r.li.publish(
        &page_cred(),
        &page_public(),
        &with_link(post("Yeni menü", vec![]), link),
    )
    .await
    .unwrap();
    assert_eq!(
        r.mock.request("POST", POSTS).json(),
        post_body(
            &page_author(),
            "Yeni menü",
            Some(json!({ "article": { "source": link, "title": link } }))
        )
    );

    // A link alone; a long one's title is cut under LinkedIn's 400.
    r.mock.clear();
    let long = format!("https://jeeta.test/{}", "m".repeat(500));
    r.li.publish(
        &page_cred(),
        &page_public(),
        &with_link(post("", vec![]), &long),
    )
    .await
    .unwrap();
    let body = r.mock.request("POST", POSTS).json();
    assert_eq!(body["commentary"], json!(""));
    assert_eq!(body["content"]["article"]["source"], json!(long));
    assert_eq!(
        body["content"]["article"]["title"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        399
    );

    // With media the link goes after the text, escaped like it; no article.
    r.mock.clear();
    r.mock.on("POST", IMAGES, r.mock.answer("image_init"));
    r.mock.on("PUT", IMAGE_UPLOAD_1, raw(201, ""));
    r.li.publish(
        &page_cred(),
        &page_public(),
        &with_link(post("Yeni", vec![png(16)]), "https://jeeta.test/a_b"),
    )
    .await
    .unwrap();
    let body = r.mock.request("POST", POSTS).json();
    assert_eq!(
        body["commentary"],
        json!("Yeni\n\nhttps://jeeta.test/a\\_b")
    );
    assert_eq!(body["content"], json!({ "media": { "id": IMAGE_1 } }));
}

#[tokio::test]
async fn image_upload_init_put_then_media_content() {
    let r = rig().await;
    r.mock.on("POST", IMAGES, r.mock.answer("image_init"));
    r.mock.on("PUT", IMAGE_UPLOAD_1, raw(201, ""));
    r.mock.on("POST", POSTS, created(SHARE));
    let image = png(1024);
    let receipt =
        r.li.publish(
            &page_cred(),
            &page_public(),
            &post("Bugünün menüsü", vec![image.clone()]),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, SHARE);
    assert_eq!(
        r.mock.lines(),
        [
            format!("POST {IMAGES}"),
            format!("PUT {IMAGE_UPLOAD_1}"),
            format!("POST {POSTS}"),
        ]
    );
    let init = r.mock.request("POST", IMAGES);
    assert_eq!(init.raw_query, "action=initializeUpload");
    assert_eq!(init.bearer(), Some(ACCESS_TOKEN));
    init.assert_rest_headers(DEFAULT_API_VERSION);
    assert_eq!(
        init.json(),
        json!({ "initializeUploadRequest": { "owner": page_author() } })
    );
    // The bytes go to the URL LinkedIn handed out, as it handed it out, with the token.
    let put = r.mock.request("PUT", IMAGE_UPLOAD_1);
    assert_eq!(put.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(put.header("content-type"), Some("image/png"));
    assert_eq!(put.header("linkedin-version"), None);
    assert_eq!(put.bytes, image.bytes);
    assert_eq!(
        put.raw_query,
        "ca=vector_feedshare&cn=uploads&sync=0&v=beta&ut=upload-SECRET-image-1"
    );
    assert_eq!(
        r.mock.request("POST", POSTS).json(),
        post_body(
            &page_author(),
            "Bugünün menüsü",
            Some(json!({ "media": { "id": IMAGE_1 } }))
        )
    );

    // A failed upload stops the post; an expired upload URL (401) is the URL's, not the token's.
    for (reply, expected) in [
        (raw(400, ""), "permanent"),
        (raw(401, ""), "permanent"),
        (raw(500, ""), "transient"),
    ] {
        r.mock.clear();
        r.mock.set("PUT", IMAGE_UPLOAD_1, reply.clone());
        let e =
            r.li.publish(&page_cred(), &page_public(), &post("Merhaba", vec![png(8)]))
                .await
                .unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
        assert_no_secret(&format!("{e} {e:?}"));
        assert!(r.mock.requests("POST", POSTS).is_empty());
    }

    // An init answer without an upload URL or image URN: nothing is uploaded.
    for value in [
        json!({ "value": { "image": IMAGE_1 } }),
        json!({ "value": { "uploadUrl": "https://www.linkedin.com/dms-uploads/x" } }),
        json!({ "value": { "image": "urn:li:video:1", "uploadUrl": "https://www.linkedin.com/x" } }),
    ] {
        r.mock.clear();
        r.mock.set("POST", IMAGES, ok(value.clone()));
        assert_eq!(
            kind_of(
                r.li.publish(&page_cred(), &page_public(), &post("Merhaba", vec![png(8)]))
                    .await
            ),
            "permanent",
            "{value}"
        );
        assert_eq!(r.mock.lines(), [format!("POST {IMAGES}")]);
    }
    // An upload URL on a host the linkedin tier does not hold is never reached.
    r.mock.clear();
    r.mock.set(
        "POST",
        IMAGES,
        ok(json!({ "value": { "image": IMAGE_1, "uploadUrl": "https://uploads.example.com/x?t=1" } })),
    );
    let e =
        r.li.publish(&page_cred(), &page_public(), &post("Merhaba", vec![png(8)]))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent", "{e}");
    assert_eq!(r.mock.lines(), [format!("POST {IMAGES}")]);
}

#[tokio::test]
async fn multi_image_post() {
    let r = rig().await;
    r.mock.on("POST", IMAGES, r.mock.answer("image_init"));
    r.mock.on("POST", IMAGES, r.mock.answer("image_init_2"));
    r.mock.on("PUT", IMAGE_UPLOAD_1, raw(201, ""));
    r.mock.on("PUT", IMAGE_UPLOAD_2, raw(201, ""));
    r.mock.on("POST", POSTS, created(UGC_POST));
    let first = png(8);
    let second = file(16, " IMAGE/JPEG ", "b.jpg");
    r.li.publish(
        &member_cred(),
        &member_public(),
        &post("İki fotoğraf", vec![first.clone(), second.clone()]),
    )
    .await
    .unwrap();
    assert_eq!(
        r.mock.lines(),
        [
            format!("POST {IMAGES}"),
            format!("PUT {IMAGE_UPLOAD_1}"),
            format!("POST {IMAGES}"),
            format!("PUT {IMAGE_UPLOAD_2}"),
            format!("POST {POSTS}"),
        ]
    );
    for init in r.mock.requests("POST", IMAGES) {
        assert_eq!(
            init.json(),
            json!({ "initializeUploadRequest": { "owner": member_author() } })
        );
    }
    let put = r.mock.request("PUT", IMAGE_UPLOAD_2);
    assert_eq!(put.header("content-type"), Some("image/jpeg"));
    assert_eq!(put.bytes, second.bytes);
    assert_eq!(r.mock.request("PUT", IMAGE_UPLOAD_1).bytes, first.bytes);
    assert_eq!(
        r.mock.request("POST", POSTS).json(),
        post_body(
            &member_author(),
            "İki fotoğraf",
            Some(json!({ "multiImage": { "images": [ { "id": IMAGE_1 }, { "id": IMAGE_2 } ] } }))
        )
    );

    // Up to twenty go; twenty-one are refused before anything is sent.
    assert_eq!(MAX_IMAGES, 20);
    assert_eq!(IMAGE_MIMES, ["image/jpeg", "image/png", "image/gif"]);
    r.mock.clear();
    r.li.publish(
        &member_cred(),
        &member_public(),
        &post("Galeri", (0..MAX_IMAGES).map(|_| jpeg(8)).collect()),
    )
    .await
    .unwrap();
    assert_eq!(r.mock.requests("POST", IMAGES).len(), MAX_IMAGES);
    let images = r.mock.request("POST", POSTS).json()["content"]["multiImage"]["images"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(images, MAX_IMAGES);
    r.mock.clear();
    let e =
        r.li.publish(
            &member_cred(),
            &member_public(),
            &post("Galeri", (0..=MAX_IMAGES).map(|_| png(8)).collect()),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn video_init_parts_finalize() {
    let r = rig().await;
    r.mock.on("POST", VIDEOS, r.mock.answer("video_init"));
    // The finalize call answers 200 with no body.
    r.mock.on("POST", VIDEOS, raw(200, ""));
    r.mock.on(
        "PUT",
        VIDEO_PART_0,
        raw(200, "").with_header("etag", "\"etag-part-0\""),
    );
    r.mock.on(
        "PUT",
        VIDEO_PART_1,
        raw(200, "").with_header("etag", "/ambry-video/signedId/part-1.bin"),
    );
    r.mock.on("POST", POSTS, created(UGC_POST));
    let video = mp4(VIDEO_BYTES);
    assert_eq!(VIDEO_MIME, "video/mp4");
    // A video wins over images: the image is left out.
    let receipt =
        r.li.publish(
            &page_cred(),
            &page_public(),
            &post("Tanıtım", vec![png(8), video.clone()]),
        )
        .await
        .unwrap();
    assert_eq!(receipt.external_id, UGC_POST);
    assert_eq!(
        r.mock.lines(),
        [
            format!("POST {VIDEOS}"),
            format!("PUT {VIDEO_PART_0}"),
            format!("PUT {VIDEO_PART_1}"),
            format!("POST {VIDEOS}"),
            format!("POST {POSTS}"),
        ]
    );
    let videos = r.mock.requests("POST", VIDEOS);
    assert_eq!(videos[0].raw_query, "action=initializeUpload");
    videos[0].assert_rest_headers(DEFAULT_API_VERSION);
    assert_eq!(
        videos[0].json(),
        json!({ "initializeUploadRequest": {
            "owner": page_author(),
            "fileSizeBytes": VIDEO_BYTES,
            "uploadCaptions": false,
            "uploadThumbnail": false,
        }})
    );
    assert_eq!(videos[1].raw_query, "action=finalizeUpload");
    videos[1].assert_rest_headers(DEFAULT_API_VERSION);
    assert_eq!(
        videos[1].json(),
        json!({ "finalizeUploadRequest": {
            "video": VIDEO,
            "uploadToken": "",
            "uploadedPartIds": ["etag-part-0", "/ambry-video/signedId/part-1.bin"],
        }})
    );
    // Each part carries its own bytes, as octets, and no token.
    for (path, range) in [
        (VIDEO_PART_0, 0..60_000),
        (VIDEO_PART_1, 60_000..VIDEO_BYTES),
    ] {
        let part = r.mock.request("PUT", path);
        assert_eq!(part.header("authorization"), None, "{path}");
        assert_eq!(
            part.header("content-type"),
            Some("application/octet-stream")
        );
        assert_eq!(part.header("linkedin-version"), None);
        assert_eq!(part.bytes, video.bytes[range]);
    }
    assert_eq!(
        r.mock.request("POST", POSTS).json(),
        post_body(
            &page_author(),
            "Tanıtım",
            Some(json!({ "media": { "id": VIDEO } }))
        )
    );

    // A part answer without its ETag: nothing is finalized or posted.
    r.mock.clear();
    r.mock.set("POST", VIDEOS, r.mock.answer("video_init"));
    r.mock.set("PUT", VIDEO_PART_1, raw(200, ""));
    assert_eq!(
        kind_of(
            r.li.publish(&page_cred(), &page_public(), &post("", vec![video.clone()]))
                .await
        ),
        "permanent"
    );
    assert_eq!(r.mock.requests("POST", VIDEOS).len(), 1);
    assert!(r.mock.requests("POST", POSTS).is_empty());

    // Instructions that do not cover the file are refused before any part is sent.
    r.mock.clear();
    let mut init = r.mock.fixture("video_init");
    init["value"]["uploadInstructions"][1]["lastByte"] = json!(99_998);
    r.mock.set("POST", VIDEOS, ok(init));
    assert_eq!(
        kind_of(
            r.li.publish(&page_cred(), &page_public(), &post("", vec![video.clone()]))
                .await
        ),
        "permanent"
    );
    assert_eq!(r.mock.lines(), [format!("POST {VIDEOS}")]);

    // Two videos, or one too small: refused before anything is sent.
    r.mock.clear();
    for media in [
        vec![video.clone(), video.clone()],
        vec![mp4(MIN_VIDEO_BYTES - 1)],
    ] {
        assert_eq!(
            kind_of(
                r.li.publish(&page_cred(), &page_public(), &post("Video", media))
                    .await
            ),
            "permanent"
        );
    }
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn publish_refuses_before_any_call() {
    let r = rig().await;
    let with_urls = PublishRequest {
        text: "Merhaba".into(),
        media_urls: vec![Url::parse("https://cdn.test/a.png").unwrap()],
        ..PublishRequest::default()
    };
    let mut no_account = member_public();
    no_account.as_object_mut().unwrap().remove("external_id");
    let mut bad_account = page_public();
    bad_account["external_id"] = json!("90000001/../1");
    let refused: Vec<(&str, Value, PublishRequest)> = vec![
        (
            "media URLs without bytes",
            member_public(),
            with_urls.clone(),
        ),
        (
            "more bytes than URLs",
            member_public(),
            PublishRequest {
                media: vec![png(8), png(8)],
                ..with_urls.clone()
            },
        ),
        ("an empty image", member_public(), post("a", vec![png(0)])),
        (
            "a bitmap",
            member_public(),
            post("a", vec![file(8, "image/bmp", "a.bmp")]),
        ),
        (
            "a WebP",
            member_public(),
            post("a", vec![file(8, "image/webp", "a.webp")]),
        ),
        ("nothing to post", member_public(), post(" \n", vec![])),
        ("no account", no_account, post("a", vec![])),
        ("a misshapen account", bad_account, post("a", vec![])),
    ];
    for (what, public, request) in &refused {
        let e =
            r.li.publish(&member_cred(), public, request)
                .await
                .expect_err(what);
        assert_eq!(e.kind(), "permanent", "{what}: {e}");
    }
    let e =
        r.li.publish(&member_cred(), &member_public(), &with_urls)
            .await
            .unwrap_err();
    assert_eq!(e.reason(), Some("linkedin needs media bytes"));
    let e =
        r.li.publish(&member_cred(), &member_public(), &refused[1].2)
            .await
            .unwrap_err();
    assert_eq!(e.reason(), Some("media bytes and urls disagree"));
    let foreign = Credential::PageToken {
        page_id: "1".into(),
        token: "EAAB-SECRET".into(),
    };
    assert_eq!(
        kind_of(
            r.li.publish(&foreign, &member_public(), &post("a", vec![]))
                .await
        ),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty(), "{:?}", r.mock.lines());

    // As many bytes as URLs: the bytes are uploaded, no URL is handed to LinkedIn.
    r.mock.on("POST", IMAGES, r.mock.answer("image_init"));
    r.mock.on("PUT", IMAGE_UPLOAD_1, raw(201, ""));
    r.mock.on("POST", POSTS, created(SHARE));
    let both = PublishRequest {
        media: vec![png(32)],
        ..with_urls
    };
    r.li.publish(&member_cred(), &member_public(), &both)
        .await
        .unwrap();
    assert_eq!(r.mock.request("PUT", IMAGE_UPLOAD_1).bytes, png(32).bytes);
    assert!(
        r.mock
            .recorded()
            .iter()
            .all(|c| !c.body().contains("cdn.test")),
        "no URL is handed to LinkedIn"
    );
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn error_426_names_version() {
    let r = rig_with(apps_with_version("202401"), jt_linkedin::ATTEMPT_TIMEOUT).await;
    r.mock
        .on("POST", POSTS, r.mock.answer_with(426, "error_426"));
    r.mock
        .on("GET", NETWORK_SIZE, r.mock.answer_with(426, "error_426"));
    let e =
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        (
            "permanent",
            Some(
                "HTTP 426 NONEXISTENT_VERSION: Requested version 202401 is not active \
                 (Linkedin-Version 202401 sent)"
            )
        )
    );
    assert_eq!(
        r.mock.request("POST", POSTS).header("linkedin-version"),
        Some("202401")
    );
    // A read the same way, and not tried again: an answer arrived.
    let e =
        r.li.account_metrics(&page_cred(), &page_public())
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(e.reason().unwrap().contains("202401 sent"), "{e}");
    assert_eq!(r.mock.requests("GET", NETWORK_SIZE).len(), 1);
}

#[tokio::test]
async fn error_mapping_auth() {
    let r = rig().await;
    r.mock
        .on("POST", POSTS, r.mock.answer_with(401, "error_401"));
    r.mock
        .on("GET", USERINFO, r.mock.answer_with(401, "error_401"));
    let e =
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        (
            "auth",
            Some("HTTP 401 INVALID_ACCESS_TOKEN: Invalid access token")
        )
    );
    let e =
        r.li.probe(&member_cred(), &member_public())
            .await
            .error
            .unwrap();
    assert_eq!(e.kind(), "auth");
    // A legacy body naming only its service error code.
    r.mock.set(
        "POST",
        POSTS,
        status(
            401,
            json!({ "status": 401, "serviceErrorCode": 65601, "message": "The token used in the request has been revoked by the user" }),
        ),
    );
    let e =
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err();
    assert_eq!(
        e.reason(),
        Some("HTTP 401 65601: The token used in the request has been revoked by the user")
    );
}

#[tokio::test]
async fn error_mapping_permission() {
    let r = rig().await;
    r.mock
        .on("POST", POSTS, r.mock.answer_with(403, "error_403"));
    r.mock
        .on("GET", STATS, r.mock.answer_with(403, "error_403"));
    let e =
        r.li.publish(&page_cred(), &page_public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        (
            "permission",
            Some(
                "HTTP 403 ACCESS_DENIED: Not enough permissions to access: \
                 partnerApiPostsExternal.CREATE.20261001"
            )
        )
    );
    assert_eq!(
        kind_of(r.li.post_metrics(&page_cred(), &page_public(), SHARE).await),
        "permission"
    );
}

#[tokio::test]
async fn error_mapping_throttle() {
    let r = rig().await;
    r.mock
        .on("POST", POSTS, r.mock.answer_with(429, "error_429"));
    assert_eq!(
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err(),
        ConnectorError::throttle(None)
    );
    // A wait named in `Retry-After` is kept, capped at an hour.
    r.mock.set(
        "POST",
        POSTS,
        r.mock
            .answer_with(429, "error_429")
            .with_header("retry-after", "30"),
    );
    assert_eq!(
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err(),
        ConnectorError::throttle(Some(Duration::seconds(30)))
    );
    r.mock.set(
        "GET",
        USERINFO,
        raw(429, "slow down").with_header("retry-after", "86400"),
    );
    let e =
        r.li.probe(&member_cred(), &member_public())
            .await
            .error
            .unwrap();
    assert_eq!(
        e,
        ConnectorError::throttle(Some(jt_linkedin::MAX_RETRY_AFTER))
    );
    // A throttled read is not tried again: an answer arrived.
    assert_eq!(r.mock.requests("GET", USERINFO).len(), 1);
}

#[tokio::test]
async fn error_mapping_5xx() {
    let r = rig().await;
    for (reply, expected, quoted) in [
        (
            r.mock.answer_with(500, "error_500"),
            "transient",
            "HTTP 500 INTERNAL_SERVER_ERROR",
        ),
        (
            raw(502, "<html>bad gateway</html>"),
            "transient",
            "HTTP 502 with an unreadable body",
        ),
        (raw(503, ""), "transient", "HTTP 503"),
        (raw(504, "timeout"), "transient", "HTTP 504"),
        (
            r.mock.answer_with(400, "error_400"),
            "permanent",
            "HTTP 400 FIELD_LENGTH_TOO_LONG: /commentary",
        ),
        (
            status(
                404,
                json!({ "status": 404, "code": "NOT_FOUND", "message": "gone" }),
            ),
            "permanent",
            "HTTP 404 NOT_FOUND: gone",
        ),
        (raw(302, ""), "permanent", "HTTP 302"),
    ] {
        r.mock.set("POST", POSTS, reply.clone());
        r.mock.set("GET", NETWORK_SIZE, reply.clone());
        let e =
            r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
                .await
                .unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
        assert!(e.reason().unwrap().starts_with(quoted), "{quoted}: {e}");
        let e =
            r.li.account_metrics(&page_cred(), &page_public())
                .await
                .unwrap_err();
        assert_eq!(e.kind(), expected, "GET {reply:?}: {e}");
    }
    // A server error on a call that got an answer is never sent again.
    assert_eq!(r.mock.requests("GET", NETWORK_SIZE).len(), 7);
    assert_eq!(r.mock.requests("POST", POSTS).len(), 7);
}

// ---------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn member_metrics_are_permanent_unsupported() {
    let r = rig().await;
    let e =
        r.li.post_metrics(&member_cred(), &member_public(), SHARE)
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        ("permanent", Some("LinkedIn exposes no member post metrics"))
    );
    assert!(!e.is_retriable());
    let e =
        r.li.account_metrics(&member_cred(), &member_public())
            .await
            .unwrap_err();
    assert_eq!(
        (e.kind(), e.reason()),
        (
            "permanent",
            Some("LinkedIn exposes no member account metrics")
        )
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn org_share_statistics_map_counts() {
    let r = rig().await;
    r.mock.on("GET", STATS, r.mock.answer("share_statistics"));
    let metrics =
        r.li.post_metrics(&page_cred(), &page_public(), SHARE)
            .await
            .unwrap();
    let expected: Vec<(String, i64)> = [
        ("click_count", 78),
        ("comment_count", 24),
        ("impression_count", 5287),
        ("like_count", 14),
        ("share_count", 5),
        ("unique_impressions_count", 3100),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), *v))
    .collect();
    assert_eq!(metrics.metrics.into_iter().collect::<Vec<_>>(), expected);
    let call = r.mock.request("GET", STATS);
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    call.assert_rest_headers(DEFAULT_API_VERSION);
    assert_eq!(
        call.raw_query,
        "q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A90000001\
         &shares=List(urn%3Ali%3Ashare%3A7100000000000000001)"
    );

    // A ugcPost is asked for under `ugcPosts`; a counter that is not a whole number is left out
    // (and one may be negative, LinkedIn says).
    r.mock.clear();
    r.mock
        .set("GET", STATS, r.mock.answer("ugc_post_statistics"));
    let metrics =
        r.li.post_metrics(&page_cred(), &page_public(), UGC_POST)
            .await
            .unwrap();
    let expected: Vec<(String, i64)> = [
        ("click_count", 1),
        ("comment_count", 0),
        ("impression_count", 5),
        ("like_count", -1),
        ("share_count", 0),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), *v))
    .collect();
    assert_eq!(metrics.metrics.into_iter().collect::<Vec<_>>(), expected);
    assert!(
        r.mock
            .request("GET", STATS)
            .raw_query
            .ends_with("&ugcPosts=List(urn%3Ali%3AugcPost%3A7100000000000000002)")
    );

    // A post LinkedIn leaves out (no actions, no impressions) reads zero on every counter; an
    // element for another post is not this one's.
    for answer in [
        json!({ "paging": { "start": 0, "count": 10 }, "elements": [] }),
        json!({ "elements": [ { "share": "urn:li:share:9", "totalShareStatistics": { "likeCount": 99 } } ] }),
        json!({ "elements": [ { "totalShareStatistics": { "likeCount": 99 } } ] }),
    ] {
        r.mock.set("GET", STATS, ok(answer.clone()));
        let metrics =
            r.li.post_metrics(&page_cred(), &page_public(), SHARE)
                .await
                .unwrap();
        assert_eq!(metrics.metrics.len(), 6, "{answer}");
        assert!(metrics.metrics.values().all(|v| *v == 0), "{answer}");
    }
    r.mock.set("GET", STATS, ok(json!({ "paging": {} })));
    assert_eq!(
        kind_of(r.li.post_metrics(&page_cred(), &page_public(), SHARE).await),
        "permanent"
    );

    // An id that is not a post URN: refused without a call.
    r.mock.clear();
    for bad in [
        "",
        "7100",
        "urn:li:share:1)",
        "urn:li:video:C1",
        "urn:li:share:1&x=2",
    ] {
        assert_eq!(
            kind_of(r.li.post_metrics(&page_cred(), &page_public(), bad).await),
            "permanent",
            "{bad:?}"
        );
    }
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn org_follower_count() {
    let r = rig().await;
    r.mock
        .on("GET", NETWORK_SIZE, r.mock.answer("network_size"));
    let metrics =
        r.li.account_metrics(&page_cred(), &page_public())
            .await
            .unwrap();
    assert_eq!(
        metrics.metrics.into_iter().collect::<Vec<_>>(),
        [("follower_count".to_owned(), 219)]
    );
    let call = r.mock.request("GET", NETWORK_SIZE);
    assert_eq!(call.raw_query, "edgeType=COMPANY_FOLLOWED_BY_MEMBER");
    assert_eq!(call.bearer(), Some(ACCESS_TOKEN));
    call.assert_rest_headers(DEFAULT_API_VERSION);
    r.mock.set("GET", NETWORK_SIZE, ok(json!({})));
    assert_eq!(
        kind_of(r.li.account_metrics(&page_cred(), &page_public()).await),
        "permanent"
    );
}

#[tokio::test]
async fn api_version_override_is_sent() {
    let r = rig_with(apps_with_version("202601"), jt_linkedin::ATTEMPT_TIMEOUT).await;
    r.mock.on("POST", POSTS, created(SHARE));
    r.mock
        .on("GET", NETWORK_SIZE, r.mock.answer("network_size"));
    r.mock.on("GET", USERINFO, r.mock.answer("userinfo"));
    r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
        .await
        .unwrap();
    r.li.account_metrics(&page_cred(), &page_public())
        .await
        .unwrap();
    r.mock.request("POST", POSTS).assert_rest_headers("202601");
    r.mock
        .request("GET", NETWORK_SIZE)
        .assert_rest_headers("202601");
    // OpenID userinfo stays unversioned.
    assert!(r.li.probe(&member_cred(), &member_public()).await.ok);
    assert_eq!(
        r.mock.request("GET", USERINFO).header("linkedin-version"),
        None
    );

    // A configured value that is no version: refused before anything is sent.
    for bad in ["2026-01", "202613", "latest"] {
        let r = rig_with(apps_with_version(bad), jt_linkedin::ATTEMPT_TIMEOUT).await;
        let e =
            r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
                .await
                .unwrap_err();
        assert_eq!(e.kind(), "permanent", "{bad}");
        assert!(r.mock.recorded().is_empty());
    }
    // A blank one is no override.
    let r = rig_with(apps_with_version("  "), jt_linkedin::ATTEMPT_TIMEOUT).await;
    r.mock.on("POST", POSTS, created(SHARE));
    r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
        .await
        .unwrap();
    r.mock
        .request("POST", POSTS)
        .assert_rest_headers(DEFAULT_API_VERSION);
}

// ---------------------------------------------------------------------------------------------
// Kinds and secrets
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn kind_key_must_be_linkedin() {
    let r = rig().await;
    for public in [
        json!({}),
        json!(null),
        json!({ "kind_key": null }),
        json!({ "kind_key": "LinkedIn_Page" }),
        json!({ "kind_key": "linkedin_ads" }),
        json!({ "kind_key": "x", "external_id": SUB }),
    ] {
        let errors = [
            r.li.publish(&page_cred(), &public, &post("Merhaba", vec![]))
                .await
                .map(drop),
            r.li.post_metrics(&page_cred(), &public, SHARE)
                .await
                .map(drop),
            r.li.account_metrics(&page_cred(), &public).await.map(drop),
            r.li.probe(&page_cred(), &public)
                .await
                .error
                .map_or(Ok(()), Err),
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

#[tokio::test]
async fn no_secret_in_errors() {
    let r = rig().await;
    let member = OAuthApp::Linkedin(linkedin_app(false));
    let mut errors: Vec<ConnectorError> = Vec::new();
    // The token endpoint echoes what it was sent.
    let token_error = |code: u16, error: &str, description: String| {
        status(
            code,
            json!({ "error": error, "error_description": description }),
        )
    };
    for (code, error) in [(400, "invalid_request"), (503, "temporarily_unavailable")] {
        r.mock.set(
            "POST",
            TOKEN,
            token_error(
                code,
                error,
                format!("code {CODE} for client {CLIENT_ID}:{CLIENT_SECRET} is invalid"),
            ),
        );
        errors.push(
            r.li.exchange(&member, &redirect(), CODE, None)
                .await
                .unwrap_err(),
        );
        r.mock.set(
            "POST",
            TOKEN,
            token_error(
                code,
                error,
                format!("refresh token {REFRESH_TOKEN} with secret {CLIENT_SECRET} was revoked"),
            ),
        );
        errors.push(r.li.refresh(&page_cred()).await.unwrap_err());
    }
    // The API echoes the access token.
    for code in [400, 401, 403, 404, 426, 503] {
        let body = json!({
            "status": code,
            "code": "ECHO",
            "message": format!("token {ACCESS_TOKEN} rejected (Bearer {ACCESS_TOKEN})"),
        });
        for path in [POSTS, IMAGES, NETWORK_SIZE, STATS, USERINFO, ACLS] {
            let method =
                if path == NETWORK_SIZE || path == STATS || path == USERINFO || path == ACLS {
                    "GET"
                } else {
                    "POST"
                };
            r.mock.set(method, path, status(code, body.clone()));
        }
        errors.push(
            r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
                .await
                .unwrap_err(),
        );
        errors.push(
            r.li.publish(
                &member_cred(),
                &member_public(),
                &post("Merhaba", vec![png(8)]),
            )
            .await
            .unwrap_err(),
        );
        errors.push(
            r.li.account_metrics(&page_cred(), &page_public())
                .await
                .unwrap_err(),
        );
        errors.push(
            r.li.post_metrics(&page_cred(), &page_public(), SHARE)
                .await
                .unwrap_err(),
        );
        errors.push(
            r.li.probe(&member_cred(), &member_public())
                .await
                .error
                .unwrap(),
        );
        errors.push(r.li.list_assets(&page_cred()).await.unwrap_err());
    }
    // An upload URL's host echoes the URL it was sent to, upload token and all.
    r.mock.set("POST", IMAGES, r.mock.answer("image_init"));
    let url = r.mock.fixture("image_init")["value"]["uploadUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    for code in [400, 403, 500] {
        r.mock.set(
            "PUT",
            IMAGE_UPLOAD_1,
            status(
                code,
                json!({ "message": format!("bad upload to {url} (ut=upload-SECRET-image-1)") }),
            ),
        );
        errors.push(
            r.li.publish(
                &member_cred(),
                &member_public(),
                &post("Merhaba", vec![png(8)]),
            )
            .await
            .unwrap_err(),
        );
    }
    assert_eq!(errors.len(), 4 + 6 * 6 + 3);
    let kinds: std::collections::BTreeSet<&str> = errors.iter().map(|e| e.kind()).collect();
    assert_eq!(
        kinds,
        ["auth", "permanent", "permission", "transient"]
            .into_iter()
            .collect()
    );
    for e in &errors {
        assert_no_secret(&format!("{e} {e:?}"));
    }
    // LinkedIn's words are still there around the secret.
    assert!(
        errors[0].reason().unwrap().contains("is invalid"),
        "{}",
        errors[0]
    );
    assert!(
        errors
            .last()
            .unwrap()
            .reason()
            .unwrap()
            .contains("bad upload to"),
        "{}",
        errors.last().unwrap()
    );

    // Nor in the `Debug` of the adapter, its bases, a credential, the app, a request.
    let printed = format!(
        "{:?} {:?} {:?} {:?} {:?} {:?}",
        r.li,
        r.li.bases(),
        member_cred(),
        page_cred(),
        linkedin_app(true),
        post("Merhaba", vec![png(64)])
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
    // A socket that closes every connection: no answer ever arrives.
    let dropper = Dropper::start().await;
    let li = connector_at(dropper.addr, TestApps::default(), StdDuration::from_secs(5));
    let count = |before: usize| dropper.accepted() - before;
    let member = OAuthApp::Linkedin(linkedin_app(false));

    // Writes: once, and their outcome is unknown.
    for (name, attempt) in [
        ("post", {
            let before = dropper.accepted();
            let e = li
                .publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
                .await
                .unwrap_err();
            (count(before), e)
        }),
        ("image upload", {
            let before = dropper.accepted();
            let e = li
                .publish(
                    &member_cred(),
                    &member_public(),
                    &post("Merhaba", vec![png(8)]),
                )
                .await
                .unwrap_err();
            (count(before), e)
        }),
        ("code exchange", {
            let before = dropper.accepted();
            let e = li
                .exchange(&member, &redirect(), CODE, None)
                .await
                .unwrap_err();
            (count(before), e)
        }),
        ("refresh", {
            let before = dropper.accepted();
            let e = li.refresh(&page_cred()).await.unwrap_err();
            (count(before), e)
        }),
    ] {
        let (connections, e) = attempt;
        assert_eq!(connections, 1, "{name} is sent once");
        assert_eq!(e.kind(), "unknown", "{name}: {e}");
        assert!(!e.is_retriable());
        assert!(
            e.reason().unwrap().contains("outcome is unknown"),
            "{name}: {e}"
        );
    }

    // Reads are tried once more, exactly.
    assert_eq!(READ_ATTEMPTS, 2);
    for (name, attempt) in [
        ("member probe", {
            let before = dropper.accepted();
            let e = li
                .probe(&member_cred(), &member_public())
                .await
                .error
                .unwrap();
            (count(before), e)
        }),
        ("page probe", {
            let before = dropper.accepted();
            let e = li.probe(&page_cred(), &page_public()).await.error.unwrap();
            (count(before), e)
        }),
        ("account_metrics", {
            let before = dropper.accepted();
            let e = li
                .account_metrics(&page_cred(), &page_public())
                .await
                .unwrap_err();
            (count(before), e)
        }),
        ("post_metrics", {
            let before = dropper.accepted();
            let e = li
                .post_metrics(&page_cred(), &page_public(), SHARE)
                .await
                .unwrap_err();
            (count(before), e)
        }),
        ("list_assets", {
            let before = dropper.accepted();
            let e = li.list_assets(&member_cred()).await.unwrap_err();
            (count(before), e)
        }),
    ] {
        let (connections, e) = attempt;
        assert_eq!(connections, 2, "{name}");
        assert_eq!(e.kind(), "transient", "{name}: {e}");
        assert!(e.reason().unwrap().contains("no answer"), "{name}: {e}");
    }

    // A read that timed out is tried again, and the second answer is read.
    let r = rig_with(TestApps::default(), SHORT_TIMEOUT).await;
    r.mock
        .on("GET", USERINFO, r.mock.answer("userinfo").delayed(STALL));
    r.mock.on("GET", USERINFO, r.mock.answer("userinfo"));
    let result = r.li.probe(&member_cred(), &member_public()).await;
    assert!(result.ok, "{result:?}");
    assert_eq!(r.mock.requests("GET", USERINFO).len(), 2);
    // A post that times out is not sent again.
    r.mock.on("POST", POSTS, created(SHARE).delayed(STALL));
    let e =
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba", vec![]))
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "unknown", "{e}");
    assert_eq!(r.mock.requests("POST", POSTS).len(), 1);
}

#[tokio::test]
async fn broken_response_body_preserves_write_uncertainty() {
    let addr = broken_response().await;
    let li = connector_at(addr, TestApps::default(), StdDuration::from_secs(5));
    for media in [vec![], vec![png(8)]] {
        let e = li
            .publish(&member_cred(), &member_public(), &post("hello", media))
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "unknown", "{e}");
        assert!(!e.is_retriable());
    }
    assert_eq!(
        li.probe(&member_cred(), &member_public())
            .await
            .error
            .unwrap()
            .kind(),
        "transient"
    );
}
