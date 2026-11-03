//! The campaign state machine with revision-bound approval (spec §3.10, §3.13, D19) and the
//! definition's bounds.

mod support;

use jt_inbox::{JourneyStatus, PersonId};
use jt_outreach::*;
use jt_tenancy::UserId;
use support::*;
use time::Duration;
use uuid::Uuid;

use CampaignStatus as S;

const STATUSES: [CampaignStatus; 7] = [
    S::Draft,
    S::AwaitingApproval,
    S::Scheduled,
    S::Running,
    S::Paused,
    S::Completed,
    S::Canceled,
];

fn events() -> Vec<CampaignEvent> {
    vec![
        CampaignEvent::Launch {
            approval_required: false,
            now: NOW,
        },
        CampaignEvent::Launch {
            approval_required: true,
            now: NOW,
        },
        CampaignEvent::Approve {
            revision: 1,
            now: NOW,
        },
        CampaignEvent::Start { now: NOW },
        CampaignEvent::Pause {
            reason: PauseReason::Manual,
        },
        CampaignEvent::Resume {
            approval_required: false,
            now: NOW,
        },
        CampaignEvent::Resume {
            approval_required: true,
            now: NOW,
        },
        CampaignEvent::Complete,
        CampaignEvent::Cancel,
        CampaignEvent::Edit,
    ]
}

/// Spec §3.10's machine at revision 1 without an approval and without a start time, pair by pair.
fn allowed() -> Vec<(CampaignStatus, usize, CampaignStatus, ApprovalChange)> {
    use ApprovalChange::*;
    vec![
        (S::Draft, 0, S::Running, Keep),
        (S::Draft, 1, S::AwaitingApproval, Keep),
        (S::Draft, 8, S::Canceled, Keep),
        (S::Draft, 9, S::Draft, Void),
        (S::AwaitingApproval, 2, S::Running, Set),
        (S::AwaitingApproval, 8, S::Canceled, Keep),
        (S::Scheduled, 3, S::Running, Keep),
        (S::Scheduled, 4, S::Paused, Keep),
        (S::Scheduled, 8, S::Canceled, Keep),
        (S::Running, 4, S::Paused, Keep),
        (S::Running, 7, S::Completed, Keep),
        (S::Running, 8, S::Canceled, Keep),
        (S::Paused, 2, S::Paused, Set),
        (S::Paused, 5, S::Running, Keep),
        (S::Paused, 6, S::AwaitingApproval, Keep),
        (S::Paused, 8, S::Canceled, Keep),
        (S::Paused, 9, S::Paused, Void),
    ]
}

#[test]
fn every_campaign_next_pair() {
    let events = events();
    let allowed = allowed();
    for from in STATUSES {
        for (i, event) in events.iter().enumerate() {
            let got = campaign_next(from, None, 1, None, event);
            match allowed.iter().find(|(f, e, _, _)| *f == from && *e == i) {
                Some((_, _, to, change)) => {
                    assert_eq!(got, Ok((*to, *change)), "{from:?} {event:?}")
                }
                None => assert_eq!(
                    got,
                    Err(CampaignError::Transition {
                        from: from.key(),
                        event: event.key()
                    }),
                    "{from:?} {event:?}"
                ),
            }
        }
    }
    assert_eq!(
        campaign_next(S::Completed, None, 1, None, &CampaignEvent::Cancel)
            .unwrap_err()
            .to_string(),
        "a completed campaign cannot be canceled"
    );
    for s in STATUSES {
        assert_eq!(CampaignStatus::parse(s.key()), Some(s));
        assert_eq!(
            s.is_final(),
            matches!(s, S::Completed | S::Canceled),
            "{s:?}"
        );
    }
}

#[test]
fn a_future_start_schedules_and_start_waits_for_it() {
    let later = NOW + Duration::hours(2);
    let launch = CampaignEvent::Launch {
        approval_required: false,
        now: NOW,
    };
    assert_eq!(
        campaign_next(S::Draft, None, 1, Some(later), &launch),
        Ok((S::Scheduled, ApprovalChange::Keep))
    );
    assert_eq!(
        campaign_next(
            S::Draft,
            None,
            1,
            Some(NOW),
            &CampaignEvent::Launch {
                approval_required: false,
                now: NOW
            }
        ),
        Ok((S::Running, ApprovalChange::Keep)),
        "a start time reached runs at once"
    );
    assert_eq!(
        campaign_next(
            S::Scheduled,
            None,
            1,
            Some(later),
            &CampaignEvent::Start { now: NOW }
        ),
        Err(CampaignError::NotYet)
    );
    assert_eq!(
        campaign_next(
            S::Scheduled,
            None,
            1,
            Some(later),
            &CampaignEvent::Start { now: later }
        ),
        Ok((S::Running, ApprovalChange::Keep))
    );
    assert_eq!(
        campaign_next(
            S::AwaitingApproval,
            None,
            1,
            Some(later),
            &CampaignEvent::Approve {
                revision: 1,
                now: NOW
            }
        ),
        Ok((S::Scheduled, ApprovalChange::Set))
    );
}

