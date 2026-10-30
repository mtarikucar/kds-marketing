//! `jeeta-voice-bridge slice`: the vertical slice of plan task B6, without the core. It dials the
//! number in `SLICE_TO` (+90…, read from the environment so it is in no command line), plays the
//! opening when answered, waits for one caller turn, lets `--think-ms` pass (the bridge covers it
//! with its own acknowledgement and filler, as with a thinking agent), plays the reply and the
//! approved closing, hangs up, and prints every turn's trace as JSON. `--show-transcript` prints the
//! caller's words to this terminal only (never to the log).
//!
//! The reports are printed as they come, the think time included (it runs in a task of its own).
//! Ctrl-C hangs the line up, and the call ends as at the caller's hangup; a second one quits at
//! once. After an `error` the slice waits for the call's task to hang the line up before it exits.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use jt_calls::{BridgeEvent, BridgePhrases, CLOSING, Command, DialScript, PlayKind};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::ari::{self, Ari};
use crate::call::{CallDeps, CallSetup, ToCall, run_call};
use crate::config::Config;
use crate::netgsm;
use crate::trace::TraceFile;

struct Args {
    opening: String,
    reply: String,
    think: Duration,
    show_transcript: bool,
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
    let forward = to_call.clone();
    tokio::spawn(async move {
        let mut events = events;
        // Asterisk's pings and other frames are passed over; the stream's end ends the forwarding.
        while let Some(Ok(message)) = events.next().await {
            if let Message::Text(t) = message {
                let _ = forward.send(ToCall::Ari(ari::parse_event(&t))).await;
            }
        }
    });
    let id = uuid::Uuid::now_v7().to_string();
    let (hang_ari, hang_id) = (ari.clone(), id.clone());
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_err() {
            return;
        }
        eprintln!("hanging up (Ctrl-C again quits at once)");
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
        plan_lines: vec![args.reply.clone(), CLOSING.to_owned()],
    };
    tokio::spawn(run_call(deps, setup, rx, reports_tx));
    let mut seq = 0u32;
    let mut replied = false;
    let mut failed = false;
    while let Some(report) = reports.recv().await {
        if let Some(taken) = report.taken {
            let _ = taken.send(());
        }
        match report.event {
            BridgeEvent::Answered => {
                println!("answered");
                seq += 1;
                let play = Command::Play {
                    seq,
                    clip: PlayKind::Opening,
                    index: 0,
                    text: args.opening.clone(),
                };
                let _ = to_call.send(ToCall::Command(play)).await;
            }
            BridgeEvent::Utterance { text, .. } if !replied => {
                replied = true;
                if args.show_transcript {
                    println!("caller: {text}");
                }
                // The agent's think time, in a task of its own: what the bridge plays meanwhile
                // (its acknowledgement, filler and long wait) is printed as it happens.
                let (say_seq, closing_seq) = (seq + 1, seq + 2);
                seq += 2;
                let (to_call, think, reply) = (to_call.clone(), args.think, args.reply.clone());
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
            BridgeEvent::Phrase { set, index } => println!("phrase {set:?} {index}"),
            BridgeEvent::Said {
                seq,
                interrupted_at_char,
                ..
            } => println!("said {seq} cut at {interrupted_at_char:?}"),
            BridgeEvent::Trace { trace } => {
                println!(
                    "trace {}",
                    serde_json::to_string(&trace).unwrap_or_default()
                )
            }
            BridgeEvent::Hangup { cause } => println!("hangup {cause}"),
            BridgeEvent::Error { failure_line } => {
                // The call's task hangs the line up and then ends, which closes the reports.
                eprintln!("error: {failure_line}");
                failed = true;
            }
            _ => {}
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
