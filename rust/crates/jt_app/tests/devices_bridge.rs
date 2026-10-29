//! The device bridge's surface (D1-T5): its heartbeat declares and verifies a `phone` per phone,
//! merging what it reports key by key; its poll leases the due commands of exactly the phones its
//! latest registration lists, re-checking what each phone's bridge lists now; its results are
//! applied once per command, for the phones it ever registered; its files are the workspace's
//! device files; and its key reaches nothing else.
mod support;

use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};

use async_trait::async_trait;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::MediaUpload;
use jt_app::ports::devices::{
    CommandStatus, DEFAULT_EXPIRES_IN, DeviceCommand, DeviceCommandRow, FailReason,
    MAX_DEVICE_COMMAND_PAGE, NewDeviceCommand, TEXT_UNICODE,
};
use jt_app::ports::files::{ByteSource, FileMaintenance, FileStore, StoredFile};
use jt_app::usecases::Deps;
use jt_app::usecases::api_keys::{self, AgentPrincipal, CreateKey};
use jt_app::usecases::capabilities::{self, DeclareInput};
use jt_app::usecases::devices::{
    self,
    bridge::{
        self, BridgeCaller, CommandsQuery, FileOut, RegisterIn, RegisterOut, ResultsIn, ResultsOut,
    },
    uploads::{UploadLimits, UploadTurns},
};
use jt_app::usecases::files::DEVICE_FILE_LIMIT;
use jt_app::usecases::studio::files::IMAGE_LIMIT;
use jt_capability::{Capability, CapabilityId, Reach, StoredStatus};
use jt_device_protocol::{
    CommandResult, LeasedCommand, Observation, Outcome, PHONE_RETIRED, PhoneReport, Platform,
    RefusedPhone, ResultIn, Screen,
};
use jt_ledger::{Actor, Subject};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::FIXED_NOW;
use jt_testkit::fakes::files::{Chunks, MemoryFiles};
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// A screenshot as the bridge uploads it: the PNG signature, then anything.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nscreen";

/// `seconds` after the fixed time.
fn later(seconds: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(seconds)
}

/// Whether `at` is the time of a read made at `expected`: a read is made at its poll's time plus
/// how long it has waited, a poll that does not wait included.
fn read_at(at: OffsetDateTime, expected: OffsetDateTime) -> bool {
    at >= expected && at - expected < Duration::seconds(1)
}

/// A key the owner of workspace `ctx` issues with `scopes`, as the API resolves it.
async fn key_in(w: &World, ctx: &jt_app::ctx::Ctx, name: &str, scopes: &[&str]) -> AgentPrincipal {
    let key = api_keys::create(
        &w.deps,
        ctx,
        CreateKey {
            name: name.into(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        },
    )
    .await
    .unwrap();
    api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap()
}

/// A bridge's key: issued by the owner with `devices.bridge` alone.
async fn bridge_key(w: &World, name: &str) -> AgentPrincipal {
    key_in(w, &w.owner_ctx, name, &["devices.bridge"]).await
}

/// The bridge of `key` calling at `now`.
fn bridge_at(key: &AgentPrincipal, now: OffsetDateTime) -> BridgeCaller {
    bridge::ctx_for_bridge(key, now)
}

/// Everything a bridge can report it runs: every command kind, and Unicode text.
fn every_feature() -> Vec<String> {
    DeviceCommand::KINDS
        .iter()
        .map(|kind| (*kind).to_owned())
        .chain([TEXT_UNICODE.to_owned()])
        .collect()
}

/// An Android phone with serial `serial`, as the bridge reports it.
fn phone(serial: &str) -> PhoneReport {
    PhoneReport {
        platform: Platform::Android,
        serial: serial.into(),
        model: Some("Redmi 10C".into()),
        os_version: Some("13".into()),
        screen: Some(Screen {
            w: 720,
            h: 1650,
            rotation: 0,
        }),
        features: every_feature(),
    }
}

fn register_in(phones: Vec<PhoneReport>) -> RegisterIn {
    RegisterIn {
        bridge_id: "PC-1".into(),
        version: "0.1.0".into(),
        protocol: 1,
        phones,
    }
}

/// A registration of `phones` by the bridge of `key` at `now`, which must succeed.
async fn register(
    w: &World,
    key: &AgentPrincipal,
    now: OffsetDateTime,
    phones: Vec<PhoneReport>,
) -> RegisterOut {
    bridge::register(&w.deps, &bridge_at(key, now), register_in(phones))
        .await
        .unwrap()
}

/// The capability of the `i`-th phone a registration registered.
fn cap(out: &RegisterOut, i: usize) -> CapabilityId {
    CapabilityId(out.phones[i].capability_id)
}

/// An active workspace, a bridge's key, and the bridge registered with phone `SER1` at the fixed
/// time.
async fn rig() -> (World, AgentPrincipal, CapabilityId) {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w, "phones").await;
    let out = register(&w, &key, FIXED_NOW, vec![phone("SER1")]).await;
    (w, key, cap(&out, 0))
}

/// The fixed time plus the default lifetime of a command.
fn expires() -> OffsetDateTime {
    FIXED_NOW + DEFAULT_EXPIRES_IN
}

