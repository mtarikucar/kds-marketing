use std::collections::BTreeSet;

use jt_capability::*;
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use time::macros::datetime;
use time::{Duration, OffsetDateTime, UtcOffset};

/// A Thursday afternoon.
const NOW: OffsetDateTime = datetime!(2026-10-22 15:30:00 UTC);

/// The closed list of kinds, per group, in the order of `KINDS` (spec §6.2).
const EXPECTED_KINDS: &[(KindGroup, &[&str])] = &[
    (
        KindGroup::SocialAccount,
        &[
            "instagram",
            "facebook_page",
            "x",
            "linkedin_page",
            "tiktok",
            "pinterest",
            "youtube",
            "google_business",
        ],
    ),
    (
        KindGroup::Messaging,
        &[
            "whatsapp_cloud",
            "instagram_dm",
            "messenger",
            "sms_line",
            "mailbox",
            "webchat",
        ],
    ),
    (KindGroup::Telephony, &["netgsm_pbx"]),
    (
        KindGroup::Community,
        &["discord", "reddit", "review_google", "review_facebook"],
    ),
    (
        KindGroup::Ads,
        &["meta_ads", "tiktok_ads", "linkedin_ads", "google_ads"],
    ),
    (
        KindGroup::Calendar,
        &["google_calendar", "outlook_calendar"],
    ),
    (
        KindGroup::Device,
        &[
            "phone",
            "computer",
            "printer",
            "printer_3d",
            "audio_io",
            "camera",
            "screen",
            "scanner",
            "usb_storage",
        ],
    ),
    (
        KindGroup::AgentConnection,
        &["claude_code", "codex", "claude_ai", "other_agent"],
    ),
    (
        KindGroup::ComputerAccess,
        &[
            "filesystem_root",
            "browser_profile",
            "shell",
            "adb",
            "screen_control",
        ],
    ),
    (
        KindGroup::ThirdParty,
        &["notion", "slack", "gmail", "apify", "firecrawl", "other"],
    ),
];

fn fields(gaps: &[Gap]) -> Vec<&str> {
    gaps.iter().map(|g| g.field.as_str()).collect()
}

fn kind(key: &str) -> &'static CapabilityKind {
    CapabilityKind::parse(key).unwrap_or_else(|| panic!("no kind {key:?}"))
}

fn input(kind_key: &str) -> NewCapability {
    NewCapability {
        kind_key: kind_key.to_owned(),
        key_detail: None,
        name: "Brand A phone".to_owned(),
        description: "the shop's Android".to_owned(),
        external_id: None,
        connector_public: json!({}),
        policy: Policy::default(),
    }
}

fn create(input: NewCapability) -> Result<Capability, CapabilityError> {
    Capability::new(CapabilityId::new_v7(), WorkspaceId::new_v7(), input, NOW)
}

fn declared(kind_key: &str) -> Capability {
    create(input(kind_key)).unwrap_or_else(|e| panic!("{kind_key}: {e}"))
}

#[test]
fn every_kind_key_is_unique_and_parses() {
    let expected: Vec<(KindGroup, &str)> = EXPECTED_KINDS
        .iter()
        .flat_map(|(g, keys)| keys.iter().map(move |k| (*g, *k)))
        .collect();
    let actual: Vec<(KindGroup, &str)> = KINDS.iter().map(|k| (k.group, k.key)).collect();
    assert_eq!(actual, expected);
    assert_eq!(KINDS.len(), 49);

    let keys: BTreeSet<&str> = KINDS.iter().map(|k| k.key).collect();
    assert_eq!(keys.len(), KINDS.len(), "kind keys must be unique");

    for (i, k) in KINDS.iter().enumerate() {
        let parsed = CapabilityKind::parse(k.key).expect(k.key);
        assert_eq!(parsed, &KINDS[i]);
        // Keys double as strategy channel names: lowercase, digits and `_`, never `any`.
        assert!(
            k.key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
            "{}",
            k.key
        );
        assert_ne!(k.key, "any");
    }
    for unknown in [
        "",
        "Instagram",
        "instagram ",
        "third_party.other",
        "any",
        "facebook",
        "printer3d",
        "fax",
    ] {
        assert!(CapabilityKind::parse(unknown).is_none(), "{unknown:?}");
    }

    // The groups, in order, and the kinds of each.
    let groups: Vec<KindGroup> = EXPECTED_KINDS.iter().map(|(g, _)| *g).collect();
    assert_eq!(KindGroup::all(), groups.as_slice());
    for (g, keys) in EXPECTED_KINDS {
        let in_group: Vec<&str> = kinds_in_group(*g).map(|k| k.key).collect();
        assert_eq!(in_group, *keys, "{}", g.key());
    }

    // Group keys are stable and are what serde writes.
    let group_keys: Vec<&str> = KindGroup::all().iter().map(|g| g.key()).collect();
    assert_eq!(
        group_keys,
        [
            "social_account",
            "messaging",
            "telephony",
            "community",
            "ads",
            "calendar",
            "device",
            "agent_connection",
            "computer_access",
            "third_party",
        ]
    );
    for g in KindGroup::all() {
        assert_eq!(KindGroup::parse(g.key()), Some(*g));
        assert_eq!(serde_json::to_value(g).unwrap(), json!(g.key()));
        assert_eq!(
            serde_json::from_value::<KindGroup>(json!(g.key())).unwrap(),
            *g
        );
    }
    assert_eq!(KindGroup::parse("Ads"), None);

    // A capability names its kind by key and finds it again.
    let c = declared("printer_3d");
    assert_eq!(c.kind_key, "printer_3d");
    assert_eq!(c.kind(), Some(kind("printer_3d")));
}

