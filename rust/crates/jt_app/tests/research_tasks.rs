//! Research tasks (spec 2026-10-30-leads-pool-outreach-design.md §3.7): the planner's standing
//! tasks, ad-hoc tasks, what a task may still record today, the advisory claim and closing.
//! Every value is invented.

mod support;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::usecases::jobs::{Job, run_research_plan};
use jt_app::usecases::prospects;
use jt_app::usecases::research::{self, CloseInput, CloseOutcome, CreateInput, ListInput};
use jt_ledger::Actor;
use jt_prospects::{
    Brief, CreateInput as ProspectInput, EntityKind, FieldInput, Recorder, ResearchTask,
    ResearchTaskId, SourceRefInput, TaskKind, TaskStatus,
};
use jt_strategy::{
    Area, Criterion, IcpEntry, Prospecting, Rubric, Sections, Segment, StrategyVersion,
    StrategyVersionId, VersionStatus,
};
use jt_tenancy::WorkspaceStatus;
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::Duration;
use time::macros::datetime;

fn entry(key: &str, daily_cap: u16, backlog_target: u16) -> IcpEntry {
    IcpEntry {
        key: key.into(),
        segment_key: "kafeler".into(),
        sectors: vec!["kafe".into()],
        areas: vec![Area {
            city: "İstanbul".into(),
            district: None,
        }],
        signals: vec!["yeni şube".into()],
        exclusions: vec![],
        size_hint: String::new(),
        language: Some("tr".into()),
        daily_cap,
        backlog_target,
    }
}

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

/// Puts version `number` with `icp` in force (the previous approved one archived).
async fn approve(w: &World, number: i32, icp: Vec<IcpEntry>) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    if let Some(previous) = t.strategy().current_approved().await.unwrap() {
        t.strategy()
            .set_status(
                previous.id,
                VersionStatus::Archived,
                FIXED_NOW,
                Some(w.owner),
            )
            .await
            .unwrap();
    }
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: w.ws,
            number,
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
    id
}

fn tasks(w: &World) -> Vec<ResearchTask> {
    w.uow.snapshot().prospects.tasks
}

async fn plan(w: &World, now: time::OffsetDateTime) {
    run_research_plan(&w.deps, now).await;
}

fn brief() -> Brief {
    Brief {
        segment_key: Some("kafeler".into()),
        sectors: vec!["pastane".into()],
        areas: vec![Area {
            city: "Ankara".into(),
            district: Some("Çankaya".into()),
        }],
        ..Brief::default()
    }
}

fn ad_hoc(target_count: u16, daily_cap: u16) -> CreateInput {
    CreateInput {
        brief: brief(),
        target_count,
        daily_cap,
        request_key: None,
    }
}

fn assert_refused(e: &AppError, code: ErrorCode, why: &str) {
    assert_eq!(e.code, code, "{e:?}");
    assert_eq!(e.details["reason"], why, "{e:?}");
}

