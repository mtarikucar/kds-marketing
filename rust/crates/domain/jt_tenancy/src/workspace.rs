//! Workspace and membership lifecycle states.

use serde::{Deserialize, Serialize};

/// Lifecycle of a workspace. Only `Active` workspaces pass the gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    PendingPayment,
    Active,
    Suspended,
}

impl WorkspaceStatus {
    /// The stable key, e.g. `"pending_payment"`.
    pub fn key(&self) -> &'static str {
        match self {
            WorkspaceStatus::PendingPayment => "pending_payment",
            WorkspaceStatus::Active => "active",
            WorkspaceStatus::Suspended => "suspended",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<WorkspaceStatus> {
        match key {
            "pending_payment" => Some(WorkspaceStatus::PendingPayment),
            "active" => Some(WorkspaceStatus::Active),
            "suspended" => Some(WorkspaceStatus::Suspended),
            _ => None,
        }
    }
}

/// Lifecycle of a user's membership in a workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MembershipStatus {
    Invited,
    Active,
    Removed,
}

impl MembershipStatus {
    /// The stable key, e.g. `"invited"`.
    pub fn key(&self) -> &'static str {
        match self {
            MembershipStatus::Invited => "invited",
            MembershipStatus::Active => "active",
            MembershipStatus::Removed => "removed",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<MembershipStatus> {
        match key {
            "invited" => Some(MembershipStatus::Invited),
            "active" => Some(MembershipStatus::Active),
            "removed" => Some(MembershipStatus::Removed),
            _ => None,
        }
    }
}
