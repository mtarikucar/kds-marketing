//! The in-process LinkedIn mock and the adapter wired to it.
//!
//! The mock listens on 127.0.0.1 (an ephemeral port) and stands for both LinkedIn hosts at once,
//! by path prefix: `/api` for `api.linkedin.com` and `/www` for `www.linkedin.com` (the token
//! endpoint and the upload URLs the fixtures hand out). It answers each `(method, path)` from the
//! replies a test queued for it, in order, the last one repeating; anything unscripted is a 404 in
//! LinkedIn's error shape. It records every request (method, path, raw and decoded query, headers,
//! body bytes). Nothing reaches the internet: the adapter's egress client allows the mock's
//! address only (`test-loopback`).
//!
//! Every fixture holds synthetic values only: the member `a1B2c3D4e5`, organizations `9000000N`,
//! posts `71000000000000000NN`, and made-up tokens, codes, upload tokens and client credentials.
//! A fixture's `MOCK_WWW` stands for the mock's `/www` base, so its upload URLs lead back to it.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use jt_app::ports::connectors::{InstagramApp, LinkedinApp, MetaApp, PlatformAppConfig, XApp};
use jt_connector::Credential;
use jt_linkedin::{LinkedinBases, LinkedinConnector, MEMBER_SCOPES, ORGANIZATION_SCOPES};
use jt_outbound::{Egress, FIXED_HOSTS};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use tokio::net::TcpListener;
use url::Url;

/// The platform's LinkedIn client of the tests.
pub const CLIENT_ID: &str = "li-client-test";
/// Its secret: no error text, `Debug` output or log line may ever contain it.
pub const CLIENT_SECRET: &str = "li-client-SECRET-test";
/// The access token of the tests' credentials.
pub const ACCESS_TOKEN: &str = "li-access-test-0";
/// The refresh token of the tests' page credential.
pub const REFRESH_TOKEN: &str = "li-refresh-test-0";
/// An authorization code.
pub const CODE: &str = "li-code-test-0";
/// The member the credential signs in as (OpenID `sub`).
pub const SUB: &str = "a1B2c3D4e5";
/// The organizations the member administers.
pub const ORG: &str = "90000001";
pub const ORG_2: &str = "90000002";
/// The posts the fixtures create and read.
pub const SHARE: &str = "urn:li:share:7100000000000000001";
pub const UGC_POST: &str = "urn:li:ugcPost:7100000000000000002";
/// The media the fixtures register.
pub const IMAGE_1: &str = "urn:li:image:C4E10AQtestimage1";
pub const IMAGE_2: &str = "urn:li:image:C4E10AQtestimage2";
pub const VIDEO: &str = "urn:li:video:C5505AQtestvideo1";
/// The size of the fixtures' video (its upload instructions cover exactly this).
pub const VIDEO_BYTES: usize = 100_000;

pub const TOKEN: &str = "/www/oauth/v2/accessToken";
pub const USERINFO: &str = "/api/v2/userinfo";
pub const ACLS: &str = "/api/rest/organizationAcls";
pub const ORGANIZATIONS: &str = "/api/rest/organizations";
pub const ORGANIZATION: &str = "/api/rest/organizations/90000001";
pub const IMAGES: &str = "/api/rest/images";
pub const VIDEOS: &str = "/api/rest/videos";
pub const POSTS: &str = "/api/rest/posts";
pub const STATS: &str = "/api/rest/organizationalEntityShareStatistics";
pub const NETWORK_SIZE: &str = "/api/rest/networkSizes/urn%3Ali%3Aorganization%3A90000001";
pub const IMAGE_UPLOAD_1: &str = "/www/dms-uploads/C4E10AQtestimage1/uploaded-image/0";
pub const IMAGE_UPLOAD_2: &str = "/www/dms-uploads/C4E10AQtestimage2/uploaded-image/0";
pub const VIDEO_PART_0: &str = "/www/dms-uploads/C5505AQtestvideo1/uploadedVideo/0";
pub const VIDEO_PART_1: &str = "/www/dms-uploads/C5505AQtestvideo1/uploadedVideo/1";

/// The scopes of a member flow.
pub fn member_scopes() -> Vec<String> {
    MEMBER_SCOPES.iter().map(|s| (*s).to_owned()).collect()
}

/// The scopes of a page flow.
pub fn page_scopes() -> Vec<String> {
    MEMBER_SCOPES
        .iter()
        .chain(ORGANIZATION_SCOPES)
        .map(|s| (*s).to_owned())
        .collect()
}

