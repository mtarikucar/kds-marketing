use std::collections::BTreeSet;

use jt_ledger::Actor;
use jt_strategy::*;
use jt_tenancy::{UserId, WorkspaceId};
use serde::Serialize;
use serde_json::{Value, json};
use time::macros::datetime;

fn segment(key: &str) -> Segment {
    Segment {
        key: key.to_owned(),
        name: format!("Segment {key}"),
        description: "who they are".to_owned(),
    }
}

fn channel(kind: &str) -> ChannelChoice {
    ChannelChoice {
        channel: kind.to_owned(),
        rationale: "where they are".to_owned(),
        group_id: None,
    }
}

fn mix(kind: &str, share_pct: u8) -> Mix {
    Mix {
        channel: kind.to_owned(),
        share_pct,
    }
}

fn lane(lane: LaneKind, period: Period, cap_minor: i64, currency: &str) -> Lane {
    Lane {
        lane,
        period,
        cap_minor,
        currency: currency.to_owned(),
    }
}

/// A strategy with every section filled and consistent.
fn complete_sections() -> Sections {
    Sections {
        identity: Identity {
            product: "Coffee subscription".to_owned(),
            voice: "warm, plain".to_owned(),
            positioning: "fresh roast at the door".to_owned(),
            usp: "roasted the day it ships".to_owned(),
        },
        audience: vec![segment("young_professionals"), segment("students")],
        channels: vec![channel("instagram"), channel("mailbox")],
        goals: Goals {
            objective: "200 subscribers a month".to_owned(),
            kpis: vec![Kpi {
                name: "new subscribers".to_owned(),
                target: "200 / month".to_owned(),
            }],
        },
        budget_frame: BudgetFrame {
            lanes: vec![
                lane(LaneKind::Organic, Period::Monthly, 0, "TRY"),
                lane(LaneKind::Paid, Period::Weekly, 150_000, "TRY"),
            ],
        },
        prohibitions: vec!["no price comparisons with named rivals".to_owned()],
        cadence: Cadence {
            per_week: 5,
            channel_mix: vec![mix("instagram", 70), mix("mailbox", 30)],
        },
        paid_enabled: true,
        prospecting: Prospecting::default(),
    }
}

fn hypothesis(segment_key: &str, channel: &str, state: HypothesisState) -> Hypothesis {
    Hypothesis {
        cadence: Default::default(),
        derived_confidence: None,
        id: HypothesisId::new_v7(),
        title: format!("{segment_key} answer on {channel}"),
        segment_key: segment_key.to_owned(),
        angle: "morning ritual".to_owned(),
        channel: channel.to_owned(),
        metric: "click-through rate".to_owned(),
        prior_confidence: 0.5,
        state,
    }
}

fn known(kinds: &[&str]) -> BTreeSet<String> {
    kinds.iter().map(|k| (*k).to_owned()).collect()
}

fn fields(gaps: &[Gap]) -> Vec<&str> {
    gaps.iter().map(|g| g.field.as_str()).collect()
}

#[test]
fn validate_sections_reports_every_gap_at_once() {
    assert!(validate_sections(&complete_sections()).is_empty());

    let mut s = complete_sections();
    s.identity.product = "   ".to_owned();
    s.audience.clear();
    s.cadence.channel_mix = vec![mix("instagram", 60)];
    let gaps = validate_sections(&s);
    assert_eq!(
        fields(&gaps),
        ["identity.product", "audience", "cadence.channel_mix"]
    );
    assert!(gaps.iter().all(|g| !g.message.is_empty()), "{gaps:?}");

    // An empty strategy names every required section, not just the first.
    assert_eq!(
        fields(&validate_sections(&Sections::default())),
        ["identity.product", "audience", "channels"]
    );
}

#[test]
fn segment_keys_must_be_well_formed_and_unique() {
    let mut s = complete_sections();
    s.audience = vec![
        segment("students"),
        segment("Students"),
        segment("x"),
        segment("students"),
        segment(&"a".repeat(33)),
    ];
    assert_eq!(
        fields(&validate_sections(&s)),
        [
            "audience[1].key",
            "audience[2].key",
            "audience[3].key",
            "audience[4].key"
        ]
    );
    assert!(validate_segment_key("ab").is_ok());
    assert!(validate_segment_key(&"a".repeat(32)).is_ok());
    assert!(validate_segment_key("new_york_2").is_ok());
    for bad in ["", "a", "A_b", "a-b", "a b", "ş_x"] {
        assert_eq!(
            validate_segment_key(bad),
            Err(StrategyError::InvalidSegmentKey(bad.to_owned())),
            "{bad}"
        );
    }
}

