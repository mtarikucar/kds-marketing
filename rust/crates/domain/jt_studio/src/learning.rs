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

use crate::{Arm, LearningPolicy, Measurement, MeasurementId, MeasurementStatus};
pub const LEARNING_RULE: &str = "studio-learning-v1";
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reward {
    pub value: f64,
    pub measurement_ids: Vec<MeasurementId>,
    pub rule_version: String,
    pub chain: Chain,
    pub evidence_key: String,
}
pub fn reward(m: &Measurement, rule: &LearningPolicy) -> Result<Option<Reward>, StudioError> {
    m.validate()?;
    if rule.exploration_bps > 10000 || m.rule_version != LEARNING_RULE {
        return Err(StudioError::InvalidLearning);
    }
    if m.status != MeasurementStatus::Complete {
        return Ok(None);
    }
    let Some(impressions) = m
        .raw_metrics
        .get("impressions")
        .copied()
        .flatten()
        .filter(|n| *n > 0)
    else {
        return Ok(None);
    };
    let key = if m.binding_id.is_some() {
        "clicks"
    } else {
        "engagements"
    };
    let Some(events) = m
        .raw_metrics
        .get(key)
        .copied()
        .flatten()
        .filter(|n| *n >= 0)
    else {
        return Ok(None);
    };
    Ok(Some(Reward {
        value: (events as f64 / impressions as f64).clamp(0.0, 1.0),
        measurement_ids: vec![m.id],
        rule_version: LEARNING_RULE.into(),
        chain: m.chain.clone(),
        evidence_key: m.evidence_key.clone(),
    }))
}
pub fn learn(
    arm: &Arm,
    reward: &Reward,
    rule: &LearningPolicy,
) -> Result<LearningUpdate, StudioError> {
    arm.validate()?;
    reward.chain.validate()?;
    if reward.measurement_ids.is_empty() {
        return Err(StudioError::InvalidLearning);
    }
    if rule.exploration_bps > 10000
        || reward.rule_version != LEARNING_RULE
        || !reward.value.is_finite()
        || !(0.0..=1.0).contains(&reward.value)
        || arm.id != reward.chain.arm_id
        || arm.workspace_id != reward.chain.workspace_id
        || arm.key.hypothesis_id != reward.chain.hypothesis_id
    {
        return Err(StudioError::InvalidLearning);
    }
    let mean = (arm.alpha + reward.value) / (arm.alpha + arm.beta + 1.0);
    Ok(LearningUpdate {
        chain: reward.chain.clone(),
        evidence_key: reward.evidence_key.clone(),
        alpha_delta: reward.value,
        beta_delta: 1.0 - reward.value,
        weight_delta: mean - arm.weight,
        derived_confidence: mean as f32,
    })
}
pub fn reweight(arms: &[Arm], rule: &LearningPolicy) -> Result<Vec<Arm>, StudioError> {
    if rule.exploration_bps > 10000 {
        return Err(StudioError::InvalidLearning);
    }
    arms.iter()
        .map(|a| {
            a.validate()?;
            let mut a = a.clone();
            a.weight = a.alpha / (a.alpha + a.beta);
            Ok(a)
        })
        .collect()
}
/// Select one complete observation per publication or binding/day, independent of arrival order.
/// The highest explicit revision wins corrections; a retry never erases complete evidence.
pub fn observations(rows: &[Measurement]) -> Result<Vec<Reward>, StudioError> {
    let mut selected = std::collections::BTreeMap::new();
    for m in rows {
        if let Some(r) = reward(m, &LearningPolicy::default())? {
            let key = (m.publication_id, m.binding_id, m.date);
            let rank = (m.window, m.evidence_revision);
            if selected.get(&key).is_none_or(|(old, _)| rank > *old) {
                selected.insert(key, (rank, r));
            }
        }
    }
    Ok(selected.into_values().map(|(_, r)| r).collect())
}