/// A credential of the member flow: 60 days, no refresh token (no programmatic refresh).
pub fn member_cred() -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(60)),
        scopes: member_scopes(),
    }
}

/// A credential of the page flow, with a refresh token.
pub fn page_cred() -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(60)),
        scopes: page_scopes(),
    }
}

/// The public fields the use cases hand the adapter for the member capability.
pub fn member_public() -> Value {
    serde_json::json!({
        "provider": "linkedin",
        "kind_key": "linkedin_member",
        "external_id": SUB,
        "name": "Jeeta Test",
    })
}

/// The public fields the use cases hand the adapter for the page capability.
pub fn page_public() -> Value {
    serde_json::json!({
        "provider": "linkedin",
        "kind_key": "linkedin_page",
        "external_id": ORG,
        "name": "Jeeta Test Kahve",
    })
}

/// The platform's LinkedIn app: the organization scopes as `organization_scopes` says, the
/// default API version.
pub fn linkedin_app(organization_scopes: bool) -> LinkedinApp {
    LinkedinApp {
        client_id: CLIENT_ID.into(),
        client_secret: CLIENT_SECRET.into(),
        organization_scopes,
        api_version: None,
    }
}

/// One reply: a status, extra headers, a body, and how long the mock waits before answering
/// (the request is recorded first).
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

/// `201 Created` of a post: no body, its URN in `x-restli-id`.
pub fn created(urn: &str) -> Reply {
    raw(201, "").with_header("x-restli-id", urn)
}

/// A request the mock received.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    /// The query string exactly as sent.
    pub raw_query: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
}

impl Recorded {
    /// The query parameter `name`, when present exactly once (panics when repeated).
    pub fn param(&self, name: &str) -> Option<&str> {
        let values: Vec<&str> = self
            .query
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect();
        assert!(values.len() <= 1, "{name} repeated in {}", self.line());
        values.first().copied()
    }

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

