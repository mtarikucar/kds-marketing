//! Strategy domain: versions, sections, hypotheses, the consultation log and the approval rules.
//! Pure, no I/O.

mod consultation;
mod hypothesis;
mod parse;
mod rules;
mod sections;
mod version;

pub use consultation::{
    ConsultationEntry, ConsultationEntryId, ConsultationKind, MAX_CONSULTATION_TEXT_CHARS,
};
pub use hypothesis::{Hypothesis, HypothesisId, HypothesisInput, HypothesisState};
pub use parse::{
    MAX_PROHIBITION_CHARS, MAX_SECTION_NAME_CHARS, MAX_SECTION_TEXT_CHARS, SectionValue,
    parse_hypotheses_strict, parse_section_strict,
};
pub use rules::{
    ANY_CHANNEL, Gap, MAX_PER_WEEK, MAX_PROHIBITIONS, budget_cap_for, diff, next_draft_from,
    validate_currency, validate_for_approval, validate_sections, validate_segment_key,
};
pub use sections::{
    BudgetFrame, Cadence, ChannelChoice, Goals, Identity, Kpi, Lane, LaneKind, Mix, Period,
    Sections, Segment,
};
pub use version::{StrategyVersion, StrategyVersionId, VersionStatus};

/// A strategy rule refused a value.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum StrategyError {
    /// A consultation text is longer than [`MAX_CONSULTATION_TEXT_CHARS`] characters.
    #[error("text is {len} characters, at most {MAX_CONSULTATION_TEXT_CHARS} allowed")]
    TextTooLong { len: usize },
    /// A segment key is not `[a-z0-9_]{2,32}`.
    #[error("invalid segment key {0:?}: use 2 to 32 of a-z, 0-9 and _")]
    InvalidSegmentKey(String),
    /// A currency is not three uppercase ASCII letters (ISO 4217).
    #[error("invalid currency {0:?}: use an ISO 4217 code such as TRY")]
    InvalidCurrency(String),
}
