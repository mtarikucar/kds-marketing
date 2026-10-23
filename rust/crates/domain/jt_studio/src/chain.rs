use crate::{ArmId, StudioError, require_id};
use jt_capability::Capability;
use jt_strategy::{
    Hypothesis, HypothesisId, LaneKind, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Birth identity never changes when a newer strategy authorizes execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chain {
    pub workspace_id: WorkspaceId,
    pub born_version_id: StrategyVersionId,
    pub hypothesis_id: HypothesisId,
    pub arm_id: ArmId,
}
impl Chain {
    pub fn validate(&self) -> Result<(), StudioError> {
        for (id, field) in [
            (self.workspace_id.0, "workspace_id"),
            (self.born_version_id.0, "born_version_id"),
            (self.hypothesis_id.0, "hypothesis_id"),
            (self.arm_id.0, "arm_id"),
        ] {
            require_id(id, field)?;
        }
        Ok(())
    }
    pub fn require_same(&self, other: &Self) -> Result<(), StudioError> {
        self.validate()?;
        other.validate()?;
        if self == other {
            Ok(())
        } else {
            Err(StudioError::ChainMismatch("evidence"))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArmKey {
    pub hypothesis_id: HypothesisId,
    pub content_type: String,
    pub channel: String,
    pub lane: LaneKind,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "ArmRecord")]
pub struct Arm {
    pub id: ArmId,
    pub workspace_id: WorkspaceId,
    pub key: ArmKey,
    pub alpha: f64,
    pub beta: f64,
    pub weight: f64,
}
#[derive(Deserialize)]
struct ArmRecord {
    id: ArmId,
    workspace_id: WorkspaceId,
    key: ArmKey,
    alpha: f64,
    beta: f64,
    weight: f64,
}
impl TryFrom<ArmRecord> for Arm {
    type Error = StudioError;
    fn try_from(r: ArmRecord) -> Result<Self, Self::Error> {
        let arm = Self {
            id: r.id,
            workspace_id: r.workspace_id,
            key: r.key,
            alpha: r.alpha,
            beta: r.beta,
            weight: r.weight,
        };
        arm.validate()?;
        Ok(arm)
    }
}
impl Arm {
    /// Priors on hypotheses are display metadata, never Thompson pseudocounts.
    pub fn new(id: ArmId, workspace_id: WorkspaceId, key: ArmKey) -> Result<Self, StudioError> {
        let arm = Self {
            id,
            workspace_id,
            key,
            alpha: 1.0,
            beta: 1.0,
            weight: 0.5,
        };
        arm.validate()?;
        Ok(arm)
    }
    pub fn validate(&self) -> Result<(), StudioError> {
        require_id(self.id.0, "arm_id")?;
        require_id(self.workspace_id.0, "workspace_id")?;
        require_id(self.key.hypothesis_id.0, "hypothesis_id")?;
        if self.key.content_type.trim().is_empty()
            || self.key.channel.trim().is_empty()
            || self.key.channel == "any"
        {
            return Err(StudioError::TargetNotSelected);
        }
        if !self.alpha.is_finite()
            || !self.beta.is_finite()
            || !self.weight.is_finite()
            || self.alpha <= 0.0
            || self.beta <= 0.0
            || !(0.0..=1.0).contains(&self.weight)
            || !(self.alpha + self.beta).is_finite()
        {
            return Err(StudioError::InvalidLearning);
        }
        Ok(())
    }
}

/// Loaded tenant-scoped context, not caller-supplied authorization claims. Hypothesis slices
/// belong to their corresponding versions; group IDs are memberships of this exact target.
/// `supported_kinds` comes from the registry for the requested lane/operation (None excluded).
pub struct ChainContext<'a> {
    pub workspace_id: WorkspaceId,
    pub birth_version: &'a StrategyVersion,
    pub birth_hypotheses: &'a [Hypothesis],
    pub current_version: &'a StrategyVersion,
    pub hypotheses: &'a [Hypothesis],
    pub arm: &'a Arm,
    pub target: &'a Capability,
    pub target_group_ids: &'a [Uuid],
    pub supported_kinds: &'a [&'a str],
    pub lane: LaneKind,
}

pub fn validate_chain(chain: &Chain, ctx: &ChainContext<'_>) -> Result<(), StudioError> {
    chain.validate()?;
    ctx.arm.validate()?;
    require_id(ctx.target.id.0, "capability_id")?;
    require_id(ctx.current_version.id.0, "executed_version_id")?;
    if [
        ctx.workspace_id,
        ctx.birth_version.workspace_id,
        ctx.current_version.workspace_id,
        ctx.arm.workspace_id,
        ctx.target.workspace_id,
    ]
    .iter()
    .any(|ws| *ws != chain.workspace_id)
    {
        return Err(StudioError::ChainMismatch("workspace"));
    }
    if ctx.birth_version.id != chain.born_version_id
        || ctx.birth_version.status == VersionStatus::Draft
        || !ctx
            .birth_hypotheses
            .iter()
            .any(|h| h.id == chain.hypothesis_id && h.state.is_live())
    {
        return Err(StudioError::ChainMismatch("birth version/hypothesis"));
    }
    if ctx.current_version.status != VersionStatus::Approved {
        return Err(StudioError::StrategyRequired);
    }
    let hypothesis = ctx
        .hypotheses
        .iter()
        .find(|h| h.id == chain.hypothesis_id && h.state.is_live())
        .ok_or(StudioError::HypothesisInactive)?;
    if ctx.arm.id != chain.arm_id || ctx.arm.key.hypothesis_id != chain.hypothesis_id {
        return Err(StudioError::ChainMismatch("arm"));
    }
    if ctx.target.kind().is_none() {
        return Err(StudioError::TargetNotSelected);
    }
    let channel = ctx.target.kind_key.as_str();
    let cadence = hypothesis
        .cadence
        .get(&ctx.lane)
        .ok_or(StudioError::TargetNotSelected)?;
    if cadence.validate().is_err()
        || cadence.slots_per_week == 0
        || !cadence
            .content_types
            .iter()
            .any(|t| t.key == ctx.arm.key.content_type && t.max_bps > 0)
        || ctx.arm.key.lane != ctx.lane
        || ctx.arm.key.channel != channel
        || !(hypothesis.channel == "any" || hypothesis.channel == channel)
        || !ctx.supported_kinds.contains(&channel)
        || (ctx.lane == LaneKind::Paid && !ctx.current_version.sections.paid_enabled)
        || !ctx.current_version.sections.channels.iter().any(|choice| {
            (choice.channel == "any" || choice.channel == channel)
                && choice
                    .group_id
                    .is_none_or(|group| ctx.target_group_ids.contains(&group))
        })
    {
        return Err(StudioError::TargetNotSelected);
    }
    Ok(())
}
