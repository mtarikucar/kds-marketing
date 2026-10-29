//! What an agent does with the workspace's phones (D1-T6): `act` checks the command, the phone and
//! what its bridge runs before anything is queued, queues it with a ledger entry carrying the whole
//! command, and waits for the bridge's result, answering where the command stands when the wait
//! ends first; `observe` is `act` with an observation; `command_get` waits on one command;
//! `commands` is a phone's log, without results; `list` the phones. Every one needs
//! `devices.work`, and reaches only its own workspace's phones and files. Once a command is queued,
//! `act` answers it, whatever its wait meets; a command past its expiry reads `expired`. (That
//! `tracing` never carries a command's arguments is `devices_agent_tracing.rs`, a binary of its
//! own.)
mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration as StdDuration, Instant};

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{PlatformRepos, TenantRepos, UserRepos};
use jt_tenancy::WorkspaceId;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::devices::{
    CommandStatus, DEFAULT_EXPIRES_IN, DeviceCommand, DeviceKey, ElementTarget, FailReason,
    KEY_WAKEUP, TEXT_UNICODE,
};
use jt_app::usecases::api_keys::{self, AgentPrincipal, CreateKey};
use jt_app::usecases::capabilities;
use jt_app::usecases::devices::agent::{
    self, ActInput, LogQuery, MAX_WAIT_S, ObserveInput, UNICODE_HINT, WaitQuery,
};
use jt_app::usecases::devices::bridge::{
    self, BridgeCaller, CommandsQuery, RegisterIn, RegisterOut, ResultsIn,
};
use jt_capability::CapabilityId;
use jt_device_protocol::{
    CommandResult, Element, Observation, Outcome, PhoneReport, Platform, ResultIn, Screen,
};
use jt_ledger::Subject;
use jt_testkit::fakes::files::{Chunks, MemoryFiles};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow};
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// `seconds` after the fixed time.
fn later(seconds: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(seconds)
}

/// A bridge's key: issued by the owner with `devices.bridge` alone.
async fn bridge_key(w: &World) -> AgentPrincipal {
    let key = api_keys::create(
        &w.deps,
        &w.owner_ctx,
        CreateKey {
            name: "phones".into(),
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

/// Every command kind, and Unicode text: what a bridge with ADBKeyBoard reports.
fn every_feature() -> Vec<String> {
    DeviceCommand::KINDS
        .iter()
        .map(|kind| (*kind).to_owned())
        .chain([TEXT_UNICODE.to_owned()])
        .collect()
}

/// An Android phone with serial `serial` whose bridge runs `features`.
fn phone_with(serial: &str, features: Vec<String>) -> PhoneReport {
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
        features,
    }
}

fn phone(serial: &str) -> PhoneReport {
    phone_with(serial, every_feature())
}

/// A registration of `phones` by the bridge of `key` at `now`.
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

/// An active workspace, a bridge's key, that bridge registered with `phones` at the fixed time,
/// and an agent holding `devices.work`.
async fn rig_with(
    phones: Vec<PhoneReport>,
) -> (World, AgentPrincipal, RegisterOut, jt_app::ctx::Ctx) {
    let mut w = world().await;
    w.deps.files = Arc::new(MemoryFiles::default());
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w).await;
    let out = register(&w, &key, FIXED_NOW, phones).await;
    let agent = w.agent(&["devices.work"]).await;
    (w, key, out, agent)
}

/// [`rig_with`] one phone, `SER1`, whose bridge runs everything.
async fn rig() -> (World, AgentPrincipal, CapabilityId, jt_app::ctx::Ctx) {
    let (w, key, out, agent) = rig_with(vec![phone("SER1")]).await;
    let p = cap(&out, 0);
    (w, key, p, agent)
}

fn tap() -> DeviceCommand {
    DeviceCommand::Tap { x: 5, y: 5 }
}

fn shell() -> DeviceCommand {
    DeviceCommand::Shell {
        argv: vec!["getprop".into(), "ro.product.model".into()],
    }
}

fn text(value: &str) -> DeviceCommand {
    DeviceCommand::Text {
        value: value.into(),
    }
}

fn input(command: DeviceCommand, wait_s: u32) -> ActInput {
    ActInput {
        command,
        wait_s: Some(wait_s),
    }
}

/// The bridge of `key`: waits up to five seconds for its next commands, and answers each with
/// what `answer` makes of it; the ids of the commands it was handed.
async fn bridge_answers(
    w: &World,
    key: &AgentPrincipal,
    answer: impl Fn(&DeviceCommand) -> Outcome,
) -> Vec<Uuid> {
    let b = bridge_at(key, FIXED_NOW);
    let query = CommandsQuery {
        wait_s: 5,
        limit: 20,
    };
    let leased = bridge::commands(&w.deps, &b, query).await.unwrap().commands;
    let results = leased
        .iter()
        .map(|c| ResultIn {
            command_id: c.id,
            outcome: answer(&c.command),
            duration_ms: 12,
        })
        .collect();
    bridge::results(&w.deps, &b, ResultsIn { results })
        .await
        .unwrap();
    leased.iter().map(|c| c.id).collect()
}

/// Every command of the workspace, oldest first.
async fn queued(w: &World, phone: CapabilityId) -> Vec<Uuid> {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut rows = r.device_commands().list(phone, 200).await.unwrap();
    rows.reverse();
    rows.into_iter().map(|row| row.id).collect()
}

/// Asserts `CONFLICT` with `details.reason = reason`.
fn assert_not_ready(e: &jt_app::error::AppError, reason: &str) {
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details, json!({ "reason": reason }), "{e:?}");
}

