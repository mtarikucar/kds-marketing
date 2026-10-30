//! Recording, checking, editing and reading prospects (spec 2026-10-30-leads-pool-outreach-design.md
//! §3.1, §3.3, §3.7 caps). Every value is invented: `example.invalid` addresses, numbers made of
//! zeros, made-up business names.

mod support;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::usecases::inbox::{erasure, people};
use jt_app::usecases::prospects::{self, CheckInput, ListInput};
use jt_inbox::{IdentityChannel, Source};
use jt_ledger::Actor;
use jt_prospects::{
    Bucket, CreateInput, EntityKind, FieldInput, FieldName, ProspectId, ProspectStatus, Recorder,
    SetFields, SourceRefInput, TaskKind, UpdateInput,
};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::Duration;
use time::macros::datetime;

const PHONE: &str = "0500 000 00 00";
const EMAIL: &str = "bilgi@ornek-kafe.example.invalid";

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
    CreateInput {
        business_name: name.into(),
        entity_kind: EntityKind::LegalEntity,
        sector: Some("kafe".into()),
        city: Some("İstanbul".into()),
        district: None,
        language: Some("tr".into()),
        segment_key: Some("kafeler".into()),
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
    }
}

fn reason(e: &AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

fn assert_refused(e: &AppError, code: ErrorCode, why: &str) {
    assert_eq!(e.code, code, "{e:?}");
    assert_eq!(reason(e), why, "{e:?}");
}

async fn create(w: &World, ctx: &Ctx, i: CreateInput) -> Result<jt_prospects::Prospect, AppError> {
    prospects::create(&w.deps, ctx, i).await.map(|o| o.prospect)
}

/// A person in the inbox with `phone`.
async fn inbox_person(w: &World, phone: &str) -> jt_inbox::PersonId {
    people::create(
        &w.deps,
        &w.owner_ctx,
        people::CreateInput {
            display_name: "Örnek Kafe".into(),
            identities: vec![people::IdentityInput {
                channel: IdentityChannel::Phone,
                value: phone.into(),
                capability_id: None,
            }],
            source: Source::Import,
        },
    )
    .await
    .unwrap()
    .person
    .id
}

/// An open ad-hoc research task with `daily_cap`, under an approved strategy.
async fn task(w: &World, daily_cap: u16) -> jt_prospects::ResearchTaskId {
    let version = w.approve_strategy().await;
    let t = jt_testkit::prospects_contract::task(
        w.ws,
        w.owner,
        version,
        TaskKind::AdHoc { target_count: 100 },
        FIXED_NOW,
    );
    let t = jt_prospects::ResearchTask { daily_cap, ..t };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.research_tasks().insert(&t).await.unwrap();
    r.commit().await.unwrap();
    t.id
}

#[tokio::test]
async fn create_records_the_agent_connection_as_recorder() {
    let w = world().await;
    let agent = w.agent(&["prospects.work"]).await;
    let p = create(&w, &agent, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let Actor::Agent {
        connection_id,
        user_id,
    } = agent.actor.clone()
    else {
        panic!("an agent")
    };
    let expected = Recorder::Agent {
        connection_id,
        user_id,
    };
    assert_eq!(
        p.contact.phone.as_ref().unwrap().evidence.recorder,
        expected
    );
    assert_eq!(p.origin.recorder, expected);
    assert_eq!(p.status, ProspectStatus::New);
    assert_eq!(
        p.purge_after,
        Some(FIXED_NOW + Duration::days(180)),
        "unpromoted retention"
    );
    let entries = w.entries("prospects.created");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].payload["fields"],
        json!(["sector", "city", "language", "segment_key", "phone"])
    );
}

#[tokio::test]
async fn create_by_human_records_the_user() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let expected = Recorder::Human { user_id: w.owner };
    assert_eq!(p.contact.phone.unwrap().evidence.recorder, expected);
    assert_eq!(p.origin.via, jt_prospects::OriginVia::Manual);
}

