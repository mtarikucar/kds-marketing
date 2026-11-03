//! Lead distribution (spec 2026-10-30-leads-pool-outreach-design.md §3.9): rules, the default
//! rule, capacity, hours, SLA reassignment, the manual override, and the rule that no open
//! journey is ever silently ownerless. Every value is invented.

mod support;

use jt_app::ctx::Ctx;
use jt_app::ports::distribution::AssignmentRow;
use jt_app::ports::{DistributionMode, UnitOfWork, UserRow};
use jt_app::usecases::distribution::{self, BackfillInput, RepSetInput, RuleInput, RulesSetInput};
use jt_app::usecases::inbox::{journeys, people, tasks};
use jt_app::usecases::jobs::{self, run_lead_distribution};
use jt_app::usecases::prospects::{self, PromoteInput};
use jt_app::usecases::{team, work};
use jt_capability::Hours;
use jt_inbox::{Cause, JourneyId, Match, MemberPool, Method, PersonId, SourceKind};
use jt_prospects::{CreateInput, EntityKind, FieldInput, SourceRefInput};
use jt_tenancy::{Email, MembershipId, UserId};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::{Duration, OffsetDateTime};

/// The world, its workspace active: the `lead_distribution` job runs for active workspaces only
/// (a registration starts `pending_payment`).
async fn active_world() -> World {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w
}

/// A new active member with role `role_key`, numbered `n` (unique email).
async fn member(w: &World, role_key: &str, n: u32) -> Ctx {
    let role = {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.roles().find_by_key(role_key).await.unwrap().unwrap()
    };
    let user = UserId::new_v7();
    let mut u = w.uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: user,
            email: Email::parse(&format!("{role_key}{n}@acme.example")).unwrap(),
            password_hash: "plain:pw".into(),
            display_name: format!("{role_key} {n}"),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    u.memberships_insert_active(MembershipId::new_v7(), w.ws, user, role.id, FIXED_NOW)
        .await
        .unwrap();
    u.commit().await.unwrap();
    human(w.ws, user, role_key, role.permissions)
}

fn user_of(ctx: &Ctx) -> UserId {
    match ctx.actor {
        jt_ledger::Actor::Human { user_id } => user_id,
        _ => panic!("not a person"),
    }
}

/// A person created by hand with `phone`; their journey.
async fn by_hand(w: &World, phone: &str) -> (PersonId, JourneyId) {
    let person = people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "Arayan",
            "identities": [{"channel": "phone", "value": phone, "capability_id": null}],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person
    .id;
    let journey = w
        .uow
        .snapshot()
        .inbox
        .journeys
        .iter()
        .find(|j| j.person_id == person)
        .unwrap()
        .id;
    (person, journey)
}

/// Runs the job at `now`.
async fn tick(w: &World, now: OffsetDateTime) -> jobs::JobReport {
    run_lead_distribution(&w.deps, now).await
}

fn owner_of(w: &World, journey: JourneyId) -> Option<UserId> {
    w.uow
        .snapshot()
        .inbox
        .journeys
        .iter()
        .find(|j| j.id == journey)
        .unwrap()
        .owner
}

fn decisions(w: &World, journey: JourneyId) -> Vec<AssignmentRow> {
    let mut rows: Vec<AssignmentRow> = w
        .uow
        .snapshot()
        .distribution
        .assignments
        .into_iter()
        .filter(|(_, r)| r.journey_id == journey)
        .map(|(_, r)| r)
        .collect();
    rows.sort_by_key(|r| (r.assigned_at, r.id));
    rows
}

fn live(w: &World, journey: JourneyId) -> AssignmentRow {
    decisions(w, journey)
        .into_iter()
        .find(|r| r.superseded_at.is_none())
        .expect("a live decision")
}

fn rule(name: &str, when: Match, to: MemberPool, sla: Option<u32>) -> RuleInput {
    RuleInput {
        id: None,
        name: name.into(),
        enabled: true,
        when,
        to,
        method: Method::RoundRobin,
        sla_minutes: sla,
    }
}

async fn set_rules(w: &World, rules: Vec<RuleInput>, mode: Option<DistributionMode>) {
    distribution::rules_set(
        &w.deps,
        &w.owner_ctx,
        RulesSetInput {
            rules,
            mode,
            max_reassignments: None,
        },
    )
    .await
    .unwrap();
}

