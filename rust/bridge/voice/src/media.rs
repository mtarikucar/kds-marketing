//! `chan_websocket`'s control messages in JSON mode (`f(json)`; Asterisk ≥ 22.8): the events the
//! bridge reads and the commands it writes. Audio goes as binary messages of whole frames, at most
//! [`MAX_MESSAGE_BYTES`] (Asterisk closes the call above 65 500 bytes), paced by [`Pacer`]: one
//! frame every 20 ms for the whole call, silence when nothing plays (since 22.9 Asterisk sends
//! nothing to the line when the bridge writes nothing).

use std::collections::VecDeque;

use serde_json::{Value, json};

pub const MAX_MESSAGE_BYTES: usize = 64_000;

/// A control message from Asterisk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaEvent {
    /// The media is up: its codec (`alaw`, `ulaw`) and a frame's size in bytes.
    Start {
        format: String,
        frame_bytes: usize,
    },
    /// Asterisk played everything written before the `MARK_MEDIA` of this correlation id.
    MarkProcessed {
        correlation: String,
    },
    /// Asterisk's queue is full: write nothing until `Xon`.
    Xoff,
    Xon,
    /// A key the caller pressed (`digit` is never logged; the bridge reads keys from ARI).
    Dtmf {
        digit: String,
    },
    Other,
}

/// Reads one control message.
pub fn parse_control(text: &str) -> MediaEvent {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return MediaEvent::Other;
    };
    match v["event"].as_str() {
        Some("MEDIA_START") => MediaEvent::Start {
            format: v["format"].as_str().unwrap_or("ulaw").to_owned(),
            frame_bytes: v["optimal_frame_size"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(160),
        },
        Some("MEDIA_MARK_PROCESSED") => MediaEvent::MarkProcessed {
            correlation: v["correlation_id"].as_str().unwrap_or_default().to_owned(),
        },
        Some("MEDIA_XOFF") => MediaEvent::Xoff,
        Some("MEDIA_XON") => MediaEvent::Xon,
        Some("DTMF_END") => MediaEvent::Dtmf {
            digit: v["digit"].as_str().unwrap_or_default().to_owned(),
        },
        _ => MediaEvent::Other,
    }
}

/// A control command (`FLUSH_MEDIA`, `MARK_MEDIA`, `HANGUP`, ...), with its correlation id.
pub fn command(name: &str, correlation: Option<&str>) -> String {
    match correlation {
        Some(c) => json!({ "command": name, "correlation_id": c }),
        None => json!({ "command": name }),
    }
    .to_string()
}

/// `pcm` padded with silence to whole frames of `frame_samples`.
pub fn pad_to_frames(mut pcm: Vec<i16>, frame_samples: usize) -> Vec<i16> {
    let frame = frame_samples.max(1);
    let rest = pcm.len() % frame;
    if rest != 0 {
        pcm.resize(pcm.len() + frame - rest, 0);
    }
    pcm
}

/// The line's frame: 20 ms, `MEDIA_START`'s `optimal_frame_size` bytes (160 for G.711).
pub const FRAME_MS: u64 = 20;
/// Frames kept queued in Asterisk ahead of real time: enough to ride out a late tick, few enough
/// that a barge-in's `FLUSH_MEDIA` drops at most 60 ms.
pub const LEAD_FRAMES: u64 = 3;
/// Owing more frames than this (the worker's loop was held up) restarts the clock: the lead is
/// written again instead of a burst that would queue the stall's length in Asterisk.
const MAX_OWED_FRAMES: u64 = 2 * LEAD_FRAMES;

/// What the pacer writes to Asterisk, in this order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    /// One whole frame: queued audio, or silence (`silence: true`) when none is queued.
    Frame { bytes: Vec<u8>, silence: bool },
    /// A `MARK_MEDIA` with this correlation id, right after the last real frame queued before it.
    Mark(String),
}

#[derive(Debug)]
enum Queued {
    Frame(Vec<u8>),
    Mark(String),
}

/// The worker's playout buffer and its 20 ms clock (design addendum §3, B1 review). Since 22.9
/// `chan_websocket` sends nothing when the worker writes nothing, so the pacer writes one frame per
/// 20 ms from `MEDIA_START` for the whole call: the queued audio's next frame, or a silence frame
/// when none is queued. Pure: the call task feeds it its own monotonic milliseconds.
#[derive(Debug)]
pub struct Pacer {
    frame_bytes: usize,
    silence: Vec<u8>,
    queue: VecDeque<Queued>,
    /// The current sentence's bytes short of a whole frame.
    partial: Vec<u8>,
    /// Frames written since the clock's origin.
    written: u64,
    /// When frame 0 was due, in the caller's milliseconds (before 0 after a restart).
    origin_ms: i128,
    paused: bool,
}

