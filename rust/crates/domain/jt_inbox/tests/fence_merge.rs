use jt_inbox::*;
use time::{Duration, OffsetDateTime};

fn fence() -> FenceCtx {
    FenceCtx {
        journey_status: Some(JourneyStatus::Contacted),
        person_erased: false,
        person_merged: false,
        conversation_state: ConvState::Ours,
        expected_generation: 7,
        current_generation: 7,
        executor_is_agent: true,
        capability_live: true,
    }
}

#[test]
fn fence_refuses_lost_erased_merged_generation_and_agent_human_hold() {
    let clear = fence();
    for by_agent in [false, true] {
        assert_eq!(may_send(&clear, by_agent), Ok(()));
        for (ctx, reason) in [
            (
                FenceCtx {
                    journey_status: Some(JourneyStatus::Lost),
                    ..clear.clone()
                },
                FenceRefusal::JourneyLost,
            ),
            (
                FenceCtx {
                    person_erased: true,
                    ..clear.clone()
                },
                FenceRefusal::PersonErased,
            ),
            (
                FenceCtx {
                    person_merged: true,
                    ..clear.clone()
                },
                FenceRefusal::PersonMerged,
            ),
            (
                FenceCtx {
                    current_generation: 8,
                    ..clear.clone()
                },
                FenceRefusal::ExecutorChanged,
            ),
            (
                FenceCtx {
                    capability_live: false,
                    ..clear.clone()
                },
                FenceRefusal::CapabilityDown,
            ),
        ] {
            assert_eq!(may_send(&ctx, by_agent), Err(reason));
        }
    }
    let human = FenceCtx {
        executor_is_agent: false,
        ..clear.clone()
    };
    assert_eq!(
        may_send(&human, true),
        Err(FenceRefusal::HumanHoldsConversation)
    );
    assert_eq!(may_send(&human, false), Ok(()));
    for state in [
        ConvState::Closed,
        ConvState::Open,
        ConvState::Ours,
        ConvState::Theirs,
        ConvState::Snoozed {
            until: OffsetDateTime::UNIX_EPOCH,
        },
    ] {
        for journey_status in [None, Some(JourneyStatus::Won), Some(JourneyStatus::New)] {
            let ctx = FenceCtx {
                conversation_state: state.clone(),
                journey_status,
                ..clear.clone()
            };
            assert_eq!(may_send(&ctx, false), Ok(()));
            assert_eq!(may_send(&ctx, true), Ok(()));
        }
    }
}

fn person() -> PersonView {
    PersonView {
        id: PersonId::new_v7(),
        created_at: OffsetDateTime::UNIX_EPOCH,
        open_journeys: 0,
        display_name: "A person".into(),
        email: "person@example.com".into(),
        phone: "+905321234567".into(),
        company: "Company".into(),
    }
}

#[test]
fn merge_auto_requires_no_conflicts() {
    let a = person();
    let mut b = person();
    b.created_at += Duration::days(1);
    for (left, right) in [(0, 0), (1, 0), (0, 1)] {
        let a = PersonView {
            open_journeys: left,
            ..a.clone()
        };
        let b = PersonView {
            open_journeys: right,
            ..b.clone()
        };
        let expected = MergeDecision::Auto {
            keep: a.id,
            merge: b.id,
        };
        assert_eq!(decide_merge(&a, &b), expected);
        assert_eq!(decide_merge(&b, &a), expected);
    }
    for (left, right) in [(1, 1), (2, 0), (0, 2), (u32::MAX, 1)] {
        let a = PersonView {
            open_journeys: left,
            ..a.clone()
        };
        let b = PersonView {
            open_journeys: right,
            ..b.clone()
        };
        assert_eq!(
            decide_merge(&a, &b),
            MergeDecision::Suggest(vec![MergeConflict::TwoOpenJourneys])
        );
    }
    for (candidate, conflict) in [
        (
            PersonView {
                display_name: "Different".into(),
                ..b.clone()
            },
            MergeConflict::DisplayName,
        ),
        (
            PersonView {
                email: "different@example.com".into(),
                ..b.clone()
            },
            MergeConflict::Email,
        ),
        (
            PersonView {
                phone: "+905329999999".into(),
                ..b.clone()
            },
            MergeConflict::Phone,
        ),
        (
            PersonView {
                company: "Different company".into(),
                ..b.clone()
            },
            MergeConflict::Company,
        ),
    ] {
        assert_eq!(
            decide_merge(&a, &candidate),
            MergeDecision::Suggest(vec![conflict])
        );
        assert_eq!(
            decide_merge(&candidate, &a),
            MergeDecision::Suggest(vec![conflict])
        );
    }
    let empty = PersonView {
        display_name: "".into(),
        email: "".into(),
        phone: "".into(),
        company: "".into(),
        ..b.clone()
    };
    assert_eq!(
        decide_merge(&a, &empty),
        MergeDecision::Auto {
            keep: a.id,
            merge: b.id
        }
    );
    assert_eq!(
        decide_merge(&empty, &a),
        MergeDecision::Auto {
            keep: a.id,
            merge: b.id
        }
    );
    let mut all = empty;
    all.display_name = "Other person".into();
    all.email = "other@example.com".into();
    all.phone = "+905551234567".into();
    all.company = "Other company".into();
    all.open_journeys = 2;
    assert_eq!(
        decide_merge(&a, &all),
        MergeDecision::Suggest(vec![
            MergeConflict::TwoOpenJourneys,
            MergeConflict::DisplayName,
            MergeConflict::Email,
            MergeConflict::Phone,
            MergeConflict::Company,
        ])
    );
    b.created_at = a.created_at;
    assert_eq!(decide_merge(&a, &b), decide_merge(&b, &a));
    assert_eq!(
        serde_json::to_value(MergeConflict::TwoOpenJourneys).unwrap(),
        "two_open_journeys"
    );
}
