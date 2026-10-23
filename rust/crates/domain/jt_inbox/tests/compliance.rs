use jt_inbox::*;
use time::{Duration, OffsetDateTime, macros::datetime};

fn consent(person_id: PersonId, channel: Channel, kind: ConsentKind, minutes: i64) -> Consent {
    Consent {
        id: ConsentId::new_v7(),
        person_id,
        channel,
        kind,
        source: ConsentSource::Customer,
        at: OffsetDateTime::UNIX_EPOCH + Duration::minutes(minutes),
        sync_state: SyncState::Pending,
        attempts: 0,
    }
}

#[test]
fn older_grant_cannot_override_withdrawal() {
    let person = PersonId::new_v7();
    let grant = consent(person, Channel::Sms, ConsentKind::Explicit, 1);
    let withdrawal = consent(person, Channel::Sms, ConsentKind::Withdrawn, 2);
    for history in [
        vec![grant.clone(), withdrawal.clone()],
        vec![withdrawal.clone(), grant.clone()],
    ] {
        assert_eq!(
            commercial_allowed(&history, &[], Channel::Sms),
            Err(IzinYok)
        );
        assert_eq!(
            effective_consent(&history, person, Channel::Sms),
            Some(&withdrawal)
        );
    }
    let later = consent(person, Channel::Sms, ConsentKind::ImpliedByContract, 3);
    assert_eq!(
        commercial_allowed(&[withdrawal, grant, later], &[], Channel::Sms),
        Ok(())
    );
}

#[test]
fn equal_at_withdrawn_wins_in_either_order() {
    let person = PersonId::new_v7();
    for kind in [ConsentKind::Explicit, ConsentKind::ImpliedByContract] {
        let grant = consent(person, Channel::Sms, kind, 5);
        let withdrawal = consent(person, Channel::Sms, ConsentKind::Withdrawn, 5);
        for history in [
            vec![grant.clone(), withdrawal.clone()],
            vec![withdrawal.clone(), grant],
        ] {
            assert_eq!(
                commercial_allowed(&history, &[], Channel::Sms),
                Err(IzinYok)
            );
            assert_eq!(
                effective_consent(&history, person, Channel::Sms),
                Some(&withdrawal)
            );
        }
    }
}

#[test]
fn consent_is_scoped_to_person_and_contact_channel() {
    let person = PersonId::new_v7();
    let other = PersonId::new_v7();
    let sms = consent(person, Channel::Sms, ConsentKind::Explicit, 1);
    let history = [
        sms.clone(),
        consent(person, Channel::Phone, ConsentKind::Withdrawn, 2),
        consent(other, Channel::Sms, ConsentKind::Withdrawn, 3),
    ];
    assert_eq!(
        effective_consent(&history, person, Channel::Sms),
        Some(&sms)
    );
    assert_eq!(effective_consent(&history, other, Channel::Email), None);
    assert_eq!(
        commercial_allowed(&[sms], &[], Channel::Phone),
        Err(IzinYok)
    );
    // The commercial helper requires a single person's history and fails closed on mixed input.
    assert_eq!(
        commercial_allowed(&history, &[], Channel::Sms),
        Err(IzinYok)
    );
}

fn fence(intent: SendIntent, consent_ok: bool, suppressed: bool) -> FenceCtx {
    FenceCtx {
        journey_status: Some(JourneyStatus::Contacted),
        person_erased: false,
        person_merged: false,
        conversation_state: ConvState::Ours,
        expected_generation: 1,
        current_generation: 1,
        executor_is_agent: true,
        capability_live: true,
        intent,
        consent_ok,
        suppressed,
    }
}

