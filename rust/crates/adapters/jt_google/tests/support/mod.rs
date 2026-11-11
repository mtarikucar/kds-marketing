//! The in-process Google mock and the adapter wired to it.
//!
//! The mock listens on 127.0.0.1 (an ephemeral port) and stands for both Google hosts at once, by
//! path prefix: `/api` for `googleads.googleapis.com` and `/oauth` for `oauth2.googleapis.com`.
//! A test queues replies for a `(method, path)`, optionally only for requests whose body holds a
//! given piece of text (every search goes to one path: the query tells them apart). Replies are
//! given in order, the last one repeating; anything unscripted is a 404 in Google's error shape.
//! Every request is recorded (method, path, headers, body bytes). Nothing reaches the internet:
//! the adapter's egress client allows the mock's address only (`test-loopback`).
//!
//! Every value is synthetic: the accounts `1234567890`, `2000000002`..., made-up tokens, codes
//! and client credentials.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use jt_app::ports::connectors::{GoogleApp, InstagramApp, MetaApp, PlatformAppConfig, XApp};
use jt_connector::Credential;
use jt_google::{ADS_SCOPE, GoogleBases, GoogleConnector};
use jt_outbound::{Egress, FIXED_HOSTS};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use tokio::net::TcpListener;
use url::Url;

/// The platform's Google client of the tests.
pub const CLIENT_ID: &str = "g-client-test.apps.googleusercontent.test";
/// Its secret: no error text, `Debug` output or log line may ever contain it.
pub const CLIENT_SECRET: &str = "g-client-SECRET-test";
/// The access token of the tests' credentials.
pub const ACCESS_TOKEN: &str = "g-access-test-0";
/// The refresh token of the tests' credentials.
pub const REFRESH_TOKEN: &str = "g-refresh-test-0";
/// An access token the token endpoint hands out.
pub const MINTED_TOKEN: &str = "g-access-test-minted";
/// An authorization code.
pub const CODE: &str = "g-code-test-0";
/// The ad account of the tests.
pub const CUSTOMER: &str = "1234567890";

pub const TOKEN: &str = "/oauth/token";
pub const REVOKE: &str = "/oauth/revoke";
pub const LIST: &str = "/api/v26/customers:listAccessibleCustomers";
pub const SEARCH: &str = "/api/v26/customers/1234567890/googleAds:search";
pub const MUTATE: &str = "/api/v26/customers/1234567890/googleAds:mutate";

pub const CAMPAIGN: &str = "customers/1234567890/campaigns/111";
pub const AD_GROUP: &str = "customers/1234567890/adGroups/222";
pub const AD: &str = "customers/1234567890/adGroupAds/222~333";

/// The search path of customer `id`.
pub fn search_of(id: &str) -> String {
    format!("/api/v26/customers/{id}/googleAds:search")
}

/// A credential whose access token is good for a day (no token call is needed).
pub fn cred() -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(1)),
        scopes: vec![ADS_SCOPE.into()],
    }
}

/// A credential whose access token ended an hour ago: a call needs a new one first.
pub fn stale_cred() -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at: Some(OffsetDateTime::now_utc() - Duration::hours(1)),
        scopes: vec![ADS_SCOPE.into()],
    }
}

/// The public fields the use cases hand the adapter for the ad account capability.
pub fn public() -> Value {
    json!({"provider":"google","kind_key":"google_ads","external_id":CUSTOMER,"name":"Test"})
}

/// The answer of the customer query for account `id`.
pub fn customer(id: &str, status: &str, manager: bool) -> Value {
    json!({"results":[{"customer":{"resourceName":format!("customers/{id}"),"id":id,
        "descriptiveName":format!("Hesap {id}"),"currencyCode":"TRY",
        "timeZone":"Europe/Istanbul","status":status,"manager":manager,"testAccount":false}}],
        "fieldMask":"customer.id"})
}

/// A Google Ads failure with one error `group.value`.
pub fn failure(group: &str, value: &str, message: &str) -> Value {
    json!({"error":{"code":400,"message":"Request contains an invalid argument.",
        "status":"INVALID_ARGUMENT","details":[{
            "@type":"type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
            "errors":[{"errorCode":{group:value},"message":message}],"requestId":"req-test"}]}})
}

