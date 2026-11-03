//! The line end to end against a fake Jeeta and a fake ARI: a Turkish dial reaches the PBX, a
//! foreign one is refused as a failure, every command is acknowledged, the bridge registers; and
//! each report carries the time it happened, not the time it was posted.
mod support;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use jeeta_voice_bridge::config::Config;
use jeeta_voice_bridge::run_loop::run;
use jt_calls::wire::BridgeCommand;
use jt_calls::{CallCommandId, CallId, CallPlan, Command, DialScript};
use serde_json::{Value, json};
use support::{fake_ari, fake_ari_leaving, serve_speaker, ws_server};
use time::OffsetDateTime;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use uuid::Uuid;

type Seen = Arc<Mutex<Vec<String>>>;
type Ats = Arc<Mutex<Vec<OffsetDateTime>>>;
type Queue = Arc<Mutex<Option<Vec<BridgeCommand>>>>;

/// The fake Jeeta's state: what it saw, the events' times, its first poll's commands, and how
/// long an events post takes.
#[derive(Clone)]
struct Jeeta {
    seen: Seen,
    ats: Ats,
    queue: Queue,
    events_take: Duration,
}

fn plan() -> CallPlan {
    serde_json::from_value(json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "test", "holding": ["Bir saniye."],
        "closing": "Görüşmek üzere, iyi günler.", "max_duration_s": 120,
    }))
    .unwrap()
}

fn command(call: &str, command: Command) -> BridgeCommand {
    BridgeCommand::of(
        CallCommandId(Uuid::now_v7()),
        CallId(Uuid::now_v7()),
        Some(call.into()),
        &command,
    )
}

fn dial(call: &str, to: &str) -> BridgeCommand {
    command(
        call,
        Command::Dial {
            to_e164: to.into(),
            plan: plan(),
            script: DialScript::default(),
        },
    )
}

/// A fake Jeeta whose first poll hands out `first`, and every later one waits 200 ms for nothing;
/// what the bridge registered and reported is logged as `register <extension>` and
/// `<bridge_call_id> <kind>`.
async fn fake_jeeta(first: Vec<BridgeCommand>) -> (String, Seen) {
    let (base, seen, _) = fake_jeeta_with(first, Duration::ZERO).await;
    (base, seen)
}

/// As [`fake_jeeta`], each events post taking `events_take`; the events' `at` are kept too.
async fn fake_jeeta_with(first: Vec<BridgeCommand>, events_take: Duration) -> (String, Seen, Ats) {
    let state = Jeeta {
        seen: Arc::default(),
        ats: Arc::default(),
        queue: Arc::new(Mutex::new(Some(first))),
        events_take,
    };
    let (seen, ats) = (state.seen.clone(), state.ats.clone());
    let app = Router::new()
        .route(
            "/api/voice/bridge/register",
            post(|State(j): State<Jeeta>, Json(b): Json<Value>| async move {
                j.seen
                    .lock()
                    .unwrap()
                    .push(format!("register {}", b["extension"].as_str().unwrap()));
                Json(json!({ "capability_id": "00000000-0000-0000-0000-000000000001", "status": "verified", "heartbeat_s": 15 }))
            }),
        )
        .route(
            "/api/voice/bridge/commands",
            get(|State(j): State<Jeeta>| async move {
                let next = j.queue.lock().unwrap().take();
                match next {
                    Some(commands) => Json(json!({ "commands": commands, "timed_out": false })),
                    None => {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        Json(json!({ "commands": [], "timed_out": true }))
                    }
                }
            }),
        )
        .route(
            "/api/voice/bridge/events",
            post(|State(j): State<Jeeta>, Json(b): Json<Value>| async move {
                tokio::time::sleep(j.events_take).await;
                for e in b["events"].as_array().unwrap() {
                    j.seen.lock().unwrap().push(format!(
                        "{} {}",
                        e["bridge_call_id"].as_str().unwrap(),
                        e["kind"].as_str().unwrap()
                    ));
                    let at = e["at"].as_str().unwrap();
                    j.ats.lock().unwrap().push(
                        OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
                            .unwrap(),
                    );
                }
                Json(json!({ "accepted": 1, "duplicates": 0, "unmatched": 0 }))
            }),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen, ats)
}

