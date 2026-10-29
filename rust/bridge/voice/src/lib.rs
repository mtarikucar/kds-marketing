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
//! [`config::Config`] neither the key nor the ARI password.

pub mod ari;
pub mod cache;
pub mod config;
pub mod g711;
pub mod media;
pub mod netgsm;
pub mod speech;
pub mod talker;
pub mod text;
pub mod trace;
