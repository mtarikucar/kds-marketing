use jt_inbox::*;
use jt_tenancy::{UserId, WorkspaceId};
use time::{Duration, OffsetDateTime};

fn now() -> OffsetDateTime {
    OffsetDateTime::UNIX_EPOCH + Duration::days(20)
}

fn journey(status: JourneyStatus) -> Journey {
    Journey {
        id: JourneyId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        person_id: PersonId::new_v7(),
        status,
        owner: None,
        opened_at: now() - Duration::days(1),
        closed_at: None,
        lost_reason: None,
        unreachable_attempts: 0,
        source: Source::Import,
        updated_at: now() - Duration::hours(1),
        reduce_input: ReduceInput::default(),
    }
}

fn event(j: &Journey, kind: JourneyEventKind) -> JourneyEvent {
    JourneyEvent {
        id: JourneyEventId::new_v7(),
        workspace_id: j.workspace_id,
        journey_id: j.id,
        source: EventSource::System,
        idempotency_key: "event-1".into(),
        kind,
        reason_label: None,
        at: now(),
    }
}

fn apply(j: &Journey, kind: JourneyEventKind) -> Transition {
    reduce(j, &event(j, kind), &ReducePolicy::default()).unwrap()
}

#[test]
fn reducer_table_matches_spec() {
    use JourneyEventKind as E;
    use JourneyStatus as S;
    for (from, kind, to, effects) in [
        (
            S::New,
            E::MessageReceived,
            S::New,
            vec![JourneyEffect::ConversationOurs],
        ),
        (
            S::New,
            E::Replied,
            S::Contacted,
            vec![JourneyEffect::ConversationTheirs],
        ),
        (
            S::New,
            E::CallMade { connected: true },
            S::Contacted,
            vec![],
        ),
        (S::New, E::CallMade { connected: false }, S::New, vec![]),
        (S::Contacted, E::AppointmentBooked, S::Appointment, vec![]),
        (S::Appointment, E::MeetingHeld, S::Met, vec![]),
        (S::Met, E::QuoteSent, S::Quoted, vec![]),
        (S::Quoted, E::QuoteAccepted, S::Pending, vec![]),
        (
            S::Pending,
            E::Won {
                product: "service".into(),
                amount_minor: 12500,
                currency: "TRY".into(),
            },
            S::Won,
            vec![
                JourneyEffect::CommissionDue {
                    amount_minor: 12500,
                    currency: "TRY".into(),
                },
                JourneyEffect::CloseTasks,
            ],
        ),
        (
            S::Contacted,
            E::Snoozed {
                until: now() + Duration::days(1),
            },
            S::Contacted,
            vec![JourneyEffect::ConversationSnoozed {
                until: now() + Duration::days(1),
            }],
        ),
        (
            S::Quoted,
            E::Merged {
                target: PersonId::new_v7(),
            },
            S::Quoted,
            vec![],
        ),
    ] {
        let j = journey(from);
        let transition = apply(&j, kind);
        assert_eq!(transition.from(), from);
        assert_eq!(transition.to(), to);
        assert_eq!(transition.patch().status, to);
        assert_eq!(transition.effects(), effects);
        assert_eq!(transition.patch().updated_at, now());
        assert_eq!(
            transition.patch().closed_at,
            (to == S::Won).then_some(now())
        );
    }
    let j = journey(S::Pending);
    let mut e = event(
        &j,
        E::Lost {
            reason_key: "fiyat".into(),
        },
    );
    e.reason_label = Some("Price at time of loss".into());
    let transition = reduce(&j, &e, &ReducePolicy::default()).unwrap();
    assert_eq!(transition.to(), S::Lost);
    assert_eq!(transition.patch().closed_at, Some(now()));
    assert_eq!(
        transition.patch().lost_reason,
        Some(LostReason {
            reason_key: "fiyat".into(),
            reason_label: "Price at time of loss".into(),
        })
    );
    assert_eq!(
        transition.effects(),
        [
            JourneyEffect::CloseConversations,
            JourneyEffect::CancelOpenTasks
        ]
    );
    for (attempts, wanted) in [(0, S::New), (1, S::New), (2, S::Unreachable)] {
        let mut j = journey(S::New);
        j.unreachable_attempts = attempts;
        let transition = apply(&j, E::CallMade { connected: false });
        assert_eq!(transition.to(), wanted);
        assert_eq!(transition.patch().unreachable_attempts, attempts + 1);
    }
}

