use jt_capability::CapabilityId;
use jt_strategy::{ChannelChoice, ContentTypeShare, HypothesisCadence, HypothesisId, LaneKind};
use jt_studio::*;
use jt_tenancy::WorkspaceId;
use time::{Duration, macros::datetime};
use uuid::Uuid;

fn input() -> PlanningInput {
    let h = HypothesisId(Uuid::from_u128(1));
    let ws = WorkspaceId(Uuid::from_u128(2));
    PlanningInput {
        now: datetime!(2026-10-25 21:00 UTC),
        lanes: vec![PlanningLane {
            hypothesis_id: h,
            lane: LaneKind::Organic,
            cadence: HypothesisCadence {
                slots_per_week: 7,
                exploration_bps: 0,
                content_types: vec![ContentTypeShare {
                    key: "text".into(),
                    min_bps: 0,
                    max_bps: 10000,
                }],
            },
            channel: "any".into(),
        }],
        selected_channels: vec![ChannelChoice {
            channel: "x".into(),
            group_id: None,
            rationale: String::new(),
        }],
        paid_enabled: false,
        accounts: vec![PlanningAccount {
            capability_id: CapabilityId(Uuid::from_u128(3)),
            channel: "x".into(),
            group_ids: vec![],
            lane: LaneKind::Organic,
        }],
        arms: (4..6)
            .map(|id| {
                Arm::new(
                    ArmId(Uuid::from_u128(id)),
                    ws,
                    ArmKey {
                        hypothesis_id: h,
                        content_type: "text".into(),
                        channel: "x".into(),
                        lane: LaneKind::Organic,
                    },
                )
                .unwrap()
            })
            .collect(),
        existing: vec![],
        trends: vec![],
    }
}
#[test]
fn thompson_selection_and_uniform_exploration_are_injected() {
    let i = input();
    assert_eq!(
        select_arm(
            &i.arms,
            &[0.2, 0.8],
            0.0,
            0.0,
            &LearningPolicy { exploration_bps: 0 }
        )
        .unwrap(),
        i.arms[1].id
    );
    assert_eq!(
        select_arm(
            &i.arms,
            &[0.2, 0.8],
            0.0,
            0.0,
            &LearningPolicy {
                exploration_bps: 10000
            }
        )
        .unwrap(),
        i.arms[0].id
    );
    let mut arms = i.arms.clone();
    arms.reverse();
    assert_eq!(
        select_arm(
            &arms,
            &[0.5, 0.5],
            0.5,
            0.0,
            &LearningPolicy { exploration_bps: 0 }
        )
        .unwrap(),
        i.arms[0].id
    );
    assert!(
        select_arm(
            &i.arms,
            &[f64::NAN, 0.8],
            0.5,
            0.0,
            &LearningPolicy { exploration_bps: 0 }
        )
        .is_err()
    );
}
#[test]
fn plan_respects_seven_days_cadence_and_type_shares() {
    let mut i = input();
    i.lanes[0].cadence.content_types = vec![
        ContentTypeShare {
            key: "text".into(),
            min_bps: 4000,
            max_bps: 6000,
        },
        ContentTypeShare {
            key: "video".into(),
            min_bps: 4000,
            max_bps: 6000,
        },
    ];
    i.arms[1].key.content_type = "video".into();
    let slots = plan_week(&i, &[0.5; 100]).unwrap();
    assert_eq!(slots.len(), 7);
    assert_eq!(slots.iter().filter(|s| s.arm_id == i.arms[0].id).count(), 4);
    for (n, s) in slots.iter().enumerate() {
        assert_eq!(s.scheduled_at, i.now + Duration::days(n as i64));
        assert_eq!(s.ordinal, n as u16);
    }
    i.lanes[0].cadence.slots_per_week = 1;
    assert!(matches!(
        plan_week(&i, &[0.5; 100]),
        Err(StudioError::InvalidPlanning(_))
    ));
}
#[test]
fn planning_uses_only_selected_group_accounts() {
    let mut i = input();
    let group = Uuid::from_u128(9);
    i.selected_channels[0].group_id = Some(group);
    assert!(plan_week(&i, &[0.5; 100]).unwrap().is_empty());
    i.accounts[0].group_ids.push(group);
    let other = PlanningAccount {
        capability_id: CapabilityId(Uuid::from_u128(1)),
        group_ids: vec![],
        ..i.accounts[0].clone()
    };
    i.accounts.push(other);
    assert!(
        plan_week(&i, &[0.5; 100])
            .unwrap()
            .iter()
            .all(|s| s.capability_id == i.accounts[0].capability_id)
    );
}
#[test]
fn same_and_overlapping_plan_runs_do_not_duplicate_slots() {
    let mut i = input();
    let first = plan_week(&i, &[0.5; 100]).unwrap();
    i.existing = first
        .iter()
        .map(|s| ExistingPosition {
            hypothesis_id: i.lanes[0].hypothesis_id,
            lane: LaneKind::Organic,
            week_start: istanbul_week_start(s.scheduled_at),
            ordinal: s.ordinal,
            arm_id: s.arm_id,
        })
        .collect();
    assert!(plan_week(&i, &[0.9; 100]).unwrap().is_empty());
    i.now += Duration::hours(1);
    let second = plan_week(&i, &[0.9; 100]).unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].scheduled_at, datetime!(2026-11-01 21:00 UTC));
}
#[test]
fn timezone_and_overdue_slots_match_ruling() {
    assert_eq!(
        istanbul_week_start(datetime!(2026-10-25 20:59:59 UTC)),
        datetime!(2026-10-18 21:00 UTC)
    );
    assert_eq!(
        istanbul_week_start(datetime!(2026-10-25 21:00 UTC)),
        datetime!(2026-10-25 21:00 UTC)
    );
    let mut i = input();
    i.now += Duration::hours(1);
    let s = plan_week(&i, &[0.5; 100]).unwrap();
    assert_eq!(s.len(), 7);
    assert_eq!(s[0].scheduled_at, datetime!(2026-10-26 21:00 UTC));
}