#[test]
fn approval_requires_a_live_hypothesis_and_known_channels() {
    let s = complete_sections();
    let kinds = known(&["instagram", "mailbox", "any"]);
    let live = vec![hypothesis("students", "instagram", HypothesisState::Added)];
    assert!(validate_for_approval(&s, &live, &kinds).is_empty());

    // No hypothesis at all, or only retired ones: not approvable.
    assert_eq!(
        fields(&validate_for_approval(&s, &[], &kinds)),
        ["hypotheses"]
    );
    let retired = vec![hypothesis("gone", "fax", HypothesisState::Retired)];
    assert_eq!(
        fields(&validate_for_approval(&s, &retired, &kinds)),
        ["hypotheses"],
        "a retired hypothesis is neither counted nor checked for segment and channel"
    );

    // A channel the workspace has no capability for, in the channels section and in a
    // hypothesis; an unknown segment; an out-of-range prior_confidence. Every gap at once, plus the
    // section gaps.
    let mut s = complete_sections();
    s.identity.product.clear();
    s.channels.push(channel("tiktok"));
    let mut bad_confidence = hypothesis("students", "mailbox", HypothesisState::Kept);
    bad_confidence.prior_confidence = 1.5;
    let hyps = vec![
        hypothesis("students", "instagram", HypothesisState::Kept),
        hypothesis("retirees", "tiktok", HypothesisState::Added),
        bad_confidence,
    ];
    let gaps = validate_for_approval(&s, &hyps, &known(&["instagram", "mailbox"]));
    assert_eq!(
        fields(&gaps),
        [
            "identity.product",
            "channels[2].channel",
            "hypotheses[1].segment_key",
            "hypotheses[1].channel",
            "hypotheses[2].prior_confidence",
        ]
    );

    // `any` is accepted wherever a channel is named, even if the caller did not list it.
    let mut s = complete_sections();
    s.channels.push(channel("any"));
    let hyps = vec![hypothesis("students", "any", HypothesisState::Kept)];
    assert!(validate_for_approval(&s, &hyps, &known(&["instagram", "mailbox"])).is_empty());

    // Confidence must be a number in 0..=1; a NaN is a gap too.
    for c in [-0.1_f32, 1.01, f32::NAN] {
        let mut h = hypothesis("students", "instagram", HypothesisState::Kept);
        h.prior_confidence = c;
        assert_eq!(
            fields(&validate_for_approval(&complete_sections(), &[h], &kinds)),
            ["hypotheses[0].prior_confidence"],
            "{c}"
        );
    }

    // A hypothesis must say what it tests and how it is measured.
    let mut h = hypothesis("students", "instagram", HypothesisState::Kept);
    h.title = " ".to_owned();
    h.angle.clear();
    h.metric.clear();
    assert_eq!(
        fields(&validate_for_approval(&complete_sections(), &[h], &kinds)),
        [
            "hypotheses[0].title",
            "hypotheses[0].angle",
            "hypotheses[0].metric"
        ]
    );
}

#[test]
fn next_draft_keeps_every_hypothesis() {
    let approved = StrategyVersion {
        id: StrategyVersionId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        number: 3,
        status: VersionStatus::Approved,
        sections: complete_sections(),
        created_at: datetime!(2026-10-01 09:00 UTC),
        created_by: Actor::Human {
            user_id: UserId::new_v7(),
        },
        submitted_at: Some(datetime!(2026-10-02 09:00 UTC)),
        approved_at: Some(datetime!(2026-10-02 10:00 UTC)),
        approved_by: Some(UserId::new_v7()),
        archived_at: None,
    };
    let hyps = vec![
        hypothesis("students", "instagram", HypothesisState::Kept),
        hypothesis("students", "mailbox", HypothesisState::Retired),
        hypothesis("young_professionals", "mailbox", HypothesisState::Added),
    ];

    let (sections, draft) = next_draft_from(&approved, &hyps);
    assert_eq!(sections, approved.sections);
    // Every live hypothesis carries over with the same id, now `Kept`; one retired in the
    // approved version stays retired (it is not carried back to life).
    assert_eq!(
        draft.iter().map(|h| h.id).collect::<Vec<_>>(),
        [hyps[0].id, hyps[2].id]
    );
    assert!(draft.iter().all(|h| h.state == HypothesisState::Kept));
    assert_eq!(draft[1].title, hyps[2].title);
    assert_eq!(draft[1].prior_confidence, hyps[2].prior_confidence);
}

