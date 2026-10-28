//! The bridge's loop against a fake Jeeta: an axum server on 127.0.0.1 that records what the
//! bridge sends and answers from a script, with fake phones behind the driver traits. Intervals
//! are milliseconds (`Timing`), so no test waits for real seconds.
//!
//! Each test captures the log of its own thread (`#[tokio::test]` runs every task of the test on
//! it), so a test can say what was and was not logged.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use jeeta_device_bridge::{
    AttachedPhone, Config, DriverError, FileTransfer, PhoneDriver, PhoneRegistry, Timing, run,
};
use jt_device_protocol::{
    CommandResult, DeviceCommand, FailReason, PHONE_RETIRED, PhoneReport, Platform,
};
use serde_json::{Value, json};
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
    /// The answers to the polls, in order; then idle polls.
    polls: VecDeque<Poll>,
    /// The statuses of the result posts, in order; then 200.
    result_statuses: VecDeque<u16>,
    /// A command whose result makes a batch refused (422).
    refuse_batches_with: Option<Uuid>,
    /// The body of every error answer but a 422.
    error_body: String,
}

/// What the fake was sent.
#[derive(Default)]
struct Seen {
    /// Register bodies.
    registers: Vec<(Instant, Value)>,
    /// When each poll arrived.
    polls: Vec<Instant>,
    /// Result posts and the status each was answered with.
    posts: Vec<(Instant, Value, u16)>,
    /// Uploads: content type and bytes.
    uploads: Vec<(Option<String>, Vec<u8>)>,
    /// Signed downloads: the authorization header each carried.
    downloads: Vec<Option<String>>,
    /// Route calls without the right key.
    unauthorized: usize,
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
}

async fn register(State(fake): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if !fake.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, fake.error_body()).into_response();
    }
    let body: Value = serde_json::from_slice(&body).unwrap();
    fake.seen
        .lock()
        .unwrap()
        .registers
        .push((Instant::now(), body.clone()));
    let script = fake.script.lock().unwrap();
    let (mut phones, mut refused) = (Vec::new(), Vec::new());
    for phone in body["phones"].as_array().unwrap() {
        let serial = phone["serial"].as_str().unwrap();
        match script.refuse.iter().find(|(s, _)| *s == serial) {
            Some((_, reason)) => refused
                .push(json!({ "platform": phone["platform"], "serial": serial, "reason": reason })),
            None => phones.push(json!({ "serial": serial, "capability_id": capability(serial) })),
        }
    }
    let heartbeat_s = if script.heartbeat_s == 0 {
        15
    } else {
        script.heartbeat_s
    };
    axum::Json(json!({
        "phones": phones, "refused": refused,
        "heartbeat_s": heartbeat_s, "max_wait_s": 25, "protocol": 1,
    }))
    .into_response()
}

async fn commands(State(fake): State<Shared>, headers: HeaderMap) -> Response {
    if !fake.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, fake.error_body()).into_response();
    }
    fake.seen.lock().unwrap().polls.push(Instant::now());
    let next = fake.script.lock().unwrap().polls.pop_front();
    match next {
        Some(poll) => {
            tokio::time::sleep(poll.delay).await;
            (StatusCode::from_u16(poll.status).unwrap(), poll.body).into_response()
        }
        None => {
            // An idle long poll: held a little, then empty.
            tokio::time::sleep(Duration::from_millis(30)).await;
            (StatusCode::OK, r#"{"commands":[]}"#).into_response()
        }
    }
}

async fn results(State(fake): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if !fake.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, fake.error_body()).into_response();
    }
    let body: Value = serde_json::from_slice(&body).unwrap();
    let ids = posted_ids(&body);
    let (status, error_body) = {
        let mut script = fake.script.lock().unwrap();
        let refused = script
            .refuse_batches_with
            .is_some_and(|id| ids.contains(&id.to_string()));
        let status = if refused {
            422
        } else {
            script.result_statuses.pop_front().unwrap_or(200)
        };
        (status, script.error_body.clone())
    };
    fake.seen
        .lock()
        .unwrap()
        .posts
        .push((Instant::now(), body, status));
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
    if !fake.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, fake.error_body()).into_response();
    }
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
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
        .route("/api/devices/bridge/results", post(results))
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