fn prospect(name: &str, phone: &str, task: Option<ResearchTaskId>) -> ProspectInput {
    ProspectInput {
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
        research_task_id: task,
        discovered_at: vec![],
        distinct_from: vec![],
        request_key: None,
    }
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
async fn approval_creates_one_standing_task_per_icp_entry_and_planning_is_idempotent() {
    let w = active_world().await;
    let version = approve(&w, 1, vec![entry("kafeler", 20, 0), entry("merkez", 5, 0)]).await;
    plan(&w, FIXED_NOW).await;
    let all = tasks(&w);
    assert_eq!(all.len(), 2);
    for t in &all {
        assert_eq!(t.strategy_version_id, version);
        assert_eq!(t.status, TaskStatus::Open);
        assert_eq!(
            t.created_by,
            Recorder::System {
                job: "research_plan".into()
            }
        );
        assert_eq!(t.rubric_digest, prospects::rubric_digest(&rubric()));
        assert_eq!(t.brief.segment_key.as_deref(), Some("kafeler"));
    }
    let caps: Vec<(String, u16)> = all
        .iter()
        .map(|t| match &t.kind {
            TaskKind::Standing { icp_key } => (icp_key.clone(), t.daily_cap),
            other => panic!("{other:?}"),
        })
        .collect();
    assert!(caps.contains(&("kafeler".into(), 20)));
    assert!(caps.contains(&("merkez".into(), 5)));
    plan(&w, FIXED_NOW + Duration::hours(1)).await;
    assert_eq!(tasks(&w).len(), 2, "planning again creates nothing");
    let created = w.entries("research.task_created");
    assert_eq!(created.len(), 2);
    assert!(matches!(created[0].actor, Actor::System { .. }));
    assert_eq!(created[0].payload["kind"], "standing");
    assert_eq!(Job::ResearchPlan.name(), "research_plan");
}

#[tokio::test]
async fn a_newer_version_supersedes_the_old_standing_tasks_but_not_ad_hoc_ones() {
    let w = active_world().await;
    approve(&w, 1, vec![entry("kafeler", 20, 0), entry("merkez", 5, 0)]).await;
    plan(&w, FIXED_NOW).await;
    let asked = research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(10, 5))
        .await
        .unwrap();
    let v2 = approve(&w, 2, vec![entry("kafeler", 30, 0)]).await;
    plan(&w, FIXED_NOW + Duration::hours(1)).await;
    let all = tasks(&w);
    let open: Vec<&ResearchTask> = all
        .iter()
        .filter(|t| t.status == TaskStatus::Open)
        .collect();
    assert_eq!(open.len(), 2, "v2's one standing task and the ad-hoc one");
    assert!(open.iter().any(|t| t.id == asked.task.id));
    let standing = open
        .iter()
        .find(|t| matches!(t.kind, TaskKind::Standing { .. }))
        .unwrap();
    assert_eq!(standing.strategy_version_id, v2);
    assert_eq!(standing.daily_cap, 30);
    assert_eq!(
        all.iter()
            .filter(|t| t.status == TaskStatus::Superseded)
            .count(),
        2
    );
    let closed = w.entries("research.task_closed");
    assert_eq!(closed.len(), 2);
    assert!(closed.iter().all(|e| e.payload["outcome"] == "superseded"));
    // Turning prospecting off supersedes the last standing task and creates none.
    approve(&w, 3, vec![]).await;
    plan(&w, FIXED_NOW + Duration::hours(2)).await;
    let open: Vec<ResearchTask> = tasks(&w)
        .into_iter()
        .filter(|t| t.status == TaskStatus::Open)
        .collect();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].id, asked.task.id);
}

#[tokio::test]
async fn the_planner_runs_only_in_active_workspaces_with_an_approved_strategy() {
    let w = active_world().await;
    let report = run_research_plan(&w.deps, FIXED_NOW).await;
    assert_eq!((report.touched, report.skipped), (0, 1), "no strategy yet");
    approve(&w, 1, vec![entry("kafeler", 20, 0)]).await;
    set_status(&w, WorkspaceStatus::Suspended).await;
    plan(&w, FIXED_NOW).await;
    assert!(tasks(&w).is_empty(), "a suspended workspace is not planned");
}

