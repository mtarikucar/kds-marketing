//! Research tasks (spec §3.7): an ICP entry's standing brief, ad-hoc bounds, the claim lease
//! and what a task may still record today. Every value is invented.

use jt_prospects::*;
use jt_strategy::{Area, IcpEntry};
use time::Duration;

fn entry() -> IcpEntry {
    IcpEntry {
        key: "kafeler".into(),
        segment_key: "kafeler".into(),
        sectors: vec![" kafe ".into(), "pastane".into()],
        areas: vec![Area {
            city: " İstanbul ".into(),
            district: Some(" Kadıköy ".into()),
        }],
        signals: vec!["yeni şube".into()],
        exclusions: vec!["zincir".into()],
        size_hint: "bir iki şube".into(),
        language: Some("tr".into()),
        daily_cap: 20,
        backlog_target: 100,
    }
}

#[test]
fn a_standing_brief_is_its_icp_entry() {
    let b = standing_brief(&entry());
    assert_eq!(
        b,
        Brief {
            segment_key: Some("kafeler".into()),
            sectors: vec!["kafe".into(), "pastane".into()],
            areas: vec![Area {
                city: "İstanbul".into(),
                district: Some("Kadıköy".into()),
            }],
            signals: vec!["yeni şube".into()],
            exclusions: vec!["zincir".into()],
            size_hint: "bir iki şube".into(),
            language: Some("tr".into()),
            note: String::new(),
        }
    );
    validate_brief(&b).unwrap();
}

#[test]
fn a_brief_is_stored_trimmed() {
    let b = Brief {
        sectors: vec![" kafe ".into()],
        areas: vec![Area {
            city: " Ankara ".into(),
            district: Some("  ".into()),
        }],
        signals: vec![" ".into(), " açık ".into()],
        size_hint: " küçük ".into(),
        language: Some(" TR ".into()),
        note: " bir not ".into(),
        ..Brief::default()
    }
    .normalised();
    assert_eq!(b.sectors, ["kafe"]);
    assert_eq!(
        b.areas,
        [Area {
            city: "Ankara".into(),
            district: None
        }]
    );
    assert_eq!(b.signals, ["açık"], "an empty entry is dropped");
    assert_eq!(b.size_hint, "küçük");
    assert_eq!(b.language.as_deref(), Some("tr"));
    assert_eq!(b.note, "bir not");
}

#[test]
fn an_ad_hoc_task_is_bounded() {
    validate_ad_hoc(1, 1).unwrap();
    validate_ad_hoc(MAX_TASK_TARGET, MAX_TASK_DAILY_CAP).unwrap();
    assert_eq!(
        validate_ad_hoc(0, 10),
        Err(ProspectError::Invalid {
            field: "target_count",
            reason: "range"
        })
    );
    assert_eq!(
        validate_ad_hoc(MAX_TASK_TARGET + 1, 10),
        Err(ProspectError::Invalid {
            field: "target_count",
            reason: "range"
        })
    );
    assert_eq!(
        validate_ad_hoc(10, 0),
        Err(ProspectError::Invalid {
            field: "daily_cap",
            reason: "range"
        })
    );
    assert_eq!(
        validate_ad_hoc(10, MAX_TASK_DAILY_CAP + 1),
        Err(ProspectError::Invalid {
            field: "daily_cap",
            reason: "range"
        })
    );
    assert_eq!(CLAIM_LEASE, Duration::hours(2));
}

fn capacity() -> Capacity {
    Capacity {
        daily_cap: 20,
        recorded_today: 5,
        workspace_today: 100,
        target_left: None,
        backlog: None,
    }
}

#[test]
fn remaining_is_the_daily_cap_less_today() {
    assert_eq!(remaining_today(&capacity()), 15);
    assert_eq!(
        remaining_today(&Capacity {
            recorded_today: 25,
            ..capacity()
        }),
        0,
        "never below zero"
    );
}

#[test]
fn remaining_never_passes_the_workspace_ceiling_or_the_target() {
    assert_eq!(
        remaining_today(&Capacity {
            workspace_today: MAX_DAILY_PROSPECTS - 3,
            ..capacity()
        }),
        3
    );
    assert_eq!(
        remaining_today(&Capacity {
            workspace_today: MAX_DAILY_PROSPECTS + 9,
            ..capacity()
        }),
        0
    );
    assert_eq!(
        remaining_today(&Capacity {
            target_left: Some(4),
            ..capacity()
        }),
        4
    );
}

#[test]
fn a_full_backlog_zeroes_remaining_and_a_zero_target_sets_no_limit() {
    assert_eq!(
        remaining_today(&Capacity {
            backlog: Some((100, 100)),
            ..capacity()
        }),
        0
    );
    assert_eq!(
        remaining_today(&Capacity {
            backlog: Some((99, 100)),
            ..capacity()
        }),
        15
    );
    assert_eq!(
        remaining_today(&Capacity {
            backlog: Some((5_000, 0)),
            ..capacity()
        }),
        15,
        "a backlog target of 0 is no limit"
    );
}
