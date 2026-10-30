//! Reaching the local services: the speak service's `hello`, the unix peer check, and a service
//! that never answers (each connect gives up within seconds, so a stuck service cannot hold a
//! call's media back, or `check`, until its watchdog).
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use jeeta_voice_bridge::ari::{Ari, AriError};
use jeeta_voice_bridge::speech::{
    CONNECT_WAIT, Endpoint, SPEAK_UID, SpeechError, connect, connect_speaker,
};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// A WebSocket server whose connections each send `first`, in turn, then read until closed.
async fn serve_firsts(firsts: Vec<&'static str>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        for first in firsts {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.send(Message::Text(first.into())).await.unwrap();
            tokio::spawn(async move { while ws.next().await.is_some() {} });
        }
    });
    addr
}

/// The speak service's `hello` names the voice the phrase cache keys by (B2 review); a service
/// that sends anything else first, or audio the bridge cannot play (B5 review), is no speaker.
#[tokio::test]
async fn the_speakers_hello_names_its_voice_and_its_audio() {
    let addr = serve_firsts(vec![
        r#"{"type":"hello","voice_id":"test-voice","sample_rate":8000,"format":"pcm16le"}"#,
        r#"{"type":"done","id":"x","synth_ms":1,"audio_ms":1}"#,
        r#"{"type":"hello","voice_id":"test-voice","sample_rate":16000,"format":"pcm16le"}"#,
        r#"{"type":"hello","voice_id":"test-voice","sample_rate":8000,"format":"f32le"}"#,
        r#"{"type":"hello","voice_id":"test-voice"}"#,
    ])
    .await;
    let (_socket, voice) = connect_speaker(&Endpoint::Tcp(addr.clone())).await.unwrap();
    assert_eq!(voice, "test-voice");
    for _ in 0..4 {
        assert!(matches!(
            connect_speaker(&Endpoint::Tcp(addr.clone())).await,
            Err(SpeechError::NoHello)
        ));
    }
}

/// A listener that never accepts: the system completes the TCP handshake into its backlog, and
/// nothing ever answers the WebSocket's.
async fn silent() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    (listener, addr)
}

/// B5 review: a service that takes the connection and never answers is unreachable after
/// [`CONNECT_WAIT`], not a call held up until its watchdog.
#[tokio::test]
async fn a_speech_service_that_never_answers_is_unreachable_within_seconds() {
    let (_held, addr) = silent().await;
    let started = Instant::now();
    let endpoint = Endpoint::Tcp(addr);
    let limit = CONNECT_WAIT + Duration::from_secs(3);
    let listen = tokio::time::timeout(limit, connect(&endpoint, SPEAK_UID))
        .await
        .expect("connect gives up on its own");
    assert!(matches!(listen, Err(SpeechError::Unreachable)));
    let speak = tokio::time::timeout(limit, connect_speaker(&endpoint))
        .await
        .expect("connect_speaker gives up on its own");
    assert!(matches!(speak, Err(SpeechError::Unreachable)));
    assert!(started.elapsed() >= CONNECT_WAIT);
}

/// B5 review: the same for ARI's WebSockets (events, media).
#[tokio::test]
async fn ari_that_never_answers_its_websocket_is_unreachable_within_seconds() {
    let (_held, addr) = silent().await;
    let ari = Ari::new(&format!("http://{addr}"), "u", "p").unwrap();
    let limit = CONNECT_WAIT + Duration::from_secs(3);
    let events = tokio::time::timeout(limit, ari.events())
        .await
        .expect("events gives up on its own");
    assert!(matches!(events, Err(AriError::Transport)));
    let media = tokio::time::timeout(limit, ari.media("conn-1"))
        .await
        .expect("media gives up on its own");
    assert!(matches!(media, Err(AriError::Transport)));
}

/// The peer check (B3 review, I4): a unix socket whose peer runs as another user is refused, so a
/// service that took the other's socket name is never talked to. The uid is the socket file's
/// owner, this test's own user.
#[cfg(unix)]
#[tokio::test]
async fn a_unix_socket_held_by_another_user_is_refused() {
    use std::os::unix::fs::MetadataExt;

    let dir = std::env::temp_dir().join(format!("voice-peer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("service.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                    while ws.next().await.is_some() {}
                }
            });
        }
    });
    let own = std::fs::metadata(&path).unwrap().uid();
    assert!(connect(&Endpoint::Unix(path.clone()), own).await.is_ok());
    assert!(matches!(
        connect(&Endpoint::Unix(path.clone()), own.wrapping_add(1)).await,
        Err(SpeechError::WrongPeer)
    ));
    std::fs::remove_dir_all(&dir).unwrap();
}