#[test]
fn default_reach_per_group() {
    for g in KindGroup::all() {
        let expected = match g {
            KindGroup::SocialAccount
            | KindGroup::Messaging
            | KindGroup::Telephony
            | KindGroup::Community
            | KindGroup::Ads
            | KindGroup::Calendar => Reach::Connector,
            KindGroup::Device => Reach::Device,
            KindGroup::AgentConnection | KindGroup::ComputerAccess | KindGroup::ThirdParty => {
                Reach::Agent
            }
        };
        assert_eq!(g.default_reach(), expected, "{}", g.key());
        for k in kinds_in_group(*g) {
            assert_eq!(k.default_reach(), expected, "{}", k.key);
        }
    }
    let count = |r: Reach| KINDS.iter().filter(|k| k.default_reach() == r).count();
    assert_eq!(count(Reach::Connector), 25);
    assert_eq!(count(Reach::Device), 9);
    assert_eq!(count(Reach::Agent), 15);

    // A new capability takes its kind's reach, starts declared and unverified.
    for (key, reach) in [
        ("instagram", Reach::Connector),
        ("netgsm_pbx", Reach::Connector),
        ("printer_3d", Reach::Device),
        ("shell", Reach::Agent),
        ("claude_code", Reach::Agent),
    ] {
        let c = declared(key);
        assert_eq!(c.reach, reach, "{key}");
        assert_eq!(c.status, StoredStatus::Declared);
        assert!(!c.has_sealed_config);
        assert_eq!(c.last_verified_at, None);
        assert_eq!(c.evidence, None);
        assert!(c.budget_item_ids.is_empty());
        assert_eq!(c.strategy_version_id, None);
        assert_eq!((c.created_at, c.updated_at), (NOW, NOW));
    }

    for (r, key) in [
        (Reach::Connector, "connector"),
        (Reach::Agent, "agent"),
        (Reach::Device, "device"),
    ] {
        assert_eq!(r.key(), key);
        assert_eq!(Reach::parse(key), Some(r));
        assert_eq!(serde_json::to_value(r).unwrap(), json!(key));
    }
    assert_eq!(Reach::parse("Agent"), None);
}

#[test]
fn effective_status_goes_stale_after_policy_age() {
    let verified_at = |at: Option<OffsetDateTime>| {
        let mut c = declared("phone");
        c.status = StoredStatus::Verified;
        c.last_verified_at = at;
        c
    };
    let status_after = |age: Duration| effective_status(&verified_at(Some(NOW - age)), NOW);

    // Review Focus 4: a device verified 40 days ago under the default 30-day policy is no longer
    // verified.
    let c = verified_at(Some(NOW - Duration::days(40)));
    assert_eq!(c.policy.verify_max_age_days, 30);
    assert_eq!(DEFAULT_VERIFY_MAX_AGE_DAYS, 30);
    assert_eq!(effective_status(&c, NOW), EffectiveStatus::Stale);

    // The age limit itself is still fresh; one second past it is stale.
    assert_eq!(status_after(Duration::ZERO), EffectiveStatus::Verified);
    assert_eq!(status_after(Duration::days(29)), EffectiveStatus::Verified);
    assert_eq!(status_after(Duration::days(30)), EffectiveStatus::Verified);
    assert_eq!(
        status_after(Duration::days(30) + Duration::seconds(1)),
        EffectiveStatus::Stale
    );

    // The limit is the capability's own policy.
    let mut c = verified_at(Some(NOW - Duration::days(8)));
    c.policy.verify_max_age_days = 7;
    assert_eq!(effective_status(&c, NOW), EffectiveStatus::Stale);
    c.policy.verify_max_age_days = 10;
    assert_eq!(effective_status(&c, NOW), EffectiveStatus::Verified);

    // 0 means never stale.
    let mut c = verified_at(Some(NOW - Duration::days(3650)));
    c.policy.verify_max_age_days = 0;
    assert_eq!(effective_status(&c, NOW), EffectiveStatus::Verified);

    // Verified without a verification time: nothing proves it fresh, unless it never goes stale.
    let mut c = verified_at(None);
    assert_eq!(effective_status(&c, NOW), EffectiveStatus::Stale);
    c.policy.verify_max_age_days = 0;
    assert_eq!(effective_status(&c, NOW), EffectiveStatus::Verified);

    // A verification time ahead of `now` (clock skew) is fresh.
    assert_eq!(
        effective_status(&verified_at(Some(NOW + Duration::hours(1))), NOW),
        EffectiveStatus::Verified
    );

    // Every other stored status reads as stored, whatever the verification time.
    for (stored, expected) in [
        (StoredStatus::Declared, EffectiveStatus::Declared),
        (StoredStatus::Unreachable, EffectiveStatus::Unreachable),
        (StoredStatus::Retired, EffectiveStatus::Retired),
    ] {
        for at in [
            None,
            Some(NOW),
            Some(NOW - Duration::days(40)),
            Some(NOW + Duration::days(1)),
        ] {
            let mut c = verified_at(at);
            c.status = stored;
            assert_eq!(effective_status(&c, NOW), expected, "{stored:?} {at:?}");
        }
    }

    // Stable keys.
    for (s, key) in [
        (StoredStatus::Declared, "declared"),
        (StoredStatus::Verified, "verified"),
        (StoredStatus::Unreachable, "unreachable"),
        (StoredStatus::Retired, "retired"),
    ] {
        assert_eq!(s.key(), key);
        assert_eq!(StoredStatus::parse(key), Some(s));
        assert_eq!(serde_json::to_value(s).unwrap(), json!(key));
    }
    assert_eq!(StoredStatus::parse("stale"), None);
    for (s, key) in [
        (EffectiveStatus::Declared, "declared"),
        (EffectiveStatus::Verified, "verified"),
        (EffectiveStatus::Stale, "stale"),
        (EffectiveStatus::Unreachable, "unreachable"),
        (EffectiveStatus::Retired, "retired"),
    ] {
        assert_eq!(s.key(), key);
        assert_eq!(serde_json::to_value(s).unwrap(), json!(key));
    }
}

