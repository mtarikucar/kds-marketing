//! The prospect pool's repository contracts (`jt_app::ports::prospects`), exercised by both
//! adapters: the in-memory fake (`tests/prospects_fakes.rs`) and PostgreSQL
//! (`jt_pg/tests/prospects_repos.rs`). Races between bundles are PostgreSQL's own tests.
//! Every value is invented: `example.invalid` addresses, numbers made of zeros.

use std::sync::Arc;

use jt_app::ports::prospects::{
    BlockReason, Inserted, ListCursor, ProspectQuery, ResearchTaskQuery, ScoreRow, Updated,
};
use jt_app::ports::{UnitOfWork, WorkspacePolicy};
use jt_ledger::Actor;
use jt_prospects::{
    Brief, Bucket, Claim, CreateInput, DecisionKind, EntityKind, FieldInput, Key, KeyKind,
    Prospect, ProspectId, ProspectStatus, Reason, Recorder, RejectReason, ResearchTask,
    ResearchTaskId, SourceRef, SourceRefInput, TaskKind, TaskStatus, derive_keys,
};
use jt_strategy::{Area, Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::{UserId, WorkspaceId};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::fakes::FIXED_NOW;
use crate::inbox_contract::Fixture;

/// `FIXED_NOW` plus `s` seconds.
pub fn at(s: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(s)
}

/// The recorder the contracts write as.
pub fn human(user: UserId) -> Recorder {
    Recorder::Human { user_id: user }
}

fn source() -> Vec<SourceRefInput> {
    vec![SourceRefInput::Url {
        url: "https://ornek.example.invalid/iletisim".into(),
        note: Some("contact page".into()),
    }]
}

fn field(value: &str) -> Option<FieldInput<String>> {
    Some(FieldInput {
        value: value.to_owned(),
        sources: source(),
        captured_at: FIXED_NOW - Duration::days(1),
    })
}

/// A valid create input for a business called `name` in İstanbul with phone `phone`.
pub fn input(name: &str, phone: &str) -> CreateInput {
    CreateInput {
        business_name: name.into(),
        entity_kind: EntityKind::LegalEntity,
        sector: Some("kafe".into()),
        city: Some("İstanbul".into()),
        district: Some("Kadıköy".into()),
        language: Some("tr".into()),
        segment_key: Some("kafeler".into()),
        country: None,
        labels: vec!["sicak".into()],
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

/// The prospect `input` builds for workspace `ws`, created at `created_at`.
pub fn prospect(
    ws: WorkspaceId,
    user: UserId,
    input: CreateInput,
    created_at: OffsetDateTime,
) -> Prospect {
    jt_prospects::validate_create(&input, created_at, &human(user)).expect("a valid input");
    let mut p = jt_prospects::build(
        input,
        ProspectId(Uuid::now_v7()),
        ws,
        created_at,
        human(user),
    );
    p.purge_after = Some(created_at + Duration::days(180));
    p
}

/// Stores `p` with its derived keys in one bundle.
pub async fn store(uow: &Arc<dyn UnitOfWork>, p: &Prospect) -> Inserted {
    let mut t = uow.tenant(p.workspace_id).await.unwrap();
    t.prospects().lock_pool().await.unwrap();
    let out = t.prospects().insert(p, &derive_keys(p)).await.unwrap();
    t.commit().await.unwrap();
    out
}

async fn get(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId, id: ProspectId) -> Option<Prospect> {
    let mut t = uow.tenant(ws).await.unwrap();
    t.prospects().get(id).await.unwrap()
}

/// An approved strategy version of `ws`, for research tasks to hang off.
pub async fn approved_version(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = uow.tenant(ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections::default(),
            created_at: FIXED_NOW,
            created_by: Actor::System {
                component: "prospects_contract".into(),
            },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: None,
            archived_at: None,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    id
}

/// An open task of `ws` under `version`.
pub fn task(
    ws: WorkspaceId,
    user: UserId,
    version: StrategyVersionId,
    kind: TaskKind,
    created_at: OffsetDateTime,
) -> ResearchTask {
    ResearchTask {
        id: ResearchTaskId(Uuid::now_v7()),
        workspace_id: ws,
        kind,
        strategy_version_id: version,
        brief: Brief {
            segment_key: Some("kafeler".into()),
            sectors: vec!["kafe".into()],
            areas: vec![Area {
                city: "İstanbul".into(),
                district: None,
            }],
            ..Brief::default()
        },
        rubric_digest: "d".repeat(64),
        daily_cap: 20,
        status: TaskStatus::Open,
        claim: None,
        created_by: human(user),
        created_at,
        closed_at: None,
        close_note: String::new(),
    }
}

fn hash(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

pub async fn insert_then_get_round_trips_every_field(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let version = approved_version(&uow, f.ws).await;
    let t = task(
        f.ws,
        f.user,
        version,
        TaskKind::AdHoc { target_count: 5 },
        at(0),
    );
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(tx.research_tasks().insert(&t).await.unwrap());
    tx.commit().await.unwrap();

    let mut i = input("Örnek Kafe", "0500 000 00 00");
    i.email = field("bilgi@ornek.example.invalid");
    i.website = field("https://www.ornek.example.invalid/");
    i.instagram = field("@ornek.kafe");
    i.tiktok = field("@ornek.kafe");
    i.address = field("Örnek Sokak 0");
    i.contact_person = Some(FieldInput {
        value: jt_prospects::ContactPerson {
            name: "Ayşe Örnek".into(),
            role: "Kurucu".into(),
        },
        sources: source(),
        captured_at: FIXED_NOW,
    });
    i.size = Some(FieldInput {
        value: jt_prospects::SizeHint {
            branches: Some(2),
            employees: Some(jt_prospects::EmployeeBand::B10To49),
            note: Some("two branches".into()),
        },
        sources: source(),
        captured_at: FIXED_NOW,
    });
    i.signals = vec![jt_prospects::SignalInput {
        text: "new menu".into(),
        source: source().remove(0),
    }];
    i.research_task_id = Some(t.id);
    i.discovered_at = source();
    i.distinct_from = vec![ProspectId(Uuid::from_u128(7))];
    let mut p = prospect(f.ws, f.user, i, at(1));
    p.contact.email.as_mut().unwrap().deliverable = false;
    assert_eq!(store(&uow, &p).await, Inserted::Ok);
    assert_eq!(get(&uow, f.ws, p.id).await.as_ref(), Some(&p));
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(tx.prospects().lock(p.id).await.unwrap().as_ref(), Some(&p));
    assert_eq!(tx.prospects().keys_of(p.id).await.unwrap(), derive_keys(&p));
    let back = tx.research_tasks().get(t.id).await.unwrap();
    assert_eq!(back.as_ref(), Some(&t));
    assert_eq!(
        tx.prospects().get(ProspectId::new_v7()).await.unwrap(),
        None
    );
    // A taken id is a conflict.
    let err = tx.prospects().insert(&p, &[]).await.unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::Conflict);
}

pub async fn hard_key_duplicate_is_reported_with_its_owner(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let first = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(0));
    assert_eq!(store(&uow, &first).await, Inserted::Ok);
    let second = prospect(f.ws, f.user, input("Başka Kafe", "+90 500 000 0000"), at(1));
    assert_eq!(
        store(&uow, &second).await,
        Inserted::DuplicateKey {
            kind: KeyKind::Phone,
            prospect_id: first.id
        }
    );
    assert_eq!(get(&uow, f.ws, second.id).await, None, "nothing written");
    // The other workspace may hold the same number.
    let other = prospect(
        f.other,
        f.user,
        input("Örnek Kafe", "0500 000 00 00"),
        at(2),
    );
    assert_eq!(store(&uow, &other).await, Inserted::Ok);
}

pub async fn soft_keys_never_conflict(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let mut a = input("Örnek Kafe", "0500 000 00 01");
    a.website = field("https://ornek.example.invalid");
    let mut b = input("Örnek Kafe", "0500 000 00 02");
    b.website = field("https://ornek.example.invalid/sube");
    let (a, b) = (
        prospect(f.ws, f.user, a, at(0)),
        prospect(f.ws, f.user, b, at(1)),
    );
    assert_eq!(store(&uow, &a).await, Inserted::Ok);
    assert_eq!(store(&uow, &b).await, Inserted::Ok);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let found = t
        .prospects()
        .find_by_keys(&[
            Key {
                kind: KeyKind::Domain,
                value: "ornek.example.invalid".into(),
            },
            Key {
                kind: KeyKind::NameCity,
                value: "ornek kafe|istanbul".into(),
            },
        ])
        .await
        .unwrap();
    let mut expected = vec![
        (KeyKind::Domain, a.id),
        (KeyKind::Domain, b.id),
        (KeyKind::NameCity, a.id),
        (KeyKind::NameCity, b.id),
    ];
    expected.sort();
    assert_eq!(found, expected);
    assert!(t.prospects().find_by_keys(&[]).await.unwrap().is_empty());
}

pub async fn update_is_revision_checked(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(0));
    store(&uow, &p).await;
    let mut changed = p.clone();
    changed.notes = "changed".into();
    changed.revision = 2;
    changed.updated_at = at(10);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let keys = derive_keys(&changed);
    assert_eq!(
        t.prospects().update(&changed, &keys, 2).await.unwrap(),
        Updated::Stale
    );
    assert_eq!(
        t.prospects().update(&changed, &keys, 1).await.unwrap(),
        Updated::Ok
    );
    t.commit().await.unwrap();
    let back = get(&uow, f.ws, p.id).await.unwrap();
    assert_eq!(back.notes, "changed");
    assert_eq!(back.revision, 2);
    assert_eq!(back.updated_at, at(10));
    assert_eq!(back.created_at, p.created_at);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.prospects().update(&changed, &keys, 1).await.unwrap(),
        Updated::Stale,
        "the same revision twice"
    );
    let mut missing = changed.clone();
    missing.id = ProspectId::new_v7();
    let err = t.prospects().update(&missing, &[], 1).await.unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::NotFound);
}

