//! The bridge's loop against a fake Jeeta: an axum server on 127.0.0.1 that records what the
//! bridge sends, refuses what the server (plan D1-T5) refuses, and answers from a script; with
//! fake phones behind the driver traits. Intervals are milliseconds (`Timing`), so no test waits
//! for real seconds.
//!
//! Each test captures the log of its own thread, so a test can say what was and was not logged.

mod support;

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use jeeta_device_bridge::{
    AttachedPhone, Config, ContentType, DriverError, FileTransfer, PhoneDriver, PhoneRegistry,
    Timing, run,
};
use jt_device_protocol::{
    CommandResult, DeviceCommand, FailReason, MAX_PHONES, MAX_RESULTS_BODY_BYTES, PHONE_RETIRED,
    PhoneReport, Platform, RegisterIn, ResultsIn,
};
use serde_json::{Value, json};
use support::Logs;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// The bridge key. No log line may carry it.
const KEY: &str = "jdb_K3Y-never-in-a-log-7f3a9c";
/// What the fake answers for an upload.
const FILE_ID: Uuid = Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0f11);
/// A screenshot, as a fake phone takes it.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";
/// The file a signed address serves.
const DOWNLOAD: &[u8] = b"the file the agent pushes";
/// The file a fake phone hands over for `pull_file`.
const PULLED: &[u8] = b"a file pulled from the phone";

fn id(n: u128) -> Uuid {
    Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0000 + n)
}

fn capability(serial: &str) -> Uuid {
    Uuid::from_u128(
        0x0190_0000_0000_7000_9000_0000_0000_0000 + serial.bytes().map(u128::from).sum::<u128>(),
    )
}

// ---------------------------------------------------------------------------------------------
// The fake Jeeta

/// One answer to a poll.
struct Poll {
    delay: Duration,
    status: u16,
    body: String,
}

fn poll(commands: Vec<Value>) -> Poll {
    answer(200, json!({ "commands": commands }).to_string())
}

fn answer(status: u16, body: impl Into<String>) -> Poll {
    Poll {
        delay: Duration::ZERO,
        status,
        body: body.into(),
    }
}

/// What the fake answers.
#[derive(Default)]
struct Script {
    /// The `heartbeat_s` register answers (15 when 0).
    heartbeat_s: u32,
    /// Phones the register refuses: serial and reason.
    refuse: Vec<(&'static str, &'static str)>,
    /// Refusals for phones the bridge did not list.
    refuse_unsent: Vec<(&'static str, &'static str)>,
    /// A field the register answer carries beyond what protocol 1 defines.
    register_extra: Option<&'static str>,
    /// The answers to the polls, in order; then idle polls.
    polls: VecDeque<Poll>,
    /// The statuses of the result posts, in order; then 200.
    result_statuses: VecDeque<u16>,
    /// While set, every result post is answered 503.
    results_unavailable: bool,
    /// A command whose result makes a batch refused with `refuse_status` (422 when `None`).
    refuse_batches_with: Option<Uuid>,
    refuse_status: Option<u16>,
    /// The most bytes of a results body (`MAX_RESULTS_BODY_BYTES` when `None`); more is a 413.
    results_body_limit: Option<usize>,
    /// The body of every error answer but a 422.
    error_body: String,
    /// The `max_wait_s` register answers (25 when `None`).
    max_wait_s: Option<u32>,
    /// How long an idle poll is held (30 ms when `None`).
    idle_hold: Option<Duration>,
}

/// What the fake was sent.
#[derive(Default)]
struct Seen {
    /// Register bodies.
    registers: Vec<(Instant, Value)>,
    /// When each poll arrived.
    polls: Vec<Instant>,
    /// The query of each poll.
    poll_queries: Vec<String>,
    /// Result posts and the status each was answered with.
    posts: Vec<(Instant, Value, u16)>,
    /// Uploads: content type and bytes.
    uploads: Vec<(Option<String>, Vec<u8>)>,
    /// Signed downloads: the authorization header each carried.
    downloads: Vec<Option<String>>,
    /// Route calls without the right key.
    unauthorized: usize,
    /// Posts without `X-Requested-With: jeeta-panel`.
    without_requested_with: usize,
}

#[derive(Default)]
struct Fake {
    script: Mutex<Script>,
    seen: Mutex<Seen>,
}

type Shared = Arc<Fake>;

impl Fake {
    /// Whether a route call carries the key; counts the ones that do not.
    fn authorized(&self, headers: &HeaderMap) -> bool {
        let ok = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == format!("Bearer {KEY}"));
        if !ok {
            self.seen.lock().unwrap().unauthorized += 1;
        }
        ok
    }

    fn error_body(&self) -> String {
        self.script.lock().unwrap().error_body.clone()
    }

    /// How the API refuses a route call: a mutating one without the request header first (403,
    /// before the key is read, as `jt_panel_http::csrf` does), then one without the key (401).
    fn refusal(&self, headers: &HeaderMap, mutating: bool) -> Option<Response> {
        let requested_with = headers
            .get("x-requested-with")
            .is_some_and(|v| v.as_bytes() == b"jeeta-panel");
        if mutating && !requested_with {
            self.seen.lock().unwrap().without_requested_with += 1;
            let body =
                json!({ "code": "FORBIDDEN", "message": "missing request header", "details": {} });
            return Some((StatusCode::FORBIDDEN, axum::Json(body)).into_response());
        }
        if !self.authorized(headers) {
            return Some((StatusCode::UNAUTHORIZED, self.error_body()).into_response());
        }
        None
    }
}

/// A 422 as the server gives one: the field is `ProtocolError::field()`.
fn refused_body(field: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        axum::Json(json!({
            "code": "VALIDATION",
            "message": format!("{field}: is refused"),
            "details": { "field": field },
        })),
    )
        .into_response()
}

async fn register(State(fake): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(refused) = fake.refusal(&headers, true) {
        return refused;
    }
    let body: Value = serde_json::from_slice(&body).unwrap();
    fake.seen
        .lock()
        .unwrap()
        .registers
        .push((Instant::now(), body.clone()));
    // Refused as the server refuses a body that breaks a limit...
    let read: RegisterIn = serde_json::from_value(body.clone()).unwrap();
    if let Err(error) = read.validate() {
        return refused_body(error.field());
    }
    let script = fake.script.lock().unwrap();
    let (mut phones, mut refused) = (Vec::new(), Vec::new());
    for phone in &read.phones {
        let serial = phone.serial.as_str();
        // ... and a phone whose own report breaks one, which it lists as refused.
        let reason = match phone.validate() {
            Err(error) => Some(error.to_string()),
            Ok(()) => script
                .refuse
                .iter()
                .find(|(s, _)| *s == serial)
                .map(|(_, reason)| (*reason).to_owned()),
        };
        match reason {
            Some(reason) => refused
                .push(json!({ "platform": phone.platform, "serial": serial, "reason": reason })),
            None => phones.push(json!({ "serial": serial, "capability_id": capability(serial) })),
        }
    }
    for (serial, reason) in &script.refuse_unsent {
        refused.push(json!({ "platform": "android", "serial": serial, "reason": reason }));
    }
    let heartbeat_s = if script.heartbeat_s == 0 {
        15
    } else {
        script.heartbeat_s
    };
    let mut answer = json!({
        "phones": phones, "refused": refused,
        "heartbeat_s": heartbeat_s, "max_wait_s": script.max_wait_s.unwrap_or(25), "protocol": 1,
    });
    if let Some(extra) = script.register_extra {
        answer[extra] = json!("VALUE-OF-AN-EXTRA-FIELD");
    }
    axum::Json(answer).into_response()
}

