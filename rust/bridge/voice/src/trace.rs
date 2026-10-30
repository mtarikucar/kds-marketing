//! The per-turn trace on the bridge's monotonic clock (design addendum §7): the listener reports
//! audio positions, which [`AudioClock`] maps to the instants the bridge forwarded those frames;
//! [`TurnMarks`] collects a turn's instants and gives its [`TurnTrace`]; [`TraceFile`] keeps one JSON
//! line per trace (numbers and the call id only) for `jeeta-voice-bridge report`.

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use jt_calls::{EndpointBy, TurnTrace};
use time::OffsetDateTime;

/// How much audio history the clock keeps, in milliseconds.
const KEEP_MS: u64 = 60_000;

/// Inbound audio positions and when they arrived.
#[derive(Debug, Default)]
pub struct AudioClock {
    entries: VecDeque<(u64, Instant)>,
    position_ms: u64,
}

impl AudioClock {
    /// `ms` more audio arrived at `at`.
    pub fn push(&mut self, ms: u64, at: Instant) {
        self.entries.push_back((self.position_ms, at));
        self.position_ms += ms;
        while self
            .entries
            .front()
            .is_some_and(|(p, _)| self.position_ms - p > KEEP_MS)
        {
            self.entries.pop_front();
        }
    }

    /// How much audio arrived since the call's media started.
    pub fn position_ms(&self) -> u64 {
        self.position_ms
    }

    /// When the frame holding audio position `ms` arrived: `None` for audio not yet arrived, or
    /// older than the history kept.
    pub fn at(&self, ms: u64) -> Option<Instant> {
        if ms >= self.position_ms {
            return None;
        }
        self.entries
            .iter()
            .rev()
            .find(|(p, _)| *p <= ms)
            .map(|(_, at)| *at)
    }
}

fn since(base: Instant, at: Option<Instant>) -> Option<u32> {
    at.map(|t| u32::try_from(t.saturating_duration_since(base).as_millis()).unwrap_or(u32::MAX))
}

/// One turn's instants (see [`TurnTrace`] for what each one times).
#[derive(Clone, Debug)]
pub struct TurnMarks {
    pub speech_end: Instant,
    pub endpoint_ms: u32,
    pub endpoint_by: EndpointBy,
    pub stt_final: Instant,
    pub delivered: Option<Instant>,
    pub say: Option<Instant>,
    pub tts_first: Option<Instant>,
    pub first_audio: Option<Instant>,
    pub ack: Option<Instant>,
    /// The `seq` of the agent `say` that `say` timed (the trace's `reply_seq`).
    pub reply_seq: Option<u32>,
    pub barge_in_stop_ms: Option<u32>,
    pub backchannel_cut: bool,
}

impl TurnMarks {
    pub fn new(
        speech_end: Instant,
        endpoint_ms: u32,
        endpoint_by: EndpointBy,
        stt_final: Instant,
    ) -> TurnMarks {
        TurnMarks {
            speech_end,
            endpoint_ms,
            endpoint_by,
            stt_final,
            delivered: None,
            say: None,
            tts_first: None,
            first_audio: None,
            ack: None,
            reply_seq: None,
            barge_in_stop_ms: None,
            backchannel_cut: false,
        }
    }

    /// The turn's trace: each instant as milliseconds after the caller's end of speech.
    pub fn trace(&self) -> TurnTrace {
        let base = self.speech_end;
        TurnTrace {
            endpoint_ms: self.endpoint_ms,
            endpoint_by: Some(self.endpoint_by),
            stt_final_ms: since(base, Some(self.stt_final)).unwrap_or_default(),
            delivered_ms: since(base, self.delivered),
            say_ms: since(base, self.say),
            tts_first_ms: since(base, self.tts_first),
            first_audio_ms: since(base, self.first_audio),
            ack_ms: since(base, self.ack),
            barge_in_stop_ms: self.barge_in_stop_ms,
            backchannel_cut: self.backchannel_cut,
            reply_seq: self.reply_seq,
        }
    }
}

/// One line of the trace file.
#[derive(serde::Serialize, serde::Deserialize)]
struct Line {
    #[serde(with = "time::serde::rfc3339")]
    at: OffsetDateTime,
    call: String,
    trace: TurnTrace,
}

/// The bridge's own trace log.
#[derive(Clone, Debug)]
pub struct TraceFile {
    path: PathBuf,
}

impl TraceFile {
    pub fn new(path: PathBuf) -> TraceFile {
        TraceFile { path }
    }

    /// Appends `trace` of call `call`, stamped now (UTC). The line and its newline go in one
    /// write to a file opened for appending, so writers that share the file (`run`, a `slice`)
    /// never interleave inside a line (B5 review); `writeln!` would write them in two. The file is
    /// opened by its path on every append, so a rotation that renames it needs no signal (D3).
    pub fn append(&self, call: &str, trace: &TurnTrace) -> std::io::Result<()> {
        let line = Line {
            at: OffsetDateTime::now_utc(),
            call: call.to_owned(),
            trace: trace.clone(),
        };
        let mut text = serde_json::to_string(&line).map_err(std::io::Error::other)?;
        text.push('\n');
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(text.as_bytes())
    }
}

/// The traces of `path` written at or after `since` (all of them without), unreadable lines skipped.
pub fn read_traces(path: &Path, since: Option<OffsetDateTime>) -> std::io::Result<Vec<TurnTrace>> {
    let text = std::fs::read_to_string(path)?;
    Ok(text
        .lines()
        .filter_map(|l| serde_json::from_str::<Line>(l).ok())
        .filter(|l| since.is_none_or(|s| l.at >= s))
        .map(|l| l.trace)
        .collect())
}
