//! The phones' scheduled jobs (D1-T7) and what a heartbeat of their own changes: the
//! `device_bridge_health` job marks unreachable a phone no registration listed for ten minutes;
//! `device_command_expiry` ends the commands past their time limit and ledgers each, a late result
//! still replacing the expiry; `device_file_purge` deletes the device files past their seven days,
//! bytes and record, idempotently, the commands kept. A phone is verified by its bridge's
//! registrations only (`capability.verify` refuses it), and an offline phone is pending work of
//! its own, never a voice bridge's.
mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::MediaUpload;
use jt_app::ports::devices::{CommandStatus, DEFAULT_EXPIRES_IN, DeviceCommand, TEXT_UNICODE};
use jt_app::ports::files::{FileStore, StoredFile};
use jt_app::usecases::api_keys::{self, AgentPrincipal, CreateKey};
use jt_app::usecases::capabilities;
use jt_app::usecases::devices::agent::{self, ActInput, WaitQuery};
use jt_app::usecases::devices::bridge::{
    self, BridgeCaller, CommandsQuery, RegisterIn, RegisterOut, ResultsIn, ResultsOut,
};
use jt_app::usecases::jobs::{self, JobReport};
use jt_app::usecases::work::{self, WorkKind};
use jt_capability::{
    Capability, CapabilityId, EffectiveStatus, Evidence, KINDS, NewCapability, StoredStatus,
};
use jt_device_protocol::{
    CommandResult, LeasedCommand, Outcome, PHONE_HELD_BY_ANOTHER_BRIDGE, PhoneReport, Platform,
    ResultIn, Screen,
};
use jt_ledger::Actor;
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::FIXED_NOW;
use jt_testkit::fakes::files::{Chunks, MemoryFiles};
use serde_json::{Value, json};
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// `seconds` after the fixed time.
fn later(seconds: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(seconds)
}

/// `days` after the fixed time.
fn days(days: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::days(days)
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&Rfc3339).unwrap()
}

fn report(touched: u64, changed: u64, skipped: u64, failed: u64) -> JobReport {
    JobReport {
        touched,
        changed,
        skipped,
        failed,
    }
}

/// A bridge's key, named `name`: issued by the owner with `devices.bridge` alone.
async fn bridge_key(w: &World, name: &str) -> AgentPrincipal {
    let key = api_keys::create(
        &w.deps,
        &w.owner_ctx,
        CreateKey {
            name: name.into(),
            scopes: vec!["devices.bridge".into()],
        },
    )
    .await
    .unwrap();
    api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap()
}

/// The bridge of `key` calling at `now`.
fn bridge_at(key: &AgentPrincipal, now: OffsetDateTime) -> BridgeCaller {
    bridge::ctx_for_bridge(key, now)
}

/// An Android phone with serial `serial` whose bridge runs every command, Unicode text included.
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
        features: DeviceCommand::KINDS
            .iter()
            .map(|kind| (*kind).to_owned())
            .chain([TEXT_UNICODE.to_owned()])
            .collect(),
    }
}

/// A registration of `phones` by the bridge of `key` at `now`, which must succeed.
async fn register(
    w: &World,
    key: &AgentPrincipal,
    now: OffsetDateTime,
    phones: Vec<PhoneReport>,
) -> RegisterOut {
    let body = RegisterIn {
        bridge_id: "PC-1".into(),
        version: "0.1.0".into(),
        protocol: 1,
        phones,
    };
    bridge::register(&w.deps, &bridge_at(key, now), body)
        .await
        .unwrap()
}

/// The capability of the `i`-th phone a registration registered.
fn cap(out: &RegisterOut, i: usize) -> CapabilityId {
    CapabilityId(out.phones[i].capability_id)
}

/// An active workspace with a file store, a bridge's key, that bridge registered with phone
/// `SER1` at the fixed time, and an agent holding `devices.work`.
async fn rig() -> (World, AgentPrincipal, CapabilityId, jt_app::ctx::Ctx) {
    let mut w = world().await;
    w.deps.files = Arc::new(MemoryFiles::default());
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w, "phones").await;
    let out = register(&w, &key, FIXED_NOW, vec![phone("SER1")]).await;
    let agent = w.agent(&["devices.work"]).await;
    (w, key, cap(&out, 0), agent)
}