#[test]
fn trend_recording_does_not_change_selection() {
    let mut i = input();
    let before = plan_week(&i, &[0.5; 100]).unwrap();
    i.trends.push(TrendSignal {
        id: TrendSignalId(Uuid::from_u128(10)),
        workspace_id: i.arms[0].workspace_id,
        born_version_id: jt_strategy::StrategyVersionId(Uuid::from_u128(11)),
        hypothesis_id: i.lanes[0].hypothesis_id,
        channel: "x".into(),
        summary: "Strong new trend".into(),
        source_url: None,
        observed_at: i.now,
        actor: jt_ledger::Actor::System {
            component: "fixture".into(),
        },
    });
    assert_eq!(plan_week(&i, &[0.5; 100]).unwrap(), before);
    i.trends[0].summary = "Opposite trend".into();
    assert_eq!(plan_week(&i, &[0.5; 100]).unwrap(), before);
}
#[test]
fn quotas_constrain_exploration_and_posterior_allocation() {
    let mut i = input();
    i.lanes[0].cadence.slots_per_week = 10;
    i.lanes[0].cadence.exploration_bps = 10000;
    i.lanes[0].cadence.content_types = vec![
        ContentTypeShare {
            key: "text".into(),
            min_bps: 2000,
            max_bps: 5000,
        },
        ContentTypeShare {
            key: "video".into(),
            min_bps: 2000,
            max_bps: 8000,
        },
    ];
    i.arms[0].alpha = 9.0;
    i.arms[0].beta = 1.0;
    i.arms[1].alpha = 1.0;
    i.arms[1].beta = 9.0;
    i.arms[1].key.content_type = "video".into();
    let slots = plan_week(&i, &[0.0; 100]).unwrap();
    assert_eq!(slots.len(), 10);
    assert_eq!(slots.iter().filter(|s| s.arm_id == i.arms[0].id).count(), 5);
}
