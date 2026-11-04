//! The workspace's call policy (spec §5): the sentences an owner authored for calls nobody
//! scripted (the inbound greeting, the voicemail, the recording announcement, the disclosure),
//! default holding phrases, and the timers and limits of every call. Stored tolerant: a missing
//! field reads as its default, so an older stored policy keeps decoding.

use serde::{Deserialize, Serialize};

use crate::opening::{CLOSING, TRANSCRIPT_NOTICE, disclosure, inbound_greeting, outbound_opening};
use crate::phrases::{BridgePhrases, PhraseSet};
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
    /// Played first when an outbound agent call is answered: the workspace's own opening, which
    /// discloses the assistant. `None`: the approved opening with the workspace's name
    /// ([`CallPolicy::with_workspace`]); empty: none (the plan's opening must then disclose).
    pub opening_outbound: Option<String>,
    /// Played after the opening on every agent call. `None`: the approved notice; empty: none.
    pub transcript_notice: Option<String>,
    /// Played before an agent's call is hung up when its plan brings no closing. `None`: the
    /// approved closing ([`CLOSING`], filled in by [`CallPolicy::with_workspace`]); empty: none (a
    /// plan must then bring its own).
    pub closing: Option<String>,
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
    /// The phrases the voice bridge plays on its own (the owner-approved set by default).
    pub phrases: BridgePhrases,
}

impl Default for CallPolicy {
    fn default() -> Self {
        CallPolicy {
            greeting_inbound: String::new(),
            voicemail_text: String::new(),
            recording_announcement: String::new(),
            disclose_assistant: true,
            disclosure_sentence: String::new(),
            opening_outbound: None,
            transcript_notice: None,
            closing: None,
            holding_default: Vec::new(),
            max_duration_s: 360,
            slow_agent_s: 4,
            holding_again_s: 10,
            fallback_after_s: 20,
            caller_silence_s: 6,
            caller_silence_close_s: 15,
            handoff_extension: None,
            estimated_minor_per_minute: 0,
            phrases: BridgePhrases::default(),
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

/// The policy field that holds the phrases of `set`.
fn phrase_field(set: PhraseSet) -> &'static str {
    match set {
        PhraseSet::Acknowledgement => "phrases.acknowledgements",
        PhraseSet::Filler => "phrases.fillers",
        PhraseSet::LongWait => "phrases.long_wait",
        PhraseSet::NotHeard => "phrases.not_heard",
        PhraseSet::StillThere => "phrases.still_there",
        PhraseSet::Fault => "phrases.fault",
    }
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
    /// This policy with the workspace's own sentences where the owner wrote none: the approved
    /// outbound opening and inbound greeting with `business` in them, the approved transcript
    /// notice and closing, and the disclosure sentence both openings contain. The owner's own texts
    /// are kept (an empty one is the owner's "none").
    pub fn with_workspace(mut self, business: &str) -> CallPolicy {
        if self.opening_outbound.is_none() {
            self.opening_outbound = outbound_opening(business);
        }
        if self.transcript_notice.is_none() {
            self.transcript_notice = Some(TRANSCRIPT_NOTICE.to_owned());
        }
        if self.closing.is_none() {
            self.closing = Some(CLOSING.to_owned());
        }
        if self.disclosure_sentence.trim().is_empty()
            && let Some(d) = disclosure(business)
        {
            self.disclosure_sentence = d;
        }
        if self.greeting_inbound.trim().is_empty()
            && let Some(g) = inbound_greeting(business)
        {
            self.greeting_inbound = g;
        }
        self
    }

    /// What an outbound agent call plays when answered, in order: the workspace's opening, the
    /// transcript notice, and `plan_opening` when given; empty texts left out.
    pub fn opening_lines<'a>(&'a self, plan_opening: Option<&'a str>) -> Vec<&'a str> {
        [
            self.opening_outbound.as_deref(),
            self.transcript_notice.as_deref(),
            plan_opening,
        ]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect()
    }

    /// [`CallPolicy::opening_lines`] with the plan's opening, as one text.
    pub fn spoken_opening(&self, plan_opening: &str) -> String {
        self.opening_lines(Some(plan_opening)).join(" ")
    }

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
        if let Some(t) = &self.opening_outbound {
            optional_line(t, "opening_outbound")?;
        }
        if let Some(t) = &self.transcript_notice {
            optional_line(t, "transcript_notice")?;
        }
        if let Some(t) = &self.closing {
            optional_line(t, "closing")?;
        }
        for set in PhraseSet::ALL {
            let field = phrase_field(set);
            let list = self.phrases.set(set);
            if list.len() > MAX_HOLDING_LINES {
                return Err(refuse(field, "has more than 5 phrases"));
            }
            for p in list {
                line(p, field).map_err(PolicyError::from)?;
            }
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