impl Pacer {
    /// The pacer of a call whose media started at `now_ms`. `silence_byte` is the codec's encoding
    /// of a zero sample: 0xD5 (A-law) or 0xFF (μ-law).
    pub fn new(frame_bytes: usize, silence_byte: u8, now_ms: u64) -> Pacer {
        let frame_bytes = frame_bytes.max(1);
        Pacer {
            frame_bytes,
            silence: vec![silence_byte; frame_bytes],
            queue: VecDeque::new(),
            partial: Vec::new(),
            written: 0,
            origin_ms: i128::from(now_ms),
            paused: false,
        }
    }

    /// Queues encoded audio as whole frames; a remainder waits for the rest of its sentence.
    pub fn audio(&mut self, bytes: &[u8]) {
        self.partial.extend_from_slice(bytes);
        let whole = self.partial.len() / self.frame_bytes * self.frame_bytes;
        let rest = self.partial.split_off(whole);
        for frame in self.partial.chunks(self.frame_bytes) {
            self.queue.push_back(Queued::Frame(frame.to_vec()));
        }
        self.partial = rest;
    }

    /// Ends a sentence: its last frame is padded with silence, then the mark is queued after it.
    pub fn mark(&mut self, correlation: impl Into<String>) {
        if !self.partial.is_empty() {
            let mut last = std::mem::take(&mut self.partial);
            last.resize(self.frame_bytes, self.silence[0]);
            self.queue.push_back(Queued::Frame(last));
        }
        self.queue.push_back(Queued::Mark(correlation.into()));
    }

    /// Whether no real audio and no mark is left to write.
    pub fn is_idle(&self) -> bool {
        self.queue.is_empty() && self.partial.is_empty()
    }

    /// A barge-in: drops everything queued (the caller sends `FLUSH_MEDIA`, which drops the at
    /// most `LEAD_FRAMES` Asterisk holds) and restarts the clock, so the next `due` writes the lead
    /// of silence at once.
    pub fn flush(&mut self, now_ms: u64) {
        self.queue.clear();
        self.partial.clear();
        self.restart(now_ms);
    }

    /// `MEDIA_XOFF`: nothing is written until [`Pacer::resume`].
    pub fn pause(&mut self) {
        self.paused = true;
    }

    /// `MEDIA_XON`: writing resumes with a fresh lead, not a burst of the paused time.
    pub fn resume(&mut self, now_ms: u64) {
        self.paused = false;
        self.restart(now_ms);
    }

    /// What is due at `now_ms`: frames until `LEAD_FRAMES` ahead of the clock, real ones first and
    /// silence when none is queued, each mark right after the frame before it. Silence frames carry
    /// no mark and count toward nothing but the clock.
    pub fn due(&mut self, now_ms: u64) -> Vec<Out> {
        let mut out = Vec::new();
        if self.paused {
            return out;
        }
        if self.target(now_ms) > self.written + MAX_OWED_FRAMES {
            self.restart(now_ms);
        }
        let target = self.target(now_ms);
        self.marks(&mut out);
        while self.written < target {
            // `marks` left a frame or nothing at the front.
            let real = matches!(self.queue.front(), Some(Queued::Frame(_)));
            let frame = match real.then(|| self.queue.pop_front()).flatten() {
                Some(Queued::Frame(bytes)) => Out::Frame {
                    bytes,
                    silence: false,
                },
                _ => Out::Frame {
                    bytes: self.silence.clone(),
                    silence: true,
                },
            };
            out.push(frame);
            self.written += 1;
            self.marks(&mut out);
        }
        out
    }

    /// The frames that should have been written by `now_ms`, the lead included.
    fn target(&self, now_ms: u64) -> u64 {
        let elapsed = (i128::from(now_ms) - self.origin_ms).max(0) / i128::from(FRAME_MS);
        u64::try_from(elapsed)
            .unwrap_or(u64::MAX)
            .saturating_add(LEAD_FRAMES)
    }

    /// Moves the clock's origin so that what was written is exactly due at `now_ms`: the next
    /// `due` writes the lead and no more.
    fn restart(&mut self, now_ms: u64) {
        self.origin_ms = i128::from(now_ms) - i128::from(self.written) * i128::from(FRAME_MS);
    }

    /// Moves the marks at the front of the queue to `out`.
    fn marks(&mut self, out: &mut Vec<Out>) {
        while let Some(Queued::Mark(_)) = self.queue.front() {
            if let Some(Queued::Mark(m)) = self.queue.pop_front() {
                out.push(Out::Mark(m));
            }
        }
    }
}
