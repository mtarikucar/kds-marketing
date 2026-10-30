//! Provenance (spec §3.1, D4): every contact field has evidence, the recorder comes from the
//! actor, never from input, and the input is bounded.

mod support;

use jt_prospects::*;
use serde_json::json;
use support::*;
use time::Duration;

fn invalid(input: &CreateInput, recorder: &Recorder) -> (&'static str, &'static str) {
    match validate_create(input, NOW, recorder) {
        Err(ProspectError::Invalid { field, reason }) => (field, reason),
        Ok(()) => panic!("accepted"),
    }
}

#[test]
fn agent_fields_need_a_url_source() {
    let mut i = input();
    i.email = Some(FieldInput {
        sources: vec![],
        ..field("bilgi@ornek-kafe.example.invalid".to_owned())
    });
    assert_eq!(invalid(&i, &agent()), ("email", "source_required"));

    let mut i = input();
    i.phone = Some(FieldInput {
        sources: vec![url("https://ornek.example.invalid/a"); 6],
        ..field("0500 000 00 00".to_owned())
    });
    assert_eq!(invalid(&i, &agent()), ("phone", "too_many_sources"));

    let mut i = input();
    i.phone = Some(FieldInput {
        sources: vec![url("javascript:alert(1)")],
        ..field("0500 000 00 00".to_owned())
    });
    assert_eq!(invalid(&i, &agent()), ("phone", "source_not_http"));

    // The recorder is the actor's: an agent's field keeps the connection that recorded it.
    let p = prospect(input());
    let phone = p.contact.phone.unwrap();
    assert_eq!(phone.evidence.recorder, agent());
    assert_eq!(
        phone.evidence.sources,
        vec![SourceRef::Url {
            url: "https://ornek-kafe.example.invalid/iletisim".into(),
            note: None
        }]
    );
    assert_eq!(phone.evidence.captured_at, NOW - Duration::days(1));
    assert_eq!(p.origin.recorder, agent());
    assert_eq!(p.origin.via, OriginVia::Agent);
}

#[test]
fn manual_sources_are_for_humans_only() {
    let manual = SourceRefInput::Manual {
        note: "business card at a fair".into(),
    };
    let mut i = input();
    i.phone = Some(FieldInput {
        sources: vec![manual.clone()],
        ..field("0500 000 00 00".to_owned())
    });
    assert_eq!(
        invalid(&i, &agent()),
        ("phone", "manual_source_is_for_humans")
    );
    assert_eq!(validate_create(&i, NOW, &human()), Ok(()));
    let p = build(i, pid(2), ws(), NOW, human());
    assert_eq!(p.origin.via, OriginVia::Manual);
    assert_eq!(
        p.contact.phone.unwrap().evidence.recorder,
        human(),
        "a human's field records the user"
    );

    let mut i = input();
    i.phone = Some(FieldInput {
        sources: vec![SourceRefInput::Manual { note: " ".into() }],
        ..field("0500 000 00 00".to_owned())
    });
    assert_eq!(invalid(&i, &human()), ("phone", "manual_note_length"));
    // Humans too must give some source.
    let mut i = input();
    i.phone = Some(FieldInput {
        sources: vec![],
        ..field("0500 000 00 00".to_owned())
    });
    assert_eq!(invalid(&i, &human()), ("phone", "source_required"));
}

#[test]
fn captured_at_window() {
    for (at, ok) in [
        (NOW - Duration::days(365), true),
        (NOW - Duration::days(365) - Duration::seconds(1), false),
        (NOW + Duration::minutes(5), true),
        (NOW + Duration::minutes(5) + Duration::seconds(1), false),
    ] {
        let mut i = input();
        i.phone = Some(FieldInput {
            captured_at: at,
            ..field("0500 000 00 00".to_owned())
        });
        if ok {
            assert_eq!(validate_create(&i, NOW, &agent()), Ok(()), "{at}");
        } else {
            assert_eq!(
                invalid(&i, &agent()),
                ("phone", "captured_at_out_of_window"),
                "{at}"
            );
        }
    }
}

#[test]
fn recorder_is_never_read_from_input() {
    let body = json!({
        "business_name": "Örnek Kafe",
        "entity_kind": "legal_entity",
        "recorder": {"kind": "human", "user_id": "00000000-0000-0000-0000-000000000009"},
    });
    assert!(serde_json::from_value::<CreateInput>(body).is_err());
    let field_level = json!({
        "business_name": "Örnek Kafe",
        "entity_kind": "legal_entity",
        "phone": {
            "value": "0500 000 00 00",
            "sources": [{"kind": "url", "url": "https://ornek.example.invalid"}],
            "captured_at": "2026-10-29T12:00:00Z",
            "recorder": {"kind": "human", "user_id": "00000000-0000-0000-0000-000000000009"},
        },
    });
    assert!(serde_json::from_value::<CreateInput>(field_level).is_err());
    let import_source = json!({
        "business_name": "Örnek Kafe",
        "entity_kind": "legal_entity",
        "phone": {
            "value": "0500 000 00 00",
            "sources": [{"kind": "import", "system": "v1", "record": "1"}],
            "captured_at": "2026-10-29T12:00:00Z",
        },
    });
    assert!(
        serde_json::from_value::<CreateInput>(import_source).is_err(),
        "an import source is the importer's, never input"
    );
    let ok = json!({
        "business_name": "Örnek Kafe",
        "entity_kind": "sole_trader",
        "phone": {
            "value": "0500 000 00 00",
            "sources": [{"kind": "url", "url": "https://ornek.example.invalid"}],
            "captured_at": "2026-10-29T12:00:00Z",
        },
    });
    let parsed: CreateInput = serde_json::from_value(ok).expect("a valid body");
    assert_eq!(parsed.entity_kind, EntityKind::SoleTrader);
    let update = json!({"expected_revision": 1, "set": {"notes": "x"}, "recorder": {}});
    assert!(serde_json::from_value::<UpdateInput>(update).is_err());
}

