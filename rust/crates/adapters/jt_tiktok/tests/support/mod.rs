//! The in-process TikTok mock and the adapter wired to it.
//!
//! The mock listens on 127.0.0.1 (an ephemeral port) and stands for both TikTok hosts at once, by
//! path prefix: `/api` for `open.tiktokapis.com` and `/upload` for the upload URL a video's init
//! hands out (`open-upload.tiktokapis.com`; the mock hands out its own address). It answers each
//! `(method, path)` from the replies a test queued for it, in order, the last one repeating;
//! anything unscripted is a 404 with a TikTok error object. It records every request (method,
//! path, query, headers, body bytes). Nothing reaches the internet: the adapter's egress client
//! allows the mock's address only (`test-loopback`).
//!
//! Every fixture holds synthetic values only: open ids shaped `0f0e…-test`, publish ids
//! `v_pub_file~v2-1.7300…`, video ids `7300…`, the account `jeeta_test`, and made-up tokens, codes
//! and client credentials.

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
use jt_app::ports::connectors::{
    InstagramApp, MediaUpload, MetaApp, PlatformAppConfig, TiktokApp, TiktokPost, XApp,
};
use jt_connector::Credential;
use jt_outbound::{Egress, FIXED_HOSTS};
use jt_tiktok::{TIKTOK_SCOPES, TiktokBases, TiktokConnector};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use tokio::net::TcpListener;
use url::Url;

/// The platform's TikTok client of the tests.
pub const CLIENT_KEY: &str = "tt-client-key-test";
/// Its secret: no error text, `Debug` output or log line may ever contain it.
pub const CLIENT_SECRET: &str = "tt-client-SECRET-test";
/// The access token of the tests' credential.
pub const ACCESS_TOKEN: &str = "act.tt-access-SECRET-0";
/// Its refresh token.
pub const REFRESH_TOKEN: &str = "rft.tt-refresh-SECRET-0";
/// An authorization code.
pub const CODE: &str = "tt-code-SECRET-0";
/// What authorizes the upload URL the mock hands out.
pub const UPLOAD_TOKEN: &str = "tt-upload-SECRET-0";
/// The account the credential authenticates as.
pub const OPEN_ID: &str = "0f0e0d0c-0000-4000-8000-000000000001-test";
pub const USERNAME: &str = "jeeta_test";
pub const DISPLAY_NAME: &str = "Jeeta Test";
/// The publish id the inits answer with, and the video it becomes.
pub const PUBLISH_ID: &str = "v_pub_file~v2-1.7300000000000000009";
pub const PHOTO_PUBLISH_ID: &str = "p_pub_url~v2-1.7300000000000000008";
pub const VIDEO_ID: &str = "7300000000000000001";

pub const TOKEN: &str = "/api/v2/oauth/token/";
pub const USER_INFO: &str = "/api/v2/user/info/";
pub const CREATOR_INFO: &str = "/api/v2/post/publish/creator_info/query/";
pub const VIDEO_INIT: &str = "/api/v2/post/publish/video/init/";
pub const CONTENT_INIT: &str = "/api/v2/post/publish/content/init/";
pub const STATUS: &str = "/api/v2/post/publish/status/fetch/";
pub const VIDEO_QUERY: &str = "/api/v2/video/query/";
pub const UPLOAD: &str = "/upload/video/";

/// The credential of the tests: valid for 20 hours (not yet due for renewal), with a refresh
/// token.
pub fn cred() -> Credential {
    cred_expiring_in(Duration::hours(20))
}

/// The credential of the tests, expiring `in_` from now.
pub fn cred_expiring_in(in_: Duration) -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at: Some(OffsetDateTime::now_utc() + in_),
        scopes: TIKTOK_SCOPES.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// The public fields the use cases hand the adapter for the TikTok capability.
pub fn public() -> Value {
    json!({
        "provider": "tiktok",
        "kind_key": "tiktok",
        "external_id": OPEN_ID,
        "username": USERNAME,
    })
}