#[tokio::test]
async fn act_queues_and_returns_result_when_bridge_answers() {
    let (w, key, p, agent) = rig().await;
    let model = CommandResult::shell(0, b"Redmi 10C\n", b"");
    let started = Instant::now();
    let (out, handed) = tokio::join!(
        agent::act(&w.deps, &agent, p, input(shell(), 10)),
        bridge_answers(&w, &key, |_| Outcome::Done {
            result: model.clone()
        }),
    );
    let out = out.unwrap();
    // Woken by the result: without the signal, a read only every second.
    let took = started.elapsed();
    assert!(took < StdDuration::from_millis(900), "{took:?}");
    assert_eq!(handed, [out.command_id]);
    assert_eq!(out.capability_id, p);
    assert_eq!((out.kind, out.status), ("shell", CommandStatus::Done));
    assert_eq!(out.command, shell());
    assert_eq!(out.result, Some(serde_json::to_value(&model).unwrap()));
    assert_eq!((out.reason, out.detail.clone()), (None, None));
    assert_eq!(out.attempts, 1);
    assert_eq!(out.requested_by, agent.actor);
    assert_eq!(out.created_at, FIXED_NOW);
    assert_eq!(out.expires_at, FIXED_NOW + DEFAULT_EXPIRES_IN);
    assert!(out.leased_at.is_some() && out.done_at.is_some());
    assert_eq!(out.file_url, None);

    // A failure answers its reason and the bridge's line.
    let (out, _) = tokio::join!(
        agent::act(
            &w.deps,
            &agent,
            p,
            input(
                DeviceCommand::TapOn {
                    target: ElementTarget::Text("Gönder".into()),
                    exact: false,
                },
                10
            )
        ),
        bridge_answers(&w, &key, |_| Outcome::failed(
            FailReason::ElementNotFound,
            "no element; visible: OK, Cancel"
        )),
    );
    let out = out.unwrap();
    assert_eq!(out.status, CommandStatus::Failed);
    assert_eq!(out.reason, Some(FailReason::ElementNotFound));
    assert_eq!(
        out.detail.as_deref(),
        Some("no element; visible: OK, Cancel")
    );
    assert_eq!(out.result, None);
    // As JSON, the answer names its state the way the tools describe it.
    let wire = serde_json::to_value(&out).unwrap();
    assert_eq!(wire["status"], "failed");
    assert_eq!(wire["reason"], "element_not_found");
    assert_eq!(
        wire["command"],
        json!({ "kind": "tap_on", "text": "Gönder", "exact": false })
    );
}

#[tokio::test]
async fn act_returns_queued_when_wait_ends() {
    let (w, key, p, agent) = rig().await;
    assert_eq!(MAX_WAIT_S, 20);
    // No wait: answered at once, queued; a queued command is not a done one.
    let started = Instant::now();
    let first = agent::act(&w.deps, &agent, p, input(tap(), 0))
        .await
        .unwrap();
    assert!(started.elapsed() < StdDuration::from_millis(500));
    assert_eq!(first.status, CommandStatus::Queued);
    assert_eq!((first.attempts, first.leased_at), (0, None));
    assert_eq!((first.result, first.done_at), (None, None));

    // A wait that ends before any bridge answers answers the command as it then stands.
    let started = Instant::now();
    let second = agent::act(&w.deps, &agent, p, input(tap(), 1))
        .await
        .unwrap();
    let took = started.elapsed();
    assert!(took >= StdDuration::from_millis(900), "{took:?}");
    assert!(took < StdDuration::from_secs(2), "{took:?}");
    assert_eq!(second.status, CommandStatus::Queued);
    assert_eq!(queued(&w, p).await, [first.command_id, second.command_id]);

    // Handed to a bridge that has not answered yet: leased, still not done.
    let b = bridge_at(&key, FIXED_NOW);
    let query = CommandsQuery {
        wait_s: 0,
        limit: 20,
    };
    assert_eq!(
        bridge::commands(&w.deps, &b, query)
            .await
            .unwrap()
            .commands
            .len(),
        2
    );
    let now = agent::command_get(
        &w.deps,
        &agent,
        first.command_id,
        WaitQuery { wait_s: Some(0) },
    )
    .await
    .unwrap();
    assert_eq!((now.status, now.attempts), (CommandStatus::Leased, 1));
    assert_eq!(now.result, None);
}

