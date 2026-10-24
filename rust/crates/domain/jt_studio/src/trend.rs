use crate::{StudioError, TrendSignalId, require_id};
use jt_ledger::Actor;
use jt_strategy::{HypothesisId, StrategyVersionId};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use url::Url;

/// Agent-recorded context only. Trends never alter M3 arm selection or learning weights.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrendSignal {
    pub id: TrendSignalId,
    pub workspace_id: WorkspaceId,
    pub born_version_id: StrategyVersionId,
    pub hypothesis_id: HypothesisId,
    pub channel: String,
    pub summary: String,
    pub source_url: Option<Url>,
    pub observed_at: OffsetDateTime,
    pub actor: Actor,
}
impl TrendSignal {
    pub fn validate(&self) -> Result<(), StudioError> {
        for (id, key) in [
            (self.id.0, "trend_id"),
            (self.workspace_id.0, "workspace_id"),
            (self.born_version_id.0, "born_version_id"),
            (self.hypothesis_id.0, "hypothesis_id"),
        ] {
            require_id(id, key)?;
        }
        if self.channel.trim().is_empty() || self.summary.trim().is_empty() {
            return Err(StudioError::InvalidEvidence("trend context"));
        }
        if let Some(url) = &self.source_url {
            crate::piece::validate_public_url(url)?;
        }
        Ok(())
    }
}