fn profile() -> RepSetInput {
    serde_json::from_value(json!({})).unwrap()
}

async fn set_rep(w: &World, user: UserId, input: RepSetInput) {
    distribution::rep_set(&w.deps, &w.owner_ctx, user, input)
        .await
        .unwrap();
}

/// Makes the owner unavailable, so only the members a test adds are eligible.
async fn owner_away(w: &World) {
    let mut away = profile();
    away.accepting = false;
    set_rep(w, w.owner, away).await;
}

fn field(value: &str) -> Option<FieldInput<String>> {
    Some(FieldInput {
        value: value.into(),
        sources: vec![SourceRefInput::Url {
            url: "https://ornek.example.invalid/iletisim".into(),
            note: None,
        }],
        captured_at: FIXED_NOW - Duration::days(1),
    })
}

/// A prospect in `city` with `phone`, promoted by the owner; its journey.
async fn promoted_in(w: &World, city: &str, phone: &str) -> JourneyId {
    let p = prospects::create(
        &w.deps,
        &w.owner_ctx,
        CreateInput {
            business_name: format!("Kafe {phone}"),
            entity_kind: EntityKind::LegalEntity,
            sector: Some("kafe".into()),
            city: Some(city.into()),
            district: None,
            language: None,
            segment_key: None,
            country: None,
            labels: vec![],
            phone: field(phone),
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
        },
    )
    .await
    .unwrap()
    .prospect;
    let out = prospects::promote(
        &w.deps,
        &w.owner_ctx,
        PromoteInput {
            prospect_ids: vec![p.id],
            request_key: None,
        },
    )
    .await
    .unwrap();
    match &out.items[0] {
        prospects::PromoteOutcome::Promoted { journey_id, .. } => *journey_id,
        other => panic!("{other:?}"),
    }
}