#[tokio::test]
async fn system_actor_cannot_create() {
    let w = world().await;
    let system = Ctx {
        actor: Actor::System {
            component: "importer".into(),
        },
        ..w.owner_ctx.clone()
    };
    let e = err(create(&w, &system, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Forbidden, "system_actor");
}

#[tokio::test]
async fn refuses_erased_identity_before_anything_else() {
    let w = world().await;
    let person = inbox_person(&w, PHONE).await;
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        person,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let e = err(create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Forbidden, "erased_identity");
    assert_eq!(
        e.details,
        json!({"reason": "erased_identity"}),
        "no other detail"
    );
}

#[tokio::test]
async fn refuses_blocklisted_key() {
    let w = world().await;
    blocklist(
        &w,
        PHONE,
        jt_app::ports::prospects::BlockReason::DoNotContact,
    )
    .await;
    let e = err(create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Forbidden, "do_not_contact");
    assert_eq!(
        e.details,
        json!({"reason": "do_not_contact"}),
        "never a hash"
    );
}

#[tokio::test]
async fn previously_rejected_key_is_a_conflict() {
    let w = world().await;
    blocklist(&w, PHONE, jt_app::ports::prospects::BlockReason::Rejected).await;
    let e = err(create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Conflict, "previously_rejected");
}

/// Puts the phone key of `phone` on the workspace's blocklist with `reason`, hashed as the pool
/// hashes it.
async fn blocklist(w: &World, phone: &str, reason: jt_app::ports::prospects::BlockReason) {
    use hmac::{Hmac, KeyInit, Mac};
    let value = jt_prospects::normalise_key(jt_prospects::KeyKind::Phone, phone).unwrap();
    let secret = w
        .deps
        .seal
        .hmac_key(w.ws, prospects::BLOCKLIST_PURPOSE)
        .unwrap();
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_ref()).unwrap();
    mac.update(&jt_prospects::blocklist_material(
        jt_prospects::KeyKind::Phone,
        &value,
    ));
    let hash: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let expires = (reason == jt_app::ports::prospects::BlockReason::Rejected)
        .then_some(FIXED_NOW + Duration::days(365));
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.prospect_blocklist()
        .insert(
            jt_prospects::KeyKind::Phone,
            &hash,
            reason,
            FIXED_NOW,
            expires,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
}

#[tokio::test]
async fn phone_in_inbox_answers_in_inbox_with_person_id() {
    let w = world().await;
    let person = inbox_person(&w, "+905000000000").await;
    let e = err(create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE)).await);
    assert_refused(&e, ErrorCode::Conflict, "in_inbox");
    assert_eq!(e.details["person_id"], json!(person));
}

#[tokio::test]
async fn duplicate_hard_key_names_the_prospect() {
    let w = world().await;
    let first = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let e = err(create(&w, &w.owner_ctx, input("Başka Ad", "+90 500 000 00 00")).await);
    assert_refused(&e, ErrorCode::Conflict, "duplicate");
    assert_eq!(e.details["prospect_id"], json!(first.id));
}

#[tokio::test]
async fn possible_duplicate_lists_candidates() {
    let w = world().await;
    let first = create(
        &w,
        &w.owner_ctx,
        input("Örnek Kafe Ltd. Şti.", "0500 000 00 01"),
    )
    .await
    .unwrap();
    let e = err(create(&w, &w.owner_ctx, input("ÖRNEK KAFE", "0500 000 00 02")).await);
    assert_refused(&e, ErrorCode::Conflict, "possible_duplicate");
    assert_eq!(
        e.details["candidates"],
        json!([{
            "prospect_id": first.id,
            "business_name": "Örnek Kafe Ltd. Şti.",
            "city": "İstanbul",
            "matched": ["name_city"],
        }])
    );
}

#[tokio::test]
async fn distinct_from_lets_a_branch_through_and_is_recorded() {
    let w = world().await;
    let first = create(&w, &w.owner_ctx, input("Örnek Kafe", "0500 000 00 01"))
        .await
        .unwrap();
    let mut branch = input("Örnek Kafe", "0500 000 00 02");
    branch.distinct_from = vec![first.id];
    let second = create(&w, &w.owner_ctx, branch).await.unwrap();
    assert_eq!(second.origin.distinct_from, [first.id]);
    let entry = w.entries("prospects.created").pop().unwrap();
    assert_eq!(entry.payload["distinct_from"], 1);
}