pub async fn update_replaces_keys(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(0));
    let q = prospect(f.ws, f.user, input("Başka Kafe", "0500 000 00 09"), at(1));
    store(&uow, &p).await;
    store(&uow, &q).await;
    let mut changed = p.clone();
    changed.contact.phone = None;
    changed.contact.email = Some(jt_prospects::Field {
        value: "bilgi@ornek.example.invalid".into(),
        evidence: p.contact.phone.clone().unwrap().evidence,
        deliverable: true,
    });
    let keys = derive_keys(&changed);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.prospects().update(&changed, &keys, 1).await.unwrap(),
        Updated::Ok
    );
    assert_eq!(t.prospects().keys_of(p.id).await.unwrap(), keys);
    t.commit().await.unwrap();
    // The old phone is free now; the other prospect's phone is not.
    let reuse = prospect(f.ws, f.user, input("Yeni Kafe", "0500 000 00 00"), at(2));
    assert_eq!(store(&uow, &reuse).await, Inserted::Ok);
    let mut steal = get(&uow, f.ws, p.id).await.unwrap();
    steal.contact.phone = q.contact.phone.clone();
    let keys = derive_keys(&steal);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.prospects().update(&steal, &keys, 2).await.unwrap(),
        Updated::DuplicateKey {
            kind: KeyKind::Phone,
            prospect_id: q.id
        }
    );
    t.commit().await.unwrap();
    assert_eq!(
        get(&uow, f.ws, p.id).await.unwrap().revision,
        2,
        "nothing written"
    );
}

