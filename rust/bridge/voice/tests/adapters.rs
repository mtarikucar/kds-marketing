//! The adapters' pure parts: configuration, cache keys, traces and the wire parsers.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use jeeta_voice_bridge::ari::{AriEvent, parse_event};
use jeeta_voice_bridge::cache::{PhraseCache, key};
use jeeta_voice_bridge::config::{Config, ConfigError};
use jeeta_voice_bridge::media::{MediaEvent, command, parse_control};
use jeeta_voice_bridge::speech::{Endpoint, Heard};
use jeeta_voice_bridge::trace::{AudioClock, TraceFile, TurnMarks, read_traces};
use jt_calls::{EndpointBy, TurnTrace};
use serde_json::json;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect();
    move |k| map.get(k).cloned()
}

/// A fresh temporary path of this test process.
fn temp(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("voice-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    let _ = std::fs::remove_file(&path);
    path
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

/// B5 review: an empty value is an unset one (`VOICE_CACHE_DIR=` is not the working directory).
#[test]
fn configuration_defaults_hold_and_an_empty_value_is_unset() {
    let c = Config::from_env(
        env(&[
            ("ARI_PASSWORD", "x"),
            ("VOICE_CACHE_DIR", ""),
            ("VOICE_EXTENSION", " "),
            ("LISTEN_SOCKET", ""),
            ("VOICE_ACK_MS", ""),
        ]),
        false,
    )
    .unwrap();
    assert_eq!(c.extension, "102");
    assert_eq!(c.cache_dir, Path::new("/var/lib/jeeta-voice/cache"));
    assert_eq!(c.trace_file, Path::new("/var/lib/jeeta-voice/traces.jsonl"));
    assert_eq!(
        c.listen,
        Endpoint::Unix("/run/jeeta-voice/listen/listen.sock".into())
    );
    assert_eq!(
        c.speak,
        Endpoint::Unix("/run/jeeta-voice/speak.sock".into())
    );
    assert_eq!(c.timing, jeeta_voice_bridge::talker::Timing::default());
    assert_eq!(c.max_call_s, 600);
    assert!(matches!(
        Config::from_env(env(&[("ARI_PASSWORD", "")]), false),
        Err(ConfigError::Missing("ARI_PASSWORD"))
    ));
    assert!(matches!(
        Config::from_env(
            env(&[
                ("ARI_PASSWORD", "x"),
                ("JEETA_BASE_URL", "http://127.0.0.1:8091"),
                ("JEETA_BRIDGE_KEY", "")
            ]),
            true
        ),
        Err(ConfigError::Missing("JEETA_BRIDGE_KEY"))
    ));
}

/// B5 review: timings the talker cannot keep are refused, not silently skipped (an
/// acknowledgement at or after the filler never plays).
#[test]
fn configuration_refuses_what_the_bridge_cannot_use() {
    let refused = |pairs: &[(&str, &str)]| {
        let mut all = vec![("ARI_PASSWORD", "x")];
        all.extend_from_slice(pairs);
        Config::from_env(env(&all), false).unwrap_err()
    };
    assert!(matches!(
        refused(&[("VOICE_ACK_MS", "soon")]),
        ConfigError::Invalid("VOICE_ACK_MS")
    ));
    assert!(matches!(
        refused(&[("LISTEN_SOCKET", "unix:listen.sock")]),
        ConfigError::Invalid("LISTEN_SOCKET")
    ));
    assert!(matches!(
        refused(&[("SPEAK_SOCKET", "tcp:10.0.0.5:9000")]),
        ConfigError::Invalid("SPEAK_SOCKET")
    ));
    assert!(matches!(
        refused(&[("VOICE_ACK_MS", "2700")]),
        ConfigError::Order("VOICE_ACK_MS", "VOICE_FILLER_MS")
    ));
    assert!(matches!(
        refused(&[("VOICE_FILLER_MS", "8000")]),
        ConfigError::Order("VOICE_FILLER_MS", "VOICE_LONG_WAIT_MS")
    ));
    assert!(matches!(
        refused(&[("VOICE_LONG_WAIT_MS", "20000")]),
        ConfigError::TooLarge("VOICE_LONG_WAIT_MS", 20_000)
    ));
    assert!(matches!(
        refused(&[("VOICE_STILL_THERE_MS", "15000")]),
        ConfigError::TooLarge("VOICE_STILL_THERE_MS", 15_000)
    ));
    assert!(matches!(
        refused(&[("VOICE_PHRASE_GAP_MS", "2000")]),
        ConfigError::TooLarge("VOICE_PHRASE_GAP_MS", 2_000)
    ));
    // B6 review D: a call's longest duration is 1 s to an hour.
    for bad in ["0", "3601", "long"] {
        assert!(matches!(
            refused(&[("VOICE_MAX_CALL_S", bad)]),
            ConfigError::Invalid("VOICE_MAX_CALL_S")
        ));
    }
    let short = Config::from_env(
        env(&[("ARI_PASSWORD", "x"), ("VOICE_MAX_CALL_S", "150")]),
        false,
    )
    .unwrap();
    assert_eq!(short.max_call_s, 150);
    let edge = Config::from_env(
        env(&[
            ("ARI_PASSWORD", "x"),
            ("VOICE_ACK_MS", "0"),
            ("VOICE_FILLER_MS", "1"),
            ("VOICE_LONG_WAIT_MS", "19999"),
            ("VOICE_STILL_THERE_MS", "14999"),
            ("VOICE_PHRASE_GAP_MS", "1999"),
        ]),
        false,
    );
    assert!(edge.is_ok(), "{edge:?}");
}

/// B5 review: the rules of the speech services' own `parse_endpoint` (B2, B3): an absolute unix
/// path, or TCP on loopback with a port.
#[test]
fn endpoints_parse() {
    assert_eq!(
        "tcp:127.0.0.1:7071".parse::<Endpoint>().unwrap(),
        Endpoint::Tcp("127.0.0.1:7071".into())
    );
    assert_eq!(
        "tcp:[::1]:9000".parse::<Endpoint>().unwrap(),
        Endpoint::Tcp("[::1]:9000".into())
    );
    assert_eq!(
        "tcp:localhost:9000".parse::<Endpoint>().unwrap(),
        Endpoint::Tcp("localhost:9000".into())
    );
    for unix in [
        "unix:/run/jeeta-voice/speak.sock",
        "/run/jeeta-voice/speak.sock",
    ] {
        assert_eq!(
            unix.parse::<Endpoint>().unwrap(),
            Endpoint::Unix("/run/jeeta-voice/speak.sock".into()),
            "{unix}"
        );
    }
    for bad in [
        "http://x",
        "tcp:0.0.0.0:9000",
        "tcp:10.0.0.5:9000",
        "tcp:example.com:80",
        "tcp:127.0.0.1:x",
        "tcp:127.0.0.1:70000",
        "tcp:127.0.0.1:0",
        "tcp:127.0.0.1",
        "speak.sock",
        "unix:speak.sock",
        "unix:",
        "",
    ] {
        assert!(bad.parse::<Endpoint>().is_err(), "{bad}");
    }
}

#[test]
fn the_cache_keeps_policy_sentences_on_disk_and_call_sentences_in_memory() {
    let dir = temp("cache");
    let mut a = PhraseCache::new(dir.clone(), "ema-test");
    a.put("ema-test", "Hı hı.", vec![1, 2, 3], true).unwrap();
    a.put(
        "ema-test",
        "Ada Hanım ile mi görüşüyorum?",
        vec![4, 5],
        false,
    )
    .unwrap();
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

/// B5 review: a file a crash left empty or cut short would play as nothing, for good. It is a miss,
/// and it is removed so the sentence is synthesised and filed again.
#[test]
fn an_empty_or_odd_file_on_disk_is_a_miss_and_is_removed() {
    let dir = temp("cache-short");
    std::fs::create_dir_all(&dir).unwrap();
    let empty = dir.join(format!("{}.pcm", key("v", "Tamam.")));
    let odd = dir.join(format!("{}.pcm", key("v", "Peki.")));
    std::fs::write(&empty, b"").unwrap();
    std::fs::write(&odd, [1u8, 0, 2]).unwrap();
    let mut c = PhraseCache::new(dir.clone(), "v");
    assert_eq!(c.get("Tamam."), None);
    assert_eq!(c.get("Peki."), None);
    assert!(!empty.exists() && !odd.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// B5 review: every writer has a temporary file of its own, so one never renames another's
/// half-written file into place.
#[test]
fn a_writer_never_touches_another_writers_temporary_file() {
    let dir = temp("cache-tmp");
    std::fs::create_dir_all(&dir).unwrap();
    let k = key("v", "Hı hı.");
    let theirs = dir.join(format!("{k}.tmp"));
    std::fs::write(&theirs, b"half").unwrap();
    PhraseCache::new(dir.clone(), "v")
        .put("v", "Hı hı.", vec![1, 2, 3], true)
        .unwrap();
    assert_eq!(std::fs::read(&theirs).unwrap(), b"half");
    assert_eq!(
        PhraseCache::new(dir.clone(), "v").get("Hı hı.").as_deref(),
        Some(&vec![1i16, 2, 3])
    );
    let temps = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "tmp")
        })
        .count();
    assert_eq!(temps, 1, "only the other writer's file is left");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// B5 re-review: opening a call's cache removes the temporary files a crashed writer left, once
/// they are older than any write takes; a fresh one (another writer at work) and the cached
/// sentences stay.
#[test]
fn opening_a_cache_removes_temporary_files_left_by_a_crash() {
    let dir = temp("cache-orphan");
    std::fs::create_dir_all(&dir).unwrap();
    let left = dir.join(format!("{}.4242.0.tmp", key("v", "Tamam.")));
    let fresh = dir.join(format!("{}.4243.0.tmp", key("v", "Peki.")));
    let kept = dir.join(format!("{}.pcm", key("v", "Hı hı.")));
    for path in [&left, &fresh, &kept] {
        std::fs::write(path, [1u8, 0]).unwrap();
    }
    let an_hour_ago = std::time::SystemTime::now() - Duration::from_secs(3_600);
    for path in [&left, &kept] {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(an_hour_ago)
            .unwrap();
    }
    let mut c = PhraseCache::open(dir.clone(), "v");
    assert!(!left.exists(), "the crashed writer's file is removed");
    assert!(fresh.exists() && kept.exists());
    assert_eq!(c.get("Hı hı.").as_deref(), Some(&vec![1i16]));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// B6 review E: a call keeps a sentence under its cache's lock and writes it to disk outside it:
/// `keep` stores it in memory and hands back the write a policy sentence needs.
#[test]
fn a_kept_policy_sentence_is_written_outside_the_lock() {
    let dir = temp("cache-keep");
    let mut c = PhraseCache::new(dir.clone(), "v");
    assert!(
        c.keep("v", "Arama sırası geldi.", vec![5, 6], false)
            .is_none(),
        "a call's own sentence stays in memory"
    );
    let filing = c
        .keep("v", "Hı hı.", vec![1, 2], true)
        .expect("a policy sentence is filed");
    let file = dir.join(format!("{}.pcm", key("v", "Hı hı.")));
    assert!(!file.exists(), "nothing is on disk before the write");
    assert_eq!(c.get("Hı hı.").as_deref(), Some(&vec![1i16, 2]));
    filing.write().unwrap();
    assert_eq!(
        PhraseCache::new(dir.clone(), "v").get("Hı hı.").as_deref(),
        Some(&vec![1i16, 2])
    );
    assert!(
        c.keep("w", "Tamam.", vec![1], true).is_none(),
        "another voice's audio is dropped"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// B5 review: a late write of the voice the call started with (its pre-synthesis) is not filed
/// under the voice the cache now keys by.
#[test]
fn audio_of_another_voice_is_never_filed() {
    let dir = temp("cache-voice");
    let mut c = PhraseCache::new(dir.clone(), "new-voice");
    c.put("old-voice", "Tamam.", vec![1, 2], true).unwrap();
    assert_eq!(c.get("Tamam."), None);
    assert_eq!(
        PhraseCache::new(dir.clone(), "old-voice").get("Tamam."),
        None
    );
    assert!(!dir.exists(), "nothing was written");
}

/// B5 review: a disk that cannot be written is an error the call can warn about; the sentence
/// still plays from memory.
#[test]
fn a_disk_that_cannot_be_written_is_an_error_and_the_sentence_stays_in_memory() {
    let dir = temp("cache-blocked");
    std::fs::write(&dir, b"a file where the directory should be").unwrap();
    let mut c = PhraseCache::new(dir.clone(), "v");
    assert!(c.put("v", "Tamam.", vec![7], true).is_err());
    assert_eq!(c.get("Tamam.").as_deref(), Some(&vec![7i16]));
    std::fs::remove_file(&dir).unwrap();
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
fn the_audio_clock_keeps_a_minute_of_history() {
    let mut clock = AudioClock::default();
    let t0 = Instant::now();
    for i in 0..4_000u64 {
        clock.push(20, t0 + Duration::from_millis(20 * i));
    }
    assert_eq!(clock.position_ms(), 80_000);
    assert_eq!(clock.at(19_990), None, "older than the minute kept");
    assert_eq!(clock.at(20_000), Some(t0 + Duration::from_millis(20_000)));
    assert_eq!(clock.at(79_990), Some(t0 + Duration::from_millis(79_980)));
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
    let path = temp("traces.jsonl");
    let file = TraceFile::new(path.clone());
    file.append("c-1", &trace).unwrap();
    file.append("c-1", &trace).unwrap();
    let read = read_traces(&path, None).unwrap();
    assert_eq!(read, vec![trace.clone(), trace]);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains('+'), "{text}");
    std::fs::remove_file(&path).unwrap();
}

/// B5 review: a line goes in one write, so writers that share the file (`run` and a `slice`)
/// never interleave inside a line.
#[test]
fn concurrent_appends_keep_every_line_whole() {
    let path = temp("traces-many.jsonl");
    let file = TraceFile::new(path.clone());
    let trace = TurnTrace {
        endpoint_ms: 260,
        reply_seq: Some(4),
        ..TurnTrace::default()
    };
    std::thread::scope(|s| {
        for _ in 0..8 {
            s.spawn(|| {
                for _ in 0..200 {
                    file.append("c-1", &trace).unwrap();
                }
            });
        }
    });
    assert_eq!(read_traces(&path, None).unwrap().len(), 1_600);
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn traces_are_read_since_a_time_and_unreadable_lines_are_skipped() {
    let path = temp("traces-since.jsonl");
    let line = |at: &str, endpoint_ms: u32| {
        let trace = TurnTrace {
            endpoint_ms,
            ..TurnTrace::default()
        };
        json!({ "at": at, "call": "c-1", "trace": trace }).to_string()
    };
    let text = [
        line("2026-10-30T09:00:00Z", 1),
        line("2026-10-30T10:00:00Z", 2),
        "{\"at\":".to_owned(),
        line("2026-10-30T11:00:00Z", 3),
    ]
    .join("\n");
    std::fs::write(&path, text).unwrap();
    let since = OffsetDateTime::parse("2026-10-30T10:00:00Z", &Rfc3339).unwrap();
    let ms = |traces: Vec<TurnTrace>| traces.iter().map(|t| t.endpoint_ms).collect::<Vec<_>>();
    assert_eq!(ms(read_traces(&path, Some(since)).unwrap()), [2, 3]);
    assert_eq!(ms(read_traces(&path, None).unwrap()), [1, 2, 3]);
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
        parse_event(r#"{"type":"ChannelStateChange","channel":{"id":"c-1","state":"Up"}}"#),
        AriEvent::Other
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
            frame_bytes: 160,
            ptime_ms: Some(20)
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

/// B5 review: a `MEDIA_START` without its codec or its frame size is no start (the bridge would
/// guess the codec of the line); `ptime` is passed on for the call to check.
#[test]
fn a_media_start_without_its_codec_or_frame_is_no_start() {
    assert_eq!(
        parse_control(r#"{"event":"MEDIA_START","format":"ulaw","optimal_frame_size":160}"#),
        MediaEvent::Start {
            format: "ulaw".into(),
            frame_bytes: 160,
            ptime_ms: None
        }
    );
    for partial in [
        r#"{"event":"MEDIA_START","channel_id":"c-1-m"}"#,
        r#"{"event":"MEDIA_START","format":"alaw","ptime":20}"#,
        r#"{"event":"MEDIA_START","optimal_frame_size":160,"ptime":20}"#,
        r#"{"event":"MEDIA_START","format":"alaw","optimal_frame_size":"160","ptime":20}"#,
    ] {
        assert_eq!(parse_control(partial), MediaEvent::Other, "{partial}");
    }
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
    let p: Heard = serde_json::from_str(r#"{"type":"partial","text":"evet perşembe"}"#).unwrap();
    assert_eq!(format!("{p:?}"), "Partial");
    let s: Heard = serde_json::from_str(r#"{"type":"speech_start","audio_ms":420}"#).unwrap();
    assert!(matches!(s, Heard::SpeechStart { audio_ms: 420 }));
}
