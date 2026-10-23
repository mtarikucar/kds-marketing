//! The in-process X mock and the adapter wired to it.
//!
//! The mock listens on 127.0.0.1 (an ephemeral port) and stands for both X hosts at once, by path
//! prefix: `/api` for `api.twitter.com` and `/upload` for `api.x.com`. It answers each
//! `(method, path)` from the replies a test queued for it, in order, the last one repeating;
//! anything unscripted is a 404 problem. It records every request (method, path, query, headers,
//! body bytes). Nothing reaches the internet: the adapter's egress client allows the mock's
//! address only (`test-loopback`).
//!
//! Every fixture holds synthetic values only: ids shaped `1700…`, `1800…`, `1900…`, the account
//! `jeeta_test`, and made-up tokens, codes and client credentials.

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
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jt_app::ports::connectors::{InstagramApp, MetaApp, PlatformAppConfig, XApp};
use jt_connector::Credential;
use jt_outbound::{Egress, FIXED_HOSTS};
use jt_x::{X_SCOPES, XBases, XConnector};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use tokio::net::TcpListener;
use url::Url;

/// The platform's X client of the tests.
pub const CLIENT_ID: &str = "x-client-test";
/// Its secret: no error text, `Debug` output or log line may ever contain it.
pub const CLIENT_SECRET: &str = "x-client-SECRET-test";
/// The access token of the tests' credential.
pub const ACCESS_TOKEN: &str = "x-access-test-0";
/// Its refresh token.
pub const REFRESH_TOKEN: &str = "x-refresh-test-0";
/// An authorization code.
pub const CODE: &str = "x-code-test-0";
/// A PKCE verifier.
pub const VERIFIER: &str = "x-verifier-test-0-abcdefghijklmnopqrstuvwxyz0123456789";
/// The account the credential authenticates as.
pub const USER_ID: &str = "1700000000000000001";
pub const USERNAME: &str = "jeeta_test";
/// The post the fixtures create.
pub const TWEET_ID: &str = "1800000000000000001";

pub const TOKEN: &str = "/api/2/oauth2/token";
pub const ME: &str = "/api/2/users/me";
pub const TWEETS: &str = "/api/2/tweets";
pub const UPLOAD: &str = "/upload/2/media/upload";

/// The path of post `id`.
pub fn tweet(id: &str) -> String {
    format!("{TWEETS}/{id}")
}

/// The credential of the tests: valid for two hours, with a refresh token.
pub fn cred() -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::hours(2)),
        scopes: X_SCOPES.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// The public fields the use cases hand the adapter for the X capability.
pub fn public() -> Value {
    serde_json::json!({
        "provider": "x",
        "kind_key": "x",
        "external_id": USER_ID,
        "username": USERNAME,
    })
}

pub fn x_app() -> XApp {
    XApp {
        client_id: CLIENT_ID.into(),
        client_secret: CLIENT_SECRET.into(),
    }
}

