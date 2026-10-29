//! `chan_websocket`'s control messages in JSON mode (`f(json)`; Asterisk ≥ 22.8): the events the
//! bridge reads and the commands it writes. Audio goes as binary messages of whole frames, at most
//! [`MAX_MESSAGE_BYTES`] (Asterisk closes the call above 65 500 bytes).

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