#[test]
fn other_third_party_requires_key_detail() {
    let other = |detail: Option<&str>| {
        create(NewCapability {
            key_detail: detail.map(str::to_owned),
            ..input("other")
        })
    };
    assert!(kind("other").requires_key_detail());
    assert_eq!(kind("other").group, KindGroup::ThirdParty);
    assert_eq!(other(None), Err(CapabilityError::KeyDetailRequired));
    assert_eq!(
        validate_key_detail(kind("other"), None),
        Err(CapabilityError::KeyDetailRequired)
    );

    let too_long = "a".repeat(41);
    for bad in [
        "",
        "a",
        "My Tool",
        "my.tool",
        "my tool",
        "ş_tool",
        "tool!",
        too_long.as_str(),
    ] {
        assert_eq!(
            other(Some(bad)),
            Err(CapabilityError::InvalidKeyDetail(bad.to_owned())),
            "{bad:?}"
        );
    }

    let longest = "a".repeat(40);
    for good in ["ab", "my-tool_2", "zapier", "0-9", longest.as_str()] {
        let c = other(Some(good)).unwrap_or_else(|e| panic!("{good}: {e}"));
        assert_eq!(c.key_detail.as_deref(), Some(good));
        assert_eq!(c.kind_key, "other");
        assert_eq!(c.reach, Reach::Agent);
    }

    // Every other kind refuses a key detail and needs none.
    for k in KINDS.iter().filter(|k| k.key != "other") {
        assert!(!k.requires_key_detail(), "{}", k.key);
        assert_eq!(
            create(NewCapability {
                key_detail: Some("zapier".to_owned()),
                ..input(k.key)
            }),
            Err(CapabilityError::KeyDetailNotAllowed(k.key.to_owned())),
        );
        assert!(create(input(k.key)).is_ok(), "{}", k.key);
    }

    // A kind outside the closed list is refused.
    for unknown in ["", "fax", "Instagram", "third_party.other", "any"] {
        assert_eq!(
            create(input(unknown)),
            Err(CapabilityError::UnknownKind(unknown.to_owned())),
            "{unknown:?}"
        );
    }
}

#[test]
fn names_and_texts_are_bounded() {
    assert_eq!(MAX_NAME_CHARS, 64);
    assert!(validate_name("A").is_ok());
    assert!(
        validate_name(&"ş".repeat(64)).is_ok(),
        "characters, not bytes"
    );
    assert_eq!(
        validate_name(&"a".repeat(65)),
        Err(CapabilityError::NameTooLong { len: 65 })
    );
    for blank in ["", "   ", "\t"] {
        assert_eq!(validate_name(blank), Err(CapabilityError::BlankName));
    }
    assert_eq!(
        validate_name("Brand\nA"),
        Err(CapabilityError::NameHasControlCharacter)
    );

    // Constructors trim the name and check it.
    let c = create(NewCapability {
        name: "  Brand A phone  ".to_owned(),
        ..input("phone")
    })
    .unwrap();
    assert_eq!(c.name, "Brand A phone");
    assert_eq!(
        create(NewCapability {
            name: " ".to_owned(),
            ..input("phone")
        }),
        Err(CapabilityError::BlankName)
    );

    assert_eq!(
        create(NewCapability {
            description: "x".repeat(MAX_DESCRIPTION_CHARS + 1),
            ..input("phone")
        }),
        Err(CapabilityError::TextTooLong {
            field: "description",
            len: MAX_DESCRIPTION_CHARS + 1,
            max: MAX_DESCRIPTION_CHARS,
        })
    );
    assert!(
        create(NewCapability {
            description: "x".repeat(MAX_DESCRIPTION_CHARS),
            ..input("phone")
        })
        .is_ok()
    );

    // An external id, when given, is not blank and is bounded; it is kept as given.
    let with_external = |id: &str| {
        create(NewCapability {
            external_id: Some(id.to_owned()),
            ..input("instagram")
        })
    };
    assert_eq!(
        with_external("17841400000000000").unwrap().external_id,
        Some("17841400000000000".to_owned())
    );
    assert_eq!(with_external("  "), Err(CapabilityError::BlankExternalId));
    assert_eq!(
        with_external(&"1".repeat(MAX_EXTERNAL_ID_CHARS + 1)),
        Err(CapabilityError::TextTooLong {
            field: "external_id",
            len: MAX_EXTERNAL_ID_CHARS + 1,
            max: MAX_EXTERNAL_ID_CHARS,
        })
    );

    // Groups: a name of 1 to 64 characters, trimmed; an optional, bounded purpose.
    let ws = WorkspaceId::new_v7();
    let group = |name: &str, purpose: Option<String>| {
        CapabilityGroup::new(CapabilityGroupId::new_v7(), ws, name.to_owned(), purpose)
    };
    let g = group(" Brand A accounts ", Some("brand".to_owned())).unwrap();
    assert_eq!(g.name, "Brand A accounts");
    assert_eq!(g.purpose.as_deref(), Some("brand"));
    assert_eq!(g.workspace_id, ws);
    assert_eq!(group("", None), Err(CapabilityError::BlankName));
    assert_eq!(
        group(&"g".repeat(65), None),
        Err(CapabilityError::NameTooLong { len: 65 })
    );
    assert_eq!(
        group("Brand A", Some("p".repeat(MAX_DESCRIPTION_CHARS + 1))),
        Err(CapabilityError::TextTooLong {
            field: "purpose",
            len: MAX_DESCRIPTION_CHARS + 1,
            max: MAX_DESCRIPTION_CHARS,
        })
    );

    // Evidence is the agent's claim: a text, and references, both bounded.
    let evidence = |text: &str, refs: &[&str]| Evidence {
        text: text.to_owned(),
        refs: refs.iter().map(|r| (*r).to_owned()).collect(),
    };
    assert!(validate_evidence(&evidence("adb devices: R58M123", &["file:abc"])).is_empty());
    assert!(validate_evidence(&evidence("serial R58M123", &[])).is_empty());
    let long_ref = "r".repeat(MAX_EVIDENCE_REF_CHARS + 1);
    let gaps = validate_evidence(&evidence(" ", &["ok", "", long_ref.as_str()]));
    assert_eq!(
        fields(&gaps),
        ["evidence.text", "evidence.refs[1]", "evidence.refs[2]"]
    );
    assert!(gaps.iter().all(|g| !g.message.is_empty()), "{gaps:?}");
    assert_eq!(
        fields(&validate_evidence(&evidence(
            &"t".repeat(MAX_EVIDENCE_TEXT_CHARS + 1),
            &["r"; MAX_EVIDENCE_REFS + 1]
        ))),
        ["evidence.text", "evidence.refs"]
    );
    assert!(
        validate_evidence(&evidence(
            &"t".repeat(MAX_EVIDENCE_TEXT_CHARS),
            &["r"; MAX_EVIDENCE_REFS]
        ))
        .is_empty()
    );
}

