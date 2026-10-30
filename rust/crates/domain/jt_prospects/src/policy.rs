//! Retention and caps of the pool (spec §3.6, §3.7). The defaults are the owner's decision of
//! 2026-10-30 (spec §2 D9, §15 Q2): rejected prospects are purged 30 days after the rejection,
//! unpromoted ones 180 days after their last update, and a purged rejection's keys are
//! remembered for 365 days.

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::ProspectStatus;

/// The most prospects a workspace creates per local day.
pub const MAX_DAILY_PROSPECTS: u32 = 500;

/// The pool's part of the workspace's leads policy. Stored as JSON and read key by key: a
/// missing key reads as its default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProspectsPolicy {
    /// Days a rejected prospect is kept after the rejection (`1..=730`).
    pub rejected_retention_days: u16,
    /// Days a `new` or `qualified` prospect is kept after its last update (`1..=730`).
    pub unpromoted_retention_days: u16,
    /// Days a purged rejection's key hashes keep agents from recording it again (`0..=1095`).
    pub rejected_memory_days: u16,
    /// Prospects promoted per local day (`1..=1000`).
    pub max_promotions_per_day: u16,
    /// Agents promote only qualified prospects; people may promote new ones.
    pub agents_promote_qualified_only: bool,
}

impl Default for ProspectsPolicy {
    fn default() -> Self {
        Self {
            rejected_retention_days: 30,
            unpromoted_retention_days: 180,
            rejected_memory_days: 365,
            max_promotions_per_day: 100,
            agents_promote_qualified_only: true,
        }
    }
}

/// When a prospect in `status` is purged: a rejection `rejected_retention_days` after it was
/// decided (after the last update when the decision time is unknown); a `new` or `qualified`
/// prospect `unpromoted_retention_days` after its last update; never for a promoted prospect
/// (its lifetime is its person's) or a do-not-contact one (only hashes remain of it).
pub fn purge_after(
    policy: &ProspectsPolicy,
    status: ProspectStatus,
    decided_at: Option<OffsetDateTime>,
    updated_at: OffsetDateTime,
) -> Option<OffsetDateTime> {
    match status {
        ProspectStatus::Rejected => Some(
            decided_at.unwrap_or(updated_at)
                + Duration::days(i64::from(policy.rejected_retention_days)),
        ),
        ProspectStatus::New | ProspectStatus::Qualified => {
            Some(updated_at + Duration::days(i64::from(policy.unpromoted_retention_days)))
        }
        ProspectStatus::Promoted | ProspectStatus::DoNotContact => None,
    }
}