/// The speech services a dial waits for (B6 as built): a listener that takes the connection
/// (its connections are kept open by the returned receiver), and a speaker that says hello.
async fn speech() -> (String, String, mpsc::Receiver<WebSocketStream<TcpStream>>) {
    let (listen_addr, listen_conns) = ws_server().await;
    let (speak_addr, speak_conns) = ws_server().await;
    serve_speaker(speak_conns);
    (listen_addr, speak_addr, listen_conns)
}

/// The line's configuration against the fakes, its files in a directory of `name`'s.
fn config(name: &str, jeeta: &str, ari: &str, listen: &str, speak: &str) -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("voice-run-{name}-{}", std::process::id()));
    let env: HashMap<&str, String> = HashMap::from([
        ("JEETA_BASE_URL", jeeta.to_owned()),
        ("JEETA_BRIDGE_KEY", "jeeta_test".into()),
        ("ARI_URL", ari.to_owned()),
        ("ARI_PASSWORD", "p".into()),
        ("LISTEN_SOCKET", format!("tcp:{listen}")),
        ("SPEAK_SOCKET", format!("tcp:{speak}")),
        ("VOICE_CACHE_DIR", dir.join("cache").display().to_string()),
        (
            "VOICE_TRACE_FILE",
            dir.join("traces.jsonl").display().to_string(),
        ),
        (
            "VOICE_DIAL_LOG",
            dir.join("dials.log").display().to_string(),
        ),
    ]);
    std::fs::create_dir_all(&dir).unwrap();
    (
        Config::from_env(|k| env.get(k).cloned(), true).unwrap(),
        dir,
    )
}

/// Runs the line `for_how_long`, then stops it and waits for it to end.
async fn run_for(config: Config, for_how_long: Duration) {
    let (stop_tx, stop_rx) = watch::channel(false);
    let task = tokio::spawn(run(config, stop_rx));
    tokio::time::sleep(for_how_long).await;
    stop_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(8), task)
        .await
        .unwrap()
        .unwrap()
        .expect("the line started");
}

