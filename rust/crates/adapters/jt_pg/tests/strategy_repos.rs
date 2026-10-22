//! Strategy versions, hypotheses, the consultation log and the strategy gate against a real
//! database: the repos' contracts, the partial unique indexes behind "one draft, one approved",
//! the append-only log, workspace scoping, and the gate opening on approval.

use jt_app::error::{AppError, ErrorCode};
use jt_app::gate::StrategyGate;
use jt_app::ports::UnitOfWork;
use jt_ledger::Actor;
use jt_pg::{PgStrategyGate, PgUnitOfWork, TenantTx};
use jt_strategy::{
    ConsultationEntry, ConsultationKind, Hypothesis, HypothesisId, HypothesisState, Identity,
    Sections, Segment, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use jt_testkit::TestDb;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const T0: OffsetDateTime = datetime!(2030-01-01 09:00 UTC);

fn uow(db: &TestDb) -> PgUnitOfWork {
    PgUnitOfWork::new(db.pool.clone())
}

/// The code of a result that must be an error.
fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

fn human(user: UserId) -> Actor {
    Actor::Human { user_id: user }
}

fn version(ws: WorkspaceId, number: i32, status: VersionStatus, by: Actor) -> StrategyVersion {
    StrategyVersion {
        id: StrategyVersionId::new_v7(),
        workspace_id: ws,
        number,
        status,
        sections: Sections::default(),
        created_at: T0,
        created_by: by,
        submitted_at: None,
        approved_at: None,
        approved_by: None,
        archived_at: None,
    }
}

fn sections(product: &str) -> Sections {
    Sections {
        identity: Identity {
            product: product.into(),
            voice: "sıcak".into(),
            ..Identity::default()
        },
        audience: vec![Segment {
            key: "esnaf".into(),
            name: "Esnaf".into(),
            description: "Mahalle esnafı".into(),
        }],
        prohibitions: vec!["fiyat kıyaslaması".into()],
        paid_enabled: true,
        ..Sections::default()
    }
}

fn hypothesis(title: &str, confidence: f32) -> Hypothesis {
    Hypothesis {
        id: HypothesisId::new_v7(),
        title: title.into(),
        segment_key: "esnaf".into(),
        angle: "zaman kazancı".into(),
        channel: "instagram".into(),
        metric: "dm_replies".into(),
        confidence,
        state: HypothesisState::Kept,
    }
}

fn entry(
    version: StrategyVersionId,
    kind: ConsultationKind,
    text: &str,
    actor: Actor,
    at: OffsetDateTime,
) -> ConsultationEntry {
    ConsultationEntry::new(version, kind, None, text.into(), actor, at).unwrap()
}

/// Inserts and commits `v`.
async fn insert(uow: &PgUnitOfWork, v: &StrategyVersion) {
    let mut t = uow.tenant(v.workspace_id).await.unwrap();
    t.strategy().insert(v.clone()).await.unwrap();
    t.commit().await.unwrap();
}

async fn find(uow: &PgUnitOfWork, ws: WorkspaceId, id: StrategyVersionId) -> StrategyVersion {
    let mut t = uow.tenant(ws).await.unwrap();
    t.strategy().find(id).await.unwrap().expect("the version")
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn one_approved_version_per_workspace_is_enforced_by_the_index() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let mut v1 = version(a, 1, VersionStatus::Approved, human(owner));
    v1.approved_at = Some(T0);
    v1.approved_by = Some(owner);
    insert(&uow, &v1).await;

    // Through the repo: a second approved version is CONFLICT.
    let v2 = version(a, 2, VersionStatus::Approved, human(owner));
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.strategy().insert(v2.clone()).await),
        ErrorCode::Conflict
    );
    drop(t);

    // The refusal is the partial unique index's, not a check in the repo.
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let err = sqlx::query(
        "insert into strategy_versions (id, workspace_id, number, status, created_at, \
         created_by_user) values ($1, $2, 2, 'approved', $3, $4)",
    )
    .bind(Uuid::now_v7())
    .bind(a.as_uuid())
    .bind(T0)
    .bind(owner.as_uuid())
    .execute(tx.conn())
    .await
    .unwrap_err();
    let db_err = err.as_database_error().expect("a database error");
    assert_eq!(db_err.code().as_deref(), Some("23505"), "{db_err}");
    assert_eq!(db_err.constraint(), Some("strategy_versions_one_approved"));
    tx.rollback().await.unwrap();

    // Another workspace has its own approved version.
    insert(&uow, &version(b, 1, VersionStatus::Approved, human(owner))).await;

    // Approving a draft while another version is approved is CONFLICT too.
    let v3 = version(a, 3, VersionStatus::Draft, human(owner));
    insert(&uow, &v3).await;
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .set_status(v3.id, VersionStatus::Approved, T0, Some(owner))
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);

    // Archiving the approved one first, in the same transaction, lets the draft through.
    let at = T0 + Duration::hours(1);
    let mut t = uow.tenant(a).await.unwrap();
    let s = t.strategy();
    assert_eq!(
        s.set_status(v1.id, VersionStatus::Archived, at, Some(owner))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.set_status(v3.id, VersionStatus::Approved, at, Some(owner))
            .await
            .unwrap(),
        1
    );
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    let approved = t.strategy().current_approved().await.unwrap().unwrap();
    assert_eq!(approved.id, v3.id);
    assert_eq!(approved.approved_at, Some(at));
    assert_eq!(approved.approved_by, Some(owner));
    assert_eq!(t.strategy().current_draft().await.unwrap(), None);
    let old = t.strategy().find(v1.id).await.unwrap().unwrap();
    assert_eq!(old.status, VersionStatus::Archived);
    assert_eq!(old.archived_at, Some(at));
    // Archiving keeps the record of the approval.
    assert_eq!(old.approved_at, Some(T0));
    assert_eq!(old.approved_by, Some(owner));
}

