//! The adapters' pure parts: configuration, cache keys, traces and the wire parsers.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use jeeta_voice_bridge::ari::{AriEvent, parse_event};
use jeeta_voice_bridge::cache::{PhraseCache, key};
use jeeta_voice_bridge::config::Config;
use jeeta_voice_bridge::media::{MediaEvent, command, parse_control};
use jeeta_voice_bridge::speech::{Endpoint, Heard};
use jeeta_voice_bridge::trace::{AudioClock, TraceFile, TurnMarks, read_traces};
use jt_calls::EndpointBy;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect();
    move |k| map.get(k).cloned()
}

#[test]
fn configuration_reads_the_environment_and_hides_secrets() {
    let c = Config::from_env(
        env(&[
            ("JEETA_BASE_URL", "http://127.0.0.1:8091"),
            ("JEETA_BRIDGE_KEY", "jeeta_secret"),
            ("ARI_PASSWORD", "ari-secret"),
            ("VOICE_ACK_MS", "500"),
        ]),
        true,
    )
    .unwrap();
    assert_eq!(c.extension, "102");
    assert_eq!(c.ari_url, "http://127.0.0.1:8188");
    assert_eq!(c.timing.ack_after_ms, 500);
    assert_eq!(
        c.listen,
        Endpoint::Unix("/run/jeeta-voice/listen/listen.sock".into())
    );
    let shown = format!("{c:?}");
    assert!(
        !shown.contains("jeeta_secret") && !shown.contains("ari-secret"),
        "{shown}"
    );
    assert!(Config::from_env(env(&[("ARI_PASSWORD", "x")]), true).is_err());
    assert!(Config::from_env(env(&[("ARI_PASSWORD", "x")]), false).is_ok());
}

#[test]
fn endpoints_parse() {
    assert_eq!(
        "tcp:127.0.0.1:7071".parse::<Endpoint>().unwrap(),
        Endpoint::Tcp("127.0.0.1:7071".into())
    );
    assert!("http://x".parse::<Endpoint>().is_err());
}