#[test]
fn budget_link_rules() {
    use BudgetKind::*;
    assert_eq!(
        BudgetKind::all(),
        [
            Cash, AdBudget, SmsBudget, AgentQuota, AgentHours, Consumable
        ]
    );
    let linkable = |key: &str| -> Vec<BudgetKind> {
        BudgetKind::all()
            .iter()
            .copied()
            .filter(|b| can_link_budget(kind(key), *b))
            .collect()
    };

    for key in ["meta_ads", "tiktok_ads", "linkedin_ads", "google_ads"] {
        assert_eq!(linkable(key), [Cash, AdBudget], "{key}");
    }
    assert_eq!(linkable("sms_line"), [Cash, SmsBudget]);
    for key in ["claude_code", "codex", "claude_ai", "other_agent"] {
        assert_eq!(linkable(key), [AgentQuota, AgentHours], "{key}");
    }
    for key in ["printer", "printer_3d"] {
        assert_eq!(linkable(key), [Cash, Consumable], "{key}");
    }
    for key in [
        "instagram",
        "whatsapp_cloud",
        "mailbox",
        "netgsm_pbx",
        "review_google",
        "google_calendar",
        "phone",
        "scanner",
        "shell",
        "adb",
        "notion",
        "other",
    ] {
        assert_eq!(linkable(key), [Cash], "{key}");
    }

    // Across the whole list: how many kinds each budget kind can feed.
    let feeds = |b: BudgetKind| -> usize { KINDS.iter().filter(|k| can_link_budget(k, b)).count() };
    assert_eq!(feeds(Cash), 45, "every kind but the agent connections");
    assert_eq!(feeds(AdBudget), 4);
    assert_eq!(feeds(SmsBudget), 1);
    assert_eq!(feeds(AgentQuota), 4);
    assert_eq!(feeds(AgentHours), 4);
    assert_eq!(feeds(Consumable), 2);

    for (b, key) in [
        (Cash, "cash"),
        (AdBudget, "ad_budget"),
        (SmsBudget, "sms_budget"),
        (AgentQuota, "agent_quota"),
        (AgentHours, "agent_hours"),
        (Consumable, "consumable"),
    ] {
        assert_eq!(b.key(), key);
        assert_eq!(BudgetKind::parse(key), Some(b));
        assert_eq!(serde_json::to_value(b).unwrap(), json!(key));
    }
    assert_eq!(BudgetKind::parse("ads"), None);
}

