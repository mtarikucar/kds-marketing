//! One call's task (design addendum §3): it connects the listener and the speaker, dials through
//! ARI, waits for the answer, brings the call's media up (`chan_websocket`), and runs the talker
//! until the line closes, reporting each event as a [`Report`] (to the core in `run`, to the
//! console in `slice`). It never logs a number or a word.
//!
//! The speech services are connected before the dial (B5 re-review): only ARI's media setup on
//! loopback sits between the answer and the first frame, and a service that cannot be reached
//! fails the call before anyone's phone rings. While the line rings the call watches them: one
//! that closes, or sends anything but its `hello` (the listener refusing the call), fails the
//! call, and a line that is never answered closes them.
//!
//! The media is written by a task of its own (`pace_media`): one frame every 20 ms for the whole
//! call, silence when nothing plays, since Asterisk >= 22.9 sends nothing to the line otherwise
//! (B1 review). The call's loop only hands that task audio, marks and flushes, so nothing the
//! loop waits on (the speech services, a slow consumer of reports) can leave a hole in the line's
//! RTP; ARI calls made during the call are spawned (B5 review), and a sentence is written to the
//! phrase cache's disk off the loop (B6 review).
//!
//! Every end of the line is reported (B5 re-review): the caller's hangup, and the media or the
//! speaker closing during the call as a transient `error`, before the task hangs the caller's
//! channel up. Reports go on an unbounded queue: one call's events are few, and none may be
//! dropped (a lost utterance would lose its turn's reply, and its `taken` with it).
//!
//! No call waits on the line for ever (B6 review, [`LineWaits`]): a line that rings past its
//! deadline is hung up as unanswered; a hangup ARI refuses is asked again, and one Asterisk never
//! confirms ends the call all the same; a call at its longest duration (`CallSetup::max_duration`)
//! plays its closing and hangs up, and is cut 30 s later if the caller holds the closing back; a
//! hangup asked before the dial rings no phone.
//!
//! The opening (the workspace's opening with the disclosure and the transcript notice in it, then
//! the plan's), the recording announcement and the closing are heard in full: the caller's speech
//! does not cut them, and a turn spoken over them is reported and answered once they end (B6
//! review; design §3).
//!
//! A turn's `first_audio_ms` and `ack_ms` time the frame written to Asterisk, which holds the
//! pacer's lead (`media::LEAD_FRAMES`, 60 ms) ahead of the line: the caller hears it about that
//! much later.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use jt_calls::{BridgeEvent, Command, DialScript, PhraseSet, PlayKind};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{self, Message};
use tracing::{info, warn};

use crate::ari::{self, Ari, AriError, AriEvent};
use crate::cache::{Filing, PhraseCache};
use crate::g711::Codec;
use crate::media::{self, MediaEvent, Out, Pacer};
use crate::netgsm;
use crate::speech::{self, Endpoint, Heard, Spoken, ToListener, ToSpeaker};
use crate::talker::{Action, Input, Item, Source, Talker, Timing};
use crate::text::{self, Sentence};
use crate::trace::{AudioClock, TraceFile, TurnMarks};

/// How long after the closing's end the line is hung up.
const HANGUP_TAIL: Duration = Duration::from_millis(400);
/// How long the answered line may take to bring its media up.
const MEDIA_SETUP: Duration = Duration::from_secs(3);
/// How long the media channel may take to enter the application once its WebSocket is connected
/// (Asterisk refuses to bridge it before, 422), and how often the bridge asks meanwhile (B7).
const MIX_WAIT: Duration = Duration::from_secs(2);
const MIX_RETRY: Duration = Duration::from_millis(100);
/// How long the PBX may ring.
const RING_TIMEOUT_S: u32 = 45;
/// The pauses before each try to hang a channel up: ARI may be away a moment (B6 review).
const HANGUP_TRIES: [Duration; 3] = [
    Duration::ZERO,
    Duration::from_millis(500),
    Duration::from_millis(1_500),
];
/// How long past its longest duration a call may take to play its closing (the caller may hold it
/// back) before the line is cut.
const CLOSE_GRACE: Duration = Duration::from_secs(30);
const SAMPLE_RATE: u64 = 8_000;
/// G.711 in 20 ms frames: the only media the pacer writes (B5 review).
const FRAME_BYTES: usize = 160;

/// How long a call waits on the line (B6 review).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineWaits {
    /// From the dial to the answer: then the line is hung up as unanswered.
    pub ring: Duration,
    /// From the bridge's hangup to Asterisk's word that the line is gone: then the call ends all
    /// the same.
    pub gone: Duration,
}

impl Default for LineWaits {
    /// The PBX's own ring timeout and 10 s more; 5 s for the hangup.
    fn default() -> Self {
        LineWaits {
            ring: Duration::from_secs(u64::from(RING_TIMEOUT_S) + 10),
            gone: Duration::from_secs(5),
        }
    }
}

pub struct CallDeps {
    pub ari: Arc<Ari>,
    pub listen: Endpoint,
    pub speak: Endpoint,
    pub cache_dir: PathBuf,
    pub timing: Timing,
    pub traces: Option<TraceFile>,
    pub waits: LineWaits,
}

pub struct CallSetup {
    pub bridge_call_id: String,
    /// The number as the PBX dials it (`netgsm::dial_string`).
    pub dial: String,
    pub script: DialScript,
    /// The plan's sentences (opening first), synthesised ahead into this call's memory.
    pub plan_lines: Vec<String>,
    /// The closing the bridge plays itself when the call reaches `max_duration`.
    pub closing: String,
    /// The call's longest duration from the answer: the slice's `VOICE_MAX_CALL_S`; in `run`, a
    /// minute past the plan's own, after which the core has closed a call it still holds (D2).
    pub max_duration: Duration,
}

#[expect(
    clippy::large_enum_variant,
    reason = "a call's messages are few and short-lived, as jt_calls' Command"
)]
pub enum ToCall {
    Command(Command),
    Ari(AriEvent),
    CoreLost,
}

/// An event of the call, and a way to hear when it was taken (the core answered its report).
pub struct Report {
    pub bridge_call_id: String,
    pub event: BridgeEvent,
    pub taken: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
struct Reporter {
    id: String,
    tx: mpsc::UnboundedSender<Report>,
}

impl Reporter {
    /// Hands `event` on without waiting. The queue is unbounded (B5 re-review), so a consumer that
    /// is slow to take reports (the core away, the poster retrying) never holds the call's loop up,
    /// and no report is dropped; it is closed only once its consumer stopped (`run` ending).
    fn send(&self, event: BridgeEvent) {
        self.put(event, None);
    }

    /// As `send`, with a way to hear when the core took the report.
    fn send_taken(&self, event: BridgeEvent) -> oneshot::Receiver<()> {
        let (taken, rx) = oneshot::channel();
        self.put(event, Some(taken));
        rx
    }

