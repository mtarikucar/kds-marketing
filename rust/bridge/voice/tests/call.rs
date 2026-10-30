//! One call against fake Asterisk and speech services: dial, answer, the core's opening played to
//! its mark, a caller turn reported and acknowledged, the agent's sentence, the closing hang-up;
//! and the ways a call ends early (B5 re-review): the speech services are connected before the
//! dial, and a line whose media or speaker closes is reported as failed and hung up. The B6 review:
//! the opening is heard in full, and no call waits on the line for ever (the ring, the hangup, the
//! longest duration, a hangup asked before the dial).
mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use jeeta_voice_bridge::ari::{Ari, AriEvent};
use jeeta_voice_bridge::call::{CallDeps, CallSetup, LineWaits, Report, ToCall, run_call};
use jeeta_voice_bridge::speech::Endpoint;
use jeeta_voice_bridge::talker::Timing;
use jt_calls::{BridgeEvent, Command, DialScript, PhraseSet, PlayKind};
use serde_json::json;
use support::*;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

async fn next(reports: &mut mpsc::UnboundedReceiver<Report>) -> Report {
    tokio::time::timeout(Duration::from_secs(3), reports.recv())
        .await
        .expect("a report in time")
        .expect("open")
}

#[derive(Default)]
struct Options {
    /// The media closes this long after its start.
    media_closes_after: Option<Duration>,
    /// The speaker closes when asked to synthesise a text holding this.
    speaker_dies_on: Option<&'static str>,
    /// The listener's address takes no connection.
    listener_unreachable: bool,
    /// Each sentence takes this long to play (the fake media answers its mark this much later).
    mark_delay: Option<Duration>,
    /// The first channel hangups ARI answers 500.
    refused_hangups: usize,
    /// The call's waits on the line (ring 5 s and gone 2 s without).
    waits: Option<LineWaits>,
    /// The call's longest duration (60 s without).
    max_duration: Option<Duration>,
}

/// A call on its way: its fakes, its channels and its task.
struct Rig {
    log: Log,
    to_call: mpsc::Sender<ToCall>,
    reports: mpsc::UnboundedReceiver<Report>,
    listen_conns: mpsc::Receiver<WebSocketStream<TcpStream>>,
    controls: mpsc::Receiver<String>,
    task: JoinHandle<()>,
    cache: PathBuf,
}

/// An address on loopback that takes no connection.
async fn closed_port() -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    l.local_addr().unwrap().to_string()
}

async fn rig(name: &str, options: Options) -> Rig {
    let (ari_base, log) = fake_ari_refusing_hangups(options.refused_hangups).await;
    let (media_addr, media_conns) = ws_server().await;
    let (listen_addr, listen_conns) = ws_server().await;
    let (speak_addr, speak_conns) = ws_server().await;
    serve_speaker_until(speak_conns, options.speaker_dies_on);
    let controls = serve_media_with(
        media_conns,
        MediaFake {
            closes_after: options.media_closes_after,
            mark_delay: options.mark_delay,
        },
    );
    let listen = if options.listener_unreachable {
        closed_port().await
    } else {
        listen_addr
    };
    let cache = std::env::temp_dir().join(format!("voice-call-{name}-{}", std::process::id()));
    let deps = Arc::new(CallDeps {
        ari: Arc::new(
            Ari::new(&ari_base, "u", "p")
                .unwrap()
                .with_ws_base(&format!("ws://{media_addr}")),
        ),
        listen: Endpoint::Tcp(listen),
        speak: Endpoint::Tcp(speak_addr),
        cache_dir: cache.clone(),
        timing: Timing::default(),
        traces: None,
        waits: options.waits.unwrap_or(LineWaits {
            ring: Duration::from_secs(5),
            gone: Duration::from_secs(2),
        }),
    });
    let (to_call, rx) = mpsc::channel(16);
    let (reports_tx, reports) = mpsc::unbounded_channel();
    let setup = CallSetup {
        bridge_call_id: "c-1".into(),
        dial: "05321234567".into(),
        script: DialScript::default(),
        plan_lines: vec!["Ada Hanım ile mi görüşüyorum?".into()],
        closing: "Görüşmek üzere, iyi günler.".into(),
        max_duration: options.max_duration.unwrap_or(Duration::from_secs(60)),
    };
    let task = tokio::spawn(run_call(deps, setup, rx, reports_tx));
    Rig {
        log,
        to_call,
        reports,
        listen_conns,
        controls,
        task,
        cache,
    }
}

