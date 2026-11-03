//! The agents' playbook (spec 2026-10-30-leads-pool-outreach-design.md §3.8) and the pool's
//! pending work (§3.17: `research_due`, `prospects_to_score`). Every value is invented.

mod support;

use jt_app::ports::UnitOfWork;
use jt_app::usecases::jobs::run_research_plan;
use jt_app::usecases::prospects;
use jt_app::usecases::work::{self, WorkKind};
use jt_ledger::Actor;
use jt_prospects::{
    CreateInput, EntityKind, FieldInput, KeyKind, ReasonInput, ScoreInput, SourceRefInput, TaskKind,
};
use jt_strategy::{
    Area, Criterion, IcpEntry, Prospecting, Rubric, Sections, Segment, StrategyVersion,
    StrategyVersionId, VersionStatus,
};
use jt_tenancy::WorkspaceStatus;
use jt_testkit::fakes::FIXED_NOW;
use support::*;
use time::Duration;

fn rubric() -> Rubric {
    Rubric {
        criteria: vec![Criterion {
            key: "fit".into(),
            description: "serves coffee".into(),
            weight: 100,
        }],
        qualify_at: 60,
    }
}

fn entry(backlog_target: u16) -> IcpEntry {
    IcpEntry {
        key: "kafeler".into(),
        segment_key: "kafeler".into(),
        sectors: vec!["kafe".into()],
        areas: vec![Area {
            city: "İstanbul".into(),
            district: None,
        }],
        signals: vec![],
        exclusions: vec![],
        size_hint: String::new(),
        language: Some("tr".into()),
        daily_cap: 20,
        backlog_target,
    }
}

/// Puts an approved version with `icp` in force and runs the planner.
async fn approve(w: &World, icp: Vec<IcpEntry>) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: w.ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections {
                audience: vec![Segment {
                    key: "kafeler".into(),
                    name: "Kafeler".into(),
                    description: "mahalle kafeleri".into(),
                }],
                prospecting: Prospecting {
                    icp,
                    rubric: rubric(),
                },
                ..Sections::default()
            },
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: w.owner },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(w.owner),
            archived_at: None,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    run_research_plan(&w.deps, FIXED_NOW).await;
    id
}

fn prospect(name: &str, phone: &str) -> CreateInput {
    CreateInput {
        business_name: name.into(),
        entity_kind: EntityKind::LegalEntity,
        sector: Some("kafe".into()),
        city: Some("İstanbul".into()),
        district: None,
        language: None,
        segment_key: Some("kafeler".into()),
        country: None,
        labels: vec![],
        phone: Some(FieldInput {
            value: phone.into(),
            sources: vec![SourceRefInput::Url {
                url: "https://ornek.example.invalid/iletisim".into(),
                note: None,
            }],
            captured_at: FIXED_NOW - Duration::days(1),
        }),
        email: None,
        website: None,
        instagram: None,
        tiktok: None,
        address: None,
        contact_person: None,
        size: None,
        signals: vec![],
        notes: String::new(),
        research_task_id: None,
        discovered_at: vec![],
        distinct_from: vec![],
        request_key: None,
    }
}

fn pool_items(out: &work::PendingOut) -> Vec<(WorkKind, u8)> {
    out.items
        .iter()
        .filter(|i| {
            matches!(
                i.kind,
                WorkKind::ResearchDue { .. } | WorkKind::ProspectsToScore { .. }
            )
        })
        .map(|i| (i.kind.clone(), i.priority))
        .collect()
}

/// A world whose workspace is `active` (a registration starts it `pending_payment`): the
/// planner and the pool's work items run only there.
async fn active_world() -> World {
    let w = world().await;
    set_status(&w, WorkspaceStatus::Active).await;
    w
}

async fn set_status(w: &World, status: WorkspaceStatus) {
    let mut platform = w.uow.platform().await.unwrap();
    platform
        .workspace_set_status(
            w.ws,
            status,
            "test status",
            &Actor::System {
                component: "test".into(),
            },
        )
        .await
        .unwrap();
    platform.commit().await.unwrap();
}

#[tokio::test]
async fn the_playbook_carries_its_text_the_rubric_digest_and_what_remains() {
    let w = active_world().await;
    approve(&w, vec![entry(0)]).await;
    let agent = w.agent(&["prospects.work"]).await;
    prospects::create(&w.deps, &agent, prospect("Örnek Kafe", "0500 000 00 01"))
        .await
        .unwrap();
    let out = prospects::playbook(&w.deps, &agent).await.unwrap();
    assert_eq!(out.version, jt_prospects::playbook::PLAYBOOK_VERSION);
    assert_eq!(out.text, jt_prospects::playbook::TEXT);
    let ws = &out.workspace;
    assert!(ws.prospecting_on);
    assert_eq!(ws.icp, [entry(0)]);
    assert_eq!(ws.rubric, rubric());
    assert_eq!(
        ws.rubric_digest.as_deref(),
        Some(prospects::rubric_digest(&rubric()).as_str())
    );
    assert_eq!(ws.caps.daily_prospects, 500);
    assert_eq!(ws.caps.recorded_today, 1);
    assert_eq!(ws.caps.timezone, "Europe/Istanbul");
    assert_eq!(ws.remaining_today.len(), 1);
    assert_eq!(ws.remaining_today[0].icp_key.as_deref(), Some("kafeler"));
    assert_eq!(ws.remaining_today[0].remaining, 20);
    assert_eq!(
        (ws.retention_days.rejected, ws.retention_days.unpromoted),
        (30, 180)
    );
    assert_eq!(
        ws.blocklist_rules.listed,
        [
            KeyKind::Phone,
            KeyKind::Email,
            KeyKind::Instagram,
            KeyKind::Tiktok
        ]
    );
    assert_eq!(
        ws.blocklist_rules.flagged,
        [KeyKind::Domain, KeyKind::NameCity]
    );
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(prospects::playbook(&w.deps, &rep).await),
        "prospects.work",
    );
}

