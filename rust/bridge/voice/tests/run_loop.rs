//! The line end to end against a fake Jeeta and a fake ARI: a Turkish dial reaches the PBX, a
//! foreign one is refused as a failure, every command is acknowledged, the bridge registers.
mod support;

use std::collections::HashMap;
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
use support::{fake_ari, serve_speaker, ws_server};
use tokio::sync::watch;
use uuid::Uuid;

type Seen = Arc<Mutex<Vec<String>>>;
type Queue = Arc<Mutex<Option<Vec<BridgeCommand>>>>;

fn plan() -> CallPlan {
    serde_json::from_value(json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "test", "holding": ["Bir saniye."],
        "closing": "Görüşmek üzere, iyi günler.", "max_duration_s": 120,
    }))
    .unwrap()
}

fn dial(call: &str, to: &str) -> BridgeCommand {
    BridgeCommand::of(
        CallCommandId(Uuid::now_v7()),
        CallId(Uuid::now_v7()),
        Some(call.into()),
        &Command::Dial {
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
    let seen: Seen = Arc::default();
    let queue: Queue = Arc::new(Mutex::new(Some(first)));
    let app = Router::new()
        .route(
            "/api/voice/bridge/register",
            post(
                |State((s, _)): State<(Seen, Queue)>, Json(b): Json<Value>| async move {
                    s.lock()
                        .unwrap()
                        .push(format!("register {}", b["extension"].as_str().unwrap()));
                    Json(json!({ "capability_id": "00000000-0000-0000-0000-000000000001", "status": "verified", "heartbeat_s": 15 }))
                },
            ),
        )
        .route(
            "/api/voice/bridge/commands",
            get(|State((_, q)): State<(Seen, Queue)>| async move {
                let next = q.lock().unwrap().take();
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
            post(
                |State((s, _)): State<(Seen, Queue)>, Json(b): Json<Value>| async move {
                    for e in b["events"].as_array().unwrap() {
                        s.lock().unwrap().push(format!(
                            "{} {}",
                            e["bridge_call_id"].as_str().unwrap(),
                            e["kind"].as_str().unwrap()
                        ));
                    }
                    Json(json!({ "accepted": 1, "duplicates": 0, "unmatched": 0 }))
                },
            ),
        )
        .with_state((seen.clone(), queue));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

#[tokio::test]
async fn a_dial_reaches_the_pbx_and_every_command_is_acknowledged() {
    let (ari_base, ari_log) = fake_ari().await;
    let (jeeta_base, seen) = fake_jeeta(vec![
        dial("call-de", "+4915112345678"),
        dial("call-tr", "+905321234567"),
    ])
    .await;
    let dir = std::env::temp_dir().join(format!("voice-run-{}", std::process::id()));
    // B6 dials only once both speech services answer (B6 as built): a listener that takes the
    // connection, and a speaker that says hello.
    let (listen_addr, _listen_conns) = ws_server().await;
    let (speak_addr, speak_conns) = ws_server().await;
    serve_speaker(speak_conns);
    let env: HashMap<&str, String> = HashMap::from([
        ("JEETA_BASE_URL", jeeta_base),
        ("JEETA_BRIDGE_KEY", "jeeta_test".into()),
        ("ARI_URL", ari_base),
        ("ARI_PASSWORD", "p".into()),
        ("LISTEN_SOCKET", format!("tcp:{listen_addr}")),
        ("SPEAK_SOCKET", format!("tcp:{speak_addr}")),
        ("VOICE_CACHE_DIR", dir.join("cache").display().to_string()),
        (
            "VOICE_TRACE_FILE",
            dir.join("traces.jsonl").display().to_string(),
        ),
    ]);
    let config = Config::from_env(|k| env.get(k).cloned(), true).unwrap();
    let (stop_tx, stop_rx) = watch::channel(false);
    let task = tokio::spawn(run(config, stop_rx));
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    stop_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(8), task)
        .await
        .unwrap()
        .unwrap();
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
    let _ = std::fs::remove_dir_all(dir);
}