/// Queues `command` for phone `phone` at the fixed time, as an agent's `act` will, and signals the
/// bridges; its id.
async fn enqueue(
    w: &World,
    phone: CapabilityId,
    command: DeviceCommand,
    expires_at: OffsetDateTime,
) -> Uuid {
    let id = Uuid::now_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.device_commands()
        .enqueue(NewDeviceCommand {
            id,
            capability_id: phone,
            command,
            requested_by: Actor::System {
                component: "test".into(),
            },
            created_at: FIXED_NOW,
            expires_at,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.deps.bridge_signals.notify(devices::signal_key(w.ws));
    id
}

fn tap() -> DeviceCommand {
    DeviceCommand::Tap { x: 5, y: 5 }
}

fn shell() -> DeviceCommand {
    DeviceCommand::Shell {
        argv: vec!["getprop".into(), "ro.product.model".into()],
    }
}

/// A poll by the bridge of `key` at `now` that does not wait, handing out at most `limit`.
async fn poll(
    w: &World,
    key: &AgentPrincipal,
    now: OffsetDateTime,
    limit: u32,
) -> Vec<LeasedCommand> {
    bridge::commands(
        &w.deps,
        &bridge_at(key, now),
        CommandsQuery { wait_s: 0, limit },
    )
    .await
    .unwrap()
    .commands
}

fn ids(commands: &[LeasedCommand]) -> Vec<Uuid> {
    commands.iter().map(|c| c.id).collect()
}

/// A batch of `results` posted by the bridge of `key` at `now`.
async fn post(
    w: &World,
    key: &AgentPrincipal,
    now: OffsetDateTime,
    results: Vec<ResultIn>,
) -> Result<ResultsOut, AppError> {
    bridge::results(&w.deps, &bridge_at(key, now), ResultsIn { results }).await
}

fn counted(applied: u32, duplicates: u32, unknown: u32) -> ResultsOut {
    ResultsOut {
        applied,
        duplicates,
        unknown,
    }
}

/// Command `id` done, with nothing to report, in 42 ms.
fn done(id: Uuid) -> ResultIn {
    ResultIn {
        command_id: id,
        outcome: Outcome::Done {
            result: CommandResult::Done {},
        },
        duration_ms: 42,
    }
}

/// Command `id` done with `result`.
fn done_with(id: Uuid, result: CommandResult) -> ResultIn {
    ResultIn {
        command_id: id,
        outcome: Outcome::Done { result },
        duration_ms: 7,
    }
}

/// Command `id` as stored.
async fn row(w: &World, id: Uuid) -> DeviceCommandRow {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.device_commands().get(id).await.unwrap().unwrap()
}

/// Capability `id` as stored.
async fn stored(w: &World, id: CapabilityId) -> Capability {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().find(id).await.unwrap().unwrap()
}

/// What `devices.command.finished` carries as `result_sha256` for a command done with `result`:
/// the hash of the result as the command keeps it.
fn hash_of(result: &CommandResult) -> String {
    bridge::result_sha256(&serde_json::to_value(result).unwrap())
}

/// The payloads of the workspace's `devices.command.finished` entries, oldest first.
fn finished(w: &World) -> Vec<Value> {
    w.entries("devices.command.finished")
        .into_iter()
        .map(|e| e.payload)
        .collect()
}

/// The bridge `b` uploads `bytes` as `content_type`, announcing their length.
async fn upload_as(
    deps: &Deps,
    b: &BridgeCaller,
    content_type: Option<&str>,
    bytes: &[u8],
) -> Result<FileOut, AppError> {
    let len = Some(bytes.len() as u64);
    bridge::files(deps, b, content_type, len, &mut Chunks::of(bytes)).await
}

/// A file store that records the lifetime of each download address it is asked to sign, and
/// fails to sign one while `broken` is set.
#[derive(Default)]
struct Signing {
    inner: MemoryFiles,
    asked: Mutex<Vec<(FileId, OffsetDateTime)>>,
    broken: std::sync::atomic::AtomicBool,
}

impl Signing {
    fn asked(&self) -> Vec<(FileId, OffsetDateTime)> {
        self.asked.lock().unwrap().clone()
    }
}

#[async_trait]
impl FileStore for Signing {
    async fn probe(&self) -> Result<(), AppError> {
        self.inner.probe().await
    }
    async fn put(
        &self,
        ws: WorkspaceId,
        id: FileId,
        upload: MediaUpload,
    ) -> Result<StoredFile, AppError> {
        self.inner.put(ws, id, upload).await
    }
    async fn read(&self, ws: WorkspaceId, id: FileId) -> Result<MediaUpload, AppError> {
        self.inner.read(ws, id).await
    }
    async fn provider_url(
        &self,
        ws: WorkspaceId,
        id: FileId,
        expires_at: OffsetDateTime,
    ) -> Result<url::Url, AppError> {
        self.asked.lock().unwrap().push((id, expires_at));
        if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AppError::internal("the store cannot sign now"));
        }
        self.inner.provider_url(ws, id, expires_at).await
    }
    async fn delete(&self, ws: WorkspaceId, id: FileId) -> Result<(), AppError> {
        self.inner.delete(ws, id).await
    }
}

/// Asserts `FORBIDDEN` with `details.reason = "bridge_key_only"`.
fn assert_bridge_key_only(e: &AppError) {
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    assert_eq!(e.details, json!({ "reason": "bridge_key_only" }), "{e:?}");
}

#[tokio::test]
async fn register_declares_phones_and_merges_facts() {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w, "phones").await;
    let out = register(&w, &key, FIXED_NOW, vec![phone("SER1"), phone("SER2")]).await;
    assert_eq!((out.heartbeat_s, out.max_wait_s, out.protocol), (15, 25, 1));
    assert!(out.refused.is_empty());
    let serials: Vec<&str> = out.phones.iter().map(|p| p.serial.as_str()).collect();
    assert_eq!(serials, ["SER1", "SER2"]);
    let (one, two) = (cap(&out, 0), cap(&out, 1));

    // Each phone is a `phone` capability, reached as a device, verified by the heartbeat, with
    // what the bridge reported of it and of itself.
    let c = stored(&w, one).await;
    assert_eq!(
        (
            c.kind_key.as_str(),
            c.external_id.as_deref(),
            c.name.as_str()
        ),
        ("phone", Some("android:SER1"), "Redmi 10C (SER1)")
    );
    assert_eq!(c.reach, Reach::Device);
    assert_eq!(c.status, StoredStatus::Verified);
    assert_eq!(c.last_verified_at, Some(FIXED_NOW));
    let bridge = key.api_key_id.to_string();
    let expected = json!({
        "platform": "android",
        "serial": "SER1",
        "model": "Redmi 10C",
        "os_version": "13",
        "screen": { "w": 720, "h": 1650, "rotation": 0 },
        "features": every_feature(),
        "bridge_id": "PC-1",
        "version": "0.1.0",
        "protocol": 1,
        "listed_by": bridge,
        "listed": true,
    });
    assert_eq!(c.connector_public["device"], expected);

    // Declared as `capability.declare` would, and came online, by the bridge.
    assert_eq!(w.entries("capability.declare").len(), 2);
    let online = w.entries("devices.bridge.online");
    assert_eq!(online.len(), 2);
    assert_eq!(
        online[0].payload,
        json!({
            "capability_id": one,
            "external_id": "android:SER1",
            "bridge_id": "PC-1",
            "version": "0.1.0",
            "declared": true,
        })
    );
    assert_eq!(
        online[0].actor,
        Actor::System {
            component: "device_bridge".into()
        }
    );

    // The next heartbeat merges, never replaces: a model it cannot read is kept, what it reports
    // changes, a list of features is the new one. The phone is not declared again and, verified
    // already, does not come online again.
    let again = register(
        &w,
        &key,
        later(15),
        vec![PhoneReport {
            model: None,
            os_version: Some("14".into()),
            screen: None,
            features: vec!["tap".into()],
            ..phone("SER1")
        }],
    )
    .await;
    assert_eq!(cap(&again, 0), one);
    let c = stored(&w, one).await;
    let device = &c.connector_public["device"];
    assert_eq!(device["model"], "Redmi 10C");
    assert_eq!(device["os_version"], "14");
    assert_eq!(
        device["screen"],
        json!({ "w": 720, "h": 1650, "rotation": 0 })
    );
    assert_eq!(device["features"], json!(["tap"]));
    assert_eq!(device["listed_by"], json!(bridge));
    assert_eq!(c.last_verified_at, Some(later(15)));
    assert_eq!(w.entries("capability.declare").len(), 2);
    assert_eq!(w.entries("devices.bridge.online").len(), 2);

    // SER2, which this registration leaves out, reads as left out; its facts are otherwise kept.
    let c = stored(&w, two).await;
    assert_eq!(c.connector_public["device"]["listed"], false);
    assert_eq!(c.connector_public["device"]["model"], "Redmi 10C");
    assert_eq!(c.last_verified_at, Some(FIXED_NOW));
}