fn kinds(items: &[work::WorkItem]) -> Vec<String> {
    items
        .iter()
        .map(|i| {
            serde_json::to_value(&i.kind).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

#[tokio::test]
async fn solo_owner_gets_everything_without_setup() {
    let w = active_world().await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    assert_eq!(owner_of(&w, j), None);
    tick(&w, FIXED_NOW).await;
    assert_eq!(owner_of(&w, j), Some(w.owner));
    let row = live(&w, j);
    assert_eq!(row.cause, Cause::Default);
    assert_eq!(row.sla_due_at, None);
    // A promotion is assigned inline, before any job runs.
    let promoted = promoted_in(&w, "İstanbul", "+905000000002").await;
    assert_eq!(owner_of(&w, promoted), Some(w.owner));
    // A second tick has nothing to decide.
    let before = w.uow.snapshot().distribution.assignments.len();
    tick(&w, FIXED_NOW + Duration::minutes(1)).await;
    assert_eq!(w.uow.snapshot().distribution.assignments.len(), before);
    assert_eq!(w.entries("distribution.assigned").len(), 2);
}

#[tokio::test]
async fn every_creation_path_ends_owned_or_counted() {
    let w = active_world().await;
    let rep = member(&w, "rep", 1).await;
    // By hand.
    let (person, hand) = by_hand(&w, "+905000000001").await;
    // A later journey after a won one (inbox.journeys.open).
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        hand,
        serde_json::from_value(json!({"kind": "won", "idempotency_key": "w",
            "payload": {"product": "Plan", "amount_minor": 100, "currency": "TRY"}}))
        .unwrap(),
    )
    .await
    .unwrap();
    let repeat = journeys::open(&w.deps, &w.owner_ctx, person)
        .await
        .unwrap()
        .id;
    // A promotion.
    let promoted = promoted_in(&w, "İzmir", "+905000000003").await;
    // A v1 import's journey.
    let imported = {
        let p = people::create(
            &w.deps,
            &w.owner_ctx,
            serde_json::from_value(json!({
                "display_name": "v1",
                "identities": [{"channel": "phone", "value": "+905000000004", "capability_id": null}],
                "source": {"system": "v1", "kind": "import", "v1_lead_id": "lead-1",
                    "v1_source": "AI_RESEARCH", "v1_status": "CONTACTED"},
            }))
            .unwrap(),
        )
        .await
        .unwrap()
        .person
        .id;
        w.uow
            .snapshot()
            .inbox
            .journeys
            .iter()
            .find(|j| j.person_id == p)
            .unwrap()
            .id
    };
    // A rep's journey when the rep leaves.
    let (_, left) = by_hand(&w, "+905000000005").await;
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        left,
        serde_json::from_value(json!({"user_id": user_of(&rep)})).unwrap(),
    )
    .await
    .unwrap();
    let membership = {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.memberships()
            .find_by_user(user_of(&rep))
            .await
            .unwrap()
            .unwrap()
            .id
    };
    team::remove(&w.deps, &w.owner_ctx, membership)
        .await
        .unwrap();
    assert_eq!(owner_of(&w, left), None);
    assert_eq!(live(&w, left).cause, Cause::MemberLeft);

    tick(&w, FIXED_NOW + Duration::minutes(1)).await;
    for j in [repeat, promoted, left] {
        assert_eq!(owner_of(&w, j), Some(w.owner), "{j}");
    }
    // The import waits for a manager, recorded and counted.
    assert_eq!(owner_of(&w, imported), None);
    assert_eq!(live(&w, imported).cause, Cause::Import);
    let pending = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    let item = pending
        .items
        .iter()
        .find(|i| matches!(i.kind, work::WorkKind::OwnerlessJourneys { .. }))
        .expect("ownerless journeys are listed");
    assert_eq!(
        item.kind,
        work::WorkKind::OwnerlessJourneys {
            count: 1,
            oldest_journey_id: Some(imported),
        }
    );
    // Every open journey is owned or has a decision saying why not.
    let s = w.uow.snapshot();
    for j in s.inbox.journeys.iter().filter(|j| j.closed_at.is_none()) {
        assert!(
            j.owner.is_some()
                || decisions(&w, j.id)
                    .iter()
                    .any(|d| d.superseded_at.is_none()),
            "{} is silently ownerless",
            j.id
        );
    }
}

#[tokio::test]
async fn manual_mode_raises_work_item() {
    let w = active_world().await;
    set_rules(&w, vec![], Some(DistributionMode::Manual)).await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    tick(&w, FIXED_NOW).await;
    assert_eq!(owner_of(&w, j), None);
    assert_eq!(live(&w, j).cause, Cause::NoEligible);
    assert_eq!(w.entries("distribution.no_eligible").len(), 1);
    let pending = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(kinds(&pending.items).contains(&"ownerless_journeys".to_owned()));
    // A rep without inbox.manage is not asked.
    let rep = member(&w, "rep", 1).await;
    let theirs = work::pending(&w.deps, &rep).await.unwrap();
    assert!(!kinds(&theirs.items).contains(&"ownerless_journeys".to_owned()));
    // Backfill does not override the manual mode's lack of a default rule either.
    let out = distribution::backfill(&w.deps, &w.owner_ctx, BackfillInput::default())
        .await
        .unwrap();
    assert_eq!((out.assigned, out.no_eligible), (0, 1));
}

#[tokio::test]
async fn rules_route_by_city_and_source() {
    let w = active_world().await;
    let izmir = member(&w, "rep", 1).await;
    let other = member(&w, "rep", 2).await;
    set_rules(
        &w,
        vec![rule(
            "İzmir adayları",
            Match {
                sources: vec![SourceKind::Prospect],
                cities: vec!["IZMIR".into()],
                ..Match::default()
            },
            MemberPool::Members {
                user_ids: vec![user_of(&izmir)],
            },
            None,
        )],
        None,
    )
    .await;
    owner_away(&w).await;
    let routed = promoted_in(&w, "İzmir", "+905000000001").await;
    assert_eq!(owner_of(&w, routed), Some(user_of(&izmir)));
    assert_eq!(live(&w, routed).cause, Cause::Rule);
    // Another city, and an inbound journey: the default rule's round robin.
    let elsewhere = promoted_in(&w, "Ankara", "+905000000002").await;
    let (_, inbound) = by_hand(&w, "+905000000003").await;
    tick(&w, FIXED_NOW).await;
    assert_eq!(live(&w, elsewhere).cause, Cause::Default);
    assert_eq!(live(&w, inbound).cause, Cause::Default);
    let owners = [owner_of(&w, elsewhere), owner_of(&w, inbound)];
    assert!(owners.contains(&Some(user_of(&izmir))) && owners.contains(&Some(user_of(&other))));
}

#[tokio::test]
async fn capacity_and_away_skip_members() {
    let w = active_world().await;
    let full = member(&w, "rep", 1).await;
    let away = member(&w, "rep", 2).await;
    let free = member(&w, "rep", 3).await;
    owner_away(&w).await;
    let mut capped = profile();
    capped.max_open = Some(1);
    set_rep(&w, user_of(&full), capped).await;
    let mut gone = profile();
    gone.away_until = Some(FIXED_NOW + Duration::days(3));
    set_rep(&w, user_of(&away), gone).await;
    let (_, first) = by_hand(&w, "+905000000001").await;
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        first,
        serde_json::from_value(json!({"user_id": user_of(&full)})).unwrap(),
    )
    .await
    .unwrap();
    let mut ids = Vec::new();
    for i in 2..5 {
        ids.push(by_hand(&w, &format!("+90500000000{i}")).await.1);
    }
    tick(&w, FIXED_NOW).await;
    for j in ids {
        assert_eq!(owner_of(&w, j), Some(user_of(&free)));
    }
}