#[tokio::test]
async fn two_racing_approvals_end_with_exactly_one_approved_version() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;

    // Two transactions each insert an approved version; the second waits for the first, then
    // loses on the index.
    let mut first = uow.tenant(a).await.unwrap();
    first
        .strategy()
        .insert(version(a, 1, VersionStatus::Approved, human(owner)))
        .await
        .unwrap();
    let racer = {
        let uow = uow.clone();
        tokio::spawn(async move {
            let mut second = uow.tenant(a).await.unwrap();
            second
                .strategy()
                .insert(version(a, 2, VersionStatus::Approved, human(owner)))
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    first.commit().await.unwrap();
    assert_eq!(code(racer.await.unwrap()), ErrorCode::Conflict);

    // Two transactions approving the same draft: the second one changes no row.
    let draft = version(a, 3, VersionStatus::Draft, human(owner));
    insert(&uow, &draft).await;
    let mut t = uow.tenant(a).await.unwrap();
    let approved = t.strategy().current_approved().await.unwrap().unwrap();
    t.commit().await.unwrap();

    let mut first = uow.tenant(a).await.unwrap();
    let s = first.strategy();
    assert_eq!(
        s.set_status(approved.id, VersionStatus::Archived, T0, Some(owner))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Approved, T0, Some(owner))
            .await
            .unwrap(),
        1
    );
    let racer = {
        let uow = uow.clone();
        let draft = draft.id;
        tokio::spawn(async move {
            let mut second = uow.tenant(a).await.unwrap();
            let changed = second
                .strategy()
                .set_status(draft, VersionStatus::Approved, T0, Some(owner))
                .await;
            second.commit().await.unwrap();
            changed
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    first.commit().await.unwrap();
    assert_eq!(racer.await.unwrap().unwrap(), 0);

    let mut t = uow.tenant(a).await.unwrap();
    let approved: Vec<StrategyVersion> = t
        .strategy()
        .list()
        .await
        .unwrap()
        .into_iter()
        .filter(|v| v.status == VersionStatus::Approved)
        .collect();
    assert_eq!(approved.len(), 1);
    assert_eq!(approved[0].id, draft.id);
}

#[tokio::test]
async fn one_draft_per_workspace() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let v1 = version(a, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &v1).await;

    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .insert(version(a, 2, VersionStatus::Draft, human(owner)))
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);

    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let err = sqlx::query(
        "insert into strategy_versions (id, workspace_id, number, status, created_at, \
         created_by_user) values ($1, $2, 2, 'draft', $3, $4)",
    )
    .bind(Uuid::now_v7())
    .bind(a.as_uuid())
    .bind(T0)
    .bind(owner.as_uuid())
    .execute(tx.conn())
    .await
    .unwrap_err();
    let db_err = err.as_database_error().expect("a database error");
    assert_eq!(db_err.constraint(), Some("strategy_versions_one_draft"));
    tx.rollback().await.unwrap();

    // Another workspace has its own draft.
    insert(&uow, &version(b, 1, VersionStatus::Draft, human(owner))).await;

    // Once the draft is archived, a new one can open.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.strategy().current_draft().await.unwrap(),
        Some(v1.clone())
    );
    assert_eq!(
        t.strategy()
            .set_status(v1.id, VersionStatus::Archived, T0, None)
            .await
            .unwrap(),
        1
    );
    let v2 = version(a, 2, VersionStatus::Draft, human(owner));
    t.strategy().insert(v2.clone()).await.unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.strategy().current_draft().await.unwrap(), Some(v2));
}