type ListenSink = SplitSink<WebSocketStream<TcpStream>, Message>;

impl Rig {
    fn ari(&self) -> String {
        self.log.lock().unwrap().join("\n")
    }

    /// The listener's connection, whose first message is the call's `start`.
    async fn listener(&mut self) -> WebSocketStream<TcpStream> {
        let mut listener = tokio::time::timeout(Duration::from_secs(3), self.listen_conns.recv())
            .await
            .expect("the listener is connected")
            .unwrap();
        let start = listener.next().await.unwrap().unwrap();
        assert!(matches!(start, Message::Text(ref t) if t.contains("\"start\"")));
        listener
    }

    /// Answers the line once it was dialled; the listener's sink (what the bridge sends it is read
    /// and dropped).
    async fn answer(&mut self) -> ListenSink {
        let (listen_tx, mut listen_rx) = self.answer_whole().await.split();
        tokio::spawn(async move { while listen_rx.next().await.is_some() {} });
        listen_tx
    }

    /// As [`Rig::answer`], with the listener's whole connection: dropping it is the listen
    /// service's crash.
    async fn answer_whole(&mut self) -> WebSocketStream<TcpStream> {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self.ari().contains("POST /ari/channels") {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the line is dialled");
        self.to_call
            .send(ToCall::Ari(AriEvent::Answered {
                channel: "c-1".into(),
                inbound: false,
            }))
            .await
            .unwrap();
        assert_eq!(next(&mut self.reports).await.event, BridgeEvent::Answered);
        self.listener().await
    }

    /// How many times ARI was asked to hang the caller's channel up.
    fn hangups(&self) -> usize {
        let log = self.log.lock().unwrap();
        log.iter().filter(|l| *l == "DELETE channel c-1").count()
    }

    async fn send(&self, message: ToCall) {
        self.to_call.send(message).await.unwrap();
    }

    /// Waits for the call's task to end, and removes its cache.
    async fn ended(&mut self) {
        tokio::time::timeout(Duration::from_secs(3), &mut self.task)
            .await
            .expect("the call's task ends")
            .unwrap();
        let _ = std::fs::remove_dir_all(&self.cache);
    }
}

#[tokio::test]
async fn a_call_dials_plays_hears_acknowledges_and_hangs_up() {
    let mut r = rig("whole", Options::default()).await;

    // The dial goes to the PBX in national form.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(r.ari().contains("PJSIP/05321234567@netgsm"), "{}", r.ari());

    let mut listen_tx = r.answer().await;

    // The core's opening plays to its mark.
    let opening = Command::Play {
        seq: 2,
        clip: PlayKind::Opening,
        index: 0,
        text: "Ada Hanım ile mi görüşüyorum?".into(),
    };
    r.to_call.send(ToCall::Command(opening)).await.unwrap();
    let said = next(&mut r.reports).await.event;
    assert_eq!(
        said,
        BridgeEvent::Said {
            seq: 2,
            interrupted_at_char: None,
            tts_ms: None
        }
    );

    // The caller's turn is reported, then acknowledged by the bridge on its own.
    let final_ = json!({ "type": "final", "text": "evet benim", "speech_end_ms": 0, "endpoint_ms": 260,
        "endpoint_by": "smart_turn", "stt_ms": 40 });
    listen_tx
        .send(Message::Text(final_.to_string().into()))
        .await
        .unwrap();
    let utterance = next(&mut r.reports).await;
    assert!(
        matches!(utterance.event, BridgeEvent::Utterance { ref text, is_final: true, .. } if text == "evet benim")
    );
    utterance.taken.unwrap().send(()).unwrap();
    let ack = next(&mut r.reports).await.event;
    assert_eq!(
        ack,
        BridgeEvent::Phrase {
            set: PhraseSet::Acknowledgement,
            index: 0
        }
    );

    // The agent speaks, then the core hangs up.
    r.to_call
        .send(ToCall::Command(Command::Say {
            seq: 4,
            text: "Harika.".into(),
            allow_barge_in: true,
        }))
        .await
        .unwrap();
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Said {
            seq: 4,
            interrupted_at_char: None,
            tts_ms: None
        }
    );
    r.to_call
        .send(ToCall::Command(Command::Hangup))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        r.log
            .lock()
            .unwrap()
            .iter()
            .any(|l| l == "DELETE channel c-1")
    );
    r.to_call
        .send(ToCall::Ari(AriEvent::Gone {
            channel: "c-1".into(),
            cause: Some(16),
        }))
        .await
        .unwrap();
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Hangup {
            cause: "normal".into()
        }
    );
    let BridgeEvent::Trace { trace } = next(&mut r.reports).await.event else {
        panic!("a trace")
    };
    assert_eq!(trace.endpoint_ms, 260);
    assert!(trace.ack_ms.is_some() && trace.say_ms.is_some() && trace.first_audio_ms.is_some());
    assert_eq!(trace.reply_seq, Some(4));
    r.ended().await;
    let sent: Vec<String> = std::iter::from_fn(|| r.controls.try_recv().ok()).collect();
    assert!(sent.iter().any(|c| c == "MARK_MEDIA"));
    assert!(
        sent.iter().any(|c| c == "silence frame"),
        "silence fills the gaps: {sent:?}"
    );
    assert!(
        !sent.iter().any(|c| c.starts_with("frame of")),
        "whole 160-byte frames only: {sent:?}"
    );
}