#[tokio::test]
async fn ad_hoc_tasks_need_prospecting_and_a_valid_brief() {
    let w = active_world().await;
    w.approve_strategy().await;
    let e = err(research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(10, 5)).await);
    assert_refused(&e, ErrorCode::Conflict, "prospecting_off");
    approve(&w, 2, vec![entry("kafeler", 20, 0)]).await;
    let mut no_sector = ad_hoc(10, 5);
    no_sector.brief.sectors.clear();
    assert_invalid(
        &err(research::tasks_create(&w.deps, &w.owner_ctx, no_sector).await),
        "sectors",
    );
    assert_invalid(
        &err(research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(0, 5)).await),
        "target_count",
    );
    assert_invalid(
        &err(research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(10, 501)).await),
        "daily_cap",
    );
    let mut stray = ad_hoc(10, 5);
    stray.brief.segment_key = Some("bilinmeyen".into());
    let e = err(research::tasks_create(&w.deps, &w.owner_ctx, stray).await);
    assert_invalid(&e, "segment_key");
    assert_eq!(e.details["reason"], "unknown_segment");
    let unknown: Result<CreateInput, _> = serde_json::from_value(json!({
        "brief": {"sectors": ["kafe"], "areas": [{"city": "Ankara"}]},
        "target_count": 1, "daily_cap": 1, "recorder": {},
    }));
    assert!(unknown.is_err(), "the recorder is never input");
    let agent = w.agent(&["prospects.work"]).await;
    let out = research::tasks_create(&w.deps, &agent, ad_hoc(10, 5))
        .await
        .unwrap();
    assert_eq!(out.task.kind, TaskKind::AdHoc { target_count: 10 });
    assert!(out.task.created_by.is_agent());
    assert_eq!(out.task.rubric_digest, prospects::rubric_digest(&rubric()));
    assert_eq!(out.remaining_today, 5);
    let entry = w.entries("research.task_created").pop().unwrap();
    assert_eq!(entry.payload["kind"], "ad_hoc");
    assert!(
        !entry.payload.to_string().contains("pastane"),
        "a brief's text never goes into the ledger"
    );
}

#[tokio::test]
async fn a_request_key_replays_the_task_it_created() {
    let w = active_world().await;
    approve(&w, 1, vec![entry("kafeler", 20, 0)]).await;
    let mut input = ad_hoc(10, 5);
    input.request_key = Some("t-1".into());
    let first = research::tasks_create(&w.deps, &w.owner_ctx, input.clone())
        .await
        .unwrap();
    let again = research::tasks_create(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap();
    assert_eq!(again, first);
    assert_eq!(w.entries("research.task_created").len(), 1);
    let stored: Vec<serde_json::Value> = w
        .uow
        .snapshot()
        .inbox
        .request_keys
        .iter()
        .map(|k| k.response.clone())
        .collect();
    assert_eq!(stored, [json!({ "task_id": first.task.id })]);
}

#[tokio::test]
async fn an_ad_hoc_task_completes_at_its_target() {
    let w = active_world().await;
    approve(&w, 1, vec![entry("kafeler", 20, 0)]).await;
    let task = research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(2, 5))
        .await
        .unwrap()
        .task;
    for n in 0..2 {
        prospects::create(
            &w.deps,
            &w.owner_ctx,
            prospect(
                &format!("Kafe {n}"),
                &format!("0500 000 00 0{n}"),
                Some(task.id),
            ),
        )
        .await
        .unwrap();
    }
    let out = research::tasks_get(&w.deps, &w.owner_ctx, task.id)
        .await
        .unwrap();
    assert_eq!(out.task.status, TaskStatus::Done);
    assert_eq!(out.found, 2);
    assert_eq!(out.remaining_today, 0);
    let closed = w.entries("research.task_closed");
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].payload["auto"], true);
    let e = err(prospects::create(
        &w.deps,
        &w.owner_ctx,
        prospect("Kafe 3", "0500 000 00 03", Some(task.id)),
    )
    .await);
    assert_refused(&e, ErrorCode::Conflict, "task_closed");
}