#[test]
fn commercial_requires_consent_without_suppression() {
    let person = PersonId::new_v7();
    assert_eq!(commercial_allowed(&[], &[], Channel::Sms), Err(IzinYok));
    assert_eq!(IzinYok.to_string(), "IZIN_YOK");
    for kind in [ConsentKind::Explicit, ConsentKind::ImpliedByContract] {
        let grants = [consent(person, Channel::Sms, kind, 1)];
        assert_eq!(commercial_allowed(&grants, &[], Channel::Sms), Ok(()));
        for reason in [
            SuppressionReason::Unsubscribe,
            SuppressionReason::Bounce,
            SuppressionReason::Complaint,
            SuppressionReason::Manual,
        ] {
            let mut suppression = Suppression {
                person_id: person,
                channel: Channel::Sms,
                reason,
            };
            assert_eq!(
                commercial_allowed(&grants, &[suppression.clone()], Channel::Sms),
                Err(IzinYok)
            );
            suppression.channel = Channel::Email;
            assert_eq!(
                commercial_allowed(&grants, &[suppression], Channel::Sms),
                Ok(())
            );
        }
    }
    for by_agent in [false, true] {
        for consent_ok in [false, true] {
            for suppressed in [false, true] {
                let expected = if suppressed {
                    Err(FenceRefusal::Suppressed)
                } else if !consent_ok {
                    Err(FenceRefusal::IzinYok)
                } else {
                    Ok(())
                };
                assert_eq!(
                    may_send(
                        &fence(SendIntent::Commercial, consent_ok, suppressed),
                        by_agent
                    ),
                    expected
                );
                assert_eq!(
                    may_send(&fence(SendIntent::Reply, consent_ok, suppressed), by_agent),
                    Ok(())
                );
            }
        }
    }
}

#[test]
fn commission_rounds_half_even() {
    for (amount, rate, expected) in [
        (1, 5000, 0),
        (3, 5000, 2),
        (5, 5000, 2),
        (7, 5000, 4),
        (-1, 5000, 0),
        (-3, 5000, -2),
        (-5, 5000, -2),
        (-7, 5000, -4),
        (1, 4999, 0),
        (1, 5001, 1),
        (-1, 4999, 0),
        (-1, 5001, -1),
        (12345, 250, 309),
        (0, 10000, 0),
        (12345, 0, 0),
        (i64::MAX, 10000, i64::MAX),
        (i64::MIN, 10000, i64::MIN),
    ] {
        assert_eq!(
            commission_for(amount, rate),
            expected,
            "amount={amount}, rate={rate}"
        );
    }
}

fn appointment() -> Appointment {
    Appointment {
        journey_id: JourneyId::new_v7(),
        starts_at: datetime!(2026-10-23 13:04:05 +03:00),
        ends_at: datetime!(2026-10-23 14:04:05 +03:00),
        location: "Room\\A; floor, 2\r\nİstanbul\nOffice\rDesk".into(),
        state: AppointmentState::Booked,
    }
}

