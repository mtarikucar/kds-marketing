//! Retention arithmetic (spec §3.6) and the research brief's bounds (§3.7).

use jt_prospects::*;
use jt_strategy::Area;
use time::Duration;
use time::macros::datetime;

const DECIDED: time::OffsetDateTime = datetime!(2026-10-01 09:00 UTC);
const UPDATED: time::OffsetDateTime = datetime!(2026-10-20 09:00 UTC);

#[test]
fn defaults_are_the_owners() {
    let p = ProspectsPolicy::default();
    assert_eq!(p.rejected_retention_days, 30);
    assert_eq!(p.unpromoted_retention_days, 180);
    assert_eq!(p.rejected_memory_days, 365);
    assert_eq!(p.max_promotions_per_day, 100);
    assert!(p.agents_promote_qualified_only);
    assert_eq!(MAX_DAILY_PROSPECTS, 500);
    // A stored partial object reads every missing key as its default.
    let partial: ProspectsPolicy =
        serde_json::from_value(serde_json::json!({"rejected_retention_days": 7})).unwrap();
    assert_eq!(
        partial,
        ProspectsPolicy {
            rejected_retention_days: 7,
            ..ProspectsPolicy::default()
        }
    );
}

#[test]
fn purge_after_rejected_is_decision_plus_retention() {
    let p = ProspectsPolicy::default();
    assert_eq!(
        purge_after(&p, ProspectStatus::Rejected, Some(DECIDED), UPDATED),
        Some(DECIDED + Duration::days(30))
    );
    // A rejection without its decision time counts from the last update.
    assert_eq!(
        purge_after(&p, ProspectStatus::Rejected, None, UPDATED),
        Some(UPDATED + Duration::days(30))
    );
}

#[test]
fn purge_after_unpromoted_moves_with_updates() {
    let p = ProspectsPolicy::default();
    for status in [ProspectStatus::New, ProspectStatus::Qualified] {
        assert_eq!(
            purge_after(&p, status, None, UPDATED),
            Some(UPDATED + Duration::days(180))
        );
        let later = UPDATED + Duration::days(3);
        assert_eq!(
            purge_after(&p, status, Some(DECIDED), later),
            Some(later + Duration::days(180)),
            "an update moves it; a decision does not"
        );
    }
}

#[test]
fn promoted_and_dnc_have_no_purge_time() {
    let p = ProspectsPolicy::default();
    assert_eq!(
        purge_after(&p, ProspectStatus::Promoted, Some(DECIDED), UPDATED),
        None
    );
    assert_eq!(
        purge_after(&p, ProspectStatus::DoNotContact, Some(DECIDED), UPDATED),
        None
    );
}

fn brief() -> Brief {
    Brief {
        segment_key: Some("kafeler".into()),
        sectors: vec!["kafe".into()],
        areas: vec![Area {
            city: "İstanbul".into(),
            district: Some("Kadıköy".into()),
        }],
        signals: vec!["new menu".into()],
        exclusions: vec![],
        size_hint: "two branches or more".into(),
        language: Some("tr".into()),
        note: String::new(),
    }
}

/// A change to a valid brief and the refusal it must meet.
type Case = (Box<dyn Fn(&mut Brief)>, (&'static str, &'static str));

#[test]
fn brief_bounds() {
    assert_eq!(validate_brief(&brief()), Ok(()));
    let cases: Vec<Case> = vec![
        (Box::new(|b| b.sectors.clear()), ("sectors", "count")),
        (
            Box::new(|b| b.sectors = vec!["x".into(); 11]),
            ("sectors", "count"),
        ),
        (Box::new(|b| b.areas.clear()), ("areas", "count")),
        (
            Box::new(|b| {
                b.areas = vec![
                    Area {
                        city: "x".into(),
                        district: None
                    };
                    21
                ]
            }),
            ("areas", "count"),
        ),
        (
            Box::new(|b| b.areas[0].city = String::new()),
            ("areas", "city_length"),
        ),
        (
            Box::new(|b| b.signals = vec!["x".into(); 11]),
            ("signals", "count"),
        ),
        (
            Box::new(|b| b.exclusions = vec![String::new()]),
            ("exclusions", "length"),
        ),
        (
            Box::new(|b| b.size_hint = "a".repeat(201)),
            ("size_hint", "too_long"),
        ),
        (
            Box::new(|b| b.note = "a".repeat(1001)),
            ("note", "too_long"),
        ),
        (
            Box::new(|b| b.segment_key = Some("X".into())),
            ("segment_key", "invalid"),
        ),
        (
            Box::new(|b| b.language = Some("t".into())),
            ("language", "invalid"),
        ),
    ];
    for (change, expected) in cases {
        let mut b = brief();
        change(&mut b);
        match validate_brief(&b) {
            Err(ProspectError::Invalid { field, reason }) => assert_eq!((field, reason), expected),
            Ok(()) => panic!("accepted {expected:?}"),
        }
    }
}

#[test]
fn task_kind_is_tagged_by_type() {
    assert_eq!(
        serde_json::to_value(TaskKind::Standing {
            icp_key: "kafeler_ist".into()
        })
        .unwrap(),
        serde_json::json!({"type": "standing", "icp_key": "kafeler_ist"})
    );
    assert_eq!(
        serde_json::to_value(TaskKind::AdHoc { target_count: 20 }).unwrap(),
        serde_json::json!({"type": "ad_hoc", "target_count": 20})
    );
    let keys: Vec<&str> = [
        TaskStatus::Open,
        TaskStatus::Done,
        TaskStatus::Canceled,
        TaskStatus::Superseded,
    ]
    .iter()
    .map(|s| s.key())
    .collect();
    assert_eq!(keys, ["open", "done", "canceled", "superseded"]);
}

#[test]
fn the_playbook_is_versioned_english_text() {
    assert_eq!(playbook::PLAYBOOK_VERSION, 1);
    assert!(playbook::TEXT.starts_with("JEETA PROSPECTING PLAYBOOK v1\n"));
    assert!(playbook::TEXT.contains("jeeta.prospects.check"));
    assert!(!playbook::TEXT.ends_with('\n'));
}