pub async fn record_score_sets_latest_in_the_same_call(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(0));
    store(&uow, &p).await;
    let row = |id: u128, score: u8, s: i64| ScoreRow {
        id: Uuid::from_u128(id),
        prospect_id: p.id,
        score,
        reasons: vec![Reason {
            criterion: "fit".into(),
            points: score,
            evidence: "their menu".into(),
            source: Some(SourceRef::Url {
                url: "https://ornek.example.invalid/menu".into(),
                note: None,
            }),
        }],
        rubric_digest: format!("digest-{id}"),
        strategy_version_id: None,
        recorder: human(f.user),
        at: at(s),
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.prospects().record_score(&row(1, 40, 10)).await.unwrap();
    t.prospects().record_score(&row(2, 80, 20)).await.unwrap();
    // An older score recorded late is history, not the latest.
    t.prospects().record_score(&row(3, 10, 5)).await.unwrap();
    t.commit().await.unwrap();
    let back = get(&uow, f.ws, p.id).await.unwrap();
    let latest = back.latest_score.unwrap();
    assert_eq!(
        (latest.score, latest.digest.as_str(), latest.at),
        (80, "digest-2", at(20))
    );
    assert_eq!(back.revision, 1, "a score is not an edit");
    assert_eq!(back.updated_at, p.updated_at);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let scores = t.prospects().scores(p.id, 2).await.unwrap();
    assert_eq!(scores, vec![row(2, 80, 20), row(1, 40, 10)]);
    assert_eq!(t.prospects().count_unscored("digest-2").await.unwrap(), 0);
    assert_eq!(t.prospects().count_unscored("digest-9").await.unwrap(), 1);
    let mut missing = row(4, 1, 1);
    missing.prospect_id = ProspectId::new_v7();
    let err = t.prospects().record_score(&missing).await.unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::NotFound);
}

