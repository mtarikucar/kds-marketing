//! The workspace's call policy (spec §5): the sentences an owner authored for calls nobody
//! scripted (the inbound greeting, the voicemail, the recording announcement, the disclosure),
//! default holding phrases, and the timers and limits of every call. Stored tolerant: a missing
//! field reads as its default, so an older stored policy keeps decoding.

use serde::{Deserialize, Serialize};

use crate::plan::{MAX_CALL_DURATION_S, MAX_HOLDING_LINES, PlanError, line};

/// The longest summary a finished call keeps.
pub const MAX_SUMMARY_CHARS: usize = 2000;

/// The longest extension a policy names, in digits.
const MAX_EXTENSION_DIGITS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CallPolicy {
    /// Played when an agent on duty answers an inbound call; empty until the owner writes it.
    pub greeting_inbound: String,
    /// Played when nobody is on duty, before the voicemail is recorded.
    pub voicemail_text: String,
    /// Played before anything is recorded; recording needs it non-empty.
    pub recording_announcement: String,
    /// Whether every agent-driven opening must disclose the assistant (only a human turns it off).
    pub disclose_assistant: bool,
    /// The sentence an agent-driven opening must contain while `disclose_assistant` holds.
    pub disclosure_sentence: String,
    /// Holding phrases for a plan that brings none of its own.
    pub holding_default: Vec<String>,
    /// The longest call, in seconds (a plan may only ask for less).
    pub max_duration_s: u16,
    /// Agent silence after the caller spoke before the first holding phrase.
    pub slow_agent_s: u16,
    /// Agent silence before the second holding phrase.
    pub holding_again_s: u16,
    /// Agent silence before the next fallback line (and, once they are spent, the closing).
    pub fallback_after_s: u16,
    /// Caller silence after the agent spoke before the agent is told (it may prompt again).
    pub caller_silence_s: u16,
    /// Caller silence after the agent spoke before the scripted closing.
    pub caller_silence_close_s: u16,
    /// Where a call is transferred to by default (a PBX extension).
    pub handoff_extension: Option<String>,
    /// The account's tariff estimate per started minute, in the linked budget item's minor
    /// units; 0 when unknown (then no spend is recorded).
    pub estimated_minor_per_minute: i64,
}

impl Default for CallPolicy {
    fn default() -> Self {
        CallPolicy {
            greeting_inbound: String::new(),
            voicemail_text: String::new(),
            recording_announcement: String::new(),
            disclose_assistant: true,
            disclosure_sentence: String::new(),
            holding_default: Vec::new(),
            max_duration_s: 360,
            slow_agent_s: 4,
            holding_again_s: 10,
            fallback_after_s: 20,
            caller_silence_s: 6,
            caller_silence_close_s: 15,
            handoff_extension: None,
            estimated_minor_per_minute: 0,
        }
    }
}

/// Why a policy is refused; `field` names the offending field.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PolicyError {
    pub field: &'static str,
    pub message: &'static str,
}

fn refuse(field: &'static str, message: &'static str) -> PolicyError {
    PolicyError { field, message }
}

impl From<PlanError> for PolicyError {
    fn from(e: PlanError) -> Self {
        let message = match e {
            PlanError::Empty(_) => "is empty",
            PlanError::TooLong(_) => "is longer than 600 characters",
            _ => "is invalid",
        };
        refuse(e.field(), message)
    }
}

/// `text` when it is empty or a playable sentence.
fn optional_line(text: &str, field: &'static str) -> Result<(), PolicyError> {
    if text.is_empty() {
        Ok(())
    } else {
        line(text, field).map_err(PolicyError::from)
    }
}

impl CallPolicy {
    /// The policy when its sentences can be played and its timers are in order.
    pub fn validate(&self) -> Result<(), PolicyError> {
        optional_line(&self.greeting_inbound, "greeting_inbound")?;
        optional_line(&self.voicemail_text, "voicemail_text")?;
        optional_line(&self.recording_announcement, "recording_announcement")?;
        optional_line(&self.disclosure_sentence, "disclosure_sentence")?;
        if self.holding_default.len() > MAX_HOLDING_LINES {
            return Err(refuse("holding_default", "has more than 5 phrases"));
        }
        for h in &self.holding_default {
            line(h, "holding_default").map_err(PolicyError::from)?;
        }
        if self.max_duration_s == 0 || self.max_duration_s > MAX_CALL_DURATION_S {
            return Err(refuse("max_duration_s", "is 1 to 900"));
        }
        let ordered = 0 < self.slow_agent_s
            && self.slow_agent_s < self.holding_again_s
            && self.holding_again_s < self.fallback_after_s
            && self.fallback_after_s <= 60;
        if !ordered {
            return Err(refuse(
                "fallback_after_s",
                "needs 0 < slow_agent_s < holding_again_s < fallback_after_s <= 60",
            ));
        }
        if !(0 < self.caller_silence_s
            && self.caller_silence_s < self.caller_silence_close_s
            && self.caller_silence_close_s <= 120)
        {
            return Err(refuse(
                "caller_silence_close_s",
                "needs 0 < caller_silence_s < caller_silence_close_s <= 120",
            ));
        }
        if let Some(ext) = &self.handoff_extension
            && (ext.is_empty()
                || ext.len() > MAX_EXTENSION_DIGITS
                || !ext.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(refuse("handoff_extension", "is 1 to 16 digits"));
        }
        if self.estimated_minor_per_minute < 0 {
            return Err(refuse("estimated_minor_per_minute", "is negative"));
        }
        Ok(())
    }

    /// Whether `opening` carries the disclosure this policy asks for: always when the policy
    /// does not ask; otherwise only with a non-empty disclosure sentence it contains exactly.
    pub fn discloses(&self, opening: &str) -> bool {
        !self.disclose_assistant
            || (!self.disclosure_sentence.trim().is_empty()
                && opening.contains(self.disclosure_sentence.trim()))
    }

    /// Whether calls may be recorded: an announcement exists to be played first.
    pub fn may_record(&self) -> bool {
        !self.recording_announcement.trim().is_empty()
    }

    /// The longest a call with `plan_max_s` may last, in seconds.
    pub fn max_duration(&self, plan_max_s: Option<u16>) -> u16 {
        plan_max_s.map_or(self.max_duration_s, |p| p.min(self.max_duration_s))
    }
}
