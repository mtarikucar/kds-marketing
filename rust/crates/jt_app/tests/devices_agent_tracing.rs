//! `tracing` never carries what a device command or its result says (D1-T6, spec §5.5): typed
//! text, shell arguments and output, a tap's target, a failure's detail, an address to open, a
//! path on the phone, screen text, a file's bytes or a signed file address. Ids, kinds, statuses
//! and counts only; the ledger carries the command (`devices_agent.rs`). The jobs that sweep the
//! phones' commands and files (D1-T7) log the same way.
//!
//! A binary of its own, with one test: it installs the process's global subscriber, which sees
//! every event of every thread, so no other test's first call can leave a callsite without one.
mod support;

use std::io::Write;
use std::sync::{Arc, Mutex};

use jt_app::ports::devices::{DeviceCommand, ElementTarget, FailReason, TEXT_UNICODE};
use jt_app::usecases::api_keys::{self, AgentPrincipal, CreateKey};
use jt_app::usecases::devices::agent::{self, ActInput, LogQuery, ObserveInput, WaitQuery};
use jt_app::usecases::devices::bridge::{self, BridgeCaller, CommandsQuery, RegisterIn, ResultsIn};
use jt_app::usecases::jobs;
use jt_capability::CapabilityId;
use jt_device_protocol::{
    CommandResult, Element, Observation, Outcome, PhoneReport, Platform, ResultIn, Screen,
};
use jt_testkit::fakes::FIXED_NOW;
use jt_testkit::fakes::files::{Chunks, MemoryFiles};
use support::*;
use uuid::Uuid;

/// What the subscriber wrote, kept for the test to read.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The bridge of `b`: waits for its next commands and answers each with what `answer` makes of
/// it.
async fn bridge_answers(w: &World, b: &BridgeCaller, answer: impl Fn(&DeviceCommand) -> Outcome) {
    let query = CommandsQuery {
        wait_s: 5,
        limit: 20,
    };
    let leased = bridge::commands(&w.deps, b, query).await.unwrap().commands;
    let results = leased
        .iter()
        .map(|c| ResultIn {
            command_id: c.id,
            outcome: answer(&c.command),
            duration_ms: 12,
        })
        .collect();
    bridge::results(&w.deps, b, ResultsIn { results })
        .await
        .unwrap();
}

/// `command` acted on phone `p` by `agent` while the bridge `b` answers it with `answer`.
async fn round_trip(
    w: &World,
    agent: &jt_app::ctx::Ctx,
    b: &BridgeCaller,
    p: CapabilityId,
    command: DeviceCommand,
    answer: impl Fn(&DeviceCommand) -> Outcome,
) -> agent::CommandOut {
    let input = ActInput {
        command,
        wait_s: Some(10),
    };
    let (out, ()) = tokio::join!(
        agent::act(&w.deps, agent, p, input),
        bridge_answers(w, b, answer)
    );
    out.unwrap()
}