#[test]
fn the_cache_keeps_policy_sentences_on_disk_and_call_sentences_in_memory() {
    let dir = std::env::temp_dir().join(format!("voice-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut a = PhraseCache::new(dir.clone(), "ema-test");
    a.put("Hı hı.", vec![1, 2, 3], true);
    a.put("Ada Hanım ile mi görüşüyorum?", vec![4, 5], false);
    let mut b = PhraseCache::new(dir.clone(), "ema-test");
    assert_eq!(b.get("Hı hı.").as_deref(), Some(&vec![1i16, 2, 3]));
    assert_eq!(b.get("Ada Hanım ile mi görüşüyorum?"), None);
    assert_eq!(
        a.get("Ada Hanım ile mi görüşüyorum?").as_deref(),
        Some(&vec![4i16, 5])
    );
    assert_ne!(key("ema-test", "Hı hı."), key("ema-other", "Hı hı."));
    assert_eq!(key("v", "t").len(), 64);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_audio_clock_maps_positions_to_arrival() {
    let mut clock = AudioClock::default();
    let t0 = Instant::now();
    for i in 0..10u64 {
        clock.push(20, t0 + Duration::from_millis(20 * i));
    }
    assert_eq!(clock.position_ms(), 200);
    assert_eq!(clock.at(0), Some(t0));
    assert_eq!(clock.at(100), Some(t0 + Duration::from_millis(100)));
    assert_eq!(clock.at(119), Some(t0 + Duration::from_millis(100)));
    assert_eq!(clock.at(500), None);
}

#[test]
fn marks_become_a_trace_and_traces_go_to_their_file() {
    let t0 = Instant::now();
    let mut m = TurnMarks::new(
        t0,
        260,
        EndpointBy::SmartTurn,
        t0 + Duration::from_millis(310),
    );
    m.delivered = Some(t0 + Duration::from_millis(340));
    m.ack = Some(t0 + Duration::from_millis(620));
    m.first_audio = Some(t0 + Duration::from_millis(4_760));
    m.reply_seq = Some(4);
    let trace = m.trace();
    assert_eq!((trace.endpoint_ms, trace.stt_final_ms), (260, 310));
    assert_eq!(trace.reply_seq, Some(4));
    assert_eq!(
        (trace.ack_ms, trace.first_audio_ms),
        (Some(620), Some(4_760))
    );
    let path = std::env::temp_dir().join(format!("voice-traces-{}.jsonl", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let file = TraceFile::new(path.clone());
    file.append("c-1", &trace).unwrap();
    file.append("c-1", &trace).unwrap();
    let read = read_traces(&path, None).unwrap();
    assert_eq!(read, vec![trace.clone(), trace]);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains('+'), "{text}");
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn ari_events_are_read() {
    assert_eq!(
        parse_event(r#"{"type":"StasisStart","args":["out"],"channel":{"id":"c-1","state":"Up"}}"#),
        AriEvent::Answered {
            channel: "c-1".into(),
            inbound: false
        }
    );
    assert_eq!(
        parse_event(r#"{"type":"StasisStart","args":["in"],"channel":{"id":"x"}}"#),
        AriEvent::Answered {
            channel: "x".into(),
            inbound: true
        }
    );
    assert_eq!(
        parse_event(r#"{"type":"ChannelStateChange","channel":{"id":"c-1","state":"Ringing"}}"#),
        AriEvent::Ringing {
            channel: "c-1".into()
        }
    );
    assert_eq!(
        parse_event(r#"{"type":"ChannelDtmfReceived","digit":"5","channel":{"id":"c-1"}}"#),
        AriEvent::Dtmf {
            channel: "c-1".into(),
            digit: "5".into()
        }
    );
    assert_eq!(
        parse_event(r#"{"type":"ChannelDestroyed","cause":17,"channel":{"id":"c-1"}}"#),
        AriEvent::Gone {
            channel: "c-1".into(),
            cause: Some(17)
        }
    );
    assert_eq!(
        parse_event(r#"{"type":"StasisStart","args":[],"channel":{"id":"c-1-m"}}"#),
        AriEvent::Other
    );
    assert_eq!(parse_event("not json"), AriEvent::Other);
}

#[test]
fn media_control_is_read_and_written_as_json() {
    assert_eq!(
        parse_control(
            r#"{"event":"MEDIA_START","connection_id":"k","channel":"WebSocket/x","channel_id":"c-1-m","format":"alaw","optimal_frame_size":160,"ptime":20}"#
        ),
        MediaEvent::Start {
            format: "alaw".into(),
            frame_bytes: 160
        }
    );
    assert_eq!(
        parse_control(
            r#"{"event":"MEDIA_MARK_PROCESSED","channel_id":"c-1-m","correlation_id":"7:2"}"#
        ),
        MediaEvent::MarkProcessed {
            correlation: "7:2".into()
        }
    );
    assert_eq!(
        parse_control(r#"{"event":"MEDIA_XOFF","channel_id":"c"}"#),
        MediaEvent::Xoff
    );
    assert_eq!(
        parse_control(r#"{"event":"MEDIA_XON","channel_id":"c"}"#),
        MediaEvent::Xon
    );
    assert_eq!(command("FLUSH_MEDIA", None), r#"{"command":"FLUSH_MEDIA"}"#);
    assert_eq!(
        command("MARK_MEDIA", Some("7:2")),
        r#"{"command":"MARK_MEDIA","correlation_id":"7:2"}"#
    );
}

#[test]
fn listener_events_are_read_and_never_printed_with_their_words() {
    let h: Heard = serde_json::from_str(
        r#"{"type":"final","text":"evet perşembe","speech_end_ms":900,"endpoint_ms":1160,"endpoint_by":"smart_turn","stt_ms":45}"#,
    )
    .unwrap();
    assert!(matches!(
        h,
        Heard::Final {
            endpoint_ms: 1160,
            ..
        }
    ));
    assert!(!format!("{h:?}").contains("perşembe"));
    let s: Heard = serde_json::from_str(r#"{"type":"speech_start","audio_ms":420}"#).unwrap();
    assert!(matches!(s, Heard::SpeechStart { audio_ms: 420 }));
}

/// The speak service's `hello` names the voice the phrase cache keys by (B2 review); a service
/// that sends anything else first is no speaker.
#[tokio::test]
async fn the_speakers_hello_names_its_voice() {
    use futures_util::{SinkExt, StreamExt};
    use jeeta_voice_bridge::speech::{SpeechError, connect_speaker};
    use tokio_tungstenite::tungstenite::Message;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        for first in [
            r#"{"type":"hello","voice_id":"test-voice","sample_rate":8000,"format":"pcm16le"}"#,
            r#"{"type":"done","id":"x","synth_ms":1,"audio_ms":1}"#,
        ] {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.send(Message::Text(first.into())).await.unwrap();
            tokio::spawn(async move { while ws.next().await.is_some() {} });
        }
    });
    let (_socket, voice) = connect_speaker(&Endpoint::Tcp(addr.clone())).await.unwrap();
    assert_eq!(voice, "test-voice");
    assert!(matches!(
        connect_speaker(&Endpoint::Tcp(addr)).await,
        Err(SpeechError::NoHello)
    ));
}

/// The peer check (B3 review, I4): a unix socket whose peer runs as another user is refused, so a
/// service that took the other's socket name is never talked to. The uid is the socket file's
/// owner, this test's own user.
#[cfg(unix)]
#[tokio::test]
async fn a_unix_socket_held_by_another_user_is_refused() {
    use std::os::unix::fs::MetadataExt;

    use jeeta_voice_bridge::speech::{SpeechError, connect};

    let dir = std::env::temp_dir().join(format!("voice-peer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("service.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                    use futures_util::StreamExt;
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