/// One reply: a status, extra headers, a body, and how long the mock waits before answering.
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub delay: Option<std::time::Duration>,
}

impl Reply {
    pub fn with_header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    /// The reply, sent only after `delay` (to make an attempt time out).
    pub fn delayed(mut self, delay: std::time::Duration) -> Reply {
        self.delay = Some(delay);
        self
    }
}

/// `200` with the JSON `body`.
pub fn ok(body: Value) -> Reply {
    status(200, body)
}

/// `status` with the JSON `body`.
pub fn status(status: u16, body: Value) -> Reply {
    Reply {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: body.to_string(),
        delay: None,
    }
}

/// `status` with the body `text` as is (an HTML error page, broken JSON, nothing).
pub fn raw(status: u16, text: &str) -> Reply {
    Reply {
        status,
        headers: vec![("content-type".into(), "text/html".into())],
        body: text.to_owned(),
        delay: None,
    }
}

/// A request the mock received.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The bearer token of the `Authorization` header.
    pub fn bearer(&self) -> Option<&str> {
        self.header("authorization")
            .and_then(|v| v.strip_prefix("Bearer "))
    }

    pub fn body(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or_else(|_| panic!("not JSON: {}", self.body()))
    }

    /// The `query` of a search request.
    pub fn query(&self) -> String {
        self.json()["query"].as_str().unwrap_or_default().to_owned()
    }

    pub fn form(&self) -> Vec<(String, String)> {
        url::form_urlencoded::parse(&self.bytes)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    /// `METHOD /path`.
    pub fn line(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
}

struct Route {
    method: String,
    path: String,
    /// Only requests whose body holds this text; `None`: any.
    needle: Option<String>,
    replies: VecDeque<Reply>,
}

#[derive(Default)]
struct Script {
    routes: Vec<Route>,
    recorded: Vec<Recorded>,
}

/// The mock server.
#[derive(Clone)]
pub struct Mock {
    pub addr: SocketAddr,
    script: Arc<Mutex<Script>>,
}

impl Mock {
    pub async fn start() -> Mock {
        let script = Arc::new(Mutex::new(Script::default()));
        let app = Router::new().fallback(handle).with_state(script.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Mock { addr, script }
    }

    fn queue(&self, method: &str, path: &str, needle: Option<&str>, reply: Reply) {
        let mut script = self.script.lock().unwrap();
        let needle = needle.map(str::to_owned);
        match script
            .routes
            .iter_mut()
            .find(|r| r.method == method && r.path == path && r.needle == needle)
        {
            Some(route) => route.replies.push_back(reply),
            None => script.routes.push(Route {
                method: method.to_owned(),
                path: path.to_owned(),
                needle,
                replies: VecDeque::from([reply]),
            }),
        }
    }

    /// Queues `reply` for `method path` (the last queued reply keeps answering).
    pub fn on(&self, method: &str, path: &str, reply: Reply) {
        self.queue(method, path, None, reply);
    }

    /// Queues `reply` for the searches of the tests' account whose query holds `needle`.
    pub fn on_search(&self, needle: &str, reply: Reply) {
        self.queue("POST", SEARCH, Some(needle), reply);
    }

    /// Queues `reply` for the searches of account `customer` whose query holds `needle`.
    pub fn on_search_of(&self, customer: &str, needle: &str, reply: Reply) {
        self.queue("POST", &search_of(customer), Some(needle), reply);
    }

    /// Every request so far, in order.
    pub fn recorded(&self) -> Vec<Recorded> {
        self.script.lock().unwrap().recorded.clone()
    }

    /// `METHOD /path` of every request so far, in order.
    pub fn lines(&self) -> Vec<String> {
        self.recorded().iter().map(Recorded::line).collect()
    }

    /// The requests to `method path`.
    pub fn requests(&self, method: &str, path: &str) -> Vec<Recorded> {
        self.recorded()
            .into_iter()
            .filter(|r| r.method == method && r.path == path)
            .collect()
    }

    /// The one request to `method path` (panics unless exactly one was made).
    pub fn request(&self, method: &str, path: &str) -> Recorded {
        let mut all = self.requests(method, path);
        assert_eq!(all.len(), 1, "{method} {path}: {:#?}", self.lines());
        all.remove(0)
    }

    /// The searches of the tests' account whose query holds `needle`.
    pub fn searches(&self, needle: &str) -> Vec<Recorded> {
        self.requests("POST", SEARCH)
            .into_iter()
            .filter(|r| r.query().contains(needle))
            .collect()
    }

    pub fn clear(&self) {
        self.script.lock().unwrap().recorded.clear();
    }
}

async fn handle(
    State(script): State<Arc<Mutex<Script>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let recorded = Recorded {
        method: method.to_string(),
        path: uri.path().to_owned(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_owned()))
            .collect(),
        bytes: body.to_vec(),
    };
    let reply = {
        let mut script = script.lock().unwrap();
        let text = recorded.body();
        let (method, path) = (recorded.method.clone(), recorded.path.clone());
        script.recorded.push(recorded);
        // A route for this very text wins over the path's general one.
        let position = script
            .routes
            .iter()
            .position(|r| {
                r.method == method
                    && r.path == path
                    && r.needle.as_ref().is_some_and(|n| text.contains(n))
            })
            .or_else(|| {
                script
                    .routes
                    .iter()
                    .position(|r| r.method == method && r.path == path && r.needle.is_none())
            });
        position.and_then(|i| {
            let queue = &mut script.routes[i].replies;
            if queue.len() > 1 {
                queue.pop_front()
            } else {
                queue.front().cloned()
            }
        })
    };
    let reply = reply.unwrap_or_else(|| {
        status(
            404,
            json!({"error":{"code":404,"message":"no mock route","status":"NOT_FOUND"}}),
        )
    });
    if let Some(delay) = reply.delay {
        tokio::time::sleep(delay).await;
    }
    let mut out_headers = HeaderMap::new();
    for (name, value) in &reply.headers {
        out_headers.insert(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    (
        StatusCode::from_u16(reply.status).unwrap(),
        out_headers,
        reply.body,
    )
        .into_response()
}

/// Platform apps for the tests: the Google app (or none), no other.
#[derive(Clone)]
pub struct TestApps {
    pub google: Option<GoogleApp>,
}

impl Default for TestApps {
    fn default() -> Self {
        TestApps {
            google: Some(GoogleApp {
                client_id: CLIENT_ID.into(),
                client_secret: CLIENT_SECRET.into(),
            }),
        }
    }
}

impl PlatformAppConfig for TestApps {
    fn meta_app(&self) -> Option<MetaApp> {
        None
    }

    fn instagram_app(&self) -> Option<InstagramApp> {
        None
    }

    fn x_app(&self) -> Option<XApp> {
        None
    }

    fn google_app(&self) -> Option<GoogleApp> {
        self.google.clone()
    }

    fn public_base_url(&self) -> Option<Url> {
        Some(Url::parse("https://panel.test").unwrap())
    }
}

/// The mock and an adapter sending to it.
pub struct Rig {
    pub mock: Mock,
    pub google: GoogleConnector,
}

/// An adapter sending to `addr` with the platform apps `apps`, retrying without pausing and
/// giving each attempt `timeout`. The authorize dialog stays the real one: it is only a URL.
pub fn connector_at(
    addr: SocketAddr,
    apps: TestApps,
    timeout: std::time::Duration,
) -> GoogleConnector {
    let base = |prefix: &str| Url::parse(&format!("http://{addr}{prefix}")).unwrap();
    let bases = GoogleBases {
        api: base("/api"),
        oauth: base("/oauth"),
        ..GoogleBases::production()
    };
    let egress = Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("google", addr.to_string())]));
    GoogleConnector::new(egress, bases, Arc::new(apps))
        .with_retry_delay(std::time::Duration::ZERO)
        .with_attempt_timeout(timeout)
}

pub async fn rig() -> Rig {
    rig_with(TestApps::default(), jt_google::ATTEMPT_TIMEOUT).await
}

pub async fn rig_with(apps: TestApps, timeout: std::time::Duration) -> Rig {
    let mock = Mock::start().await;
    let google = connector_at(mock.addr, apps, timeout);
    Rig { mock, google }
}

/// Every secret of the tests: none may appear in any error text or `Debug` output.
pub const SECRETS: &[&str] = &[
    CLIENT_SECRET,
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    MINTED_TOKEN,
    CODE,
    "SECRET",
];

/// Asserts no secret of the tests appears in `text`.
pub fn assert_no_secret(text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "a secret leaked ({secret}): {text}");
    }
}