pub fn tiktok_app() -> TiktokApp {
    TiktokApp {
        client_key: CLIENT_KEY.into(),
        client_secret: CLIENT_SECRET.into(),
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

/// `status` with the body `text` as is (an HTML error page, broken JSON, an empty body).
pub fn raw(status: u16, text: &str) -> Reply {
    Reply {
        status,
        headers: vec![("content-type".into(), "text/html".into())],
        body: text.to_owned(),
        delay: None,
    }
}

/// A TikTok API error answer: `status` with `error {code, message, log_id}`.
pub fn api_error(status_code: u16, code: &str, message: &str) -> Reply {
    status(
        status_code,
        json!({ "error": { "code": code, "message": message, "log_id": "20261027000000TEST" } }),
    )
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
        let values = self.headers_named(name);
        assert!(values.len() <= 1, "{name} repeated in {}", self.line());
        values.first().copied()
    }

    /// Every value of header `name`.
    pub fn headers_named(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
            .collect()
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
        // Video chunks run to tens of megabytes: no body limit.
        let app = Router::new()
            .fallback(handle)
            .layer(DefaultBodyLimit::disable())
            .with_state(script.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Mock { addr, script }
    }

    /// The upload URL this mock hands out in a video's init: its own `/upload` path, carrying
    /// [`UPLOAD_TOKEN`] as TikTok's does its authority.
    pub fn upload_url(&self) -> String {
        format!(
            "http://{}{UPLOAD}?upload_id=7300000000000000077&upload_token={UPLOAD_TOKEN}",
            self.addr
        )
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
    let reply = reply.unwrap_or_else(|| api_error(404, "not_found", "no mock route"));
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

/// The JSON of `tests/fixtures/tiktok/<name>.json`.
pub fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/tests/fixtures/tiktok/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The provider answer `tests/fixtures/tiktok/<name>.json`, as a `200` reply.
pub fn answer(name: &str) -> Reply {
    ok(fixture(name))
}

/// The provider answer `tests/fixtures/tiktok/<name>.json` with HTTP status `code`.
pub fn answer_with(code: u16, name: &str) -> Reply {
    status(code, fixture(name))
}

/// The video init answer, its upload URL the mock's own.
pub fn video_init(mock: &Mock) -> Reply {
    let mut body = fixture("video_init");
    body["data"]["upload_url"] = json!(mock.upload_url());
    ok(body)
}

/// The answers of a chunk before the last, and of the last.
pub fn partial() -> Reply {
    raw(206, "")
}

pub fn complete() -> Reply {
    raw(201, "")
}

/// What a human chose on the posting screen, as the tests post by default: `privacy`, comments
/// and stitches allowed (the creator of `creator_info_public` turned duets off), no commercial
/// content.
pub fn choice(privacy: &str) -> TiktokPost {
    TiktokPost {
        title: "Merhaba".into(),
        privacy_level: privacy.into(),
        allow_comment: true,
        allow_duet: false,
        allow_stitch: true,
        disclose_commercial: false,
        your_brand: false,
        branded_content: false,
    }
}

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// An MP4 video of `seconds`, as its boxes say (a file type and a movie header, timescale 1000),
/// padded with media data to `len` bytes at least.
pub fn mp4(seconds: u32, len: usize) -> MediaUpload {
    let mut mvhd = vec![0; 12];
    mvhd.extend_from_slice(&1000u32.to_be_bytes());
    mvhd.extend_from_slice(&(seconds * 1000).to_be_bytes());
    mvhd.extend_from_slice(&[0; 80]);
    let head = [
        mp4_box(b"ftyp", b"isom\0\0\x02\0isomiso2mp41"),
        mp4_box(b"moov", &mp4_box(b"mvhd", &mvhd)),
    ]
    .concat();
    let data = len.saturating_sub(head.len() + 8);
    MediaUpload {
        bytes: [head, mp4_box(b"mdat", &vec![7; data])].concat(),
        mime: "video/mp4".into(),
        filename: "clip.mp4".into(),
    }
}

/// Scripts a whole video post that the creator's settings allow publicly: `creator_info`, the
/// init and every chunk.
pub fn script_video(mock: &Mock) {
    mock.on("POST", CREATOR_INFO, answer("creator_info_public"));
    mock.on("POST", VIDEO_INIT, video_init(mock));
    mock.on("PUT", UPLOAD, complete());
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/// Platform apps for the tests: the TikTok app (or none), no other.
#[derive(Clone)]
pub struct TestApps {
    pub tiktok: Option<TiktokApp>,
}

impl Default for TestApps {
    fn default() -> Self {
        TestApps {
            tiktok: Some(tiktok_app()),
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

    fn tiktok_app(&self) -> Option<TiktokApp> {
        self.tiktok.clone()
    }

    fn public_base_url(&self) -> Option<Url> {
        Some(Url::parse("https://panel.test").unwrap())
    }
}

/// The mock and an adapter sending to it.
pub struct Rig {
    pub mock: Mock,
    pub tt: TiktokConnector,
}

/// The bases of an adapter sending to `addr` (the authorize dialog stays the real one: it is only
/// a URL for a browser).
pub fn bases_at(addr: SocketAddr) -> TiktokBases {
    TiktokBases {
        api: Url::parse(&format!("http://{addr}/api")).unwrap(),
        ..TiktokBases::production()
    }
}

/// The egress client of the production fixed tier, with `host` added to the `tiktok` connector's.
pub fn egress(host: String) -> Arc<Egress> {
    Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("tiktok", host)]))
}

/// An adapter sending to `addr` (a mock, a [`Dropper`]) with the platform apps `apps`, retrying
/// without pausing and giving each attempt `timeout`.
pub fn connector_at(
    addr: SocketAddr,
    apps: TestApps,
    timeout: std::time::Duration,
) -> TiktokConnector {
    TiktokConnector::new(egress(addr.to_string()), bases_at(addr), Arc::new(apps))
        .with_retry_delay(std::time::Duration::ZERO)
        .with_attempt_timeout(timeout)
        .with_upload_timeout(timeout)
}

pub async fn rig() -> Rig {
    rig_with(TestApps::default(), jt_tiktok::ATTEMPT_TIMEOUT).await
}

/// A rig whose attempts time out after `timeout`.
pub async fn rig_with_timeout(timeout: std::time::Duration) -> Rig {
    rig_with(TestApps::default(), timeout).await
}

pub async fn rig_with(apps: TestApps, timeout: std::time::Duration) -> Rig {
    let mock = Mock::start().await;
    let tt = connector_at(mock.addr, apps, timeout);
    Rig { mock, tt }
}

/// Every secret of the fixtures: none may appear in any error text or `Debug` output.
pub const SECRETS: &[&str] = &[
    CLIENT_SECRET,
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    CODE,
    UPLOAD_TOKEN,
    "act.tt-access-SECRET-1",
    "rft.tt-refresh-SECRET-1",
    "act.tt-access-SECRET-2",
    "rft.tt-refresh-SECRET-2",
    "SECRET",
];

/// Asserts no secret of the fixtures appears in `text`.
pub fn assert_no_secret(text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "a secret leaked ({secret}): {text}");
    }
}