#[tokio::test]
async fn remaining_today_counts_the_local_day() {
    // 23:30 UTC on the 30th: already the 31st in Istanbul (UTC+3), still the 30th in New York.
    for (tz, recorded_at, same_day, next_day) in [
        (
            "Europe/Istanbul",
            datetime!(2026-10-30 18:00 UTC),
            datetime!(2026-10-30 20:30 UTC),
            datetime!(2026-10-30 23:30 UTC),
        ),
        (
            "America/New_York",
            datetime!(2026-10-30 18:00 UTC),
            datetime!(2026-10-30 23:30 UTC),
            datetime!(2026-10-31 04:30 UTC),
        ),
    ] {
        let w = active_world().await;
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        r.workspace_policy()
            .patch_leads(json!({ "timezone": tz }), FIXED_NOW)
            .await
            .unwrap();
        r.commit().await.unwrap();
        approve(&w, 1, vec![entry("kafeler", 20, 0)]).await;
        let task = research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(100, 3))
            .await
            .unwrap()
            .task;
        let mut input = prospect("Kafe", "0500 000 00 01", Some(task.id));
        input.phone.as_mut().unwrap().captured_at = recorded_at - Duration::hours(1);
        prospects::create(&w.deps, &at(&w.owner_ctx, recorded_at), input)
            .await
            .unwrap();
        let left = |now| {
            let w = &w;
            async move {
                research::tasks_get(&w.deps, &at(&w.owner_ctx, now), task.id)
                    .await
                    .unwrap()
                    .remaining_today
            }
        };
        assert_eq!(left(same_day).await, 2, "{tz}: the same local day");
        assert_eq!(left(next_day).await, 3, "{tz}: the next local day");
    }
}

#[tokio::test]
async fn a_full_backlog_zeroes_a_standing_tasks_remaining() {
    let w = active_world().await;
    approve(&w, 1, vec![entry("kafeler", 20, 2)]).await;
    plan(&w, FIXED_NOW).await;
    let task = tasks(&w).remove(0);
    let left = || async {
        research::tasks_get(&w.deps, &w.owner_ctx, task.id)
            .await
            .unwrap()
            .remaining_today
    };
    assert_eq!(left().await, 20);
    // Two unpromoted prospects of the segment, recorded for no task, fill the backlog.
    for n in 0..2 {
        prospects::create(
            &w.deps,
            &w.owner_ctx,
            prospect(&format!("Kafe {n}"), &format!("0500 000 00 0{n}"), None),
        )
        .await
        .unwrap();
    }
    assert_eq!(left().await, 0);
    // A rejected one leaves the backlog.
    let one = w.uow.snapshot().prospects.prospects[0].clone();
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        one.id,
        prospects::DecideInput {
            decision: prospects::DecideKind::Reject,
            reason: Some(jt_prospects::RejectReason::NotIcp),
            note: None,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(left().await, 20);
}

#[tokio::test]
async fn a_claim_is_a_two_hour_lease_and_another_recorder_is_told() {
    let w = active_world().await;
    approve(&w, 1, vec![entry("kafeler", 20, 0)]).await;
    let task = research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(10, 5))
        .await
        .unwrap()
        .task;
    let a = w.agent(&["prospects.work"]).await;
    let b = w.agent(&["prospects.work"]).await;
    let first = research::tasks_claim(&w.deps, &a, task.id).await.unwrap();
    assert!(first.claimed && !first.held_by_other);
    assert_eq!(first.claim.until, FIXED_NOW + Duration::hours(2));
    let other = research::tasks_claim(&w.deps, &b, task.id).await.unwrap();
    assert!(!other.claimed && other.held_by_other);
    assert_eq!(other.claim, first.claim, "the other's claim stays");
    // The holder renews; once it lapses, another takes it.
    let later = at(&a, FIXED_NOW + Duration::hours(1));
    let renewed = research::tasks_claim(&w.deps, &later, task.id)
        .await
        .unwrap();
    assert_eq!(renewed.claim.until, FIXED_NOW + Duration::hours(3));
    let lapsed = at(&b, FIXED_NOW + Duration::hours(3));
    assert!(
        research::tasks_claim(&w.deps, &lapsed, task.id)
            .await
            .unwrap()
            .claimed
    );
    assert_eq!(w.entries("research.task_claimed").len(), 3);
    // Anyone may still record for a claimed task: the claim is advisory.
    prospects::create(
        &w.deps,
        &a,
        prospect("Kafe", "0500 000 00 01", Some(task.id)),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn closing_needs_prospects_work_and_an_open_ad_hoc_task() {
    let w = active_world().await;
    approve(&w, 1, vec![entry("kafeler", 20, 0)]).await;
    plan(&w, FIXED_NOW).await;
    let standing = tasks(&w).remove(0);
    let task = research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(10, 5))
        .await
        .unwrap()
        .task;
    let close = |outcome| CloseInput {
        outcome,
        note: Some("enough for now".into()),
    };
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(research::tasks_close(&w.deps, &rep, task.id, close(CloseOutcome::Done)).await),
        "prospects.work",
    );
    assert_forbidden(
        &err(research::tasks_list(&w.deps, &rep, ListInput::default()).await),
        "prospects.work",
    );
    let e = err(research::tasks_close(
        &w.deps,
        &w.owner_ctx,
        standing.id,
        close(CloseOutcome::Canceled),
    )
    .await);
    assert_refused(&e, ErrorCode::Conflict, "standing_task");
    let out = research::tasks_close(
        &w.deps,
        &w.owner_ctx,
        task.id,
        close(CloseOutcome::Canceled),
    )
    .await
    .unwrap();
    assert_eq!(out.task.status, TaskStatus::Canceled);
    assert_eq!(out.task.close_note, "enough for now");
    assert_eq!(out.task.closed_at, Some(FIXED_NOW));
    let e =
        err(research::tasks_close(&w.deps, &w.owner_ctx, task.id, close(CloseOutcome::Done)).await);
    assert_refused(&e, ErrorCode::Conflict, "task_closed");
    let e = err(research::tasks_claim(&w.deps, &w.owner_ctx, task.id).await);
    assert_refused(&e, ErrorCode::Conflict, "task_closed");
    let closed = w.entries("research.task_closed").pop().unwrap();
    assert_eq!(
        closed.payload,
        json!({ "task_id": task.id, "outcome": "canceled" })
    );
}

