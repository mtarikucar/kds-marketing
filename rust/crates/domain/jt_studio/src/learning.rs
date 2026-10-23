use crate::{Chain, StudioError};
use serde::{Deserialize, Serialize};

/// Produced by the T7 evidence replacement calculation, never accepted from a public confidence
/// setter. Negative deltas remove the previous contribution before adding its correction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LearningUpdate {
    pub chain: Chain,
    pub evidence_key: String,
    pub alpha_delta: f64,
    pub beta_delta: f64,
    pub weight_delta: f64,
    pub derived_confidence: f32,
}
impl LearningUpdate {
    pub fn validate(&self) -> Result<(), StudioError> {
        self.chain.validate()?;
        if self.evidence_key.trim().is_empty()
            || !self.alpha_delta.is_finite()
            || !self.beta_delta.is_finite()
            || !self.weight_delta.is_finite()
            || !self.derived_confidence.is_finite()
            || !(0.0..=1.0).contains(&self.derived_confidence)
        {
            return Err(StudioError::InvalidLearning);
        }
        Ok(())
    }
}