#[tokio::test]
async fn register_lists_retired_phone_as_refused() {
    let (w, key, p) = rig().await;
    capabilities::retire(&w.deps, &w.owner_ctx, p, true)
        .await
        .unwrap();
    let retired = stored(&w, p).await;

    // Still plugged in, the retired phone is refused for good; the bridge's other phone registers
    // as usual. Nothing is declared or merged for the retired one.
    for now in [later(15), later(30)] {
        let out = register(&w, &key, now, vec![phone("SER1"), phone("SER2")]).await;
        assert_eq!(
            out.refused,
            [RefusedPhone {
                platform: Platform::Android,
                serial: "SER1".into(),
                reason: PHONE_RETIRED.into(),
            }]
        );
        let serials: Vec<&str> = out.phones.iter().map(|p| p.serial.as_str()).collect();
        assert_eq!(serials, ["SER2"]);
        assert_eq!(stored(&w, p).await, retired);
    }
    assert_eq!(w.entries("capability.declare").len(), 2);
}

#[tokio::test]
async fn register_refuses_one_bad_phone_not_the_heartbeat() {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w, "phones").await;
    let flat = PhoneReport {
        screen: Some(Screen {
            w: 0,
            h: 1650,
            rotation: 0,
        }),
        ..phone("SER2")
    };
    let out = register(
        &w,
        &key,
        FIXED_NOW,
        vec![phone("SER1"), flat, phone("SER\t3")],
    )
    .await;
    let serials: Vec<&str> = out.phones.iter().map(|p| p.serial.as_str()).collect();
    assert_eq!(serials, ["SER1"]);
    assert_eq!(
        out.refused,
        [
            RefusedPhone {
                platform: Platform::Android,
                serial: "SER2".into(),
                reason: "screen: has a side outside 1 to 20000 pixels".into(),
            },
            RefusedPhone {
                platform: Platform::Android,
                serial: "SER\t3".into(),
                reason: "serial: must not contain control characters".into(),
            },
        ]
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let phones = jt_app::usecases::bridges::kernel::of_kind(r.as_mut(), devices::PHONE_KIND)
        .await
        .unwrap();
    drop(r);
    assert_eq!(phones.len(), 1);

    // The body's own faults refuse the registration, naming the field.
    let many = register_in((0..17).map(|i| phone(&format!("S{i}"))).collect());
    let e = err(bridge::register(&w.deps, &bridge_at(&key, FIXED_NOW), many).await);
    assert_invalid(&e, "phones");
    let old = RegisterIn {
        protocol: 0,
        ..register_in(vec![phone("SER1")])
    };
    let e = err(bridge::register(&w.deps, &bridge_at(&key, FIXED_NOW), old).await);
    assert_invalid(&e, "protocol");
}

#[tokio::test]
async fn bridge_key_only() {
    let (mut w, key, _) = rig().await;
    w.deps.files = Arc::new(MemoryFiles::default());
    let agent = key_in(&w, &w.owner_ctx, "agent", &[]).await;
    let voice = key_in(&w, &w.owner_ctx, "voice", &["calls.bridge"]).await;
    // A person, an agent whose key holds every permission, and the voice bridge's key.
    let callers = [
        (
            BridgeCaller {
                ctx: w.owner_ctx.clone(),
                bridge: key.api_key_id,
            },
            None,
        ),
        (bridge_at(&agent, FIXED_NOW), None),
        (bridge_at(&voice, FIXED_NOW), Some("devices.bridge")),
    ];
    for (caller, permission) in callers {
        let errors = [
            err(bridge::register(&w.deps, &caller, register_in(vec![phone("SER9")])).await),
            err(bridge::commands(
                &w.deps,
                &caller,
                CommandsQuery {
                    wait_s: 0,
                    limit: 1,
                },
            )
            .await),
            err(bridge::results(
                &w.deps,
                &caller,
                ResultsIn {
                    results: vec![done(Uuid::now_v7())],
                },
            )
            .await),
            err(upload_as(&w.deps, &caller, Some("image/png"), PNG).await),
        ];
        for e in &errors {
            match permission {
                Some(permission) => assert_forbidden(e, permission),
                None => assert_bridge_key_only(e),
            }
        }
    }
    // Nothing was registered by any of them.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let phones = jt_app::usecases::bridges::kernel::of_kind(r.as_mut(), devices::PHONE_KIND)
        .await
        .unwrap();
    assert_eq!(phones.len(), 1);
}

#[tokio::test]
async fn commands_long_poll_wakes_on_enqueue() {
    let (w, key, p) = rig().await;
    // Nothing queued: a poll that does not wait answers at once, with nothing.
    let started = Instant::now();
    assert!(poll(&w, &key, FIXED_NOW, 20).await.is_empty());
    assert!(started.elapsed() < StdDuration::from_millis(500));

    // A command queued while the bridge waits is handed out at once, long before the wait ends.
    let deps = w.deps.clone();
    let waiting_as = bridge_at(&key, FIXED_NOW);
    let started = Instant::now();
    let waiting = tokio::spawn(async move {
        bridge::commands(
            &deps,
            &waiting_as,
            CommandsQuery {
                wait_s: 5,
                limit: 20,
            },
        )
        .await
    });
    tokio::time::sleep(StdDuration::from_millis(300)).await;
    let id = enqueue(&w, p, tap(), expires()).await;
    let out = waiting.await.unwrap().unwrap();
    let took = started.elapsed();
    // Woken by the signal: without it the next read is a fallback tick (a second) after the first.
    assert!(took < StdDuration::from_millis(900), "{took:?}");
    assert_eq!(
        out.commands,
        [LeasedCommand {
            id,
            capability_id: p.as_uuid(),
            serial: "SER1".into(),
            command: tap(),
            expires_at: expires(),
            download_url: None,
        }]
    );
    let leased = row(&w, id).await;
    assert_eq!((leased.status, leased.attempts), (CommandStatus::Leased, 1));

    // A wait over 25 seconds is cut to 25 and a limit over 20 to 20, not refused; with commands
    // due, the poll answers at once.
    for _ in 0..25 {
        enqueue(&w, p, tap(), expires()).await;
    }
    let started = Instant::now();
    let out = bridge::commands(
        &w.deps,
        &bridge_at(&key, FIXED_NOW),
        CommandsQuery {
            wait_s: 600,
            limit: 500,
        },
    )
    .await
    .unwrap();
    assert_eq!(out.commands.len(), 20);
    assert!(started.elapsed() < StdDuration::from_secs(1));
    // A limit of 0 hands out one.
    assert_eq!(poll(&w, &key, FIXED_NOW, 0).await.len(), 1);
}