    /// Reports the call as failed for `reason`, a transient failure of the bridge.
    fn fail(&self, reason: &str) {
        self.send(BridgeEvent::Error {
            failure_line: format!("transient: bridge: {reason}"),
        });
    }

    /// Reports that the line closed (after the answer, always `normal` to the core).
    fn hung_up(&self, cause: &str) {
        self.send(BridgeEvent::Hangup {
            cause: cause.to_owned(),
        });
    }

    fn put(&self, event: BridgeEvent, taken: Option<oneshot::Sender<()>>) {
        let report = Report {
            bridge_call_id: self.id.clone(),
            event,
            taken,
        };
        if self.tx.send(report).is_err() {
            warn!(call = %self.id, "a report was dropped: its consumer stopped");
        }
    }
}

/// The call's phrase cache, with what it keeps on disk and whether a disk error was logged.
#[derive(Clone)]
struct CallCache {
    phrases: Arc<Mutex<PhraseCache>>,
    /// The policy's sentences: kept on disk once synthesised.
    persist: Arc<HashSet<String>>,
    /// A disk error is logged once a call.
    warned: Arc<AtomicBool>,
}

impl CallCache {
    /// Keeps `pcm` of `sentence`, spoken by `voice`, and writes a policy sentence to disk outside
    /// the lock and off the call's loop (a blocking write and its sync; B6 review).
    fn file(&self, call: &str, voice: &str, sentence: &str, pcm: Vec<i16>) {
        let persist = self.persist.contains(sentence);
        let filing: Option<Filing> = self
            .phrases
            .lock()
            .ok()
            .and_then(|mut c| c.keep(voice, sentence, pcm, persist));
        let Some(filing) = filing else {
            return;
        };
        let (id, warned) = (call.to_owned(), self.warned.clone());
        tokio::spawn(async move {
            let written = tokio::task::spawn_blocking(move || filing.write()).await;
            if !matches!(written, Ok(Ok(()))) && !warned.swap(true, Ordering::Relaxed) {
                warn!(call = %id, "the phrase cache could not be written");
            }
        });
    }
}

/// Why the answered call's media did not come up: the step, and ARI's answer when ARI refused it
/// (its status code; never a URL or a body).
struct SetupError {
    reason: &'static str,
    ari: Option<AriError>,
}

impl SetupError {
    /// The failure of step `reason` with ARI's error.
    fn at(reason: &'static str) -> impl FnOnce(AriError) -> SetupError {
        move |e| SetupError {
            reason,
            ari: Some(e),
        }
    }

