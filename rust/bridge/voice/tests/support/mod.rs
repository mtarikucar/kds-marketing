//! Fakes of Asterisk (ARI over HTTP, media over WebSocket) and of the two speech services.
#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

pub type Log = Arc<Mutex<Vec<String>>>;

/// A fake ARI REST surface; every request is logged as `METHOD path query`.
pub async fn fake_ari() -> (String, Log) {
    fake_ari_refusing_hangups(0).await
}

#[derive(Clone)]
struct Fake {
    log: Log,
    /// Channel hangups still to answer 500 (ARI briefly away).
    refusals: Arc<AtomicUsize>,
}

impl Fake {
    fn record(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }
}

/// As [`fake_ari`], but the first `refusals` channel hangups answer 500 (each logged all the same).
pub async fn fake_ari_refusing_hangups(refusals: usize) -> (String, Log) {
    let fake = Fake {
        log: Arc::default(),
        refusals: Arc::new(AtomicUsize::new(refusals)),
    };
    let log = fake.log.clone();
    let app = Router::new()
        .route(
            "/ari/channels",
            post(
                |State(f): State<Fake>, Query(q): Query<Vec<(String, String)>>| async move {
                    f.record(format!("POST /ari/channels {q:?}"));
                    axum::Json(json!({ "id": "c-1" }))
                },
            )
            .get(|| async { axum::Json(json!([])) }),
        )
        .route(
            "/ari/channels/externalMedia",
            post(|State(f): State<Fake>| async move {
                f.record("POST externalMedia".into());
                axum::Json(json!({}))
            }),
        )
        .route(
            "/ari/channels/{id}/variable",
            get(|| async { axum::Json(json!({ "value": "conn-1" })) }),
        )
        .route(
            "/ari/channels/{id}",
            delete(|State(f): State<Fake>, Path(id): Path<String>| async move {
                f.record(format!("DELETE channel {id}"));
                let refused = f
                    .refusals
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok();
                if refused {
                    StatusCode::INTERNAL_SERVER_ERROR
                } else {
                    StatusCode::NO_CONTENT
                }
            }),
        )
        .route("/ari/bridges", post(|| async { axum::Json(json!({})) }))
        .route(
            "/ari/bridges/{id}/addChannel",
            post(|| async { StatusCode::NO_CONTENT }),
        )
        .route(
            "/ari/bridges/{id}",
            delete(|| async { StatusCode::NO_CONTENT }),
        )
        .with_state(fake);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, log)
}

/// A WebSocket server handing every accepted connection to the test.
pub async fn ws_server() -> (String, mpsc::Receiver<WebSocketStream<TcpStream>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            if let Ok(ws) = tokio_tungstenite::accept_async(stream).await {
                let _ = tx.send(ws).await;
            }
        }
    });
    (addr, rx)
}

/// Says hello, then answers every `synth` on every connection with 160 samples of silence and `done`.
pub fn serve_speaker(conns: mpsc::Receiver<WebSocketStream<TcpStream>>) {
    serve_speaker_until(conns, None);
}

/// As [`serve_speaker`], but a connection asked to synthesise a text holding `dies_on` closes
/// instead (the speak service stopped during the call).
pub fn serve_speaker_until(
    mut conns: mpsc::Receiver<WebSocketStream<TcpStream>>,
    dies_on: Option<&'static str>,
) {
    tokio::spawn(async move {
        while let Some(mut ws) = conns.recv().await {
            tokio::spawn(async move {
                let hello = json!({ "type": "hello", "voice_id": "test-voice", "sample_rate": 8000, "format": "pcm16le" });
                let _ = ws.send(Message::Text(hello.to_string().into())).await;
                while let Some(Ok(Message::Text(t))) = ws.next().await {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["type"] == "synth" {
                        let text = v["text"].as_str().unwrap_or_default();
                        if dies_on.is_some_and(|d| text.contains(d)) {
                            let _ = ws.close(None).await;
                            return;
                        }
                        let _ = ws.send(Message::Binary(vec![0u8; 320].into())).await;
                        let done =
                            json!({ "type": "done", "id": v["id"], "synth_ms": 5, "audio_ms": 20 });
                        let _ = ws.send(Message::Text(done.to_string().into())).await;
                    }
                }
            });
        }
    });
}

/// Starts the media of the first connection (`MEDIA_START`, A-law) and answers each `MARK_MEDIA`
/// with `MEDIA_MARK_PROCESSED`; the control commands it received go to the returned channel, with
/// `silence frame` the first time a frame of all 0xD5 arrives and `frame of N bytes` for any frame
/// that is not 160 bytes.
pub fn serve_media(conns: mpsc::Receiver<WebSocketStream<TcpStream>>) -> mpsc::Receiver<String> {
    serve_media_with(conns, MediaFake::default())
}

/// How the fake media behaves.
#[derive(Clone, Copy, Default)]
pub struct MediaFake {
    /// The media closes this long after its start (Asterisk restarted, the media channel failed).
    pub closes_after: Option<Duration>,
    /// Each mark is answered this much later: the sentence before it takes that long to play.
    pub mark_delay: Option<Duration>,
}

/// As [`serve_media`], as `fake` says.
pub fn serve_media_with(
    mut conns: mpsc::Receiver<WebSocketStream<TcpStream>>,
    fake: MediaFake,
) -> mpsc::Receiver<String> {
    let MediaFake {
        closes_after,
        mark_delay,
    } = fake;
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        let Some(mut ws) = conns.recv().await else {
            return;
        };
        let start = json!({ "event": "MEDIA_START", "connection_id": "conn-1", "channel": "WebSocket/x",
            "channel_id": "c-1-m", "format": "alaw", "optimal_frame_size": 160, "ptime": 20 });
        ws.send(Message::Text(start.to_string().into()))
            .await
            .unwrap();
        if let Some(after) = closes_after {
            tokio::time::sleep(after).await;
            let _ = ws.close(None).await;
            return;
        }
        let mut silence_seen = false;
        while let Some(Ok(msg)) = ws.next().await {
            match msg {
                // 50 frames a second: reported once (the first silence) or when one is not whole.
                Message::Binary(b) => {
                    if !silence_seen && b.iter().all(|&x| x == 0xD5) {
                        silence_seen = true;
                        let _ = tx.try_send("silence frame".to_owned());
                    }
                    if b.len() != 160 {
                        let _ = tx.try_send(format!("frame of {} bytes", b.len()));
                    }
                }
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    let name = v["command"].as_str().unwrap_or_default().to_owned();
                    if name == "MARK_MEDIA" {
                        if let Some(delay) = mark_delay {
                            tokio::time::sleep(delay).await;
                        }
                        let done = json!({ "event": "MEDIA_MARK_PROCESSED", "channel_id": "c-1-m",
                            "correlation_id": v["correlation_id"] });
                        ws.send(Message::Text(done.to_string().into()))
                            .await
                            .unwrap();
                    }
                    let _ = tx.send(name).await;
                }
                _ => {}
            }
        }
    });
    rx
}