#[test]
fn failed_calls_never_regress_advanced_stages() {
    for status in [
        JourneyStatus::Appointment,
        JourneyStatus::Met,
        JourneyStatus::Quoted,
        JourneyStatus::Pending,
    ] {
        for attempts in [0, 2, 254, 255] {
            let mut j = journey(status);
            j.unreachable_attempts = attempts;
            let transition = apply(&j, JourneyEventKind::CallMade { connected: false });
            assert_eq!(transition.to(), status);
            assert_eq!(
                transition.patch().unreachable_attempts,
                attempts.saturating_add(1)
            );
        }
    }
    let mut j = journey(JourneyStatus::Contacted);
    j.unreachable_attempts = 1;
    let transition = reduce(
        &j,
        &event(&j, JourneyEventKind::CallMade { connected: false }),
        &ReducePolicy {
            unreachable_threshold: 2,
        },
    )
    .unwrap();
    assert_eq!(transition.to(), JourneyStatus::Unreachable);
}

#[test]
fn equal_rank_success_recovers_unreachable() {
    for kind in [
        JourneyEventKind::CallMade { connected: true },
        JourneyEventKind::Replied,
    ] {
        for (status, expected) in [
            (JourneyStatus::Unreachable, JourneyStatus::Contacted),
            (JourneyStatus::Pending, JourneyStatus::Pending),
        ] {
            let mut j = journey(status);
            j.unreachable_attempts = 3;
            let transition = apply(&j, kind.clone());
            assert_eq!(transition.to(), expected);
            assert_eq!(transition.patch().unreachable_attempts, 0);
        }
    }
}

#[test]
fn reopen_clears_full_patch() {
    let mut j = journey(JourneyStatus::Lost);
    j.closed_at = Some(now() - Duration::hours(1));
    j.unreachable_attempts = 7;
    j.lost_reason = Some(LostReason {
        reason_key: "fiyat".into(),
        reason_label: "Price".into(),
    });
    let mut e = event(&j, JourneyEventKind::Reopened);
    e.source = EventSource::Human(UserId::new_v7());
    assert!(matches!(
        reduce(&j, &e, &ReducePolicy::default()),
        Err(ReduceError::NotAllowed(_))
    ));
    j.reduce_input = ReduceInput::new([], true).unwrap();
    let transition = reduce(&j, &e, &ReducePolicy::default()).unwrap();
    assert_eq!(transition.to(), JourneyStatus::Contacted);
    assert_eq!(transition.patch().closed_at, None);
    assert_eq!(transition.patch().lost_reason, None);
    assert_eq!(transition.patch().unreachable_attempts, 0);
    assert_eq!(transition.patch().updated_at, now());
    assert!(transition.effects().is_empty());
    for source in [EventSource::Agent, EventSource::System] {
        e.source = source;
        assert!(matches!(
            reduce(&j, &e, &ReducePolicy::default()),
            Err(ReduceError::NotAllowed(_))
        ));
    }
    j.status = JourneyStatus::Contacted;
    e.source = EventSource::Human(UserId::new_v7());
    assert!(matches!(
        reduce(&j, &e, &ReducePolicy::default()),
        Err(ReduceError::NotAllowed(_))
    ));
}

#[test]
fn lost_inbound_only_changes_conversation() {
    let mut j = journey(JourneyStatus::Lost);
    j.closed_at = Some(now() - Duration::hours(1));
    j.lost_reason = Some(LostReason {
        reason_key: "diger".into(),
        reason_label: "Other".into(),
    });
    j.unreachable_attempts = 4;
    let transition = apply(&j, JourneyEventKind::MessageReceived);
    assert_eq!(transition.to(), JourneyStatus::Lost);
    assert_eq!(transition.patch().closed_at, j.closed_at);
    assert_eq!(transition.patch().lost_reason, j.lost_reason);
    assert_eq!(transition.patch().unreachable_attempts, 4);
    assert_eq!(transition.effects(), [JourneyEffect::ConversationOurs]);
    assert!(matches!(
        reduce(
            &j,
            &event(&j, JourneyEventKind::QuoteAccepted),
            &ReducePolicy::default()
        ),
        Err(ReduceError::Terminal)
    ));
}