#[tokio::test]
async fn the_playbook_says_when_prospecting_is_off() {
    let w = active_world().await;
    w.approve_strategy().await;
    let out = prospects::playbook(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(!out.workspace.prospecting_on);
    assert!(out.workspace.icp.is_empty());
    assert_eq!(out.workspace.rubric_digest, None);
    assert!(out.workspace.remaining_today.is_empty());
}

#[tokio::test]
async fn research_due_lists_the_open_tasks_with_what_remains() {
    let w = active_world().await;
    approve(&w, vec![entry(0)]).await;
    let task = w.uow.snapshot().prospects.tasks[0].clone();
    assert!(matches!(task.kind, TaskKind::Standing { .. }));
    let agent = w.agent(&["prospects.work", "workspace.read"]).await;
    let out = work::pending(&w.deps, &agent).await.unwrap();
    assert_eq!(
        pool_items(&out),
        [(
            WorkKind::ResearchDue {
                task_id: task.id,
                remaining_today: 20
            },
            3
        )]
    );
    let item = out
        .items
        .iter()
        .find(|i| matches!(i.kind, WorkKind::ResearchDue { .. }))
        .unwrap();
    assert!(
        item.hint.contains("jeeta.prospects.create"),
        "{}",
        item.hint
    );
    assert_eq!(item.kind.cleared_by(), "prospects.create");
    let wire = serde_json::to_value(item).unwrap();
    assert_eq!(wire["kind"], "research_due");
    assert_eq!(wire["remaining_today"], 20);
}

#[tokio::test]
async fn no_research_is_due_while_the_backlog_is_full() {
    let w = active_world().await;
    approve(&w, vec![entry(1)]).await;
    let agent = w.agent(&["prospects.work", "workspace.read"]).await;
    prospects::create(&w.deps, &agent, prospect("Örnek Kafe", "0500 000 00 01"))
        .await
        .unwrap();
    let out = work::pending(&w.deps, &agent).await.unwrap();
    assert!(
        !pool_items(&out)
            .iter()
            .any(|(k, _)| matches!(k, WorkKind::ResearchDue { .. })),
        "{:?}",
        out.items
    );
}

#[tokio::test]
async fn prospects_to_score_counts_the_new_ones_without_a_current_score() {
    let w = active_world().await;
    approve(&w, vec![entry(0)]).await;
    let agent = w.agent(&["prospects.work", "workspace.read"]).await;
    let mut ids = Vec::new();
    for n in 0..3 {
        ids.push(
            prospects::create(
                &w.deps,
                &agent,
                prospect(&format!("Kafe {n}"), &format!("0500 000 00 0{n}")),
            )
            .await
            .unwrap()
            .prospect
            .id,
        );
    }
    // One scored under the current rubric (below qualify_at, so still new).
    prospects::score(
        &w.deps,
        &agent,
        ids[0],
        ScoreInput {
            score: 40,
            reasons: vec![ReasonInput {
                criterion: "fit".into(),
                points: 40,
                evidence: "a small coffee corner".into(),
                source: None,
            }],
            rubric_digest: prospects::rubric_digest(&rubric()),
        },
    )
    .await
    .unwrap();
    let out = work::pending(&w.deps, &agent).await.unwrap();
    let item = out
        .items
        .iter()
        .find(|i| matches!(i.kind, WorkKind::ProspectsToScore { .. }))
        .unwrap();
    assert_eq!(item.kind, WorkKind::ProspectsToScore { count: 2 });
    assert_eq!(item.priority, 3);
    assert_eq!(item.kind.cleared_by(), "prospects.score");
    assert!(item.hint.contains("rubric_digest"), "{}", item.hint);
}

#[tokio::test]
async fn pool_items_are_hidden_without_prospects_work() {
    let w = active_world().await;
    approve(&w, vec![entry(0)]).await;
    let rep = w.member("rep").await;
    let out = work::pending(&w.deps, &rep).await.unwrap();
    assert!(pool_items(&out).is_empty(), "{:?}", out.items);
    let reader = w.agent(&["workspace.read"]).await;
    let out = work::pending(&w.deps, &reader).await.unwrap();
    assert!(pool_items(&out).is_empty(), "{:?}", out.items);
}

#[tokio::test]
async fn pool_items_follow_the_workspace_status() {
    let w = active_world().await;
    approve(&w, vec![entry(0)]).await;
    let out = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(!pool_items(&out).is_empty(), "listed while active");
    set_status(&w, WorkspaceStatus::PendingPayment).await;
    let out = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(pool_items(&out).is_empty(), "{:?}", out.items);
}

#[tokio::test]
async fn no_pool_items_while_prospecting_is_off() {
    let w = active_world().await;
    approve(&w, vec![]).await;
    prospects::create(
        &w.deps,
        &w.owner_ctx,
        prospect("Örnek Kafe", "0500 000 00 01"),
    )
    .await
    .unwrap();
    let out = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(pool_items(&out).is_empty(), "{:?}", out.items);
}