#[tokio::test]
async fn a_dial_reaches_the_pbx_and_every_command_is_acknowledged() {
    let (ari_base, ari_log) = fake_ari().await;
    let (jeeta_base, seen) = fake_jeeta(vec![
        dial("call-de", "+4915112345678"),
        dial("call-tr", "+905321234567"),
    ])
    .await;
    let (listen, speak, _listen_conns) = speech().await;
    let (config, dir) = config("dial", &jeeta_base, &ari_base, &listen, &speak);
    run_for(config, Duration::from_millis(1_500)).await;
    let ari = ari_log.lock().unwrap().join("\n");
    assert!(ari.contains("PJSIP/05321234567@netgsm"), "{ari}");
    assert!(!ari.contains("4915112345678"), "{ari}");
    let seen = seen.lock().unwrap().clone();
    assert!(seen.contains(&"register 102".to_owned()), "{seen:?}");
    assert!(seen.contains(&"call-de error".to_owned()), "{seen:?}");
    assert_eq!(
        seen.iter().filter(|e| e.ends_with("command_done")).count(),
        2,
        "{seen:?}"
    );
    // Stopped while it rang: hung up, and reported (review of D, M1: no call ends unheard).
    assert!(ari.contains("DELETE channel call-tr"), "{ari}");
    assert!(seen.contains(&"call-tr error".to_owned()), "{seen:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_call_left_from_before_is_hung_up_and_reported() {
    // A crash or a restart left a call on Asterisk: the next run hangs both of its channels up
    // and reports the call failed, once (its `-m` media channel is the same call's).
    let (ari_base, ari_log) = fake_ari_leaving(&["call-old", "call-old-m"]).await;
    let (jeeta_base, seen) = fake_jeeta(Vec::new()).await;
    let (listen, speak, _listen_conns) = speech().await;
    let (config, dir) = config("sweep", &jeeta_base, &ari_base, &listen, &speak);
    run_for(config, Duration::from_millis(1_000)).await;
    let ari = ari_log.lock().unwrap().clone();
    assert!(
        ari.contains(&"DELETE channel call-old".to_owned()),
        "{ari:?}"
    );
    assert!(
        ari.contains(&"DELETE channel call-old-m".to_owned()),
        "{ari:?}"
    );
    let seen = seen.lock().unwrap().clone();
    assert!(seen.contains(&"call-old error".to_owned()), "{seen:?}");
    assert!(
        !seen.iter().any(|e| e.starts_with("call-old-m")),
        "{seen:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_command_for_a_call_not_on_the_line_is_reported() {
    // A sentence for a call this line does not carry (the line restarted under it): the core hears
    // the call failed instead of a sentence played. A hangup of one has nothing left to do. Both
    // are acknowledged, so neither is handed out again.
    let (ari_base, _) = fake_ari().await;
    let say = Command::Say {
        seq: 4,
        text: "Perşembe uygun mu?".into(),
        allow_barge_in: true,
    };
    let (jeeta_base, seen) = fake_jeeta(vec![
        command("call-ghost", say),
        command("call-gone", Command::Hangup),
    ])
    .await;
    let (listen, speak, _listen_conns) = speech().await;
    let (config, dir) = config("unknown", &jeeta_base, &ari_base, &listen, &speak);
    run_for(config, Duration::from_millis(1_000)).await;
    let seen = seen.lock().unwrap().clone();
    for line in [
        "call-ghost error",
        "call-ghost command_done",
        "call-gone command_done",
    ] {
        assert!(seen.contains(&line.to_owned()), "{line}: {seen:?}");
    }
    assert!(!seen.contains(&"call-gone error".to_owned()), "{seen:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn reports_keep_the_time_they_happened() {
    // Two refused dials make four reports at once; the core takes 700 ms over each. Stamped when
    // posted, the last would read about two seconds after the first (review of D, L4).
    let (ari_base, _) = fake_ari().await;
    let (jeeta_base, _, ats) = fake_jeeta_with(
        vec![
            dial("call-de", "+4915112345678"),
            dial("call-fr", "+33612345678"),
        ],
        Duration::from_millis(700),
    )
    .await;
    let (listen, speak, _listen_conns) = speech().await;
    let (config, dir) = config("at", &jeeta_base, &ari_base, &listen, &speak);
    run_for(config, Duration::from_millis(3_500)).await;
    let ats = ats.lock().unwrap().clone();
    assert_eq!(ats.len(), 4, "{ats:?}");
    let spread = *ats.iter().max().unwrap() - *ats.iter().min().unwrap();
    assert!(spread < time::Duration::milliseconds(500), "{spread}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_hangup_frees_the_line_for_the_next_dial() {
    // The core asked call-a to hang up; it closes on its own (here it was ringing), and a dial that
    // comes meanwhile is not refused as busy (review of D, L6).
    let (ari_base, ari_log) = fake_ari().await;
    let (jeeta_base, seen) = fake_jeeta(vec![
        dial("call-a", "+905321234567"),
        command("call-a", Command::Hangup),
        dial("call-b", "+905321234568"),
    ])
    .await;
    let (listen, speak, _listen_conns) = speech().await;
    let (config, dir) = config("free", &jeeta_base, &ari_base, &listen, &speak);
    run_for(config, Duration::from_millis(1_500)).await;
    let ari = ari_log.lock().unwrap().join("\n");
    // call-b was dialled, not refused as busy.
    assert!(ari.contains("\"call-b\""), "{ari}");
    assert!(
        seen.lock()
            .unwrap()
            .contains(&"call-b command_done".to_owned())
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_dial_handed_out_again_after_a_restart_rings_nobody() {
    // A dial whose acknowledgement was lost before a restart, handed out again by a core that
    // re-hands dials: the dial log holds its id, so the next run rings nobody (review of D, M2).
    // The log holds command ids only, never a number.
    let again = dial("call-tr", "+905321234567");
    let (listen, speak, _listen_conns) = speech().await;
    let (ari_base, first_ari) = fake_ari().await;
    let (jeeta_base, _) = fake_jeeta(vec![again.clone()]).await;
    let (first, dir) = config("restart", &jeeta_base, &ari_base, &listen, &speak);
    run_for(first, Duration::from_millis(1_000)).await;
    assert!(
        first_ari
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.starts_with("POST /ari/channels"))
    );
    let (ari_base, second_ari) = fake_ari().await;
    let (jeeta_base, seen) = fake_jeeta(vec![again.clone()]).await;
    let (second, _) = config("restart", &jeeta_base, &ari_base, &listen, &speak);
    run_for(second, Duration::from_millis(1_000)).await;
    let ari = second_ari.lock().unwrap().join("\n");
    assert!(!ari.contains("POST /ari/channels"), "{ari}");
    assert!(
        seen.lock()
            .unwrap()
            .contains(&"call-tr command_done".to_owned())
    );
    let log = std::fs::read_to_string(dir.join("dials.log")).unwrap();
    assert_eq!(log.lines().collect::<Vec<_>>(), [again.id.0.to_string()]);
    let _ = std::fs::remove_dir_all(dir);
}
