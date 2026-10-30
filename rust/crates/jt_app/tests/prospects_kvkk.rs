//! Scores, decisions, the do-not-contact list, erasure and the purge (spec
//! 2026-10-30-leads-pool-outreach-design.md §3.2, §3.4, §3.6). Every value is invented.

mod support;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::usecases::jobs::{Job, run_prospects_purge};
use jt_app::usecases::prospects::{
    self, DecideInput, DecideKind, DncInput, EraseInput, LiftInput, RawKey, SettingsInput,
    rubric_digest,
};
use jt_ledger::Actor;
use jt_prospects::{
    CreateInput, DncReason, EntityKind, FieldInput, KeyKind, Prospect, ProspectStatus, ReasonInput,
    RejectReason, ScoreInput, SourceRefInput,
};
use jt_strategy::{
    Criterion, Prospecting, Rubric, Sections, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::WorkspaceStatus;
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::Duration;

const PHONE: &str = "0500 000 00 00";

fn field(value: &str) -> Option<FieldInput<String>> {
    Some(FieldInput {
        value: value.into(),
        sources: vec![SourceRefInput::Url {
            url: "https://ornek-kafe.example.invalid/iletisim".into(),
            note: None,
        }],
        captured_at: FIXED_NOW - Duration::days(1),
    })
}

fn input(name: &str, phone: &str) -> CreateInput {
    input_at(name, phone, FIXED_NOW)
}

/// [`input`], its phone seen the day before `now`.
fn input_at(name: &str, phone: &str, now: time::OffsetDateTime) -> CreateInput {
    let mut i = base_input(name, phone);
    if let Some(f) = i.phone.as_mut() {
        f.captured_at = now - Duration::days(1);
    }
    i
}

fn base_input(name: &str, phone: &str) -> CreateInput {
    CreateInput {
        business_name: name.into(),
        entity_kind: EntityKind::SoleTrader,
        sector: Some("kafe".into()),
        city: Some("İstanbul".into()),
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
        notes: "a corner cafe".into(),
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

/// Puts an approved version with `rubric` in force.
async fn approve(w: &World, rubric: Rubric) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: w.ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections {
                prospecting: Prospecting {
                    icp: vec![],
                    rubric,
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

fn scored(fit: u8, size: u8, digest: &str) -> ScoreInput {
    let reason = |criterion: &str, points| ReasonInput {
        criterion: criterion.into(),
        points,
        evidence: "seen on their menu".into(),
        source: None,
    };
    ScoreInput {
        score: fit + size,
        reasons: vec![reason("fit", fit), reason("size", size)],
        rubric_digest: digest.into(),
    }
}

fn assert_refused(e: &AppError, code: ErrorCode, why: &str) {
    assert_eq!(e.code, code, "{e:?}");
    assert_eq!(e.details["reason"], why, "{e:?}");
}

async fn create(w: &World, ctx: &Ctx, i: CreateInput) -> Result<Prospect, AppError> {
    prospects::create(&w.deps, ctx, i).await.map(|o| o.prospect)
}

async fn get(w: &World, p: &Prospect) -> Option<Prospect> {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.prospects().get(p.id).await.unwrap()
}

fn decide(
    kind: DecideKind,
    reason: Option<RejectReason>,
    note: Option<&str>,
    rev: u32,
) -> DecideInput {
    DecideInput {
        decision: kind,
        reason,
        note: note.map(str::to_owned),
        expected_revision: rev,
    }
}

#[tokio::test]
async fn score_with_stale_digest_is_rubric_mismatch() {
    let w = world().await;
    approve(&w, rubric()).await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let e = err(prospects::score(&w.deps, &w.owner_ctx, p.id, scored(30, 10, "old")).await);
    assert_refused(&e, ErrorCode::Conflict, "rubric_mismatch");
    assert_eq!(e.details["current"], rubric_digest(&rubric()));
}

#[tokio::test]
async fn score_without_prospecting_is_refused() {
    let w = world().await;
    w.approve_strategy().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let e = err(prospects::score(&w.deps, &w.owner_ctx, p.id, scored(30, 10, "x")).await);
    assert_refused(&e, ErrorCode::Conflict, "prospecting_off");
}

#[tokio::test]
async fn score_at_threshold_auto_qualifies_once() {
    let w = world().await;
    let version = approve(&w, rubric()).await;
    let digest = rubric_digest(&rubric());
    let agent = w.agent(&["prospects.work"]).await;
    let p = create(&w, &agent, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let low = prospects::score(&w.deps, &agent, p.id, scored(40, 29, &digest))
        .await
        .unwrap();
    assert!(!low.qualified);
    assert_eq!(low.status, ProspectStatus::New);
    let out = prospects::score(&w.deps, &agent, p.id, scored(40, 30, &digest))
        .await
        .unwrap();
    assert!(out.qualified);
    assert_eq!(out.status, ProspectStatus::Qualified);
    assert_eq!(out.score.strategy_version_id, Some(version));
    let again = prospects::score(&w.deps, &agent, p.id, scored(60, 40, &digest))
        .await
        .unwrap();
    assert!(!again.qualified, "qualified once");
    let qualified = w.entries("prospects.qualified");
    assert_eq!(qualified.len(), 1);
    assert_eq!(qualified[0].payload["auto"], true);
    assert!(matches!(qualified[0].actor, Actor::System { .. }));
    assert_eq!(w.entries("prospects.scored").len(), 3);
    let back = get(&w, &p).await.unwrap();
    assert_eq!(back.latest_score.unwrap().score, 100);
    // Points must add up, each criterion once.
    let mut bad = scored(40, 30, &digest);
    bad.score = 71;
    let e = err(prospects::score(&w.deps, &agent, p.id, bad).await);
    assert_invalid(&e, "score");
}

#[tokio::test]
async fn lower_score_never_unqualifies_a_human_decision() {
    let w = world().await;
    approve(&w, rubric()).await;
    let digest = rubric_digest(&rubric());
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(DecideKind::Qualify, None, None, 1),
    )
    .await
    .unwrap();
    let out = prospects::score(&w.deps, &w.owner_ctx, p.id, scored(5, 5, &digest))
        .await
        .unwrap();
    assert_eq!(out.status, ProspectStatus::Qualified);
    assert_eq!(get(&w, &p).await.unwrap().status, ProspectStatus::Qualified);
}

#[tokio::test]
async fn reject_requires_a_known_reason_and_note_for_other() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let e = err(prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(DecideKind::Reject, None, None, 1),
    )
    .await);
    assert_invalid(&e, "reason");
    let e = err(prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(DecideKind::Reject, Some(RejectReason::Other), None, 1),
    )
    .await);
    assert_invalid(&e, "note");
    let unknown: Result<DecideInput, _> = serde_json::from_value(
        json!({"decision": "reject", "reason": "too_expensive", "expected_revision": 1}),
    );
    assert!(unknown.is_err(), "the reasons are a fixed list");
    let out = prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(
            DecideKind::Reject,
            Some(RejectReason::ClosedBusiness),
            None,
            1,
        ),
    )
    .await
    .unwrap();
    assert_eq!(out.prospect.status, ProspectStatus::Rejected);
    assert_eq!(
        out.prospect.purge_after,
        Some(FIXED_NOW + Duration::days(30)),
        "rejected retention from the decision"
    );
    assert_eq!(
        w.entries("prospects.rejected")[0].payload["reason"],
        "closed_business"
    );
    // A rejected prospect cannot be rejected again.
    let e = err(prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(DecideKind::Reject, Some(RejectReason::NotIcp), None, 2),
    )
    .await);
    assert_refused(&e, ErrorCode::Conflict, "invalid_transition");
}