#[tokio::test]
async fn act_queues_the_wakeup_key_only_for_a_bridge_that_lists_it() {
    // A bridge built before the key lists every kind but not `key.wakeup`; one built after does.
    let mut newer = every_feature();
    newer.push(KEY_WAKEUP.to_owned());
    let (w, _, out, agent) = rig_with(vec![phone("SER1"), phone_with("SER2", newer)]).await;
    let (older, newer) = (cap(&out, 0), cap(&out, 1));
    let key = |key| DeviceCommand::Key { key };
    let e = err(agent::act(&w.deps, &agent, older, input(key(DeviceKey::Wakeup), 0)).await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "field": "command", "reason": "unsupported_by_bridge", "kind": KEY_WAKEUP })
    );
    assert!(queued(&w, older).await.is_empty());
    // Every other key still reaches it.
    let power = agent::act(&w.deps, &agent, older, input(key(DeviceKey::Power), 0))
        .await
        .unwrap();
    assert_eq!(queued(&w, older).await, [power.command_id]);
    let wakeup = agent::act(&w.deps, &agent, newer, input(key(DeviceKey::Wakeup), 0))
        .await
        .unwrap();
    assert_eq!(queued(&w, newer).await, [wakeup.command_id]);
}

#[tokio::test]
async fn act_refuses_unsupported_kind() {
    let features = ["observe", "tap", "text"].map(str::to_owned).to_vec();
    let (w, _, out, agent) = rig_with(vec![phone_with("SER1", features)]).await;
    let p = cap(&out, 0);
    for (command, kind) in [
        (shell(), "shell"),
        (DeviceCommand::Screenshot {}, "screenshot"),
        (
            DeviceCommand::Key {
                key: DeviceKey::Home,
            },
            "key",
        ),
    ] {
        let e = err(agent::act(&w.deps, &agent, p, input(command, 0)).await);
        assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
        assert_eq!(
            e.details,
            json!({ "field": "command", "reason": "unsupported_by_bridge", "kind": kind })
        );
        assert!(e.message.contains(kind), "{}", e.message);
    }
    // Nothing was queued or ledgered for them.
    assert!(queued(&w, p).await.is_empty());
    assert!(w.entries("devices.command.queued").is_empty());
    // What the bridge runs is queued.
    let out = agent::act(&w.deps, &agent, p, input(tap(), 0))
        .await
        .unwrap();
    assert_eq!(queued(&w, p).await, [out.command_id]);
}

#[tokio::test]
async fn act_refuses_unicode_without_feature() {
    let kinds: Vec<String> = DeviceCommand::KINDS
        .iter()
        .map(|k| (*k).to_owned())
        .collect();
    let (w, _, out, agent) = rig_with(vec![phone_with("SER1", kinds), phone("SER2")]).await;
    let (plain, unicode) = (cap(&out, 0), cap(&out, 1));
    // Text outside ASCII on a phone without ADBKeyBoard: refused with the hint, never queued
    // (`adb shell input text` would type it wrong and report it done).
    let e = err(agent::act(&w.deps, &agent, plain, input(text("Ayşe Gönder"), 0)).await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "field": "command", "reason": "unicode_unsupported", "hint": UNICODE_HINT })
    );
    assert!(e.message.contains("ADBKeyBoard"), "{}", e.message);
    assert!(UNICODE_HINT.contains("ADBKeyBoard") && UNICODE_HINT.contains("enable"));
    assert!(queued(&w, plain).await.is_empty());
    // ASCII text is typed there; Unicode text on a phone that lists text.unicode is queued.
    agent::act(&w.deps, &agent, plain, input(text("merhaba"), 0))
        .await
        .unwrap();
    agent::act(&w.deps, &agent, unicode, input(text("Ayşe Gönder"), 0))
        .await
        .unwrap();
    assert_eq!(queued(&w, plain).await.len(), 1);
    assert_eq!(queued(&w, unicode).await.len(), 1);
    // `list` says which phone types Unicode.
    let phones = agent::list(&w.deps, &agent).await.unwrap();
    let by_serial = |s: &str| {
        phones
            .iter()
            .find(|p| p.serial.as_deref() == Some(s))
            .unwrap()
            .unicode
    };
    assert!(!by_serial("SER1") && by_serial("SER2"));
}