// ---------------------------------------------------------------------------------------------
// Fake phones

/// A command a fake phone ran.
#[derive(Clone, Debug)]
struct Run {
    serial: String,
    what: String,
    started: Instant,
    ended: Instant,
}

struct FakePhone {
    serial: String,
    delay: Duration,
    runs: Arc<Mutex<Vec<Run>>>,
}

#[async_trait]
impl PhoneDriver for FakePhone {
    fn platform(&self) -> Platform {
        Platform::Android
    }

    async fn report(&self) -> Result<PhoneReport, DriverError> {
        Ok(PhoneReport {
            platform: Platform::Android,
            serial: self.serial.clone(),
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
        tokio::time::sleep(self.delay).await;
        let (what, result) = match cmd {
            DeviceCommand::Tap { x, .. } => (format!("tap {x}"), Ok(CommandResult::Done {})),
            DeviceCommand::Screenshot {} => (
                "screenshot".to_owned(),
                files
                    .upload(PNG.to_vec(), "image/png")
                    .await
                    .map(|file_id| CommandResult::File { file_id }),
            ),
            DeviceCommand::PushFile { .. } => {
                let dest = std::env::temp_dir().join(format!("jdb-loop-{}", Uuid::now_v7()));
                let result = pushed(files, &dest).await;
                let _ = std::fs::remove_file(&dest);
                ("push_file".to_owned(), result)
            }
            other => (
                other.kind().to_owned(),
                Err(DriverError::new(
                    FailReason::UnsupportedOnPlatform,
                    "not in this fake",
                )),
            ),
        };
        self.runs.lock().unwrap().push(Run {
            serial: self.serial.clone(),
            what,
            started,
            ended: Instant::now(),
        });
        result
    }
}

/// A `push_file` the fake way: download, then check what arrived.
async fn pushed(files: &dyn FileTransfer, dest: &PathBuf) -> Result<CommandResult, DriverError> {
    let written = files.download(dest).await?;
    let bytes = std::fs::read(dest).unwrap();
    if written != DOWNLOAD.len() as u64 || bytes != DOWNLOAD {
        return Err(DriverError::new(FailReason::BridgeError, "wrong file"));
    }
    Ok(CommandResult::Done {})
}

/// Fixed attached phones.
struct Phones(Vec<AttachedPhone>);

#[async_trait]
impl PhoneRegistry for Phones {
    async fn attached(&self) -> Result<Vec<AttachedPhone>, DriverError> {
        Ok(self.0.clone())
    }
}

// ---------------------------------------------------------------------------------------------
// The rig

/// Short intervals: a server second is 20 ms; failures pause 40, 80, then 160 ms.
fn quick() -> Timing {
    Timing {
        server_second: Duration::from_millis(20),
        poll_wait_s: 1,
        backoff_min: Duration::from_millis(40),
        backoff_max: Duration::from_millis(160),
        command_timeout: Duration::from_secs(5),
        report_timeout: Duration::from_secs(2),
        shutdown_grace: Duration::from_millis(500),
    }
}

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Everything logged on this thread, at every level, while it lives.
struct Logs {
    buffer: Buffer,
    _guard: tracing::subscriber::DefaultGuard,
}

impl Logs {
    fn capture() -> Logs {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        Logs {
            buffer,
            _guard: tracing::subscriber::set_default(subscriber),
        }
    }

    fn text(&self) -> String {
        String::from_utf8(self.buffer.0.lock().unwrap().clone()).unwrap()
    }
}

/// A bridge for `base` with `registry`'s phones; answers its stop switch and its task.
fn bridge(base: &str, registry: Arc<dyn PhoneRegistry>) -> (oneshot::Sender<()>, JoinHandle<()>) {
    let config = Config::parse(
        &format!("base_url = \"{base}\"\nkey = \"{KEY}\"\nbridge_id = \"test-pc\"\n"),
        |_| None,
    )
    .unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let stopped = async {
            let _ = stopped.await;
        };
        run(&config, registry, quick(), stopped).await.unwrap();
    });
    (stop, task)
}