    /// The failure line's words: the step, and ARI's answer (`ARI answered 422`).
    fn words(&self) -> String {
        match &self.ari {
            Some(e) => format!("{} ({e})", self.reason),
            None => self.reason.to_owned(),
        }
    }
}

/// Aborts its task when dropped: the call's pre-synthesis ends with the call (B6 review).
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn text_message<T: Serialize>(value: &T) -> Message {
    Message::Text(serde_json::to_string(value).unwrap_or_default().into())
}

/// PCM16 little-endian samples. The speak service's frames are always of an even length, so an
/// odd one is a protocol error, not a sample to drop (B5 review).
fn pcm16(bytes: &[u8]) -> Option<Vec<i16>> {
    bytes.len().is_multiple_of(2).then(|| {
        bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    })
}

fn audio_duration(samples: usize) -> Duration {
    Duration::from_millis(samples as u64 * 1_000 / SAMPLE_RATE)
}

fn parse_mark(correlation: &str) -> Option<(u64, usize)> {
    let (item, index) = correlation.split_once(':')?;
    Some((item.parse().ok()?, index.parse().ok()?))
}

/// The sentences of the policy's texts: kept on disk once synthesised.
fn policy_sentences(script: &DialScript) -> HashSet<String> {
    script
        .lines
        .iter()
        .map(String::as_str)
        .chain(script.phrases.all())
        .flat_map(|t| text::sentences(t).into_iter().map(|s| s.text))
        .collect()
}

/// What to synthesise ahead, most urgent first: the plan's opening, the policy's lines, the
/// phrases (acknowledgements first), the closing, then the rest of the plan.
fn presynth_order(setup: &CallSetup) -> Vec<String> {
    let mut out: Vec<String> = setup.plan_lines.iter().take(1).cloned().collect();
    out.extend(setup.script.lines.iter().cloned());
    out.extend(setup.script.phrases.all().map(str::to_owned));
    out.push(setup.closing.clone());
    out.extend(setup.plan_lines.iter().skip(1).cloned());
    out
}

/// Synthesises `texts` ahead into the call's cache, filed under `voice`, the one this socket's
/// `hello` named: if the call's cache moved to another voice meanwhile, the cache drops them (B5
/// review).
async fn presynthesize(
    socket: speech::Socket,
    cache: CallCache,
    call: String,
    voice: String,
    texts: Vec<String>,
) {
    let (mut tx, mut rx) = socket.split();
    let mut n = 0u32;
    for t in texts {
        for sentence in text::sentences(&t) {
            let cached = cache
                .phrases
                .lock()
                .map(|mut c| c.get(&sentence.text).is_some())
                .unwrap_or(false);
            if cached {
                continue;
            }
            n += 1;
            let id = format!("pre:{n}");
            let synth = ToSpeaker::Synth {
                id,
                text: sentence.text.clone(),
            };
            if tx.send(text_message(&synth)).await.is_err() {
                return;
            }
            let mut pcm = Vec::new();
            loop {
                match rx.next().await {
                    Some(Ok(Message::Binary(b))) => match pcm16(&b) {
                        Some(samples) => pcm.extend(samples),
                        // A broken frame: pre-synthesis stops; the call synthesises what it needs.
                        None => return,
                    },
                    Some(Ok(Message::Text(m))) => {
                        if let Ok(spoken) = serde_json::from_str::<Spoken>(&m) {
                            if matches!(spoken, Spoken::Done { .. }) && !pcm.is_empty() {
                                cache.file(&call, &voice, &sentence.text, std::mem::take(&mut pcm));
                            }
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => return,
                }
            }
        }
    }
}

/// Hangs `channel` up, asking again after an error (`HANGUP_TRIES`); whether ARI took it. A
/// channel already gone is taken.
async fn hang_up(ari: &Ari, channel: &str) -> bool {
    for pause in HANGUP_TRIES {
        tokio::time::sleep(pause).await;
        if ari.hangup(channel).await.is_ok() {
            return true;
        }
    }
    false
}

type MediaSink = SplitSink<ari::Socket, Message>;
type SpeechSink = SplitSink<speech::Socket, Message>;
type SpeechStream = SplitStream<speech::Socket>;

/// The call's speech services, connected before its dial: the listener, its `start` sent, and the
/// live speaker with the voice id of its `hello`.
struct Services {
    listen_tx: SpeechSink,
    listen_rx: SpeechStream,
    speak_tx: SpeechSink,
    speak_rx: SpeechStream,
    voice: String,
}

impl Services {
    /// Both services at once, each within its connect timeout (`speech::CONNECT_WAIT`).
    async fn connect(deps: &CallDeps, setup: &CallSetup) -> Result<Services, &'static str> {
        let (listen, speak) = tokio::join!(
            speech::connect(&deps.listen, speech::LISTEN_UID),
            speech::connect_speaker(&deps.speak)
        );
        let (mut listen_tx, listen_rx) = listen.map_err(|_| "listener unreachable")?.split();
        let (speak, voice) = speak.map_err(|_| "speaker unreachable")?;
        let start = ToListener::Start {
            sample_rate: speech::SAMPLE_RATE,
            hotwords: setup.script.hotwords.clone(),
        };
        listen_tx
            .send(text_message(&start))
            .await
            .map_err(|_| "listener refused the call")?;
        let (speak_tx, speak_rx) = speak.split();
        Ok(Services {
            listen_tx,
            listen_rx,
            speak_tx,
            speak_rx,
            voice,
        })
    }
}

/// What a speech service sent while the line rang.
enum Early {
    /// Its `hello`, a ping: nothing else is due before the call's audio.
    Fine,
    /// Anything else: the listener's `error` (busy, a failed start) refuses the call (B6 review).
    Refused,
    Closed,
}

fn early(message: Option<Result<Message, tungstenite::Error>>) -> Early {
    match message {
        Some(Ok(Message::Text(t))) => {
            let hello = serde_json::from_str::<Value>(&t).is_ok_and(|v| v["type"] == "hello");
            if hello { Early::Fine } else { Early::Refused }
        }
        Some(Ok(Message::Binary(_))) => Early::Refused,
        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => Early::Closed,
        Some(Ok(_)) => Early::Fine,
    }
}

/// Ends a call that has not been answered for `reason`: the line is hung up (nobody is on it yet,
/// so the call may wait for ARI) and the call reported failed.
async fn fail_before_answer(deps: &CallDeps, id: &str, reporter: &Reporter, reason: &'static str) {
    warn!(call = %id, reason, "the call failed before the answer");
    hang_up(&deps.ari, id).await;
    reporter.fail(reason);
}

/// Runs call `setup` until its line closes (see the module docs).
pub async fn run_call(
    deps: Arc<CallDeps>,
    setup: CallSetup,
    mut rx: mpsc::Receiver<ToCall>,
    reports: mpsc::UnboundedSender<Report>,
) {
    let id = setup.bridge_call_id.clone();
    let reporter = Reporter {
        id: id.clone(),
        tx: reports,
    };
    // The speaker's hello names the voice this call's cache keys by; without a speaker, no dial.
    let Ok((pre, voice)) = speech::connect_speaker(&deps.speak).await else {
        warn!(call = %id, "the speaker is unreachable");
        reporter.fail("the speaker is unreachable");
        return;
    };
    let cache = CallCache {
        phrases: Arc::new(Mutex::new(PhraseCache::open(
            deps.cache_dir.clone(),
            &voice,
        ))),
        persist: Arc::new(policy_sentences(&setup.script)),
        warned: Arc::default(),
    };
    let _presynthesis = AbortOnDrop(tokio::spawn(presynthesize(
        pre,
        cache.clone(),
        id.clone(),
        voice,
        presynth_order(&setup),
    )));
    // The live services before the dial (B5 re-review; the module docs).
    let mut services = match Services::connect(&deps, &setup).await {
        Ok(s) => s,
        Err(reason) => {
            warn!(call = %id, reason, "a speech service is unreachable");
            reporter.fail(reason);
            return;
        }
    };
    if let Ok(mut c) = cache.phrases.lock()
        && c.voice() != services.voice
    {
        // The speak service was replaced since the pre-synthesis connected: this call's audio is
        // the new voice's.
        warn!(call = %id, "the speaker's voice changed before the dial");
        *c = PhraseCache::new(deps.cache_dir.clone(), &services.voice);
    }
    // What came before the dial: a hangup rings no phone (the slice's Ctrl-C; B6 review).
    let mut early_commands = Vec::new();
    loop {
        match rx.try_recv() {
            Ok(ToCall::Command(Command::Hangup)) => {
                info!(call = %id, "hung up before the dial");
                reporter.hung_up("no_answer");
                return;
            }
            Ok(ToCall::Command(c)) => early_commands.push(c),
            Ok(ToCall::CoreLost) => {
                warn!(call = %id, "the core was lost before the dial");
                reporter.fail("the core was unreachable during the call");
                return;
            }
            Ok(ToCall::Ari(_)) => {}
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => return,
        }
    }
    let endpoint = format!("PJSIP/{}@netgsm", setup.dial);
    if deps
        .ari
        .originate(&id, &endpoint, RING_TIMEOUT_S)
        .await
        .is_err()
    {
        // A request that timed out may still ring: the id is hung up all the same (404 when no
        // channel was made; B5 review).
        hang_up(&deps.ari, &id).await;
        warn!(call = %id, "Asterisk refused the dial");
        reporter.fail("the line refused the dial");
        return;
    }
    info!(call = %id, "dialling");
    let ring_until = tokio::time::Instant::now() + deps.waits.ring;
    // While the line rings, the speech services are watched too: the listener's `hello` is the only
    // message either sends before the call's audio, and a service that closes fails the call.
    loop {
        tokio::select! {
            c = rx.recv() => match c {
                None => {
                    hang_up(&deps.ari, &id).await;
                    return;
                }
                Some(ToCall::Ari(AriEvent::Ringing { channel })) if channel == id => {
                    reporter.send(BridgeEvent::Ringing);
                }
                Some(ToCall::Ari(AriEvent::Answered { channel, .. })) if channel == id => break,
                Some(ToCall::Ari(AriEvent::Gone { channel, cause })) if channel == id => {
                    info!(call = %id, cause = ?cause, "the line closed before an answer");
                    // A Gone the slice made up when Asterisk's events ended: the line may still
                    // ring (404 when it is gone; B6 review).
                    let _ = deps.ari.hangup(&id).await;
                    // A number that cannot be called at all fails for good (B4 review M5).
                    let event = match netgsm::permanent_failure(cause, false) {
                        Some(line) => BridgeEvent::Error {
                            failure_line: line.into(),
                        },
                        None => BridgeEvent::Hangup {
                            cause: netgsm::hangup_cause(cause, false).into(),
                        },
                    };
                    reporter.send(event);
                    return;
                }
                Some(ToCall::Command(Command::Hangup)) => {
                    hang_up(&deps.ari, &id).await;
                }
                Some(ToCall::Command(c)) => early_commands.push(c),
                // Lost while the line rings: nobody would hear the fault sentence yet, so the
                // ringing line is hung up (the talker, which would play it, starts at the answer).
                Some(ToCall::CoreLost) => {
                    let reason = "the core was unreachable during the call";
                    return fail_before_answer(&deps, &id, &reporter, reason).await;
                }
                Some(ToCall::Ari(_)) => {}
            },
            m = services.listen_rx.next() => match early(m) {
                Early::Fine => {}
                Early::Refused => {
                    let reason = "the listener refused the call";
                    return fail_before_answer(&deps, &id, &reporter, reason).await;
                }
                Early::Closed => {
                    let reason = "the listener closed before the answer";
                    return fail_before_answer(&deps, &id, &reporter, reason).await;
                }
            },
            m = services.speak_rx.next() => match early(m) {
                Early::Fine => {}
                Early::Refused => {
                    let reason = "the speaker refused the call";
                    return fail_before_answer(&deps, &id, &reporter, reason).await;
                }
                Early::Closed => {
                    let reason = "the speaker closed before the answer";
                    return fail_before_answer(&deps, &id, &reporter, reason).await;
                }
            },
            () = tokio::time::sleep_until(ring_until) => {
                info!(call = %id, "the line rang past its deadline");
                hang_up(&deps.ari, &id).await;
                reporter.hung_up("no_answer");
                return;
            },
        }
    }
    reporter.send(BridgeEvent::Answered);
    info!(call = %id, "answered");
    match Live::connect(&deps, &setup, services, cache, reporter.clone()).await {
        Ok(live) => live.run(rx, early_commands).await,
        Err(e) => {
            match &e.ari {
                Some(err) => {
                    warn!(call = %id, reason = e.reason, error = %err, "the call's media did not come up");
                }
                None => warn!(call = %id, reason = e.reason, "the call's media did not come up"),
            }
            reporter.fail(&e.words());
        }
    }
    // The caller's own channel too: the media or the speaker may have closed while the caller was
    // still on the line (404 when the caller already hung up; B5 review).
    hang_up(&deps.ari, &id).await;
    let _ = deps.ari.destroy_bridge(&format!("{id}-b")).await;
    let _ = deps.ari.hangup(&format!("{id}-m")).await;
}

struct InFlight {
    index: usize,
    id: String,
    pcm: Vec<i16>,
}

struct Playing {
    item: Item,
    sentences: Vec<Sentence>,
    next: usize,
    in_flight: Option<InFlight>,
    marked: usize,
    mark_at: Instant,
    audio_started: Option<Instant>,
    durations: Vec<Duration>,
    /// What had been asked of the pacing task when the item began: its first real frame is the
    /// first [`Sounding`] that [`Sounding::is_of`] it.
    start: Sounding,
}

/// What the call asks of its pacing task, in order.
enum PaceOp {
    /// Encoded audio of the playing sentence, unpadded: the pacer pads at the sentence's end.
    Audio(Vec<u8>),
    /// The sentence's end: `MARK_MEDIA` with this correlation id after its last frame.
    Mark(String),
    /// A barge-in: what is queued is dropped, `FLUSH_MEDIA` drops what Asterisk holds, and the
    /// lead of silence goes at once.
    Flush,
    /// `MEDIA_XOFF` and `MEDIA_XON`.
    Pause,
    Resume,
}

/// A point in the media's order: the flushes done, and the marks since the last of them. The
/// pacing task sends one when a real frame leaves after silence or a mark (the marks it had
/// written by then); the call keeps one of what it has asked (the marks it queued), and each
/// item starts at the call's. The pacer writes in the order it was asked, so a frame is of the
/// item playing only when no flush came between and every mark queued before that item had been
/// written (B5 re-review: with the flushes alone, a loop that read the item before's last mark
/// first took that item's last sentence as the next item's first audio).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Sounding {
    flushes: u64,
    marks: u64,
}

impl Sounding {
    /// Whether a frame that left at `self` is of the item that began at `start`.
    fn is_of(self, start: Sounding) -> bool {
        self.flushes == start.flushes && self.marks >= start.marks
    }