#[tokio::test]
async fn act_on_offline_phone_refuses_device_offline() {
    let (w, _, p, agent) = rig().await;
    // Within the minute after its last registration it takes commands.
    agent::act(&w.deps, &at(&agent, later(59)), p, input(tap(), 0))
        .await
        .unwrap();
    // No registration for more than a minute: offline, nothing queued.
    let e = err(agent::act(&w.deps, &at(&agent, later(61)), p, input(tap(), 0)).await);
    assert_not_ready(&e, "device_offline");
    assert_eq!(queued(&w, p).await.len(), 1);
    let phones = agent::list(&w.deps, &at(&agent, later(61))).await.unwrap();
    assert!(!phones[0].online);
    // Marked unreachable by a person: offline too, however recent its last registration.
    capabilities::mark_unreachable(&w.deps, &w.owner_ctx, p, "unplugged".into())
        .await
        .unwrap();
    let e = err(agent::act(&w.deps, &agent, p, input(tap(), 0)).await);
    assert_not_ready(&e, "device_offline");
    // Retired: refused as such.
    capabilities::retire(&w.deps, &w.owner_ctx, p, true)
        .await
        .unwrap();
    let e = err(agent::act(&w.deps, &agent, p, input(tap(), 0)).await);
    assert_not_ready(&e, "phone_retired");
    assert!(agent::list(&w.deps, &agent).await.unwrap().is_empty());
}

#[tokio::test]
async fn act_on_phone_missing_from_latest_register_refuses_device_offline() {
    let (w, key, out, agent) = rig_with(vec![phone("SER1"), phone("SER2")]).await;
    let (kept, left_out) = (cap(&out, 0), cap(&out, 1));
    // The bridge's latest registration lists SER1 only (SER2's worker is stuck, say): SER2 is not
    // live, although it registered seconds ago.
    register(&w, &key, later(5), vec![phone("SER1")]).await;
    let agent = at(&agent, later(6));
    let e = err(agent::act(&w.deps, &agent, left_out, input(tap(), 0)).await);
    assert_not_ready(&e, "device_offline");
    assert!(queued(&w, left_out).await.is_empty());
    agent::act(&w.deps, &agent, kept, input(tap(), 0))
        .await
        .unwrap();
    let phones = agent::list(&w.deps, &agent).await.unwrap();
    let online = |id: CapabilityId| {
        phones
            .iter()
            .find(|p| p.capability_id == id)
            .unwrap()
            .online
    };
    assert!(online(kept) && !online(left_out));
    // Listed again: live again.
    register(&w, &key, later(7), vec![phone("SER1"), phone("SER2")]).await;
    agent::act(&w.deps, &at(&agent, later(8)), left_out, input(tap(), 0))
        .await
        .unwrap();
}

#[tokio::test]
async fn ledger_carries_full_command() {
    let (w, key, p, agent) = rig().await;
    let commands = [
        shell(),
        text("Ayşe Gönder: şifre 1234"),
        DeviceCommand::OpenUrl {
            url: "intent://scan/#Intent;scheme=zxing;end".into(),
        },
        DeviceCommand::Shell {
            argv: vec!["rm".into(), "-rf".into(), "/sdcard/x".into()],
        },
    ];
    let mut ids = Vec::new();
    for command in &commands {
        let out = agent::act(&w.deps, &agent, p, input(command.clone(), 0))
            .await
            .unwrap();
        ids.push(out.command_id);
    }
    let entries = w.entries("devices.command.queued");
    assert_eq!(entries.len(), commands.len());
    for ((entry, command), id) in entries.iter().zip(&commands).zip(&ids) {
        // The whole command, typed text and shell arguments included, by the agent who asked.
        assert_eq!(
            entry.payload,
            json!({
                "command_id": id,
                "phone": p,
                "kind": command.kind(),
                "command": serde_json::to_value(command).unwrap(),
                "expires_at": "2026-10-22T09:05:00Z",
            })
        );
        assert_eq!(entry.actor, agent.actor);
        assert_eq!(
            entry.subject,
            Some(Subject {
                kind: "device_command".into(),
                id: id.to_string(),
            })
        );
    }
    assert_eq!(
        entries[1].payload["command"]["value"],
        "Ayşe Gönder: şifre 1234"
    );
    assert_eq!(
        entries[3].payload["command"]["argv"],
        json!(["rm", "-rf", "/sdcard/x"])
    );
    // How each ended is ledgered by the bridge's results, naming the command.
    bridge_answers(&w, &key, |_| Outcome::Done {
        result: CommandResult::Done {},
    })
    .await;
    let finished: Vec<Value> = w
        .entries("devices.command.finished")
        .into_iter()
        .map(|e| e.payload["command_id"].clone())
        .collect();
    assert_eq!(finished, ids.iter().map(|id| json!(id)).collect::<Vec<_>>());
}