#[tokio::test]
async fn versions_round_trip_list_newest_first_and_number_on() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let connection = AgentConnectionId::new_v7();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.strategy().next_number().await.unwrap(), 1);
    assert_eq!(t.strategy().list().await.unwrap(), vec![]);
    drop(t);

    // Every kind of creator round-trips, as do the sections and every timestamp.
    let mut v1 = version(a, 1, VersionStatus::Archived, human(owner));
    v1.sections = sections("Kahve");
    v1.submitted_at = Some(T0);
    v1.approved_at = Some(T0 + Duration::minutes(1));
    v1.approved_by = Some(owner);
    v1.archived_at = Some(T0 + Duration::minutes(2));
    let mut v2 = version(
        a,
        2,
        VersionStatus::Approved,
        Actor::Agent {
            connection_id: connection,
            user_id: owner,
        },
    );
    v2.sections = sections("Çay");
    let v3 = version(
        a,
        3,
        VersionStatus::Draft,
        Actor::System {
            component: "importer".into(),
        },
    );
    for v in [&v1, &v2, &v3] {
        insert(&uow, v).await;
    }

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.strategy().list().await.unwrap(),
        vec![v3.clone(), v2.clone(), v1.clone()]
    );
    assert_eq!(t.strategy().find(v1.id).await.unwrap(), Some(v1.clone()));
    assert_eq!(t.strategy().current_approved().await.unwrap(), Some(v2));
    assert_eq!(t.strategy().current_draft().await.unwrap(), Some(v3));
    assert_eq!(t.strategy().next_number().await.unwrap(), 4);

    // A taken number or id is CONFLICT.
    let r = t
        .strategy()
        .insert(version(a, 1, VersionStatus::Archived, human(owner)))
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let mut same_id = version(a, 9, VersionStatus::Archived, human(owner));
    same_id.id = v1.id;
    assert_eq!(
        code(t.strategy().insert(same_id).await),
        ErrorCode::Conflict
    );
    drop(t);

    // An approver who is no user is NOT_FOUND.
    let mut t = uow.tenant(a).await.unwrap();
    let mut ghost = version(a, 9, VersionStatus::Archived, human(owner));
    ghost.approved_by = Some(UserId::new_v7());
    assert_eq!(code(t.strategy().insert(ghost).await), ErrorCode::NotFound);
}