#[test]
fn ics_crlf_utc_escaping() {
    let mut appt = appointment();
    assert_eq!(appt.validate(), Ok(()));
    let calendar = ics(
        &appt,
        "host@example.com",
        "guest@example.com",
        "meeting@example.com",
    );
    assert!(calendar.starts_with("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
    assert!(calendar.ends_with("END:VEVENT\r\nEND:VCALENDAR\r\n"));
    assert!(calendar.contains("DTSTART:20261023T100405Z\r\n"));
    assert!(calendar.contains("DTEND:20261023T110405Z\r\n"));
    assert!(calendar.contains("DTSTAMP:"));
    assert!(calendar.contains("UID:meeting@example.com\r\n"));
    assert!(calendar.contains("ORGANIZER:mailto:host@example.com\r\n"));
    assert!(calendar.contains("ATTENDEE:mailto:guest@example.com\r\n"));
    assert!(calendar.contains("LOCATION:Room\\\\A\\; floor\\, 2\\nİstanbul\\nOffice\\nDesk\r\n"));
    assert!(!calendar.replace("\r\n", "").contains(['\r', '\n']));
    appt.location = format!("{}{}", "a".repeat(65), "ş😀".repeat(45));
    let folded = ics(
        &appt,
        "host@example.com",
        "guest@example.com",
        "meeting@example.com",
    );
    assert!(folded.contains("\r\n "));
    assert!(folded.split("\r\n").all(|line| line.len() <= 75));
    assert!(
        folded
            .replace("\r\n ", "")
            .contains(&format!("LOCATION:{}\r\n", appt.location))
    );
}

#[test]
fn appointment_requires_positive_duration() {
    let mut appt = appointment();
    appt.ends_at = appt.starts_at;
    assert_eq!(appt.validate(), Err(AppointmentError::InvalidInterval));
    appt.ends_at -= Duration::seconds(1);
    assert_eq!(appt.validate(), Err(AppointmentError::InvalidInterval));
}

#[test]
fn quote_currency_validated() {
    let mut quote = Quote {
        journey_id: JourneyId::new_v7(),
        amount_minor: 12500,
        currency: "TRY".into(),
        valid_until: datetime!(2026-11-01 0:00 UTC),
        file_ref: None,
        channel: Channel::Email,
        state: QuoteState::Sent,
    };
    for currency in ["TRY", "USD", "EUR", "JPY", "XAF", "XCG", "ZWG"] {
        quote.currency = currency.into();
        assert_eq!(quote.validate(), Ok(()));
    }
    for currency in ["", "try", "US", "USDT", "123", "ZZZ", " TR", "TL "] {
        quote.currency = currency.into();
        assert_eq!(quote.validate(), Err(QuoteError::InvalidCurrency));
    }
}

#[test]
fn identity_hash_uses_account_scope() {
    let a = scope_opaque("account-a", "person-42");
    let b = scope_opaque("account-b", "person-42");
    let hash = identity_hash(IdentityChannel::InstagramDm, &a);
    assert_eq!(hash.len(), 64);
    assert!(
        hash.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(hash, identity_hash(IdentityChannel::InstagramDm, &a));
    assert_ne!(hash, identity_hash(IdentityChannel::InstagramDm, &b));
    assert_ne!(hash, identity_hash(IdentityChannel::Messenger, &a));
    assert_ne!(
        hash,
        identity_hash(IdentityChannel::InstagramDm, "person-42")
    );
    // Fixed SHA-256 fixture of the documented namespace + NUL + scoped identity encoding.
    assert_eq!(
        hash,
        "cf376a8e6451ff61348f4b81e94ff487eebb08cbff74a1edc7f876adaab3bdac"
    );
}

#[test]
fn sms_segments_ascii_160_161() {
    for (count, expected) in [(0, 0), (1, 1), (160, 1), (161, 2), (306, 2), (307, 3)] {
        assert_eq!(sms_segments(&"a".repeat(count)), expected);
    }
}

#[test]
fn sms_segments_turkish_70_71() {
    for c in ['ş', 'ğ'] {
        for (count, expected) in [(70, 1), (71, 2), (134, 2), (135, 3)] {
            assert_eq!(sms_segments(&c.to_string().repeat(count)), expected);
        }
    }
    assert_eq!(sms_segments(&format!("{}ş", "a".repeat(70))), 2);
}

#[test]
fn sms_segments_extension_and_surrogate_units() {
    for c in ['^', '{', '}', '\\', '[', '~', ']', '|', '€', '\u{000c}'] {
        assert_eq!(sms_segments(&c.to_string().repeat(80)), 1);
        assert_eq!(sms_segments(&c.to_string().repeat(81)), 2);
        assert_eq!(sms_segments(&c.to_string().repeat(154)), 3);
    }
    for c in [
        '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å', 'Δ', '_',
        'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', 'Æ', 'æ', 'ß', 'É', '¤', '¡', 'Ä', 'Ö', 'Ñ',
        'Ü', '§', '¿', 'ä', 'ö', 'ñ', 'ü', 'à',
    ] {
        assert_eq!(sms_segments(&c.to_string().repeat(160)), 1, "{c:?}");
    }
    assert_eq!(sms_segments(&"😀".repeat(35)), 1);
    assert_eq!(sms_segments(&"😀".repeat(36)), 2);
    assert_eq!(sms_segments(&"😀".repeat(67)), 2);
    assert_eq!(sms_segments(&"😀".repeat(68)), 3);
    assert_eq!(sms_segments(&format!("{}😀", "^".repeat(68))), 1);
    assert_eq!(sms_segments(&format!("{}😀", "^".repeat(69))), 2);
    for c in ['`', '\t', '\u{001b}'] {
        assert_eq!(sms_segments(&c.to_string().repeat(71)), 2);
    }
}

#[test]
#[should_panic(expected = "SMS segment count exceeds u16")]
fn oversized_sms_never_wraps_segment_count() {
    sms_segments(&"a".repeat(153 * usize::from(u16::MAX) + 1));
}