#[test]
fn website_must_be_http_or_https() {
    for bad in [
        "ftp://ornek.example.invalid",
        "ornek.example.invalid",
        "mailto:a@b.invalid",
    ] {
        let mut i = input();
        i.website = Some(field(bad.to_owned()));
        assert_eq!(invalid(&i, &agent()), ("website", "not_http"), "{bad}");
    }
    let mut i = input();
    i.website = Some(field(format!(
        "https://ornek.example.invalid/{}",
        "a".repeat(2048)
    )));
    assert_eq!(invalid(&i, &agent()), ("website", "too_long"));
}

#[test]
fn website_on_platform_host_is_refused() {
    let mut i = input();
    i.website = Some(field("https://www.instagram.com/ornekkafe".to_owned()));
    assert_eq!(
        invalid(&i, &agent()),
        ("website", "website_is_a_platform_profile")
    );
}

/// A change to a valid input and the refusal it must meet.
type Case = (Box<dyn Fn(&mut CreateInput)>, (&'static str, &'static str));

#[test]
fn labels_signals_and_lengths_are_bounded() {
    let cases: Vec<Case> = vec![
        (
            Box::new(|i| i.business_name = "  ".into()),
            ("business_name", "length"),
        ),
        (
            Box::new(|i| i.business_name = "a".repeat(201)),
            ("business_name", "length"),
        ),
        (
            Box::new(|i| i.sector = Some("a".repeat(81))),
            ("sector", "length"),
        ),
        (
            Box::new(|i| i.city = Some(String::new())),
            ("city", "length"),
        ),
        (
            Box::new(|i| i.language = Some("türkçe".into())),
            ("language", "invalid"),
        ),
        (
            Box::new(|i| i.segment_key = Some("Kafe Ler".into())),
            ("segment_key", "invalid"),
        ),
        (
            Box::new(|i| i.country = Some("TUR".into())),
            ("country", "invalid"),
        ),
        (
            Box::new(|i| i.labels = vec!["x".into(); 21]),
            ("labels", "too_many"),
        ),
        (
            Box::new(|i| i.labels = vec!["a".repeat(41)]),
            ("labels", "length"),
        ),
        (
            Box::new(|i| i.notes = "a".repeat(2001)),
            ("notes", "too_long"),
        ),
        (
            Box::new(|i| {
                i.signals = vec![
                    SignalInput {
                        text: "x".into(),
                        source: url("https://ornek.example.invalid")
                    };
                    21
                ]
            }),
            ("signals", "too_many"),
        ),
        (
            Box::new(|i| {
                i.signals = vec![SignalInput {
                    text: "a".repeat(201),
                    source: url("https://ornek.example.invalid"),
                }]
            }),
            ("signals", "length"),
        ),
        (
            Box::new(|i| i.discovered_at = vec![url("https://ornek.example.invalid"); 6]),
            ("discovered_at", "too_many_sources"),
        ),
        (
            Box::new(|i| i.address = Some(field("a".repeat(301)))),
            ("address", "too_long"),
        ),
        (
            Box::new(|i| {
                i.contact_person = Some(field(ContactPerson {
                    name: "a".repeat(121),
                    role: "Kurucu".into(),
                }))
            }),
            ("contact_person", "name_length"),
        ),
        (
            Box::new(|i| {
                i.size = Some(field(SizeHint {
                    branches: None,
                    employees: None,
                    note: Some("a".repeat(121)),
                }))
            }),
            ("size", "note_too_long"),
        ),
        (
            Box::new(|i| i.phone = Some(field("12".into()))),
            ("phone", "invalid"),
        ),
        (
            Box::new(|i| i.email = Some(field("not-an-email".into()))),
            ("email", "invalid"),
        ),
        (
            Box::new(|i| i.instagram = Some(field("a b".into()))),
            ("instagram", "invalid"),
        ),
        (
            Box::new(|i| i.request_key = Some("a".repeat(129))),
            ("request_key", "length"),
        ),
    ];
    for (change, expected) in cases {
        let mut i = input();
        change(&mut i);
        assert_eq!(invalid(&i, &agent()), expected);
    }
    // At the bounds, accepted.
    let mut i = input();
    i.business_name = "a".repeat(200);
    i.labels = vec!["a".repeat(40); 20];
    i.notes = "a".repeat(2000);
    assert_eq!(validate_create(&i, NOW, &agent()), Ok(()));
}