#[tokio::test]
async fn on_shift_preferred() {
    let w = active_world().await;
    let night = member(&w, "rep", 1).await;
    let day = member(&w, "rep", 2).await;
    owner_away(&w).await;
    // FIXED_NOW is Thursday 12:00 in Istanbul.
    let mut nights = profile();
    nights.hours = Some(Hours {
        tz: "Europe/Istanbul".into(),
        from: 20,
        to: 24,
        days: vec![1, 2, 3, 4, 5],
    });
    set_rep(&w, user_of(&night), nights).await;
    let mut days = profile();
    days.hours = Some(Hours {
        tz: "Europe/Istanbul".into(),
        from: 9,
        to: 18,
        days: vec![1, 2, 3, 4, 5],
    });
    set_rep(&w, user_of(&day), days).await;
    for i in 1..4 {
        let (_, j) = by_hand(&w, &format!("+90500000000{i}")).await;
        tick(&w, FIXED_NOW).await;
        assert_eq!(owner_of(&w, j), Some(user_of(&day)));
    }
}

/// A rule giving every journey to `members` with a one-hour SLA.
async fn sla_rule(w: &World, members: Vec<UserId>) {
    set_rules(
        w,
        vec![rule(
            "hepsi",
            Match::default(),
            MemberPool::Members { user_ids: members },
            Some(60),
        )],
        None,
    )
    .await;
}

#[tokio::test]
async fn sla_counts_only_working_minutes() {
    for (tz, expected) in [
        // Thursday 17:30 in Istanbul (14:30 UTC): 30 minutes Thursday, 30 on Friday from 09:00.
        (
            "Europe/Istanbul",
            time::macros::datetime!(2026-10-23 06:30 UTC),
        ),
        // 10:30 in New York (14:30 UTC): one wall-clock hour inside the window.
        (
            "America/New_York",
            time::macros::datetime!(2026-10-22 15:30 UTC),
        ),
    ] {
        let w = active_world().await;
        let rep = member(&w, "rep", 1).await;
        let mut hours = profile();
        hours.hours = Some(Hours {
            tz: tz.into(),
            from: 9,
            to: 18,
            days: vec![1, 2, 3, 4, 5],
        });
        set_rep(&w, user_of(&rep), hours).await;
        sla_rule(&w, vec![user_of(&rep)]).await;
        let (_, j) = by_hand(&w, "+905000000001").await;
        let now = time::macros::datetime!(2026-10-22 14:30 UTC);
        tick(&w, now).await;
        let row = live(&w, j);
        assert_eq!(row.user_id, Some(user_of(&rep)));
        assert_eq!(row.sla_due_at, Some(expected), "{tz}");
    }
}