#[tokio::test]
async fn redelivered_after_10s() {
    let (w, key, p) = rig().await;
    let id = enqueue(&w, p, tap(), expires()).await;
    assert_eq!(ids(&poll(&w, &key, FIXED_NOW, 20).await), [id]);
    // Leased: not handed out again while its lease runs.
    assert!(poll(&w, &key, later(5), 20).await.is_empty());
    assert!(poll(&w, &key, later(9), 20).await.is_empty());
    // Not answered within ten seconds: handed out again, the same command, a second attempt.
    assert_eq!(ids(&poll(&w, &key, later(11), 20).await), [id]);
    let leased = row(&w, id).await;
    assert_eq!((leased.status, leased.attempts), (CommandStatus::Leased, 2));
    assert!(read_at(leased.leased_at.unwrap(), later(11)), "{leased:?}");
    // Answered: never again.
    assert_eq!(
        post(&w, &key, later(12), vec![done(id)]).await.unwrap(),
        counted(1, 0, 0)
    );
    assert!(poll(&w, &key, later(30), 20).await.is_empty());
}

#[tokio::test]
async fn expired_command_not_leased() {
    let (w, key, p) = rig().await;
    let stale = enqueue(&w, p, tap(), later(5)).await;
    // Past its expiry it is never handed out; ending it is the expiry sweep's.
    assert!(poll(&w, &key, later(6), 20).await.is_empty());
    assert_eq!(row(&w, stale).await.status, CommandStatus::Queued);
    // Nor is a lease that ran out after the command expired renewed.
    let id = enqueue(&w, p, tap(), later(15)).await;
    assert_eq!(ids(&poll(&w, &key, later(6), 20).await), [id]);
    assert!(poll(&w, &key, later(20), 20).await.is_empty());
    assert_eq!(row(&w, id).await.attempts, 1);
}

