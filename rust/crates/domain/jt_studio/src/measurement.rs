use crate::{AdSetBindingId, Chain, MeasurementId, PublicationId, StudioError, require_id};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::{Date, Duration, OffsetDateTime};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementWindow {
    Hours24,
    Hours72,
    Days7,
}
impl MeasurementWindow {
    pub fn delay(self) -> Duration {
        match self {
            Self::Hours24 => Duration::hours(24),
            Self::Hours72 => Duration::hours(72),
            Self::Days7 => Duration::days(7),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementStatus {
    Complete,
    Missing,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Measurement {
    pub id: MeasurementId,
    pub chain: Chain,
    /// Includes the correction revision; replaying it must not add another contribution.
    pub evidence_key: String,
    pub publication_id: Option<PublicationId>,
    pub binding_id: Option<AdSetBindingId>,
    pub window: MeasurementWindow,
    #[serde(default)]
    pub evidence_revision: u64,
    #[serde(default)]
    pub scheduled_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub account_timezone: Option<String>,
    #[serde(default)]
    pub minor_unit_exponent: Option<u8>,
    pub measured_at: OffsetDateTime,
    pub source: String,
    pub raw_metrics: BTreeMap<String, Option<i64>>,
    pub metric_scope: String,
    pub date: Option<Date>,
    pub currency: Option<String>,
    pub status: MeasurementStatus,
    pub rule_version: String,
}
impl Measurement {
    pub fn validate(&self) -> Result<(), StudioError> {
        self.chain.validate()?;
        require_id(self.id.0, "measurement_id")?;
        match (self.publication_id, self.binding_id) {
            (Some(id), None) => {
                require_id(id.0, "publication_id")?;
                if self.metric_scope != "post" {
                    return Err(StudioError::InvalidEvidence("post scope"));
                }
            }
            (None, Some(id)) => {
                require_id(id.0, "binding_id")?;
                if self.metric_scope != "adset" || self.date.is_none() {
                    return Err(StudioError::InvalidEvidence("adset/day scope"));
                }
            }
            _ => {
                return Err(StudioError::InvalidEvidence(
                    "exactly one measurement target",
                ));
            }
        }
        if self.evidence_key.trim().is_empty()
            || self.source.trim().is_empty()
            || self.rule_version.trim().is_empty()
        {
            return Err(StudioError::InvalidEvidence("measurement provenance"));
        }
        if self
            .currency
            .as_ref()
            .is_some_and(|c| jt_strategy::validate_currency(c).is_err())
        {
            return Err(StudioError::InvalidEvidence("currency"));
        }
        Ok(())
    }
}
