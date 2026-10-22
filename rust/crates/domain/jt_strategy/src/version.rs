//! Strategy versions and their lifecycle.

use jt_ledger::Actor;
use jt_tenancy::{UserId, WorkspaceId, define_id};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::sections::Sections;

define_id!(
    /// A version of a workspace's strategy.
    StrategyVersionId
);

/// Lifecycle of a strategy version. A workspace has at most one `Draft` and at most one
/// `Approved` version at a time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionStatus {
    /// Being worked out in the consultation; may be submitted for approval.
    Draft,
    /// The strategy in force; opens the strategy gate.
    Approved,
    /// Superseded by a later approval, or archived by an owner or manager.
    Archived,
}

impl VersionStatus {
    /// The stable key, e.g. `"draft"`.
    pub fn key(&self) -> &'static str {
        match self {
            VersionStatus::Draft => "draft",
            VersionStatus::Approved => "approved",
            VersionStatus::Archived => "archived",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<VersionStatus> {
        match key {
            "draft" => Some(VersionStatus::Draft),
            "approved" => Some(VersionStatus::Approved),
            "archived" => Some(VersionStatus::Archived),
            _ => None,
        }
    }
}

/// One numbered version of a workspace's strategy. Its hypotheses are kept beside it, keyed by
/// the version (see [`crate::Hypothesis`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StrategyVersion {
    pub id: StrategyVersionId,
    pub workspace_id: WorkspaceId,
    /// 1, 2, 3, ... per workspace.
    pub number: i32,
    pub status: VersionStatus,
    pub sections: Sections,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Who opened the consultation that produced this version.
    pub created_by: Actor,
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub approved_at: Option<OffsetDateTime>,
    /// The user who approved it; for an agent, the user who issued its connection.
    pub approved_by: Option<UserId>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub archived_at: Option<OffsetDateTime>,
}
