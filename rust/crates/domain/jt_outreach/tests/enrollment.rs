//! Enrollment states, stop and skip reasons with stable keys, the step schedule, send outcomes
//! and personalization bounds (spec §3.10, §3.11, D16).

mod support;

use std::collections::BTreeMap;

use jt_outreach::*;
use serde_json::json;
use support::*;
use time::Duration;

#[test]
fn stop_and_skip_keys_are_stable() {
    for (r, key) in [
        (StopReason::Replied, "replied"),
        (StopReason::Bounced, "bounced"),
        (StopReason::Complained, "complained"),
        (StopReason::Unsubscribed, "unsubscribed"),
        (StopReason::ConsentWithdrawn, "consent_withdrawn"),
        (StopReason::MeetingBooked, "meeting_booked"),
        (StopReason::JourneyWon, "journey_won"),
        (StopReason::JourneyLost, "journey_lost"),
        (StopReason::PersonErased, "person_erased"),
        (StopReason::PersonMerged, "person_merged"),
        (
            StopReason::HumanHoldsConversation,
            "human_holds_conversation",
        ),
        (StopReason::DoNotContact, "do_not_contact"),
        (StopReason::CampaignCanceled, "campaign_canceled"),
        (StopReason::Manual, "manual"),
        (StopReason::Refused("IZIN_YOK".into()), "refused:IZIN_YOK"),
        (
            StopReason::MissingVariable("first_name".into()),
            "missing_variable:first_name",
        ),
    ] {
        assert_eq!(r.key(), key);
        assert_eq!(StopReason::parse(key), Some(r.clone()));
        assert_eq!(serde_json::to_value(&r).unwrap(), json!(key));
        assert_eq!(serde_json::from_value::<StopReason>(json!(key)).unwrap(), r);
    }
    for bad in [
        "",
        "nonsense",
        "refused:",
        "missing_variable:",
        "refused:a\nb",
    ] {
        assert_eq!(StopReason::parse(bad), None, "{bad:?}");
    }
    for (r, key) in [
        (SkipReason::NoDeliverableEmail, "no_deliverable_email"),
        (SkipReason::Suppressed, "suppressed"),
        (SkipReason::NoBasis, "no_basis"),
        (SkipReason::DoNotContact, "do_not_contact"),
        (SkipReason::ActiveElsewhere, "active_elsewhere"),
        (SkipReason::PersonGone, "person_gone"),
        (SkipReason::JourneyClosed, "journey_closed"),
        (SkipReason::PromotionCap, "promotion_cap"),
    ] {
        assert_eq!(r.key(), key);
        assert_eq!(SkipReason::parse(key), Some(r));
        assert_eq!(serde_json::to_value(r).unwrap(), json!(key));
    }
    assert_eq!(SkipReason::ALL.len(), 8);
    for s in EnrollmentStatus::ALL {
        assert_eq!(EnrollmentStatus::parse(s.key()), Some(*s));
    }
    assert_eq!(EnrollmentStatus::Active.key(), "active");
}

#[test]
fn the_next_step_follows_the_delays() {
    let steps = vec![step(1, 0), step(2, 3), step(3, 7)];
    assert_eq!(
        next_step_after(&steps, 1, NOW),
        Some((2, NOW + Duration::days(3)))
    );
    assert_eq!(
        next_step_after(&steps, 2, NOW),
        Some((3, NOW + Duration::days(7)))
    );
    assert_eq!(next_step_after(&steps, 3, NOW), None, "the last step");
    assert_eq!(next_step_after(&steps, 9, NOW), None);
}

#[test]
fn send_outcomes_move_forward_only() {
    use SendOutcome::*;
    let allowed = [
        (Queued, Sent),
        (Queued, Failed),
        (Queued, Unknown),
        (Queued, Refused),
        (Unknown, Sent),
        (Unknown, Failed),
        (Unknown, Bounced),
        (Unknown, Complained),
        (Sent, Bounced),
        (Sent, Complained),
    ];
    for from in SendOutcome::ALL {
        for to in SendOutcome::ALL {
            assert_eq!(
                from.can_become(*to),
                allowed.contains(&(*from, *to)),
                "{from:?} -> {to:?}"
            );
        }
        assert_eq!(SendOutcome::parse(from.key()), Some(*from));
    }
    assert!(Sent.left_the_mailbox() && Bounced.left_the_mailbox() && Unknown.left_the_mailbox());
    assert!(
        !Queued.left_the_mailbox() && !Failed.left_the_mailbox() && !Refused.left_the_mailbox()
    );
}

fn personalization(pairs: &[(&str, String)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}

#[test]
fn personalization_is_bounded() {
    assert_eq!(
        validate_personalization(&personalization(&[("opener", "Merhaba".into())])),
        Ok(())
    );
    let reason = |m: BTreeMap<String, String>| match validate_personalization(&m) {
        Err(CampaignError::Invalid { field, reason }) => {
            assert_eq!(field, "personalization");
            reason
        }
        other => panic!("{other:?}"),
    };
    let many: BTreeMap<String, String> = (0..21).map(|i| (format!("k{i}"), "v".into())).collect();
    assert_eq!(reason(many), "too_many");
    for key in ["Opener", "a-b", "", "custom.opener"] {
        assert_eq!(
            reason(personalization(&[(key, "x".into())])),
            "custom_key",
            "{key:?}"
        );
    }
    assert_eq!(
        reason(personalization(&[("opener", "ş".repeat(501))])),
        "length"
    );
    assert_eq!(
        reason(personalization(&[("opener", "  ".into())])),
        "length"
    );
    assert!(validate_personalization(&personalization(&[("opener", "ş".repeat(500))])).is_ok());
}
