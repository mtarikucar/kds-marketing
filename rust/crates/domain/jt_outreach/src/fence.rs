//! The outreach fence (spec §3.11): the checks outreach adds to the inbox fence, each
//! authoritative wherever it runs (D16). [`outreach_fence`] runs at dispatch and again at claim;
//! [`launch_fence`] at launch. The platform switch `JEETA_OUTREACH_ENABLED` (D24, default off)
//! is checked first, so while it is off nothing else can let an outreach email through.

use serde::{Deserialize, Serialize};

use crate::CampaignStatus;

/// Fresh facts about one enrollment's next send, read by the application.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutreachFacts {
    /// The platform switch `JEETA_OUTREACH_ENABLED`.
    pub platform_enabled: bool,
    pub status: CampaignStatus,
    /// [`crate::requires_approval`] of the workspace policy and the sending mailbox.
    pub approval_required: bool,
    /// The revision of the campaign's stored approval.
    pub approved_revision: Option<u32>,
    /// The campaign's current revision.
    pub revision: u32,
    /// The person's email or phone, or their prospect's keys, are on the do-not-contact list.
    pub blocklisted: bool,
    /// The person wrote to the workspace after enrolling.
    pub inbound_since_enrollment: bool,
    /// A meeting was booked with the person after enrolling.
    pub meeting_since_enrollment: bool,
    /// [`crate::OutreachPolicy::sender_identity_complete`].
    pub sender_identity_complete: bool,
}

/// Why outreach refused a send; serialised as its key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum OutreachRefusal {
    /// F2: the platform switch is off.
    #[error("outreach_disabled_on_platform")]
    OutreachDisabledOnPlatform,
    /// F3: the campaign is not running.
    #[error("campaign_not_running")]
    CampaignNotRunning,
    /// F3: approval is required and the current revision is not the approved one.
    #[error("approval_required")]
    ApprovalRequired,
    /// F7.
    #[error("do_not_contact")]
    DoNotContact,
    /// F9: the person replied.
    #[error("replied")]
    Replied,
    /// F9.
    #[error("meeting_booked")]
    MeetingBooked,
    /// F10: the footer's sender identity or privacy notice is not configured.
    #[error("sender_identity_missing")]
    SenderIdentityMissing,
}

impl OutreachRefusal {
    /// The stable key.
    pub fn key(self) -> &'static str {
        match self {
            OutreachRefusal::OutreachDisabledOnPlatform => "outreach_disabled_on_platform",
            OutreachRefusal::CampaignNotRunning => "campaign_not_running",
            OutreachRefusal::ApprovalRequired => "approval_required",
            OutreachRefusal::DoNotContact => "do_not_contact",
            OutreachRefusal::Replied => "replied",
            OutreachRefusal::MeetingBooked => "meeting_booked",
            OutreachRefusal::SenderIdentityMissing => "sender_identity_missing",
        }
    }
}

/// F2, F3, F7, F9 and F10, in this order: the first that fails refuses.
pub fn outreach_fence(f: &OutreachFacts) -> Result<(), OutreachRefusal> {
    if !f.platform_enabled {
        return Err(OutreachRefusal::OutreachDisabledOnPlatform);
    }
    if f.status != CampaignStatus::Running {
        return Err(OutreachRefusal::CampaignNotRunning);
    }
    if f.approval_required && f.approved_revision != Some(f.revision) {
        return Err(OutreachRefusal::ApprovalRequired);
    }
    if f.blocklisted {
        return Err(OutreachRefusal::DoNotContact);
    }
    if f.inbound_since_enrollment {
        return Err(OutreachRefusal::Replied);
    }
    if f.meeting_since_enrollment {
        return Err(OutreachRefusal::MeetingBooked);
    }
    if !f.sender_identity_complete {
        return Err(OutreachRefusal::SenderIdentityMissing);
    }
    Ok(())
}

/// The launch's part of the fence: F2, then F10.
pub fn launch_fence(
    platform_enabled: bool,
    sender_identity_complete: bool,
) -> Result<(), OutreachRefusal> {
    if !platform_enabled {
        return Err(OutreachRefusal::OutreachDisabledOnPlatform);
    }
    if !sender_identity_complete {
        return Err(OutreachRefusal::SenderIdentityMissing);
    }
    Ok(())
}
