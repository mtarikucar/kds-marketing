//! The bridge's calls to Jeeta, against a fake Jeeta: the key on every route, the request header on
//! the posts, the long-poll's query, the bodies of `jt_calls::wire`; errors without the address.
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use jeeta_voice_bridge::jeeta::{ClientError, JeetaClient};
use jt_calls::BridgeEvent;
use jt_calls::wire::{
    CommandsQuery, EventIn, EventsInput, RegisterInput, SpeechToText, TextToSpeech,
};
use serde_json::{Value, json};
use time::OffsetDateTime;

type Seen = Arc<Mutex<Vec<String>>>;

fn header(h: &HeaderMap, name: &str) -> String {
    h.get(name)
        .map_or("-".into(), |v| v.to_str().unwrap().to_owned())
}

async fn fake_jeeta() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let app = Router::new()
        .route(
            "/api/voice/bridge/register",
            post(
                |State(s): State<Seen>, h: HeaderMap, Json(body): Json<Value>| async move {
                    if header(&h, "authorization") == "Bearer bad" {
                        return (StatusCode::FORBIDDEN, Json(json!({ "code": "FORBIDDEN" })))
                            .into_response();
                    }
                    s.lock().unwrap().push(format!(
                        "register {} {} {}",
                        header(&h, "authorization"),
                        header(&h, "x-requested-with"),
                        body["extension"]
                    ));
                    Json(json!({ "capability_id": "00000000-0000-0000-0000-000000000001", "status": "verified", "heartbeat_s": 15 }))
                        .into_response()
                },
            ),
        )
        .route(
            "/api/voice/bridge/commands",
            get(
                |State(s): State<Seen>, h: HeaderMap, Query(q): Query<Vec<(String, String)>>| async move {
                    s.lock()
                        .unwrap()
                        .push(format!("commands {q:?} {}", header(&h, "authorization")));
                    Json(json!({ "commands": [], "timed_out": true }))
                },
            ),
        )
        .route(
            "/api/voice/bridge/events",
            post(
                |State(s): State<Seen>, h: HeaderMap, Json(body): Json<Value>| async move {
                    s.lock().unwrap().push(format!(
                        "events {} {}",
                        body["events"][0]["kind"],
                        header(&h, "x-requested-with")
                    ));
                    Json(json!({ "accepted": 1, "duplicates": 0, "unmatched": 0 }))
                },
            ),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

fn register_input() -> RegisterInput {
    RegisterInput {
        extension: "102".into(),
        codecs: vec!["PCMA".into(), "PCMU".into()],
        max_calls: 1,
        stt: SpeechToText {
            engine: "seda".into(),
            model: "seda-v0.1".into(),
        },
        tts: TextToSpeech {
            engine: "ema".into(),
            voice: "ema-lightning-1.1.2".into(),
        },
        version: "0.1.0".into(),
    }
}

#[tokio::test]
async fn the_key_and_the_request_header_go_where_jeeta_expects_them() {
    let (base, seen) = fake_jeeta().await;
    let client = JeetaClient::new(&base, "jeeta_test_key");
    assert_eq!(
        client
            .register(&register_input())
            .await
            .unwrap()
            .heartbeat_s,
        15
    );
    let polled = client
        .commands(&CommandsQuery {
            wait_s: Some(25),
            extension: Some("102".into()),
        })
        .await
        .unwrap();
    assert!(polled.timed_out);
    let batch = EventsInput {
        events: vec![EventIn {
            bridge_call_id: "c-1".into(),
            bridge_seq: 1,
            at: OffsetDateTime::now_utc(),
            event: BridgeEvent::Ringing,
        }],
    };
    assert_eq!(client.events(&batch).await.unwrap().accepted, 1);
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen[0],
        "register Bearer jeeta_test_key jeeta-panel \"102\""
    );
    assert_eq!(
        seen[1],
        "commands [(\"wait_s\", \"25\"), (\"extension\", \"102\")] Bearer jeeta_test_key"
    );
    assert_eq!(seen[2], "events \"ringing\" jeeta-panel");
}

#[tokio::test]
async fn errors_carry_a_status_or_a_kind_and_never_the_address() {
    let (base, _) = fake_jeeta().await;
    let refused = JeetaClient::new(&base, "bad")
        .register(&register_input())
        .await
        .unwrap_err();
    assert!(matches!(refused, ClientError::Status(403)));
    assert!(!refused.retryable());
    let unreachable = JeetaClient::new("http://127.0.0.1:9", "k")
        .register(&register_input())
        .await
        .unwrap_err();
    assert!(matches!(unreachable, ClientError::Transport));
    assert!(unreachable.retryable());
    assert!(!unreachable.to_string().contains("127.0.0.1"));
}