/// `command` queued by the agent at its context's time, without waiting; its id.
async fn act(w: &World, agent: &jt_app::ctx::Ctx, p: CapabilityId, command: DeviceCommand) -> Uuid {
    let input = ActInput {
        command,
        wait_s: Some(0),
    };
    agent::act(&w.deps, agent, p, input)
        .await
        .unwrap()
        .command_id
}

/// A poll by the bridge of `key` at `now` that does not wait.
async fn poll(w: &World, key: &AgentPrincipal, now: OffsetDateTime) -> Vec<LeasedCommand> {
    let query = CommandsQuery {
        wait_s: 0,
        limit: 20,
    };
    bridge::commands(&w.deps, &bridge_at(key, now), query)
        .await
        .unwrap()
        .commands
}

fn ids(commands: &[LeasedCommand]) -> Vec<Uuid> {
    commands.iter().map(|c| c.id).collect()
}

/// The bridge of `key` reports `outcome` for command `id` at `now`.
async fn post(
    w: &World,
    key: &AgentPrincipal,
    now: OffsetDateTime,
    id: Uuid,
    outcome: Outcome,
) -> ResultsOut {
    let results = vec![ResultIn {
        command_id: id,
        outcome,
        duration_ms: 42,
    }];
    bridge::results(&w.deps, &bridge_at(key, now), ResultsIn { results })
        .await
        .unwrap()
}

fn done() -> Outcome {
    Outcome::Done {
        result: CommandResult::Done {},
    }
}

/// The bridge of `key` uploads `bytes` as a pulled file at `now`; its id.
async fn upload(w: &World, key: &AgentPrincipal, now: OffsetDateTime, bytes: &[u8]) -> Uuid {
    let len = Some(bytes.len() as u64);
    let b = bridge_at(key, now);
    bridge::files(
        &w.deps,
        &b,
        Some("application/octet-stream"),
        len,
        &mut Chunks::of(bytes),
    )
    .await
    .unwrap()
    .file_id
}

/// Whether the file store keeps file `id` of the workspace.
async fn kept(w: &World, id: Uuid) -> bool {
    w.deps.files.exists(w.ws, FileId(id)).await.unwrap()
}

/// The ids of the device files among `ids` the workspace records.
async fn recorded(w: &World, ids: &[Uuid]) -> Vec<Uuid> {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let files = r.device_commands().files(ids).await.unwrap();
    files.into_iter().map(|f| f.id).collect()
}

/// Capability `id` as the owner reads it at `now`: its effective status and its last heartbeat.
async fn read(
    w: &World,
    id: CapabilityId,
    now: OffsetDateTime,
) -> (EffectiveStatus, Option<OffsetDateTime>) {
    let out = capabilities::get(&w.deps, &at(&w.owner_ctx, now), id)
        .await
        .unwrap();
    (out.effective_status, out.capability.last_verified_at)
}

/// The items of what is pending for the owner at `now`.
async fn pending(w: &World, now: OffsetDateTime) -> Vec<work::WorkItem> {
    work::pending(&w.deps, &at(&w.owner_ctx, now))
        .await
        .unwrap()
        .items
}

/// The pending items of kind `kind` (its wire name) for the owner at `now`, as the wire has them.
async fn items_of(w: &World, now: OffsetDateTime, kind: &str) -> Vec<Value> {
    serde_json::to_value(pending(w, now).await)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == kind)
        .cloned()
        .collect()
}

/// The payloads of the workspace's `devices.command.finished` entries, oldest first.
fn finished(w: &World) -> Vec<Value> {
    w.entries("devices.command.finished")
        .into_iter()
        .map(|e| e.payload)
        .collect()
}

/// Command `id` as stored.
async fn row(w: &World, id: Uuid) -> jt_app::ports::devices::DeviceCommandRow {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.device_commands().get(id).await.unwrap().unwrap()
}

