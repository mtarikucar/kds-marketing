//! Follow-up tasks attached to a journey.

use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{JourneyId, TaskId};

/// Lifecycle of a journey task.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Work remains outstanding.
    #[default]
    Open,
    /// Work was completed, including closure by a won journey.
    Done,
    /// Work was cancelled, including cancellation by a lost journey.
    Cancelled,
}

/// A tenant-scoped follow-up action; time comparisons use the application's supplied clock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    /// Task identity.
    pub id: TaskId,
    /// Owning tenant.
    pub workspace_id: WorkspaceId,
    /// Journey containing the task.
    pub journey_id: JourneyId,
    /// Human-readable action.
    pub title: String,
    /// Scheduled due time.
    #[serde(with = "time::serde::rfc3339")]
    pub due_at: OffsetDateTime,
    /// Assigned human, or the unassigned queue.
    #[serde(default)]
    pub assignee: Option<UserId>,
    /// Current lifecycle; missing historical values read as Open.
    #[serde(default)]
    pub status: TaskStatus,
}