#[tokio::test]
async fn tracing_never_carries_args() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let mut w = world().await;
    w.deps.files = Arc::new(MemoryFiles::default());
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key: AgentPrincipal = {
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
    };
    let b = bridge::ctx_for_bridge(&key, FIXED_NOW);
    let features = DeviceCommand::KINDS
        .iter()
        .map(|k| (*k).to_owned())
        .chain([TEXT_UNICODE.to_owned()])
        .collect();
    let registered = bridge::register(
        &w.deps,
        &b,
        RegisterIn {
            bridge_id: "PC-1".into(),
            version: "0.1.0".into(),
            protocol: 1,
            phones: vec![PhoneReport {
                platform: Platform::Android,
                serial: "SER1".into(),
                model: Some("Redmi 10C".into()),
                os_version: Some("13".into()),
                screen: None,
                features,
            }],
        },
    )
    .await
    .unwrap();
    let p = CapabilityId(registered.phones[0].capability_id);
    let agent = w.agent(&["devices.work"]).await;

    // Typed text, shell arguments and output, a tap's target and a failure's detail.
    round_trip(
        &w,
        &agent,
        &b,
        p,
        DeviceCommand::Text {
            value: "TYPED-CANARY şifre".into(),
        },
        |_| Outcome::Done {
            result: CommandResult::Done {},
        },
    )
    .await;
    let shell = round_trip(
        &w,
        &agent,
        &b,
        p,
        DeviceCommand::Shell {
            argv: vec!["echo".into(), "ARGV-CANARY".into()],
        },
        |_| Outcome::Done {
            result: CommandResult::shell(0, b"STDOUT-CANARY", b"STDERR-CANARY"),
        },
    )
    .await;
    round_trip(
        &w,
        &agent,
        &b,
        p,
        DeviceCommand::TapOn {
            target: ElementTarget::Text("TARGET-CANARY".into()),
            exact: true,
        },
        |_| Outcome::failed(FailReason::ElementNotFound, "DETAIL-CANARY"),
    )
    .await;

    // A screen read with its screenshot, whose answer carries a signed address.
    let png = b"\x89PNG\r\n\x1a\nPNG-CANARY";
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
    let observed = Observation {
        screen: Screen {
            w: 720,
            h: 1650,
            rotation: 0,
        },
        foreground_app: Some("APP-CANARY".into()),
        awake: None,
        locked: None,
        elements: vec![Element {
            text: Some("SCREEN-CANARY".into()),
            id: None,
            desc: Some("DESC-CANARY".into()),
            class: None,
            bounds: [0, 0, 10, 10],
            tap_point: [5, 5],
            clickable: true,
            editable: false,
            focused: false,
        }],
        truncated: false,
        screenshot_file_id: Some(shot),
    };
    let (seen, ()) = tokio::join!(
        agent::observe(
            &w.deps,
            &agent,
            p,
            ObserveInput {
                screenshot: true,
                wait_s: Some(10),
            }
        ),
        bridge_answers(&w, &b, |_| Outcome::Done {
            result: CommandResult::Observation(observed.clone()),
        }),
    );
    assert!(seen.unwrap().file_url.is_some());

    // A file pulled off the phone, then pushed back: its bytes, its paths and the signed download
    // address handed to the bridge.
    let pulled = bridge::files(
        &w.deps,
        &b,
        Some("application/octet-stream"),
        None,
        &mut Chunks::of(b"FILE-CANARY bytes"),
    )
    .await
    .unwrap()
    .file_id;
    round_trip(
        &w,
        &agent,
        &b,
        p,
        DeviceCommand::PullFile {
            path: "/sdcard/PULL-CANARY.bin".into(),
        },
        move |_| Outcome::Done {
            result: CommandResult::File { file_id: pulled },
        },
    )
    .await;
    round_trip(
        &w,
        &agent,
        &b,
        p,
        DeviceCommand::PushFile {
            file_id: pulled,
            dest: "/sdcard/DEST-CANARY.bin".into(),
        },
        |_| Outcome::Done {
            result: CommandResult::Done {},
        },
    )
    .await;

    // Queued and left waiting, then read; and refused before it was queued.
    let waiting = agent::act(
        &w.deps,
        &agent,
        p,
        ActInput {
            command: DeviceCommand::OpenUrl {
                url: "https://URL-CANARY.example/x".into(),
            },
            wait_s: Some(0),
        },
    )
    .await
    .unwrap();
    agent::command_get(
        &w.deps,
        &agent,
        waiting.command_id,
        WaitQuery { wait_s: Some(1) },
    )
    .await
    .unwrap();
    agent::command_get(&w.deps, &agent, shell.command_id, WaitQuery::default())
        .await
        .unwrap();
    agent::commands(&w.deps, &agent, p, LogQuery::default())
        .await
        .unwrap();
    agent::list(&w.deps, &agent).await.unwrap();
    let refused = agent::act(
        &w.deps,
        &agent,
        CapabilityId(Uuid::now_v7()),
        ActInput {
            command: DeviceCommand::Text {
                value: "REFUSED-CANARY".into(),
            },
            wait_s: Some(0),
        },
    )
    .await;
    assert!(refused.is_err());

    // A command its bridge took and never answered, then the sweeps: the expiry ends it (and the
    // one left waiting above), the purge deletes the files, the health job marks the phone
    // unreachable.
    agent::act(
        &w.deps,
        &agent,
        p,
        ActInput {
            command: DeviceCommand::Shell {
                argv: vec!["echo".into(), "SWEEP-CANARY".into()],
            },
            wait_s: Some(0),
        },
    )
    .await
    .unwrap();
    let leased = bridge::commands(
        &w.deps,
        &b,
        CommandsQuery {
            wait_s: 0,
            limit: 20,
        },
    )
    .await
    .unwrap();
    // The address left waiting above and the shell command, neither ever answered.
    assert_eq!(leased.commands.len(), 2);
    let week = FIXED_NOW + time::Duration::days(8);
    assert!(jobs::run_device_command_expiry(&w.deps, week).await.changed >= 2);
    assert!(jobs::run_device_file_purge(&w.deps, week).await.changed >= 2);
    assert_eq!(
        jobs::run_device_bridge_health(&w.deps, week).await.changed,
        1
    );

    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    // The subscriber saw the flow: ids, kinds and statuses were logged.
    for line in [
        "device command queued",
        "device command waited on",
        "device commands handed out",
        "device command results",
        "device file uploaded",
        "device command expired",
        "device file purged",
        "job=\"device_command_expiry\"",
        "job=\"device_file_purge\"",
        "job=\"device_bridge_health\"",
    ] {
        assert!(logs.contains(line), "`{line}` missing from:\n{logs}");
    }
    assert!(logs.contains("kind=\"shell\""), "{logs}");
    // Nothing a command or its result says.
    for secret in [
        "TYPED-CANARY",
        "şifre",
        "ARGV-CANARY",
        "STDOUT-CANARY",
        "STDERR-CANARY",
        "TARGET-CANARY",
        "DETAIL-CANARY",
        "PNG-CANARY",
        "APP-CANARY",
        "SCREEN-CANARY",
        "DESC-CANARY",
        "FILE-CANARY",
        "PULL-CANARY",
        "DEST-CANARY",
        "URL-CANARY",
        "REFUSED-CANARY",
        "SWEEP-CANARY",
        "files.example.com",
    ] {
        assert!(!logs.contains(secret), "`{secret}` was logged:\n{logs}");
    }
}