#[test]
fn budget_items_and_spend_are_validated() {
    let ws = WorkspaceId::new_v7();
    let item = |unit: Unit, cap: i64| {
        BudgetItem::new(
            BudgetItemId::new_v7(),
            ws,
            NewBudgetItem {
                name: " Meta ads ".to_owned(),
                kind: BudgetKind::AdBudget,
                unit,
                cap,
                period: Period::Monthly,
            },
            NOW,
        )
    };
    let ok = item(Unit::Currency("TRY".to_owned()), 150_000).unwrap();
    assert_eq!(ok.name, "Meta ads");
    assert_eq!(ok.kind, BudgetKind::AdBudget);
    assert_eq!(ok.cap, 150_000);
    assert_eq!(ok.period, Period::Monthly);
    assert_eq!(ok.created_at, NOW);
    assert_eq!(ok.strategy_version_id, None);
    assert!(item(Unit::Currency("TRY".to_owned()), 0).is_ok());
    assert!(item(Unit::Minutes, 600).is_ok());
    assert!(item(Unit::Count("filament spools".to_owned()), 3).is_ok());
    assert!(item(Unit::Count("ş".repeat(32)), 3).is_ok());

    for bad in ["try", "TRYX", "TR", "", "T1Y"] {
        assert_eq!(
            item(Unit::Currency(bad.to_owned()), 1),
            Err(CapabilityError::InvalidCurrency(bad.to_owned())),
            "{bad:?}"
        );
    }
    for bad in [String::new(), "  ".to_owned(), "a".repeat(33)] {
        assert_eq!(
            item(Unit::Count(bad.clone()), 1),
            Err(CapabilityError::InvalidUnitLabel(bad.clone())),
            "{bad:?}"
        );
    }
    assert_eq!(
        item(Unit::Minutes, -1),
        Err(CapabilityError::NegativeCap(-1))
    );
    assert_eq!(
        BudgetItem::new(
            BudgetItemId::new_v7(),
            ws,
            NewBudgetItem {
                name: String::new(),
                kind: BudgetKind::Cash,
                unit: Unit::Minutes,
                cap: 1,
                period: Period::Total,
            },
            NOW
        ),
        Err(CapabilityError::BlankName)
    );

    // Remaining may go below zero (recorded over-cap spend); it never overflows.
    assert_eq!(remaining(100, 30), 70);
    assert_eq!(remaining(100, 100), 0);
    assert_eq!(remaining(100, 130), -30);
    assert_eq!(remaining(0, 0), 0);
    assert_eq!(remaining(i64::MIN, i64::MAX), i64::MIN);

    // A spend is a positive amount: a negative one would raise what remains.
    let spend = |amount: i64, reference: Option<String>| {
        BudgetSpend::new(
            BudgetSpendId::new_v7(),
            ws,
            ok.id,
            NewBudgetSpend {
                amount,
                source: SpendSource::Agent,
                reference,
            },
            NOW,
        )
    };
    let s = spend(2_500, Some("invoice 42".to_owned())).unwrap();
    assert_eq!(
        (s.workspace_id, s.budget_item_id, s.amount, s.at),
        (ws, ok.id, 2_500, NOW)
    );
    assert_eq!(s.source, SpendSource::Agent);
    assert_eq!(s.reference.as_deref(), Some("invoice 42"));
    for bad in [0, -5] {
        assert_eq!(
            spend(bad, None),
            Err(CapabilityError::NonPositiveAmount(bad))
        );
    }
    assert_eq!(
        spend(1, Some("r".repeat(MAX_REFERENCE_CHARS + 1))),
        Err(CapabilityError::TextTooLong {
            field: "reference",
            len: MAX_REFERENCE_CHARS + 1,
            max: MAX_REFERENCE_CHARS,
        })
    );
}