#[tokio::test]
async fn results_idempotent_and_ledgered() {
    let (w, key, p) = rig().await;
    let (getprop, touch) = (
        enqueue(&w, p, shell(), expires()).await,
        enqueue(&w, p, tap(), expires()).await,
    );
    poll(&w, &key, FIXED_NOW, 20).await;
    let batch = vec![
        ResultIn {
            command_id: getprop,
            outcome: Outcome::Done {
                result: CommandResult::shell(0, b"Redmi 10C\n", b""),
            },
            duration_ms: 120,
        },
        ResultIn {
            command_id: touch,
            outcome: Outcome::failed(FailReason::AdbError, "adb: device offline"),
            duration_ms: 30,
        },
    ];
    assert_eq!(
        post(&w, &key, later(2), batch.clone()).await.unwrap(),
        counted(2, 0, 0)
    );
    // The result is kept on the command, the failure's reason and detail on its own.
    let shelled = row(&w, getprop).await;
    assert_eq!(
        (shelled.status, shelled.done_at),
        (CommandStatus::Done, Some(later(2)))
    );
    assert_eq!(
        shelled.result,
        Some(json!({
            "kind": "shell", "exit_code": 0, "stdout": "Redmi 10C\n", "stderr": "", "truncated": false,
        }))
    );
    let tapped = row(&w, touch).await;
    assert_eq!(
        (tapped.status, tapped.reason, tapped.detail.as_deref()),
        (
            CommandStatus::Failed,
            Some(FailReason::AdbError),
            Some("adb: device offline")
        )
    );
    // Each is ledgered once, by the bridge: what ended and how, never the output.
    assert_eq!(
        finished(&w),
        [
            json!({ "command_id": getprop, "kind": "shell", "status": "done", "reason": null, "duration_ms": 120, "leased_by": key.api_key_id.to_string(), "result_sha256": hash_of(&CommandResult::shell(0, b"Redmi 10C
", b"")) }),
            json!({ "command_id": touch, "kind": "tap", "status": "failed", "reason": "adb_error", "duration_ms": 30, "leased_by": key.api_key_id.to_string(), "result_sha256": null }),
        ]
    );
    let entries = w.entries("devices.command.finished");
    assert_eq!(
        entries[0].actor,
        Actor::System {
            component: "device_bridge".into()
        }
    );
    assert_eq!(
        entries[0].subject,
        Some(Subject {
            kind: "device_command".into(),
            id: getprop.to_string(),
        })
    );
    assert_eq!(entries[0].at, later(2));

    // Posted again (a retry), with a command nobody queued: nothing changes, nothing is written.
    let mut retry = batch;
    retry.push(done(Uuid::now_v7()));
    assert_eq!(
        post(&w, &key, later(3), retry).await.unwrap(),
        counted(0, 2, 1)
    );
    assert_eq!(row(&w, getprop).await, shelled);
    assert_eq!(row(&w, touch).await, tapped);
    assert_eq!(finished(&w).len(), 2);
}

#[tokio::test]
async fn late_result_after_expiry_is_applied_and_ledgered_again() {
    let (w, key, p) = rig().await;
    let id = enqueue(&w, p, tap(), later(5)).await;
    assert_eq!(ids(&poll(&w, &key, later(1), 20).await), [id]);
    // The expiry sweep ends it while the bridge works on it (D1-T7's job ledgers that ending).
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.device_commands()
        .expire_due(later(6), MAX_DEVICE_COMMAND_PAGE)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(row(&w, id).await.status, CommandStatus::Expired);

    // The bridge's result arrives late: it ran, so it replaces the expiry, and is ledgered with
    // what it says.
    assert_eq!(
        post(&w, &key, later(7), vec![done(id)]).await.unwrap(),
        counted(1, 0, 0)
    );
    let late = row(&w, id).await;
    assert_eq!(
        (late.status, late.done_at),
        (CommandStatus::Done, Some(later(7)))
    );
    assert_eq!(
        finished(&w),
        [
            json!({ "command_id": id, "kind": "tap", "status": "done", "reason": null, "duration_ms": 42, "leased_by": key.api_key_id.to_string(), "result_sha256": hash_of(&CommandResult::Done {}) })
        ]
    );
    // Once.
    assert_eq!(
        post(&w, &key, later(8), vec![done(id)]).await.unwrap(),
        counted(0, 1, 0)
    );
    assert_eq!(finished(&w).len(), 1);
}

#[tokio::test]
async fn push_file_gets_signed_download_url() {
    let (mut w, key, p) = rig().await;
    let store = Arc::new(Signing::default());
    w.deps.files = store.clone();
    let file = upload_as(
        &w.deps,
        &bridge_at(&key, FIXED_NOW),
        Some("application/octet-stream"),
        b"payload",
    )
    .await
    .unwrap()
    .file_id;
    let missing = Uuid::now_v7();
    let lost = enqueue(
        &w,
        p,
        DeviceCommand::PushFile {
            file_id: missing,
            dest: "/sdcard/Download/gone.bin".into(),
        },
        expires(),
    )
    .await;
    let push = enqueue(
        &w,
        p,
        DeviceCommand::PushFile {
            file_id: file,
            dest: "/sdcard/Download/payload.bin".into(),
        },
        expires(),
    )
    .await;

    // The command carries an absolute https address, signed for ten minutes from the lease.
    let out = poll(&w, &key, later(2), 20).await;
    assert_eq!(ids(&out), [push]);
    let url = out[0].download_url.as_deref().unwrap();
    assert!(url.starts_with("https://"), "{url}");
    let asked = store.asked();
    let signed: Vec<FileId> = asked.iter().map(|(id, _)| *id).collect();
    assert_eq!(signed, [FileId(missing), FileId(file)]);
    for (_, expires_at) in &asked {
        assert!(
            read_at(*expires_at, later(2) + Duration::minutes(10)),
            "{asked:?}"
        );
    }
    // One whose file is not stored is failed instead of handed out, and ledgered.
    let failed = row(&w, lost).await;
    assert_eq!(
        (failed.status, failed.reason, failed.detail.as_deref()),
        (
            CommandStatus::Failed,
            Some(FailReason::FileNotFound),
            Some("the file to push is not stored: it was removed, or never uploaded")
        )
    );
    assert_eq!(
        finished(&w),
        [
            json!({ "command_id": lost, "kind": "push_file", "status": "failed", "reason": "file_not_found", "duration_ms": null, "leased_by": key.api_key_id.to_string(), "result_sha256": null })
        ]
    );
    // While the store cannot sign, the command is not handed out, and stays leased: its lease
    // runs out and it is handed out again once it can.
    store
        .broken
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(poll(&w, &key, later(13), 20).await.is_empty());
    assert_eq!(row(&w, push).await.status, CommandStatus::Leased);
    assert_eq!(finished(&w).len(), 1);
    store
        .broken
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let again = poll(&w, &key, later(13), 20).await;
    assert!(again.is_empty(), "its new lease runs: {again:?}");
    // Handed out again, it is signed again, from the new lease.
    let again = poll(&w, &key, later(24), 20).await;
    assert_eq!(ids(&again), [push]);
    assert!(again[0].download_url.is_some());
    let (id, expires_at) = *store.asked().last().unwrap();
    assert_eq!(id, FileId(file));
    assert!(read_at(expires_at, later(24) + Duration::minutes(10)));
}

#[tokio::test]
async fn files_upload_returns_id() {
    let (mut w, key, _) = rig().await;
    let store = Arc::new(MemoryFiles::default());
    w.deps.files = store.clone();
    let b = bridge_at(&key, FIXED_NOW);
    let upload = |content_type: Option<&'static str>, bytes: &[u8]| {
        let (deps, b, bytes) = (w.deps.clone(), b.clone(), bytes.to_vec());
        async move { upload_as(&deps, &b, content_type, &bytes).await }
    };
    let png = upload(Some("image/png"), PNG).await.unwrap().file_id;
    let pulled = upload(Some("application/octet-stream"), b"\x00any bytes")
        .await
        .unwrap()
        .file_id;
    let empty = upload(Some("Application/Octet-Stream; charset=binary"), b"")
        .await
        .unwrap()
        .file_id;
    // A retried upload is a new file.
    let again = upload(Some("image/png"), PNG).await.unwrap().file_id;
    assert_ne!(again, png);

    // Each is the workspace's device file, kept seven days, its bytes in the store.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let files = r
        .device_commands()
        .files(&[png, pulled, empty])
        .await
        .unwrap();
    drop(r);
    assert_eq!(files.len(), 3);
    let shot = files.iter().find(|f| f.id == png).unwrap();
    assert_eq!(
        (
            shot.mime.as_str(),
            shot.size_bytes,
            shot.created_at,
            shot.expires_at
        ),
        (
            "image/png",
            PNG.len() as u64,
            FIXED_NOW,
            FIXED_NOW + Duration::days(7)
        )
    );
    let kept = files.iter().find(|f| f.id == empty).unwrap();
    assert_eq!(
        (kept.mime.as_str(), kept.size_bytes),
        ("application/octet-stream", 0)
    );
    assert_eq!(
        store.read(w.ws, FileId(pulled)).await.unwrap().bytes,
        b"\x00any bytes"
    );

    // Another type, none, or a PNG that is not one, is refused.
    for content_type in [Some("application/json"), Some("image/jpeg"), None] {
        assert_invalid(&err(upload(content_type, PNG).await), "content_type");
    }
    assert_invalid(&err(upload(Some("image/png"), b"not a png").await), "body");
}

/// A file maintenance that offers every stored file of a workspace as an orphan, however young.
struct EveryFile(Arc<MemoryFiles>);

#[async_trait]
impl FileMaintenance for EveryFile {
    async fn orphan_candidates(
        &self,
        ws: WorkspaceId,
        _older_than: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError> {
        Ok(self
            .0
            .files
            .lock()
            .unwrap()
            .keys()
            .filter(|(of, _)| *of == ws)
            .map(|(_, id)| *id)
            .collect())
    }
}

#[tokio::test]
async fn studio_cleanup_keeps_device_files() {
    let (mut w, key, _) = rig().await;
    let store = Arc::new(MemoryFiles::default());
    w.deps.files = store.clone();
    w.deps.file_maintenance = Arc::new(EveryFile(store.clone()));
    let kept = upload_as(&w.deps, &bridge_at(&key, FIXED_NOW), Some("image/png"), PNG)
        .await
        .unwrap()
        .file_id;
    // A stored file nothing records is an orphan.
    let stray = FileId::new_v7();
    store
        .put(
            w.ws,
            stray,
            MediaUpload {
                bytes: PNG.to_vec(),
                mime: "image/png".into(),
                filename: "stray.png".into(),
            },
        )
        .await
        .unwrap();
    jt_app::usecases::studio::files::cleanup_files(&w.deps, w.ws)
        .await
        .unwrap();
    assert!(store.read(w.ws, FileId(kept)).await.is_ok());
    assert!(store.read(w.ws, stray).await.is_err());
}

#[tokio::test]
async fn commands_rechecks_supports_at_lease_time() {
    let (w, key, p) = rig().await;
    let getprop = enqueue(&w, p, shell(), expires()).await;
    let unicode = enqueue(
        &w,
        p,
        DeviceCommand::Text {
            value: "Ayşe".into(),
        },
        expires(),
    )
    .await;
    let ascii = enqueue(
        &w,
        p,
        DeviceCommand::Text {
            value: "merhaba".into(),
        },
        expires(),
    )
    .await;
    let touch = enqueue(&w, p, tap(), expires()).await;
    // The bridge registers again without `shell` and without Unicode text.
    register(
        &w,
        &key,
        later(1),
        vec![PhoneReport {
            features: vec!["tap".into(), "text".into()],
            ..phone("SER1")
        }],
    )
    .await;

    // What it lists now is leased; what it does not is failed, never leased.
    assert_eq!(ids(&poll(&w, &key, later(2), 20).await), [ascii, touch]);
    for (id, missing) in [(getprop, "shell"), (unicode, "text.unicode")] {
        let refused = row(&w, id).await;
        assert_eq!(
            (
                refused.status,
                refused.reason,
                refused.leased_at,
                refused.attempts
            ),
            (
                CommandStatus::Failed,
                Some(FailReason::UnsupportedByBridge),
                None,
                0
            )
        );
        assert!(read_at(refused.done_at.unwrap(), later(2)), "{refused:?}");
        assert_eq!(
            refused.detail,
            Some(format!("the phone's bridge does not list `{missing}`"))
        );
    }
    assert_eq!(
        finished(&w),
        [
            json!({ "command_id": getprop, "kind": "shell", "status": "failed", "reason": "unsupported_by_bridge", "duration_ms": null, "leased_by": null, "result_sha256": null }),
            json!({ "command_id": unicode, "kind": "text", "status": "failed", "reason": "unsupported_by_bridge", "duration_ms": null, "leased_by": null, "result_sha256": null }),
        ]
    );
}

#[tokio::test]
async fn a_read_that_fails_all_it_picked_reads_again() {
    let (w, key, p) = rig().await;
    register(
        &w,
        &key,
        later(1),
        vec![PhoneReport {
            features: vec!["tap".into()],
            ..phone("SER1")
        }],
    )
    .await;
    let shells = [
        enqueue(&w, p, shell(), expires()).await,
        enqueue(&w, p, shell(), expires()).await,
    ];
    let touch = enqueue(&w, p, tap(), expires()).await;
    // One command a read: the first two reads fail what they pick, and a poll that does not wait
    // reads on at once rather than answer nothing.
    assert_eq!(ids(&poll(&w, &key, later(2), 1).await), [touch]);
    for id in shells {
        assert_eq!(row(&w, id).await.status, CommandStatus::Failed);
    }
}

#[tokio::test]
async fn leases_follow_the_latest_register() {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w, "phones").await;
    let out = register(&w, &key, FIXED_NOW, vec![phone("SER1"), phone("SER2")]).await;
    let (one, two) = (cap(&out, 0), cap(&out, 1));
    let first = enqueue(&w, one, tap(), expires()).await;
    let second = enqueue(&w, two, tap(), expires()).await;

    // The bridge leaves SER2 out (its worker is stuck, say): from the next poll on SER2 is leased
    // nothing.
    register(&w, &key, later(15), vec![phone("SER1")]).await;
    assert_eq!(
        stored(&w, one).await.connector_public["device"]["listed"],
        true
    );
    assert_eq!(
        stored(&w, two).await.connector_public["device"]["listed"],
        false
    );
    assert_eq!(ids(&poll(&w, &key, later(16), 20).await), [first]);
    assert_eq!(row(&w, second).await.status, CommandStatus::Queued);
    post(&w, &key, later(17), vec![done(first)]).await.unwrap();

    // Listed again, it is leased again.
    register(&w, &key, later(30), vec![phone("SER1"), phone("SER2")]).await;
    assert_eq!(
        stored(&w, two).await.connector_public["device"]["listed"],
        true
    );
    assert_eq!(ids(&poll(&w, &key, later(31), 20).await), [second]);
}

#[tokio::test]
async fn a_late_result_from_a_phone_the_bridge_left_out_is_applied() {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w, "phones").await;
    let out = register(&w, &key, FIXED_NOW, vec![phone("SER1"), phone("SER2")]).await;
    let id = enqueue(&w, cap(&out, 1), tap(), expires()).await;
    assert_eq!(ids(&poll(&w, &key, later(1), 20).await), [id]);
    register(&w, &key, later(15), vec![phone("SER1")]).await;
    // The command ran: the bridge's result for it counts, though the phone is left out now.
    assert_eq!(
        post(&w, &key, later(16), vec![done(id)]).await.unwrap(),
        counted(1, 0, 0)
    );
    assert_eq!(row(&w, id).await.status, CommandStatus::Done);
}

#[tokio::test]
async fn result_for_another_bridges_command_is_unknown() {
    let (w, ours, _) = rig().await;
    let theirs = bridge_key(&w, "other phones").await;
    let out = register(&w, &theirs, FIXED_NOW, vec![phone("SER2")]).await;
    let id = enqueue(&w, cap(&out, 0), tap(), expires()).await;
    // A bridge never leases another bridge's phone.
    assert!(poll(&w, &ours, later(1), 20).await.is_empty());
    assert_eq!(ids(&poll(&w, &theirs, later(1), 20).await), [id]);

    // Its result for the other bridge's command is unknown, and changes nothing.
    let before = row(&w, id).await;
    assert_eq!(
        post(&w, &ours, later(2), vec![done(id)]).await.unwrap(),
        counted(0, 0, 1)
    );
    assert_eq!(row(&w, id).await, before);
    assert!(finished(&w).is_empty());
    // The bridge whose command it is applies it.
    assert_eq!(
        post(&w, &theirs, later(3), vec![done(id)]).await.unwrap(),
        counted(1, 0, 0)
    );
}

#[tokio::test]
async fn result_with_a_foreign_file_id_is_refused() {
    let (mut w, key, p) = rig().await;
    w.deps.files = Arc::new(MemoryFiles::default());
    let (_, beta_owner) = w.other_workspace().await;
    let beta = key_in(&w, &beta_owner, "beta phones", &["devices.bridge"]).await;
    let upload = |key: AgentPrincipal| {
        let deps = w.deps.clone();
        async move {
            upload_as(&deps, &bridge_at(&key, FIXED_NOW), Some("image/png"), PNG)
                .await
                .unwrap()
                .file_id
        }
    };
    let (ours, foreign) = (upload(key.clone()).await, upload(beta).await);
    let shot = enqueue(&w, p, DeviceCommand::Screenshot {}, expires()).await;
    let look = enqueue(
        &w,
        p,
        DeviceCommand::Observe { screenshot: true },
        expires(),
    )
    .await;
    let touch = enqueue(&w, p, tap(), expires()).await;
    poll(&w, &key, later(1), 20).await;
    let file = |file_id| done_with(shot, CommandResult::File { file_id });
    let seen = |screenshot_file_id| {
        done_with(
            look,
            CommandResult::Observation(Observation {
                screen: Screen {
                    w: 720,
                    h: 1650,
                    rotation: 0,
                },
                foreground_app: Some("com.android.launcher3".into()),
                elements: Vec::new(),
                truncated: false,
                screenshot_file_id: Some(screenshot_file_id),
            }),
        )
    };

    // Another bridge of the workspace uploads a file too.
    let other = bridge_key(&w, "other phones").await;
    let neighbour = upload(other).await;

    // Another workspace's file, another bridge's, or one nobody uploaded, refuses the whole batch,
    // naming the field.
    for named in [foreign, neighbour, Uuid::now_v7()] {
        let e = err(post(&w, &key, later(2), vec![done(touch), file(named)]).await);
        assert_invalid(&e, "file_id");
        let e = err(post(&w, &key, later(2), vec![done(touch), seen(named)]).await);
        assert_invalid(&e, "screenshot_file_id");
    }
    for id in [shot, look, touch] {
        assert_eq!(row(&w, id).await.status, CommandStatus::Leased);
    }
    assert!(finished(&w).is_empty());

    // The workspace's own device files are taken.
    assert_eq!(
        post(&w, &key, later(3), vec![file(ours), seen(ours)])
            .await
            .unwrap(),
        counted(2, 0, 0)
    );
    assert_eq!(
        row(&w, shot).await.result,
        Some(json!({ "kind": "file", "file_id": ours }))
    );
}

#[tokio::test]
async fn invalid_results_body_is_422() {
    let (w, key, p) = rig().await;
    let id = enqueue(&w, p, tap(), expires()).await;
    poll(&w, &key, later(1), 20).await;
    let over_long = ResultIn {
        command_id: id,
        outcome: Outcome::Failed {
            reason: FailReason::AdbError,
            detail: "x".repeat(301),
        },
        duration_ms: 1,
    };
    let cases = [
        (Vec::new(), "results"),
        ((0..101).map(|_| done(Uuid::now_v7())).collect(), "results"),
        (vec![done(id), done(id)], "command_id"),
        (vec![over_long], "detail"),
    ];
    // Refused whole (`VALIDATION`, the panel's 422), naming the field `ProtocolError::field`
    // names, and nothing is applied.
    for (results, field) in cases {
        let e = err(post(&w, &key, later(2), results).await);
        assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
        assert_eq!(e.details, json!({ "field": field }), "{e:?}");
    }
    assert_eq!(row(&w, id).await.status, CommandStatus::Leased);
    assert!(finished(&w).is_empty());
}

#[tokio::test]
async fn nobody_but_the_bridge_writes_a_phones_bridge_facts() {
    let (w, key, _) = rig().await;
    // A person or an agent declaring a phone that names a bridge, as if one held it, is refused:
    // `connector_public.device` is the bridge's own.
    let agent = w.agent(&[]).await;
    for ctx in [&w.owner_ctx, &agent] {
        let e = err(capabilities::declare(
            &w.deps,
            ctx,
            DeclareInput {
                kind_key: "phone".into(),
                name: "Telefon".into(),
                external_id: Some("android:SER7".into()),
                connector_public: json!({ "device": {
                    "listed_by": key.api_key_id.to_string(),
                    "listed": true,
                    "features": ["shell"],
                } }),
                ..DeclareInput::default()
            },
        )
        .await);
        assert_eq!(gap_fields(&e), ["connector_public.device"]);
    }
}

/// A file store whose stream path reads its source to the end and keeps nothing: a large upload
/// costs no memory.
struct Draining;

#[async_trait]
impl FileStore for Draining {
    async fn probe(&self) -> Result<(), AppError> {
        Ok(())
    }
    async fn put(&self, _: WorkspaceId, _: FileId, _: MediaUpload) -> Result<StoredFile, AppError> {
        Err(AppError::internal("not in this test"))
    }
    async fn read(&self, _: WorkspaceId, _: FileId) -> Result<MediaUpload, AppError> {
        Err(AppError::not_found("file"))
    }
    async fn put_stream(
        &self,
        _: WorkspaceId,
        _: FileId,
        _: &str,
        _: &str,
        source: &mut dyn ByteSource,
    ) -> Result<StoredFile, AppError> {
        while source.next_chunk().await?.is_some() {}
        Err(AppError::internal("kept nothing"))
    }
    async fn provider_url(
        &self,
        _: WorkspaceId,
        _: FileId,
        _: OffsetDateTime,
    ) -> Result<url::Url, AppError> {
        Err(AppError::not_found("file"))
    }
    async fn delete(&self, _: WorkspaceId, _: FileId) -> Result<(), AppError> {
        Ok(())
    }
}

/// `head`, then zeros, `len` bytes in all, a mebibyte at a time.
struct Zeros {
    head: Vec<u8>,
    left: u64,
}

#[async_trait]
impl ByteSource for Zeros {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        if self.left == 0 {
            return Ok(None);
        }
        let n = self.left.min(1 << 20);
        self.left -= n;
        let mut chunk = std::mem::take(&mut self.head);
        chunk.resize(usize::try_from(n).unwrap().max(chunk.len()), 0);
        Ok(Some(chunk))
    }
}

/// A source that must not be read.
struct Untouched;

#[async_trait]
impl ByteSource for Untouched {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        panic!("the body was read")
    }
}