pub async fn list_filters_and_cursor(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let version = approved_version(&uow, f.ws).await;
    let t = task(
        f.ws,
        f.user,
        version,
        TaskKind::AdHoc { target_count: 5 },
        at(0),
    );
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.research_tasks().insert(&t).await.unwrap();
    tx.commit().await.unwrap();
    let mut ids = Vec::new();
    for n in 0..5u8 {
        let mut i = input(&format!("Kafe {n}"), &format!("0500 000 00 0{n}"));
        if n % 2 == 0 {
            i.research_task_id = Some(t.id);
        }
        if n == 4 {
            i.city = Some("Ankara".into());
        }
        let p = prospect(f.ws, f.user, i, at(i64::from(n)));
        store(&uow, &p).await;
        ids.push(p.id);
    }
    // One scored 60 (bucket 50-74) and qualified.
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.prospects()
        .record_score(&ScoreRow {
            id: Uuid::now_v7(),
            prospect_id: ids[2],
            score: 60,
            reasons: vec![],
            rubric_digest: "d".into(),
            strategy_version_id: None,
            recorder: human(f.user),
            at: at(30),
        })
        .await
        .unwrap();
    tx.prospects()
        .set_status(ids[2], ProspectStatus::Qualified, None, None, at(31), 1)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let all = |q: ProspectQuery| ProspectQuery { limit: 10, ..q };
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let page = tx
        .prospects()
        .list(&all(ProspectQuery::default()))
        .await
        .unwrap();
    let listed: Vec<ProspectId> = page.items.iter().map(|r| r.id).collect();
    assert_eq!(
        listed,
        ids.iter().rev().copied().collect::<Vec<_>>(),
        "newest first"
    );
    assert_eq!(page.next, None);
    // The fields a row holds, never their values: sector, city, district, language, segment,
    // labels, phone, notes.
    assert_eq!(page.items[0].fields.len(), 8);
    drop(tx);
    let by = |q: ProspectQuery| {
        let uow = uow.clone();
        let ws = f.ws;
        async move {
            let mut t = uow.tenant(ws).await.unwrap();
            let page = t.prospects().list(&all(q)).await.unwrap();
            page.items.iter().map(|r| r.id).collect::<Vec<_>>()
        }
    };
    assert_eq!(
        by(ProspectQuery {
            status: Some(ProspectStatus::Qualified),
            ..Default::default()
        })
        .await,
        [ids[2]]
    );
    assert_eq!(
        by(ProspectQuery {
            research_task_id: Some(t.id),
            ..Default::default()
        })
        .await,
        [ids[4], ids[2], ids[0]]
    );
    assert_eq!(
        by(ProspectQuery {
            city: Some("Ankara".into()),
            ..Default::default()
        })
        .await,
        [ids[4]]
    );
    assert_eq!(
        by(ProspectQuery {
            bucket: Some(Bucket::B50To74),
            ..Default::default()
        })
        .await,
        [ids[2]]
    );
    assert!(
        by(ProspectQuery {
            bucket: Some(Bucket::B75To100),
            ..Default::default()
        })
        .await
        .is_empty()
    );
    // Pages of two, following the cursor.
    let mut t = uow.tenant(f.ws).await.unwrap();
    let mut seen = Vec::new();
    let mut after: Option<ListCursor> = None;
    loop {
        let page = t
            .prospects()
            .list(&ProspectQuery {
                limit: 2,
                after,
                ..Default::default()
            })
            .await
            .unwrap();
        seen.extend(page.items.iter().map(|r| r.id));
        match page.next {
            Some(c) => after = Some(c),
            None => break,
        }
    }
    assert_eq!(seen, ids.iter().rev().copied().collect::<Vec<_>>());
}

