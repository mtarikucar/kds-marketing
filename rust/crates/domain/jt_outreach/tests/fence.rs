//! The outreach fence (spec §3.11 F2, F3, F7, F9, F10; D24): the platform switch first, so a
//! locked platform refuses whatever else holds.

use jt_outreach::*;

fn open() -> OutreachFacts {
    OutreachFacts {
        platform_enabled: true,
        status: CampaignStatus::Running,
        approval_required: true,
        approved_revision: Some(2),
        revision: 2,
        blocklisted: false,
        inbound_since_enrollment: false,
        meeting_since_enrollment: false,
        sender_identity_complete: true,
    }
}

#[test]
fn refusals_in_order() {
    assert_eq!(outreach_fence(&open()), Ok(()));
    let everything_wrong = OutreachFacts {
        platform_enabled: false,
        status: CampaignStatus::Paused,
        approval_required: true,
        approved_revision: Some(1),
        revision: 2,
        blocklisted: true,
        inbound_since_enrollment: true,
        meeting_since_enrollment: true,
        sender_identity_complete: false,
    };
    // Fix one fact at a time, in the fence's order: each step reveals the next refusal.
    let mut f = everything_wrong;
    let mut seen = vec![];
    loop {
        match outreach_fence(&f) {
            Ok(()) => break,
            Err(r) => {
                seen.push(r);
                match r {
                    OutreachRefusal::OutreachDisabledOnPlatform => f.platform_enabled = true,
                    OutreachRefusal::CampaignNotRunning => f.status = CampaignStatus::Running,
                    OutreachRefusal::ApprovalRequired => f.approved_revision = Some(2),
                    OutreachRefusal::DoNotContact => f.blocklisted = false,
                    OutreachRefusal::Replied => f.inbound_since_enrollment = false,
                    OutreachRefusal::MeetingBooked => f.meeting_since_enrollment = false,
                    OutreachRefusal::SenderIdentityMissing => f.sender_identity_complete = true,
                }
            }
        }
    }
    use OutreachRefusal::*;
    assert_eq!(
        seen,
        vec![
            OutreachDisabledOnPlatform,
            CampaignNotRunning,
            ApprovalRequired,
            DoNotContact,
            Replied,
            MeetingBooked,
            SenderIdentityMissing,
        ]
    );
    let keys: Vec<_> = seen.iter().map(|r| r.key()).collect();
    assert_eq!(
        keys,
        [
            "outreach_disabled_on_platform",
            "campaign_not_running",
            "approval_required",
            "do_not_contact",
            "replied",
            "meeting_booked",
            "sender_identity_missing",
        ]
    );
    assert_eq!(
        OutreachDisabledOnPlatform.to_string(),
        "outreach_disabled_on_platform"
    );
    assert_eq!(
        serde_json::to_value(ApprovalRequired).unwrap(),
        serde_json::json!("approval_required")
    );
}

#[test]
fn a_locked_platform_refuses_whatever_else_holds() {
    for status in [
        CampaignStatus::Draft,
        CampaignStatus::Running,
        CampaignStatus::Completed,
    ] {
        let f = OutreachFacts {
            platform_enabled: false,
            status,
            ..open()
        };
        assert_eq!(
            outreach_fence(&f),
            Err(OutreachRefusal::OutreachDisabledOnPlatform)
        );
    }
    assert_eq!(
        launch_fence(false, true),
        Err(OutreachRefusal::OutreachDisabledOnPlatform)
    );
    assert_eq!(
        launch_fence(false, false),
        Err(OutreachRefusal::OutreachDisabledOnPlatform),
        "F2 before F10"
    );
    assert_eq!(
        launch_fence(true, false),
        Err(OutreachRefusal::SenderIdentityMissing)
    );
    assert_eq!(launch_fence(true, true), Ok(()));
}

#[test]
fn approval_counts_only_when_required() {
    let f = OutreachFacts {
        approval_required: false,
        approved_revision: None,
        ..open()
    };
    assert_eq!(outreach_fence(&f), Ok(()));
    let f = OutreachFacts {
        approved_revision: None,
        ..open()
    };
    assert_eq!(outreach_fence(&f), Err(OutreachRefusal::ApprovalRequired));
}