#[tokio::test]
async fn an_upload_over_its_limit_is_refused() {
    let (mut w, key, _) = rig().await;
    w.deps.files = Arc::new(Draining);
    let b = bridge_at(&key, FIXED_NOW);
    // An announced length over the type's limit is refused before the body is read.
    for (content_type, limit) in [
        ("application/octet-stream", DEVICE_FILE_LIMIT),
        ("image/png", IMAGE_LIMIT),
    ] {
        let e = err(bridge::files(
            &w.deps,
            &b,
            Some(content_type),
            Some(limit + 1),
            &mut Untouched,
        )
        .await);
        assert_invalid(&e, "body");
    }
    // A body that grows past it as it is read is refused too, with nothing kept, a chunk in memory
    // at a time.
    for (content_type, head, limit) in [
        ("application/octet-stream", Vec::new(), DEVICE_FILE_LIMIT),
        ("image/png", PNG.to_vec(), IMAGE_LIMIT),
    ] {
        let mut body = Zeros {
            head,
            left: limit + 1,
        };
        let e = err(bridge::files(&w.deps, &b, Some(content_type), None, &mut body).await);
        assert_invalid(&e, "body");
    }
}

/// A source that, read, counts that it was and waits until `go` lets it end.
struct Gated {
    reads: Arc<std::sync::atomic::AtomicUsize>,
    go: Arc<tokio::sync::Semaphore>,
}

