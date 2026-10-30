//! What the caller authored before an agent-driven call: every sentence the server may play
//! without the agent (spec §3.3, §5).

use serde::{Deserialize, Deserializer, Serialize};

use crate::opening::lower_tr;

/// The longest sentence of a plan or a policy, and of one `calls.say`.
pub const MAX_LINE_CHARS: usize = 600;
/// The most holding phrases a plan carries.
pub const MAX_HOLDING_LINES: usize = 5;
/// The most fallback lines a plan carries.
pub const MAX_FALLBACK_LINES: usize = 3;
/// The longest call any plan or policy allows, in seconds.
pub const MAX_CALL_DURATION_S: u16 = 900;
/// The most hotwords a call carries (the plan's and the workspace's name), and the longest.
pub const MAX_HOTWORDS: usize = 20;
pub const MAX_HOTWORD_CHARS: usize = 40;
/// The most hotwords a plan brings: one fewer than a call carries, the workspace's name taking the
/// last.
pub const MAX_PLAN_HOTWORDS: usize = MAX_HOTWORDS - 1;

/// The script of an agent-driven call: the opening (which must carry the assistant disclosure
/// when the policy asks for it), the goal (for the transcript, never played), 1 to 5 holding
/// phrases played while the agent thinks, 0 to 3 fallback lines played when it stays silent, and
/// the closing played before the server hangs up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallPlan {
    pub opening: String,
    pub goal: String,
    pub holding: Vec<String>,
    #[serde(default)]
    pub fallback: Vec<String>,
    /// Played before the call is hung up. Empty: the call policy's `closing` (the core fills it in
    /// when the call is placed; a plan with neither is refused).
    #[serde(default)]
    pub closing: String,
    pub max_duration_s: u16,
    #[serde(default = "turkish")]
    pub language: String,
    /// Whether the opening discloses that an assistant speaks; the policy forces it on.
    #[serde(default = "yes")]
    pub disclose_assistant: bool,
    /// Words the call's speech-to-text is biased toward (names, products, from the agent's
    /// context): at most [`MAX_PLAN_HOTWORDS`], each 1 to 40 characters once trimmed, and read
    /// trimmed. Written only when there is one, so that a plan without any still reads in a
    /// release that knows no hotwords (which reads a plan strictly).
    #[serde(
        default,
        deserialize_with = "trimmed",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub hotwords: Vec<String>,
}

fn turkish() -> String {
    "tr".into()
}

fn yes() -> bool {
    true
}

/// The words, each trimmed: what is stored is what was length-checked.
fn trimmed<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    let words = Vec::<String>::deserialize(d)?;
    Ok(words.into_iter().map(|w| w.trim().to_owned()).collect())
}

/// Why a plan is refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("{0} is empty")]
    Empty(&'static str),
    #[error("{0} is longer than 600 characters")]
    TooLong(&'static str),
    #[error("a plan has 1 to 5 holding phrases")]
    HoldingCount,
    #[error("a plan has at most 3 fallback lines")]
    FallbackCount,
    #[error("max_duration_s is 1 to 900")]
    Duration,
    #[error("only Turkish (tr) calls are supported")]
    Language,
    #[error("a plan has at most 19 hotwords of 1 to 40 characters")]
    Hotwords,
}

impl PlanError {
    /// The plan field the refusal names.
    pub fn field(&self) -> &'static str {
        match self {
            PlanError::Empty(f) | PlanError::TooLong(f) => f,
            PlanError::HoldingCount => "plan.holding",
            PlanError::FallbackCount => "plan.fallback",
            PlanError::Duration => "plan.max_duration_s",
            PlanError::Language => "plan.language",
            PlanError::Hotwords => "plan.hotwords",
        }
    }
}

/// `text` when it is a sentence that may be played: not blank, at most [`MAX_LINE_CHARS`].
pub(crate) fn line(text: &str, field: &'static str) -> Result<(), PlanError> {
    if text.trim().is_empty() {
        Err(PlanError::Empty(field))
    } else if text.chars().count() > MAX_LINE_CHARS {
        Err(PlanError::TooLong(field))
    } else {
        Ok(())
    }
}

impl CallPlan {
    /// The plan when every sentence can be played and its counts and duration are in bounds.
    pub fn validate(&self) -> Result<(), PlanError> {
        line(&self.opening, "plan.opening")?;
        line(&self.goal, "plan.goal")?;
        if !self.closing.is_empty() {
            line(&self.closing, "plan.closing")?;
        }
        if self.holding.is_empty() || self.holding.len() > MAX_HOLDING_LINES {
            return Err(PlanError::HoldingCount);
        }
        for h in &self.holding {
            line(h, "plan.holding")?;
        }
        if self.fallback.len() > MAX_FALLBACK_LINES {
            return Err(PlanError::FallbackCount);
        }
        for f in &self.fallback {
            line(f, "plan.fallback")?;
        }
        if self.max_duration_s == 0 || self.max_duration_s > MAX_CALL_DURATION_S {
            return Err(PlanError::Duration);
        }
        if self.language != "tr" {
            return Err(PlanError::Language);
        }
        let bad_hotword = |h: &String| {
            let n = h.trim().chars().count();
            n == 0 || n > MAX_HOTWORD_CHARS || h.chars().any(char::is_control)
        };
        if self.hotwords.len() > MAX_PLAN_HOTWORDS || self.hotwords.iter().any(bad_hotword) {
            return Err(PlanError::Hotwords);
        }
        Ok(())
    }

    /// Every sentence of the plan the server may play (the goal is never played).
    pub fn playable(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.opening.as_str())
            .chain(self.holding.iter().map(String::as_str))
            .chain(self.fallback.iter().map(String::as_str))
            .chain((!self.closing.is_empty()).then_some(self.closing.as_str()))
    }
}

/// The hotwords of a call: the plan's (at most [`MAX_PLAN_HOTWORDS`] of them), then the
/// workspace's name, which always has its slot, so at most [`MAX_HOTWORDS`]. Each is trimmed, a
/// blank one dropped, and each kept once whatever its case, lowercased the Turkish way (`IŞIK` and
/// `ışık` are one word).
pub fn call_hotwords(plan: &[String], business: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut fresh = |w: &str| seen.insert(w.chars().map(lower_tr).collect::<String>());
    let mut words: Vec<String> = plan
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty() && fresh(w))
        .take(MAX_PLAN_HOTWORDS)
        .map(str::to_owned)
        .collect();
    let name = business.trim();
    if !name.is_empty() && fresh(name) {
        words.push(name.to_owned());
    }
    words
}