#[tokio::test]
async fn reopen_is_human_manager_only() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(DecideKind::Reject, Some(RejectReason::NotIcp), None, 1),
    )
    .await
    .unwrap();
    let reopen = || decide(DecideKind::Reopen, None, None, 2);
    let agent = w.agent(&["prospects.work", "prospects.manage"]).await;
    let e = err(prospects::decide(&w.deps, &agent, p.id, reopen()).await);
    assert_refused(&e, ErrorCode::Forbidden, "human_only");
    let worker = Ctx {
        permissions: [jt_tenancy::Permission::ProspectsWork].into(),
        ..w.owner_ctx.clone()
    };
    let e = err(prospects::decide(&w.deps, &worker, p.id, reopen()).await);
    assert_forbidden(&e, "prospects.manage");
    let later = at(&w.owner_ctx, FIXED_NOW + Duration::days(3));
    let out = prospects::decide(&w.deps, &later, p.id, reopen())
        .await
        .unwrap();
    assert_eq!(out.prospect.status, ProspectStatus::New);
    assert_eq!(out.prospect.decision, None);
    assert_eq!(
        out.prospect.purge_after,
        Some(FIXED_NOW + Duration::days(3 + 180)),
        "a reopen restarts the unpromoted retention"
    );
    assert_eq!(w.entries("prospects.reopened").len(), 1);
}