    /// The point after one more flush.
    fn flushed(self) -> Sounding {
        Sounding {
            flushes: self.flushes + 1,
            marks: 0,
        }
    }
}

/// The call's media writer. It alone owns the media socket's sink and the [`Pacer`], and writes
/// what the pacer has due every 20 ms for the whole call (silence when nothing plays, each mark
/// after its sentence's last frame), whatever the call's loop is waiting on. It ends when the call
/// drops its sender or the socket closes.
async fn pace_media(
    mut sink: MediaSink,
    silence: u8,
    mut ops: mpsc::UnboundedReceiver<PaceOp>,
    sounding: mpsc::UnboundedSender<Sounding>,
) {
    let started = Instant::now();
    let now_ms = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let mut pacer = Pacer::new(FRAME_BYTES, silence, now_ms());
    let mut tick = tokio::time::interval(Duration::from_millis(media::FRAME_MS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let (mut at, mut real) = (Sounding::default(), false);
    loop {
        tokio::select! {
            op = ops.recv() => match op {
                Some(PaceOp::Audio(bytes)) => {
                    pacer.audio(&bytes);
                    continue;
                }
                Some(PaceOp::Mark(correlation)) => {
                    pacer.mark(correlation);
                    continue;
                }
                Some(PaceOp::Flush) => {
                    pacer.flush(now_ms());
                    at = at.flushed();
                    real = false;
                    let flush = media::command("FLUSH_MEDIA", None);
                    if sink.send(Message::Text(flush.into())).await.is_err() {
                        return;
                    }
                }
                Some(PaceOp::Pause) => {
                    pacer.pause();
                    continue;
                }
                Some(PaceOp::Resume) => pacer.resume(now_ms()),
                None => return,
            },
            _ = tick.tick() => {}
        }
        for out in pacer.due(now_ms()) {
            let message = match out {
                Out::Frame { bytes, silence } => {
                    if !silence && !real {
                        let _ = sounding.send(at);
                    }
                    real = !silence;
                    Message::Binary(bytes.into())
                }
                Out::Mark(correlation) => {
                    real = false;
                    at.marks += 1;
                    Message::Text(media::command("MARK_MEDIA", Some(&correlation)).into())
                }
            };
            if sink.send(message).await.is_err() {
                return;
            }
        }
    }
}

struct Live {
    deps: Arc<CallDeps>,
    id: String,
    reporter: Reporter,
    cache: CallCache,
    /// The voice id of the live speaker's hello: this call files its audio under it.
    voice: String,
    /// The closing the bridge plays itself at `longest`.
    closing: String,
    /// When the call reaches its longest duration.
    longest: tokio::time::Instant,
    talker: Talker,
    started: Instant,
    codec: Codec,
    /// The pacing task's orders (`pace_media`, which owns the media socket's sink).
    pace: mpsc::UnboundedSender<PaceOp>,
    sounding_rx: Option<mpsc::UnboundedReceiver<Sounding>>,
    /// What was asked of the pacing task: its flushes, and the marks queued since the last.
    queued: Sounding,
    media_rx: Option<SplitStream<ari::Socket>>,
    listen_tx: SpeechSink,
    listen_rx: Option<SpeechStream>,
    speak_tx: SpeechSink,
    speak_rx: Option<SpeechStream>,
    /// The id of a cancelled synthesis whose terminal message has not come yet: until it does,
    /// every binary frame from the speaker is that synthesis's and is dropped.
    draining: Option<String>,
    playing: Option<Playing>,
    clock: AudioClock,
    marks: Option<TurnMarks>,
    onset: Option<Instant>,
    cut_reply: bool,
    pending_delivered: Option<oneshot::Receiver<()>>,
    pending_hangup: bool,
    /// When the line was answered, and whether the first audio after it was logged.
    answered: Instant,
    opening_logged: bool,
}

impl Live {
    /// Brings the answered call's media up: ARI's media setup on loopback is all that sits between
    /// the answer and the first frame (the speech services are connected already).
    async fn connect(
        deps: &Arc<CallDeps>,
        setup: &CallSetup,
        services: Services,
        cache: CallCache,
        reporter: Reporter,
    ) -> Result<Live, SetupError> {
        let answered = Instant::now();
        let longest = tokio::time::Instant::now() + setup.max_duration;
        let id = setup.bridge_call_id.clone();
        let media_id = format!("{id}-m");
        deps.ari
            .external_media(&media_id, "alaw")
            .await
            .map_err(SetupError::at("external media refused"))?;
        let connection = deps
            .ari
            .variable(&media_id, "MEDIA_WEBSOCKET_CONNECTION_ID")
            .await
            .map_err(SetupError::at("no media connection id"))?;
        // The media's WebSocket first: Asterisk puts the media channel into the application only
        // once it is connected, and refuses to bridge it before (422, B7 2026-10-30).
        let media = deps
            .ari
            .media(&connection)
            .await
            .map_err(SetupError::at("media unreachable"))?;
        let (media_tx, mut media_rx) = media.split();
        let bridge = format!("{id}-b");
        deps.ari
            .create_bridge(&bridge)
            .await
            .map_err(SetupError::at("the mixing bridge was refused"))?;
        deps.ari
            .add_channels(&bridge, &[&id])
            .await
            .map_err(SetupError::at("the caller could not be bridged"))?;
        let mix_until = tokio::time::Instant::now() + MIX_WAIT;
        loop {
            match deps.ari.add_channels(&bridge, &[&media_id]).await {
                Ok(()) => break,
                Err(AriError::Status(422)) if tokio::time::Instant::now() < mix_until => {
                    tokio::time::sleep(MIX_RETRY).await;
                }
                Err(e) => return Err(SetupError::at("the media could not be bridged")(e)),
            }
        }
        // A `MEDIA_START` sent before the bridge waits in the socket and is read now; the pacer
        // starts on it either way.
        let started = tokio::time::timeout(MEDIA_SETUP, async {
            while let Some(Ok(msg)) = media_rx.next().await {
                if let Message::Text(t) = msg
                    && let MediaEvent::Start {
                        format,
                        frame_bytes,
                        ptime_ms,
                    } = media::parse_control(&t)
                {
                    // G.711 in 20 ms frames only: the pacer's frame and clock (B5 review).
                    let fits =
                        frame_bytes == FRAME_BYTES && ptime_ms.is_none_or(|p| p == media::FRAME_MS);
                    return Codec::from_format(&format).filter(|_| fits);
                }
            }
            None
        })
        .await;
        let codec = started.ok().flatten().ok_or(SetupError {
            reason: "no media start",
            ari: None,
        })?;
        // The pacing task starts at once: RTP leaves from the media's start (B1 review).
        let (pace, ops) = mpsc::unbounded_channel();
        let (sounding_tx, sounding_rx) = mpsc::unbounded_channel();
        tokio::spawn(pace_media(
            media_tx,
            codec.encode(&[0])[0],
            ops,
            sounding_tx,
        ));
        Ok(Live {
            deps: deps.clone(),
            id,
            reporter,
            cache,
            voice: services.voice,
            closing: setup.closing.clone(),
            longest,
            talker: Talker::new(deps.timing, setup.script.phrases.clone()),
            started: Instant::now(),
            codec,
            pace,
            sounding_rx: Some(sounding_rx),
            queued: Sounding::default(),
            media_rx: Some(media_rx),
            listen_tx: services.listen_tx,
            listen_rx: Some(services.listen_rx),
            speak_tx: services.speak_tx,
            speak_rx: Some(services.speak_rx),
            draining: None,
            playing: None,
            clock: AudioClock::default(),
            marks: None,
            onset: None,
            cut_reply: false,
            pending_delivered: None,
            pending_hangup: false,
            answered,
            opening_logged: false,
        })
    }

    async fn run(mut self, mut rx: mpsc::Receiver<ToCall>, early: Vec<Command>) {
        let mut media_rx = self.media_rx.take().expect("connected");
        let mut listen_rx = self.listen_rx.take().expect("connected");
        let mut speak_rx = self.speak_rx.take().expect("connected");
        let mut sounding_rx = self.sounding_rx.take().expect("connected");
        for c in early {
            self.command(c).await;
        }
        let mut delivered: Option<oneshot::Receiver<()>> = None;
        let mut hangup_at: Option<tokio::time::Instant> = None;
        // The call's longest duration, then the cut of a closing the caller holds back past it,
        // then the end of a hangup Asterisk does not confirm (B6 review).
        let mut longest = Some(self.longest);
        let mut cut_at: Option<tokio::time::Instant> = None;
        let mut gone_by: Option<tokio::time::Instant> = None;
        // A closed listener's stream resolves at once on every pass: its arm is disabled once it
        // ends, so the fault sentence it asks for plays instead of a tight loop (B4 review I2).
        let mut listening = true;
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                m = media_rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => self.inbound_audio(&b).await,
                    Some(Ok(Message::Text(t))) => self.media_control(&t).await,
                    Some(Ok(_)) => {}
                    _ => {
                        // Asterisk restarted, or the media channel failed: the core hears it now,
                        // since the caller's hangup that follows reaches no call (B5 re-review).
                        warn!(call = %self.id, "the media closed");
                        self.reporter.fail("the media closed during the call");
                        break;
                    }
                },
                m = listen_rx.next(), if listening => match m {
                    Some(Ok(Message::Text(t))) => match serde_json::from_str::<Heard>(&t) {
                        Ok(h) => self.heard(h).await,
                        // A message this build cannot read inside a turn (an `error`, a kind it
                        // lacks): the turn's words are lost, so it ends as unheard (B4 re-review
                        // N3; the talker also closes a turn left open 35 s). The hello comes
                        // before any turn.
                        Err(_) if self.talker.turn_open() => self.input(Input::Unheard).await,
                        Err(_) => {}
                    },
                    Some(Ok(_)) => {}
                    _ => {
                        listening = false;
                        warn!(call = %self.id, "the listener closed");
                        self.reporter.fail("the listener stopped during the call");
                        // A turn the caller had open ends as unheard words, after the loss (so no
                        // "not heard" is queued): the fault sentence would otherwise wait for a
                        // pause the listener can no longer report (B6 review).
                        let open = self.talker.turn_open();
                        self.input(Input::CoreLost).await;
                        if open {
                            self.input(Input::Unheard).await;
                        }
                    }
                },
                m = speak_rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => self.synth_chunk(&b).await,
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(s) = serde_json::from_str::<Spoken>(&t) {
                            self.synth_event(s).await;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => {
                        warn!(call = %self.id, "the speaker closed");
                        self.reporter.fail("the speaker stopped during the call");
                        break;
                    }
                },
                s = sounding_rx.recv() => match s {
                    Some(at) => self.sounding(at),
                    // The pacing task ended: its socket failed, and no RTP leaves any more.
                    None => {
                        warn!(call = %self.id, "the media writer stopped");
                        self.reporter.fail("the media closed during the call");
                        break;
                    }
                },
                c = rx.recv() => match c {
                    Some(ToCall::Command(c)) => self.command(c).await,
                    Some(ToCall::Ari(AriEvent::Dtmf { channel, digit })) if channel == self.id => {
                        self.reporter.send(BridgeEvent::Dtmf { digit });
                    }
                    Some(ToCall::Ari(AriEvent::Gone { channel, .. })) if channel == self.id => {
                        self.reporter.hung_up("normal");
                        break;
                    }
                    Some(ToCall::Ari(_)) => {}
                    Some(ToCall::CoreLost) => {
                        // Reported first, so the core ends the session as failed when it is back.
                        self.reporter.fail("the core was unreachable during the call");
                        self.input(Input::CoreLost).await;
                    }
                    None => break,
                },
                r = async { delivered.as_mut().expect("guarded").await }, if delivered.is_some() => {
                    delivered = None;
                    if r.is_ok() && let Some(m) = self.marks.as_mut() {
                        m.delivered = Some(Instant::now());
                    }
                },
                _ = async { tokio::time::sleep_until(hangup_at.expect("guarded")).await }, if hangup_at.is_some() => {
                    hangup_at = None;
                    self.spawn_hangup();
                    gone_by = Some(tokio::time::Instant::now() + self.deps.waits.gone);
                },
                _ = async { tokio::time::sleep_until(longest.expect("guarded")).await }, if longest.is_some() => {
                    longest = None;
                    cut_at = Some(tokio::time::Instant::now() + CLOSE_GRACE);
                    info!(call = %self.id, "the call reached its longest duration");
                    let text = self.closing.clone();
                    self.input(Input::Close { text }).await;
                },
                _ = async { tokio::time::sleep_until(cut_at.expect("guarded")).await }, if cut_at.is_some() => {
                    warn!(call = %self.id, "the closing was held back past the longest duration");
                    self.reporter.hung_up("normal");
                    break;
                },
                _ = async { tokio::time::sleep_until(gone_by.expect("guarded")).await }, if gone_by.is_some() => {
                    // Asterisk's events may be lost: the call ends, and its cleanup hangs the line
                    // up again.
                    warn!(call = %self.id, "Asterisk did not confirm the hangup");
                    self.reporter.hung_up("normal");
                    break;
                },
                _ = tick.tick() => self.input(Input::Tick).await,
            }
            if let Some(r) = self.pending_delivered.take() {
                delivered = Some(r);
            }
            if std::mem::take(&mut self.pending_hangup) {
                hangup_at = Some(tokio::time::Instant::now() + HANGUP_TAIL);
            }
        }
        self.finish_turn();
        info!(call = %self.id, "ended");
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    async fn input(&mut self, input: Input) {
        let now = self.now_ms();
        for action in self.talker.on(input, now) {
            self.act(action).await;
        }
    }

    async fn act(&mut self, action: Action) {
        match action {
            Action::EchoGuard(active) => {
                let _ = self
                    .listen_tx
                    .send(text_message(&ToListener::Playback { active }))
                    .await;
            }
            Action::Play(item) => {
                if let Source::Phrase { set, index } = item.source {
                    self.reporter.send(BridgeEvent::Phrase { set, index });
                }
                let mut sentences = text::sentences(&item.text);
                if sentences.is_empty() {
                    sentences.push(Sentence {
                        start: 0,
                        end: item.text.chars().count(),
                        text: item.text.clone(),
                    });
                }
                self.playing = Some(Playing {
                    item,
                    sentences,
                    next: 0,
                    in_flight: None,
                    marked: 0,
                    mark_at: Instant::now(),
                    audio_started: None,
                    durations: Vec::new(),
                    start: self.queued,
                });
                self.advance().await;
            }
            Action::Done(item) => {
                if let Source::Core { seq, .. } = item.source {
                    self.reporter.send(BridgeEvent::Said {
                        seq,
                        interrupted_at_char: None,
                        tts_ms: None,
                    });
                }
            }
            Action::Cut { item, dropped } => self.cut(item, dropped).await,
            // Queued while the caller held them back, and dropped when the core was lost (B4 review M1).
            Action::Dropped(items) => {
                for d in items {
                    if let Source::Core { seq, .. } = d.source {
                        self.reporter.send(BridgeEvent::Said {
                            seq,
                            interrupted_at_char: Some(0),
                            tts_ms: None,
                        });
                    }
                }
            }
            Action::Hangup => self.pending_hangup = true,
        }
    }

    /// Hangs the caller's channel up without holding the loop: ARI may take its 5 s (B5 review),
    /// and a refusal is asked again (B6 review).
    fn spawn_hangup(&self) {
        let (ari, id) = (self.deps.ari.clone(), self.id.clone());
        tokio::spawn(async move {
            if !hang_up(&ari, &id).await {
                warn!(call = %id, "Asterisk refused the hangup");
            }
        });
    }

    /// Marks the turn's first sounds: the reply's first audio, a covering phrase's first audio.
    fn first_audio_marks(&mut self) {
        let Some(p) = self.playing.as_ref() else {
            return;
        };
        if p.audio_started.is_some() {
            return;
        }
        let reply = matches!(p.item.source, Source::Core { agent: true, .. });
        let cover = matches!(
            p.item.source,
            Source::Phrase {
                set: PhraseSet::Acknowledgement | PhraseSet::Filler | PhraseSet::LongWait,
                ..
            }
        );
        let now = Instant::now();
        if let Some(m) = self.marks.as_mut() {
            if reply && m.first_audio.is_none() {
                m.first_audio = Some(now);
                m.tts_first.get_or_insert(now);
            }
            if cover && m.ack.is_none() {
                m.ack = Some(now);
            }
        }
    }

    /// A real frame left for Asterisk at `at`, after silence or a mark. On the playing item's first
    /// one (not a cut item's, nor the item before's: [`Sounding::is_of`]) the turn's first-audio
    /// marks, the opening's log line and the item's audio clock start, not when the audio was
    /// queued. Asterisk holds the lead: the caller hears the frame about 60 ms later.
    fn sounding(&mut self, at: Sounding) {
        let first = self
            .playing
            .as_ref()
            .is_some_and(|p| p.audio_started.is_none() && at.is_of(p.start));
        if !first {
            return;
        }
        self.first_audio_marks();
        if !self.opening_logged {
            self.opening_logged = true;
            let ms = u64::try_from(self.answered.elapsed().as_millis()).unwrap_or(u64::MAX);
            info!(call = %self.id, ms, "first audio after the answer");
        }
        if let Some(p) = self.playing.as_mut() {
            let now = Instant::now();
            p.audio_started = Some(now);
            p.mark_at = now;
        }
    }

    /// Hands the sentence's audio to the pacing task, unpadded: the pacer pads at the sentence's end.
    fn write_pcm(&self, pcm: &[i16]) {
        let _ = self.pace.send(PaceOp::Audio(self.codec.encode(pcm)));
    }

    /// Ends the sentence for the pacer: its `MARK_MEDIA` goes after its last frame.
    fn mark(&mut self, item: u64, index: usize) {
        self.queued.marks += 1;
        let _ = self.pace.send(PaceOp::Mark(format!("{item}:{index}")));
    }

    /// Writes the playing item's next sentences from the cache, or asks the speaker for the next one
    /// (at most one sentence ahead of what was heard).
    async fn advance(&mut self) {
        loop {
            let Some(p) = self.playing.as_mut() else {
                return;
            };
            if p.in_flight.is_some() || p.next >= p.sentences.len() || p.next > p.marked + 1 {
                return;
            }
            let index = p.next;
            let sentence = p.sentences[index].text.clone();
            let item = p.item.id;
            let hit = self
                .cache
                .phrases
                .lock()
                .ok()
                .and_then(|mut c| c.get(&sentence));
            match hit {
                Some(pcm) => {
                    if let Some(p) = self.playing.as_mut() {
                        p.next += 1;
                        p.durations.push(audio_duration(pcm.len()));
                    }
                    self.write_pcm(&pcm);
                    self.mark(item, index);
                }
                None => {
                    let id = format!("{item}:{index}");
                    if let Some(p) = self.playing.as_mut() {
                        p.in_flight = Some(InFlight {
                            index,
                            id: id.clone(),
                            pcm: Vec::new(),
                        });
                    }
                    let synth = ToSpeaker::Synth { id, text: sentence };
                    let _ = self.speak_tx.send(text_message(&synth)).await;
                    return;
                }
            }
        }
    }

    async fn synth_chunk(&mut self, bytes: &[u8]) {
        if self.draining.is_some() {
            return; // a cancelled synthesis's frame (its terminal message has not come yet)
        }
        if self
            .playing
            .as_ref()
            .and_then(|p| p.in_flight.as_ref())
            .is_none()
        {
            return;
        }
        let Some(pcm) = pcm16(bytes) else {
            warn!(call = %self.id, "the speaker sent a frame that is no PCM16");
            self.fail_synthesis().await;
            return;
        };
        if let Some(f) = self.playing.as_mut().and_then(|p| p.in_flight.as_mut()) {
            f.pcm.extend_from_slice(&pcm);
        }
        self.write_pcm(&pcm);
    }

    /// Ends the synthesis in flight as failed (B5 review): it is cancelled at the speaker (its
    /// frames dropped until its terminal message, as after a cut), and its sentence is marked
    /// with what was written of it, so the item goes on.
    async fn fail_synthesis(&mut self) {
        let Some(p) = self.playing.as_mut() else {
            return;
        };
        let Some(f) = p.in_flight.take() else {
            return;
        };
        p.durations.push(audio_duration(f.pcm.len()));
        p.next = f.index + 1;
        let item = p.item.id;
        let cancel = ToSpeaker::Cancel { id: f.id.clone() };
        let _ = self.speak_tx.send(text_message(&cancel)).await;
        self.draining = Some(f.id);
        self.mark(item, f.index);
        self.advance().await;
    }

    async fn synth_event(&mut self, spoken: Spoken) {
        let terminal = match &spoken {
            Spoken::Done { id, .. } | Spoken::Cancelled { id } => Some(id.as_str()),
            Spoken::Error { id, .. } => id.as_deref(),
            Spoken::Hello { .. } => None,
        };
        if terminal.is_some() && terminal == self.draining.as_deref() {
            // The cancelled synthesis has ended: done, cancelled or error (a cancel can lose the race).
            self.draining = None;
            return;
        }
        let (id, ok) = match spoken {
            Spoken::Done { id, .. } => (id, true),
            Spoken::Error { id: Some(id), .. } => (id, false),
            _ => return,
        };
        let Some(p) = self.playing.as_mut() else {
            return;
        };
        if p.in_flight.as_ref().is_none_or(|f| f.id != id) {
            return;
        }
        let f = p.in_flight.take().expect("checked above");
        let sentence = p.sentences[f.index].text.clone();
        let item = p.item.id;
        p.durations.push(audio_duration(f.pcm.len()));
        p.next = f.index + 1;
        if !ok {
            warn!(call = %self.id, "a sentence could not be synthesised");
        } else if !f.pcm.is_empty() {
            // Kept under the live speaker's voice; a disk error is logged once a call, and the
            // sentence still plays from memory (B5 review).
            self.cache.file(&self.id, &self.voice, &sentence, f.pcm);
        }
        self.mark(item, f.index);
        self.advance().await;
    }

    async fn media_control(&mut self, control: &str) {
        match media::parse_control(control) {
            MediaEvent::MarkProcessed { correlation } => {
                let Some((item, index)) = parse_mark(&correlation) else {
                    return;
                };
                let finished = match self.playing.as_mut() {
                    Some(p) if p.item.id == item => {
                        p.marked = index + 1;
                        p.mark_at = Instant::now();
                        p.marked >= p.sentences.len()
                    }
                    _ => return,
                };
                if finished {
                    self.input(Input::Played { id: item }).await;
                } else {
                    self.advance().await;
                }
            }
            MediaEvent::Xoff => {
                let _ = self.pace.send(PaceOp::Pause);
            }
            MediaEvent::Xon => {
                let _ = self.pace.send(PaceOp::Resume);
            }
            // DTMF is read from ARI (`ChannelDtmfReceived`), once.
            MediaEvent::Dtmf { .. } | MediaEvent::Start { .. } | MediaEvent::Other => {}
        }
    }

    async fn cut(&mut self, item: Item, dropped: Vec<Item>) {
        // The pacing task drops what it holds, sends `FLUSH_MEDIA` and the lead of silence at
        // once; a `Sounding` it sent before the flush is a cut item's.
        self.queued = self.queued.flushed();
        let _ = self.pace.send(PaceOp::Flush);
        let mut heard = 0;
        if let Some(mut p) = self.playing.take() {
            if p.item.id == item.id {
                if let Some(f) = p.in_flight.take() {
                    let cancel = ToSpeaker::Cancel { id: f.id.clone() };
                    let _ = self.speak_tx.send(text_message(&cancel)).await;
                    self.draining = Some(f.id);
                }
                let fraction = match (p.audio_started, p.durations.get(p.marked)) {
                    (Some(_), Some(d)) if !d.is_zero() => {
                        p.mark_at.elapsed().as_secs_f64() / d.as_secs_f64()
                    }
                    (Some(_), _) => 0.5,
                    (None, _) => 0.0,
                };
                heard = text::heard_chars(&p.sentences, p.marked, fraction);
            } else {
                self.playing = Some(p);
            }
        }
        if let Source::Core { seq, agent } = item.source {
            self.reporter.send(BridgeEvent::Said {
                seq,
                interrupted_at_char: Some(heard),
                tts_ms: None,
            });
            if agent && let (Some(onset), Some(m)) = (self.onset, self.marks.as_mut()) {
                m.barge_in_stop_ms =
                    Some(u32::try_from(onset.elapsed().as_millis()).unwrap_or(u32::MAX));
                self.cut_reply = true;
            }
        }
        for d in dropped {
            if let Source::Core { seq, .. } = d.source {
                self.reporter.send(BridgeEvent::Said {
                    seq,
                    interrupted_at_char: Some(0),
                    tts_ms: None,
                });
            }
        }
    }

    async fn inbound_audio(&mut self, bytes: &[u8]) {
        let pcm = self.codec.decode(bytes);
        self.clock
            .push(pcm.len() as u64 * 1_000 / SAMPLE_RATE, Instant::now());
        let out: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        let _ = self.listen_tx.send(Message::Binary(out.into())).await;
    }

    async fn heard(&mut self, heard: Heard) {
        match heard {
            Heard::SpeechStart { audio_ms } | Heard::Resume { audio_ms } => {
                self.onset = Some(self.clock.at(audio_ms).unwrap_or_else(Instant::now));
                self.input(Input::SpeechStart).await;
            }
            Heard::SpeechEnd { .. } => self.input(Input::SpeechEnd).await,
            Heard::Partial { .. } => {}
            Heard::Unheard { .. } => self.input(Input::Unheard).await,
            Heard::Final {
                text,
                confidence,
                speech_end_ms,
                endpoint_ms,
                endpoint_by,
                stt_ms,
            } => {
                if self.cut_reply
                    && let Some(m) = self.marks.as_mut()
                {
                    m.backchannel_cut = text::is_backchannel(&text);
                }
                self.finish_turn();
                let now = Instant::now();
                let speech_end = self.clock.at(speech_end_ms).unwrap_or(now);
                let endpoint =
                    u32::try_from(endpoint_ms.saturating_sub(speech_end_ms)).unwrap_or(u32::MAX);
                self.marks = Some(TurnMarks::new(speech_end, endpoint, endpoint_by, now));
                let utterance = BridgeEvent::Utterance {
                    text,
                    is_final: true,
                    confidence,
                    stt_ms: Some(stt_ms),
                };
                self.pending_delivered = Some(self.reporter.send_taken(utterance));
                self.input(Input::Final).await;
            }
        }
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Say {
                seq,
                text,
                allow_barge_in,
            } => {
                if let Some(m) = self.marks.as_mut() {
                    m.say.get_or_insert_with(Instant::now);
                    // The key the core matches its own latency for this sentence by (`summarize`).
                    m.reply_seq.get_or_insert(seq);
                }
                self.input(Input::Speak {
                    seq,
                    text,
                    barge_in: allow_barge_in,
                    agent: true,
                })
                .await;
            }
            Command::Play {
                seq, clip, text, ..
            } => {
                // Heard in full: the opening (the workspace's opening, the disclosure and the
                // transcript notice, then the plan's; B6 review), the recording announcement and
                // the closing (B4 review C1; the talker hangs up after a cut one all the same).
                // The holding and fallback lines may be cut.
                let barge_in = !matches!(
                    clip,
                    PlayKind::Opening | PlayKind::Announcement | PlayKind::Closing
                );
                self.input(Input::Speak {
                    seq,
                    text,
                    barge_in,
                    agent: false,
                })
                .await;
            }
            Command::Hangup => self.input(Input::HangupWhenDone).await,
            Command::Transfer { to } => {
                // Spawned: ARI may take its 5 s, and the call's loop never waits on it (B5 review).
                let (ari, id, reporter) = (
                    self.deps.ari.clone(),
                    self.id.clone(),
                    self.reporter.clone(),
                );
                tokio::spawn(async move {
                    if ari
                        .redirect(&id, &format!("PJSIP/{to}@netgsm"))
                        .await
                        .is_err()
                    {
                        warn!(call = %id, "Asterisk refused the transfer");
                        reporter.fail("the transfer was refused");
                    }
                });
            }
            Command::Record { .. } | Command::Answer { .. } | Command::Dial { .. } => {}
        }
    }

