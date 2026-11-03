//! `jeeta-voice-bridge slice`: the vertical slice of plan task B6, without the core. It dials the
//! number in `SLICE_TO` (+90…, read from the environment so it is in no command line), plays the
//! opening when answered, waits for one caller turn, lets `--think-ms` pass (the bridge covers it
//! with its own acknowledgement and filler, as with a thinking agent), plays the reply and the
//! approved closing, hangs up, and prints every turn's trace as JSON. `--show-transcript` prints the
//! caller's words to this terminal only (never to the log).
//!
//! The reports are printed as they come, the think time included (it runs in a task of its own).
//! The opening is heard in full; the caller's turn is the first one that ends after it (words over
//! the opening, an "Alo?", wait), or, when the caller spoke only over the opening, the words spoken
//! over it, once no other turn ended [`OVER_OPENING_WAIT`] after the opening ([`ReplyTurn`]).
//! Ctrl-C hangs the line up, before the dial too (then no
//! phone rings), and the call ends as at the caller's hangup; a second one quits at once. After an
//! `error` the slice waits for the call's task to hang the line up before it exits. The call ends
//! by itself `VOICE_MAX_CALL_S` after the answer (600 s), and if Asterisk's events end.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use jt_calls::{BridgeEvent, BridgePhrases, CLOSING, Command, DialScript, PlayKind};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::ari::{self, Ari, AriEvent};
use crate::call::{CallDeps, CallSetup, LineWaits, ToCall, run_call};
use crate::config::Config;
use crate::netgsm;
use crate::trace::TraceFile;

struct Args {
    opening: String,
    reply: String,
    think: Duration,
    show_transcript: bool,
}

/// How long after the opening's end the slice waits for a turn of the caller's before it answers
/// the words spoken over the opening: the listener's end of a turn after silence (design addendum
/// §6, 1.5 s without Smart Turn's "complete").
pub const OVER_OPENING_WAIT: Duration = Duration::from_millis(1_500);

/// Which of the caller's turns the slice answers, once. The first turn that ends after the opening
/// was heard to its end; words spoken over the opening (an "Alo?") wait for it. When the caller
/// spoke only over the opening, those words are the turn, answered once [`OVER_OPENING_WAIT`]
/// passed after the opening with no other turn (live use after B7: the slice never answered such
/// a caller, whose wait the bridge covered with its acknowledgement, filler and long wait until
/// the call ended at `VOICE_MAX_CALL_S`). The bridge itself owes that turn its reply from the
/// opening's end, as the core's agent gives it in `run` (design addendum §3, "Heard in full").
///
/// It holds the caller's words, so it has no `Debug`.
#[derive(Default)]
pub struct ReplyTurn {
    opening: Option<u32>,
    opened: bool,
    over_opening: Option<String>,
    replied: bool,
}

impl ReplyTurn {
    /// The opening was asked to play as `seq`.
    pub fn opening_asked(&mut self, seq: u32) {
        self.opening = Some(seq);
    }

    /// Line `seq` ended. True when it was the opening and words spoken over it wait for an
    /// answer: the caller then waits [`OVER_OPENING_WAIT`] and asks [`ReplyTurn::waited`].
    pub fn said(&mut self, seq: u32) -> bool {
        if self.opened || Some(seq) != self.opening {
            return false;
        }
        self.opened = true;
        !self.replied && self.over_opening.is_some()
    }

    /// The caller's final words: the words to answer now, if this is the turn.
    pub fn utterance(&mut self, words: String) -> Option<String> {
        if self.replied {
            return None;
        }
        if !self.opened {
            self.over_opening = Some(words);
            return None;
        }
        self.replied = true;
        self.over_opening = None;
        Some(words)
    }

    /// Whether the turn to answer was given out.
    pub fn answered(&self) -> bool {
        self.replied
    }

    /// [`OVER_OPENING_WAIT`] passed after the opening: the words spoken over it, when no other
    /// turn was answered meanwhile.
    pub fn waited(&mut self) -> Option<String> {
        if self.replied || !self.opened {
            return None;
        }
        let words = self.over_opening.take()?;
        self.replied = true;
        Some(words)
    }
}