async fn commands(
    State(fake): State<Shared>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Some(refused) = fake.refusal(&headers, false) {
        return refused;
    }
    {
        let mut seen = fake.seen.lock().unwrap();
        seen.polls.push(Instant::now());
        seen.poll_queries.push(query.unwrap_or_default());
    }
    let (next, hold) = {
        let mut script = fake.script.lock().unwrap();
        let hold = script.idle_hold.unwrap_or(Duration::from_millis(30));
        (script.polls.pop_front(), hold)
    };
    match next {
        Some(poll) => {
            tokio::time::sleep(poll.delay).await;
            (StatusCode::from_u16(poll.status).unwrap(), poll.body).into_response()
        }
        None => {
            // An idle long poll: held a little, then empty.
            tokio::time::sleep(hold).await;
            (StatusCode::OK, r#"{"commands":[]}"#).into_response()
        }
    }
}

async fn results(State(fake): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(refused) = fake.refusal(&headers, true) {
        return refused;
    }
    let limit = fake
        .script
        .lock()
        .unwrap()
        .results_body_limit
        .unwrap_or(MAX_RESULTS_BODY_BYTES);
    let value: Value = serde_json::from_slice(&body).unwrap();
    let record = |status: u16| {
        fake.seen
            .lock()
            .unwrap()
            .posts
            .push((Instant::now(), value.clone(), status));
    };
    // The route's body limit (D1-T5: `DefaultBodyLimit` of `MAX_RESULTS_BODY_BYTES`).
    if body.len() > limit {
        record(413);
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let read: ResultsIn = serde_json::from_value(value.clone()).unwrap();
    if let Err(error) = read.validate() {
        record(422);
        return refused_body(error.field());
    }
    let ids = posted_ids(&value);
    let (status, error_body) = {
        let mut script = fake.script.lock().unwrap();
        let refused = script
            .refuse_batches_with
            .is_some_and(|id| ids.contains(&id.to_string()));
        let status = if refused {
            script.refuse_status.unwrap_or(422)
        } else if script.results_unavailable {
            503
        } else {
            script.result_statuses.pop_front().unwrap_or(200)
        };
        (status, script.error_body.clone())
    };
    record(status);
    match status {
        200 => axum::Json(json!({ "applied": ids.len(), "duplicates": 0, "unknown": 0 }))
            .into_response(),
        422 => (
            StatusCode::UNPROCESSABLE_ENTITY,
            axum::Json(json!({
                "code": "VALIDATION",
                "message": format!("detail: is longer than 300 characters ({error_body})"),
                "details": { "field": "detail" },
            })),
        )
            .into_response(),
        other => (StatusCode::from_u16(other).unwrap(), error_body).into_response(),
    }
}

async fn files(State(fake): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(refused) = fake.refusal(&headers, true) {
        return refused;
    }
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    // The two types the route takes (D1-T5).
    if !matches!(
        content_type.as_deref(),
        Some("image/png" | "application/octet-stream")
    ) {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    fake.seen
        .lock()
        .unwrap()
        .uploads
        .push((content_type, body.to_vec()));
    axum::Json(json!({ "file_id": FILE_ID })).into_response()
}

async fn signed(State(fake): State<Shared>, headers: HeaderMap) -> Response {
    let authorization = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    fake.seen.lock().unwrap().downloads.push(authorization);
    (StatusCode::OK, DOWNLOAD).into_response()
}

/// Starts a fake Jeeta; answers its base URL.
async fn serve(script: Script) -> (String, Shared) {
    let fake = Arc::new(Fake {
        script: Mutex::new(script),
        seen: Mutex::default(),
    });
    let app = Router::new()
        .route("/api/devices/bridge/register", post(register))
        .route("/api/devices/bridge/commands", get(commands))
        // The results limit is checked in the handler, so a refused post is recorded too.
        .route(
            "/api/devices/bridge/results",
            post(results).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/devices/bridge/files", post(files))
        .route("/signed/file", get(signed))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), fake)
}

/// The command ids of a results body, in order.
fn posted_ids(body: &Value) -> Vec<String> {
    body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["command_id"].as_str().unwrap().to_owned())
        .collect()
}

/// The posts, as the ids each carried and the status it was answered with.
fn posts(seen: &Seen) -> Vec<(Vec<String>, u16)> {
    seen.posts
        .iter()
        .map(|(_, body, status)| (posted_ids(body), *status))
        .collect()
}

/// The ids of commands `ns`, as a results body carries them.
fn ids(ns: &[u128]) -> Vec<String> {
    ns.iter().map(|n| id(*n).to_string()).collect()
}

/// The results the fake accepted, in order.
fn accepted(seen: &Seen) -> Vec<Value> {
    seen.posts
        .iter()
        .filter(|(_, _, status)| *status == 200)
        .flat_map(|(_, body, _)| body["results"].as_array().unwrap().clone())
        .collect()
}

/// The accepted results of command `n`.
fn accepted_for(seen: &Seen, n: u128) -> Vec<Value> {
    accepted(seen)
        .into_iter()
        .filter(|r| r["command_id"] == id(n).to_string())
        .collect()
}

/// The serials of the phones in a register body.
fn registered_serials(body: &Value) -> Vec<String> {
    body["phones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["serial"].as_str().unwrap().to_owned())
        .collect()
}

/// A leased command for the phone `serial`, as a poll carries it.
fn leased(n: u128, serial: &str, command: Value) -> Value {
    json!({
        "id": id(n), "capability_id": capability(serial), "serial": serial,
        "command": command, "expires_at": "2026-10-28T12:30:45Z",
    })
}

fn tap(x: u32) -> Value {
    json!({ "kind": "tap", "x": x, "y": 10 })
}

/// A command the fake phones never finish.
fn hang() -> Value {
    json!({ "kind": "long_press", "x": 1, "y": 1, "ms": 100 })
}

fn push_file(n: u128, serial: &str, url: String) -> Value {
    let mut push = leased(
        n,
        serial,
        json!({ "kind": "push_file", "file_id": id(900), "dest": "/sdcard/x.bin" }),
    );
    push["download_url"] = json!(url);
    push
}

// ---------------------------------------------------------------------------------------------
// Fake phones

/// How a fake registry's listing, or a fake phone's report, goes on one call.
#[derive(Clone, Copy, Debug)]
enum Mode {
    Ok,
    Fail,
    Hang,
    Panic,
}

/// The mode of call `n`: as scripted, then `Ok`.
fn mode(modes: &[Mode], n: usize) -> Mode {
    modes.get(n).copied().unwrap_or(Mode::Ok)
}

/// A command a fake phone finished.
#[derive(Clone, Debug)]
struct Run {
    serial: String,
    what: String,
    started: Instant,
    ended: Instant,
}

/// What the fake phones did.
#[derive(Default)]
struct PhoneLog {
    /// Commands that finished, in the order they did.
    runs: Vec<Run>,
    /// Commands whose future was dropped before they finished: serial, command, when.
    cuts: Vec<(String, String, Instant)>,
    /// Calls of `recover`: serial and when.
    recovers: Vec<(String, Instant)>,
    /// Commands that started: serial, command, when.
    started: Vec<(String, String, Instant)>,
}

type Log = Arc<Mutex<PhoneLog>>;

/// A command running on a fake phone: a cut when dropped before it is done.
struct Running {
    log: Log,
    serial: String,
    what: String,
    done: bool,
}

impl Drop for Running {
    fn drop(&mut self) {
        if !self.done {
            let cut = (self.serial.clone(), self.what.clone(), Instant::now());
            if let Ok(mut log) = self.log.lock() {
                log.cuts.push(cut);
            }
        }
    }
}

struct FakePhone {
    serial: String,
    delay: Duration,
    log: Log,
    reports: Vec<Mode>,
    reported: AtomicUsize,
}

/// What a fake phone calls a command in its log.
fn describe(cmd: &DeviceCommand) -> String {
    match cmd {
        DeviceCommand::Tap { x, .. } => format!("tap {x}"),
        other => other.kind().to_owned(),
    }
}

#[async_trait]
impl PhoneDriver for FakePhone {
    fn platform(&self) -> Platform {
        Platform::Android
    }

    async fn report(&self) -> Result<PhoneReport, DriverError> {
        let n = self.reported.fetch_add(1, Ordering::SeqCst);
        match mode(&self.reports, n) {
            Mode::Ok => {}
            Mode::Fail => return Err(DriverError::new(FailReason::AdbError, "adb is busy")),
            Mode::Hang => std::future::pending::<()>().await,
            Mode::Panic => panic!("fake report bug"),
        }
        Ok(PhoneReport {
            // The loop sets both from the registry and `platform()`.
            platform: Platform::Ios,
            serial: "WHATEVER".into(),
            model: Some("Fake 1".into()),
            os_version: Some("14".into()),
            screen: None,
            features: DeviceCommand::KINDS.iter().map(|k| k.to_string()).collect(),
        })
    }

    async fn execute(
        &self,
        cmd: &DeviceCommand,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError> {
        let started = Instant::now();
        let what = describe(cmd);
        self.log
            .lock()
            .unwrap()
            .started
            .push((self.serial.clone(), what.clone(), started));
        let mut running = Running {
            log: self.log.clone(),
            serial: self.serial.clone(),
            what: what.clone(),
            done: false,
        };
        tokio::time::sleep(self.delay).await;
        let result = match cmd {
            DeviceCommand::Tap { .. } => Ok(CommandResult::Done {}),
            // A driver with a bug.
            DeviceCommand::Key { .. } => panic!("fake driver bug: PANIC-DETAIL-77"),
            // A command that never ends.
            DeviceCommand::LongPress { .. } => std::future::pending().await,
            DeviceCommand::Screenshot {} => files
                .upload(PNG.to_vec(), ContentType::Png)
                .await
                .map(|file_id| CommandResult::File { file_id }),
            DeviceCommand::PushFile { .. } => {
                let dest = std::env::temp_dir().join(format!("jdb-loop-{}", Uuid::now_v7()));
                let result = pushed(files, &dest).await;
                let _ = std::fs::remove_file(&dest);
                result
            }
            DeviceCommand::PullFile { .. } => {
                let path = std::env::temp_dir().join(format!("jdb-loop-{}", Uuid::now_v7()));
                std::fs::write(&path, PULLED).unwrap();
                let result = files
                    .upload_file(&path, ContentType::OctetStream)
                    .await
                    .map(|file_id| CommandResult::File { file_id });
                let _ = std::fs::remove_file(&path);
                result
            }
            _ => Err(DriverError::new(
                FailReason::UnsupportedOnPlatform,
                "not in this fake",
            )),
        };
        running.done = true;
        self.log.lock().unwrap().runs.push(Run {
            serial: self.serial.clone(),
            what,
            started,
            ended: Instant::now(),
        });
        result
    }

    async fn recover(&self) {
        self.log
            .lock()
            .unwrap()
            .recovers
            .push((self.serial.clone(), Instant::now()));
    }
}

/// A `push_file` the fake way: download, then check what arrived.
async fn pushed(files: &dyn FileTransfer, dest: &Path) -> Result<CommandResult, DriverError> {
    let written = files.download(dest).await?;
    let bytes = std::fs::read(dest).unwrap();
    if written != DOWNLOAD.len() as u64 || bytes != DOWNLOAD {
        return Err(DriverError::new(FailReason::BridgeError, "wrong file"));
    }
    Ok(CommandResult::Done {})
}

/// Fixed attached phones, listed as `modes` say.
struct Phones {
    list: Vec<AttachedPhone>,
    modes: Vec<Mode>,
    calls: AtomicUsize,
}

impl Phones {
    fn new(list: Vec<AttachedPhone>) -> Phones {
        Phones {
            list,
            modes: Vec::new(),
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl PhoneRegistry for Phones {
    async fn attached(&self) -> Result<Vec<AttachedPhone>, DriverError> {
        match mode(&self.modes, self.calls.fetch_add(1, Ordering::SeqCst)) {
            Mode::Ok => Ok(self.list.clone()),
            Mode::Fail => Err(DriverError::new(FailReason::AdbError, "adb is busy")),
            Mode::Hang => std::future::pending().await,
            Mode::Panic => panic!("fake registry bug"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The rig

/// Short intervals: a server second is 20 ms; failures pause 40, 80, then 160 ms.
fn quick() -> Timing {
    Timing {
        server_second: Duration::from_millis(20),
        poll_wait_s: 1,
        idle_poll_floor: Duration::from_millis(25),
        backoff_min: Duration::from_millis(40),
        backoff_max: Duration::from_millis(160),
        command_timeout: Duration::from_secs(5),
        transfer_timeout: Duration::from_secs(5),
        report_timeout: Duration::from_secs(2),
        shutdown_grace: Duration::from_millis(500),
        ..Timing::default()
    }
}

/// A bridge for `base` with `registry`'s phones; answers its stop switch and its task.
fn bridge(base: &str, registry: Arc<dyn PhoneRegistry>) -> (oneshot::Sender<()>, JoinHandle<()>) {
    bridge_with(base, registry, "", quick())
}

/// [`bridge`] with more lines of configuration and its own timing.
fn bridge_with(
    base: &str,
    registry: Arc<dyn PhoneRegistry>,
    more: &str,
    timing: Timing,
) -> (oneshot::Sender<()>, JoinHandle<()>) {
    let config = Config::parse(
        &format!("base_url = \"{base}\"\nkey = \"{KEY}\"\nbridge_id = \"test-pc\"\n{more}"),
        |_| None,
    )
    .unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let stopped = async {
            let _ = stopped.await;
        };
        run(&config, registry, timing, stopped).await.unwrap();
    });
    (stop, task)
}

/// How a rig is set up: its phones, each `(serial, milliseconds per command)`, and the rest.
struct Setup<'a> {
    phones: &'a [(&'a str, u64)],
    more: &'a str,
    timing: Timing,
    listing: Vec<Mode>,
    reports: Vec<Mode>,
}

impl<'a> Setup<'a> {
    fn new(phones: &'a [(&'a str, u64)]) -> Setup<'a> {
        Setup {
            phones,
            more: "",
            timing: quick(),
            listing: Vec::new(),
            reports: Vec::new(),
        }
    }

    async fn start(self, script: Script) -> Rig {
        let (base, fake) = serve(script).await;
        self.attach(&base, fake)
    }

    /// A bridge for a fake Jeeta already serving at `base`.
    fn attach(self, base: &str, fake: Shared) -> Rig {
        let log = Log::default();
        let list = self
            .phones
            .iter()
            .map(|(serial, ms)| AttachedPhone {
                serial: (*serial).to_owned(),
                driver: Arc::new(FakePhone {
                    serial: (*serial).to_owned(),
                    delay: Duration::from_millis(*ms),
                    log: log.clone(),
                    reports: self.reports.clone(),
                    reported: AtomicUsize::new(0),
                }),
            })
            .collect();
        let registry = Phones {
            modes: self.listing,
            ..Phones::new(list)
        };
        let started = Instant::now();
        let (stop, task) = bridge_with(base, Arc::new(registry), self.more, self.timing);
        Rig {
            fake,
            log,
            started,
            stop,
            task,
        }
    }
}

/// A fake Jeeta and a bridge with fake phones.
struct Rig {
    fake: Shared,
    log: Log,
    started: Instant,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl Rig {
    async fn start(script: Script, phones: &[(&str, u64)]) -> Rig {
        Setup::new(phones).start(script).await
    }

    fn seen(&self) -> MutexGuard<'_, Seen> {
        self.fake.seen.lock().unwrap()
    }

    fn phones(&self) -> MutexGuard<'_, PhoneLog> {
        self.log.lock().unwrap()
    }

    /// What the phones finished, in the order they did.
    fn runs(&self) -> Vec<Run> {
        self.phones().runs.clone()
    }

    /// What the phones finished, by name.
    fn ran(&self) -> Vec<String> {
        self.runs().into_iter().map(|r| r.what).collect()
    }

    /// Waits (5 s at most) until `done` holds for what the fake was sent.
    async fn until(&self, what: &str, done: impl Fn(&Seen) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if done(&self.seen()) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Waits (5 s at most) until `done` holds for what the phones did.
    async fn until_phones(&self, what: &str, done: impl Fn(&PhoneLog) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if done(&self.phones()) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn stop(self) {
        let _ = self.stop.send(());
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .expect("the bridge stops")
            .expect("the bridge's task ends cleanly");
    }
}

fn gaps(at: &[Instant]) -> Vec<Duration> {
    at.windows(2).map(|w| w[1] - w[0]).collect()
}

/// The bridge's own lines of a log, without their timestamps (digits there, and in the ports
/// of the HTTP client's traces, may spell anything).
fn bridge_lines(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|l| l.contains("jeeta_device_bridge"))
        .map(|l| l.split_once(' ').map_or(l, |(_, rest)| rest))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Registering

#[tokio::test]
async fn registers_on_start_and_every_heartbeat() {
    let _logs = Logs::capture();
    // The server asks for a register every 5 of its seconds: 100 ms here. The protocol's own 15
    // would be 300 ms.
    let heartbeat = Duration::from_millis(100);
    let script = Script {
        heartbeat_s: 5,
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("three registers", |s| s.registers.len() >= 3)
        .await;
    {
        let seen = rig.seen();
        let at: Vec<Instant> = seen.registers.iter().map(|(at, _)| *at).collect();
        // On start, not after a first heartbeat.
        assert!(at[0] - rig.started < heartbeat, "{:?}", at[0] - rig.started);
        // Then every heartbeat the server asked for: not much sooner, and nowhere near the
        // protocol's own.
        for gap in gaps(&at) {
            assert!(
                gap >= heartbeat * 95 / 100 && gap < heartbeat * 5 / 2,
                "{gap:?}"
            );
        }
        let body = &seen.registers[0].1;
        assert_eq!(body["bridge_id"], "test-pc");
        assert_eq!(body["protocol"], 1);
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        // The serial is the registry's and the platform the driver's, whatever the report says.
        assert_eq!(body["phones"][0]["serial"], "R58N1");
        assert_eq!(body["phones"][0]["platform"], "android");
        assert_eq!(body["phones"][0]["model"], "Fake 1");
        assert_eq!(seen.unauthorized, 0);
    }
    rig.stop().await;
}

#[tokio::test]
async fn retired_phone_is_not_listed_again() {
    let logs = Logs::capture();
    let script = Script {
        heartbeat_s: 3,
        refuse: vec![
            ("RETIRED1", PHONE_RETIRED),
            ("BADMODEL1", "model: must not contain a NUL character"),
            (
                "TAB\tSERIAL",
                "screen: has a side outside 1 to 20000 pixels",
            ),
        ],
        // A refusal for a phone this bridge never listed is not its to act on.
        refuse_unsent: vec![("STRANGER9", PHONE_RETIRED)],
        ..Script::default()
    };
    let rig = Rig::start(
        script,
        &[
            ("R58N1", 0),
            ("RETIRED1", 0),
            ("BADMODEL1", 0),
            ("TAB\tSERIAL", 0),
        ],
    )
    .await;
    rig.until("three registers", |s| s.registers.len() >= 3)
        .await;
    {
        let seen = rig.seen();
        assert_eq!(
            registered_serials(&seen.registers[0].1),
            ["R58N1", "RETIRED1", "BADMODEL1", "TAB\tSERIAL"]
        );
        // The retired phone is not listed again; a phone refused for another reason still is.
        for (_, body) in &seen.registers[1..] {
            assert_eq!(
                registered_serials(body),
                ["R58N1", "BADMODEL1", "TAB\tSERIAL"]
            );
        }
    }
    // Each refusal is logged with the serial and the reason, at warn level, once.
    let text = logs.text();
    for (serial, reason) in [
        ("RETIRED1", PHONE_RETIRED),
        ("BADMODEL1", "must not contain a NUL character"),
        // Logged clean: a control character in a serial is a space in the log.
        ("TAB SERIAL", "has a side outside"),
    ] {
        let lines: Vec<&str> = text.lines().filter(|l| l.contains(serial)).collect();
        assert_eq!(lines.len(), 1, "{serial}: {text}");
        assert!(
            lines[0].contains("WARN") && lines[0].contains(reason),
            "{}",
            lines[0]
        );
    }
    assert!(!text.contains("STRANGER9"), "{text}");
    rig.stop().await;
}

#[tokio::test]
async fn only_the_configured_serials_are_listed() {
    let _logs = Logs::capture();
    let phones = [("PHONE_A", 0), ("PHONE_B", 0), ("PHONE_C", 0)];
    let mut setup = Setup::new(&phones);
    setup.more = "serials = [\"PHONE_C\", \"PHONE_A\", \"PHONE_X\"]\n";
    let rig = setup.start(Script::default()).await;
    rig.until("a register", |s| !s.registers.is_empty()).await;
    // In the order they are attached; a configured serial that is not attached is not listed.
    assert_eq!(
        registered_serials(&rig.seen().registers[0].1),
        ["PHONE_A", "PHONE_C"]
    );
    rig.stop().await;
}

#[tokio::test]
async fn each_serial_is_listed_once_and_at_most_max_phones() {
    let logs = Logs::capture();
    let mut phones: Vec<(String, u64)> = (0..20).map(|n| (format!("P{n:02}"), 0)).collect();
    // The registry lists the first phone twice.
    phones.push(("P00".into(), 0));
    let phones: Vec<(&str, u64)> = phones.iter().map(|(s, ms)| (s.as_str(), *ms)).collect();
    let rig = Rig::start(Script::default(), &phones).await;
    // The fake refuses a register that breaks a limit (a serial twice, more than 16 phones) with
    // a 422, as the server does: this one is taken, and its phones registered.
    rig.until("a register taken", |s| {
        !s.registers.is_empty() && !s.polls.is_empty()
    })
    .await;
    let listed = registered_serials(&rig.seen().registers[0].1);
    let expected: Vec<String> = (0..MAX_PHONES).map(|n| format!("P{n:02}")).collect();
    assert_eq!(listed, expected);
    let text = logs.text();
    let cut = text
        .lines()
        .find(|l| l.contains("more phones than one register carries"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(
        cut.contains("WARN") && cut.contains("attached=20") && cut.contains("listed=16"),
        "{cut}"
    );
    rig.stop().await;
}

#[tokio::test]
async fn a_failed_listing_keeps_the_last_phones() {
    let logs = Logs::capture();
    let script = Script {
        heartbeat_s: 3,
        // A command for the phone while its listings fail.
        polls: [Poll {
            delay: Duration::from_millis(150),
            ..poll(vec![leased(1, "R58N1", tap(1))])
        }]
        .into(),
        ..Script::default()
    };
    let phones = [("R58N1", 0)];
    let mut setup = Setup::new(&phones);
    // The first listing works; then one fails, one hangs past the bound, one panics.
    setup.listing = vec![Mode::Ok, Mode::Fail, Mode::Hang, Mode::Panic];
    setup.timing.report_timeout = Duration::from_millis(100);
    let rig = setup.start(script).await;
    rig.until("five registers and the result", |s| {
        s.registers.len() >= 5 && !accepted(s).is_empty()
    })
    .await;
    {
        let seen = rig.seen();
        for (_, body) in &seen.registers[..5] {
            assert_eq!(registered_serials(body), ["R58N1"]);
        }
        // The phone stayed registered: its command ran, not failed as offline.
        assert_eq!(
            accepted_for(&seen, 1)[0]["outcome"],
            json!({ "status": "done", "result": { "kind": "done" } })
        );
    }
    let text = logs.text();
    let stood_in = text
        .lines()
        .filter(|l| l.contains("the last list stands in"))
        .count();
    assert_eq!(stood_in, 3, "{text}");
    rig.stop().await;
}

#[tokio::test]
async fn a_failed_report_reuses_the_last_one_for_a_few_heartbeats() {
    let _logs = Logs::capture();
    let script = Script {
        heartbeat_s: 3,
        ..Script::default()
    };
    let phones = [("R58N1", 0), ("STEADY", 0)];
    let mut setup = Setup::new(&phones);
    // Each phone reads well once, then fails, hangs, panics, and fails again.
    setup.reports = vec![Mode::Ok, Mode::Fail, Mode::Hang, Mode::Panic, Mode::Fail];
    setup.timing.report_timeout = Duration::from_millis(100);
    let rig = setup.start(script).await;
    rig.until("six registers", |s| s.registers.len() >= 6).await;
    {
        let seen = rig.seen();
        let listed: Vec<Vec<String>> = seen.registers[..6]
            .iter()
            .map(|(_, body)| registered_serials(body))
            .collect();
        let both = vec!["R58N1".to_owned(), "STEADY".to_owned()];
        // The last good report stands in for three failed reads (STALE_REPORT_HEARTBEATS)...
        assert_eq!(
            listed[..4],
            [both.clone(), both.clone(), both.clone(), both.clone()]
        );
        // ... as it was read.
        assert_eq!(seen.registers[3].1["phones"][0]["model"], "Fake 1");
        // ... and no more: then the phone is left out until it reads well again.
        assert_eq!(listed[4], Vec::<String>::new());
        assert_eq!(listed[5], both);
    }
    rig.stop().await;
}

#[tokio::test]
async fn a_register_answer_with_an_unknown_field_is_logged_by_field_and_retried() {
    let logs = Logs::capture();
    // A server that sends a protocol-1 bridge a field protocol 1 does not define, against the
    // contract: the answer is refused, the register tried again after a growing pause.
    let script = Script {
        register_extra: Some("shiny_new_field"),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("three registers", |s| s.registers.len() >= 3)
        .await;
    {
        let seen = rig.seen();
        let at: Vec<Instant> = seen.registers.iter().map(|(at, _)| *at).collect();
        let gaps = gaps(&at);
        assert!(gaps[0] >= Duration::from_millis(40), "{gaps:?}");
        assert!(gaps[1] >= Duration::from_millis(80), "{gaps:?}");
        // Not registered: no poll.
        assert!(seen.polls.is_empty());
    }
    let text = logs.text();
    let failed = text
        .lines()
        .find(|l| l.contains("registering with Jeeta failed"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(failed.contains("shiny_new_field"), "{failed}");
    assert!(!text.contains("VALUE-OF-AN-EXTRA-FIELD"), "{text}");
    rig.stop().await;
}

// ---------------------------------------------------------------------------------------------
// Polling and running

#[tokio::test]
async fn runs_leased_command_and_posts_result() {
    let logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![leased(1, "R58N1", tap(540))])].into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("the result", |s| !accepted(s).is_empty()).await;
    {
        let seen = rig.seen();
        let results = accepted(&seen);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["command_id"], id(1).to_string());
        assert_eq!(
            results[0]["outcome"],
            json!({ "status": "done", "result": { "kind": "done" } })
        );
        assert!(results[0]["duration_ms"].is_u64());
        assert_eq!(seen.unauthorized, 0);
    }
    let runs = rig.runs();
    assert_eq!(runs.len(), 1);
    assert_eq!(
        (runs[0].serial.as_str(), runs[0].what.as_str()),
        ("R58N1", "tap 540")
    );
    // The log has the command's id, kind and status, and not its arguments.
    let text = logs.text();
    let finished = text
        .lines()
        .find(|l| l.contains("command finished"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(finished.contains(&id(1).to_string()), "{finished}");
    assert!(
        finished.contains("tap") && finished.contains("done"),
        "{finished}"
    );
    let ours = bridge_lines(&text);
    assert!(
        !ours.is_empty() && ours.iter().all(|l| !l.contains("540")),
        "{ours:#?}"
    );
    rig.stop().await;
}

#[tokio::test]
async fn same_command_id_runs_once() {
    let _logs = Logs::capture();
    let script = Script {
        polls: [
            poll(vec![leased(1, "R58N1", tap(1))]),
            // Handed out again while it runs, with a new one.
            poll(vec![leased(1, "R58N1", tap(1)), leased(2, "R58N1", tap(2))]),
            // And again once it is done.
            Poll {
                delay: Duration::from_millis(150),
                ..poll(vec![leased(1, "R58N1", tap(1))])
            },
        ]
        .into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 50)]).await;
    rig.until("both results and the poll after the last redelivery", |s| {
        accepted_for(s, 2).len() == 1 && s.polls.len() >= 4
    })
    .await;
    assert_eq!(rig.ran(), ["tap 1", "tap 2"]);
    {
        let seen = rig.seen();
        assert_eq!(accepted_for(&seen, 1).len(), 1);
        let posted_1 = seen
            .posts
            .iter()
            .flat_map(|(_, body, _)| posted_ids(body))
            .filter(|i| *i == id(1).to_string())
            .count();
        assert_eq!(posted_1, 1);
    }
    rig.stop().await;
}

#[tokio::test]
async fn commands_for_one_phone_run_in_order() {
    let _logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![
            leased(1, "PHONE_A", tap(1)),
            leased(2, "PHONE_A", tap(2)),
            leased(3, "PHONE_A", tap(3)),
            leased(4, "PHONE_B", tap(4)),
        ])]
        .into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("PHONE_A", 80), ("PHONE_B", 80)]).await;
    rig.until("four results", |s| accepted(s).len() == 4).await;
    let runs = rig.runs();
    let a: Vec<&Run> = runs.iter().filter(|r| r.serial == "PHONE_A").collect();
    let b: Vec<&Run> = runs.iter().filter(|r| r.serial == "PHONE_B").collect();
    // One phone: in the order they came, each after the one before it ended.
    let what: Vec<&str> = a.iter().map(|r| r.what.as_str()).collect();
    assert_eq!(what, ["tap 1", "tap 2", "tap 3"]);
    for pair in a.windows(2) {
        assert!(pair[1].started >= pair[0].ended, "{pair:?}");
    }
    // Another phone: at the same time.
    assert_eq!(b.len(), 1);
    assert!(b[0].started < a[0].ended, "{b:?} {a:?}");
    rig.stop().await;
}

#[tokio::test]
async fn unreadable_command_is_failed_by_id_and_dropped_is_logged() {
    let logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![
            leased(1, "R58N1", tap(1)),
            // A kind this build does not know, with a readable id.
            leased(2, "R58N1", json!({ "kind": "teleport", "to": "Ankara" })),
            // No id to fail it by.
            json!({ "serial": "R58N1", "command": tap(3) }),
        ])]
        .into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("both results", |s| {
        accepted_for(s, 1).len() == 1 && accepted_for(s, 2).len() == 1
    })
    .await;
    {
        let seen = rig.seen();
        let failed = &accepted_for(&seen, 2)[0]["outcome"];
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["reason"], "unsupported_by_bridge");
        // The message is the failure's detail...
        let detail = failed["detail"].as_str().unwrap();
        assert!(detail.contains("teleport"), "{detail}");
    }
    // ... and only the readable command ran.
    assert_eq!(rig.ran(), ["tap 1"]);
    // The log names the unreadable command by id and counts the dropped one, and never quotes
    // either.
    let text = logs.text();
    assert!(text.contains(&id(2).to_string()), "{text}");
    let dropped = text
        .lines()
        .find(|l| l.contains("dropped=1"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(dropped.contains("WARN"), "{dropped}");
    assert!(
        !text.contains("teleport") && !text.contains("Ankara"),
        "{text}"
    );
    rig.stop().await;
}

#[tokio::test]
async fn malformed_poll_body_backs_off_and_polls_again() {
    let logs = Logs::capture();
    let script = Script {
        polls: [
            // JSON, but not a poll.
            answer(200, r#"{"nope":1}"#),
            // Not JSON at all.
            answer(200, "<html>not a poll</html>"),
            // An error page.
            answer(502, "bad gateway"),
            poll(vec![leased(1, "R58N1", tap(1))]),
        ]
        .into(),
        ..Script::default()
    };
    let phones = [("R58N1", 0)];
    let mut setup = Setup::new(&phones);
    // An idle poll would wait this long: far longer than the pause after a good poll may be.
    let floor = Duration::from_millis(400);
    setup.timing.idle_poll_floor = floor;
    let rig = setup.start(script).await;
    rig.until("the result and the poll after it", |s| {
        accepted_for(s, 1).len() == 1 && s.polls.len() >= 5
    })
    .await;
    {
        let seen = rig.seen();
        let gaps = gaps(&seen.polls);
        // Each failed poll is followed by a pause, growing: 40, 80, 160 ms.
        assert!(gaps[0] >= Duration::from_millis(40), "{gaps:?}");
        assert!(gaps[1] >= Duration::from_millis(80), "{gaps:?}");
        assert!(gaps[2] >= Duration::from_millis(160), "{gaps:?}");
        // A good poll is followed by the next one at once: not after a pause, nor the floor.
        assert!(gaps[3] < floor / 2, "{gaps:?}");
    }
    assert_eq!(rig.runs().len(), 1);
    // The body that is not a poll is logged by the field it lacks, and never quoted.
    let text = logs.text();
    let not_a_poll = text
        .lines()
        .find(|l| l.contains("not a poll") && l.contains("commands"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(not_a_poll.contains("WARN"), "{not_a_poll}");
    assert!(!text.contains("nope") && !text.contains("<html>"), "{text}");
    rig.stop().await;
}

#[tokio::test]
async fn idle_polls_are_spaced_even_when_the_server_does_not_wait() {
    let _logs = Logs::capture();
    // A server that holds no poll: it allows no wait and answers an idle poll at once.
    let script = Script {
        max_wait_s: Some(0),
        idle_hold: Some(Duration::ZERO),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("six polls", |s| s.polls.len() >= 6).await;
    {
        let seen = rig.seen();
        // The bridge asked for no wait, as the server allows...
        assert!(
            seen.poll_queries.iter().all(|q| q.contains("wait_s=0")),
            "{:?}",
            seen.poll_queries
        );
        // ... and still spaced the polls (25 ms in these tests), not a busy loop.
        for gap in gaps(&seen.polls) {
            assert!(gap >= Duration::from_millis(20), "{gap:?}");
        }
    }
    rig.stop().await;
}

#[tokio::test]
async fn a_driver_panic_fails_its_command_and_the_phone_keeps_working() {
    let logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![
            // The fake driver panics on a key press.
            leased(1, "R58N1", json!({ "kind": "key", "key": "power" })),
            leased(2, "R58N1", tap(2)),
        ])]
        .into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("both results", |s| accepted(s).len() == 2).await;
    {
        let seen = rig.seen();
        let failed = &accepted_for(&seen, 1)[0]["outcome"];
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["reason"], "bridge_error");
        assert!(
            !failed["detail"].as_str().unwrap().contains("PANIC-DETAIL"),
            "{failed}"
        );
        // The phone's next command still ran.
        assert_eq!(
            accepted_for(&seen, 2)[0]["outcome"],
            json!({ "status": "done", "result": { "kind": "done" } })
        );
    }
    assert_eq!(rig.ran(), ["tap 2"]);
    // The phone recovered before its next command.
    {
        let phones = rig.phones();
        assert_eq!(phones.recovers.len(), 1);
        let tap_2 = phones
            .started
            .iter()
            .find(|(_, w, _)| w == "tap 2")
            .unwrap()
            .2;
        assert!(phones.recovers[0].1 <= tap_2);
    }
    // Logged at error level with the serial and the command id, never the panic's message.
    let text = logs.text();
    let line = text
        .lines()
        .find(|l| l.contains("ERROR") && l.contains(&id(1).to_string()))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(line.contains("R58N1"), "{line}");
    assert!(!text.contains("PANIC-DETAIL"), "{text}");
    rig.stop().await;
}

#[tokio::test]
async fn a_hung_command_times_out_and_the_next_runs() {
    let _logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![
            leased(1, "R58N1", hang()),
            leased(2, "R58N1", tap(2)),
        ])]
        .into(),
        ..Script::default()
    };
    let phones = [("R58N1", 0)];
    let mut setup = Setup::new(&phones);
    setup.timing.command_timeout = Duration::from_millis(150);
    let rig = setup.start(script).await;
    rig.until("both results", |s| accepted(s).len() == 2).await;
    {
        let seen = rig.seen();
        let failed = &accepted_for(&seen, 1)[0]["outcome"];
        assert_eq!(failed["reason"], "timeout");
        assert_eq!(
            accepted_for(&seen, 2)[0]["outcome"],
            json!({ "status": "done", "result": { "kind": "done" } })
        );
    }
    // The hung command was cut off (its future dropped), the phone recovered, and only then did
    // the next command start: never two at once on one phone.
    {
        let phones = rig.phones();
        assert_eq!(phones.cuts.len(), 1);
        let (_, cut_what, cut) = &phones.cuts[0];
        assert_eq!(cut_what, "long_press");
        assert_eq!(phones.recovers.len(), 1);
        let recovered = phones.recovers[0].1;
        let tap_2 = phones
            .started
            .iter()
            .find(|(_, w, _)| w == "tap 2")
            .unwrap()
            .2;
        assert!(*cut <= recovered && recovered <= tap_2);
    }
    rig.stop().await;
}