#[test]
fn won_is_terminal_even_for_reopen() {
    let mut j = journey(JourneyStatus::Won);
    j.reduce_input = ReduceInput::new([], true).unwrap();
    for kind in [
        JourneyEventKind::Reopened,
        JourneyEventKind::MessageReceived,
        JourneyEventKind::Won {
            product: "service".into(),
            amount_minor: 500,
            currency: "TRY".into(),
        },
    ] {
        let mut e = event(&j, kind);
        e.source = EventSource::Human(UserId::new_v7());
        assert_eq!(
            reduce(&j, &e, &ReducePolicy::default()),
            Err(ReduceError::Terminal)
        );
    }
    let transition = apply(
        &j,
        JourneyEventKind::Merged {
            target: PersonId::new_v7(),
        },
    );
    assert_eq!(transition.to(), JourneyStatus::Won);
    assert!(transition.effects().is_empty());
}

#[test]
fn system_replied_on_won_or_lost_is_noop() {
    for status in [JourneyStatus::Won, JourneyStatus::Lost] {
        let mut j = journey(status);
        j.closed_at = Some(now() - Duration::hours(1));
        j.unreachable_attempts = 5;
        j.lost_reason = Some(LostReason {
            reason_key: "fiyat".into(),
            reason_label: "Price".into(),
        });
        let transition = apply(&j, JourneyEventKind::Replied);
        assert_eq!(transition.from(), status);
        assert_eq!(transition.to(), status);
        assert_eq!(
            transition.patch(),
            &JourneyPatch {
                status,
                unreachable_attempts: 5,
                closed_at: j.closed_at,
                lost_reason: j.lost_reason.clone(),
                updated_at: j.updated_at,
            }
        );
        assert!(transition.effects().is_empty());
        for source in [EventSource::Agent, EventSource::Human(UserId::new_v7())] {
            let mut e = event(&j, JourneyEventKind::Replied);
            e.source = source;
            assert_eq!(
                reduce(&j, &e, &ReducePolicy::default()),
                Err(ReduceError::Terminal)
            );
        }
    }
}

#[test]
fn lower_rank_events_keep_status_apply_effects() {
    let j = journey(JourneyStatus::Pending);
    for kind in [
        JourneyEventKind::Replied,
        JourneyEventKind::AppointmentBooked,
        JourneyEventKind::MeetingHeld,
        JourneyEventKind::QuoteSent,
    ] {
        let transition = apply(&j, kind.clone());
        assert_eq!(transition.to(), JourneyStatus::Pending);
        if kind == JourneyEventKind::Replied {
            assert_eq!(transition.effects(), [JourneyEffect::ConversationTheirs]);
        } else {
            assert!(transition.effects().is_empty());
        }
    }
}

#[test]
fn duplicate_precedes_validation_terminal_and_effects() {
    let mut j = journey(JourneyStatus::Won);
    let mut e = event(&j, JourneyEventKind::Reopened);
    j.reduce_input = ReduceInput::new([e.idempotency_key.clone()], false).unwrap();
    assert_eq!(
        reduce(&j, &e, &ReducePolicy::default()),
        Err(ReduceError::Duplicate)
    );
    e.idempotency_key.clear();
    j.reduce_input = ReduceInput::new([String::new()], false).unwrap();
    assert_eq!(
        reduce(&j, &e, &ReducePolicy::default()),
        Err(ReduceError::Duplicate)
    );
    j.reduce_input = ReduceInput::default();
    assert!(matches!(
        reduce(&j, &e, &ReducePolicy::default()),
        Err(ReduceError::NotAllowed(_))
    ));
}

#[test]
fn invalid_events_cannot_produce_transitions() {
    let j = journey(JourneyStatus::New);
    for key in ["", " \t"] {
        let mut e = event(&j, JourneyEventKind::Replied);
        e.idempotency_key = key.into();
        assert!(matches!(
            reduce(&j, &e, &ReducePolicy::default()),
            Err(ReduceError::NotAllowed(_))
        ));
    }
    for (key, label) in [("", Some("Label")), ("fiyat", None), ("fiyat", Some("  "))] {
        let mut e = event(
            &j,
            JourneyEventKind::Lost {
                reason_key: key.into(),
            },
        );
        e.reason_label = label.map(str::to_owned);
        assert!(matches!(
            reduce(&j, &e, &ReducePolicy::default()),
            Err(ReduceError::NotAllowed(_))
        ));
    }
    assert!(ReduceInput::new((0..65).map(|i| i.to_string()), false).is_err());
}