/// A fake Jeeta and a bridge with fake phones, each `(serial, milliseconds per command)`.
struct Rig {
    fake: Shared,
    runs: Arc<Mutex<Vec<Run>>>,
    started: Instant,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl Rig {
    async fn start(script: Script, phones: &[(&str, u64)]) -> Rig {
        let (base, fake) = serve(script).await;
        Rig::attach(&base, fake, phones)
    }

    /// A bridge for a fake Jeeta already serving at `base`.
    fn attach(base: &str, fake: Shared, phones: &[(&str, u64)]) -> Rig {
        let runs = Arc::new(Mutex::new(Vec::new()));
        let attached = phones
            .iter()
            .map(|(serial, ms)| AttachedPhone {
                serial: (*serial).to_owned(),
                driver: Arc::new(FakePhone {
                    serial: (*serial).to_owned(),
                    delay: Duration::from_millis(*ms),
                    runs: runs.clone(),
                }),
            })
            .collect();
        let started = Instant::now();
        let (stop, task) = bridge(base, Arc::new(Phones(attached)));
        Rig {
            fake,
            runs,
            started,
            stop,
            task,
        }
    }

    fn seen(&self) -> MutexGuard<'_, Seen> {
        self.fake.seen.lock().unwrap()
    }

    /// What the phones ran: serial and command, in the order they finished.
    fn runs(&self) -> Vec<Run> {
        self.runs.lock().unwrap().clone()
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

// ---------------------------------------------------------------------------------------------
// The tests

#[tokio::test]
async fn registers_on_start_and_every_heartbeat() {
    let _logs = Logs::capture();
    // The server asks for a register every 5 of its seconds: 100 ms here. The protocol's own 15
    // would be 300 ms.
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
        assert!(
            at[0] - rig.started < Duration::from_millis(100),
            "{:?}",
            at[0] - rig.started
        );
        // Then every heartbeat the server asked for.
        for gap in gaps(&at) {
            assert!(
                gap >= Duration::from_millis(95) && gap < Duration::from_millis(250),
                "{gap:?}"
            );
        }
        let body = &seen.registers[0].1;
        assert_eq!(body["bridge_id"], "test-pc");
        assert_eq!(body["protocol"], 1);
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["phones"][0]["serial"], "R58N1");
        assert_eq!(body["phones"][0]["platform"], "android");
        assert_eq!(body["phones"][0]["model"], "Fake 1");
        assert_eq!(seen.unauthorized, 0);
    }
    rig.stop().await;
}

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
    // The bridge's own lines, without their timestamps (digits there, and in the ports of the
    // HTTP client's traces, may spell anything).
    let ours: Vec<&str> = text
        .lines()
        .filter(|l| l.contains("jeeta_device_bridge"))
        .map(|l| l.split_once(' ').map_or(l, |(_, rest)| rest))
        .collect();
    assert!(
        !ours.is_empty() && ours.iter().all(|l| !l.contains("540")),
        "{ours:#?}"
    );
    rig.stop().await;
}

#[tokio::test]
async fn same_command_id_runs_once() {
    let _logs = Logs::capture();
    let mut later = poll(vec![leased(1, "R58N1", tap(1))]);
    later.delay = Duration::from_millis(150);
    let script = Script {
        polls: [
            poll(vec![leased(1, "R58N1", tap(1))]),
            // Handed out again while it runs, with a new one.
            poll(vec![leased(1, "R58N1", tap(1)), leased(2, "R58N1", tap(2))]),
            // And again once it is done.
            later,
        ]
        .into(),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 50)]).await;
    rig.until("both results and the poll after the last redelivery", |s| {
        accepted_for(s, 2).len() == 1 && s.polls.len() >= 4
    })
    .await;
    let what: Vec<String> = rig.runs().into_iter().map(|r| r.what).collect();
    assert_eq!(what, ["tap 1", "tap 2"]);
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
    let rig = Rig::start(script, &[("PHONE_A", 40), ("PHONE_B", 40)]).await;
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
    let what: Vec<String> = rig.runs().into_iter().map(|r| r.what).collect();
    assert_eq!(what, ["tap 1"]);
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
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
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
        // A good poll is followed by the next one at once.
        assert!(gaps[3] < Duration::from_millis(40), "{gaps:?}");
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
    let (stop, task) = bridge(&format!("http://{dead}"), Arc::new(Phones(Vec::new())));
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

