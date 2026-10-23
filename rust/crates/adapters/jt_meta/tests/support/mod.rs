//! The in-process Graph mock and the adapter wired to it.
//!
//! The mock listens on 127.0.0.1 (an ephemeral port) and stands for every Meta host at once, by
//! path prefix: `/fb` for `graph.facebook.com`, `/ig` for `graph.instagram.com`, `/igapi` for
//! `api.instagram.com`. It answers each `(method, path)` from the replies a test queued for it,
//! in order, the last one repeating; anything unscripted is a 404 Graph error. It records every
//! request (method, path, query, headers, body). Nothing reaches the internet: the adapter's
//! egress client allows the mock's address only (`test-loopback`).

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, KeyInit, Mac};
use jt_app::ports::connectors::{InstagramApp, MetaApp, PlatformAppConfig, XApp};
use jt_meta::{ContainerPoll, MetaBases, MetaConnector};
use jt_outbound::{Egress, FIXED_HOSTS};
use serde_json::Value;
use sha2::Sha256;
use tokio::net::TcpListener;
use url::Url;

pub const META_APP_ID: &str = "meta-app-test";
pub const META_APP_SECRET: &str = "meta-app-secret-test";
pub const INSTAGRAM_APP_ID: &str = "ig-app-test";
pub const INSTAGRAM_APP_SECRET: &str = "ig-app-secret-test";

/// One reply: a status, extra headers and a body.
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn with_header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.to_owned(), value.to_owned()));
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
    }
}