/// B5 re-review: the listener and the speaker are connected before the line rings, so only ARI's
/// media setup sits between the answer and the first frame; a line that is never answered closes
/// them.
#[tokio::test]
async fn the_speech_services_are_connected_before_the_answer_and_closed_when_none_comes() {
    let mut r = rig("unanswered", Options::default()).await;
    // No answer yet: the listener has its `start` all the same.
    let mut listener = r.listener().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(r.ari().contains("PJSIP/05321234567@netgsm"), "{}", r.ari());
    r.to_call
        .send(ToCall::Ari(AriEvent::Gone {
            channel: "c-1".into(),
            cause: Some(19),
        }))
        .await
        .unwrap();
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Hangup {
            cause: "no_answer".into()
        }
    );
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match listener.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the listener's connection is closed");
    r.ended().await;
}

/// B5 re-review: a listener that cannot be reached fails the call before the line rings.
#[tokio::test]
async fn an_unreachable_listener_fails_the_call_before_the_dial() {
    let mut r = rig(
        "deaf",
        Options {
            listener_unreachable: true,
            ..Options::default()
        },
    )
    .await;
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Error {
            failure_line: "transient: bridge: listener unreachable".into()
        }
    );
    r.ended().await;
    assert!(!r.ari().contains("POST /ari/channels"), "{}", r.ari());
}

/// B5 re-review: a call whose media closes (Asterisk restarted, the media channel failed) is
/// reported as failed before its task ends, and the caller's channel is hung up.
#[tokio::test]
async fn a_call_whose_media_closes_is_reported_failed_and_hung_up() {
    let mut r = rig(
        "media-gone",
        Options {
            media_closes_after: Some(Duration::from_millis(300)),
            ..Options::default()
        },
    )
    .await;
    let _listen = r.answer().await;
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Error {
            failure_line: "transient: bridge: the media closed during the call".into()
        }
    );
    r.ended().await;
    assert!(
        r.log
            .lock()
            .unwrap()
            .iter()
            .any(|l| l == "DELETE channel c-1"),
        "{}",
        r.ari()
    );
}