#[tokio::test]
async fn refused_results_batch_is_not_resent_as_is() {
    let logs = Logs::capture();
    // Three results at once (commands this build cannot read are failed together), one of which
    // the server refuses.
    let unreadable = |n| leased(n, "R58N1", json!({ "kind": "teleport" }));
    let script = Script {
        polls: [poll(vec![unreadable(1), unreadable(2), unreadable(3)])].into(),
        refuse_batches_with: Some(id(2)),
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0)]).await;
    rig.until("five posts", |s| s.posts.len() >= 5).await;
    // Longer than the longest pause: nothing is sent again.
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        let seen = rig.seen();
        let posts: Vec<(Vec<String>, u16)> = seen
            .posts
            .iter()
            .map(|(_, body, status)| (posted_ids(body), *status))
            .collect();
        let ids = |ns: &[u128]| ns.iter().map(|n| id(*n).to_string()).collect::<Vec<_>>();
        // Split in halves until the refused result stands alone, which is dropped.
        assert_eq!(
            posts,
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
        assert_eq!(accepted_for(&seen, 1).len(), 1);
        assert_eq!(accepted_for(&seen, 3).len(), 1);
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
async fn retired_phone_is_not_listed_again() {
    let logs = Logs::capture();
    let script = Script {
        heartbeat_s: 3,
        refuse: vec![
            ("RETIRED1", PHONE_RETIRED),
            ("BADMODEL1", "model: must not contain a NUL character"),
        ],
        ..Script::default()
    };
    let rig = Rig::start(script, &[("R58N1", 0), ("RETIRED1", 0), ("BADMODEL1", 0)]).await;
    rig.until("three registers", |s| s.registers.len() >= 3)
        .await;
    {
        let seen = rig.seen();
        let serials = |body: &Value| -> Vec<String> {
            body["phones"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["serial"].as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(
            serials(&seen.registers[0].1),
            ["R58N1", "RETIRED1", "BADMODEL1"]
        );
        // The retired phone is not listed again; a phone refused for another reason still is.
        for (_, body) in &seen.registers[1..] {
            assert_eq!(serials(body), ["R58N1", "BADMODEL1"]);
        }
    }
    // Each refusal is logged with the serial and the reason, at warn level, once.
    let text = logs.text();
    for (serial, reason) in [
        ("RETIRED1", PHONE_RETIRED),
        ("BADMODEL1", "must not contain a NUL character"),
    ] {
        let lines: Vec<&str> = text.lines().filter(|l| l.contains(serial)).collect();
        assert_eq!(lines.len(), 1, "{serial}: {text}");
        assert!(
            lines[0].contains("WARN") && lines[0].contains(reason),
            "{}",
            lines[0]
        );
    }
    rig.stop().await;
}

#[tokio::test]
async fn file_transfer_uploads_with_the_key_and_downloads_without_it() {
    let logs = Logs::capture();
    let (base, fake) = serve(Script::default()).await;
    // The download address is signed: it is the command's, and it must not be logged.
    let signed_url = format!("{base}/signed/file?sig=SIGNED-SECRET-123");
    let mut push = leased(
        2,
        "R58N1",
        json!({ "kind": "push_file", "file_id": id(9), "dest": "/sdcard/x.bin" }),
    );
    push["download_url"] = json!(signed_url);
    fake.script.lock().unwrap().polls = [poll(vec![
        leased(1, "R58N1", json!({ "kind": "screenshot" })),
        push,
    ])]
    .into();
    let rig = Rig::attach(&base, fake, &[("R58N1", 0)]);
    rig.until("both results", |s| accepted(s).len() == 2).await;
    {
        let seen = rig.seen();
        // The screenshot went up with the key (counted otherwise) and its type.
        assert_eq!(seen.unauthorized, 0);
        assert_eq!(seen.uploads, [(Some("image/png".to_owned()), PNG.to_vec())]);
        assert_eq!(
            accepted_for(&seen, 1)[0]["outcome"],
            json!({ "status": "done", "result": { "kind": "file", "file_id": FILE_ID } })
        );
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