#[test]
fn period_windows_are_half_open_and_utc() {
    // A Thursday.
    assert_eq!(
        period_window(Period::Daily, NOW),
        (
            datetime!(2026-10-22 0:00 UTC),
            datetime!(2026-10-23 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Weekly, NOW),
        (
            datetime!(2026-10-19 0:00 UTC),
            datetime!(2026-10-26 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Monthly, NOW),
        (
            datetime!(2026-10-01 0:00 UTC),
            datetime!(2026-11-01 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Total, NOW),
        (OffsetDateTime::UNIX_EPOCH, END_OF_TIME)
    );

    // Half-open: a window's start belongs to it, its end to the next window.
    let monday = datetime!(2026-10-26 0:00 UTC);
    let just_before = monday - Duration::nanoseconds(1);
    assert_eq!(
        period_window(Period::Weekly, monday),
        (monday, datetime!(2026-11-02 0:00 UTC))
    );
    assert_eq!(
        period_window(Period::Weekly, just_before),
        (datetime!(2026-10-19 0:00 UTC), monday)
    );
    assert_eq!(
        period_window(Period::Daily, monday),
        (monday, datetime!(2026-10-27 0:00 UTC))
    );
    assert_eq!(
        period_window(Period::Daily, just_before),
        (datetime!(2026-10-25 0:00 UTC), monday)
    );
    let november = datetime!(2026-11-01 0:00 UTC);
    assert_eq!(
        period_window(Period::Monthly, november),
        (november, datetime!(2026-12-01 0:00 UTC))
    );
    assert_eq!(
        period_window(Period::Monthly, november - Duration::nanoseconds(1)),
        (datetime!(2026-10-01 0:00 UTC), november)
    );

    // Across month and year ends, and a leap February.
    assert_eq!(
        period_window(Period::Weekly, datetime!(2027-01-01 12:00 UTC)),
        (
            datetime!(2026-12-28 0:00 UTC),
            datetime!(2027-01-04 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Monthly, datetime!(2026-12-31 23:59:59 UTC)),
        (
            datetime!(2026-12-01 0:00 UTC),
            datetime!(2027-01-01 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Monthly, datetime!(2028-02-29 12:00 UTC)),
        (
            datetime!(2028-02-01 0:00 UTC),
            datetime!(2028-03-01 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Daily, datetime!(2028-02-29 12:00 UTC)),
        (
            datetime!(2028-02-29 0:00 UTC),
            datetime!(2028-03-01 0:00 UTC)
        )
    );

    // UTC whatever the offset of `now`: 01:30 on 1 November in Istanbul is 22:30 on 31 October
    // (a Saturday) in UTC.
    let istanbul = datetime!(2026-11-01 01:30 +03:00);
    assert_eq!(
        period_window(Period::Daily, istanbul),
        (
            datetime!(2026-10-31 0:00 UTC),
            datetime!(2026-11-01 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Weekly, istanbul),
        (
            datetime!(2026-10-26 0:00 UTC),
            datetime!(2026-11-02 0:00 UTC)
        )
    );
    assert_eq!(
        period_window(Period::Monthly, istanbul),
        (
            datetime!(2026-10-01 0:00 UTC),
            datetime!(2026-11-01 0:00 UTC)
        )
    );

    for now in [
        NOW,
        istanbul,
        monday,
        just_before,
        datetime!(1970-01-01 0:00 UTC),
    ] {
        for p in Period::all() {
            let (start, end) = period_window(*p, now);
            assert_eq!(start.offset(), UtcOffset::UTC, "{p:?} {now}");
            assert_eq!(end.offset(), UtcOffset::UTC, "{p:?} {now}");
            assert!(start <= now && now < end, "{p:?} {now}: {start}..{end}");
        }
    }

    for (p, key) in [
        (Period::Daily, "daily"),
        (Period::Weekly, "weekly"),
        (Period::Monthly, "monthly"),
        (Period::Total, "total"),
    ] {
        assert_eq!(p.key(), key);
        assert_eq!(Period::parse(key), Some(p));
        assert_eq!(serde_json::to_value(p).unwrap(), json!(key));
    }
}

#[test]
fn connector_public_rejects_secret_looking_keys_at_any_depth() {
    assert_eq!(REDACTED_KEYS, jt_ledger::REDACTED_KEYS);
    assert!(validate_connector_public(&json!({})).is_empty());
    assert!(
        validate_connector_public(&json!({
            "page_name": "Brand A",
            "handle": "@brand_a",
            "token_count": 3,
            "scopes": ["pages_read_engagement"],
            "account": {"id": "1784", "key": "public-key-id", "hash": "abc"},
            "access_token_expires_at": "2026-12-01T00:00:00Z",
        }))
        .is_empty()
    );

    let value = json!({
        "page_name": "Brand A",
        "Token": "x",
        "account": {
            "id": "1",
            "ACCESS_TOKEN": "x",
            "nested": [{"ok": 1}, {"client_secret": {"inner": "x"}}],
        },
        "list": [[{"password": "x"}]],
        "authorization": null,
    });
    let gaps = validate_connector_public(&value);
    assert_eq!(
        fields(&gaps),
        [
            "connector_public.Token",
            "connector_public.account.ACCESS_TOKEN",
            "connector_public.account.nested[1].client_secret",
            "connector_public.authorization",
            "connector_public.list[0][0].password",
        ]
    );
    assert!(gaps.iter().all(|g| !g.message.is_empty()), "{gaps:?}");

    // Every key of the ledger's redaction list, in any case.
    for key in REDACTED_KEYS {
        for spelt in [key.to_string(), key.to_uppercase()] {
            let gaps = validate_connector_public(&json!({ "outer": { spelt.clone(): "x" } }));
            assert_eq!(
                fields(&gaps),
                [format!("connector_public.outer.{spelt}").as_str()]
            );
        }
    }

    // The public fields are an object.
    for not_object in [json!([]), json!("token"), json!(3), Value::Null] {
        assert_eq!(
            fields(&validate_connector_public(&not_object)),
            ["connector_public"],
            "{not_object}"
        );
    }

    // A new capability refuses them; an absent (null) value reads as an empty object.
    let refused = create(NewCapability {
        connector_public: json!({"page": {"token": "x"}}),
        ..input("facebook_page")
    });
    match refused {
        Err(CapabilityError::InvalidConnectorPublic(gaps)) => {
            assert_eq!(fields(&gaps), ["connector_public.page.token"]);
        }
        other => panic!("expected InvalidConnectorPublic, got {other:?}"),
    }
    let c = create(NewCapability {
        connector_public: Value::Null,
        ..input("facebook_page")
    })
    .unwrap();
    assert_eq!(c.connector_public, json!({}));
    let c = create(NewCapability {
        connector_public: json!({"page_name": "Brand A"}),
        ..input("facebook_page")
    })
    .unwrap();
    assert_eq!(c.connector_public, json!({"page_name": "Brand A"}));
}

#[test]
fn hours_validation() {
    let with_hours = |tz: &str, from: u8, to: u8, days: &[u8]| Policy {
        active_hours: Some(Hours {
            tz: tz.to_owned(),
            from,
            to,
            days: days.to_vec(),
        }),
        ..Policy::default()
    };
    let gaps_of = |p: &Policy| -> Vec<String> {
        validate_policy(p)
            .into_iter()
            .map(|g| {
                assert!(!g.message.is_empty(), "{g:?}");
                g.field
            })
            .collect()
    };

    let defaults = Policy::default();
    assert_eq!(defaults.active_hours, None);
    assert_eq!(defaults.daily_ops_cap, None);
    assert_eq!(defaults.spend_cap_minor, None);
    assert!(!defaults.requires_human_approval, "off by default (K8)");
    assert_eq!(defaults.verify_max_age_days, DEFAULT_VERIFY_MAX_AGE_DAYS);
    assert!(validate_policy(&defaults).is_empty());
    assert!(validate_policy(&with_hours("Europe/Istanbul", 9, 18, &[1, 2, 3, 4, 5])).is_empty());
    assert!(validate_policy(&with_hours("UTC", 0, 23, &[1, 2, 3, 4, 5, 6, 7])).is_empty());
    assert!(validate_policy(&with_hours("UTC", 22, 23, &[7])).is_empty());

    // Time zones: "UTC", or an IANA-looking `Area/Location` name.
    for tz in [
        "UTC",
        "Etc/UTC",
        "Europe/Istanbul",
        "America/Argentina/Buenos_Aires",
        "America/Port-au-Prince",
    ] {
        assert!(
            validate_policy(&with_hours(tz, 9, 17, &[1])).is_empty(),
            "{tz}"
        );
    }
    let too_long = format!("Europe/{}", "a".repeat(60));
    for tz in [
        "",
        "utc",
        "GMT",
        "Istanbul",
        "Europe/",
        "/Istanbul",
        "Europe//Istanbul",
        "Etc/GMT+3",
        "Europe/İstanbul",
        "Europe/Is tanbul",
        "Europe/Istanbul\n",
        too_long.as_str(),
    ] {
        assert_eq!(
            gaps_of(&with_hours(tz, 9, 17, &[1])),
            ["policy.active_hours.tz"],
            "{tz:?}"
        );
    }

    // Hours are 0..=23 and `from` comes before `to`.
    assert_eq!(
        gaps_of(&with_hours("UTC", 9, 9, &[1])),
        ["policy.active_hours.to"]
    );
    assert_eq!(
        gaps_of(&with_hours("UTC", 18, 9, &[1])),
        ["policy.active_hours.to"]
    );
    assert_eq!(
        gaps_of(&with_hours("UTC", 24, 23, &[1])),
        ["policy.active_hours.from"]
    );
    assert_eq!(
        gaps_of(&with_hours("UTC", 9, 24, &[1])),
        ["policy.active_hours.to"]
    );
    assert_eq!(
        gaps_of(&with_hours("UTC", 25, 30, &[1])),
        ["policy.active_hours.from", "policy.active_hours.to"]
    );

    // Days are ISO weekdays 1 (Monday) to 7 (Sunday), each once, at least one.
    assert_eq!(
        gaps_of(&with_hours("UTC", 9, 17, &[])),
        ["policy.active_hours.days"]
    );
    assert_eq!(
        gaps_of(&with_hours("UTC", 9, 17, &[0, 8, 3, 3, 7])),
        [
            "policy.active_hours.days[0]",
            "policy.active_hours.days[1]",
            "policy.active_hours.days[3]",
        ]
    );

    // Caps: a spend cap is not negative; any ops cap and any age (0 = never stale) is fine.
    let caps = |daily_ops_cap: Option<u32>, spend_cap_minor: Option<i64>, age: u16| Policy {
        daily_ops_cap,
        spend_cap_minor,
        verify_max_age_days: age,
        ..Policy::default()
    };
    assert!(validate_policy(&caps(Some(0), Some(0), 0)).is_empty());
    assert!(validate_policy(&caps(Some(u32::MAX), Some(i64::MAX), u16::MAX)).is_empty());
    assert_eq!(
        gaps_of(&caps(None, Some(-1), 30)),
        ["policy.spend_cap_minor"]
    );

    // Every gap at once, in field order.
    let mut p = with_hours("Istanbul", 30, 2, &[9]);
    p.spend_cap_minor = Some(-5);
    assert_eq!(
        gaps_of(&p),
        [
            "policy.active_hours.tz",
            "policy.active_hours.from",
            "policy.active_hours.days[0]",
            "policy.spend_cap_minor",
        ]
    );

    // A new capability refuses an invalid policy with its gaps.
    match create(NewCapability {
        policy: p,
        ..input("phone")
    }) {
        Err(CapabilityError::InvalidPolicy(gaps)) => assert_eq!(fields(&gaps).len(), 4),
        other => panic!("expected InvalidPolicy, got {other:?}"),
    }
}

#[test]
fn stored_capability_json_without_newer_fields_still_parses() {
    let id = CapabilityId::new_v7();
    let ws = WorkspaceId::new_v7();
    let minimal = json!({ "id": id, "workspace_id": ws, "kind_key": "phone" });

    // Written by an older binary: only the identity is there; everything else reads as default.
    let c: Capability = serde_json::from_value(minimal.clone()).unwrap();
    assert_eq!((c.id, c.workspace_id), (id, ws));
    assert_eq!(c.kind_key, "phone");
    assert_eq!(c.key_detail, None);
    assert_eq!((c.name.as_str(), c.description.as_str()), ("", ""));
    assert_eq!(c.reach, Reach::Connector, "the reach no claim can verify");
    assert_eq!(c.status, StoredStatus::Declared);
    assert_eq!(c.external_id, None);
    assert_eq!(c.connector_public, json!({}));
    assert!(!c.has_sealed_config);
    assert_eq!(c.last_verified_at, None);
    assert_eq!(c.evidence, None);
    assert_eq!(c.policy, Policy::default());
    assert!(c.budget_item_ids.is_empty());
    assert_eq!(c.strategy_version_id, None);
    assert_eq!(c.created_at, OffsetDateTime::UNIX_EPOCH);
    assert_eq!(c.updated_at, OffsetDateTime::UNIX_EPOCH);

    // Written by a newer binary: unknown fields are ignored at any depth, and a partial nested
    // value fills the rest with defaults.
    let c: Capability = serde_json::from_value(json!({
        "id": id,
        "workspace_id": ws,
        "kind_key": "phone",
        "reach": "device",
        "status": "verified",
        "last_verified_at": "2026-10-01T10:00:00Z",
        "policy": { "verify_max_age_days": 7, "quiet_mode": true },
        "evidence": { "text": "serial R58M123", "checksum": "abc" },
        "future_field": { "x": 1 },
    }))
    .unwrap();
    assert_eq!(c.reach, Reach::Device);
    assert_eq!(c.policy.verify_max_age_days, 7);
    assert!(!c.policy.requires_human_approval);
    assert_eq!(
        c.evidence,
        Some(Evidence {
            text: "serial R58M123".to_owned(),
            refs: vec![],
        })
    );
    assert_eq!(
        c.last_verified_at,
        Some(datetime!(2026-10-01 10:00 UTC)),
        "rfc3339"
    );
    assert_eq!(effective_status(&c, NOW), EffectiveStatus::Stale);

    // The identity is required.
    for key in ["id", "workspace_id", "kind_key"] {
        let mut v = minimal.clone();
        v.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<Capability>(v).is_err(), "{key}");
    }

    // A kind no longer on the list still reads; it just has no kind.
    let mut v = minimal.clone();
    v["kind_key"] = json!("fax");
    let c: Capability = serde_json::from_value(v).unwrap();
    assert!(c.kind().is_none());

    // A full capability round-trips, with snake_case values and rfc3339 times.
    let mut c = declared("phone");
    c.status = StoredStatus::Verified;
    c.last_verified_at = Some(NOW);
    c.evidence = Some(Evidence {
        text: "adb devices".to_owned(),
        refs: vec!["file:abc".to_owned()],
    });
    c.budget_item_ids = vec![BudgetItemId::new_v7()];
    c.strategy_version_id = Some(uuid::Uuid::now_v7());
    c.policy.active_hours = Some(Hours {
        tz: "Europe/Istanbul".to_owned(),
        from: 9,
        to: 18,
        days: vec![1, 2, 3, 4, 5],
    });
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(v["reach"], json!("device"));
    assert_eq!(v["status"], json!("verified"));
    assert_eq!(v["kind_key"], json!("phone"));
    assert_eq!(v["created_at"], json!("2026-10-22T15:30:00Z"));
    assert_eq!(serde_json::from_value::<Capability>(v).unwrap(), c);

    // The other stored types read from an empty or partial object too.
    assert_eq!(
        serde_json::from_value::<Policy>(json!({})).unwrap(),
        Policy::default()
    );
    assert_eq!(
        serde_json::from_value::<Hours>(json!({})).unwrap(),
        Hours::default()
    );
    let never_open = Hours::default();
    assert_eq!(never_open.tz, "UTC");
    assert_eq!((never_open.from, never_open.to), (0, 0));
    assert!(never_open.days.is_empty());
    assert_eq!(
        serde_json::from_value::<Evidence>(json!({})).unwrap(),
        Evidence::default()
    );

    let group: CapabilityGroup = serde_json::from_value(json!({
        "id": CapabilityGroupId::new_v7(), "workspace_id": ws, "colour": "red"
    }))
    .unwrap();
    assert_eq!((group.name.as_str(), group.purpose), ("", None));

    let item_id = BudgetItemId::new_v7();
    let item: BudgetItem = serde_json::from_value(json!({
        "id": item_id, "workspace_id": ws, "kind": "ad_budget", "rollover": true
    }))
    .unwrap();
    assert_eq!(item.kind, BudgetKind::AdBudget);
    assert_eq!(item.name, "");
    assert_eq!(item.unit, Unit::Count(String::new()));
    assert_eq!(item.cap, 0, "a missing cap allows nothing");
    assert_eq!(item.period, Period::Total, "the period that allows least");
    assert_eq!(item.strategy_version_id, None);
    assert_eq!(item.created_at, OffsetDateTime::UNIX_EPOCH);
    assert!(
        serde_json::from_value::<BudgetItem>(json!({ "id": item_id, "workspace_id": ws })).is_err(),
        "the budget kind is required"
    );

    let spend: BudgetSpend = serde_json::from_value(json!({
        "id": BudgetSpendId::new_v7(), "budget_item_id": item_id, "workspace_id": ws
    }))
    .unwrap();
    assert_eq!(spend.at, OffsetDateTime::UNIX_EPOCH);
    assert_eq!(spend.amount, 0);
    assert_eq!(spend.source, SpendSource::Agent);
    assert_eq!(spend.reference, None);

    // The tagged shapes of a unit and a spend source.
    for (unit, shape) in [
        (
            Unit::Currency("TRY".to_owned()),
            json!({"kind": "currency", "value": "TRY"}),
        ),
        (
            Unit::Count("spools".to_owned()),
            json!({"kind": "count", "value": "spools"}),
        ),
        (Unit::Minutes, json!({"kind": "minutes"})),
    ] {
        assert_eq!(serde_json::to_value(&unit).unwrap(), shape);
        assert_eq!(serde_json::from_value::<Unit>(shape).unwrap(), unit);
    }
    for (source, shape) in [
        (
            SpendSource::Connector("meta_ads".to_owned()),
            json!({"kind": "connector", "value": "meta_ads"}),
        ),
        (SpendSource::Agent, json!({"kind": "agent"})),
        (SpendSource::Human, json!({"kind": "human"})),
    ] {
        assert_eq!(serde_json::to_value(&source).unwrap(), shape);
        assert_eq!(
            serde_json::from_value::<SpendSource>(shape).unwrap(),
            source
        );
    }
}