#[test]
fn diff_lists_changed_paths() {
    let a = complete_sections();
    assert!(diff(&a, &a).is_empty());

    let mut b = a.clone();
    b.identity.voice = "bold".to_owned();
    b.audience[1].description = "night owls".to_owned();
    b.cadence.per_week = 7;
    b.paid_enabled = false;
    b.budget_frame.lanes.pop();
    assert_eq!(
        diff(&a, &b),
        [
            "audience",
            "budget_frame.lanes",
            "cadence.per_week",
            "identity.voice",
            "paid_enabled"
        ]
    );
    assert_eq!(diff(&b, &a), diff(&a, &b));

    let c = Sections {
        goals: Goals {
            objective: "more".to_owned(),
            kpis: vec![],
        },
        prohibitions: vec![],
        ..a.clone()
    };
    assert_eq!(
        diff(&a, &c),
        ["goals.kpis", "goals.objective", "prohibitions"]
    );
}

#[test]
fn currency_and_shares_rules() {
    assert!(validate_currency("TRY").is_ok());
    assert!(validate_currency("EUR").is_ok());
    for bad in ["", "try", "TR", "TRYY", "T1Y", "ÜSD"] {
        assert_eq!(
            validate_currency(bad),
            Err(StrategyError::InvalidCurrency(bad.to_owned())),
            "{bad}"
        );
    }

    // A bad currency and a negative cap are named per lane; paid channels need a paid lane.
    let mut s = complete_sections();
    s.budget_frame.lanes = vec![lane(LaneKind::Organic, Period::Monthly, -1, "try")];
    assert_eq!(
        fields(&validate_sections(&s)),
        [
            "budget_frame.lanes[0].cap_minor",
            "budget_frame.lanes[0].currency",
            "budget_frame.lanes",
        ]
    );
    s.paid_enabled = false;
    assert_eq!(
        fields(&validate_sections(&s)),
        [
            "budget_frame.lanes[0].cap_minor",
            "budget_frame.lanes[0].currency"
        ]
    );

    // One lane per kind, so a lane's cap is never ambiguous.
    let mut s = complete_sections();
    s.budget_frame
        .lanes
        .push(lane(LaneKind::Paid, Period::Monthly, 1, "TRY"));
    assert_eq!(
        fields(&validate_sections(&s)),
        ["budget_frame.lanes[2].lane"]
    );

    // Shares: each mix channel is a chosen channel, listed once; the shares sum to 100.
    let mut s = complete_sections();
    s.cadence.channel_mix = vec![
        mix("instagram", 50),
        mix("tiktok", 30),
        mix("instagram", 20),
    ];
    assert_eq!(
        fields(&validate_sections(&s)),
        [
            "cadence.channel_mix[1].channel",
            "cadence.channel_mix[2].channel"
        ]
    );
    s.cadence.channel_mix = vec![mix("instagram", 200), mix("mailbox", 100)];
    assert_eq!(fields(&validate_sections(&s)), ["cadence.channel_mix"]);
    // No mix at all is fine (the cadence is not split yet).
    s.cadence.channel_mix.clear();
    assert!(validate_sections(&s).is_empty());

    // At most 70 posts a week, at most 100 prohibitions.
    let mut s = complete_sections();
    s.cadence.per_week = 71;
    s.prohibitions = vec!["x".to_owned(); 101];
    assert_eq!(
        fields(&validate_sections(&s)),
        ["prohibitions", "cadence.per_week"]
    );
    s.cadence.per_week = 70;
    s.prohibitions.truncate(100);
    assert!(validate_sections(&s).is_empty());
}

#[test]
fn budget_cap_is_read_per_lane() {
    let s = complete_sections();
    assert_eq!(
        budget_cap_for(&s, LaneKind::Paid),
        Some((150_000, Period::Weekly, "TRY".to_owned()))
    );
    assert_eq!(
        budget_cap_for(&s, LaneKind::Organic),
        Some((0, Period::Monthly, "TRY".to_owned()))
    );
    assert_eq!(budget_cap_for(&Sections::default(), LaneKind::Paid), None);
}

#[test]
fn consultation_text_is_capped_in_characters() {
    let version_id = StrategyVersionId::new_v7();
    let actor = Actor::Human {
        user_id: UserId::new_v7(),
    };
    let at = datetime!(2026-10-22 12:00 UTC);

    // 20 000 two-byte characters: 40 000 bytes, still within the cap.
    let entry = ConsultationEntry::new(
        version_id,
        ConsultationKind::Answer,
        Some("identity".to_owned()),
        "ş".repeat(20_000),
        actor.clone(),
        at,
    )
    .unwrap();
    assert_eq!(entry.version_id, version_id);
    assert_eq!(entry.kind, ConsultationKind::Answer);
    assert_eq!(entry.actor, actor);
    assert_eq!(entry.at, at);

    assert_eq!(
        ConsultationEntry::new(
            version_id,
            ConsultationKind::Note,
            None,
            "a".repeat(20_001),
            actor,
            at,
        ),
        Err(StrategyError::TextTooLong { len: 20_001 })
    );
}