fn dnc(prospect: Option<jt_prospects::ProspectId>, keys: Vec<RawKey>) -> DncInput {
    DncInput {
        confirm: true,
        prospect_id: prospect,
        keys,
        reason: DncReason::Objected,
        note: None,
    }
}

#[tokio::test]
async fn dnc_scrubs_and_blocks_reentry_after_purge() {
    let w = world().await;
    let mut i = input("Örnek Kafe", PHONE);
    i.instagram = field("@ornek.kafe");
    let p = create(&w, &w.owner_ctx, i).await.unwrap();
    let e = err(prospects::do_not_contact(
        &w.deps,
        &w.owner_ctx,
        DncInput {
            confirm: false,
            ..dnc(Some(p.id), vec![])
        },
    )
    .await);
    assert_invalid(&e, "confirm");
    let agent = w.agent(&["prospects.work"]).await;
    let out = prospects::do_not_contact(&w.deps, &agent, dnc(Some(p.id), vec![]))
        .await
        .unwrap();
    assert_eq!(
        out.kinds,
        [KeyKind::Phone, KeyKind::Instagram, KeyKind::NameCity]
    );
    let back = get(&w, &p).await.unwrap();
    assert_eq!(back.status, ProspectStatus::DoNotContact);
    assert_eq!(back.business_name, "—");
    assert_eq!(back.contact, jt_prospects::ContactFields::default());
    assert_eq!(back.notes, "");
    assert_eq!(back.purge_after, None, "never purged by the pool");
    let entry = w.entries("prospects.do_not_contact").pop().unwrap();
    assert_eq!(
        entry.payload,
        json!({"prospect_id": p.id, "reason": "objected", "keys": ["phone", "instagram", "name_city"]})
    );
    // Even with the row gone, the business cannot be recorded again.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.prospects().delete(p.id).await.unwrap();
    r.commit().await.unwrap();
    let e = err(create(&w, &w.owner_ctx, input("Başka Ad", PHONE)).await);
    assert_refused(&e, ErrorCode::Forbidden, "do_not_contact");
    let mut by_handle = input("Başka Ad", "0500 000 00 99");
    by_handle.instagram = field("instagram.com/ornek.kafe");
    let e = err(create(&w, &w.owner_ctx, by_handle).await);
    assert_refused(&e, ErrorCode::Forbidden, "do_not_contact");
}

#[tokio::test]
async fn dnc_with_raw_keys_blocks_create() {
    let w = world().await;
    let raw = vec![RawKey {
        kind: KeyKind::Phone,
        value: "+90 (500) 000 00 00".into(),
    }];
    let out = prospects::do_not_contact(&w.deps, &w.owner_ctx, dnc(None, raw))
        .await
        .unwrap();
    assert_eq!(out.prospect_id, None);
    assert_eq!(out.kinds, [KeyKind::Phone]);
    let e = err(create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Forbidden, "do_not_contact");
    let bad = vec![RawKey {
        kind: KeyKind::Email,
        value: "not an email".into(),
    }];
    let e = err(prospects::do_not_contact(&w.deps, &w.owner_ctx, dnc(None, bad)).await);
    assert_invalid(&e, "keys");
    let e = err(prospects::do_not_contact(&w.deps, &w.owner_ctx, dnc(None, vec![])).await);
    assert_invalid(&e, "prospect_id");
    let text = w.entries("prospects.do_not_contact")[0].payload.to_string();
    assert!(!text.contains("500"), "no value in the ledger: {text}");
}

#[tokio::test]
async fn lift_requires_a_human_manager() {
    let w = world().await;
    let raw = || {
        vec![RawKey {
            kind: KeyKind::Phone,
            value: PHONE.into(),
        }]
    };
    prospects::do_not_contact(&w.deps, &w.owner_ctx, dnc(None, raw()))
        .await
        .unwrap();
    let lift = || LiftInput {
        kind: KeyKind::Phone,
        value: "+905000000000".into(),
    };
    let worker = Ctx {
        permissions: [jt_tenancy::Permission::ProspectsWork].into(),
        ..w.owner_ctx.clone()
    };
    let e = err(prospects::dnc_lift(&w.deps, &worker, lift()).await);
    assert_forbidden(&e, "prospects.manage");
    let out = prospects::dnc_lift(&w.deps, &w.owner_ctx, lift())
        .await
        .unwrap();
    assert!(out.lifted);
    assert!(
        !prospects::dnc_lift(&w.deps, &w.owner_ctx, lift())
            .await
            .unwrap()
            .lifted
    );
    create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    assert_eq!(
        w.entries("prospects.dnc_lifted")[0].payload,
        json!({"kind": "phone"})
    );
}