fn approval(revision: u32) -> Approval {
    Approval {
        revision,
        by: UserId(Uuid::from_u128(5)),
        at: NOW,
    }
}

#[test]
fn edit_voids_approval() {
    for from in [S::Draft, S::Paused] {
        assert_eq!(
            campaign_next(from, Some(&approval(3)), 3, None, &CampaignEvent::Edit),
            Ok((from, ApprovalChange::Void))
        );
    }
    for from in [S::AwaitingApproval, S::Scheduled, S::Running] {
        assert!(
            campaign_next(from, Some(&approval(3)), 3, None, &CampaignEvent::Edit).is_err(),
            "saving is refused while {from:?}"
        );
    }
}

#[test]
fn approval_is_bound_to_the_revision() {
    assert_eq!(
        campaign_next(
            S::AwaitingApproval,
            None,
            4,
            None,
            &CampaignEvent::Approve {
                revision: 3,
                now: NOW
            }
        ),
        Err(CampaignError::StaleRevision)
    );
    // A launch that needs approval goes straight on only with an approval of this revision.
    let launch = CampaignEvent::Launch {
        approval_required: true,
        now: NOW,
    };
    assert_eq!(
        campaign_next(S::Draft, Some(&approval(2)), 2, None, &launch),
        Ok((S::Running, ApprovalChange::Keep))
    );
    assert_eq!(
        campaign_next(S::Draft, Some(&approval(1)), 2, None, &launch),
        Ok((S::AwaitingApproval, ApprovalChange::Keep))
    );
}

#[test]
fn resume_requires_current_approval() {
    let resume = CampaignEvent::Resume {
        approval_required: true,
        now: NOW,
    };
    // An edit while paused bumped the revision to 2: the approval of revision 1 no longer counts.
    assert_eq!(
        campaign_next(S::Paused, Some(&approval(1)), 2, None, &resume),
        Ok((S::AwaitingApproval, ApprovalChange::Keep))
    );
    assert_eq!(
        campaign_next(S::Paused, Some(&approval(2)), 2, None, &resume),
        Ok((S::Running, ApprovalChange::Keep))
    );
    assert_eq!(
        campaign_next(
            S::Paused,
            Some(&approval(1)),
            2,
            None,
            &CampaignEvent::Resume {
                approval_required: false,
                now: NOW
            }
        ),
        Ok((S::Running, ApprovalChange::Keep))
    );
    assert!(requires_approval(true, false));
    assert!(requires_approval(false, true));
    assert!(!requires_approval(false, false));
}

fn invalid(d: &Definition) -> (&'static str, &'static str) {
    match validate_definition(d) {
        Err(CampaignError::Invalid { field, reason }) => (field, reason),
        other => panic!("{other:?}"),
    }
}

