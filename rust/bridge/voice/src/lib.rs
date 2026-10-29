//! `jeeta-voice-bridge`: the talker beside Asterisk (design addendum
//! `docs/superpowers/specs/2026-10-29-voice-sidecar-free-path-design.md`). It registers the
//! workspace's line with Jeeta, takes the commands queued for its calls, drives each call through
//! Asterisk (ARI and `chan_websocket` media) and the local speech services, and reports what
//! happened, as the voice bridge protocol of `jt_calls::wire` says.
//!
//! - [`g711`], [`text`], [`netgsm`]: codecs, sentences and the line's dialling rules (pure).
//! - [`talker`]: one call's state machine: openings, turns, barge-in, acknowledgements and
//!   fillers, closing (pure).
//!
//! # Logging
//!
//! Call ids, command ids and kinds, states, counts, durations and error kinds. Never a phone
//! number, a transcript, a sentence, audio, an audio path holding a number, the key or a password;
//! an HTTP error is logged without its URL (`tests/logging.rs` checks the log calls).

pub mod g711;
pub mod netgsm;
pub mod talker;
pub mod text;