#[tokio::test]
async fn push_file_is_bounded_by_the_transfer_timeout() {
    let _logs = Logs::capture();
    let (base, fake) = serve(Script::default()).await;
    fake.script.lock().unwrap().polls = [poll(vec![
        push_file(1, "R58N1", format!("{base}/signed/file?sig=S")),
        leased(2, "R58N1", tap(2)),
    ])]
    .into();
    // Every command takes 250 ms: longer than other commands may, well within a transfer's bound.
    let phones = [("R58N1", 250)];
    let mut setup = Setup::new(&phones);
    setup.timing.command_timeout = Duration::from_millis(100);
    setup.timing.transfer_timeout = Duration::from_secs(5);
    let rig = setup.attach(&base, fake);
    rig.until("both results", |s| accepted(s).len() == 2).await;
    {
        let seen = rig.seen();
        assert_eq!(
            accepted_for(&seen, 1)[0]["outcome"],
            json!({ "status": "done", "result": { "kind": "done" } })
        );
        assert_eq!(accepted_for(&seen, 2)[0]["outcome"]["reason"], "timeout");
    }
    rig.stop().await;
}

#[tokio::test]
async fn a_command_that_waited_past_its_expiry_is_failed_unrun() {
    let _logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![
            leased(1, "R58N1", tap(1)),
            leased(2, "R58N1", tap(2)),
        ])]
        .into(),
        ..Script::default()
    };
    // The first command takes 300 ms; the second waits behind it longer than it may.
    let phones = [("R58N1", 300)];
    let mut setup = Setup::new(&phones);
    setup.timing.stale_after = Duration::from_millis(100);
    let rig = setup.start(script).await;
    rig.until("both results", |s| accepted(s).len() == 2).await;
    {
        let seen = rig.seen();
        let failed = &accepted_for(&seen, 2)[0]["outcome"];
        assert_eq!(failed["reason"], "timeout");
        assert!(
            failed["detail"].as_str().unwrap().contains("waited"),
            "{failed}"
        );
    }
    assert_eq!(rig.ran(), ["tap 1"]);
    rig.stop().await;
}