/// `status` with a body that is not JSON.
pub fn raw(status: u16, body: &str) -> Reply {
    Reply {
        status,
        headers: vec![("content-type".into(), "text/html".into())],
        body: body.to_owned(),
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

    /// The bearer token of the `Authorization` header.
    pub fn bearer(&self) -> Option<&str> {
        self.header("authorization")
            .and_then(|v| v.strip_prefix("Bearer "))
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }

    pub fn form(&self) -> Vec<(String, String)> {
        url::form_urlencoded::parse(self.body.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
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
    /// Requests that broke the proof invariant (see [`Mock::violations`]).
    violations: Vec<String>,
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

    /// The requests so far that broke the invariant every test holds: a request to the Graph
    /// API (`/fb/`) carrying a bearer token carries `appsecret_proof` = HMAC of that very token
    /// under the app secret, and no `access_token` in its query; a request to the Instagram
    /// Graph API (`/ig/`) carries no proof. [`Rig`] asserts there are none when it is dropped.
    pub fn violations(&self) -> Vec<String> {
        self.script.lock().unwrap().violations.clone()
    }
}

/// Why `r` breaks the proof invariant, if it does (see [`Mock::violations`]).
fn violation(r: &Recorded) -> Option<String> {
    let proofs: Vec<&str> = r
        .query
        .iter()
        .filter(|(k, _)| k == "appsecret_proof")
        .map(|(_, v)| v.as_str())
        .collect();
    if r.path.starts_with("/fb/") {
        let token = r.bearer()?;
        if proofs != [proof(token).as_str()] {
            return Some(format!(
                "{}: proof {proofs:?} does not sign its token",
                r.line()
            ));
        }
        if r.query.iter().any(|(k, _)| k == "access_token") {
            return Some(format!("{}: access_token in the query", r.line()));
        }
    } else if r.path.starts_with("/ig/") && !proofs.is_empty() {
        return Some(format!(
            "{}: appsecret_proof on graph.instagram.com",
            r.line()
        ));
    }
    None
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
        if let Some(broken) = violation(&recorded) {
            script.violations.push(broken);
        }
        script.recorded.push(recorded.clone());
        let key = (recorded.method.clone(), recorded.path.clone());
        match script.routes.get_mut(&key) {
            Some(queue) if queue.len() > 1 => queue.pop_front(),
            Some(queue) => queue.front().cloned(),
            None => None,
        }
    };
    let reply = reply.unwrap_or_else(|| {
        status(
            404,
            serde_json::json!({ "error": {
                "message": format!("no mock route for {}", recorded.line()),
                "type": "MockMissing",
                "code": 100,
            }}),
        )
    });
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

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/// The text of `tests/fixtures/meta/<name>`.
pub fn fixture_text(name: &str) -> String {
    let path = format!("{}/tests/fixtures/meta/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The Graph answer `tests/fixtures/meta/graph/<name>.json`, `{{GRAPH}}` standing for the mock's
/// `graph.facebook.com` base.
pub fn graph_fixture(mock: &Mock, name: &str) -> Value {
    let text = fixture_text(&format!("graph/{name}.json"))
        .replace("{{GRAPH}}", mock.base("/fb").as_str().trim_end_matches('/'));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("graph/{name}.json: {e}"))
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/// Platform apps for the tests.
#[derive(Clone)]
pub struct TestApps {
    pub meta: Option<MetaApp>,
    pub instagram: Option<InstagramApp>,
}

pub fn meta_app() -> MetaApp {
    MetaApp {
        app_id: META_APP_ID.into(),
        app_secret: META_APP_SECRET.into(),
        verify_token: "verify-test".into(),
        login_config_id: None,
        whatsapp_config_id: None,
        graph_version: None,
    }
}

pub fn instagram_app() -> InstagramApp {
    InstagramApp {
        app_id: INSTAGRAM_APP_ID.into(),
        app_secret: INSTAGRAM_APP_SECRET.into(),
    }
}

impl Default for TestApps {
    fn default() -> Self {
        TestApps {
            meta: Some(meta_app()),
            instagram: Some(instagram_app()),
        }
    }
}

impl PlatformAppConfig for TestApps {
    fn meta_app(&self) -> Option<MetaApp> {
        self.meta.clone()
    }

    fn instagram_app(&self) -> Option<InstagramApp> {
        self.instagram.clone()
    }

    fn x_app(&self) -> Option<XApp> {
        None
    }

    fn public_base_url(&self) -> Url {
        Url::parse("https://panel.test").unwrap()
    }
}

/// The mock and an adapter sending to it. Dropping it asserts that no request broke the proof
/// invariant ([`Mock::violations`]), so every test checks it.
pub struct Rig {
    pub mock: Mock,
    pub meta: MetaConnector,
}

impl Drop for Rig {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let broken = self.mock.violations();
            assert!(broken.is_empty(), "proof invariant broken: {broken:#?}");
        }
    }
}

/// The bases of an adapter sending to `mock`.
pub fn bases(mock: &Mock) -> MetaBases {
    MetaBases {
        graph: mock.base("/fb"),
        instagram_graph: mock.base("/ig"),
        instagram_api: mock.base("/igapi"),
        ..MetaBases::production()
    }
}

/// The egress client of the production fixed tier, with the mock's address added to the `meta`
/// connector's.
pub fn egress(mock: &Mock) -> Arc<Egress> {
    Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("meta", mock.host())]))
}

pub async fn rig() -> Rig {
    rig_with(TestApps::default()).await
}

/// A rig whose platform apps are `apps`; its container poll does not pause (30 reads).
pub async fn rig_with(apps: TestApps) -> Rig {
    let mock = Mock::start().await;
    let meta = MetaConnector::new(egress(&mock), bases(&mock), Arc::new(apps)).with_container_poll(
        ContainerPoll {
            interval: std::time::Duration::ZERO,
            attempts: 30,
        },
    );
    Rig { mock, meta }
}

/// The expected `appsecret_proof` of `token` (computed here, independently of the adapter).
pub fn proof(token: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(META_APP_SECRET.as_bytes()).unwrap();
    mac.update(token.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Asserts `r` is an authenticated Graph call with `token`: in the header, never in the query,
/// with its proof.
pub fn assert_graph_auth(r: &Recorded, token: &str) {
    assert_eq!(r.bearer(), Some(token), "{}", r.line());
    assert_eq!(r.param("access_token"), None, "{}", r.line());
    assert_eq!(
        r.param("appsecret_proof"),
        Some(proof(token).as_str()),
        "{}",
        r.line()
    );
}
