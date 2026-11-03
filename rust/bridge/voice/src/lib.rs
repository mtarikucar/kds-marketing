//! `jeeta-voice-bridge`: the talker beside Asterisk (design addendum
//! `docs/superpowers/specs/2026-10-29-voice-sidecar-free-path-design.md`). It registers the
//! workspace's line with Jeeta, takes the commands queued for its calls, drives each call through
//! Asterisk (ARI and `chan_websocket` media) and the local speech services, and reports what
//! happened, as the voice bridge protocol of `jt_calls::wire` says.
//!
//! - [`g711`], [`text`], [`netgsm`]: codecs, sentences and the line's dialling rules (pure).
//! - [`talker`]: one call's state machine: openings, turns, barge-in, acknowledgements and
//!   fillers, closing (pure).
//! - [`config`], [`cache`], [`trace`]: the environment, the phrase cache, the turn traces.
//! - [`ari`], [`media`], [`speech`]: Asterisk's REST and events, `chan_websocket` media control,
//!   the local speech services.
//! - [`call`]: one call's task; [`slice`](mod@slice): the standalone test call.
//! - [`jeeta`]: the client of the core's voice bridge routes; [`run_loop`]: the line (`run`).
//!
//! # Logging
//!
//! Call ids, command ids and kinds, states, counts, durations and error kinds. Never a phone
//! number, a transcript, a sentence, audio, an audio path holding a number, the key or a password;
//! an HTTP error is logged without its URL. `tests/logging.rs` reads the sources: a log call
//! carries only listed fields, formats with `Debug` only those whose values hold no text, and
//! interpolates nothing into its message; `#[instrument]` skips every argument; only the console
//! programs print, and print no text but the slice's opt-in transcript. The types that carry a
//! sentence ([`talker::Item`], [`talker::Input`], [`text::Sentence`]) print its length in `Debug`
//! ([`text::Redacted`]), never the words; [`speech::Heard`] prints no word at all, and
//! [`config::Config`] neither the key nor the ARI password. The libraries that carry the wire (HTTP,
//! WebSocket) log at `info` at most whatever the level asked ([`log_filter`]): their `debug` and
//! `trace` lines hold what crosses it.

pub mod ari;
pub mod cache;
pub mod call;
pub mod config;
pub mod g711;
pub mod jeeta;
pub mod media;
pub mod netgsm;
pub mod run_loop;
pub mod slice;
pub mod speech;
pub mod talker;
pub mod text;
pub mod trace;

/// The libraries that carry the wire: their `debug` and `trace` lines hold what crosses it (a
/// WebSocket frame of a transcript, a request with a dial's number), so they log at `info` at most.
const WIRE_LIBRARIES: [&str; 5] = [
    "tungstenite",
    "tokio_tungstenite",
    "hyper",
    "hyper_util",
    "reqwest",
];

/// The log filter for `spec` (`JEETA_VOICE_BRIDGE_LOG`; `info` when unset, empty or unreadable):
/// its directives, less any of the wire libraries (or a module of theirs), and those libraries at
/// `info` (review of D, L7).
pub fn log_filter(spec: Option<&str>) -> tracing_subscriber::EnvFilter {
    let wire = |directive: &str| {
        let target = directive
            .split(['=', '['])
            .next()
            .unwrap_or_default()
            .trim();
        WIRE_LIBRARIES
            .iter()
            .any(|w| target == *w || target.starts_with(&format!("{w}::")))
    };
    let kept: Vec<&str> = spec
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|d| !d.is_empty() && !wire(d))
        .collect();
    let quiet = WIRE_LIBRARIES.map(|w| format!("{w}=info")).join(",");
    let asked = if kept.is_empty() {
        "info".to_owned()
    } else {
        kept.join(",")
    };
    tracing_subscriber::EnvFilter::try_new(format!("{asked},{quiet}"))
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(format!("info,{quiet}")))
}