#[tokio::test]
async fn results_made_before_shutdown_are_posted() {
    let _logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![
            leased(1, "PHONE_A", tap(1)),
            leased(2, "PHONE_B", hang()),
        ])]
        .into(),
        // The server takes no result before the bridge is told to stop.
        results_unavailable: true,
        ..Script::default()
    };
    let rig = Rig::start(script, &[("PHONE_A", 0), ("PHONE_B", 0)]).await;
    rig.until("a refused post", |s| !s.posts.is_empty()).await;
    rig.until_phones("the hung command running", |p| {
        p.started.iter().any(|(_, w, _)| w == "long_press")
    })
    .await;
    rig.fake.script.lock().unwrap().results_unavailable = false;
    let fake = rig.fake.clone();
    let log = rig.log.clone();
    rig.stop().await;
    // Once the bridge has stopped: the result made before is posted, and the running command
    // was cut off, its phone recovered, and its failure posted.
    let seen = fake.seen.lock().unwrap();
    assert_eq!(
        accepted_for(&seen, 1)[0]["outcome"],
        json!({ "status": "done", "result": { "kind": "done" } })
    );
    let cut = &accepted_for(&seen, 2)[0]["outcome"];
    assert_eq!(cut["reason"], "bridge_error");
    assert!(cut["detail"].as_str().unwrap().contains("stopped"), "{cut}");
    let phones = log.lock().unwrap();
    assert_eq!(phones.cuts.len(), 1);
    assert_eq!(phones.cuts[0].0, "PHONE_B");
    assert_eq!(phones.recovers.len(), 1);
    assert_eq!(phones.recovers[0].0, "PHONE_B");
}