#[test]
fn keys_round_trip() {
    for s in [
        VersionStatus::Draft,
        VersionStatus::Approved,
        VersionStatus::Archived,
    ] {
        assert_eq!(VersionStatus::parse(s.key()), Some(s));
        assert_eq!(serde_json::to_value(s).unwrap(), s.key());
    }
    for s in [
        HypothesisState::Kept,
        HypothesisState::Retired,
        HypothesisState::Added,
    ] {
        assert_eq!(HypothesisState::parse(s.key()), Some(s));
        assert_eq!(serde_json::to_value(s).unwrap(), s.key());
    }
    for k in ConsultationKind::all() {
        assert_eq!(ConsultationKind::parse(k.key()), Some(*k));
        assert_eq!(serde_json::to_value(k).unwrap(), k.key());
    }
    assert_eq!(ConsultationKind::all().len(), 8);
    assert_eq!(ConsultationKind::SectionDraft.key(), "section_draft");
    for l in [LaneKind::Organic, LaneKind::Paid] {
        assert_eq!(LaneKind::parse(l.key()), Some(l));
        assert_eq!(serde_json::to_value(l).unwrap(), l.key());
    }
    for p in [Period::Weekly, Period::Monthly] {
        assert_eq!(Period::parse(p.key()), Some(p));
        assert_eq!(serde_json::to_value(p).unwrap(), p.key());
    }
    assert_eq!(VersionStatus::parse("live"), None);

    let id = HypothesisId::new_v7();
    assert_eq!(id.to_string().parse::<HypothesisId>().unwrap(), id);
}

#[test]
fn sections_serialise_under_their_keys_and_read_back_from_an_empty_object() {
    let json = serde_json::to_value(complete_sections()).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    let mut expected = Sections::KEYS.to_vec();
    expected.sort_unstable();
    assert_eq!(keys, expected);
    assert_eq!(
        serde_json::from_value::<Sections>(json).unwrap(),
        complete_sections()
    );

    // A fresh row stores `{}`; it reads back as the empty strategy.
    let empty: Sections = serde_json::from_str("{}").unwrap();
    assert_eq!(empty, Sections::default());
    assert_eq!(empty.cadence.per_week, 0);
    assert!(!empty.paid_enabled);
}

#[test]
fn old_shaped_json_without_newer_fields_still_parses() {
    // As an older binary would have stored it: no `group_id`, no `channel_mix`, no `usp`, no
    // `paid_enabled`, a segment without a description and a lane without a period.
    let stored = json!({
        "identity": { "product": "Coffee", "voice": "warm", "positioning": "fresh" },
        "audience": [{ "key": "students", "name": "Students" }],
        "channels": [{ "channel": "instagram", "rationale": "they are there" }],
        "goals": { "objective": "grow", "kpis": [{ "name": "subscribers", "target": "200" }] },
        "budget_frame": { "lanes": [{ "lane": "paid", "cap_minor": 5000, "currency": "TRY" }] },
        "prohibitions": [],
        "cadence": { "per_week": 3 }
    });
    let s: Sections = serde_json::from_value(stored).unwrap();
    assert_eq!(s.identity.usp, "");
    assert_eq!(s.audience[0].description, "");
    assert_eq!(s.channels[0].group_id, None);
    assert_eq!(s.cadence.per_week, 3);
    assert!(s.cadence.channel_mix.is_empty());
    assert!(!s.paid_enabled);
    assert_eq!(
        s.budget_frame.lanes[0],
        lane(LaneKind::Paid, Period::Monthly, 5000, "TRY")
    );

    // A lane missing its kind reads as the organic lane; a hypothesis missing its state reads as
    // kept, and one missing its prior_confidence as 0.
    let l: Lane = serde_json::from_value(json!({ "cap_minor": 1, "currency": "TRY" })).unwrap();
    assert_eq!(l.lane, LaneKind::Organic);
    let id = HypothesisId::new_v7();
    let h: Hypothesis = serde_json::from_value(json!({ "id": id, "title": "t" })).unwrap();
    assert_eq!(
        (h.id, h.state, h.prior_confidence),
        (id, HypothesisState::Kept, 0.0)
    );
    // Without its identity a hypothesis cannot be read.
    assert!(serde_json::from_value::<Hypothesis>(json!({ "title": "t" })).is_err());
}