#[tokio::test]
async fn the_list_and_one_task_carry_remaining_and_found() {
    let w = active_world().await;
    approve(&w, 1, vec![entry("kafeler", 20, 0)]).await;
    plan(&w, FIXED_NOW).await;
    let task = research::tasks_create(&w.deps, &w.owner_ctx, ad_hoc(10, 5))
        .await
        .unwrap()
        .task;
    prospects::create(
        &w.deps,
        &w.owner_ctx,
        prospect("Kafe", "0500 000 00 01", Some(task.id)),
    )
    .await
    .unwrap();
    let page = research::tasks_list(&w.deps, &w.owner_ctx, ListInput::default())
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].task.id, task.id, "newest first");
    assert_eq!(page.items[0].remaining_today, 4);
    assert_eq!(
        page.items[1].remaining_today, 20,
        "the standing task recorded none (the workspace's ceiling is far)"
    );
    let open = research::tasks_list(
        &w.deps,
        &w.owner_ctx,
        ListInput {
            status: Some(TaskStatus::Done),
            ..ListInput::default()
        },
    )
    .await
    .unwrap();
    assert!(open.items.is_empty());
    let out = research::tasks_get(&w.deps, &w.owner_ctx, task.id)
        .await
        .unwrap();
    assert_eq!(out.found, 1);
    assert_eq!(out.prospects.len(), 1);
    assert_eq!(
        out.prospects[0].purge_after,
        Some(FIXED_NOW + Duration::days(180))
    );
    let rows = serde_json::to_value(&out.prospects).unwrap();
    assert!(
        rows[0].get("contact").is_none(),
        "rows carry no contact values"
    );
    let e = err(research::tasks_get(&w.deps, &w.owner_ctx, ResearchTaskId::new_v7()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
}