#[test]
fn deliverable_defaults_to_true_on_read() {
    let stored = json!({
        "value": "+905000000000",
        "evidence": {
            "sources": [{"kind": "url", "url": "https://ornek.example.invalid"}],
            "captured_at": "2026-10-29T12:00:00Z",
            "recorder": {"kind": "human", "user_id": "00000000-0000-0000-0000-000000000003"},
        },
    });
    let f: Field<String> = serde_json::from_value(stored).expect("a stored field");
    assert!(f.deliverable);
    let p = prospect(input());
    assert!(p.contact.phone.unwrap().deliverable);
    assert_eq!(
        serde_json::to_value(EmployeeBand::B250Plus).unwrap(),
        json!("250+")
    );
    assert_eq!(
        serde_json::to_value(EmployeeBand::B1To9).unwrap(),
        json!("1-9")
    );
}

#[test]
fn build_trims_and_records_the_origin() {
    let mut i = input();
    i.business_name = "  Örnek Kafe  ".into();
    i.labels = vec![" sicak ".into(), "sicak".into()];
    i.country = Some("tr".into());
    i.research_task_id = Some(ResearchTaskId(uuid::Uuid::from_u128(7)));
    i.distinct_from = vec![pid(9)];
    i.discovered_at = vec![url("https://directory.example.invalid/ornek")];
    let p = prospect(i);
    assert_eq!(p.business_name, "Örnek Kafe");
    assert_eq!(p.labels, ["sicak"]);
    assert_eq!(p.country, "TR");
    assert_eq!(p.status, ProspectStatus::New);
    assert_eq!(p.revision, 1);
    assert_eq!((p.created_at, p.updated_at), (NOW, NOW));
    assert_eq!(p.origin.via, OriginVia::ResearchTask);
    assert_eq!(p.origin.distinct_from, [pid(9)]);
    assert_eq!(p.origin.discovered_at.len(), 1);
    assert_eq!(p.origin.at, NOW);
    assert_eq!(build(input(), pid(1), ws(), NOW, agent()).country, "TR");
}

#[test]
fn update_sets_clears_and_bumps_the_revision() {
    let mut i = input();
    i.email = Some(field("bilgi@ornek-kafe.example.invalid".into()));
    let mut p = prospect(i);
    let later = NOW + Duration::hours(1);
    let update = UpdateInput {
        expected_revision: 1,
        set: SetFields {
            notes: Some("a corner cafe".into()),
            website: Some(field("https://ornek-kafe.example.invalid".into())),
            ..SetFields::default()
        },
        clear: vec![FieldName::Email, FieldName::District],
        distinct_from: vec![pid(5)],
    };
    let changed = apply_update(&mut p, update, later, human()).expect("valid");
    assert_eq!(
        changed,
        [
            FieldName::District,
            FieldName::Email,
            FieldName::Website,
            FieldName::Notes
        ]
    );
    assert_eq!(p.contact.email, None);
    assert_eq!(p.district, None);
    assert_eq!(p.notes, "a corner cafe");
    assert_eq!(
        p.contact.website.as_ref().unwrap().evidence.recorder,
        human()
    );
    assert_eq!(
        p.contact.phone.as_ref().unwrap().evidence.recorder,
        agent(),
        "untouched"
    );
    assert_eq!(p.revision, 2);
    assert_eq!(p.updated_at, later);
    assert_eq!(p.origin.distinct_from, [pid(5)]);

    let both = UpdateInput {
        expected_revision: 2,
        set: SetFields {
            notes: Some("x".into()),
            ..SetFields::default()
        },
        clear: vec![FieldName::Notes],
        distinct_from: vec![],
    };
    assert_eq!(
        apply_update(&mut p, both, later, human()),
        Err(ProspectError::Invalid {
            field: "clear",
            reason: "set_and_cleared"
        })
    );
    let empty = UpdateInput {
        expected_revision: 2,
        set: SetFields::default(),
        clear: vec![],
        distinct_from: vec![],
    };
    assert_eq!(
        apply_update(&mut p, empty, later, human()),
        Err(ProspectError::Invalid {
            field: "set",
            reason: "nothing_to_update"
        })
    );
    let manual_by_agent = UpdateInput {
        expected_revision: 2,
        set: SetFields {
            phone: Some(FieldInput {
                sources: vec![SourceRefInput::Manual { note: "x".into() }],
                ..field("0500 000 00 00".into())
            }),
            ..SetFields::default()
        },
        clear: vec![],
        distinct_from: vec![],
    };
    assert_eq!(
        apply_update(&mut p, manual_by_agent, later, agent()),
        Err(ProspectError::Invalid {
            field: "phone",
            reason: "manual_source_is_for_humans"
        })
    );
    assert_eq!(p.revision, 2, "a refused update changes nothing");
}
