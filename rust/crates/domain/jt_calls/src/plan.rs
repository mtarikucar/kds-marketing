//! What the caller authored before an agent-driven call: every sentence the server may play
//! without the agent (spec §3.3, §5).

use serde::{Deserialize, Serialize};

/// The longest sentence of a plan or a policy, and of one `calls.say`.
pub const MAX_LINE_CHARS: usize = 600;
/// The most holding phrases a plan carries.
pub const MAX_HOLDING_LINES: usize = 5;
/// The most fallback lines a plan carries.
pub const MAX_FALLBACK_LINES: usize = 3;
/// The longest call any plan or policy allows, in seconds.
pub const MAX_CALL_DURATION_S: u16 = 900;

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
    pub closing: String,
    pub max_duration_s: u16,
    #[serde(default = "turkish")]
    pub language: String,
    /// Whether the opening discloses that an assistant speaks; the policy forces it on.
    #[serde(default = "yes")]
    pub disclose_assistant: bool,
}

fn turkish() -> String {
    "tr".into()
}

fn yes() -> bool {
    true
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
        line(&self.closing, "plan.closing")?;
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
        Ok(())
    }

    /// Every sentence of the plan the server may play (the goal is never played).
    pub fn playable(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.opening.as_str())
            .chain(self.holding.iter().map(String::as_str))
            .chain(self.fallback.iter().map(String::as_str))
            .chain(std::iter::once(self.closing.as_str()))
    }
}