/// B5 re-review: so is a call whose speaker closes.
#[tokio::test]
async fn a_call_whose_speaker_closes_is_reported_failed_and_hung_up() {
    let mut r = rig(
        "mute",
        Options {
            speaker_dies_on: Some("Kapanıyor"),
            ..Options::default()
        },
    )
    .await;
    let _listen = r.answer().await;
    r.to_call
        .send(ToCall::Command(Command::Say {
            seq: 3,
            text: "Kapanıyor gibi görünüyor efendim.".into(),
            allow_barge_in: true,
        }))
        .await
        .unwrap();
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Error {
            failure_line: "transient: bridge: the speaker stopped during the call".into()
        }
    );
    r.ended().await;
    assert!(
        r.log
            .lock()
            .unwrap()
            .iter()
            .any(|l| l == "DELETE channel c-1"),
        "{}",
        r.ari()
    );
}

fn said(seq: u32, interrupted_at_char: Option<u32>) -> BridgeEvent {
    BridgeEvent::Said {
        seq,
        interrupted_at_char,
        tts_ms: None,
    }
}

fn hangup(cause: &str) -> BridgeEvent {
    BridgeEvent::Hangup {
        cause: cause.into(),
    }
}

/// B6 review C: the opening (with the workspace's opening, the disclosure and the transcript
/// notice in it) is heard in full: the caller's "Alo?" over it cuts nothing, and the turn is kept
/// and covered once the opening has played.
#[tokio::test]
async fn the_callers_alo_over_the_opening_cuts_nothing_and_is_answered_after_it() {
    let mut r = rig(
        "alo",
        Options {
            mark_delay: Some(Duration::from_millis(800)),
            ..Options::default()
        },
    )
    .await;
    let mut listen_tx = r.answer().await;
    let opening = Command::Play {
        seq: 2,
        clip: PlayKind::Opening,
        index: 0,
        text: "Ada Hanım ile mi görüşüyorum?".into(),
    };
    r.send(ToCall::Command(opening)).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    for heard in [
        json!({ "type": "speech_start", "audio_ms": 0 }),
        json!({ "type": "final", "text": "Alo?", "speech_end_ms": 0, "endpoint_ms": 200,
            "endpoint_by": "smart_turn", "stt_ms": 30 }),
    ] {
        listen_tx
            .send(Message::Text(heard.to_string().into()))
            .await
            .unwrap();
    }
    let utterance = next(&mut r.reports).await;
    assert!(matches!(utterance.event, BridgeEvent::Utterance { ref text, .. } if text == "Alo?"));
    assert_eq!(
        next(&mut r.reports).await.event,
        said(2, None),
        "heard in full"
    );
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Phrase {
            set: PhraseSet::Acknowledgement,
            index: 0
        },
        "the turn is covered after the opening"
    );
    r.send(ToCall::Ari(AriEvent::Gone {
        channel: "c-1".into(),
        cause: Some(16),
    }))
    .await;
    r.ended().await;
}