    /// Reports the turn's trace (to the core, and to the bridge's trace file).
    fn finish_turn(&mut self) {
        let Some(marks) = self.marks.take() else {
            self.cut_reply = false;
            return;
        };
        self.cut_reply = false;
        let trace = marks.trace();
        if let Some(file) = &self.deps.traces
            && file.append(&self.id, &trace).is_err()
        {
            warn!(call = %self.id, "the trace file could not be written");
        }
        self.reporter.send(BridgeEvent::Trace { trace });
    }
}

#[cfg(test)]
mod tests {
    use super::Sounding;

    /// B5 re-review: a frame is the playing item's only after every mark queued before the item
    /// was written, and only within the flush the item began in.
    #[test]
    fn a_frame_is_the_playing_items_once_every_earlier_mark_is_written() {
        let start = Sounding {
            flushes: 1,
            marks: 3,
        };
        // The item before's last sentence: its mark had not been written yet.
        assert!(
            !Sounding {
                flushes: 1,
                marks: 2
            }
            .is_of(start)
        );
        // A cut item's frame, from before the flush.
        assert!(
            !Sounding {
                flushes: 0,
                marks: 5
            }
            .is_of(start)
        );
        // The item's own first frame, and one of a later sentence of it.
        assert!(start.is_of(start));
        assert!(
            Sounding {
                flushes: 1,
                marks: 4
            }
            .is_of(start)
        );
        // A flush counts the marks again from none.
        assert_eq!(
            start.flushed(),
            Sounding {
                flushes: 2,
                marks: 0
            }
        );
    }
}