#[test]
fn unknown_field_in_stored_json_is_ignored_on_read() {
    // As a newer binary might have stored it: fields this binary does not know, at every depth.
    let mut stored = serde_json::to_value(complete_sections()).unwrap();
    stored["competitors"] = json!(["a", "b"]);
    stored["identity"]["tagline"] = json!("fresh daily");
    stored["audience"][0]["size"] = json!(1200);
    stored["channels"][1]["handle"] = json!("@coffee");
    stored["goals"]["kpis"][0]["unit"] = json!("people");
    stored["budget_frame"]["lanes"][1]["note"] = json!("from March");
    stored["budget_frame"]["reserve_minor"] = json!(10);
    stored["cadence"]["channel_mix"][0]["weight"] = json!(2);
    stored["cadence"]["quiet_hours"] = json!({ "from": 22, "to": 7 });
    let s: Sections = serde_json::from_value(stored).unwrap();
    assert_eq!(s, complete_sections());

    let h = hypothesis("students", "instagram", HypothesisState::Added);
    let mut stored = serde_json::to_value(&h).unwrap();
    stored["arms"] = json!([{ "alpha": 1, "beta": 1 }]);
    assert_eq!(serde_json::from_value::<Hypothesis>(stored).unwrap(), h);
}

#[test]
fn parse_section_strict_rejects_unknown_keys_at_any_depth_and_lists_them() {
    let mut frame = serde_json::to_value(complete_sections().budget_frame).unwrap();
    frame["total_minor"] = json!(1);
    frame["lanes"][0]["note"] = json!("x");
    frame["lanes"][1]["zeta"] = json!(1);
    frame["lanes"][1]["alpha"] = json!(2);
    let gaps = parse_section_strict("budget_frame", &frame).unwrap_err();
    assert_eq!(
        fields(&gaps),
        [
            "budget_frame.total_minor",
            "budget_frame.lanes[0].note",
            "budget_frame.lanes[1].alpha",
            "budget_frame.lanes[1].zeta",
        ]
    );
    assert!(
        gaps.iter().all(|g| g.message == "unknown field"),
        "{gaps:?}"
    );

    // Lists of objects, objects inside objects, and a type error reported together with them.
    let gaps = parse_section_strict(
        "goals",
        &json!({
            "objective": "grow",
            "kpis": [{ "name": "n", "target": "t" }, { "name": "n", "target": "t", "unit": "u" }],
            "deadline": "2027"
        }),
    )
    .unwrap_err();
    assert_eq!(fields(&gaps), ["goals.deadline", "goals.kpis[1].unit"]);
    let gaps = parse_section_strict(
        "cadence",
        &json!({ "per_week": "often", "channel_mix": [{ "channel": "instagram", "share_pct": 100, "w": 1 }] }),
    )
    .unwrap_err();
    assert_eq!(fields(&gaps), ["cadence.channel_mix[0].w", "cadence"]);
    assert_eq!(gaps[0].message, "unknown field");
    assert!(gaps[1].message.contains("invalid type"), "{gaps:?}");
    let gaps = parse_section_strict(
        "audience",
        &json!([{ "key": "students", "name": "S", "description": "d", "colour": "red" }]),
    )
    .unwrap_err();
    assert_eq!(fields(&gaps), ["audience[0].colour"]);
    let gaps = parse_section_strict(
        "channels",
        &json!([{ "channel": "instagram", "rationale": "r", "group": "a" }]),
    )
    .unwrap_err();
    assert_eq!(fields(&gaps), ["channels[0].group"]);
    let gaps =
        parse_section_strict("identity", &json!({ "product": "p", "prodcut": "p" })).unwrap_err();
    assert_eq!(fields(&gaps), ["identity.prodcut"]);

    // Scalars and lists of scalars: only the type can be wrong.
    assert_eq!(
        fields(&parse_section_strict("paid_enabled", &json!("yes")).unwrap_err()),
        ["paid_enabled"]
    );
    assert_eq!(
        fields(&parse_section_strict("prohibitions", &json!([{ "text": "x" }])).unwrap_err()),
        ["prohibitions"]
    );

    // An unknown section.
    let gaps = parse_section_strict("competitors", &json!([])).unwrap_err();
    assert_eq!(fields(&gaps), ["competitors"]);
    assert!(gaps[0].message.contains("unknown section"), "{gaps:?}");

    // A missing field is not an error at write time: it reads as empty and is a completeness
    // gap instead.
    assert_eq!(
        parse_section_strict("identity", &json!({ "product": "p" })).unwrap(),
        SectionValue::Identity(Identity {
            product: "p".to_owned(),
            ..Identity::default()
        })
    );
}