pub async fn delete_returns_keys_and_cascades_scores(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(0));
    store(&uow, &p).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.prospects()
        .record_score(&ScoreRow {
            id: Uuid::now_v7(),
            prospect_id: p.id,
            score: 10,
            reasons: vec![],
            rubric_digest: "d".into(),
            strategy_version_id: None,
            recorder: human(f.user),
            at: at(1),
        })
        .await
        .unwrap();
    assert_eq!(t.prospects().delete(p.id).await.unwrap(), derive_keys(&p));
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.prospects().get(p.id).await.unwrap(), None);
    assert!(t.prospects().keys_of(p.id).await.unwrap().is_empty());
    assert!(t.prospects().scores(p.id, 10).await.unwrap().is_empty());
    assert!(
        t.prospects().delete(p.id).await.unwrap().is_empty(),
        "twice"
    );
    // Its phone is free again.
    let again = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(2));
    t.prospects()
        .insert(&again, &derive_keys(&again))
        .await
        .unwrap();
}

pub async fn due_for_purge_respects_time(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let mut early = prospect(f.ws, f.user, input("Bir", "0500 000 00 01"), at(0));
    early.purge_after = Some(at(100));
    let mut late = prospect(f.ws, f.user, input("İki", "0500 000 00 02"), at(0));
    late.purge_after = Some(at(200));
    let mut never = prospect(f.ws, f.user, input("Üç", "0500 000 00 03"), at(0));
    never.purge_after = None;
    let mut other = prospect(f.other, f.user, input("Dört", "0500 000 00 04"), at(0));
    other.purge_after = Some(at(1));
    for p in [&early, &late, &never, &other] {
        store(&uow, p).await;
    }
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert!(
        t.prospects()
            .due_for_purge(at(99), 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        t.prospects().due_for_purge(at(100), 10).await.unwrap(),
        [early.id]
    );
    assert_eq!(
        t.prospects().due_for_purge(at(1_000), 10).await.unwrap(),
        [early.id, late.id]
    );
    assert_eq!(
        t.prospects().due_for_purge(at(1_000), 1).await.unwrap(),
        [early.id]
    );
}

pub async fn status_promotion_and_counts(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(0));
    let q = prospect(f.ws, f.user, input("Başka Kafe", "0500 000 00 01"), at(5));
    store(&uow, &p).await;
    store(&uow, &q).await;
    let decision = jt_prospects::Decision {
        kind: DecisionKind::Rejected(RejectReason::NotIcp),
        note: String::new(),
        by: human(f.user),
        at: at(10),
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.prospects()
            .set_status(
                p.id,
                ProspectStatus::Rejected,
                Some(&decision),
                Some(at(99)),
                at(10),
                2
            )
            .await
            .unwrap(),
        Updated::Stale
    );
    assert_eq!(
        t.prospects()
            .set_status(
                p.id,
                ProspectStatus::Rejected,
                Some(&decision),
                Some(at(99)),
                at(10),
                1
            )
            .await
            .unwrap(),
        Updated::Ok
    );
    t.commit().await.unwrap();
    let back = get(&uow, f.ws, p.id).await.unwrap();
    assert_eq!(back.status, ProspectStatus::Rejected);
    assert_eq!(back.decision, Some(decision));
    assert_eq!(
        (back.purge_after, back.updated_at, back.revision),
        (Some(at(99)), at(10), 2)
    );
    assert_eq!(back.contact, p.contact, "a decision keeps the record");
    let mut t = uow.tenant(f.ws).await.unwrap();
    // A reopen clears the decision.
    t.prospects()
        .set_status(p.id, ProspectStatus::New, None, Some(at(500)), at(11), 2)
        .await
        .unwrap();
    assert_eq!(
        t.prospects().get(p.id).await.unwrap().unwrap().decision,
        None
    );
    assert_eq!(t.prospects().backlog("kafeler").await.unwrap(), 2);
    assert_eq!(t.prospects().backlog("other").await.unwrap(), 0);
    t.prospects()
        .set_status(
            q.id,
            ProspectStatus::Qualified,
            None,
            Some(at(600)),
            at(12),
            1,
        )
        .await
        .unwrap();
    assert_eq!(t.prospects().count_qualified_unpromoted().await.unwrap(), 1);
    assert_eq!(
        t.prospects()
            .created_between(None, at(0), at(5))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        t.prospects()
            .created_between(None, at(0), at(6))
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        t.prospects()
            .created_between(Some(ResearchTaskId::new_v7()), at(0), at(6))
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();

    // Promotion needs a person and a journey of the workspace.
    let person = f.insert_person("Örnek Kafe").await;
    let journey = jt_inbox::begin_journey(
        jt_inbox::JourneyId::new_v7(),
        f.ws,
        person.id,
        jt_inbox::Source::Import,
        FIXED_NOW,
    );
    let journey_id = journey.journey().id;
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.people().set_write_time(FIXED_NOW).await.unwrap();
    t.journeys().insert_initial(journey).await.unwrap();
    let promotion = jt_prospects::Promotion {
        person_id: person.id,
        journey_id,
        at: at(20),
        score: Some(60),
        bucket: Some(Bucket::B50To74),
    };
    t.prospects().set_promoted(q.id, &promotion).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    let back = t.prospects().by_person(person.id).await.unwrap().unwrap();
    assert_eq!(back.id, q.id);
    assert_eq!(back.status, ProspectStatus::Promoted);
    assert_eq!(back.promoted, Some(promotion));
    assert_eq!(back.purge_after, None);
    assert_eq!(back.revision, 3);
    assert_eq!(t.prospects().count_qualified_unpromoted().await.unwrap(), 0);
    assert_eq!(
        t.prospects()
            .promoted_between(at(20), at(21))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        t.prospects()
            .promoted_between(at(21), at(22))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        derive_keys(&back),
        t.prospects().keys_of(q.id).await.unwrap(),
        "a promoted prospect keeps its keys"
    );
    let err = t
        .prospects()
        .set_promoted(ProspectId::new_v7(), &back.promoted.clone().unwrap())
        .await
        .unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::NotFound);
}