/// The value of `Authorization` for HTTP basic authentication as `user:password`.
pub fn basic(user: &str, password: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{user}:{password}")))
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

/// `status` with the body `text` as is (an HTML error page, broken JSON).
pub fn raw(status: u16, text: &str) -> Reply {
    Reply {
        status,
        headers: vec![("content-type".into(), "text/html".into())],
        body: text.to_owned(),
        delay: None,
    }
}

/// One part of a `multipart/form-data` body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

/// A request the mock received.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
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

    /// The parts of a `multipart/form-data` body, in order (panics when the body is not one).
    pub fn parts(&self) -> Vec<Part> {
        let content_type = self.header("content-type").expect("a content type");
        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap_or_else(|| panic!("not multipart: {content_type}"));
        let delimiter = format!("--{boundary}").into_bytes();
        let mut parts = Vec::new();
        let mut chunks = split(&self.bytes, &delimiter).into_iter();
        let preamble = chunks.next().expect("a preamble");
        assert!(preamble.is_empty(), "text before the first boundary");
        for chunk in chunks {
            if chunk.starts_with(b"--") {
                break; // the closing delimiter
            }
            let chunk = chunk.strip_prefix(b"\r\n").expect("CRLF after a boundary");
            let chunk = chunk.strip_suffix(b"\r\n").expect("CRLF before a boundary");
            let split_at = find(chunk, b"\r\n\r\n").expect("a blank line after the headers");
            let head = String::from_utf8(chunk[..split_at].to_vec()).expect("text headers");
            let data = chunk[split_at + 4..].to_vec();
            let mut part = Part {
                name: String::new(),
                filename: None,
                content_type: None,
                data,
            };
            for line in head.split("\r\n") {
                let (name, value) = line.split_once(':').expect("a header line");
                match name.trim().to_ascii_lowercase().as_str() {
                    "content-disposition" => {
                        for item in value.split(';').map(str::trim) {
                            if let Some(v) = item.strip_prefix("name=") {
                                part.name = v.trim_matches('"').to_owned();
                            } else if let Some(v) = item.strip_prefix("filename=") {
                                part.filename = Some(v.trim_matches('"').to_owned());
                            }
                        }
                    }
                    "content-type" => part.content_type = Some(value.trim().to_owned()),
                    other => panic!("unexpected part header {other}"),
                }
            }
            parts.push(part);
        }
        parts
    }

    /// `METHOD /path`.
    pub fn line(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn split<'a>(bytes: &'a [u8], delimiter: &[u8]) -> Vec<&'a [u8]> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while let Some(at) = find(rest, delimiter) {
        out.push(&rest[..at]);
        rest = &rest[at + delimiter.len()..];
    }
    out.push(rest);
    out
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
        // Uploads run to 5 MB: no body limit.
        let app = Router::new()
            .fallback(handle)
            .layer(DefaultBodyLimit::disable())
            .with_state(script.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Mock { addr, script }
    }

    /// `127.0.0.1:<port>`.
    pub fn host(&self) -> String {
        self.addr.to_string()
    }

    /// `http://127.0.0.1:<port><prefix>`.
    pub fn base(&self, prefix: &str) -> Url {
        Url::parse(&format!("http://{}{prefix}", self.addr)).unwrap()
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
        let lines: Vec<String> = self.recorded().iter().map(Recorded::line).collect();
        assert_eq!(all.len(), 1, "{method} {path}: {lines:#?}");
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
    let query = uri
        .query()
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default();
    let recorded = Recorded {
        method: method.to_string(),
        path: uri.path().to_owned(),
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
            serde_json::json!({
                "title": "Not Found Error",
                "detail": "no mock route",
                "type": "https://api.twitter.com/2/problems/resource-not-found",
                "status": 404,
            }),
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

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/// The JSON of `tests/fixtures/x/<name>.json`.
pub fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/tests/fixtures/x/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The provider answer `tests/fixtures/x/<name>.json`, as a `200` reply.
pub fn answer(name: &str) -> Reply {
    ok(fixture(name))
}

/// The provider answer `tests/fixtures/x/<name>.json` with HTTP status `code`.
pub fn answer_with(code: u16, name: &str) -> Reply {
    status(code, fixture(name))
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/// Platform apps for the tests: the X app (or none), no Meta app.
#[derive(Clone)]
pub struct TestApps {
    pub x: Option<XApp>,
}

impl Default for TestApps {
    fn default() -> Self {
        TestApps { x: Some(x_app()) }
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
        self.x.clone()
    }

    fn public_base_url(&self) -> Option<Url> {
        Some(Url::parse("https://panel.test").unwrap())
    }
}

/// The mock and an adapter sending to it.
pub struct Rig {
    pub mock: Mock,
    pub x: XConnector,
}

/// The bases of an adapter sending to `addr` (the authorize dialog stays the real one: it is only
/// a URL for a browser).
pub fn bases_at(addr: SocketAddr) -> XBases {
    let base = |prefix: &str| Url::parse(&format!("http://{addr}{prefix}")).unwrap();
    XBases {
        api: base("/api"),
        upload: base("/upload"),
        ..XBases::production()
    }
}

/// The egress client of the production fixed tier, with `host` added to the `x` connector's.
pub fn egress(host: String) -> Arc<Egress> {
    Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("x", host)]))
}

/// An adapter sending to `addr` (a mock, a [`Dropper`]) with the platform apps `apps`, retrying
/// without pausing and giving each attempt `timeout`.
pub fn connector_at(addr: SocketAddr, apps: TestApps, timeout: std::time::Duration) -> XConnector {
    XConnector::new(egress(addr.to_string()), bases_at(addr), Arc::new(apps))
        .with_retry_delay(std::time::Duration::ZERO)
        .with_attempt_timeout(timeout)
        .with_upload_timeout(timeout)
}

pub async fn rig() -> Rig {
    rig_with(TestApps::default(), jt_x::ATTEMPT_TIMEOUT).await
}

/// A rig whose attempts time out after `timeout`.
pub async fn rig_with_timeout(timeout: std::time::Duration) -> Rig {
    rig_with(TestApps::default(), timeout).await
}

pub async fn rig_with(apps: TestApps, timeout: std::time::Duration) -> Rig {
    let mock = Mock::start().await;
    let x = connector_at(mock.addr, apps, timeout);
    Rig { mock, x }
}

/// Every secret of the fixtures: none may appear in any error text or `Debug` output.
pub const SECRETS: &[&str] = &[
    CLIENT_SECRET,
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    CODE,
    VERIFIER,
    "x-access-test-1",
    "x-refresh-test-1",
    "x-access-test-2",
    "x-refresh-test-2",
    "SECRET",
];

/// Asserts no secret of the fixtures appears in `text`.
pub fn assert_no_secret(text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "a secret leaked ({secret}): {text}");
    }
}

/// Read the entire request, then close before or during the response.
pub async fn broken_response(after_headers: bool) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
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
                if after_headers {
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
                }
            });
        }
    });
    addr
}
