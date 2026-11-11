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

fn suppression(person_id: PersonId, channel: Channel, reason: SuppressionReason) -> Suppression {
    Suppression {
        person_id,
        channel,
        reason,
    }
}

/// Spec §3.12, D17: consent explicit/implied/withdrawn/none × suppression on/off × recipient kind
/// × channel in or out of the business channels.
#[test]
fn commercial_basis_matrix() {
    let person = PersonId::new_v7();
    let kinds = [
        Some(ConsentKind::Explicit),
        Some(ConsentKind::ImpliedByContract),
        Some(ConsentKind::Withdrawn),
        None,
    ];
    for kind in kinds {
        for suppressed in [false, true] {
            for recipient in RecipientKind::ALL {
                for b2b in [vec![], vec![Channel::Email], vec![Channel::Sms]] {
                    let consents: Vec<Consent> = kind
                        .map(|k| consent(person, Channel::Email, k, 1))
                        .into_iter()
                        .collect();
                    let suppressions: Vec<Suppression> = if suppressed {
                        vec![suppression(
                            person,
                            Channel::Email,
                            SuppressionReason::Unsubscribe,
                        )]
                    } else {
                        vec![]
                    };
                    let expected = if suppressed {
                        Err(IzinYok)
                    } else {
                        match kind {
                            Some(ConsentKind::Explicit | ConsentKind::ImpliedByContract) => {
                                Ok(CommercialBasis::Consent)
                            }
                            Some(ConsentKind::Withdrawn) => Err(IzinYok),
                            None if *recipient == RecipientKind::Business
                                && b2b.contains(&Channel::Email) =>
                            {
                                Ok(CommercialBasis::BusinessRecipient)
                            }
                            None => Err(IzinYok),
                        }
                    };
                    assert_eq!(
                        commercial_basis(
                            &consents,
                            &suppressions,
                            Channel::Email,
                            *recipient,
                            &b2b
                        ),
                        expected,
                        "{kind:?} suppressed={suppressed} {recipient:?} {b2b:?}"
                    );
                }
            }
        }
    }
    // A suppression on another channel does not refuse; another person's rows fail closed.
    let other = PersonId::new_v7();
    let sms_off = [suppression(person, Channel::Sms, SuppressionReason::Manual)];
    assert_eq!(
        commercial_basis(
            &[],
            &sms_off,
            Channel::Email,
            RecipientKind::Business,
            &[Channel::Email]
        ),
        Ok(CommercialBasis::BusinessRecipient)
    );
    let mixed = [
        suppression(person, Channel::Sms, SuppressionReason::Manual),
        suppression(other, Channel::Sms, SuppressionReason::Manual),
    ];
    assert_eq!(
        commercial_basis(
            &[],
            &mixed,
            Channel::Email,
            RecipientKind::Business,
            &[Channel::Email]
        ),
        Err(IzinYok)
    );
    assert_eq!(
        commercial_basis(
            &[consent(other, Channel::Email, ConsentKind::Explicit, 1)],
            &[suppression(person, Channel::Sms, SuppressionReason::Manual)],
            Channel::Email,
            RecipientKind::Business,
            &[Channel::Email]
        ),
        Err(IzinYok)
    );
    assert_eq!(CommercialBasis::Consent.key(), "consent");
    assert_eq!(
        CommercialBasis::BusinessRecipient.key(),
        "business_recipient"
    );
    assert_eq!(
        serde_json::to_value(CommercialBasis::BusinessRecipient).unwrap(),
        serde_json::json!("business_recipient")
    );
}

#[test]
fn withdrawal_beats_business_basis() {
    let person = PersonId::new_v7();
    let b2b = [Channel::Email];
    let history = [
        consent(person, Channel::Email, ConsentKind::Explicit, 1),
        consent(person, Channel::Email, ConsentKind::Withdrawn, 2),
    ];
    assert_eq!(
        commercial_basis(&history, &[], Channel::Email, RecipientKind::Business, &b2b),
        Err(IzinYok)
    );
    // An İYS refusal is cached as a withdrawal.
    let mut ret = consent(person, Channel::Email, ConsentKind::Withdrawn, 3);
    ret.source = ConsentSource::IysSync;
    assert_eq!(
        commercial_basis(&[ret], &[], Channel::Email, RecipientKind::Business, &b2b),
        Err(IzinYok)
    );
    for reason in [
        SuppressionReason::Unsubscribe,
        SuppressionReason::Bounce,
        SuppressionReason::Complaint,
        SuppressionReason::Manual,
    ] {
        assert_eq!(
            commercial_basis(
                &[consent(person, Channel::Email, ConsentKind::Explicit, 1)],
                &[suppression(person, Channel::Email, reason)],
                Channel::Email,
                RecipientKind::Business,
                &b2b
            ),
            Err(IzinYok),
            "{reason:?}"
        );
    }
}

/// `commercial_allowed` keeps its meaning: `commercial_basis` for an unknown recipient without
/// business channels (the earlier tests of this file still pass unchanged).
#[test]
fn commercial_allowed_unchanged() {
    let person = PersonId::new_v7();
    let other = PersonId::new_v7();
    let histories: Vec<Vec<Consent>> = vec![
        vec![],
        vec![consent(person, Channel::Sms, ConsentKind::Explicit, 1)],
        vec![consent(
            person,
            Channel::Sms,
            ConsentKind::ImpliedByContract,
            1,
        )],
        vec![
            consent(person, Channel::Sms, ConsentKind::Explicit, 1),
            consent(person, Channel::Sms, ConsentKind::Withdrawn, 2),
        ],
        vec![
            consent(person, Channel::Sms, ConsentKind::Explicit, 1),
            consent(other, Channel::Sms, ConsentKind::Explicit, 1),
        ],
    ];
    let suppressions: Vec<Vec<Suppression>> = vec![
        vec![],
        vec![suppression(person, Channel::Sms, SuppressionReason::Bounce)],
        vec![suppression(
            person,
            Channel::Email,
            SuppressionReason::Bounce,
        )],
        vec![suppression(
            other,
            Channel::Email,
            SuppressionReason::Bounce,
        )],
    ];
    for h in &histories {
        for s in &suppressions {
            for channel in [Channel::Sms, Channel::Email] {
                let allowed = commercial_allowed(h, s, channel);
                assert_eq!(
                    allowed,
                    commercial_basis(h, s, channel, RecipientKind::Unknown, &[]).map(|_| ())
                );
                // Without business channels a business recipient needs consent like anyone.
                assert_eq!(
                    allowed,
                    commercial_basis(h, s, channel, RecipientKind::Business, &[]).map(|_| ())
                );
            }
        }
    }
}
