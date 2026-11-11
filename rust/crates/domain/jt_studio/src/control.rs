use crate::{StudioError, TiktokPost, require_id};
use jt_strategy::LaneKind;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use time::OffsetDateTime;

/// Human consent metadata attached to a specific piece or budget move revision.
/// The app verifies the target module’s manage permission and a human actor before constructing this receipt.
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
    /// A person's brake on this lane. (A lane once had an approval switch of its own; the
    /// approval that remains is each connection's, design 2026-11-10 B35.)
    pub brake_engaged: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioControl {
    pub workspace_id: WorkspaceId,
    pub brake_engaged: bool,
    pub revision: u64,
    pub lanes: BTreeMap<LaneKind, LaneControl>,
    /// The lanes whose module is removed from the workspace (social media for the organic lane,
    /// advertising for the paid one): they read as braked until the module is installed again.
    /// Derived from the module registry each time the control is read; never stored and never
    /// sent, so a brake a human engaged or released is untouched by it.
    #[serde(skip)]
    pub removed: BTreeSet<LaneKind>,
    /// What a person stopped the spending of in Bütçe (design 2026-11-10 S7, B36). Never
    /// derived; absent from a control stored before it existed, and never written when empty.
    #[serde(default, skip_serializing_if = "SpendStop::is_empty")]
    pub spend_stopped: SpendStop,
}
/// The spending a person stopped: all of it, or that of single modules (their ids: `inbox`,
/// `outreach`, `calls`, `social`). Advertising is not listed here: stopping it is the paid
/// lane's brake, which also pauses what runs at the ad platform.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendStop {
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub modules: BTreeSet<String>,
}
impl SpendStop {
    pub fn is_empty(&self) -> bool {
        !self.all && self.modules.is_empty()
    }
    /// Whether the spending of `module` is stopped.
    pub fn stops(&self, module: &str) -> bool {
        self.all || self.modules.contains(module)
    }
}
impl StudioControl {
    /// Whether Studio's own work on `lane` is stopped: a human's brake, or the lane's module
    /// being removed. Spend that is not Studio's asks [`Self::brake_engaged_for`] instead.
    pub fn is_braked(&self, lane: LaneKind) -> bool {
        self.brake_engaged_for(lane) || self.removed.contains(&lane)
    }
    /// The brake a human engaged, on the workspace or on `lane`, whatever modules are installed.
    /// It is what stops spend that belongs to no Studio chain (an inbox send through a metered
    /// line): removing social media or advertising must not stop the inbox.
    pub fn brake_engaged_for(&self, lane: LaneKind) -> bool {
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
    /// The connection's own policy asks for a person's approval (design 2026-11-10 B35).
    pub capability_requires_human_approval: bool,
    /// The target's provider posts only from its posting screen (TikTok,
    /// [`crate::requires_posting_screen`]): an approval of the revision carrying the screen's
    /// choice is required, whatever the policy above says.
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
        if self.capability_requires_human_approval
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
