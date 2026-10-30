//! Score writes against the workspace's rubric (spec §3.4) and the fixed score buckets.

use jt_strategy::Rubric;
use serde::{Deserialize, Serialize};

use crate::evidence::validate_source_format;
use crate::{ProspectError, SourceRef, SourceRefInput, chars, invalid};

/// A score band, the same under every rubric, so reports compare across rubric versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Bucket {
    #[serde(rename = "0-24")]
    B0To24,
    #[serde(rename = "25-49")]
    B25To49,
    #[serde(rename = "50-74")]
    B50To74,
    #[serde(rename = "75-100")]
    B75To100,
}

impl Bucket {
    /// Every bucket, lowest first.
    pub const ALL: &[Bucket] = &[
        Bucket::B0To24,
        Bucket::B25To49,
        Bucket::B50To74,
        Bucket::B75To100,
    ];

    /// The stable key, e.g. `"25-49"`.
    pub fn key(self) -> &'static str {
        match self {
            Bucket::B0To24 => "0-24",
            Bucket::B25To49 => "25-49",
            Bucket::B50To74 => "50-74",
            Bucket::B75To100 => "75-100",
        }
    }

    /// The bucket with this key, if any.
    pub fn parse(key: &str) -> Option<Bucket> {
        Bucket::ALL.iter().copied().find(|b| b.key() == key)
    }

    /// The scores in the bucket, inclusive.
    pub fn range(self) -> (u8, u8) {
        match self {
            Bucket::B0To24 => (0, 24),
            Bucket::B25To49 => (25, 49),
            Bucket::B50To74 => (50, 74),
            Bucket::B75To100 => (75, 100),
        }
    }
}

/// The bucket a score falls in.
pub fn bucket(score: u8) -> Bucket {
    match score {
        0..=24 => Bucket::B0To24,
        25..=49 => Bucket::B25To49,
        50..=74 => Bucket::B50To74,
        _ => Bucket::B75To100,
    }
}

/// `jeeta.prospects.score`'s input (without the prospect id, which the route or tool names).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreInput {
    /// `0..=100`, the sum of the reasons' points.
    pub score: u8,
    /// One per criterion of the rubric, each exactly once.
    pub reasons: Vec<ReasonInput>,
    /// The digest of the rubric the score was computed under.
    pub rubric_digest: String,
}

/// The points given to one criterion and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReasonInput {
    /// A criterion key of the rubric.
    pub criterion: String,
    /// `0..=weight`.
    pub points: u8,
    /// One sentence, `1..=300` characters.
    pub evidence: String,
    #[serde(default)]
    pub source: Option<SourceRefInput>,
}

/// Checks a score against `rubric`: a non-empty rubric, a score of `0..=100`, every criterion
/// exactly once, points within each criterion's weight, evidence of `1..=300` characters, an
/// `http(s)` source when one is given, and a score equal to the sum of the points. Whether
/// `rubric_digest` names the approved rubric is the caller's to check (it knows the digest).
pub fn validate_score(input: &ScoreInput, rubric: &Rubric) -> Result<(), ProspectError> {
    if rubric.criteria.is_empty() {
        return Err(invalid("rubric", "empty"));
    }
    if input.score > 100 {
        return Err(invalid("score", "out_of_range"));
    }
    let mut seen: Vec<&str> = Vec::with_capacity(input.reasons.len());
    for r in &input.reasons {
        let Some(c) = rubric.criteria.iter().find(|c| c.key == r.criterion) else {
            return Err(invalid("reasons", "unknown_criterion"));
        };
        if seen.contains(&r.criterion.as_str()) {
            return Err(invalid("reasons", "duplicate_criterion"));
        }
        seen.push(&r.criterion);
        if r.points > c.weight {
            return Err(invalid("reasons", "points_exceed_weight"));
        }
        if !(1..=300).contains(&chars(r.evidence.trim())) {
            return Err(invalid("reasons", "evidence_length"));
        }
        if let Some(s) = &r.source {
            validate_source_format("reasons", s)?;
        }
    }
    if seen.len() != rubric.criteria.len() {
        return Err(invalid("reasons", "missing_criterion"));
    }
    let sum: u32 = input.reasons.iter().map(|r| u32::from(r.points)).sum();
    if sum != u32::from(input.score) {
        return Err(invalid("score", "not_the_sum_of_points"));
    }
    Ok(())
}

/// A score's reason as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reason {
    pub criterion: String,
    pub points: u8,
    pub evidence: String,
    #[serde(default)]
    pub source: Option<SourceRef>,
}

impl ReasonInput {
    /// The stored reason: the evidence trimmed, the source as stored.
    pub fn into_reason(self) -> Reason {
        Reason {
            criterion: self.criterion,
            points: self.points,
            evidence: self.evidence.trim().to_owned(),
            source: self.source.map(SourceRefInput::into_source),
        }
    }
}