#[tokio::test]
async fn daily_cap_per_task_in_workspace_time_zone() {
    // 23:30 UTC on the 30th: already the 31st in Istanbul (UTC+3), still the 30th in New York.
    for (tz, before_midnight, next_day) in [
        (
            "Europe/Istanbul",
            datetime!(2026-10-30 20:30 UTC),
            datetime!(2026-10-30 23:30 UTC),
        ),
        (
            "America/New_York",
            datetime!(2026-10-30 23:30 UTC),
            datetime!(2026-10-31 04:30 UTC),
        ),
    ] {
        let w = world().await;
        set_timezone(&w, tz).await;
        let task = task(&w, 2).await;
        let mut ctx = at(&w.owner_ctx, before_midnight - Duration::hours(1));
        for n in 0..2 {
            let mut i = input(&format!("Kafe {n}"), &format!("0500 000 00 0{n}"));
            i.research_task_id = Some(task);
            create(&w, &ctx, i).await.unwrap();
        }
        ctx = at(&w.owner_ctx, before_midnight);
        let mut third = input("Kafe 3", "0500 000 00 03");
        third.research_task_id = Some(task);
        let e = err(create(&w, &ctx, third.clone()).await);
        assert_refused(&e, ErrorCode::Conflict, "daily_cap");
        assert_eq!(e.details["scope"], "task", "{tz}");
        // The next local day takes it.
        ctx = at(&w.owner_ctx, next_day);
        create(&w, &ctx, third)
            .await
            .unwrap_or_else(|e| panic!("{tz}: {e:?}"));
    }
}

async fn set_timezone(w: &World, tz: &str) {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut policy = r.workspace_policy().get().await.unwrap();
    policy.leads.timezone = tz.into();
    r.workspace_policy().set(policy, FIXED_NOW).await.unwrap();
    r.commit().await.unwrap();
}

#[tokio::test]
async fn workspace_ceiling_500() {
    let w = world().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    for n in 0..500u32 {
        let p = jt_testkit::prospects_contract::prospect(
            w.ws,
            w.owner,
            input(&format!("Kafe {n}"), &format!("0500 {n:03} 00 00")),
            FIXED_NOW,
        );
        r.prospects().insert(&p, &[]).await.unwrap();
    }
    r.commit().await.unwrap();
    let e = err(create(&w, &w.owner_ctx, input("Bir Kafe Daha", "0500 999 99 99")).await);
    assert_refused(&e, ErrorCode::Conflict, "daily_cap");
    assert_eq!(e.details["scope"], "workspace");
    assert_eq!(e.details["cap"], 500);
    assert!(e.details["resets_at"].is_string());
}

#[tokio::test]
async fn request_key_replays() {
    let w = world().await;
    let mut i = input("Örnek Kafe", PHONE);
    i.request_key = Some("k-1".into());
    let first = create(&w, &w.owner_ctx, i.clone()).await.unwrap();
    let again = create(&w, &w.owner_ctx, i).await.unwrap();
    assert_eq!(again, first);
    assert_eq!(w.entries("prospects.created").len(), 1);
}