// ---------------------------------------------------------------------------------------------
// device_bridge_health
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn phone_unreachable_after_10m_without_heartbeat() {
    let (w, key, one, agent) = rig().await;
    let two = cap(
        &register(&w, &key, FIXED_NOW, vec![phone("SER1"), phone("SER2")]).await,
        1,
    );

    // A minute after a registration listed it a phone still reads verified and takes commands; a
    // second more and it is stale, offline, and pending as an offline phone.
    assert_eq!(read(&w, one, later(60)).await.0, EffectiveStatus::Verified);
    act(
        &w,
        &at(&agent, later(60)),
        one,
        DeviceCommand::Tap { x: 1, y: 1 },
    )
    .await;
    assert_eq!(read(&w, one, later(61)).await.0, EffectiveStatus::Stale);
    let e = err(agent::act(
        &w.deps,
        &at(&agent, later(61)),
        one,
        ActInput {
            command: DeviceCommand::Tap { x: 1, y: 1 },
            wait_s: Some(0),
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details, json!({ "reason": "device_offline" }));
    assert_eq!(items_of(&w, later(61), "phone_offline").await.len(), 2);

    // Its bridge goes on registering SER1 alone: SER2, missing from every registration since,
    // goes silent ten minutes after a registration last listed it, however often its bridge
    // registers.
    register(&w, &key, later(9 * 60), vec![phone("SER1")]).await;
    register(&w, &key, later(10 * 60), vec![phone("SER1")]).await;
    assert_eq!(
        jobs::run_device_bridge_health(&w.deps, later(10 * 60)).await,
        JobReport::default()
    );
    assert_eq!(
        read(&w, two, later(10 * 60)).await.0,
        EffectiveStatus::Stale
    );
    let run = jobs::run_device_bridge_health(&w.deps, later(10 * 60 + 1)).await;
    assert_eq!(run, report(1, 1, 0, 0));
    assert_eq!(
        read(&w, two, later(10 * 60 + 1)).await,
        (EffectiveStatus::Unreachable, Some(FIXED_NOW))
    );
    // SER1, listed a second ago, is left alone.
    assert_eq!(
        read(&w, one, later(10 * 60 + 1)).await.0,
        EffectiveStatus::Verified
    );
    let offline = w.entries("devices.bridge.offline");
    assert_eq!(offline.len(), 1);
    assert_eq!(
        offline[0].payload,
        json!({ "capability_id": two, "last_seen_at": rfc3339(FIXED_NOW) })
    );
    assert_eq!(
        offline[0].actor,
        Actor::System {
            component: "scheduler:device_bridge_health".into()
        }
    );
    // Once: an unreachable phone is not marked again; the voice bridges' job never looks at it.
    assert_eq!(
        jobs::run_device_bridge_health(&w.deps, later(11 * 60)).await,
        JobReport::default()
    );
    assert_eq!(
        jobs::run_voice_bridge_health(&w.deps, later(30 * 60)).await,
        JobReport::default()
    );
    assert_eq!(w.entries("devices.bridge.offline").len(), 1);
    let items = items_of(&w, later(11 * 60), "phone_offline").await;
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["capability_id"], json!(two));
    assert_eq!(items[0]["last_seen_at"], json!(rfc3339(FIXED_NOW)));

    // SER1's bridge stops registering altogether: ten minutes after its last registration, it
    // goes the same way.
    let run = jobs::run_device_bridge_health(&w.deps, later(20 * 60 + 1)).await;
    assert_eq!(run, report(1, 1, 0, 0));
    assert_eq!(
        read(&w, one, later(20 * 60 + 1)).await.0,
        EffectiveStatus::Unreachable
    );

    // The next registration that lists a phone brings it back.
    register(&w, &key, later(21 * 60), vec![phone("SER1"), phone("SER2")]).await;
    for p in [one, two] {
        assert_eq!(
            read(&w, p, later(21 * 60)).await.0,
            EffectiveStatus::Verified
        );
    }
    // SER1 and SER2 came online when declared, SER1 again at nine minutes, both now.
    assert_eq!(w.entries("devices.bridge.online").len(), 3 + 2);
    assert!(
        items_of(&w, later(21 * 60), "phone_offline")
            .await
            .is_empty()
    );
    act(
        &w,
        &at(&agent, later(21 * 60)),
        two,
        DeviceCommand::Tap { x: 2, y: 2 },
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// capability.verify and the pending work
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn verify_refuses_a_phone() {
    let (w, _key, p, _) = rig().await;
    let evidence = || Evidence {
        text: "adb devices: SER1 device".into(),
        refs: vec!["SER1".into()],
    };
    let manager = w.member("manager").await;
    let declarer = w.agent(&["workspace.read", "capabilities.manage"]).await;
    // Neither a person nor an agent verifies a phone by evidence, one its bridge registered or one
    // a person declared: only a registration verifies it.
    let declared = w
        .declare("phone", "Elle eklenen telefon")
        .await
        .capability
        .id;
    for id in [p, declared] {
        for ctx in [&w.owner_ctx, &manager, &declarer] {
            let e = err(capabilities::verify(&w.deps, &at(ctx, later(50)), id, evidence()).await);
            assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
            assert_eq!(
                e.details,
                json!({ "reason": "verified_by_heartbeat", "kind_key": "phone" })
            );
        }
    }
    assert!(w.entries("capability.verify").is_empty());
    // Its verification is still its last registration: stale and offline a minute after it ...
    assert_eq!(
        read(&w, p, later(50)).await,
        (EffectiveStatus::Verified, Some(FIXED_NOW))
    );
    assert_eq!(read(&w, p, later(61)).await.0, EffectiveStatus::Stale);
    assert_eq!(
        read(&w, declared, later(61)).await.0,
        EffectiveStatus::Declared
    );
    // ... and the hold of the bridge that listed it lapses with it: another bridge takes it over.
    let other = bridge_key(&w, "other PC").await;
    let refused = register(&w, &other, later(59), vec![phone("SER1")]).await;
    assert_eq!(refused.refused[0].reason, PHONE_HELD_BY_ANOTHER_BRIDGE);
    let taken = register(&w, &other, later(61), vec![phone("SER1")]).await;
    assert_eq!(cap(&taken, 0), p);
    assert!(taken.refused.is_empty());
    // A voice bridge is refused the same way, naming its kind.
    let voice = w.declare("voice_bridge", "Ses köprüsü").await.capability.id;
    let e = err(capabilities::verify(&w.deps, &w.owner_ctx, voice, evidence()).await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details["kind_key"], "voice_bridge");
}

#[tokio::test]
async fn offline_phone_is_not_reported_as_a_voice_bridge() {
    let (w, _key, p, _) = rig().await;
    let declared = w
        .declare("phone", "Elle eklenen telefon")
        .await
        .capability
        .id;
    let voice = w.declare("voice_bridge", "Ses köprüsü").await.capability.id;
    let computer = w
        .declare("computer", "Ofis bilgisayarı")
        .await
        .capability
        .id;

    // Within the minute after its registration, the registered phone is pending nothing; the
    // phone a person declared, which no bridge ever listed, is pending as an offline phone.
    let phones = |items: &[work::WorkItem]| -> Vec<CapabilityId> {
        items
            .iter()
            .filter_map(|i| match &i.kind {
                WorkKind::PhoneOffline { capability_id, .. } => Some(*capability_id),
                _ => None,
            })
            .collect()
    };
    let voices = |items: &[work::WorkItem]| -> Vec<CapabilityId> {
        items
            .iter()
            .filter_map(|i| match &i.kind {
                WorkKind::VoiceBridgeOffline { capability_id, .. } => Some(*capability_id),
                _ => None,
            })
            .collect()
    };
    let items = pending(&w, later(30)).await;
    assert_eq!(phones(&items), [declared]);
    assert_eq!(voices(&items), [voice]);

    // Stale, the registered phone is pending as an offline phone too, never as a voice bridge,
    // and never as a capability to verify by evidence (a computer still is).
    let items = pending(&w, later(61)).await;
    let mut offline = phones(&items);
    offline.sort();
    let mut expected = vec![p, declared];
    expected.sort();
    assert_eq!(offline, expected);
    assert_eq!(voices(&items), [voice]);
    let verify: Vec<CapabilityId> = items
        .iter()
        .filter_map(|i| match &i.kind {
            WorkKind::VerifyCapability { capability_id, .. } => Some(*capability_id),
            _ => None,
        })
        .collect();
    assert_eq!(verify, [computer]);

    // Each says what it is about: the phone's names its bridge program, the voice bridge's its
    // service, and each is cleared by its own bridge's registration.
    let item = items
        .iter()
        .find(|i| matches!(&i.kind, WorkKind::PhoneOffline { capability_id, .. } if *capability_id == p))
        .unwrap();
    assert_eq!(item.priority, 2);
    assert_eq!(item.kind.cleared_by(), "devices.bridge.register");
    assert!(item.hint.contains("jeeta-device-bridge"), "{}", item.hint);
    assert!(!item.hint.contains("voice"), "{}", item.hint);
    let wire = serde_json::to_value(item).unwrap();
    assert_eq!(wire["kind"], "phone_offline");
    assert_eq!(wire["name"], "Redmi 10C (SER1)");
    assert_eq!(wire["last_seen_at"], json!(rfc3339(FIXED_NOW)));
    let item = items
        .iter()
        .find(|i| matches!(&i.kind, WorkKind::VoiceBridgeOffline { .. }))
        .unwrap();
    assert_eq!(item.kind.cleared_by(), "calls.bridge.register");
    assert!(item.hint.contains("jeeta-voice-bridge"), "{}", item.hint);
}

#[test]
fn every_heartbeat_kind_has_its_own_offline_item() {
    // A kind verified by its heartbeat is never asked to be verified by evidence, so each needs
    // an item of its own; two kinds never share one.
    let mut cleared_by = Vec::new();
    for kind in KINDS.iter().filter(|k| k.heartbeat().is_some()) {
        let c = Capability::new(
            CapabilityId::new_v7(),
            WorkspaceId::new_v7(),
            NewCapability {
                kind_key: kind.key.into(),
                name: "x".into(),
                ..NewCapability::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        let item = work::offline_item(&c).unwrap_or_else(|| panic!("{} has no item", kind.key));
        cleared_by.push(item.kind.cleared_by());
    }
    assert_eq!(
        cleared_by,
        ["calls.bridge.register", "devices.bridge.register"]
    );
    // Any other kind has none.
    let c = Capability::new(
        CapabilityId::new_v7(),
        WorkspaceId::new_v7(),
        NewCapability {
            kind_key: "computer".into(),
            name: "x".into(),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    assert!(work::offline_item(&c).is_none());
}

// ---------------------------------------------------------------------------------------------
// device_command_expiry
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn expiry_job_expires_and_ledgers() {
    let (w, key, p, agent) = rig().await;
    // One command a bridge took and never answered, one no bridge took, one not due yet.
    let leased = act(&w, &agent, p, DeviceCommand::Tap { x: 1, y: 1 }).await;
    assert_eq!(ids(&poll(&w, &key, later(1)).await), [leased]);
    let queued = act(
        &w,
        &at(&agent, later(2)),
        p,
        DeviceCommand::Tap { x: 2, y: 2 },
    )
    .await;
    let fresh = act(
        &w,
        &at(&agent, later(30)),
        p,
        DeviceCommand::Tap { x: 3, y: 3 },
    )
    .await;
    let limit = FIXED_NOW + DEFAULT_EXPIRES_IN;
    assert_eq!(row(&w, leased).await.expires_at, limit);

    // Before their limit, nothing ends.
    let before = limit - Duration::seconds(1);
    assert_eq!(
        jobs::run_device_command_expiry(&w.deps, before).await,
        JobReport::default()
    );
    assert!(finished(&w).is_empty());

    // At its limit each ends expired, ledgered by the job, in queue order.
    let at_limit = limit + Duration::seconds(2);
    let run = jobs::run_device_command_expiry(&w.deps, at_limit).await;
    assert_eq!(run, report(2, 2, 0, 0));
    for id in [leased, queued] {
        let r = row(&w, id).await;
        assert_eq!(
            (r.status, r.done_at),
            (CommandStatus::Expired, Some(at_limit))
        );
    }
    assert_eq!(row(&w, fresh).await.status, CommandStatus::Queued);
    let bridge = key.api_key_id.to_string();
    assert_eq!(
        finished(&w),
        [
            json!({ "command_id": leased, "kind": "tap", "status": "expired", "reason": null, "duration_ms": null, "leased_by": bridge, "result_sha256": null }),
            json!({ "command_id": queued, "kind": "tap", "status": "expired", "reason": null, "duration_ms": null, "leased_by": null, "result_sha256": null }),
        ]
    );
    let entries = w.entries("devices.command.finished");
    for e in &entries {
        assert_eq!(
            e.actor,
            Actor::System {
                component: "scheduler:device_command_expiry".into()
            }
        );
    }
    // An expired command reads so in the agent's answer.
    let out = agent::command_get(
        &w.deps,
        &at(&agent, at_limit),
        queued,
        WaitQuery { wait_s: Some(0) },
    )
    .await
    .unwrap();
    assert_eq!(out.status, CommandStatus::Expired);
    // Once: an expired command is not ended again.
    assert_eq!(
        jobs::run_device_command_expiry(&w.deps, at_limit + Duration::seconds(10)).await,
        JobReport::default()
    );
    assert_eq!(finished(&w).len(), 2);

    // The leased one ran after all: its late result replaces the expiry and is ledgered after
    // it. The one no bridge took has no result to take.
    let late = limit + Duration::seconds(5);
    assert_eq!(
        post(&w, &key, late, leased, done()).await,
        ResultsOut {
            applied: 1,
            duplicates: 0,
            unknown: 0
        }
    );
    assert_eq!(
        post(&w, &key, late, queued, done()).await,
        ResultsOut {
            applied: 0,
            duplicates: 0,
            unknown: 1
        }
    );
    let r = row(&w, leased).await;
    assert_eq!((r.status, r.done_at), (CommandStatus::Done, Some(late)));
    let entries = finished(&w);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[2]["command_id"], json!(leased));
    assert_eq!(entries[2]["status"], "done");
    assert_eq!(entries[2]["duration_ms"], 42);
    // Every command row is kept, however it ended.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(r.device_commands().list(p, 200).await.unwrap().len(), 3);
}

// ---------------------------------------------------------------------------------------------
// device_file_purge
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn file_purge_keeps_6_days_drops_8() {
    let (w, key, p, agent) = rig().await;
    // A pull the bridge answers with a file it uploads at the fixed time; another file two days
    // later.
    let pull = act(
        &w,
        &agent,
        p,
        DeviceCommand::PullFile {
            path: "/sdcard/Download/a.bin".into(),
        },
    )
    .await;
    assert_eq!(ids(&poll(&w, &key, FIXED_NOW).await), [pull]);
    let old = upload(&w, &key, FIXED_NOW, b"eight days old").await;
    let file = Outcome::Done {
        result: CommandResult::File { file_id: old },
    };
    assert_eq!(post(&w, &key, FIXED_NOW, pull, file).await.applied, 1);
    let young = upload(&w, &key, days(2), b"six days old").await;
    let get = |now: OffsetDateTime| {
        let (deps, agent) = (w.deps.clone(), at(&agent, now));
        async move {
            agent::command_get(&deps, &agent, pull, WaitQuery { wait_s: Some(0) })
                .await
                .unwrap()
        }
    };
    assert!(get(days(8)).await.file_url.is_some());

    // Eight days on, the older file is deleted, bytes and record; the six-day-old one is kept.
    let run = jobs::run_device_file_purge(&w.deps, days(8)).await;
    assert_eq!(run, report(1, 1, 0, 0));
    assert!(!kept(&w, old).await);
    assert!(kept(&w, young).await);
    assert_eq!(recorded(&w, &[old, young]).await, [young]);
    // The command is kept, still naming its file, which is no longer read.
    let out = get(days(8)).await;
    assert_eq!(out.status, CommandStatus::Done);
    assert_eq!(out.result.unwrap()["file_id"], json!(old));
    assert_eq!(out.file_url, None);
    // Again: nothing more to do.
    assert_eq!(
        jobs::run_device_file_purge(&w.deps, days(8)).await,
        JobReport::default()
    );

    // Once its own seven days are up, the other goes too.
    assert_eq!(
        jobs::run_device_file_purge(&w.deps, days(9) - Duration::seconds(1)).await,
        JobReport::default()
    );
    let run = jobs::run_device_file_purge(&w.deps, days(9)).await;
    assert_eq!(run, report(1, 1, 0, 0));
    assert!(!kept(&w, young).await);
    assert!(recorded(&w, &[old, young]).await.is_empty());
    // No command row was deleted.
    assert_eq!(row(&w, pull).await.status, CommandStatus::Done);
}

/// A file store whose deletes fail while `broken` is set.
#[derive(Default)]
struct Deletes {
    inner: MemoryFiles,
    broken: AtomicBool,
}

#[async_trait]
impl FileStore for Deletes {
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
        self.inner.provider_url(ws, id, expires_at).await
    }
    async fn delete(&self, ws: WorkspaceId, id: FileId) -> Result<(), AppError> {
        if self.broken.load(Ordering::SeqCst) {
            return Err(AppError::internal("the store cannot delete now"));
        }
        self.inner.delete(ws, id).await
    }
}

#[tokio::test]
async fn file_purge_finishes_what_it_could_not_do() {
    let (mut w, key, _, _) = rig().await;
    let store = Arc::new(Deletes::default());
    w.deps.files = store.clone();
    let (stuck, bare) = (
        upload(&w, &key, FIXED_NOW, b"stuck").await,
        upload(&w, &key, FIXED_NOW, b"bare").await,
    );
    // One file's bytes are gone already. While the store cannot delete, each is counted failed
    // and its record kept (and the other's bytes).
    store.inner.delete(w.ws, FileId(bare)).await.unwrap();
    store.broken.store(true, Ordering::SeqCst);
    let run = jobs::run_device_file_purge(&w.deps, days(8)).await;
    assert_eq!((run.touched, run.failed), (2, 2), "{run:?}");
    assert_eq!(run.changed, 0);
    assert_eq!(recorded(&w, &[stuck, bare]).await.len(), 2);
    assert!(kept(&w, stuck).await);
    // Once it can, the next run finishes both: the bare one's record goes, though its bytes went
    // before.
    store.broken.store(false, Ordering::SeqCst);
    let run = jobs::run_device_file_purge(&w.deps, days(8)).await;
    assert_eq!(run, report(2, 2, 0, 0));
    assert!(recorded(&w, &[stuck, bare]).await.is_empty());
    assert!(!kept(&w, stuck).await);
}

#[tokio::test]
async fn the_jobs_sweep_every_workspace() {
    let (w, key, p, agent) = rig().await;
    let (other_ws, other_owner) = w.other_workspace().await;
    jt_testkit::flows::activate_workspace(&w.deps, other_ws).await;
    let other_key = {
        let key = api_keys::create(
            &w.deps,
            &other_owner,
            CreateKey {
                name: "theirs".into(),
                scopes: vec!["devices.bridge".into()],
            },
        )
        .await
        .unwrap();
        api_keys::authenticate(&w.deps, &key.plaintext)
            .await
            .unwrap()
    };
    let body = RegisterIn {
        bridge_id: "PC-2".into(),
        version: "0.1.0".into(),
        protocol: 1,
        phones: vec![phone("SER1")],
    };
    let theirs = bridge::register(&w.deps, &bridge_at(&other_key, FIXED_NOW), body)
        .await
        .unwrap();
    let their_phone = cap(&theirs, 0);
    let mine = act(&w, &agent, p, DeviceCommand::Tap { x: 1, y: 1 }).await;
    let their_file = upload(&w, &other_key, FIXED_NOW, b"theirs").await;
    let my_file = upload(&w, &key, FIXED_NOW, b"mine").await;

    let then = days(8);
    assert_eq!(
        jobs::run_device_bridge_health(&w.deps, then).await,
        report(2, 2, 0, 0)
    );
    assert_eq!(
        jobs::run_device_command_expiry(&w.deps, then).await,
        report(1, 1, 0, 0)
    );
    assert_eq!(
        jobs::run_device_file_purge(&w.deps, then).await,
        report(2, 2, 0, 0)
    );
    assert_eq!(row(&w, mine).await.status, CommandStatus::Expired);
    for (ws, id) in [(w.ws, my_file), (other_ws, their_file)] {
        assert!(!w.deps.files.exists(ws, FileId(id)).await.unwrap());
    }
    let mut r = w.uow.tenant(other_ws).await.unwrap();
    let c = r.capabilities().find(their_phone).await.unwrap().unwrap();
    assert_eq!(c.status, StoredStatus::Unreachable);
}
