//! The in-process NetGSM mock and the adapter wired to it.
//!
//! The mock listens on 127.0.0.1 (an ephemeral port) and stands for both NetGSM bases at once, by
//! path prefix: `/api` for `api.netgsm.com.tr` and `/pbx` for Netsantral
//! (`crmsntrl.netgsm.com.tr:9111`). It answers each `(method, path)` from the replies a test
//! queued for it, in order, the last one repeating; anything unscripted is a 404 with a body that
//! is not JSON. It records every request (method, path, query, headers, body). Nothing reaches
//! the internet: the adapter's egress client allows the mock's address only (`test-loopback`).
//!
//! Every fixture holds synthetic values only: numbers shaped `905XXXXXXXXX`, the sender name
//! `TESTHDR`, made-up account codes and passwords.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jt_app::ports::Clock;
use jt_connector::Credential;
use jt_netgsm::{NetgsmBases, NetgsmConnector, RateBudgeter, RetryPolicy};
use jt_outbound::{Egress, FIXED_HOSTS};
use serde_json::Value;
use time::OffsetDateTime;
use time::macros::datetime;
use tokio::net::TcpListener;
use url::Url;

/// The SMS API user of the fixtures.
pub const USERCODE: &str = "8500000001";
/// Its password: no error text, `Debug` output or log line may ever contain it.
pub const PASSWORD: &str = "Gizli-Parola-77";
/// The approved sender name of the fixtures.
pub const MSGHEADER: &str = "TESTHDR";
/// The PBX user of the fixtures.
pub const PBX_USER: &str = "8500000002";
/// Its password.
pub const PBX_PASSWORD: &str = "Santral-Parola-88";
/// The PBX trunk of the fixtures.
pub const TRUNK: &str = "8500000003";
/// The İYS brand code of the fixtures.
pub const BRAND_CODE: &str = "600001";

pub fn sms_cred() -> Credential {
    Credential::NetgsmSms {
        usercode: USERCODE.into(),
        password: PASSWORD.into(),
        msgheader: MSGHEADER.into(),
    }
}

pub fn pbx_cred() -> Credential {
    Credential::NetgsmPbx {
        username: PBX_USER.into(),
        password: PBX_PASSWORD.into(),
        trunk: Some(TRUNK.into()),
        pbxnum: None,
    }
}