#[tokio::test]
async fn owner_acts_mark_acted() {
    let w = active_world().await;
    let rep = member(&w, "rep", 1).await;
    sla_rule(&w, vec![user_of(&rep)]).await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    tick(&w, FIXED_NOW).await;
    assert_eq!(live(&w, j).acted_at, None);
    tasks::add_note(
        &w.deps,
        &at(&rep, FIXED_NOW + Duration::minutes(5)),
        j,
        tasks::NoteInput {
            text: "aradım, yarın tekrar".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(live(&w, j).acted_at, Some(FIXED_NOW + Duration::minutes(5)));
    // Acted: never due.
    tick(&w, FIXED_NOW + Duration::hours(5)).await;
    assert_eq!(owner_of(&w, j), Some(user_of(&rep)));
}

#[tokio::test]
async fn agent_reply_does_not_mark_acted() {
    let w = active_world().await;
    let rep = member(&w, "rep", 1).await;
    sla_rule(&w, vec![user_of(&rep)]).await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    tick(&w, FIXED_NOW).await;
    let agent = w.agent(&["inbox.work"]).await;
    tasks::add_note(
        &w.deps,
        &agent,
        j,
        tasks::NoteInput {
            text: "özet".into(),
        },
    )
    .await
    .unwrap();
    // The owner's manager acting is no act of the owner's either.
    tasks::add_note(
        &w.deps,
        &w.owner_ctx,
        j,
        tasks::NoteInput { text: "not".into() },
    )
    .await
    .unwrap();
    assert_eq!(live(&w, j).acted_at, None);
}

#[tokio::test]
async fn reassign_after_sla_excludes_previous() {
    let w = active_world().await;
    let a = member(&w, "rep", 1).await;
    let b = member(&w, "rep", 2).await;
    sla_rule(&w, vec![user_of(&a), user_of(&b)]).await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    tick(&w, FIXED_NOW).await;
    let first = owner_of(&w, j).unwrap();
    tick(&w, FIXED_NOW + Duration::minutes(61)).await;
    let second = owner_of(&w, j).unwrap();
    assert_ne!(first, second);
    let row = live(&w, j);
    assert_eq!(row.cause, Cause::SlaReassign);
    assert_eq!(row.sla_due_at, Some(FIXED_NOW + Duration::minutes(61 + 60)));
    let entry = payload(&w.entries("distribution.reassigned")[0]);
    assert_eq!(entry["from_user_id"], json!(first));
    assert_eq!(entry["user_id"], json!(second));
}

#[tokio::test]
async fn stalled_after_max_reassignments() {
    let w = active_world().await;
    let a = member(&w, "rep", 1).await;
    let b = member(&w, "rep", 2).await;
    sla_rule(&w, vec![user_of(&a), user_of(&b)]).await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    tick(&w, FIXED_NOW).await;
    // Two reassignments (the default limit): to the other member, then kept (nobody new).
    tick(&w, FIXED_NOW + Duration::minutes(61)).await;
    tick(&w, FIXED_NOW + Duration::minutes(122)).await;
    assert_eq!(
        decisions(&w, j)
            .iter()
            .filter(|d| d.cause == Cause::SlaReassign)
            .count(),
        2
    );
    let owner = owner_of(&w, j);
    // Past the limit: no more decisions, the owner stays, a manager is asked.
    let later = at(&w.owner_ctx, FIXED_NOW + Duration::minutes(500));
    tick(&w, later.now).await;
    assert_eq!(decisions(&w, j).len(), 3);
    assert_eq!(owner_of(&w, j), owner);
    let pending = work::pending(&w.deps, &later).await.unwrap();
    assert!(
        pending
            .items
            .iter()
            .any(|i| i.kind == work::WorkKind::AssignmentStalled { count: 1 })
    );
}

#[tokio::test]
async fn manual_assignment_has_no_sla_and_supersedes() {
    let w = active_world().await;
    let a = member(&w, "rep", 1).await;
    let b = member(&w, "rep", 2).await;
    sla_rule(&w, vec![user_of(&a)]).await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    tick(&w, FIXED_NOW).await;
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        j,
        serde_json::from_value(json!({"user_id": user_of(&b)})).unwrap(),
    )
    .await
    .unwrap();
    let rows = decisions(&w, j);
    assert_eq!(rows.len(), 2);
    assert!(rows[0].superseded_at.is_some());
    let manual = live(&w, j);
    assert_eq!(manual.cause, Cause::Manual);
    assert_eq!(manual.user_id, Some(user_of(&b)));
    assert_eq!(manual.sla_due_at, None);
    assert!(matches!(manual.by, jt_ledger::Actor::Human { .. }));
    // Never due: the job leaves it alone.
    tick(&w, FIXED_NOW + Duration::hours(3)).await;
    assert_eq!(owner_of(&w, j), Some(user_of(&b)));
}

#[tokio::test]
async fn member_left_rows_written() {
    let w = active_world().await;
    let rep = member(&w, "rep", 1).await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        j,
        serde_json::from_value(json!({"user_id": user_of(&rep)})).unwrap(),
    )
    .await
    .unwrap();
    let membership = {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.memberships()
            .find_by_user(user_of(&rep))
            .await
            .unwrap()
            .unwrap()
            .id
    };
    team::remove(&w.deps, &w.owner_ctx, membership)
        .await
        .unwrap();
    let row = live(&w, j);
    assert_eq!((row.cause, row.user_id), (Cause::MemberLeft, None));
    tick(&w, FIXED_NOW).await;
    assert_eq!(owner_of(&w, j), Some(w.owner));
}