#[tokio::test]
async fn agent_cannot_lift() {
    let w = world().await;
    let agent = w.agent(&["prospects.work", "prospects.manage"]).await;
    let e = err(prospects::dnc_lift(
        &w.deps,
        &agent,
        LiftInput {
            kind: KeyKind::Phone,
            value: PHONE.into(),
        },
    )
    .await);
    assert_refused(&e, ErrorCode::Forbidden, "human_only");
}

#[tokio::test]
async fn erase_deletes_now_and_blocks_reentry() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let agent = w.agent(&["prospects.work", "prospects.manage"]).await;
    let e = err(prospects::erase(&w.deps, &agent, p.id, EraseInput { confirm: true }).await);
    assert_refused(&e, ErrorCode::Forbidden, "human_only");
    let e = err(prospects::erase(&w.deps, &w.owner_ctx, p.id, EraseInput { confirm: false }).await);
    assert_invalid(&e, "confirm");
    let out = prospects::erase(&w.deps, &w.owner_ctx, p.id, EraseInput { confirm: true })
        .await
        .unwrap();
    assert!(out.erased);
    assert_eq!(get(&w, &p).await, None);
    let e = err(create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Forbidden, "do_not_contact");
    // An erasure is never lifted.
    let lift = prospects::dnc_lift(
        &w.deps,
        &w.owner_ctx,
        LiftInput {
            kind: KeyKind::Phone,
            value: PHONE.into(),
        },
    )
    .await
    .unwrap();
    assert!(!lift.lifted);
    assert_eq!(w.entries("prospects.erased").len(), 1);
}

#[tokio::test]
async fn erase_of_promoted_points_to_the_person() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let person = jt_app::usecases::inbox::people::create(
        &w.deps,
        &w.owner_ctx,
        jt_app::usecases::inbox::people::CreateInput {
            display_name: "Örnek Kafe".into(),
            identities: vec![jt_app::usecases::inbox::people::IdentityInput {
                channel: jt_inbox::IdentityChannel::Email,
                value: "satis@ucuncu.example.invalid".into(),
                capability_id: None,
            }],
            source: jt_inbox::Source::Import,
        },
    )
    .await
    .unwrap()
    .person;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let journey = r.journeys().open_for(person.id).await.unwrap().unwrap();
    r.prospects()
        .set_promoted(
            p.id,
            &jt_prospects::Promotion {
                person_id: person.id,
                journey_id: journey.id,
                at: FIXED_NOW,
                score: None,
                bucket: None,
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let e = err(prospects::erase(&w.deps, &w.owner_ctx, p.id, EraseInput { confirm: true }).await);
    assert_refused(&e, ErrorCode::Conflict, "erase_the_person");
    assert_eq!(e.details["person_id"], json!(person.id));
}

/// The pool's purge at `now`.
async fn purge(w: &World, days: i64) {
    run_prospects_purge(&w.deps, FIXED_NOW + Duration::days(days)).await;
}

#[tokio::test]
async fn purge_deletes_rejected_after_retention_and_remembers_keys_for_a_year() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(DecideKind::Reject, Some(RejectReason::NotIcp), None, 1),
    )
    .await
    .unwrap();
    purge(&w, 29).await;
    assert!(get(&w, &p).await.is_some(), "kept for 30 days");
    purge(&w, 30).await;
    assert_eq!(get(&w, &p).await, None);
    let purged = w.entries("prospects.purged");
    assert_eq!(purged.len(), 1);
    assert_eq!(purged[0].payload, json!({"count": 1}));
    let later = at(&w.owner_ctx, FIXED_NOW + Duration::days(31));
    let e = err(create(&w, &later, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Conflict, "previously_rejected");
}

#[tokio::test]
async fn rejected_memory_expires() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        decide(DecideKind::Reject, Some(RejectReason::NotIcp), None, 1),
    )
    .await
    .unwrap();
    purge(&w, 30).await;
    // Remembered until 30 + 365 days, then the hashes go and it may be recorded again.
    let before_at = FIXED_NOW + Duration::days(30 + 364);
    let before = at(&w.owner_ctx, before_at);
    let e = err(create(&w, &before, input_at("Örnek Kafe", PHONE, before_at)).await);
    assert_refused(&e, ErrorCode::Conflict, "previously_rejected");
    purge(&w, 30 + 365).await;
    let after_at = FIXED_NOW + Duration::days(30 + 365);
    let after = at(&w.owner_ctx, after_at);
    create(&w, &after, input_at("Örnek Kafe", PHONE, after_at))
        .await
        .unwrap();
}