#[tokio::test]
async fn sections_and_submission_change_only_on_a_draft() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;

    let draft = version(a, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &draft).await;

    let mut t = uow.tenant(a).await.unwrap();
    t.strategy()
        .update_sections(draft.id, sections("Kahve"), T0)
        .await
        .unwrap();
    t.strategy()
        .set_submitted(draft.id, Some(T0 + Duration::minutes(5)))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let stored = find(&uow, a, draft.id).await;
    assert_eq!(stored.sections, sections("Kahve"));
    assert_eq!(stored.submitted_at, Some(T0 + Duration::minutes(5)));

    // Withdrawing the submission clears it.
    let mut t = uow.tenant(a).await.unwrap();
    t.strategy().set_submitted(draft.id, None).await.unwrap();
    t.commit().await.unwrap();
    assert_eq!(find(&uow, a, draft.id).await.submitted_at, None);

    // An unknown id is NOT_FOUND.
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .update_sections(StrategyVersionId::new_v7(), sections("x"), T0)
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .set_submitted(StrategyVersionId::new_v7(), Some(T0))
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);

    // Once approved, the sections and the submission stay as they were.
    let mut t = uow.tenant(a).await.unwrap();
    t.strategy()
        .set_status(draft.id, VersionStatus::Approved, T0, Some(owner))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .update_sections(draft.id, sections("Çay"), T0)
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t.strategy().set_submitted(draft.id, None).await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);
    assert_eq!(find(&uow, a, draft.id).await.sections, sections("Kahve"));
}

#[tokio::test]
async fn set_status_moves_only_forward() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let draft = version(a, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &draft).await;

    let mut t = uow.tenant(a).await.unwrap();
    let s = t.strategy();
    // An unknown id changes nothing.
    assert_eq!(
        s.set_status(
            StrategyVersionId::new_v7(),
            VersionStatus::Archived,
            T0,
            None
        )
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Approved, T0, Some(owner))
            .await
            .unwrap(),
        1
    );
    // Approving an approved version changes nothing.
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Approved, T0, Some(owner))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Archived, T0, None)
            .await
            .unwrap(),
        1
    );
    // Neither does archiving an archived one, nor approving it.
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Archived, T0, None)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Approved, T0, Some(owner))
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();

    // A version never returns to draft.
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .set_status(draft.id, VersionStatus::Draft, T0, None)
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
    drop(t);

    // An approver who is no user is NOT_FOUND.
    let other = version(a, 2, VersionStatus::Draft, human(owner));
    insert(&uow, &other).await;
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .set_status(
            other.id,
            VersionStatus::Approved,
            T0,
            Some(UserId::new_v7()),
        )
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
}

#[tokio::test]
async fn another_workspaces_version_is_invisible_and_untouchable() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let theirs = version(b, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &theirs).await;

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.strategy().find(theirs.id).await.unwrap(), None);
    assert_eq!(t.strategy().list().await.unwrap(), vec![]);
    assert_eq!(t.strategy().current_draft().await.unwrap(), None);
    assert_eq!(t.strategy().next_number().await.unwrap(), 1);
    assert_eq!(
        t.strategy()
            .set_status(theirs.id, VersionStatus::Archived, T0, None)
            .await
            .unwrap(),
        0
    );
    let r = t
        .strategy()
        .update_sections(theirs.id, sections("x"), T0)
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);

    // Hypotheses and consultation entries cannot hang off it either.
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .hypotheses()
        .replace_all(theirs.id, vec![hypothesis("h", 0.5)])
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t.hypotheses().upsert(theirs.id, hypothesis("h", 0.5)).await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .consultation()
        .append(entry(
            theirs.id,
            ConsultationKind::Note,
            "n",
            human(owner),
            T0,
        ))
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);

    // A version for another workspace handed to this bundle is INTERNAL.
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .strategy()
        .insert(version(b, 2, VersionStatus::Archived, human(owner)))
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
}