#[async_trait]
impl ByteSource for Gated {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = self.go.acquire().await.unwrap();
        Ok(None)
    }
}

/// Upload turns of one turn a pool, waited for a tenth of a second, a body idle for at most `idle`.
fn tight(idle: StdDuration) -> Arc<UploadTurns> {
    Arc::new(UploadTurns::new(UploadLimits {
        screenshot_turns: 1,
        pulled_file_turns: 1,
        turn_wait: StdDuration::from_millis(100),
        chunk_idle: idle,
    }))
}

#[tokio::test]
async fn a_stalled_upload_holds_up_no_other_workspace_nor_a_screenshot() {
    let (mut w, key, _) = rig().await;
    w.deps.files = Arc::new(MemoryFiles::default());
    w.deps.device_uploads = tight(StdDuration::from_secs(60));
    let (_, beta_owner) = w.other_workspace().await;
    let beta = key_in(&w, &beta_owner, "beta phones", &["devices.bridge"]).await;
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let go = Arc::new(tokio::sync::Semaphore::new(0));

    // A pull in workspace A stalls, holding A's one pulled-file turn.
    let stalled = {
        let (deps, b) = (w.deps.clone(), bridge_at(&key, FIXED_NOW));
        let mut body = Gated {
            reads: reads.clone(),
            go: go.clone(),
        };
        tokio::spawn(async move {
            bridge::files(&deps, &b, Some("application/octet-stream"), None, &mut body).await
        })
    };
    let begun = Instant::now();
    while reads.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        assert!(begun.elapsed() < StdDuration::from_secs(5), "not read");
        tokio::time::sleep(StdDuration::from_millis(5)).await;
    }

    // Workspace B's screenshot and pull, and A's own screenshot, are taken at once.
    for (who, content_type, bytes) in [
        (&beta, "image/png", PNG),
        (&beta, "application/octet-stream", &b"pulled"[..]),
        (&key, "image/png", PNG),
    ] {
        let started = Instant::now();
        upload_as(
            &w.deps,
            &bridge_at(who, FIXED_NOW),
            Some(content_type),
            bytes,
        )
        .await
        .unwrap();
        assert!(
            started.elapsed() < StdDuration::from_secs(1),
            "{content_type}"
        );
    }
    // Another pull in A waits a tenth of a second for its turn, then is answered `503`, retryable,
    // its body not read.
    let e = err(bridge::files(
        &w.deps,
        &bridge_at(&key, FIXED_NOW),
        Some("application/octet-stream"),
        None,
        &mut Untouched,
    )
    .await);
    assert_eq!(e.code, ErrorCode::UpstreamUnavailable, "{e:?}");
    assert_eq!(e.details["retryable"], true);
    assert_eq!(e.details["reason"], "upload_turns_taken");

    go.add_permits(1);
    stalled.await.unwrap().unwrap();
    // The turn is free again.
    upload_as(
        &w.deps,
        &bridge_at(&key, FIXED_NOW),
        Some("application/octet-stream"),
        b"next",
    )
    .await
    .unwrap();
}