#[tokio::test]
async fn backfill_is_capped() {
    let w = active_world().await;
    set_rules(&w, vec![], Some(DistributionMode::Manual)).await;
    for i in 1..=4 {
        by_hand(&w, &format!("+90500000000{i}")).await;
    }
    tick(&w, FIXED_NOW).await;
    set_rules(&w, vec![], Some(DistributionMode::Auto)).await;
    let out = distribution::backfill(&w.deps, &w.owner_ctx, BackfillInput { limit: Some(3) })
        .await
        .unwrap();
    assert_eq!(out.assigned, 3);
    let got = distribution::get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(got.ownerless.count, 1);
    let e = err(
        distribution::backfill(&w.deps, &w.owner_ctx, BackfillInput { limit: Some(201) }).await,
    );
    assert_invalid(&e, "limit");
    let rep = member(&w, "rep", 1).await;
    let e = err(distribution::backfill(&w.deps, &rep, BackfillInput::default()).await);
    assert_forbidden(&e, "inbox.manage");
}

#[tokio::test]
async fn rep_can_edit_only_own_profile() {
    let w = active_world().await;
    let a = member(&w, "rep", 1).await;
    let b = member(&w, "rep", 2).await;
    let mut away = profile();
    away.away_until = Some(FIXED_NOW + Duration::days(1));
    let own = distribution::rep_set(&w.deps, &a, user_of(&a), away.clone())
        .await
        .unwrap();
    assert!(!own.eligible);
    let e = err(distribution::rep_set(&w.deps, &a, user_of(&b), away.clone()).await);
    assert_forbidden(&e, "inbox.manage");
    // A manager sets anyone's; bad hours are refused.
    let mut bad = profile();
    bad.hours = Some(Hours {
        tz: "Not/AZone".into(),
        from: 9,
        to: 18,
        days: vec![1],
    });
    let e = err(distribution::rep_set(&w.deps, &w.owner_ctx, user_of(&b), bad).await);
    assert_invalid(&e, "hours.tz");
    distribution::rep_set(&w.deps, &w.owner_ctx, user_of(&b), away)
        .await
        .unwrap();
    let got = distribution::get(&w.deps, &a).await.unwrap();
    assert!(got.reps.iter().all(|r| r.user_id == w.owner || !r.eligible));
    // Rules name only members who hold inbox.work.
    let e = err(distribution::rules_set(
        &w.deps,
        &w.owner_ctx,
        RulesSetInput {
            rules: vec![rule(
                "yabancı",
                Match::default(),
                MemberPool::Members {
                    user_ids: vec![UserId::new_v7()],
                },
                None,
            )],
            mode: None,
            max_reassignments: None,
        },
    )
    .await);
    assert_invalid(&e, "rules[0].to");
}

#[tokio::test]
async fn the_job_waits_for_an_active_workspace() {
    // A registration awaits payment: nothing is distributed until the workspace is active.
    let w = world().await;
    let (_, j) = by_hand(&w, "+905000000001").await;
    tick(&w, FIXED_NOW).await;
    assert_eq!(owner_of(&w, j), None);
    assert!(decisions(&w, j).is_empty());
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    tick(&w, FIXED_NOW + Duration::minutes(1)).await;
    assert_eq!(owner_of(&w, j), Some(w.owner));
}