#[tokio::test]
async fn rep_cannot_act() {
    let (w, key, p, agent) = rig().await;
    let id = agent::act(&w.deps, &agent, p, input(tap(), 0))
        .await
        .unwrap()
        .command_id;
    let rep = w.member("rep").await;
    let no_devices = w.agent(&["workspace.read"]).await;
    // The bridge's own key reaches its routes only: never a phone through these.
    let bridge = bridge_at(&key, FIXED_NOW).ctx;
    for ctx in [&rep, &no_devices, &bridge] {
        let forbidden = |e: jt_app::error::AppError| assert_forbidden(&e, "devices.work");
        forbidden(err(agent::act(&w.deps, ctx, p, input(tap(), 0)).await));
        forbidden(err(agent::observe(
            &w.deps,
            ctx,
            p,
            ObserveInput::default(),
        )
        .await));
        forbidden(err(agent::list(&w.deps, ctx).await));
        forbidden(err(agent::command_get(
            &w.deps,
            ctx,
            id,
            WaitQuery::default(),
        )
        .await));
        forbidden(err(
            agent::commands(&w.deps, ctx, p, LogQuery::default()).await
        ));
    }
    assert_eq!(queued(&w, p).await, [id]);
    // The owner and a manager hold devices.work.
    let manager = w.member("manager").await;
    for ctx in [&w.owner_ctx, &manager] {
        agent::act(&w.deps, ctx, p, input(tap(), 0)).await.unwrap();
    }
}