pub async fn research_tasks_round_trip_and_one_standing_per_entry(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let version = approved_version(&uow, f.ws).await;
    let standing = |key: &str, s: i64| {
        task(
            f.ws,
            f.user,
            version,
            TaskKind::Standing {
                icp_key: key.into(),
            },
            at(s),
        )
    };
    let (a, a_again, b) = (
        standing("kafeler", 0),
        standing("kafeler", 1),
        standing("pastaneler", 2),
    );
    let adhoc = task(
        f.ws,
        f.user,
        version,
        TaskKind::AdHoc { target_count: 10 },
        at(3),
    );
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert!(t.research_tasks().insert(&a).await.unwrap());
    assert!(
        !t.research_tasks().insert(&a_again).await.unwrap(),
        "one open per entry"
    );
    assert!(t.research_tasks().insert(&b).await.unwrap());
    assert!(t.research_tasks().insert(&adhoc).await.unwrap());
    t.commit().await.unwrap();
    // A refusal spoils its bundle: each one in a bundle of its own.
    let mut t = uow.tenant(f.ws).await.unwrap();
    let err = t.research_tasks().insert(&a).await.unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::Conflict, "a taken id");
    drop(t);
    let mut stray = adhoc.clone();
    stray.id = ResearchTaskId::new_v7();
    stray.strategy_version_id = StrategyVersionId::new_v7();
    let mut t = uow.tenant(f.ws).await.unwrap();
    let err = t.research_tasks().insert(&stray).await.unwrap_err();
    assert_eq!(
        err.code,
        jt_app::error::ErrorCode::NotFound,
        "no such version"
    );
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let open: Vec<ResearchTaskId> = t
        .research_tasks()
        .open_standing(version)
        .await
        .unwrap()
        .iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(open, [a.id, b.id]);
    // Closing one makes room for a new open one of the same entry.
    t.research_tasks()
        .set_status(a.id, TaskStatus::Superseded, at(10), "new version")
        .await
        .unwrap();
    assert!(t.research_tasks().insert(&a_again).await.unwrap());
    let claim = Claim {
        by: human(f.user),
        until: at(7_200),
    };
    t.research_tasks()
        .set_claim(b.id, Some(&claim))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    let closed = t.research_tasks().get(a.id).await.unwrap().unwrap();
    assert_eq!(closed.status, TaskStatus::Superseded);
    assert_eq!(closed.closed_at, Some(at(10)));
    assert_eq!(closed.close_note, "new version");
    assert_eq!(
        t.research_tasks().lock(b.id).await.unwrap().unwrap().claim,
        Some(claim)
    );
    t.research_tasks().set_claim(b.id, None).await.unwrap();
    assert_eq!(
        t.research_tasks().get(b.id).await.unwrap().unwrap().claim,
        None
    );
    let page = t
        .research_tasks()
        .list(&ResearchTaskQuery {
            status: Some(TaskStatus::Open),
            limit: 2,
            after: None,
        })
        .await
        .unwrap();
    let listed: Vec<ResearchTaskId> = page.items.iter().map(|t| t.id).collect();
    assert_eq!(listed, [adhoc.id, b.id], "newest first");
    let rest = t
        .research_tasks()
        .list(&ResearchTaskQuery {
            status: Some(TaskStatus::Open),
            limit: 2,
            after: page.next,
        })
        .await
        .unwrap();
    assert_eq!(
        rest.items.iter().map(|t| t.id).collect::<Vec<_>>(),
        [a_again.id]
    );
    assert_eq!(rest.next, None);
    let err = t
        .research_tasks()
        .set_status(ResearchTaskId::new_v7(), TaskStatus::Done, at(1), "")
        .await
        .unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::NotFound);
}