#[test]
fn validate_definition_bounds() {
    assert_eq!(validate_definition(&definition()), Ok(()));
    let mut d = definition();
    d.steps = (0..6)
        .map(|i| step(i, if i == 0 { 0 } else { 30 }))
        .collect();
    assert_eq!(validate_definition(&d), Ok(()), "6 steps, delays up to 30");

    type Case = (fn(&mut Definition), (&'static str, &'static str));
    let cases: Vec<Case> = vec![
        (|d| d.steps.clear(), ("steps", "count")),
        (
            |d| d.steps = (0..7).map(|i| step(i, u16::from(i != 0))).collect(),
            ("steps", "count"),
        ),
        (
            |d| d.steps[0].delay_days = 1,
            ("steps.delay_days", "first_step"),
        ),
        (|d| d.steps[1].delay_days = 0, ("steps.delay_days", "range")),
        (
            |d| d.steps[1].delay_days = 31,
            ("steps.delay_days", "range"),
        ),
        (
            |d| d.steps[0].same_thread = true,
            ("steps.same_thread", "first_step"),
        ),
        (|d| d.throttle.per_hour = 0, ("throttle.per_hour", "range")),
        (|d| d.throttle.per_hour = 61, ("throttle.per_hour", "range")),
        (|d| d.throttle.per_day = 0, ("throttle.per_day", "range")),
        (|d| d.throttle.per_day = 501, ("throttle.per_day", "range")),
        (
            |d| d.schedule.window.to = d.schedule.window.from,
            ("schedule.window", "invalid"),
        ),
        (
            |d| d.schedule.window.days.clear(),
            ("schedule.window", "invalid"),
        ),
        (
            |d| d.schedule.window.tz = "Mars".into(),
            ("schedule.window", "invalid"),
        ),
        (|d| d.sender_name = " ".into(), ("sender_name", "length")),
        (
            |d| d.sender_name = "a".repeat(81),
            ("sender_name", "length"),
        ),
        (
            |d| d.sender_name = "Ayşe\r\nBcc: x".into(),
            ("sender_name", "control_character"),
        ),
        (|d| d.audience = Audience::default(), ("audience", "empty")),
        (
            |d| d.audience.explicit = (0..501).map(|i| PersonId(Uuid::from_u128(i))).collect(),
            ("audience.explicit", "too_many"),
        ),
        (
            |d| {
                d.audience.people = Some(PeopleFilter {
                    journey_statuses: vec![JourneyStatus::New, JourneyStatus::Won],
                    ..PeopleFilter::default()
                })
            },
            ("audience.people.journey_statuses", "closed_stage"),
        ),
        (
            |d| {
                d.audience.people = Some(PeopleFilter {
                    opened_after: Some(NOW),
                    opened_before: Some(NOW),
                    ..PeopleFilter::default()
                })
            },
            ("audience.people.opened_before", "range"),
        ),
        (
            |d| {
                d.audience.people = Some(PeopleFilter {
                    cities: vec!["  ".into()],
                    ..PeopleFilter::default()
                })
            },
            ("audience.people.cities", "bounds"),
        ),
        (
            |d| {
                d.audience.prospects = Some(ProspectFilter {
                    sectors: (0..51).map(|i| format!("sektör {i}")).collect(),
                    ..ProspectFilter::default()
                })
            },
            ("audience.prospects.sectors", "bounds"),
        ),
        (
            |d| {
                d.audience.prospects = Some(ProspectFilter {
                    min_score: Some(101),
                    ..ProspectFilter::default()
                })
            },
            ("audience.prospects.min_score", "range"),
        ),
        (
            |d| d.segment_key = Some(" ".into()),
            ("segment_key", "length"),
        ),
    ];
    for (change, expected) in cases {
        let mut d = definition();
        change(&mut d);
        assert_eq!(invalid(&d), expected);
    }
    // A filter alone is an audience.
    let mut d = definition();
    d.audience = Audience {
        prospects: Some(ProspectFilter::default()),
        ..Audience::default()
    };
    assert_eq!(validate_definition(&d), Ok(()));

    assert!(validate_campaign_name("Ekim tanışma").is_ok());
    for name in ["", " ", "a\tb"] {
        assert!(validate_campaign_name(name).is_err(), "{name:?}");
    }
    assert!(validate_campaign_name(&"a".repeat(121)).is_err());
}

#[test]
fn definitions_refuse_unknown_fields_and_round_trip() {
    let d = definition();
    let mut v = serde_json::to_value(&d).unwrap();
    assert_eq!(serde_json::from_value::<Definition>(v.clone()).unwrap(), d);
    v["click_traking"] = serde_json::json!(true);
    assert!(serde_json::from_value::<Definition>(v).is_err());
    let mut v = serde_json::to_value(&d).unwrap();
    v["steps"][0]["attachments"] = serde_json::json!([]);
    assert!(
        serde_json::from_value::<Definition>(v).is_err(),
        "steps carry no attachments (D12)"
    );
    // Optional parts read as their defaults.
    let v = serde_json::json!({
        "sender_name": "Ayşe",
        "steps": [{"template_id": Uuid::from_u128(1), "delay_days": 0}],
        "audience": {"explicit": [Uuid::from_u128(9)]},
        "schedule": {"window": {"tz": "UTC", "from": 9, "to": 17, "days": [1]}},
        "throttle": {"per_hour": 10, "per_day": 50}
    });
    let d: Definition = serde_json::from_value(v).unwrap();
    assert!(!d.click_tracking && !d.evergreen && d.schedule.start_at.is_none());
    assert!(!d.steps[0].same_thread && d.steps[0].snapshot.is_none());
    for r in [
        PauseReason::Manual,
        PauseReason::BounceRate,
        PauseReason::Complaints,
        PauseReason::MailboxDown,
        PauseReason::StrategyChanged,
    ] {
        assert_eq!(PauseReason::parse(r.key()), Some(r));
    }
    assert_eq!(PauseReason::BounceRate.key(), "bounce_rate");
}
