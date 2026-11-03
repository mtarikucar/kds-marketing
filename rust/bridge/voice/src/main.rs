//! `jeeta-voice-bridge [run | slice … | report [--since RFC3339] | check]`.
//!
//! - `run` (default): the workspace's line (task D2).
//! - `slice`: one test call without the core (`slice.rs`).
//! - `report`: p50/p95 of the traces in `VOICE_TRACE_FILE`, optionally since a time.
//! - `check`: reaches ARI and both speech services, and says which answer.
//!
//! The log filter is `JEETA_VOICE_BRIDGE_LOG` (default `info`); the HTTP and WebSocket libraries log
//! at `info` at most whatever it asks (`log_filter`).

use std::process::ExitCode;

use jeeta_voice_bridge::config::Config;
use jeeta_voice_bridge::trace::read_traces;
use jeeta_voice_bridge::{ari::Ari, log_filter, run_loop, slice, speech};
use time::OffsetDateTime;

const USAGE: &str = "usage: jeeta-voice-bridge [run | slice --opening TEXT --reply TEXT [--think-ms N] [--show-transcript] | report [--since RFC3339] | check]";

fn main() -> ExitCode {
    let spec = std::env::var("JEETA_VOICE_BRIDGE_LOG").ok();
    tracing_subscriber::fmt()
        .with_env_filter(log_filter(spec.as_deref()))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        return ExitCode::FAILURE;
    };
    match args.first().map(String::as_str).unwrap_or("run") {
        "run" => runtime.block_on(run_command()),
        "slice" => runtime.block_on(slice::main(&args[1..])),
        "report" => report(&args[1..]),
        "check" => runtime.block_on(check()),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// The line, until SIGTERM or Ctrl-C.
async fn run_command() -> ExitCode {
    let config = match Config::from_env(|k| std::env::var(k).ok(), true) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    // The stop signal's handler is in place before the line comes up (see `shutdown_signal`).
    let stopping = shutdown_signal();
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        stopping.await;
        let _ = stop_tx.send(true);
    });
    run_loop::run(config, stop_rx).await;
    ExitCode::SUCCESS
}

/// SIGTERM (systemd's stop) or Ctrl-C. The SIGTERM handler is installed when this is called, not
/// when the future is first polled: `run_command` calls it before the line comes up, so a stop
/// that comes right after "the line is up" ends the loop cleanly instead of killing the process
/// (the readiness-before-signal-handler class `jeeta serve` was fixed for).
#[cfg_attr(
    not(unix),
    expect(
        clippy::manual_async_fn,
        reason = "only the unix build installs a handler before the future"
    )
)]
fn shutdown_signal() -> impl std::future::Future<Output = ()> {
    #[cfg(unix)]
    let term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    async move {
        #[cfg(unix)]
        {
            if let Some(mut term) = term {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
                return;
            }
        }
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn report(args: &[String]) -> ExitCode {
    let since = match args {
        [flag, at] if flag == "--since" => {
            match OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339) {
                Ok(t) => Some(t),
                Err(_) => {
                    eprintln!("--since takes an RFC 3339 time");
                    return ExitCode::from(2);
                }
            }
        }
        [] => None,
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let path = std::env::var("VOICE_TRACE_FILE")
        .unwrap_or_else(|_| "/var/lib/jeeta-voice/traces.jsonl".into());
    match read_traces(std::path::Path::new(&path), since) {
        Ok(traces) => {
            // The worker alone cannot see the core's latencies: `agent` and `transport` stay empty
            // here (the call view, `calls.get`, has them).
            let summary = jt_calls::summarize(&traces, &[], &[]);
            println!(
                "{}",
                serde_json::to_string_pretty(&summary).unwrap_or_default()
            );
            ExitCode::SUCCESS
        }
        Err(_) => {
            eprintln!("the trace file cannot be read");
            ExitCode::FAILURE
        }
    }
}

async fn check() -> ExitCode {
    let config = match Config::from_env(|k| std::env::var(k).ok(), false) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let ari = match Ari::new(&config.ari_url, &config.ari_user, &config.ari_password) {
        Ok(a) => a,
        Err(e) => {
            println!("ari: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut ok = true;
    match ari.info().await {
        Ok(v) => println!("ari: ok (Asterisk {v})"),
        Err(e) => {
            ok = false;
            println!("ari: {e}");
        }
    }
    match speech::connect(&config.listen, speech::LISTEN_UID).await {
        Ok(_) => println!("listen: ok"),
        Err(e) => {
            ok = false;
            println!("listen: {e}");
        }
    }
    match speech::connect_speaker(&config.speak).await {
        Ok((_, voice)) => println!("speak: ok (voice {voice})"),
        Err(e) => {
            ok = false;
            println!("speak: {e}");
        }
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