pub fn iys_cred() -> Credential {
    Credential::NetgsmIys {
        usercode: USERCODE.into(),
        password: PASSWORD.into(),
        brand_code: BRAND_CODE.into(),
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

/// `status` with the body `text` as is (plain text, broken JSON, a bare code).
pub fn raw(status: u16, text: &str) -> Reply {
    Reply {
        status,
        headers: vec![("content-type".into(), "text/plain".into())],
        body: text.to_owned(),
        delay: None,
    }
}

/// A request the mock received.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: String,
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
        assert!(values.len() <= 1, "{name} repeated in {self:?}");
        values.first().copied()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
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
        Mock::start_on("127.0.0.1:0".parse().unwrap()).await
    }

    /// The mock on `addr`.
    pub async fn start_on(addr: SocketAddr) -> Mock {
        Self::from_listener(TcpListener::bind(addr).await.unwrap())
    }

    /// Starts serving an already-bound listener without releasing its port.
    pub fn from_listener(listener: TcpListener) -> Mock {
        let script = Arc::new(Mutex::new(Script::default()));
        let app = Router::new().fallback(handle).with_state(script.clone());
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
        assert_eq!(all.len(), 1, "{method} {path}: {:#?}", self.recorded());
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
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    let reply = {
        let mut script = script.lock().unwrap();
        script.recorded.push(recorded.clone());
        let key = (recorded.method.clone(), recorded.path.clone());
        match script.routes.get_mut(&key) {
            Some(queue) if queue.len() > 1 => queue.pop_front(),
            Some(queue) => queue.front().cloned(),
            None => None,
        }
    };
    let reply =
        reply.unwrap_or_else(|| raw(404, &format!("no mock route for {}", recorded.line())));
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

/// The text of `tests/fixtures/netgsm/<name>`.
pub fn fixture_text(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/netgsm/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The JSON of `tests/fixtures/netgsm/<name>`.
pub fn fixture(name: &str) -> Value {
    serde_json::from_str(&fixture_text(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// The provider answer `tests/fixtures/netgsm/rest/<name>.json`, as a `200` reply.
pub fn rest(name: &str) -> Reply {
    ok(fixture(&format!("rest/{name}.json")))
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/// A clock a test moves by hand.
#[derive(Clone)]
pub struct ManualClock(Arc<Mutex<OffsetDateTime>>);

/// Where every [`ManualClock`] starts.
pub const START: OffsetDateTime = datetime!(2026-10-23 09:00 UTC);

impl ManualClock {
    pub fn new() -> ManualClock {
        ManualClock(Arc::new(Mutex::new(START)))
    }

    pub fn advance(&self, by: time::Duration) {
        *self.0.lock().unwrap() += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> OffsetDateTime {
        *self.0.lock().unwrap()
    }
}

/// The mock, the adapter sending to it and the clock of its rate budgeter.
pub struct Rig {
    pub mock: Mock,
    pub netgsm: NetgsmConnector,
    pub clock: ManualClock,
}

/// The bases of an adapter sending to `mock`.
pub fn bases(mock: &Mock) -> NetgsmBases {
    NetgsmBases {
        api: mock.base("/api"),
        pbx: mock.base("/pbx"),
    }
}

/// The egress client of the production fixed tier, with `host` added to the `netgsm`
/// connector's.
pub fn egress(host: String) -> Arc<Egress> {
    Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("netgsm", host)]))
}

/// Retries without pausing.
pub fn no_pause() -> RetryPolicy {
    RetryPolicy {
        attempts: 3,
        base_delay: std::time::Duration::ZERO,
    }
}

/// An adapter sending both bases to `addr` (a mock, a [`Dropper`], a closed port), retrying reads
/// as `retry` says and giving each attempt `timeout`.
pub fn connector_at(
    addr: SocketAddr,
    retry: RetryPolicy,
    timeout: std::time::Duration,
) -> NetgsmConnector {
    let base = |prefix: &str| Url::parse(&format!("http://{addr}{prefix}")).unwrap();
    NetgsmConnector::new(
        egress(addr.to_string()),
        NetgsmBases {
            api: base("/api"),
            pbx: base("/pbx"),
        },
    )
    .with_budgeter(RateBudgeter::new(Arc::new(ManualClock::new())))
    .with_retry(retry)
    .with_attempt_timeout(timeout)
}

/// A rig whose budgeter reads a [`ManualClock`] and whose retries do not pause.
pub async fn rig() -> Rig {
    rig_with_timeout(jt_netgsm::ATTEMPT_TIMEOUT).await
}

/// A [`rig`] whose attempts time out after `timeout`.
pub async fn rig_with_timeout(timeout: std::time::Duration) -> Rig {
    let mock = Mock::start().await;
    let clock = ManualClock::new();
    let netgsm = NetgsmConnector::new(egress(mock.host()), bases(&mock))
        .with_budgeter(RateBudgeter::new(Arc::new(clock.clone())))
        .with_retry(no_pause())
        .with_attempt_timeout(timeout);
    Rig {
        mock,
        netgsm,
        clock,
    }
}

/// The public fields the use cases hand an adapter for a capability of `kind`.
pub fn public(kind: &str) -> Value {
    serde_json::json!({ "provider": "netgsm", "kind_key": kind })
}

/// Asserts no form of a password of the fixtures appears in `text`.
pub fn assert_no_password(text: &str) {
    for secret in [PASSWORD, PBX_PASSWORD, "Gizli", "Santral-Parola"] {
        assert!(!text.contains(secret), "a password leaked: {text}");
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