// ---------------------------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn hypotheses_replace_and_set_state() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let v1 = version(a, 1, VersionStatus::Archived, human(owner));
    let v2 = version(a, 2, VersionStatus::Draft, human(owner));
    insert(&uow, &v1).await;
    insert(&uow, &v2).await;

    let (h1, h2, h3) = (
        hypothesis("one", 0.25),
        hypothesis("two", 0.5),
        hypothesis("three", 0.75),
    );
    let mut t = uow.tenant(a).await.unwrap();
    t.hypotheses()
        .replace_all(v1.id, vec![h1.clone(), h2.clone()])
        .await
        .unwrap();
    // The same hypothesis id lives on in the next version.
    t.hypotheses()
        .replace_all(v2.id, vec![h2.clone(), h1.clone()])
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.hypotheses().list(v1.id).await.unwrap(),
        vec![h1.clone(), h2.clone()]
    );
    assert_eq!(
        t.hypotheses().list(v2.id).await.unwrap(),
        vec![h2.clone(), h1.clone()]
    );

    // Replacing drops what is not listed and keeps the given order.
    let h2_edited = Hypothesis {
        title: "two, edited".into(),
        state: HypothesisState::Kept,
        ..h2.clone()
    };
    t.hypotheses()
        .replace_all(v2.id, vec![h3.clone(), h2_edited.clone()])
        .await
        .unwrap();
    t.hypotheses()
        .set_state(v2.id, h2.id, HypothesisState::Retired)
        .await
        .unwrap();
    // Upserting a new one appends it; upserting a listed one edits it in place.
    let h4 = Hypothesis {
        state: HypothesisState::Added,
        ..hypothesis("four", 1.0)
    };
    t.hypotheses().upsert(v2.id, h4.clone()).await.unwrap();
    let h3_edited = Hypothesis {
        confidence: 0.0,
        ..h3.clone()
    };
    t.hypotheses()
        .upsert(v2.id, h3_edited.clone())
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    let h2_retired = Hypothesis {
        state: HypothesisState::Retired,
        ..h2_edited
    };
    assert_eq!(
        t.hypotheses().list(v2.id).await.unwrap(),
        vec![h3_edited, h2_retired, h4]
    );
    // The earlier version is untouched.
    assert_eq!(
        t.hypotheses().list(v1.id).await.unwrap(),
        vec![h1.clone(), h2.clone()]
    );
    // An unknown version lists nothing.
    assert_eq!(
        t.hypotheses()
            .list(StrategyVersionId::new_v7())
            .await
            .unwrap(),
        vec![]
    );
    drop(t);

    // Another workspace sees none of them.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.hypotheses().list(v2.id).await.unwrap(), vec![]);
    drop(t);

    // Refusals.
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .hypotheses()
        .set_state(v2.id, HypothesisId::new_v7(), HypothesisState::Retired)
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .hypotheses()
        .replace_all(StrategyVersionId::new_v7(), vec![])
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .hypotheses()
        .replace_all(v2.id, vec![h1.clone(), h1.clone()])
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .hypotheses()
        .replace_all(v2.id, vec![hypothesis("too sure", 1.5)])
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
}