#[test]
fn parse_section_strict_requires_a_lanes_kind_and_period_and_caps_texts() {
    // A lane must say which lane and which period; read back, a stored one without them still
    // defaults.
    let gaps = parse_section_strict(
        "budget_frame",
        &json!({ "lanes": [
            { "cap_minor": 100, "currency": "TRY" },
            { "lane": "paid", "cap_minor": 100, "currency": "TRY", "note": "x" },
        ] }),
    )
    .unwrap_err();
    assert_eq!(
        fields(&gaps),
        [
            "budget_frame.lanes[0].lane",
            "budget_frame.lanes[0].period",
            "budget_frame.lanes[1].note",
            "budget_frame.lanes[1].period",
        ]
    );
    assert_eq!(gaps[0].message, "required field");
    let stored: BudgetFrame =
        serde_json::from_value(json!({ "lanes": [{ "cap_minor": 100, "currency": "TRY" }] }))
            .unwrap();
    assert_eq!(stored.lanes[0].lane, LaneKind::Organic);
    assert_eq!(stored.lanes[0].period, Period::Monthly);

    // Texts are capped by kind: at the cap they pass, one character over they are refused.
    let text = |n: usize| "ş".repeat(n);
    let cases = [
        (
            "identity",
            json!({ "product": text(MAX_SECTION_TEXT_CHARS + 1) }),
            "identity.product",
        ),
        (
            "identity",
            json!({ "usp": text(MAX_SECTION_TEXT_CHARS + 1) }),
            "identity.usp",
        ),
        (
            "audience",
            json!([{ "key": "k1", "name": text(MAX_SECTION_NAME_CHARS + 1), "description": "d" }]),
            "audience[0].name",
        ),
        (
            "audience",
            json!([{ "key": "k1", "name": "n", "description": text(MAX_SECTION_TEXT_CHARS + 1) }]),
            "audience[0].description",
        ),
        (
            "channels",
            json!([{ "channel": "any", "rationale": text(MAX_SECTION_TEXT_CHARS + 1) }]),
            "channels[0].rationale",
        ),
        (
            "goals",
            json!({ "objective": "o", "kpis": [{ "name": text(MAX_SECTION_NAME_CHARS + 1), "target": "t" }] }),
            "goals.kpis[0].name",
        ),
        (
            "prohibitions",
            json!(["ok", text(MAX_PROHIBITION_CHARS + 1)]),
            "prohibitions[1]",
        ),
    ];
    for (key, value, field) in cases {
        let gaps = parse_section_strict(key, &value).unwrap_err();
        assert_eq!(fields(&gaps), [field], "{key}");
        assert!(gaps[0].message.starts_with("at most "), "{gaps:?}");
    }
    let at_the_cap = [
        (
            "identity",
            json!({ "product": text(MAX_SECTION_TEXT_CHARS) }),
        ),
        (
            "audience",
            json!([{ "key": "k1", "name": text(MAX_SECTION_NAME_CHARS), "description": text(MAX_SECTION_TEXT_CHARS) }]),
        ),
        ("prohibitions", json!([text(MAX_PROHIBITION_CHARS)])),
    ];
    for (key, value) in at_the_cap {
        parse_section_strict(key, &value).unwrap_or_else(|gaps| panic!("{key}: {gaps:?}"));
    }
    assert_eq!(
        (
            MAX_SECTION_TEXT_CHARS,
            MAX_SECTION_NAME_CHARS,
            MAX_PROHIBITION_CHARS
        ),
        (2_000, 200, 500)
    );
}

#[test]
fn parse_section_strict_accepts_every_section_key() {
    let complete = serde_json::to_value(complete_sections()).unwrap();
    let mut rebuilt = Sections::default();
    for key in Sections::KEYS {
        let value = parse_section_strict(key, &complete[*key])
            .unwrap_or_else(|gaps| panic!("{key}: {gaps:?}"));
        assert_eq!(value.key(), *key);
        value.apply(&mut rebuilt);
    }
    assert_eq!(rebuilt, complete_sections());
}

#[test]
fn parse_hypotheses_strict_rejects_unknown_keys_and_reads_inputs() {
    let id = HypothesisId::new_v7();
    let parsed = parse_hypotheses_strict(&json!([
        { "id": id, "title": "t", "segment_key": "students", "angle": "a", "channel": "instagram",
          "metric": "m", "prior_confidence": 0.4 },
        { "title": "new one", "segment_key": "students", "angle": "a", "channel": "any",
          "metric": "m", "prior_confidence": 0.6 }
    ]))
    .unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].id, Some(id));
    assert_eq!(parsed[1].id, None);
    assert_eq!(parsed[1].title, "new one");

    let gaps = parse_hypotheses_strict(&json!([
        { "title": "t" },
        { "title": "t", "state": "kept", "arms": [] }
    ]))
    .unwrap_err();
    assert_eq!(fields(&gaps), ["hypotheses[1].arms", "hypotheses[1].state"]);
    assert_eq!(
        fields(&parse_hypotheses_strict(&json!({ "title": "t" })).unwrap_err()),
        ["hypotheses"]
    );
}