// ---------------------------------------------------------------------------------------------
// Posting

#[tokio::test]
async fn result_post_retried_until_accepted() {
    let logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![leased(1, "R58N1", tap(1))])].into(),
        result_statuses: [503, 500].into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("the accepted result", |s| !accepted(s).is_empty())
        .await;
    {
        let seen = rig.seen();
        let statuses: Vec<u16> = seen.posts.iter().map(|(_, _, s)| *s).collect();
        assert_eq!(statuses, [503, 500, 200]);
        // The same batch each time.
        assert!(
            seen.posts
                .iter()
                .all(|(_, body, _)| *body == seen.posts[0].1)
        );
        // After a pause that grows.
        let at: Vec<Instant> = seen.posts.iter().map(|(at, _, _)| *at).collect();
        let gaps = gaps(&at);
        assert!(gaps[0] >= Duration::from_millis(40), "{gaps:?}");
        assert!(gaps[1] >= Duration::from_millis(80), "{gaps:?}");
    }
    // The command ran once.
    assert_eq!(rig.runs().len(), 1);
    assert!(
        logs.text().contains("the server answered 503"),
        "{}",
        logs.text()
    );
    rig.stop().await;
}

/// Three commands this build cannot read: their failures are made at once, so they are posted
/// as one batch.
fn three_unreadable() -> VecDeque<Poll> {
    let unreadable = |n| leased(n, "R58N1", json!({ "kind": "teleport" }));
    [poll(vec![unreadable(1), unreadable(2), unreadable(3)])].into()
}