#[tokio::test]
async fn purge_deletes_stale_unpromoted_but_not_promoted() {
    let w = world().await;
    let stale = create(&w, &w.owner_ctx, input("Bir Kafe", "0500 000 00 01"))
        .await
        .unwrap();
    let busy = create(&w, &w.owner_ctx, input("İki Kafe", "0500 000 00 02"))
        .await
        .unwrap();
    let promoted = create(&w, &w.owner_ctx, input("Üç Kafe", "0500 000 00 03"))
        .await
        .unwrap();
    // An update moves the retention.
    let later = at(&w.owner_ctx, FIXED_NOW + Duration::days(100));
    prospects::update(
        &w.deps,
        &later,
        busy.id,
        jt_prospects::UpdateInput {
            expected_revision: 1,
            set: jt_prospects::SetFields {
                notes: Some("still open".into()),
                ..Default::default()
            },
            clear: vec![],
            distinct_from: vec![],
        },
    )
    .await
    .unwrap();
    let person = jt_app::usecases::inbox::people::create(
        &w.deps,
        &w.owner_ctx,
        jt_app::usecases::inbox::people::CreateInput {
            display_name: "Üç Kafe".into(),
            identities: vec![jt_app::usecases::inbox::people::IdentityInput {
                channel: jt_inbox::IdentityChannel::Email,
                value: "satis@ucuncu.example.invalid".into(),
                capability_id: None,
            }],
            source: jt_inbox::Source::Import,
        },
    )
    .await
    .unwrap()
    .person;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let journey = r.journeys().open_for(person.id).await.unwrap().unwrap();
    r.prospects()
        .set_promoted(
            promoted.id,
            &jt_prospects::Promotion {
                person_id: person.id,
                journey_id: journey.id,
                at: FIXED_NOW,
                score: None,
                bucket: None,
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    purge(&w, 180).await;
    assert_eq!(get(&w, &stale).await, None, "180 days without an update");
    assert!(get(&w, &busy).await.is_some());
    assert!(get(&w, &promoted).await.is_some());
    purge(&w, 280).await;
    assert_eq!(get(&w, &busy).await, None);
    purge(&w, 10_000).await;
    assert!(
        get(&w, &promoted).await.is_some(),
        "a promoted prospect lives with its person"
    );
    // An unpromoted prospect leaves no memory: it may be recorded again.
    let back = at(&w.owner_ctx, FIXED_NOW + Duration::days(281));
    create(&w, &back, input("Bir Kafe", "0500 000 00 01"))
        .await
        .unwrap();
}

#[tokio::test]
async fn purge_runs_in_suspended_workspaces() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let mut platform = w.uow.platform().await.unwrap();
    platform
        .workspace_set_status(
            w.ws,
            WorkspaceStatus::Suspended,
            "test suspension",
            &Actor::System {
                component: "test".into(),
            },
        )
        .await
        .unwrap();
    platform.commit().await.unwrap();
    purge(&w, 181).await;
    assert_eq!(get(&w, &p).await, None);
    assert_eq!(Job::ProspectsPurge.name(), "prospects_purge");
}

#[tokio::test]
async fn settings_are_bounded_and_kept_key_by_key() {
    let w = world().await;
    let e = err(prospects::settings_set(
        &w.deps,
        &w.owner_ctx,
        SettingsInput {
            rejected_retention_days: Some(0),
            ..Default::default()
        },
    )
    .await);
    assert_invalid(&e, "rejected_retention_days");
    let e = err(prospects::settings_set(
        &w.deps,
        &w.owner_ctx,
        SettingsInput {
            timezone: Some("Mars/Base".into()),
            ..Default::default()
        },
    )
    .await);
    assert_invalid(&e, "timezone");
    let out = prospects::settings_set(
        &w.deps,
        &w.owner_ctx,
        SettingsInput {
            rejected_memory_days: Some(0),
            timezone: Some("America/New_York".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(out.prospects.rejected_memory_days, 0);
    assert_eq!(out.prospects.rejected_retention_days, 30, "the others kept");
    assert_eq!(
        prospects::settings_get(&w.deps, &w.owner_ctx)
            .await
            .unwrap(),
        out
    );
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(prospects::settings_get(&w.deps, &rep).await),
        "prospects.work",
    );
    let worker = Ctx {
        permissions: [jt_tenancy::Permission::ProspectsWork].into(),
        ..w.owner_ctx.clone()
    };
    assert_forbidden(
        &err(prospects::settings_set(&w.deps, &worker, SettingsInput::default()).await),
        "prospects.manage",
    );
}