    pub fn form(&self) -> Vec<(String, String)> {
        url::form_urlencoded::parse(&self.bytes)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    /// Asserts the request carries the REST API headers, with `version`.
    pub fn assert_rest_headers(&self, version: &str) {
        assert_eq!(
            self.header("linkedin-version"),
            Some(version),
            "{}",
            self.line()
        );
        assert_eq!(
            self.header("x-restli-protocol-version"),
            Some("2.0.0"),
            "{}",
            self.line()
        );
    }

    /// `METHOD /path`.
    pub fn line(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
}

#[derive(Default)]
struct Script {
    routes: HashMap<(String, String), VecDeque<Reply>>,
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
        // Video parts run to megabytes: no body limit.
        let app = Router::new()
            .fallback(handle)
            .layer(DefaultBodyLimit::disable())
            .with_state(script.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Mock { addr, script }
    }

    /// `http://127.0.0.1:<port><prefix>`.
    pub fn base(&self, prefix: &str) -> Url {
        Url::parse(&format!("http://{}{prefix}", self.addr)).unwrap()
    }

    /// The JSON of `tests/fixtures/linkedin/<name>.json`, its `MOCK_WWW` pointing at this mock.
    pub fn fixture(&self, name: &str) -> Value {
        let path = format!(
            "{}/tests/fixtures/linkedin/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let text = text.replace("MOCK_WWW", &format!("http://{}/www", self.addr));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    /// The fixture `name` as a `200` reply.
    pub fn answer(&self, name: &str) -> Reply {
        ok(self.fixture(name))
    }

    /// The fixture `name` with HTTP status `code`.
    pub fn answer_with(&self, code: u16, name: &str) -> Reply {
        status(code, self.fixture(name))
    }

    /// Queues `reply` for `method path` (the last queued reply keeps answering).
    pub fn on(&self, method: &str, path: &str, reply: Reply) {
        self.script
            .lock()
            .unwrap()
            .routes
            .entry((method.to_owned(), path.to_owned()))
            .or_default()
            .push_back(reply);
    }

    /// Makes `reply` the only answer of `method path` from now on.
    pub fn set(&self, method: &str, path: &str, reply: Reply) {
        self.script.lock().unwrap().routes.insert(
            (method.to_owned(), path.to_owned()),
            VecDeque::from([reply]),
        );
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
    let raw_query = uri.query().unwrap_or_default().to_owned();
    let query = url::form_urlencoded::parse(raw_query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let recorded = Recorded {
        method: method.to_string(),
        path: uri.path().to_owned(),
        raw_query,
        query,
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_owned()))
            .collect(),
        bytes: body.to_vec(),
    };
    let reply = {
        let mut script = script.lock().unwrap();
        let key = (recorded.method.clone(), recorded.path.clone());
        script.recorded.push(recorded);
        match script.routes.get_mut(&key) {
            Some(queue) if queue.len() > 1 => queue.pop_front(),
            Some(queue) => queue.front().cloned(),
            None => None,
        }
    };
    let reply = reply.unwrap_or_else(|| {
        status(
            404,
            serde_json::json!({ "status": 404, "code": "NOT_FOUND", "message": "no mock route" }),
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

/// A server on 127.0.0.1 that accepts every connection and closes it at once, before any answer:
/// a call to it gets no response at all. Counts the connections it accepted.
pub struct Dropper {
    pub addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
}

impl Dropper {
    pub async fn start() -> Dropper {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        Dropper { addr, accepted }
    }

    pub fn accepted(&self) -> usize {
        self.accepted.load(Ordering::SeqCst)
    }
}

/// Reads the entire request, then answers `200` with a body that breaks off (a JSON `{` of a
/// promised 100 bytes) and closes.
pub async fn broken_response() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut request = Vec::new();
                loop {
                    socket.readable().await.unwrap();
                    let mut buf = [0; 4096];
                    match socket.try_read(&mut buf) {
                        Ok(0) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                        Err(e) => panic!("{e}"),
                    }
                    if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let mut response =
                    &b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{"[..];
                while !response.is_empty() {
                    socket.writable().await.unwrap();
                    match socket.try_write(response) {
                        Ok(n) => response = &response[n..],
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                        Err(e) => panic!("{e}"),
                    }
                }
            });
        }
    });
    addr
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/// Platform apps for the tests: the LinkedIn app (or none), no other.
#[derive(Clone)]
pub struct TestApps {
    pub linkedin: Option<LinkedinApp>,
}

impl Default for TestApps {
    fn default() -> Self {
        TestApps {
            linkedin: Some(linkedin_app(false)),
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

    fn linkedin_app(&self) -> Option<LinkedinApp> {
        self.linkedin.clone()
    }

    fn public_base_url(&self) -> Option<Url> {
        Some(Url::parse("https://panel.test").unwrap())
    }
}

/// The mock and an adapter sending to it.
pub struct Rig {
    pub mock: Mock,
    pub li: LinkedinConnector,
}

/// The bases of an adapter sending to `addr` (the authorize dialog stays the real one: it is only
/// a URL for a browser).
pub fn bases_at(addr: SocketAddr) -> LinkedinBases {
    let base = |prefix: &str| Url::parse(&format!("http://{addr}{prefix}")).unwrap();
    LinkedinBases {
        api: base("/api"),
        oauth: base("/www"),
        ..LinkedinBases::production()
    }
}

/// The egress client of the production fixed tier, with `host` added to the `linkedin`
/// connector's.
pub fn egress(host: String) -> Arc<Egress> {
    Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("linkedin", host)]))
}

/// An adapter sending to `addr` (a mock, a [`Dropper`]) with the platform apps `apps`, retrying
/// without pausing and giving each attempt `timeout`.
pub fn connector_at(
    addr: SocketAddr,
    apps: TestApps,
    timeout: std::time::Duration,
) -> LinkedinConnector {
    LinkedinConnector::new(egress(addr.to_string()), bases_at(addr), Arc::new(apps))
        .with_retry_delay(std::time::Duration::ZERO)
        .with_attempt_timeout(timeout)
        .with_upload_timeout(timeout)
}

pub async fn rig() -> Rig {
    rig_with(TestApps::default(), jt_linkedin::ATTEMPT_TIMEOUT).await
}

pub async fn rig_with(apps: TestApps, timeout: std::time::Duration) -> Rig {
    let mock = Mock::start().await;
    let li = connector_at(mock.addr, apps, timeout);
    Rig { mock, li }
}

/// Every secret of the fixtures: none may appear in any error text or `Debug` output.
pub const SECRETS: &[&str] = &[
    CLIENT_SECRET,
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    CODE,
    "li-access-test-1",
    "li-refresh-test-1",
    "li-access-test-2",
    "li-refresh-test-2",
    "upload-SECRET",
    "SECRET",
];

/// Asserts no secret of the fixtures appears in `text`.
pub fn assert_no_secret(text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "a secret leaked ({secret}): {text}");
    }
}