pub async fn blocklist_dnc_upgrades_rejected(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    let b = t.prospect_blocklist();
    b.insert(
        KeyKind::Phone,
        &hash(1),
        BlockReason::Rejected,
        at(0),
        Some(at(100)),
    )
    .await
    .unwrap();
    // A longer rejection memory wins; a shorter one does not shorten it.
    b.insert(
        KeyKind::Phone,
        &hash(1),
        BlockReason::Rejected,
        at(1),
        Some(at(200)),
    )
    .await
    .unwrap();
    b.insert(
        KeyKind::Phone,
        &hash(1),
        BlockReason::Rejected,
        at(2),
        Some(at(150)),
    )
    .await
    .unwrap();
    assert_eq!(
        b.contains(KeyKind::Phone, &hash(1), at(199)).await.unwrap(),
        Some(BlockReason::Rejected)
    );
    assert_eq!(
        b.contains(KeyKind::Phone, &hash(1), at(200)).await.unwrap(),
        None
    );
    b.insert(
        KeyKind::Phone,
        &hash(1),
        BlockReason::DoNotContact,
        at(3),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        b.contains(KeyKind::Phone, &hash(1), at(10_000))
            .await
            .unwrap(),
        Some(BlockReason::DoNotContact),
        "an objection never expires"
    );
    // A weaker reason never downgrades; an erasure is the strongest.
    b.insert(
        KeyKind::Phone,
        &hash(1),
        BlockReason::Rejected,
        at(4),
        Some(at(5)),
    )
    .await
    .unwrap();
    assert_eq!(
        b.contains(KeyKind::Phone, &hash(1), at(10_000))
            .await
            .unwrap(),
        Some(BlockReason::DoNotContact)
    );
    b.insert(KeyKind::Phone, &hash(1), BlockReason::Erased, at(5), None)
        .await
        .unwrap();
    b.insert(
        KeyKind::Phone,
        &hash(1),
        BlockReason::DoNotContact,
        at(6),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        b.contains(KeyKind::Phone, &hash(1), at(10_000))
            .await
            .unwrap(),
        Some(BlockReason::Erased)
    );
    // Kinds are apart.
    assert_eq!(
        b.contains(KeyKind::Email, &hash(1), at(0)).await.unwrap(),
        None
    );
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    let err = t
        .prospect_blocklist()
        .insert(KeyKind::Phone, "not-hex", BlockReason::Erased, at(0), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::Internal);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let err = t
        .prospect_blocklist()
        .insert(KeyKind::Phone, &hash(2), BlockReason::Rejected, at(0), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::Internal);
}

pub async fn blocklist_expired_rejected_is_ignored(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    let b = t.prospect_blocklist();
    b.insert(
        KeyKind::Domain,
        &hash(3),
        BlockReason::Rejected,
        at(0),
        Some(at(10)),
    )
    .await
    .unwrap();
    b.insert(
        KeyKind::Domain,
        &hash(4),
        BlockReason::Rejected,
        at(0),
        Some(at(20)),
    )
    .await
    .unwrap();
    b.insert(
        KeyKind::Domain,
        &hash(5),
        BlockReason::DoNotContact,
        at(0),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        b.contains(KeyKind::Domain, &hash(3), at(10)).await.unwrap(),
        None
    );
    assert_eq!(b.purge_expired(at(10)).await.unwrap(), 1);
    assert_eq!(b.purge_expired(at(10)).await.unwrap(), 0);
    assert_eq!(b.purge_expired(at(1_000)).await.unwrap(), 1);
    assert_eq!(
        b.contains(KeyKind::Domain, &hash(5), at(1_000))
            .await
            .unwrap(),
        Some(BlockReason::DoNotContact),
        "purging never touches an objection"
    );
}

