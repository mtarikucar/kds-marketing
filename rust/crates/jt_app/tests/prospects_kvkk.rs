//! Scores, decisions, the do-not-contact list, erasure and the purge (spec
//! 2026-10-30-leads-pool-outreach-design.md §3.2, §3.4, §3.6). Every value is invented.

mod support;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::ports::prospects::Promoted;
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
    Area, Criterion, IcpEntry, Prospecting, Rubric, Sections, StrategyVersion, StrategyVersionId,
    VersionStatus,
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

/// One ICP entry: cafes in İstanbul.
fn icp_entry() -> IcpEntry {
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
        language: None,
        daily_cap: 20,
        backlog_target: 0,
    }
}

/// Puts an approved version with prospecting on (one ICP entry) and `rubric` in force.
async fn approve(w: &World, rubric: Rubric) -> StrategyVersionId {
    approve_with(w, vec![icp_entry()], rubric).await
}

/// Puts an approved version with `icp` and `rubric` in force.
async fn approve_with(w: &World, icp: Vec<IcpEntry>, rubric: Rubric) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: w.ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections {
                prospecting: Prospecting { icp, rubric },
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
async fn an_empty_icp_switches_scoring_off_whatever_the_rubric() {
    let w = world().await;
    approve_with(&w, vec![], rubric()).await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let digest = rubric_digest(&rubric());
    let e = err(prospects::score(&w.deps, &w.owner_ctx, p.id, scored(30, 10, &digest)).await);
    assert_refused(&e, ErrorCode::Conflict, "prospecting_off");
    assert!(w.entries("prospects.scored").is_empty());
}

#[tokio::test]
async fn an_agent_gives_no_manual_source_in_a_score() {
    let w = world().await;
    approve(&w, rubric()).await;
    let digest = rubric_digest(&rubric());
    let agent = w.agent(&["prospects.work"]).await;
    let p = create(&w, &agent, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let mut manual = scored(30, 10, &digest);
    manual.reasons[0].source = Some(SourceRefInput::Manual {
        note: "the owner said so".into(),
    });
    let e = err(prospects::score(&w.deps, &agent, p.id, manual.clone()).await);
    assert_invalid(&e, "reasons");
    assert_eq!(e.details["reason"], "manual_source_is_for_humans");
    prospects::score(&w.deps, &w.owner_ctx, p.id, manual)
        .await
        .unwrap();
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
    approve(&w, rubric()).await;
    let mut i = input("Örnek Kafe", PHONE);
    i.instagram = field("@ornek.kafe");
    i.website = field("https://ornek-kafe.example.invalid");
    i.request_key = Some("dnc-1".into());
    let p = create(&w, &w.owner_ctx, i).await.unwrap();
    prospects::score(
        &w.deps,
        &w.owner_ctx,
        p.id,
        scored(30, 10, &rubric_digest(&rubric())),
    )
    .await
    .unwrap();
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
        [KeyKind::Phone, KeyKind::Instagram],
        "hard keys only: the domain and the name are others' too"
    );
    assert_eq!(out.prospects, [p.id]);
    let back = get(&w, &p).await.unwrap();
    assert_eq!(back.status, ProspectStatus::DoNotContact);
    assert_eq!(back.business_name, "—");
    assert_eq!(back.contact, jt_prospects::ContactFields::default());
    assert_eq!(back.notes, "");
    assert_eq!(back.purge_after, None, "never purged by the pool");
    // The score history goes (its reasons are evidence about the business); the number stays.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert!(r.prospects().scores(p.id, 10).await.unwrap().is_empty());
    drop(r);
    assert_eq!(back.latest_score.map(|s| s.score), Some(40));
    // The request that recorded it is forgotten: no replay answers the scrubbed row.
    assert!(w.uow.snapshot().inbox.request_keys.is_empty());
    let entry = w.entries("prospects.do_not_contact").pop().unwrap();
    assert_eq!(
        entry.payload,
        json!({"prospect_id": p.id, "reason": "objected", "keys": ["phone", "instagram"]})
    );
    // A business sharing only its name and city, or its domain, may still be recorded.
    let mut namesake = input("Örnek Kafe", "0500 000 00 77");
    namesake.website = field("https://ornek-kafe.example.invalid/sube");
    create(&w, &w.owner_ctx, namesake).await.unwrap();
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
    // A soft key is no objection's key.
    for (kind, value) in [
        (KeyKind::Domain, "ornek.example.invalid"),
        (KeyKind::NameCity, "Örnek Kafe|İstanbul"),
    ] {
        let soft = vec![RawKey {
            kind,
            value: value.into(),
        }];
        let e = err(prospects::do_not_contact(&w.deps, &w.owner_ctx, dnc(None, soft)).await);
        assert_invalid(&e, "keys");
        assert_eq!(e.details["reason"], "not_a_hard_key");
    }
}

#[tokio::test]
async fn dnc_by_raw_keys_marks_the_prospects_holding_them() {
    let w = world().await;
    let mut i = input("Örnek Kafe", PHONE);
    i.instagram = field("@ornek.kafe");
    let held = create(&w, &w.owner_ctx, i).await.unwrap();
    let other = create(&w, &w.owner_ctx, input("Başka Kafe", "0500 000 00 01"))
        .await
        .unwrap();
    // A promoted holder is the inbox person's: its person is answered.
    let mut j = input("Üçüncü Kafe", "0500 000 00 02");
    j.tiktok = field("@ucuncu.kafe");
    let promoted = create(&w, &w.owner_ctx, j).await.unwrap();
    let person = promote(&w, &promoted).await;
    let raw = vec![
        RawKey {
            kind: KeyKind::Instagram,
            value: "https://www.instagram.com/ornek.kafe/".into(),
        },
        RawKey {
            kind: KeyKind::Tiktok,
            value: "@ucuncu.kafe".into(),
        },
    ];
    let out = prospects::do_not_contact(&w.deps, &w.owner_ctx, dnc(None, raw))
        .await
        .unwrap();
    assert_eq!(out.prospect_id, None);
    assert_eq!(out.prospects, [held.id]);
    assert_eq!(out.people, [person]);
    assert_eq!(out.kinds, [KeyKind::Instagram, KeyKind::Tiktok]);
    let back = get(&w, &held).await.unwrap();
    assert_eq!(back.status, ProspectStatus::DoNotContact);
    assert_eq!(back.contact, jt_prospects::ContactFields::default());
    // Every hard key it held is listed, its phone too.
    let e = err(create(&w, &w.owner_ctx, input("Yeni Ad", PHONE)).await);
    assert_refused(&e, ErrorCode::Forbidden, "do_not_contact");
    assert_eq!(get(&w, &other).await.unwrap().status, ProspectStatus::New);
    assert_eq!(
        get(&w, &promoted).await.unwrap().status,
        ProspectStatus::Promoted,
        "the pool leaves a promoted prospect to its person"
    );
    let entries = w.entries("prospects.do_not_contact");
    assert_eq!(entries.len(), 2, "one per prospect, one for the raw keys");
    assert_eq!(
        entries[1].payload,
        json!({"reason": "objected", "keys": ["instagram", "tiktok"], "prospects": 1, "people": 1})
    );
}

/// Promotes `p` to a new inbox person by hand (promotion itself is L3's); the person.
async fn promote(w: &World, p: &Prospect) -> jt_inbox::PersonId {
    let person = jt_app::usecases::inbox::people::create(
        &w.deps,
        &w.owner_ctx,
        jt_app::usecases::inbox::people::CreateInput {
            display_name: p.business_name.clone(),
            identities: vec![jt_app::usecases::inbox::people::IdentityInput {
                channel: jt_inbox::IdentityChannel::Email,
                value: format!("satis+{}@ucuncu.example.invalid", p.id),
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
    let done = r
        .prospects()
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
    assert_eq!(done, Promoted::Ok);
    r.commit().await.unwrap();
    person.id
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
async fn a_soft_key_is_never_lifted() {
    let w = world().await;
    let e = err(prospects::dnc_lift(
        &w.deps,
        &w.owner_ctx,
        LiftInput {
            kind: KeyKind::Domain,
            value: "ornek.example.invalid".into(),
        },
    )
    .await);
    assert_invalid(&e, "kind");
    assert_eq!(e.details["reason"], "not_a_hard_key");
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
    approve(&w, rubric()).await;
    let mut i = input("Örnek Kafe", PHONE);
    i.request_key = Some("erase-1".into());
    let p = create(&w, &w.owner_ctx, i).await.unwrap();
    prospects::score(
        &w.deps,
        &w.owner_ctx,
        p.id,
        scored(30, 10, &rubric_digest(&rubric())),
    )
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
    assert_eq!(out.kinds, [KeyKind::Phone], "hard keys only");
    assert_eq!(get(&w, &p).await, None);
    let snapshot = w.uow.snapshot();
    assert!(snapshot.prospects.scores.is_empty(), "its scores went");
    assert!(
        snapshot.inbox.request_keys.is_empty(),
        "the request that recorded it is forgotten"
    );
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
    let done = r
        .prospects()
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
    assert_eq!(done, Promoted::Ok);
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
    let done = r
        .prospects()
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
    assert_eq!(done, Promoted::Ok);
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
async fn a_shortened_retention_reaches_existing_prospects() {
    let w = world().await;
    let unpromoted = create(&w, &w.owner_ctx, input("Bir Kafe", "0500 000 00 01"))
        .await
        .unwrap();
    let rejected = create(&w, &w.owner_ctx, input("İki Kafe", "0500 000 00 02"))
        .await
        .unwrap();
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        rejected.id,
        decide(DecideKind::Reject, Some(RejectReason::NotIcp), None, 1),
    )
    .await
    .unwrap();
    purge(&w, 10).await;
    assert!(get(&w, &unpromoted).await.is_some());
    assert!(get(&w, &rejected).await.is_some());
    // Shortened after they were recorded: the next purge reads the new periods.
    prospects::settings_set(
        &w.deps,
        &w.owner_ctx,
        SettingsInput {
            unpromoted_retention_days: Some(10),
            rejected_retention_days: Some(7),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let out = prospects::get(&w.deps, &w.owner_ctx, unpromoted.id)
        .await
        .unwrap();
    assert_eq!(
        out.prospect.purge_after,
        Some(FIXED_NOW + Duration::days(10)),
        "the answer reads the current policy"
    );
    purge(&w, 10).await;
    assert_eq!(get(&w, &unpromoted).await, None);
    assert_eq!(get(&w, &rejected).await, None);
}

#[tokio::test]
async fn purge_catches_up_beyond_one_batch() {
    let w = world().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let count = prospects::PURGE_BATCH + 3;
    for n in 0..count {
        let p = jt_testkit::prospects_contract::prospect(
            w.ws,
            w.owner,
            input(&format!("Kafe {n}"), &format!("0500 {n:03} 00 00")),
            FIXED_NOW,
        );
        r.prospects().insert(&p, &[]).await.unwrap();
    }
    r.commit().await.unwrap();
    purge(&w, 181).await;
    assert!(w.uow.snapshot().prospects.prospects.is_empty());
    let purged: Vec<serde_json::Value> = w
        .entries("prospects.purged")
        .into_iter()
        .map(|e| e.payload)
        .collect();
    assert_eq!(
        purged,
        [
            json!({"count": prospects::PURGE_BATCH}),
            json!({"count": 3})
        ],
        "one entry per batch"
    );
}

#[tokio::test]
async fn objections_are_recordable_in_a_suspended_workspace() {
    use jt_app::catalog::{CATALOG, GateMode, StatusExemption};
    use jt_app::gate::{NoStrategyYet, check_gate};
    let row = |id: &str| CATALOG.iter().find(|uc| uc.id == id).unwrap();
    for id in ["prospects.do_not_contact", "prospects.erase"] {
        let uc = row(id);
        assert_eq!(uc.status_exemption, StatusExemption::Always, "{id}");
        assert_eq!(uc.gate, GateMode::Exempt, "{id}");
        for status in [
            WorkspaceStatus::Active,
            WorkspaceStatus::PendingPayment,
            WorkspaceStatus::Suspended,
        ] {
            check_gate(
                uc,
                status,
                &NoStrategyYet,
                jt_tenancy::WorkspaceId::new_v7(),
            )
            .await
            .unwrap_or_else(|e| panic!("{id} in {status:?}: {e:?}"));
        }
    }
    // Every other pool write stays behind the gate.
    let create = row("prospects.create");
    let e = check_gate(
        create,
        WorkspaceStatus::Suspended,
        &NoStrategyYet,
        jt_tenancy::WorkspaceId::new_v7(),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::WorkspaceInactive);
    // And the use cases themselves do not look at the status.
    let w = world().await;
    let p = create_in(&w, input("Örnek Kafe", PHONE)).await;
    suspend(&w).await;
    prospects::do_not_contact(&w.deps, &w.owner_ctx, dnc(Some(p.id), vec![]))
        .await
        .unwrap();
    let q = {
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        let q = jt_testkit::prospects_contract::prospect(
            w.ws,
            w.owner,
            input("Başka Kafe", "0500 000 00 01"),
            FIXED_NOW,
        );
        r.prospects().insert(&q, &[]).await.unwrap();
        r.commit().await.unwrap();
        q
    };
    prospects::erase(&w.deps, &w.owner_ctx, q.id, EraseInput { confirm: true })
        .await
        .unwrap();
}

async fn create_in(w: &World, i: CreateInput) -> Prospect {
    create(w, &w.owner_ctx, i).await.unwrap()
}

async fn suspend(w: &World) {
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
    // Only the keys given are stored: every other one keeps following its default.
    let stored: Vec<serde_json::Value> = w
        .uow
        .snapshot()
        .workspace_policies
        .iter()
        .map(|p| p.leads.clone())
        .collect();
    assert_eq!(
        stored,
        [json!({"timezone": "America/New_York", "prospects": {"rejected_memory_days": 0}})]
    );
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