/// B6 review D: a line that rings past its deadline (the PBX's own 45 s and 10 s more) is hung up
/// as unanswered.
#[tokio::test]
async fn a_line_that_rings_past_its_deadline_is_hung_up_as_unanswered() {
    let mut r = rig(
        "rings",
        Options {
            waits: Some(LineWaits {
                ring: Duration::from_millis(500),
                gone: Duration::from_secs(2),
            }),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(next(&mut r.reports).await.event, hangup("no_answer"));
    r.ended().await;
    assert!(r.hangups() >= 1, "{}", r.ari());
}

/// B6 review D: a hangup asked before the dial (the slice's Ctrl-C) rings no phone.
#[tokio::test]
async fn a_hangup_asked_before_the_dial_rings_no_phone() {
    let mut r = rig("never", Options::default()).await;
    r.send(ToCall::Command(Command::Hangup)).await;
    assert_eq!(next(&mut r.reports).await.event, hangup("no_answer"));
    r.ended().await;
    assert!(!r.ari().contains("POST /ari/channels"), "{}", r.ari());
}

/// B6 review D: a hangup ARI refuses is asked again.
#[tokio::test]
async fn a_hangup_ari_refuses_is_asked_again() {
    let mut r = rig(
        "retry",
        Options {
            refused_hangups: 1,
            waits: Some(LineWaits {
                ring: Duration::from_secs(5),
                gone: Duration::from_secs(4),
            }),
            ..Options::default()
        },
    )
    .await;
    let _listen = r.answer().await;
    r.send(ToCall::Command(Command::Hangup)).await;
    // The hangup comes 400 ms after nothing is left to play; the second try 500 ms after the first.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(r.hangups(), 2, "{}", r.ari());
    r.send(ToCall::Ari(AriEvent::Gone {
        channel: "c-1".into(),
        cause: Some(16),
    }))
    .await;
    assert_eq!(next(&mut r.reports).await.event, hangup("normal"));
    r.ended().await;
}

/// B6 review D: a hangup Asterisk never confirms (its events lost) ends the call all the same: the
/// task reports the hangup and cleans the line up.
#[tokio::test]
async fn a_hangup_never_confirmed_ends_the_call_all_the_same() {
    let mut r = rig(
        "unconfirmed",
        Options {
            waits: Some(LineWaits {
                ring: Duration::from_secs(5),
                gone: Duration::from_millis(300),
            }),
            ..Options::default()
        },
    )
    .await;
    let _listen = r.answer().await;
    r.send(ToCall::Command(Command::Hangup)).await;
    assert_eq!(next(&mut r.reports).await.event, hangup("normal"));
    r.ended().await;
    assert!(r.ari().contains("DELETE channel c-1-m"), "{}", r.ari());
}

/// B6 review D: a call that reaches its longest duration plays the closing and hangs up, without
/// the core.
#[tokio::test]
async fn a_call_at_its_longest_duration_plays_the_closing_and_hangs_up() {
    let mut r = rig(
        "longest",
        Options {
            max_duration: Some(Duration::from_millis(600)),
            ..Options::default()
        },
    )
    .await;
    let _listen = r.answer().await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while r.hangups() == 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the line is hung up");
    r.send(ToCall::Ari(AriEvent::Gone {
        channel: "c-1".into(),
        cause: Some(16),
    }))
    .await;
    // The closing is the bridge's own line: nothing of it is reported but the end.
    assert_eq!(next(&mut r.reports).await.event, hangup("normal"));
    r.ended().await;
}

/// B6 review E: a listener that answers the call's `start` with an error fails the call before
/// the answer, and the ringing line is hung up.
#[tokio::test]
async fn a_listener_that_refuses_the_call_hangs_the_ringing_line_up() {
    let mut r = rig("refused", Options::default()).await;
    let mut listener = r.listener().await;
    let refusal = json!({ "type": "error", "reason": "busy" });
    listener
        .send(Message::Text(refusal.to_string().into()))
        .await
        .unwrap();
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Error {
            failure_line: "transient: bridge: the listener refused the call".into()
        }
    );
    r.ended().await;
    assert!(r.hangups() >= 1, "{}", r.ari());
}

/// B6 review E: a listener that stops while the caller speaks closes the caller's turn, so the
/// fault sentence plays at once instead of waiting for a pause the listener can no longer report.
#[tokio::test]
async fn a_listener_that_stops_mid_turn_lets_the_fault_sentence_play() {
    let mut r = rig("mid-turn", Options::default()).await;
    let mut listener = r.answer_whole().await;
    let start = json!({ "type": "speech_start", "audio_ms": 0 });
    listener
        .send(Message::Text(start.to_string().into()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    // The listen service crashes: its socket closes with no close frame.
    drop(listener);
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Error {
            failure_line: "transient: bridge: the listener stopped during the call".into()
        }
    );
    assert_eq!(
        next(&mut r.reports).await.event,
        BridgeEvent::Phrase {
            set: PhraseSet::Fault,
            index: 0
        }
    );
    r.send(ToCall::Ari(AriEvent::Gone {
        channel: "c-1".into(),
        cause: Some(16),
    }))
    .await;
    r.ended().await;
}