fn parse(args: &[String]) -> Option<Args> {
    let mut a = Args {
        opening: String::new(),
        reply: String::new(),
        think: Duration::from_millis(3_000),
        show_transcript: false,
    };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--opening" => a.opening = it.next()?.clone(),
            "--reply" => a.reply = it.next()?.clone(),
            "--think-ms" => a.think = Duration::from_millis(it.next()?.parse().ok()?),
            "--show-transcript" => a.show_transcript = true,
            _ => return None,
        }
    }
    (!a.opening.is_empty() && !a.reply.is_empty()).then_some(a)
}

pub async fn main(args: &[String]) -> ExitCode {
    let Some(args) = parse(args) else {
        eprintln!(
            "usage: jeeta-voice-bridge slice --opening TEXT --reply TEXT [--think-ms N] [--show-transcript]"
        );
        return ExitCode::from(2);
    };
    let Some(dial) = std::env::var("SLICE_TO")
        .ok()
        .as_deref()
        .and_then(netgsm::dial_string)
    else {
        eprintln!("SLICE_TO must hold a number the line may call (+90 and 2, 3, 4, 5, 800 or 850)");
        return ExitCode::from(2);
    };
    let config = match Config::from_env(|k| std::env::var(k).ok(), false) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let ari = match Ari::new(&config.ari_url, &config.ari_user, &config.ari_password) {
        Ok(a) => Arc::new(a),
        Err(e) => {
            eprintln!("ARI: {e}");
            return ExitCode::FAILURE;
        }
    };
    let deps = Arc::new(CallDeps {
        ari: ari.clone(),
        listen: config.listen.clone(),
        speak: config.speak.clone(),
        cache_dir: config.cache_dir.clone(),
        timing: config.timing,
        traces: Some(TraceFile::new(config.trace_file.clone())),
        waits: LineWaits::default(),
    });
    let (to_call, rx) = mpsc::channel(64);
    let (reports_tx, mut reports) = mpsc::unbounded_channel();
    let events = match ari.events().await {
        Ok(e) => e,
        Err(e) => {
            eprintln!("ARI events: {e}");
            return ExitCode::FAILURE;
        }
    };
    let id = uuid::Uuid::now_v7().to_string();
    let (forward, forward_id) = (to_call.clone(), id.clone());
    tokio::spawn(async move {
        let mut events = events;
        // Asterisk's pings and other frames are passed over.
        while let Some(Ok(message)) = events.next().await {
            if let Message::Text(t) = message {
                let _ = forward.send(ToCall::Ari(ari::parse_event(&t))).await;
            }
        }
        // Without Asterisk's events the call would wait for a hangup it never hears: it ends now,
        // and its task hangs the line up (B6 review).
        eprintln!("Asterisk's events ended: the call ends");
        let gone = AriEvent::Gone {
            channel: forward_id,
            cause: None,
        };
        let _ = forward.send(ToCall::Ari(gone)).await;
    });
    let (hang_ari, hang_id, hang_call) = (ari.clone(), id.clone(), to_call.clone());
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_err() {
            return;
        }
        eprintln!("hanging up (Ctrl-C again quits at once)");
        // Asked of the call too: before the dial it then dials nobody (B6 review).
        let _ = hang_call.try_send(ToCall::Command(Command::Hangup));
        tokio::spawn(async move {
            let _ = hang_ari.hangup(&hang_id).await;
        });
        if tokio::signal::ctrl_c().await.is_ok() {
            std::process::exit(130);
        }
    });
    let setup = CallSetup {
        bridge_call_id: id,
        dial,
        script: DialScript {
            lines: vec![args.opening.clone()],
            phrases: BridgePhrases::default(),
            hotwords: Vec::new(),
        },
        // The opening first: it is what the answer plays, so it is synthesised ahead first (B6
        // review); as a policy line it is also kept on disk.
        plan_lines: vec![args.opening.clone(), args.reply.clone(), CLOSING.to_owned()],
        closing: CLOSING.to_owned(),
        max_duration: Duration::from_secs(config.max_call_s),
    };
    tokio::spawn(run_call(deps, setup, rx, reports_tx));
    let mut seq = 0u32;
    let mut turns = ReplyTurn::default();
    // When the words spoken over the opening are answered, unless another turn ends first.
    let mut over_opening_until: Option<tokio::time::Instant> = None;
    let mut failed = false;
    loop {
        let wait = over_opening_until;
        // The words of the turn to answer now, if one is.
        let mut heard = None;
        tokio::select! {
            report = reports.recv() => {
                let Some(report) = report else { break };
                if let Some(taken) = report.taken {
                    let _ = taken.send(());
                }
                match report.event {
                    BridgeEvent::Answered => {
                        println!("answered");
                        seq += 1;
                        turns.opening_asked(seq);
                        let play = Command::Play {
                            seq,
                            clip: PlayKind::Opening,
                            index: 0,
                            text: args.opening.clone(),
                        };
                        let _ = to_call.send(ToCall::Command(play)).await;
                    }
                    BridgeEvent::Utterance { text, .. } => {
                        heard = turns.utterance(text);
                        if heard.is_some() {
                            over_opening_until = None;
                        } else if !turns.answered() {
                            println!("the caller spoke over the opening: the turn waits for its end");
                        }
                    }
                    BridgeEvent::Phrase { set, index } => println!("phrase {set:?} {index}"),
                    BridgeEvent::Said {
                        seq,
                        interrupted_at_char,
                        ..
                    } => {
                        println!("said {seq} cut at {interrupted_at_char:?}");
                        if turns.said(seq) {
                            over_opening_until =
                                Some(tokio::time::Instant::now() + OVER_OPENING_WAIT);
                        }
                    }
                    BridgeEvent::Trace { trace } => {
                        println!(
                            "trace {}",
                            serde_json::to_string(&trace).unwrap_or_default()
                        )
                    }
                    BridgeEvent::Hangup { cause } => println!("hangup {cause}"),
                    BridgeEvent::Error { failure_line } => {
                        // The call's task hangs the line up and then ends, which closes the
                        // reports.
                        eprintln!("error: {failure_line}");
                        failed = true;
                    }
                    _ => {}
                }
            }
            // Evaluated while disabled too, so it needs an instant then (never polled).
            () = tokio::time::sleep_until(wait.unwrap_or_else(tokio::time::Instant::now)),
                if wait.is_some() =>
            {
                over_opening_until = None;
                heard = turns.waited();
                if heard.is_some() {
                    println!("no turn followed the opening: the words spoken over it are answered");
                }
            }
        }
        if let Some(text) = heard {
            if args.show_transcript {
                println!("caller: {text}");
            }
            answer(&to_call, &mut seq, args.think, args.reply.clone());
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// Answers the caller's turn as a thinking agent would: `think` later the reply, then the closing
/// and the hangup, in a task of its own, so what the bridge plays meanwhile (its acknowledgement,
/// filler and long wait) is printed as it happens.
fn answer(to_call: &mpsc::Sender<ToCall>, seq: &mut u32, think: Duration, reply: String) {
    let (say_seq, closing_seq) = (*seq + 1, *seq + 2);
    *seq += 2;
    let to_call = to_call.clone();
    tokio::spawn(async move {
        tokio::time::sleep(think).await;
        let say = Command::Say {
            seq: say_seq,
            text: reply,
            allow_barge_in: true,
        };
        let _ = to_call.send(ToCall::Command(say)).await;
        let closing = Command::Play {
            seq: closing_seq,
            clip: PlayKind::Closing,
            index: 0,
            text: CLOSING.to_owned(),
        };
        let _ = to_call.send(ToCall::Command(closing)).await;
        let _ = to_call.send(ToCall::Command(Command::Hangup)).await;
    });
}