#[tokio::test]
async fn check_writes_nothing() {
    let w = world().await;
    let ok = prospects::check(
        &w.deps,
        &w.owner_ctx,
        CheckInput {
            phone: Some(PHONE.into()),
            business_name: Some("Örnek Kafe".into()),
            city: Some("İstanbul".into()),
            ..CheckInput::default()
        },
    )
    .await
    .unwrap();
    assert!(ok.ok);
    let first = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let before = w.uow.snapshot();
    let dup = prospects::check(
        &w.deps,
        &w.owner_ctx,
        CheckInput {
            phone: Some("+905000000000".into()),
            ..CheckInput::default()
        },
    )
    .await
    .unwrap();
    assert!(!dup.ok);
    assert_eq!(
        serde_json::to_value(&dup).unwrap(),
        json!({"ok": false, "reason": "duplicate", "prospect_id": first.id})
    );
    let soft = prospects::check(
        &w.deps,
        &w.owner_ctx,
        CheckInput {
            business_name: Some("ÖRNEK KAFE LTD".into()),
            city: Some("istanbul".into()),
            ..CheckInput::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(soft.refusal["reason"], "possible_duplicate");
    assert_eq!(
        w.uow.snapshot().ledger.len(),
        before.ledger.len(),
        "nothing written"
    );
    let e = err(prospects::check(&w.deps, &w.owner_ctx, CheckInput::default()).await);
    assert_eq!(e.code, ErrorCode::Validation);
}

fn update_input(revision: u32, set: SetFields, clear: Vec<FieldName>) -> UpdateInput {
    UpdateInput {
        expected_revision: revision,
        set,
        clear,
        distinct_from: vec![],
    }
}

#[tokio::test]
async fn update_changes_keys_and_rechecks_dedupe() {
    let w = world().await;
    let other = create(&w, &w.owner_ctx, input("Başka Kafe", "0500 000 00 09"))
        .await
        .unwrap();
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let steal = update_input(
        1,
        SetFields {
            phone: field("0500 000 00 09"),
            ..SetFields::default()
        },
        vec![],
    );
    let e = err(prospects::update(&w.deps, &w.owner_ctx, p.id, steal).await);
    assert_refused(&e, ErrorCode::Conflict, "duplicate");
    assert_eq!(e.details["prospect_id"], json!(other.id));
    let ok = update_input(
        1,
        SetFields {
            email: field(EMAIL),
            ..SetFields::default()
        },
        vec![FieldName::Phone],
    );
    let out = prospects::update(&w.deps, &w.owner_ctx, p.id, ok)
        .await
        .unwrap();
    assert_eq!(out.prospect.revision, 2);
    // The phone is free now.
    create(&w, &w.owner_ctx, input("Yeni Kafe", PHONE))
        .await
        .unwrap();
    let entry = w.entries("prospects.updated").pop().unwrap();
    assert_eq!(entry.payload["fields"], json!(["phone", "email"]));
}

#[tokio::test]
async fn update_clear_persists() {
    let w = world().await;
    let mut i = input("Örnek Kafe", PHONE);
    i.district = Some("Kadıköy".into());
    i.notes = "a corner cafe".into();
    let p = create(&w, &w.owner_ctx, i).await.unwrap();
    prospects::update(
        &w.deps,
        &w.owner_ctx,
        p.id,
        update_input(
            1,
            SetFields::default(),
            vec![FieldName::District, FieldName::Notes],
        ),
    )
    .await
    .unwrap();
    let back = prospects::get(&w.deps, &w.owner_ctx, p.id)
        .await
        .unwrap()
        .prospect;
    assert_eq!(back.district, None);
    assert_eq!(back.notes, "");
    assert_eq!(back.revision, 2);
}

#[tokio::test]
async fn stale_revision_is_a_conflict() {
    let w = world().await;
    let p = create(&w, &w.owner_ctx, input("Örnek Kafe", PHONE))
        .await
        .unwrap();
    let edit = |rev| {
        update_input(
            rev,
            SetFields {
                notes: Some("x".into()),
                ..SetFields::default()
            },
            vec![],
        )
    };
    prospects::update(&w.deps, &w.owner_ctx, p.id, edit(1))
        .await
        .unwrap();
    let e = err(prospects::update(&w.deps, &w.owner_ctx, p.id, edit(1)).await);
    assert_refused(&e, ErrorCode::Conflict, "stale_revision");
    assert_eq!(e.details["revision"], 2);
    let e = err(prospects::update(&w.deps, &w.owner_ctx, ProspectId::new_v7(), edit(1)).await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn list_filters_by_status_task_city_score_bucket() {
    let w = world().await;
    let task = task(&w, 50).await;
    let mut ids = Vec::new();
    for n in 0..4u8 {
        let mut i = input(&format!("Kafe {n}"), &format!("0500 000 00 0{n}"));
        if n < 2 {
            i.research_task_id = Some(task);
        }
        if n == 3 {
            i.city = Some("Ankara".into());
        }
        let ctx = at(&w.owner_ctx, FIXED_NOW + Duration::seconds(i64::from(n)));
        ids.push(create(&w, &ctx, i).await.unwrap().id);
    }
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.prospects()
        .record_score(&jt_app::ports::prospects::ScoreRow {
            id: uuid::Uuid::now_v7(),
            prospect_id: ids[1],
            score: 80,
            reasons: vec![],
            rubric_digest: "d".into(),
            strategy_version_id: None,
            recorder: Recorder::Human { user_id: w.owner },
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.prospects()
        .set_status(ids[1], ProspectStatus::Qualified, None, None, FIXED_NOW, 1)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let list = |i: ListInput| async {
        prospects::list(&w.deps, &w.owner_ctx, i)
            .await
            .unwrap()
            .items
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        list(ListInput::default()).await,
        [ids[3], ids[2], ids[1], ids[0]]
    );
    assert_eq!(
        list(ListInput {
            status: Some(ProspectStatus::Qualified),
            ..ListInput::default()
        })
        .await,
        [ids[1]]
    );
    assert_eq!(
        list(ListInput {
            research_task_id: Some(task),
            ..ListInput::default()
        })
        .await,
        [ids[1], ids[0]]
    );
    assert_eq!(
        list(ListInput {
            city: Some("Ankara".into()),
            ..ListInput::default()
        })
        .await,
        [ids[3]]
    );
    assert_eq!(
        list(ListInput {
            bucket: Some(Bucket::B75To100),
            ..ListInput::default()
        })
        .await,
        [ids[1]]
    );
    let page = prospects::list(
        &w.deps,
        &w.owner_ctx,
        ListInput {
            limit: Some(3),
            ..ListInput::default()
        },
    )
    .await
    .unwrap();
    let next = page.next.unwrap();
    assert_eq!(
        list(ListInput {
            before_at: Some(next.before_at),
            before_id: Some(next.before_id),
            ..ListInput::default()
        })
        .await,
        [ids[0]]
    );
    let rows = serde_json::to_value(&page.items).unwrap();
    assert!(
        rows[0].get("contact").is_none(),
        "a list row carries no contact values"
    );
    let e = err(prospects::list(
        &w.deps,
        &w.owner_ctx,
        ListInput {
            limit: Some(0),
            ..ListInput::default()
        },
    )
    .await);
    assert_invalid(&e, "limit");
}

#[tokio::test]
async fn get_includes_evidence_and_scores() {
    let w = world().await;
    let first = create(&w, &w.owner_ctx, input("Örnek Kafe", "0500 000 00 01"))
        .await
        .unwrap();
    let mut branch = input("Örnek Kafe", "0500 000 00 02");
    branch.distinct_from = vec![first.id];
    let p = create(&w, &w.owner_ctx, branch).await.unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.prospects()
        .record_score(&jt_app::ports::prospects::ScoreRow {
            id: uuid::Uuid::now_v7(),
            prospect_id: p.id,
            score: 40,
            reasons: vec![],
            rubric_digest: "d".into(),
            strategy_version_id: None,
            recorder: Recorder::Human { user_id: w.owner },
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let out = prospects::get(&w.deps, &w.owner_ctx, p.id).await.unwrap();
    assert_eq!(
        out.prospect
            .contact
            .phone
            .as_ref()
            .unwrap()
            .evidence
            .sources
            .len(),
        1
    );
    assert_eq!(out.scores.len(), 1);
    assert_eq!(out.duplicate_candidates.len(), 1);
    assert_eq!(out.duplicate_candidates[0].prospect_id, first.id);
    assert_eq!(out.ledger.len(), 1);
    assert_eq!(out.ledger[0].entry.action.as_str(), "prospects.created");
    let e = err(prospects::get(&w.deps, &w.owner_ctx, ProspectId::new_v7()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn pool_requires_prospects_work() {
    let w = world().await;
    let rep = w.member("rep").await;
    let e = err(create(&w, &rep, input("Örnek Kafe", PHONE)).await);
    assert_forbidden(&e, "prospects.work");
    let e = err(prospects::list(&w.deps, &rep, ListInput::default()).await);
    assert_forbidden(&e, "prospects.work");
    let e = err(prospects::check(&w.deps, &rep, CheckInput::default()).await);
    assert_forbidden(&e, "prospects.work");
    let agent = w.agent(&["inbox.work"]).await;
    let e = err(create(&w, &agent, input("Örnek Kafe", PHONE)).await);
    assert_forbidden(&e, "prospects.work");
}

/// Every value the fixture holds, as it could appear in a ledger payload.
fn values() -> Vec<&'static str> {
    vec![
        "905000000000",
        "0500 000",
        "Örnek",
        "ornek",
        "bilgi@",
        "İstanbul",
        "istanbul",
        "corner",
    ]
}

#[tokio::test]
async fn ledger_payloads_hold_no_values() {
    let w = world().await;
    let mut i = input("Örnek Kafe", PHONE);
    i.email = field(EMAIL);
    i.notes = "a corner cafe".into();
    let p = create(&w, &w.owner_ctx, i).await.unwrap();
    prospects::update(
        &w.deps,
        &w.owner_ctx,
        p.id,
        update_input(
            1,
            SetFields {
                website: field("https://ornek-kafe.example.invalid"),
                ..SetFields::default()
            },
            vec![FieldName::Notes],
        ),
    )
    .await
    .unwrap();
    let entries = w.ledger("prospects.");
    assert!(entries.len() >= 2);
    for e in entries {
        let text = e.payload.to_string();
        for v in values() {
            assert!(
                !text.contains(v),
                "{} carries {v}: {text}",
                e.action.as_str()
            );
        }
    }
}