#[tokio::test]
async fn command_get_waits() {
    let (w, key, p, agent) = rig().await;
    let id = agent::act(&w.deps, &agent, p, input(tap(), 0))
        .await
        .unwrap()
        .command_id;
    // Waits for the bridge's answer, and is woken by it.
    let started = Instant::now();
    let (out, _) = tokio::join!(
        agent::command_get(&w.deps, &agent, id, WaitQuery { wait_s: Some(10) }),
        async {
            tokio::time::sleep(StdDuration::from_millis(300)).await;
            bridge_answers(&w, &key, |_| Outcome::Done {
                result: CommandResult::Done {},
            })
            .await
        },
    );
    let took = started.elapsed();
    let out = out.unwrap();
    assert_eq!(out.status, CommandStatus::Done);
    // Woken by the result, 300 ms in: without the signal, the next read is a second after the first.
    assert!(took >= StdDuration::from_millis(300), "{took:?}");
    assert!(took < StdDuration::from_millis(900), "{took:?}");
    // A command that ended answers at once, whatever the wait.
    let started = Instant::now();
    let again = agent::command_get(&w.deps, &agent, id, WaitQuery { wait_s: Some(20) })
        .await
        .unwrap();
    assert!(started.elapsed() < StdDuration::from_millis(500));
    assert_eq!(again, out);
    // One still queued answers as it stands once the wait ends.
    let pending = agent::act(&w.deps, &agent, p, input(tap(), 0))
        .await
        .unwrap()
        .command_id;
    let started = Instant::now();
    let out = agent::command_get(&w.deps, &agent, pending, WaitQuery { wait_s: Some(1) })
        .await
        .unwrap();
    assert!(started.elapsed() >= StdDuration::from_millis(900));
    assert_eq!(out.status, CommandStatus::Queued);
    // An unknown command, or another workspace's, is not found.
    let e = err(agent::command_get(&w.deps, &agent, Uuid::now_v7(), WaitQuery::default()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let (_, other) = w.other_workspace().await;
    let e = err(agent::command_get(&w.deps, &other, id, WaitQuery { wait_s: Some(0) }).await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn observe_answers_the_screen_and_a_screenshot_address() {
    let (w, key, p, agent) = rig().await;
    let b = bridge_at(&key, FIXED_NOW);
    let png = b"\x89PNG\r\n\x1a\nscreen";
    let shot = bridge::files(
        &w.deps,
        &b,
        Some("image/png"),
        Some(png.len() as u64),
        &mut Chunks::of(png),
    )
    .await
    .unwrap()
    .file_id;
    let seen = Observation {
        screen: Screen {
            w: 720,
            h: 1650,
            rotation: 0,
        },
        foreground_app: Some("com.whatsapp".into()),
        awake: Some(true),
        locked: Some(false),
        elements: vec![Element {
            text: Some("Gönder".into()),
            id: Some("com.whatsapp:id/send".into()),
            desc: None,
            class: Some("android.widget.Button".into()),
            bounds: [600, 1500, 700, 1600],
            tap_point: [650, 1550],
            clickable: true,
            editable: false,
            focused: false,
        }],
        truncated: false,
        screenshot_file_id: Some(shot),
    };
    let observed = seen.clone();
    let (out, _) = tokio::join!(
        agent::observe(
            &w.deps,
            &agent,
            p,
            ObserveInput {
                screenshot: true,
                wait_s: Some(10),
            }
        ),
        bridge_answers(&w, &key, move |command| {
            assert_eq!(command, &DeviceCommand::Observe { screenshot: true });
            Outcome::Done {
                result: CommandResult::Observation(observed.clone()),
            }
        }),
    );
    let out = out.unwrap();
    assert_eq!((out.kind, out.status), ("observe", CommandStatus::Done));
    let result = out.result.clone().unwrap();
    assert_eq!(result["kind"], "observation");
    assert_eq!(result["elements"][0]["tap_point"], json!([650, 1550]));
    // Whether the screen is on and locked reaches the agent as the bridge said it.
    assert_eq!(
        (&result["awake"], &result["locked"]),
        (&json!(true), &json!(false))
    );
    assert_eq!(
        result,
        serde_json::to_value(CommandResult::Observation(seen)).unwrap()
    );
    // The screenshot is readable at an address of its own, in the agent's answer only.
    let url = out.file_url.clone().unwrap();
    assert!(url.contains(&shot.to_string()), "{url}");
    let log = agent::commands(&w.deps, &agent, p, LogQuery::default())
        .await
        .unwrap();
    assert_eq!(log[0].command_id, out.command_id);
    // The log carries neither the observation nor an address.
    let entry = serde_json::to_value(&log[0]).unwrap();
    assert!(
        entry.get("result").is_none() && entry.get("file_url").is_none(),
        "{entry}"
    );
    let got = agent::command_get(&w.deps, &agent, out.command_id, WaitQuery::default())
        .await
        .unwrap();
    assert_eq!(got.file_url.as_deref(), Some(url.as_str()));
}

#[tokio::test]
async fn commands_is_the_phones_log_newest_first() {
    let (w, _, p, agent) = rig().await;
    let mut ids = Vec::new();
    for command in [tap(), shell(), text("merhaba")] {
        ids.push(
            agent::act(&w.deps, &agent, p, input(command, 0))
                .await
                .unwrap()
                .command_id,
        );
    }
    let log = agent::commands(&w.deps, &agent, p, LogQuery { limit: Some(2) })
        .await
        .unwrap();
    assert_eq!(
        log.iter().map(|c| c.command_id).collect::<Vec<_>>(),
        [ids[2], ids[1]]
    );
    // Each with its arguments, kind, status and times, never its result.
    assert_eq!(log[1].command, shell());
    assert_eq!(log[1].kind, "shell");
    assert_eq!(log[0].status, CommandStatus::Queued);
    assert_eq!(log[0].requested_by, agent.actor);
    assert_eq!(log[0].created_at, FIXED_NOW);
    let wire = serde_json::to_value(&log).unwrap();
    for entry in wire.as_array().unwrap() {
        assert!(entry.get("result").is_none(), "{entry}");
    }
    // Out-of-range limits are cut to the range; the default shows them all here.
    let all = agent::commands(&w.deps, &agent, p, LogQuery::default())
        .await
        .unwrap();
    assert_eq!(all.len(), 3);
    let one = agent::commands(&w.deps, &agent, p, LogQuery { limit: Some(0) })
        .await
        .unwrap();
    assert_eq!(one.len(), 1);
    // An unknown phone, or a capability that is no phone, is not found.
    let e =
        err(agent::commands(&w.deps, &agent, CapabilityId::new_v7(), LogQuery::default()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let netgsm = w.declare("netgsm_pbx", "Santral").await;
    let e = err(agent::commands(&w.deps, &agent, netgsm.capability.id, LogQuery::default()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = err(agent::act(&w.deps, &agent, netgsm.capability.id, input(tap(), 0)).await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn list_shows_the_phones_and_what_their_bridge_reported() {
    let (w, _, p, agent) = rig().await;
    let phones = agent::list(&w.deps, &agent).await.unwrap();
    assert_eq!(phones.len(), 1);
    let phone = &phones[0];
    assert_eq!(phone.capability_id, p);
    assert!(phone.online && phone.unicode);
    assert_eq!(phone.platform.as_deref(), Some("android"));
    assert_eq!(phone.serial.as_deref(), Some("SER1"));
    assert_eq!(phone.model.as_deref(), Some("Redmi 10C"));
    assert_eq!(phone.os_version.as_deref(), Some("13"));
    assert_eq!(
        phone.screen,
        Some(json!({ "w": 720, "h": 1650, "rotation": 0 }))
    );
    assert_eq!(phone.features, every_feature());
    assert_eq!(phone.bridge_id.as_deref(), Some("PC-1"));
    assert_eq!(phone.bridge_version.as_deref(), Some("0.1.0"));
    assert_eq!(phone.last_seen_at, Some(FIXED_NOW));
    // The bridge's key id, which `connector_public.device` keeps, is not shown.
    assert!(!serde_json::to_string(phone).unwrap().contains("listed_by"));
}

#[tokio::test]
async fn act_checks_the_command_and_its_file_first() {
    let (w, _, p, agent) = rig().await;
    // A command that breaks a bound is refused naming the field, before the phone is looked at.
    let e = err(agent::act(&w.deps, &agent, p, input(text(""), 0)).await);
    assert_invalid(&e, "value");
    let e = err(agent::act(
        &w.deps,
        &agent,
        CapabilityId::new_v7(),
        input(DeviceCommand::Shell { argv: Vec::new() }, 0),
    )
    .await);
    assert_invalid(&e, "argv");
    // A file to push that is not stored is refused before anything is queued.
    let e = err(agent::act(
        &w.deps,
        &agent,
        p,
        input(
            DeviceCommand::PushFile {
                file_id: Uuid::now_v7(),
                dest: "/sdcard/Download/x.bin".into(),
            },
            0,
        ),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "field": "file_id", "reason": "file_not_found" })
    );
    // An unknown phone is not found.
    let e = err(agent::act(&w.deps, &agent, CapabilityId::new_v7(), input(tap(), 0)).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(queued(&w, p).await.is_empty());
    assert!(w.entries("devices.command.queued").is_empty());
}

/// A unit of work whose tenant bundles fail once `left` of them were opened: the database going
/// away part way through a call.
struct GoesAway {
    inner: InMemoryUow,
    left: AtomicUsize,
}

#[async_trait]
impl UnitOfWork for GoesAway {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        let open = self
            .left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok();
        if !open {
            return Err(AppError::internal("the database went away"));
        }
        self.inner.tenant(ws).await
    }
    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        self.inner.platform().await
    }
    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        self.inner.user().await
    }
}

#[tokio::test]
async fn act_answers_a_queued_command_when_its_wait_fails() {
    let (w, _, p, agent) = rig().await;
    // The bundle that queues the command opens; every read of the wait after it fails.
    let mut deps = w.deps.clone();
    deps.uow = Arc::new(GoesAway {
        inner: w.uow.clone(),
        left: AtomicUsize::new(1),
    });
    let out = agent::act(&deps, &agent, p, input(shell(), 5))
        .await
        .expect("a queued command is answered, never an error");
    assert_eq!(out.status, CommandStatus::Queued);
    assert_eq!(out.command, shell());
    // It is queued, once, and ledgered: an agent that retried would queue it twice.
    assert_eq!(queued(&w, p).await, [out.command_id]);
    let entries = w.entries("devices.command.queued");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].payload["command_id"], json!(out.command_id));
    // A read on its own may fail: it changes nothing, and can be asked again.
    let e = err(agent::command_get(&deps, &agent, out.command_id, WaitQuery::default()).await);
    assert_eq!(e.code, ErrorCode::Internal);
    // A refusal still comes before anything is queued.
    let e = err(agent::act(&deps, &agent, p, input(tap(), 5)).await);
    assert_eq!(e.code, ErrorCode::Internal);
    assert_eq!(queued(&w, p).await, [out.command_id]);
}

#[tokio::test]
async fn an_unfinished_command_past_its_expiry_reads_expired() {
    let (w, _, p, agent) = rig().await;
    let id = agent::act(&w.deps, &agent, p, input(tap(), 0))
        .await
        .unwrap()
        .command_id;
    let expiry = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let before = at(&agent, expiry - Duration::seconds(1));
    let after = at(&agent, expiry + Duration::seconds(1));
    let read = |ctx: jt_app::ctx::Ctx, wait_s| {
        let deps = w.deps.clone();
        async move {
            agent::command_get(
                &deps,
                &ctx,
                id,
                WaitQuery {
                    wait_s: Some(wait_s),
                },
            )
            .await
            .unwrap()
        }
    };
    assert_eq!(read(before, 0).await.status, CommandStatus::Queued);
    // No sweep has run: the command is still queued as stored, and reads expired, at once, even
    // with a wait (nobody will be handed it any more).
    let started = Instant::now();
    let out = read(after.clone(), 20).await;
    assert!(started.elapsed() < StdDuration::from_millis(500));
    assert_eq!(out.status, CommandStatus::Expired);
    assert_eq!(out.done_at, None);
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let stored = r.device_commands().get(id).await.unwrap().unwrap();
    assert_eq!(stored.status, CommandStatus::Queued);
    let log = agent::commands(&w.deps, &after, p, LogQuery::default())
        .await
        .unwrap();
    assert_eq!(log[0].status, CommandStatus::Expired);
    // A wait that runs past the expiry ends there: a command expiring in a second.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let soon = Uuid::now_v7();
    r.device_commands()
        .enqueue(jt_app::ports::devices::NewDeviceCommand {
            id: soon,
            capability_id: p,
            command: tap(),
            requested_by: agent.actor.clone(),
            created_at: FIXED_NOW,
            expires_at: FIXED_NOW + Duration::seconds(1),
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let started = Instant::now();
    let out = agent::command_get(&w.deps, &agent, soon, WaitQuery { wait_s: Some(10) })
        .await
        .unwrap();
    let took = started.elapsed();
    assert_eq!(out.status, CommandStatus::Expired);
    assert!(took >= StdDuration::from_millis(900), "{took:?}");
    assert!(took < StdDuration::from_secs(3), "{took:?}");
}

#[tokio::test]
async fn a_leased_command_past_its_expiry_reads_leased_until_it_ends() {
    let (w, key, p, agent) = rig().await;
    let id = agent::act(&w.deps, &agent, p, input(tap(), 0))
        .await
        .unwrap()
        .command_id;
    // A bridge took it: the phone may run it past its expiry.
    let b = bridge_at(&key, FIXED_NOW);
    let query = CommandsQuery {
        wait_s: 0,
        limit: 20,
    };
    assert_eq!(
        bridge::commands(&w.deps, &b, query)
            .await
            .unwrap()
            .commands
            .len(),
        1
    );
    let after = at(
        &agent,
        FIXED_NOW + DEFAULT_EXPIRES_IN + Duration::seconds(30),
    );
    let out = agent::command_get(&w.deps, &after, id, WaitQuery { wait_s: Some(0) })
        .await
        .unwrap();
    assert_eq!(out.status, CommandStatus::Leased);
    assert!(out.leased_at.is_some());
    let log = agent::commands(&w.deps, &after, p, LogQuery::default())
        .await
        .unwrap();
    assert_eq!(log[0].status, CommandStatus::Leased);
    // Its result, when it comes, is the answer.
    bridge::results(
        &w.deps,
        &bridge_at(&key, FIXED_NOW + DEFAULT_EXPIRES_IN + Duration::seconds(40)),
        ResultsIn {
            results: vec![ResultIn {
                command_id: id,
                outcome: Outcome::Done {
                    result: CommandResult::Done {},
                },
                duration_ms: 330_000,
            }],
        },
    )
    .await
    .unwrap();
    let out = agent::command_get(&w.deps, &after, id, WaitQuery { wait_s: Some(0) })
        .await
        .unwrap();
    assert_eq!(out.status, CommandStatus::Done);
}

#[tokio::test]
async fn another_workspaces_phone_and_file_are_not_found() {
    let (w, key, p, _) = rig().await;
    let (beta, beta_owner) = w.other_workspace().await;
    jt_testkit::flows::activate_workspace(&w.deps, beta).await;
    // Acme's phone, from Beta: not found, whatever is asked of it.
    let e = err(agent::act(&w.deps, &beta_owner, p, input(tap(), 0)).await);
    assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    let e = err(agent::observe(&w.deps, &beta_owner, p, ObserveInput::default()).await);
    assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    let e = err(agent::commands(&w.deps, &beta_owner, p, LogQuery::default()).await);
    assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    assert!(agent::list(&w.deps, &beta_owner).await.unwrap().is_empty());
    assert!(queued(&w, p).await.is_empty());

    // A file Acme's bridge uploaded cannot be pushed to Beta's own phone: not in Beta's store.
    let acme_file = bridge::files(
        &w.deps,
        &bridge_at(&key, FIXED_NOW),
        Some("application/octet-stream"),
        None,
        &mut Chunks::of(b"acme's file"),
    )
    .await
    .unwrap()
    .file_id;
    let beta_key = api_keys::create(
        &w.deps,
        &beta_owner,
        CreateKey {
            name: "beta phones".into(),
            scopes: vec!["devices.bridge".into()],
        },
    )
    .await
    .unwrap();
    let beta_key = api_keys::authenticate(&w.deps, &beta_key.plaintext)
        .await
        .unwrap();
    let beta_phone = cap(
        &register(&w, &beta_key, FIXED_NOW, vec![phone("SER9")]).await,
        0,
    );
    let push = DeviceCommand::PushFile {
        file_id: acme_file,
        dest: "/sdcard/Download/x.bin".into(),
    };
    let e = err(agent::act(&w.deps, &beta_owner, beta_phone, input(push.clone(), 0)).await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "field": "file_id", "reason": "file_not_found" })
    );
    // In Acme, the same command is queued.
    agent::act(&w.deps, &w.owner_ctx, p, input(push, 0))
        .await
        .unwrap();
}