pub async fn lift_refuses_erased(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    let b = t.prospect_blocklist();
    b.insert(
        KeyKind::Email,
        &hash(6),
        BlockReason::DoNotContact,
        at(0),
        None,
    )
    .await
    .unwrap();
    b.insert(KeyKind::Email, &hash(7), BlockReason::Erased, at(0), None)
        .await
        .unwrap();
    b.insert(
        KeyKind::Email,
        &hash(8),
        BlockReason::Rejected,
        at(0),
        Some(at(99)),
    )
    .await
    .unwrap();
    assert!(b.lift(KeyKind::Email, &hash(6)).await.unwrap());
    assert!(!b.lift(KeyKind::Email, &hash(6)).await.unwrap(), "twice");
    assert!(!b.lift(KeyKind::Email, &hash(7)).await.unwrap());
    assert!(!b.lift(KeyKind::Email, &hash(8)).await.unwrap());
    assert_eq!(
        b.contains(KeyKind::Email, &hash(6), at(1)).await.unwrap(),
        None
    );
    assert_eq!(
        b.contains(KeyKind::Email, &hash(7), at(1)).await.unwrap(),
        Some(BlockReason::Erased)
    );
}

pub async fn rows_are_workspace_scoped(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let version = approved_version(&uow, f.ws).await;
    let p = prospect(f.ws, f.user, input("Örnek Kafe", "0500 000 00 00"), at(0));
    store(&uow, &p).await;
    let tk = task(
        f.ws,
        f.user,
        version,
        TaskKind::AdHoc { target_count: 1 },
        at(0),
    );
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.research_tasks().insert(&tk).await.unwrap();
    t.prospect_blocklist()
        .insert(
            KeyKind::Phone,
            &hash(9),
            BlockReason::DoNotContact,
            at(0),
            None,
        )
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut o = uow.tenant(f.other).await.unwrap();
    assert_eq!(o.prospects().get(p.id).await.unwrap(), None);
    assert_eq!(o.prospects().lock(p.id).await.unwrap(), None);
    assert!(o.prospects().keys_of(p.id).await.unwrap().is_empty());
    assert!(
        o.prospects()
            .find_by_keys(&derive_keys(&p))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        o.prospects()
            .list(&ProspectQuery {
                limit: 10,
                ..Default::default()
            })
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert!(o.prospects().delete(p.id).await.unwrap().is_empty());
    assert_eq!(o.research_tasks().get(tk.id).await.unwrap(), None);
    assert_eq!(
        o.prospect_blocklist()
            .contains(KeyKind::Phone, &hash(9), at(1))
            .await
            .unwrap(),
        None
    );
    assert!(
        !o.prospect_blocklist()
            .lift(KeyKind::Phone, &hash(9))
            .await
            .unwrap()
    );
    // A row for another workspace is refused.
    let err = o.prospects().insert(&p, &[]).await.unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::Internal);
    drop(o);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.prospects().get(p.id).await.unwrap().as_ref(),
        Some(&p),
        "still there"
    );
}

pub async fn leads_policy_merges_defaults_key_by_key(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.workspace_policy().get().await.unwrap(),
        WorkspacePolicy::default()
    );
    let mut policy = WorkspacePolicy::default();
    policy.leads.prospects.rejected_retention_days = 7;
    policy.leads.timezone = "America/New_York".into();
    t.workspace_policy()
        .set(policy.clone(), at(0))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.workspace_policy().get().await.unwrap(), policy);
    // A stored partial object reads every missing key as its default (bug class "stale stored
    // aggregate").
    let partial: jt_app::ports::LeadsPolicy = serde_json::from_value(
        serde_json::json!({"prospects": {"rejected_memory_days": 0}, "attachments": {}}),
    )
    .unwrap();
    let mut expected = jt_app::ports::LeadsPolicy::default();
    expected.prospects.rejected_memory_days = 0;
    assert_eq!(partial, expected);
}