/// The keys of `value` serialised, sorted.
fn serialised_keys(value: impl Serialize) -> Vec<String> {
    let Value::Object(map) = serde_json::to_value(value).unwrap() else {
        panic!("not an object")
    };
    let mut keys: Vec<String> = map.keys().cloned().collect();
    keys.sort_unstable();
    keys
}

fn sorted(keys: &[&str]) -> Vec<String> {
    let mut keys: Vec<String> = keys.iter().map(|k| (*k).to_owned()).collect();
    keys.sort_unstable();
    keys
}

#[test]
fn every_written_struct_lists_exactly_its_serialised_keys() {
    assert_eq!(serialised_keys(Sections::default()), sorted(Sections::KEYS));
    assert_eq!(serialised_keys(Identity::default()), sorted(Identity::KEYS));
    assert_eq!(serialised_keys(Segment::default()), sorted(Segment::KEYS));
    assert_eq!(
        serialised_keys(ChannelChoice::default()),
        sorted(ChannelChoice::KEYS)
    );
    assert_eq!(serialised_keys(Goals::default()), sorted(Goals::KEYS));
    assert_eq!(serialised_keys(Kpi::default()), sorted(Kpi::KEYS));
    assert_eq!(
        serialised_keys(BudgetFrame::default()),
        sorted(BudgetFrame::KEYS)
    );
    assert_eq!(serialised_keys(Lane::default()), sorted(Lane::KEYS));
    assert_eq!(serialised_keys(Cadence::default()), sorted(Cadence::KEYS));
    assert_eq!(serialised_keys(Mix::default()), sorted(Mix::KEYS));
    assert_eq!(
        serialised_keys(HypothesisInput::default()),
        sorted(HypothesisInput::KEYS)
    );
    assert_eq!(
        serialised_keys(Prospecting::default()),
        sorted(Prospecting::KEYS)
    );
    assert_eq!(serialised_keys(IcpEntry::default()), sorted(IcpEntry::KEYS));
    assert_eq!(serialised_keys(Area::default()), sorted(Area::KEYS));
    assert_eq!(serialised_keys(Rubric::default()), sorted(Rubric::KEYS));
    assert_eq!(
        serialised_keys(Criterion::default()),
        sorted(Criterion::KEYS)
    );
}

// ---------------------------------------------------------------------------------------------
// The prospecting section (spec 2026-10-30-leads-pool-outreach-design.md §3.7)
// ---------------------------------------------------------------------------------------------

fn icp_entry(key: &str, segment: &str) -> IcpEntry {
    IcpEntry {
        key: key.to_owned(),
        segment_key: segment.to_owned(),
        sectors: vec!["kafe".to_owned()],
        areas: vec![Area {
            city: "İstanbul".to_owned(),
            district: Some("Kadıköy".to_owned()),
        }],
        signals: vec!["new menu".to_owned()],
        exclusions: vec!["chains".to_owned()],
        size_hint: "two branches".to_owned(),
        language: Some("tr".to_owned()),
        daily_cap: 20,
        backlog_target: 100,
    }
}

fn criterion(key: &str, weight: u8) -> Criterion {
    Criterion {
        key: key.to_owned(),
        description: format!("{key} fits"),
        weight,
    }
}

fn prospecting() -> Prospecting {
    Prospecting {
        icp: vec![icp_entry("kafeler_ist", "students")],
        rubric: Rubric {
            criteria: vec![criterion("fit", 60), criterion("size", 40)],
            qualify_at: 70,
        },
    }
}

fn with_prospecting(p: Prospecting) -> Sections {
    Sections {
        prospecting: p,
        ..complete_sections()
    }
}

#[test]
fn empty_prospecting_is_not_a_gap() {
    assert!(validate_sections(&complete_sections()).is_empty());
    // A rubric without ICP entries is not checked: prospecting is off.
    let off = Prospecting {
        icp: vec![],
        rubric: Rubric::default(),
    };
    assert!(validate_sections(&with_prospecting(off)).is_empty());
    assert!(validate_sections(&with_prospecting(prospecting())).is_empty());
}