#[tokio::test]
async fn refused_results_batch_is_not_resent_as_is() {
    let logs = Logs::capture();
    let script = Script {
        polls: three_unreadable(),
        refuse_batches_with: Some(id(2)),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("five posts", |s| s.posts.len() >= 5).await;
    // Longer than the longest pause: nothing is sent again.
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        let seen = rig.seen();
        // Split in halves until the refused result stands alone, which is dropped.
        assert_eq!(
            posts(&seen),
            [
                (ids(&[1, 2, 3]), 422),
                (ids(&[1]), 200),
                (ids(&[2, 3]), 422),
                (ids(&[2]), 422),
                (ids(&[3]), 200),
            ]
        );
        // No body was sent twice.
        for (i, (_, a, _)) in seen.posts.iter().enumerate() {
            for (_, b, _) in &seen.posts[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
    // The dropped result is logged by its id and the field, not the server's message.
    let text = logs.text();
    let dropped = text
        .lines()
        .find(|l| l.contains("dropped") && l.contains(&id(2).to_string()))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(
        dropped.contains("WARN") && dropped.contains("detail"),
        "{dropped}"
    );
    assert!(!text.contains("longer than 300"), "{text}");
    rig.stop().await;
}

#[tokio::test]
async fn a_batch_over_the_body_limit_is_split() {
    let _logs = Logs::capture();
    // A body limit that three of these results break, and two do not (each is about 380 bytes).
    let script = Script {
        polls: three_unreadable(),
        results_body_limit: Some(900),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("all three accepted", |s| accepted(s).len() == 3)
        .await;
    assert_eq!(
        posts(&rig.seen()),
        [
            (ids(&[1, 2, 3]), 413),
            (ids(&[1]), 200),
            (ids(&[2, 3]), 200)
        ]
    );
    rig.stop().await;
}

#[tokio::test]
async fn a_batch_refused_with_another_4xx_is_dropped() {
    let logs = Logs::capture();
    let script = Script {
        polls: [
            poll(vec![leased(1, "R58N1", tap(1))]),
            Poll {
                delay: Duration::from_millis(150),
                ..poll(vec![leased(2, "R58N1", tap(2))])
            },
        ]
        .into(),
        result_statuses: [404].into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("the second result", |s| accepted_for(s, 2).len() == 1)
        .await;
    // The refused batch is posted once and dropped; the bridge goes on.
    assert_eq!(posts(&rig.seen()), [(ids(&[1]), 404), (ids(&[2]), 200)]);
    let text = logs.text();
    let dropped = text
        .lines()
        .find(|l| l.contains("they are dropped"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(
        dropped.contains("ERROR") && dropped.contains("404"),
        "{dropped}"
    );
    rig.stop().await;
}

#[tokio::test]
async fn a_batch_the_server_keeps_failing_is_split_and_a_lone_result_dropped() {
    let logs = Logs::capture();
    // The server fails (503) every batch that holds the second result, forever.
    let script = Script {
        polls: three_unreadable(),
        refuse_batches_with: Some(id(2)),
        refuse_status: Some(503),
        ..Script::default()
    };
    let phones = [("R58N1", 0)];
    let mut setup = Setup::new(&phones);
    setup.timing.post_attempts = 2;
    let rig = setup.start(script).await;
    rig.until("eight posts", |s| s.posts.len() >= 8).await;
    // Longer than the longest pause: nothing more is sent.
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        let seen = rig.seen();
        // Each batch gets two tries, then is split; the lone failing result is dropped, and
        // the others are not held up by it.
        assert_eq!(
            posts(&seen),
            [
                (ids(&[1, 2, 3]), 503),
                (ids(&[1, 2, 3]), 503),
                (ids(&[1]), 200),
                (ids(&[2, 3]), 503),
                (ids(&[2, 3]), 503),
                (ids(&[2]), 503),
                (ids(&[2]), 503),
                (ids(&[3]), 200),
            ]
        );
    }
    let text = logs.text();
    let dropped = text
        .lines()
        .find(|l| l.contains("kept failing a result"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(
        dropped.contains("WARN") && dropped.contains(&id(2).to_string()),
        "{dropped}"
    );
    rig.stop().await;
}

// ---------------------------------------------------------------------------------------------
// Files

#[tokio::test]
async fn file_transfer_uploads_with_the_key_and_downloads_without_it() {
    let logs = Logs::capture();
    let (base, fake) = serve(Script::default()).await;
    // The download address is signed: it is the command's, and it must not be logged.
    fake.script.lock().unwrap().polls = [poll(vec![
        leased(1, "R58N1", json!({ "kind": "screenshot" })),
        push_file(
            2,
            "R58N1",
            format!("{base}/signed/file?sig=SIGNED-SECRET-123"),
        ),
        leased(
            3,
            "R58N1",
            json!({ "kind": "pull_file", "path": "/sdcard/x.bin" }),
        ),
    ])]
    .into();
    let rig = Setup::new(&[("R58N1", 0)]).attach(&base, fake);
    rig.until("three results", |s| accepted(s).len() == 3).await;
    {
        let seen = rig.seen();
        // The screenshot and the pulled file went up with the key (counted otherwise), each with
        // its type; the pulled one streamed from disk.
        assert_eq!(seen.unauthorized, 0);
        assert_eq!(
            seen.uploads,
            [
                (Some("image/png".to_owned()), PNG.to_vec()),
                (Some("application/octet-stream".to_owned()), PULLED.to_vec()),
            ]
        );
        let file = json!({ "status": "done", "result": { "kind": "file", "file_id": FILE_ID } });
        assert_eq!(accepted_for(&seen, 1)[0]["outcome"], file);
        assert_eq!(accepted_for(&seen, 3)[0]["outcome"], file);
        // The file came down without it.
        assert_eq!(seen.downloads, [None]);
        assert_eq!(
            accepted_for(&seen, 2)[0]["outcome"],
            json!({ "status": "done", "result": { "kind": "done" } })
        );
    }
    let text = logs.text();
    assert!(
        !text.contains("SIGNED-SECRET") && !text.contains(KEY),
        "{text}"
    );
    rig.stop().await;
}

#[tokio::test]
async fn posts_carry_the_requested_with_header() {
    let _logs = Logs::capture();
    let script = Script {
        polls: [poll(vec![leased(
            1,
            "R58N1",
            json!({ "kind": "screenshot" }),
        )])]
        .into(),
        ..Script::default()
    };
    let (base, fake) = serve(script).await;
    // The fake refuses a post without it, as the API does: the rule is not vacuous.
    let bare = reqwest::Client::new()
        .post(format!("{base}/api/devices/bridge/results"))
        .header("authorization", format!("Bearer {KEY}"))
        .json(&json!({ "results": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(bare.status(), 403);
    fake.seen.lock().unwrap().without_requested_with = 0;

    let rig = Setup::new(&[("R58N1", 0)]).attach(&base, fake);
    rig.until("the accepted result", |s| !accepted(s).is_empty())
        .await;
    {
        // A register, an upload and a results post went through, every one with the header.
        let seen = rig.seen();
        assert!(!seen.registers.is_empty() && seen.uploads.len() == 1);
        assert_eq!(seen.without_requested_with, 0);
        assert_eq!(seen.unauthorized, 0);
    }
    rig.stop().await;
}

// ---------------------------------------------------------------------------------------------
// What is never logged

#[tokio::test]
async fn key_never_logged() {
    let logs = Logs::capture();
    // Error answers that echo the key, as a careless server or proxy might.
    let echo = format!("key {KEY} refused; Authorization: Bearer {KEY}");
    let script = Script {
        polls: [
            answer(500, echo.clone()),
            answer(401, echo.clone()),
            poll(vec![leased(1, "R58N1", json!({ "kind": "screenshot" }))]),
        ]
        .into(),
        result_statuses: [503].into(),
        error_body: echo,
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("the accepted result", |s| !accepted(s).is_empty())
        .await;
    rig.stop().await;

    // A server that cannot be reached: the request errors themselves.
    let dead = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap()
    };
    let (stop, task) = bridge(&format!("http://{dead}"), Arc::new(Phones::new(Vec::new())));
    // Windows takes about two seconds to refuse a connection to a closed port.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !logs.text().contains("registering with Jeeta failed") {
        assert!(Instant::now() < deadline, "{}", logs.text());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _ = stop.send(());
    task.await.unwrap();

    let text = logs.text();
    // Not vacuous: the failures were logged.
    for logged in [
        "the server answered 500",
        "the server answered 401",
        "the server answered 503",
        "error sending request",
    ] {
        assert!(text.contains(logged), "{logged} not in {text}");
    }
    assert!(!text.contains(KEY), "{text}");
    assert!(!text.contains("Bearer"), "{text}");
}

/// An address that accepts a connection and closes it at once: every request to it fails
/// without an answer, and fast (a closed port takes about two seconds to refuse on Windows).
async fn closing_server() -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            drop(socket);
        }
    });
    addr
}

#[tokio::test]
async fn a_failed_requests_url_is_never_logged() {
    let logs = Logs::capture();
    let closing = closing_server().await;

    // The server's own address, with a path no line may show.
    let (stop, task) = bridge(
        &format!("http://{closing}/PRIVATE-PATH-1"),
        Arc::new(Phones::new(Vec::new())),
    );

    // A signed download address that answers nothing: neither the log nor the failure's
    // detail, which the server keeps, may show it.
    let (base, fake) = serve(Script::default()).await;
    fake.script.lock().unwrap().polls = [poll(vec![push_file(
        1,
        "R58N1",
        format!("http://{closing}/signed/file?sig=SIGNED-SECRET-2"),
    )])]
    .into();
    let rig = Setup::new(&[("R58N1", 0)]).attach(&base, fake);
    rig.until("the failed push", |s| accepted_for(s, 1).len() == 1)
        .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !logs.text().contains("registering with Jeeta failed") {
        assert!(Instant::now() < deadline, "{}", logs.text());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _ = stop.send(());
    task.await.unwrap();
    {
        let seen = rig.seen();
        let failed = &accepted_for(&seen, 1)[0]["outcome"];
        assert_eq!(failed["reason"], "bridge_error");
        let detail = failed["detail"].as_str().unwrap();
        assert!(detail.contains("downloading the file failed"), "{detail}");
        assert!(
            !detail.contains("SIGNED-SECRET") && !detail.contains("signed/file"),
            "{detail}"
        );
    }
    rig.stop().await;
    let text = logs.text();
    // Not vacuous: the request errors were logged.
    assert!(text.contains("error sending request"), "{text}");
    for hidden in ["PRIVATE-PATH", "SIGNED-SECRET", "signed/file"] {
        assert!(!text.contains(hidden), "{hidden} in {text}");
    }
}
