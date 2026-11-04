//! The pool's report (plan L4-T6; spec 2026-10-30-leads-pool-outreach-design.md §3.16, D22):
//! computed at read time, grouped by the prospect's record at promotion, revenue per currency,
//! half-open ranges. Every value is invented.

mod support;

use jt_app::ctx::Ctx;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::inbox::journeys;
use jt_app::usecases::prospects::report::{GroupBy, ReportInput, report};
use jt_app::usecases::prospects::{self, PromoteInput, PromoteOutcome, rubric_digest};
use jt_ledger::Actor;
use jt_prospects::{
    CreateInput, EntityKind, FieldInput, Prospect, ProspectId, ReasonInput, ScoreInput,
    SourceRefInput,
};
use jt_strategy::{
    Area, Criterion, IcpEntry, Prospecting, Rubric, Sections, StrategyVersion, StrategyVersionId,
    VersionStatus,
};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

fn field(value: &str, now: OffsetDateTime) -> Option<FieldInput<String>> {
    Some(FieldInput {
        value: value.into(),
        sources: vec![SourceRefInput::Url {
            url: "https://kaynak.example.invalid/iletisim".into(),
            note: None,
        }],
        captured_at: now - Duration::days(1),
    })
}

fn input(name: &str, phone: &str, sector: &str, now: OffsetDateTime) -> CreateInput {
    CreateInput {
        business_name: name.into(),
        entity_kind: EntityKind::LegalEntity,
        sector: Some(sector.into()),
        city: Some("İstanbul".into()),
        district: None,
        language: Some("tr".into()),
        segment_key: Some("kafeler".into()),
        country: None,
        labels: vec![],
        phone: field(phone, now),
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

fn rubric() -> Rubric {
    Rubric {
        criteria: vec![
            Criterion {
                key: "fit".into(),
                description: "serves coffee".into(),
                weight: 60,
            },
            Criterion {
                key: "size".into(),
                description: "two branches".into(),
                weight: 40,
            },
        ],
        qualify_at: 70,
    }
}

/// Puts an approved version with prospecting on (cafes in İstanbul) in force.
async fn approve(w: &World) {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id: StrategyVersionId::new_v7(),
            workspace_id: w.ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections {
                prospecting: Prospecting {
                    icp: vec![IcpEntry {
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
                        language: None,
                        daily_cap: 50,
                        backlog_target: 0,
                    }],
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
}

/// A prospect created at `now`, scored `fit + size` under the approved rubric.
async fn scored(
    w: &World,
    name: &str,
    phone: &str,
    fit: u8,
    size: u8,
    now: OffsetDateTime,
) -> Prospect {
    let ctx = at(&w.owner_ctx, now);
    let p = prospects::create(&w.deps, &ctx, input(name, phone, "kafe", now))
        .await
        .unwrap()
        .prospect;
    let reason = |criterion: &str, points| ReasonInput {
        criterion: criterion.into(),
        points,
        evidence: "seen on their menu".into(),
        source: None,
    };
    prospects::score(
        &w.deps,
        &ctx,
        p.id,
        ScoreInput {
            score: fit + size,
            reasons: vec![reason("fit", fit), reason("size", size)],
            rubric_digest: rubric_digest(&rubric()),
        },
    )
    .await
    .unwrap();
    get(w, p.id).await
}

async fn get(w: &World, id: ProspectId) -> Prospect {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.prospects().get(id).await.unwrap().unwrap()
}

/// Promotes `id` as the owner at `ctx`'s time; the journey it opened.
async fn promote(w: &World, ctx: &Ctx, id: ProspectId) -> jt_inbox::JourneyId {
    let out = prospects::promote(
        &w.deps,
        ctx,
        PromoteInput {
            prospect_ids: vec![id],
            request_key: None,
        },
    )
    .await
    .unwrap();
    match out.items.into_iter().next().unwrap() {
        PromoteOutcome::Promoted { journey_id, .. } => journey_id,
        other => panic!("not promoted: {other:?}"),
    }
}

async fn win(w: &World, ctx: &Ctx, journey: jt_inbox::JourneyId, amount: i64, currency: &str) {
    journeys::report(
        &w.deps,
        ctx,
        journey,
        serde_json::from_value(json!({"kind": "won", "idempotency_key": format!("won-{journey}"),
            "payload": {"product": "Kahve makinesi", "amount_minor": amount, "currency": currency}}))
        .unwrap(),
    )
    .await
    .unwrap();
}

fn range(from: OffsetDateTime, to: OffsetDateTime, group_by: GroupBy) -> ReportInput {
    ReportInput {
        from: from.format(&Rfc3339).unwrap(),
        to: to.format(&Rfc3339).unwrap(),
        group_by,
    }
}

#[tokio::test]
async fn prospects_report_groups_by_bucket_at_promotion() {
    let w = world().await;
    approve(&w).await;
    let high = scored(&w, "Örnek Kafe", "+905000000001", 50, 30, FIXED_NOW).await;
    let low = scored(&w, "Deneme Kafe", "+905000000002", 30, 10, FIXED_NOW).await;
    let unscored = prospects::create(
        &w.deps,
        &w.owner_ctx,
        input("Başka Kafe", "+905000000003", "kafe", FIXED_NOW),
    )
    .await
    .unwrap()
    .prospect;
    assert_eq!(high.status, jt_prospects::ProspectStatus::Qualified);
    promote(&w, &w.owner_ctx, high.id).await;
    // A person may promote a `new` prospect too.
    promote(&w, &w.owner_ctx, low.id).await;
    // Were the latest score to move after promotion, the group stays the promotion's.
    w.uow.edit(|s| {
        for p in &mut s.prospects.prospects {
            if p.id == high.id
                && let Some(score) = p.latest_score.as_mut()
            {
                score.score = 10;
            }
        }
    });
    let out = report(
        &w.deps,
        &w.owner_ctx,
        range(
            FIXED_NOW,
            FIXED_NOW + Duration::days(1),
            GroupBy::ScoreBucket,
        ),
    )
    .await
    .unwrap();
    let of = |key: Option<&str>| {
        out.groups
            .iter()
            .find(|g| g.key.as_deref() == key)
            .unwrap_or_else(|| panic!("no group {key:?}: {:?}", out.groups))
            .clone()
    };
    let top = of(Some("75-100"));
    assert_eq!(
        (top.created, top.scored, top.qualified, top.promoted),
        (1, 1, 1, 1)
    );
    let bottom = of(Some("25-49"));
    assert_eq!((bottom.created, bottom.scored, bottom.promoted), (1, 1, 1));
    let none = of(None);
    assert_eq!((none.created, none.scored, none.promoted), (1, 0, 0));
    assert_eq!(out.groups.len(), 3, "{:?}", out.groups);
    assert!(!out.truncated);
    // By rubric digest: the two scored under it, the unscored one apart.
    let by_digest = report(
        &w.deps,
        &w.owner_ctx,
        range(
            FIXED_NOW,
            FIXED_NOW + Duration::days(1),
            GroupBy::RubricDigest,
        ),
    )
    .await
    .unwrap();
    let digest = rubric_digest(&rubric());
    let g = by_digest
        .groups
        .iter()
        .find(|g| g.key.as_deref() == Some(digest.as_str()))
        .unwrap();
    assert_eq!((g.created, g.promoted), (2, 2));
    let _ = unscored;
    // The report needs prospects.work.
    let rep = w.member("rep").await;
    let e = err(report(
        &w.deps,
        &rep,
        range(FIXED_NOW, FIXED_NOW + Duration::days(1), GroupBy::Source),
    )
    .await);
    assert_forbidden(&e, "prospects.work");
}

#[tokio::test]
async fn won_revenue_grouped_per_currency() {
    let w = world().await;
    approve(&w).await;
    let mut journeys_of = Vec::new();
    for (i, name) in ["Bir Kafe", "İki Kafe", "Üç Kafe", "Dört Kafe"]
        .iter()
        .enumerate()
    {
        let p = scored(&w, name, &format!("+90500000001{i}"), 50, 30, FIXED_NOW).await;
        journeys_of.push(promote(&w, &w.owner_ctx, p.id).await);
    }
    let later = at(&w.owner_ctx, FIXED_NOW + Duration::hours(2));
    win(&w, &later, journeys_of[0], 1_500_000, "TRY").await;
    win(&w, &later, journeys_of[1], 500_000, "TRY").await;
    win(&w, &later, journeys_of[2], 20_000, "EUR").await;
    journeys::report(
        &w.deps,
        &later,
        journeys_of[3],
        serde_json::from_value(json!({"kind": "lost", "idempotency_key": "lost-4",
            "payload": {"reason_key": "fiyat"}}))
        .unwrap(),
    )
    .await
    .unwrap();
    let out = report(
        &w.deps,
        &w.owner_ctx,
        range(FIXED_NOW, FIXED_NOW + Duration::days(1), GroupBy::Sector),
    )
    .await
    .unwrap();
    assert_eq!(out.groups.len(), 1);
    let g = &out.groups[0];
    assert_eq!(g.key.as_deref(), Some("kafe"));
    assert_eq!((g.promoted, g.won), (4, 3));
    assert_eq!(g.lost.get("fiyat"), Some(&1));
    // Never summed across currencies.
    assert_eq!(
        g.won_revenue,
        [("EUR".to_owned(), 20_000), ("TRY".to_owned(), 2_000_000)].into()
    );
    assert_eq!(g.rates.promoted_to_replied, Some(0.0));
    assert_eq!(g.rates.replied_to_meeting, None, "nobody replied");
    let text = serde_json::to_string(&out).unwrap();
    assert!(text.contains("\"won_revenue\":{\"EUR\":20000,\"TRY\":2000000}"));
}

#[tokio::test]
async fn report_ranges_are_half_open() {
    let w = world().await;
    approve(&w).await;
    let from = FIXED_NOW;
    let to = FIXED_NOW + Duration::hours(1);
    // Created at `from` (in), just before `to` (in), at `to` (out).
    scored(&w, "Bir Kafe", "+905000000021", 50, 30, from).await;
    scored(
        &w,
        "İki Kafe",
        "+905000000022",
        50,
        30,
        to - Duration::seconds(1),
    )
    .await;
    let out_of_range = scored(&w, "Üç Kafe", "+905000000023", 50, 30, to).await;
    // Promoted at `to`: out of this range, in the next.
    promote(&w, &at(&w.owner_ctx, to), out_of_range.id).await;
    let out = report(&w.deps, &w.owner_ctx, range(from, to, GroupBy::Source))
        .await
        .unwrap();
    let created: u32 = out.groups.iter().map(|g| g.created).sum();
    let promoted: u32 = out.groups.iter().map(|g| g.promoted).sum();
    assert_eq!((created, promoted), (2, 0));
    let next = report(
        &w.deps,
        &w.owner_ctx,
        range(to, to + Duration::hours(1), GroupBy::Source),
    )
    .await
    .unwrap();
    let created: u32 = next.groups.iter().map(|g| g.created).sum();
    let promoted: u32 = next.groups.iter().map(|g| g.promoted).sum();
    assert_eq!((created, promoted), (1, 1));
    assert_eq!(next.groups[0].key.as_deref(), Some("manual"));
    // A range is at most 366 days and its end comes after its start.
    let e = err(report(
        &w.deps,
        &w.owner_ctx,
        range(from, from + Duration::days(367), GroupBy::Source),
    )
    .await);
    assert_eq!(e.details["reason"], "range_too_long");
    let e = err(report(&w.deps, &w.owner_ctx, range(to, from, GroupBy::Source)).await);
    assert_eq!(e.details["reason"], "not_after_from");
    let e = err(report(
        &w.deps,
        &w.owner_ctx,
        ReportInput {
            from: "yesterday".into(),
            to: to.format(&Rfc3339).unwrap(),
            group_by: GroupBy::Source,
        },
    )
    .await);
    assert_eq!(e.details, json!({"field": "from", "reason": "not_a_time"}));
}
