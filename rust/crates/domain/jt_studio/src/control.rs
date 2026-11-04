use crate::{StudioError, TiktokPost, require_id};
use jt_strategy::LaneKind;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::OffsetDateTime;

/// Human consent metadata attached to a specific piece or budget move revision.
/// The app verifies studio.manage and a human actor before constructing this receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalReceipt {
    pub revision: u64,
    pub by: UserId,
    #[serde(with = "crate::time_compat")]
    pub at: OffsetDateTime,
    /// What the human chose on the TikTok posting screen, for a TikTok piece (see
    /// [`crate::requires_posting_screen`]): the post goes out as chosen. Absent from receipts
    /// written before the screen existed, and never written when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiktok: Option<TiktokPost>,
}
impl ApprovalReceipt {
    pub fn approves(&self, revision: u64) -> bool {
        revision > 0 && self.revision == revision && !self.by.0.is_nil()
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneControl {
    pub brake_engaged: bool,
    pub requires_human_approval: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioControl {
    pub workspace_id: WorkspaceId,
    pub brake_engaged: bool,
    pub revision: u64,
    pub lanes: BTreeMap<LaneKind, LaneControl>,
}
impl StudioControl {
    pub fn is_braked(&self, lane: LaneKind) -> bool {
        self.brake_engaged || self.lanes.get(&lane).is_some_and(|l| l.brake_engaged)
    }
    pub fn validate(&self) -> Result<(), StudioError> {
        require_id(self.workspace_id.0, "workspace_id")
    }
}
/// Revision and consent checks only. This is not an application execution permit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StudioPolicy {
    pub expected_revision: u64,
    pub requires_human_approval: bool,
    pub capability_requires_human_approval: bool,
    /// The target's provider posts only from its posting screen (TikTok,
    /// [`crate::requires_posting_screen`]): an approval of the revision carrying the screen's
    /// choice is required, whatever the two policies above say.
    pub posting_screen_required: bool,
    pub approval: Option<ApprovalReceipt>,
}
impl StudioPolicy {
    pub fn check_approval(&self, revision: u64) -> Result<(), StudioError> {
        if self.posting_screen_required
            && !self
                .approval
                .as_ref()
                .is_some_and(|receipt| receipt.approves(revision) && receipt.tiktok.is_some())
        {
            return Err(StudioError::PostingScreenRequired);
        }
        if (self.requires_human_approval || self.capability_requires_human_approval)
            && !self
                .approval
                .as_ref()
                .is_some_and(|receipt| receipt.approves(revision))
        {
            Err(StudioError::ApprovalRequired)
        } else {
            Ok(())
        }
    }
}