#[test]
fn prospecting_gaps_are_reported() {
    let mut p = prospecting();
    p.icp.push(icp_entry("kafeler_ist", "students"));
    p.icp[0].sectors.clear();
    p.icp[0].areas.clear();
    p.icp[0].daily_cap = 0;
    p.icp[1].daily_cap = 201;
    p.icp[1].backlog_target = 2_001;
    p.rubric.qualify_at = 0;
    let gaps = validate_sections(&with_prospecting(p));
    assert_eq!(
        fields(&gaps),
        [
            "prospecting.icp[0].sectors",
            "prospecting.icp[0].areas",
            "prospecting.icp[0].daily_cap",
            "prospecting.icp[1].key",
            "prospecting.icp[1].daily_cap",
            "prospecting.icp[1].backlog_target",
            "prospecting.rubric.qualify_at",
        ]
    );
    let mut p = prospecting();
    p.rubric.criteria = vec![
        criterion("fit", 50),
        criterion("fit", 50),
        criterion("X", 0),
    ];
    let gaps = validate_sections(&with_prospecting(p));
    assert_eq!(
        fields(&gaps),
        [
            "prospecting.rubric.criteria[1].key",
            "prospecting.rubric.criteria[2].key",
        ]
    );
    let mut p = prospecting();
    p.rubric.criteria = (0..13).map(|i| criterion(&format!("c{i:02}"), 0)).collect();
    let gaps = validate_sections(&with_prospecting(p));
    assert!(fields(&gaps).contains(&"prospecting.rubric.criteria"));
}

#[test]
fn icp_segment_must_exist() {
    let mut p = prospecting();
    p.icp[0].segment_key = "retirees".to_owned();
    let gaps = validate_sections(&with_prospecting(p));
    assert_eq!(fields(&gaps), ["prospecting.icp[0].segment_key"]);
}

#[test]
fn rubric_weights_must_sum_to_100() {
    let mut p = prospecting();
    p.rubric.criteria[1].weight = 39;
    let gaps = validate_sections(&with_prospecting(p));
    assert_eq!(fields(&gaps), ["prospecting.rubric.weights_sum"]);
    assert!(gaps[0].message.contains("99"));
}

#[test]
fn prospecting_round_trips_and_reads_tolerantly() {
    let sections = with_prospecting(prospecting());
    let json = serde_json::to_value(&sections).unwrap();
    assert_eq!(serde_json::from_value::<Sections>(json).unwrap(), sections);
    // An older row has no prospecting key: prospecting is off.
    let old: Sections = serde_json::from_value(json!({"paid_enabled": true})).unwrap();
    assert_eq!(old.prospecting, Prospecting::default());
    // A partial entry reads its missing keys as defaults, an unknown one is ignored.
    let partial: Prospecting =
        serde_json::from_value(json!({"icp": [{"key": "a_b", "extra": 1}]})).unwrap();
    assert_eq!(partial.icp[0].key, "a_b");
    assert_eq!(partial.icp[0].daily_cap, 0);
}

#[test]
fn strict_parse_refuses_unknown_prospecting_keys() {
    let value = json!({
        "icp": [{"key": "a_b", "segment_key": "students", "areas": [{"city": "İzmir", "zip": "35"}], "colour": "x"}],
        "rubric": {"criteria": [{"key": "fit", "description": "d", "weight": 100, "hint": ""}], "qualify_at": 50, "x": 1},
        "y": true,
    });
    let gaps = parse_section_strict("prospecting", &value).unwrap_err();
    assert_eq!(
        fields(&gaps),
        [
            "prospecting.y",
            "prospecting.icp[0].colour",
            "prospecting.icp[0].areas[0].zip",
            "prospecting.rubric.x",
            "prospecting.rubric.criteria[0].hint",
        ]
    );
    let area_without_city = json!({"icp": [{"areas": [{"district": "Konak"}]}]});
    let gaps = parse_section_strict("prospecting", &area_without_city).unwrap_err();
    assert_eq!(fields(&gaps), ["prospecting.icp[0].areas[0].city"]);
    let ok =
        parse_section_strict("prospecting", &serde_json::to_value(prospecting()).unwrap()).unwrap();
    assert_eq!(ok.key(), "prospecting");
    let mut sections = complete_sections();
    ok.apply(&mut sections);
    assert_eq!(sections.prospecting, prospecting());
}

#[test]
fn diff_reports_prospecting() {
    let a = complete_sections();
    let b = with_prospecting(prospecting());
    assert_eq!(diff(&a, &b), ["prospecting"]);
    assert!(diff(&b, &b.clone()).is_empty());
}

#[test]
fn next_draft_copies_prospecting() {
    let approved = StrategyVersion {
        id: StrategyVersionId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        number: 1,
        status: VersionStatus::Approved,
        sections: with_prospecting(prospecting()),
        created_at: datetime!(2026-10-30 09:00 UTC),
        created_by: Actor::System {
            component: "test".into(),
        },
        submitted_at: None,
        approved_at: None,
        approved_by: None,
        archived_at: None,
    };
    let (sections, _) = next_draft_from(&approved, &[]);
    assert_eq!(sections.prospecting, prospecting());
}