/// A first chunk, then nothing, ever.
struct Stalls {
    sent: bool,
}

#[async_trait]
impl ByteSource for Stalls {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        if !self.sent {
            self.sent = true;
            return Ok(Some(b"first".to_vec()));
        }
        std::future::pending().await
    }
}

#[tokio::test]
async fn a_body_idle_past_the_timeout_is_refused_and_leaves_no_file() {
    let (mut w, key, _) = rig().await;
    let store = Arc::new(MemoryFiles::default());
    w.deps.files = store.clone();
    w.deps.device_uploads = tight(StdDuration::from_millis(100));
    let b = bridge_at(&key, FIXED_NOW);
    let started = Instant::now();
    let e = err(bridge::files(
        &w.deps,
        &b,
        Some("application/octet-stream"),
        None,
        &mut Stalls { sent: false },
    )
    .await);
    assert_invalid(&e, "body");
    assert!(started.elapsed() < StdDuration::from_secs(2));
    // Nothing is stored or recorded, and the turn is free again.
    assert!(store.files.lock().unwrap().is_empty());
    assert!(w.uow.snapshot().devices.files.is_empty());
    upload_as(&w.deps, &b, Some("application/octet-stream"), b"next")
        .await
        .unwrap();
}

#[tokio::test]
async fn a_phone_that_passes_to_another_bridge_is_ledgered() {
    let (w, first, p) = rig().await;
    let second = bridge_key(&w, "other phones").await;
    // Registering its own phone again, a bridge changes no holder.
    register(&w, &first, later(15), vec![phone("SER1")]).await;
    assert!(w.entries("devices.phone.holder_changed").is_empty());
    // The first leaves it out; the second takes it over.
    register(&w, &first, later(30), vec![]).await;
    let out = register(&w, &second, later(31), vec![phone("SER1")]).await;
    assert_eq!(cap(&out, 0), p);
    let changed = w.entries("devices.phone.holder_changed");
    assert_eq!(changed.len(), 1);
    assert_eq!(
        changed[0].payload,
        json!({
            "capability_id": p,
            "from": first.api_key_id.to_string(),
            "to": second.api_key_id.to_string(),
        })
    );
    assert_eq!(
        changed[0].actor,
        Actor::System {
            component: "device_bridge".into()
        }
    );
}