// ---------------------------------------------------------------------------------------------
// Consultation log
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn consultation_is_append_only_and_lists_newest_first() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let v1 = version(a, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &v1).await;

    let agent = Actor::Agent {
        connection_id: AgentConnectionId::new_v7(),
        user_id: owner,
    };
    let e1 = entry(
        v1.id,
        ConsultationKind::Question,
        "Ne satıyorsunuz?",
        agent.clone(),
        T0,
    );
    let e2 = entry(
        v1.id,
        ConsultationKind::Answer,
        "Kahve.",
        human(owner),
        T0 + Duration::minutes(1),
    );
    let e3 = ConsultationEntry::new(
        v1.id,
        ConsultationKind::SectionDraft,
        Some("identity".into()),
        "Kimlik taslağı yazıldı.".into(),
        Actor::System {
            component: "drafter".into(),
        },
        T0 + Duration::minutes(2),
    )
    .unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    for e in [&e1, &e2, &e3] {
        assert_eq!(t.consultation().append(e.clone()).await.unwrap(), e.id);
    }
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    let c = t.consultation();
    assert_eq!(
        c.list(v1.id, 10, None).await.unwrap(),
        vec![e3.clone(), e2.clone(), e1.clone()]
    );
    assert_eq!(
        c.list(v1.id, 2, None).await.unwrap(),
        vec![e3.clone(), e2.clone()]
    );
    assert_eq!(
        c.list(v1.id, 10, Some(e2.at)).await.unwrap(),
        vec![e1.clone()]
    );
    // The limit is clamped to at least one.
    assert_eq!(c.list(v1.id, 0, None).await.unwrap(), vec![e3.clone()]);
    drop(t);

    // Another workspace sees none of them.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.consultation().list(v1.id, 10, None).await.unwrap(),
        vec![]
    );
    drop(t);

    // A taken id is CONFLICT; an unknown version NOT_FOUND.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.consultation().append(e1.clone()).await),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .consultation()
        .append(entry(
            StrategyVersionId::new_v7(),
            ConsultationKind::Note,
            "n",
            human(owner),
            T0,
        ))
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);

    // The log cannot be changed or deleted, even by its own workspace.
    for statement in [
        "update consultation_entries set text = 'changed' where workspace_id = $1",
        "delete from consultation_entries where workspace_id = $1",
    ] {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let err = sqlx::query(statement)
            .bind(a.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.consultation().list(v1.id, 10, None).await.unwrap().len(),
        3
    );
}

// ---------------------------------------------------------------------------------------------
// Row-level security and the gate
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn strategy_tables_are_hidden_without_their_workspace_in_scope() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let v1 = version(a, 1, VersionStatus::Draft, human(owner));
    let mut t = uow.tenant(a).await.unwrap();
    t.strategy().insert(v1.clone()).await.unwrap();
    t.hypotheses()
        .replace_all(v1.id, vec![hypothesis("h", 0.5)])
        .await
        .unwrap();
    t.consultation()
        .append(entry(v1.id, ConsultationKind::Note, "n", human(owner), T0))
        .await
        .unwrap();
    t.commit().await.unwrap();

    for table in [
        "strategy_versions",
        "strategy_hypotheses",
        "consultation_entries",
    ] {
        let count = format!("select count(*) from {table}");
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} is visible without a workspace in scope");

        let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} shows another workspace's rows");
        tx.rollback().await.unwrap();

        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 1, "{table} hides its own workspace's rows");
        tx.rollback().await.unwrap();
    }
}

#[tokio::test]
async fn strategy_gate_flips_when_a_version_is_approved() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let gate = PgStrategyGate::new(db.pool.clone());
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    assert!(!gate.has_approved_strategy(a).await.unwrap());

    // A draft does not open the gate.
    let draft = version(a, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &draft).await;
    assert!(!gate.has_approved_strategy(a).await.unwrap());

    // Nor does an approval that is not committed yet.
    let mut t = uow.tenant(a).await.unwrap();
    t.strategy()
        .set_status(draft.id, VersionStatus::Approved, T0, Some(owner))
        .await
        .unwrap();
    assert!(!gate.has_approved_strategy(a).await.unwrap());
    t.commit().await.unwrap();
    assert!(gate.has_approved_strategy(a).await.unwrap());

    // Only for its own workspace.
    assert!(!gate.has_approved_strategy(b).await.unwrap());

    // Archiving closes it again.
    let mut t = uow.tenant(a).await.unwrap();
    t.strategy()
        .set_status(draft.id, VersionStatus::Archived, T0, Some(owner))
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert!(!gate.has_approved_strategy(a).await.unwrap());
}
