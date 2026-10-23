//! Strategy versions, hypotheses, the consultation log and the strategy gate against a real
//! database: the repos' contracts, the partial unique indexes behind "one draft, one approved",
//! the append-only log, workspace scoping, and the gate opening on approval.

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::gate::StrategyGate;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::strategy::{self, ApproveInput, ArchiveInput, RecordInput, RecordKind};
use jt_ledger::Actor;
use jt_pg::{PgStrategyGate, PgUnitOfWork, PlatformTx, TenantTx};
use jt_strategy::{
    ConsultationEntry, ConsultationEntryId, ConsultationKind, Hypothesis, HypothesisId,
    HypothesisState, Identity, Sections, Segment, StrategyVersion, StrategyVersionId,
    VersionStatus,
};
use jt_tenancy::{AgentConnectionId, SystemRole, UserId, WorkspaceId};
use jt_testkit::TestDb;
use serde_json::json;
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

fn hypothesis(title: &str, prior_confidence: f32) -> Hypothesis {
    Hypothesis {
        cadence: Default::default(),
        derived_confidence: None,
        id: HypothesisId::new_v7(),
        title: title.into(),
        segment_key: "esnaf".into(),
        angle: "zaman kazancı".into(),
        channel: "instagram".into(),
        metric: "dm_replies".into(),
        prior_confidence,
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
        prior_confidence: 0.0,
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
        c.list(v1.id, 10, Some((e2.at, e2.id))).await.unwrap(),
        vec![e1.clone()]
    );
    // The limit is clamped to at least one.
    assert_eq!(c.list(v1.id, 0, None).await.unwrap(), vec![e3.clone()]);
    assert_eq!(c.count(v1.id).await.unwrap(), 3);
    assert_eq!(c.count(StrategyVersionId::new_v7()).await.unwrap(), 0);
    drop(t);

    // Another workspace sees none of them.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.consultation().list(v1.id, 10, None).await.unwrap(),
        vec![]
    );
    assert_eq!(t.consultation().count(v1.id).await.unwrap(), 0);
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

#[tokio::test]
async fn consultation_pages_by_keyset_through_entries_sharing_an_instant() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let v1 = version(a, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &v1).await;

    // Five entries at one instant (as under a fixed clock), one earlier.
    let mut entries: Vec<ConsultationEntry> = (0..5)
        .map(|i| {
            entry(
                v1.id,
                ConsultationKind::Note,
                &format!("note {i}"),
                human(owner),
                T0 + Duration::minutes(1),
            )
        })
        .collect();
    entries.push(entry(
        v1.id,
        ConsultationKind::Note,
        "earlier",
        human(owner),
        T0,
    ));
    let mut t = uow.tenant(a).await.unwrap();
    for e in &entries {
        t.consultation().append(e.clone()).await.unwrap();
    }
    t.commit().await.unwrap();

    let mut newest_first = entries.clone();
    newest_first.sort_by_key(|e| std::cmp::Reverse((e.at, e.id)));

    // Pages of two, each starting after the previous page's last (at, id): nothing skipped or
    // repeated.
    let mut t = uow.tenant(a).await.unwrap();
    let mut paged = Vec::new();
    let mut cursor: Option<(OffsetDateTime, ConsultationEntryId)> = None;
    loop {
        let page = t.consultation().list(v1.id, 2, cursor).await.unwrap();
        let Some(last) = page.last() else { break };
        cursor = Some((last.at, last.id));
        paged.extend(page);
    }
    assert_eq!(paged, newest_first);
}

// ---------------------------------------------------------------------------------------------
// Locking the draft
// ---------------------------------------------------------------------------------------------

/// Waits until another backend of this database waits for a lock; panics after ten seconds.
async fn wait_for_a_lock_waiter(db: &TestDb) {
    wait_for_lock_waiters(db, 1).await;
}

async fn wait_for_lock_waiters(db: &TestDb, expected: i64) {
    for _ in 0..500 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() \
             and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        if waiting >= expected {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("fewer than {expected} backends waited for a lock");
}

#[tokio::test]
async fn lock_draft_blocks_a_second_locker_until_commit() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let draft = version(a, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &draft).await;

    // A locks the draft and edits it; B's lock waits for A and then reads A's edit.
    let mut first = uow.tenant(a).await.unwrap();
    let locked = first.strategy().lock_draft().await.unwrap();
    assert_eq!(locked, Some(draft.clone()));
    first
        .strategy()
        .update_sections(draft.id, sections("Kahve"), T0)
        .await
        .unwrap();
    let second = {
        let uow = uow.clone();
        tokio::spawn(async move {
            let mut t = uow.tenant(a).await.unwrap();
            let seen = t.strategy().lock_draft().await.unwrap();
            t.commit().await.unwrap();
            seen
        })
    };
    wait_for_a_lock_waiter(&db).await;
    assert!(!second.is_finished(), "the second locker did not wait");
    first.commit().await.unwrap();
    let seen = second.await.unwrap().expect("the draft");
    assert_eq!(seen.sections, sections("Kahve"));

    // A locks the draft and approves it; B's lock waits, then finds no draft at all.
    let mut first = uow.tenant(a).await.unwrap();
    assert!(first.strategy().lock_draft().await.unwrap().is_some());
    first
        .strategy()
        .set_status(draft.id, VersionStatus::Approved, T0, Some(owner))
        .await
        .unwrap();
    let second = {
        let uow = uow.clone();
        tokio::spawn(async move {
            let mut t = uow.tenant(a).await.unwrap();
            t.strategy().lock_draft().await.unwrap()
        })
    };
    wait_for_a_lock_waiter(&db).await;
    assert!(!second.is_finished(), "the second locker did not wait");
    first.commit().await.unwrap();
    assert_eq!(second.await.unwrap(), None);

    // With no draft there is nothing to lock.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.strategy().lock_draft().await.unwrap(), None);
}

// ---------------------------------------------------------------------------------------------
// The schema on its own
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_schema_ties_hypotheses_and_entries_to_a_version_of_their_own_workspace() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let theirs = version(b, 1, VersionStatus::Draft, human(owner));
    insert(&uow, &theirs).await;

    // Even platform-wide, where row-level security lets any workspace through, a row of `a`
    // cannot hang off a version of `b`.
    for statement in [
        "insert into strategy_hypotheses (version_id, workspace_id, hypothesis_id, title, \
         segment_key, angle, channel, metric, prior_confidence, state, position) \
         values ($1, $2, $3, 't', 's', 'a', 'c', 'm', 0.5, 'kept', 0)",
        "insert into consultation_entries (version_id, workspace_id, id, kind, text, \
         actor_kind, actor_component, at) values ($1, $2, $3, 'note', 't', 'system', 'x', now())",
    ] {
        let mut p = PlatformTx::begin(&db.pool).await.unwrap();
        let err = sqlx::query(statement)
            .bind(theirs.id.as_uuid())
            .bind(a.as_uuid())
            .bind(Uuid::now_v7())
            .execute(p.conn())
            .await
            .unwrap_err();
        let db_err = err.as_database_error().expect("a database error");
        assert_eq!(db_err.code().as_deref(), Some("23503"), "{db_err}");
        p.rollback().await.unwrap();
    }

    // An actor kind outside the three is refused.
    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query(
        "insert into consultation_entries (version_id, workspace_id, id, kind, text, \
         actor_kind, actor_component, at) values ($1, $2, $3, 'note', 't', 'robot', 'x', now())",
    )
    .bind(theirs.id.as_uuid())
    .bind(b.as_uuid())
    .bind(Uuid::now_v7())
    .execute(p.conn())
    .await
    .unwrap_err();
    let db_err = err.as_database_error().expect("a database error");
    assert_eq!(db_err.code().as_deref(), Some("23514"), "{db_err}");
    p.rollback().await.unwrap();
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

#[tokio::test]
async fn derived_confidence_cannot_edit_hypothesis_content() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("studio-confidence").await;
    let u = uow(&db);
    let approved = version(ws, 1, VersionStatus::Approved, human(user));
    insert(&u, &approved).await;
    let mut h = hypothesis("Original", 0.2);
    h.cadence.insert(
        jt_strategy::LaneKind::Organic,
        jt_strategy::HypothesisCadence {
            slots_per_week: 7,
            exploration_bps: 1000,
            content_types: vec![jt_strategy::ContentTypeShare {
                key: "image".into(),
                min_bps: 0,
                max_bps: 10000,
            }],
        },
    );
    let mut tx = u.tenant(ws).await.unwrap();
    tx.hypotheses()
        .upsert(approved.id, h.clone())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let draft = version(ws, 2, VersionStatus::Draft, human(user));
    insert(&u, &draft).await;
    let mut tx = u.tenant(ws).await.unwrap();
    tx.hypotheses()
        .replace_all(draft.id, vec![h.clone()])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = u.tenant(ws).await.unwrap();
    tx.hypotheses()
        .set_derived_confidence(h.id, 0.8, "post:one:24h")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut edited = h.clone();
    edited.title = "Edited".into();
    edited.prior_confidence = 0.1;
    edited.derived_confidence = Some(0.99); // content writes cannot author learning.
    let mut tx = u.tenant(ws).await.unwrap();
    tx.hypotheses()
        .replace_all(draft.id, vec![edited])
        .await
        .unwrap();
    let row = tx.hypotheses().list(draft.id).await.unwrap().remove(0);
    assert_eq!(row.cadence, h.cadence);
    assert_eq!(
        (
            row.title.as_str(),
            row.prior_confidence,
            row.derived_confidence
        ),
        ("Edited", 0.1, Some(0.8))
    );
    assert_eq!(
        tx.hypotheses().list(approved.id).await.unwrap()[0].title,
        "Original"
    );
    tx.commit().await.unwrap();
    let (other, _) = db.seed_workspace("studio-other").await;
    let mut tx = u.tenant(other).await.unwrap();
    assert_eq!(
        tx.hypotheses()
            .set_derived_confidence(h.id, 0.9, "foreign")
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(tx);
    let mut tx = u.tenant(ws).await.unwrap();
    tx.hypotheses()
        .set_derived_confidence(h.id, 0.8, "post:one:24h")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = u.tenant(ws).await.unwrap();
    assert_eq!(
        tx.hypotheses()
            .set_derived_confidence(h.id, 0.9, "post:one:24h")
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}

#[tokio::test]
async fn execution_frame_serializes_even_without_an_approved_version() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("studio-frame").await;
    let u = uow(&db);
    let mut first = u.tenant(ws).await.unwrap();
    assert!(
        first
            .strategy()
            .lock_execution_frame()
            .await
            .unwrap()
            .is_none()
    );
    let mut second = u.tenant(ws).await.unwrap();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            second.strategy().lock_execution_frame()
        )
        .await
        .is_err()
    );
    first.commit().await.unwrap();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            second.strategy().lock_execution_frame()
        )
        .await
        .unwrap()
        .unwrap()
        .is_none()
    );
}

#[tokio::test]
async fn execution_frame_allows_ledger_foreign_key_checks() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("frame-ledger").await;
    let u = uow(&db);
    let mut frame = u.tenant(ws).await.unwrap();
    frame.strategy().lock_execution_frame().await.unwrap();
    let mut writer = u.tenant(ws).await.unwrap();
    let entry = jt_ledger::LedgerEntry {
        workspace_id: ws,
        at: T0,
        actor: human(owner),
        action: jt_ledger::Action::new("strategy.record").unwrap(),
        subject: None,
        payload: json!({}),
        strategy_version_id: None,
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        writer.ledger().append(entry),
    )
    .await
    .expect("workspace frame must allow ledger foreign-key checks")
    .unwrap();
    writer.commit().await.unwrap();
    frame.commit().await.unwrap();
}

#[tokio::test]
async fn strategy_transition_and_draft_edits_never_deadlock() {
    let db = TestDb::new().await;
    let u = uow(&db);
    let deps = jt_testkit::fakes::deps(Arc::new(u.clone()));
    // Queue the editor before the transition behind a held draft lock. With the old order,
    // the transition holds the workspace while waiting for the draft; after release the
    // editor holds the draft while its ledger FK waits for the workspace: a real deadlock.
    for iteration in 0..10 {
        for archive in [false, true] {
            for edit in ["record", "write_section", "set_hypotheses"] {
                let (ws, owner) = db.seed_workspace("transition-edit").await;
                let ctx = Ctx {
                    workspace_id: ws,
                    actor: human(owner),
                    permissions: SystemRole::Owner.permissions(),
                    role_key: Some("owner".into()),
                    now: T0,
                    agent_connection_id: None,
                };
                let previous = version(ws, 1, VersionStatus::Approved, human(owner));
                insert(&u, &previous).await;
                let mut draft = version(ws, 2, VersionStatus::Draft, human(owner));
                draft.sections = sections("Coffee");
                draft.sections.paid_enabled = false;
                jt_strategy::parse_section_strict(
                    "channels",
                    &json!([{"channel": "any", "rationale": "reach"}]),
                )
                .unwrap()
                .apply(&mut draft.sections);
                draft.submitted_at = Some(T0);
                insert(&u, &draft).await;
                let mut h = hypothesis("Original", 0.5);
                h.channel = "any".into();
                let mut seed = u.tenant(ws).await.unwrap();
                seed.hypotheses()
                    .replace_all(draft.id, vec![h])
                    .await
                    .unwrap();
                seed.commit().await.unwrap();
                // Ensure the record race can actually approve; edits must instead withdraw it.
                assert!(strategy::get(&deps, &ctx).await.unwrap().gaps.is_empty());

                let mut blocker = u.tenant(ws).await.unwrap();
                blocker.strategy().lock_draft().await.unwrap().unwrap();
                let editor = {
                    let deps = deps.clone();
                    let ctx = ctx.clone();
                    tokio::spawn(async move {
                        match edit {
                            "record" => strategy::record(
                                &deps,
                                &ctx,
                                RecordInput {
                                    kind: RecordKind::Note,
                                    section_key: None,
                                    text: "Concurrent note".into(),
                                },
                            )
                            .await
                            .map(|_| ()),
                            "write_section" => strategy::write_section(
                                &deps,
                                &ctx,
                                "identity".into(),
                                json!({"product": "Edited coffee"}),
                            )
                            .await
                            .map(|_| ()),
                            "set_hypotheses" => strategy::set_hypotheses(
                                &deps,
                                &ctx,
                                json!([{
                                    "title": "Edited hypothesis", "segment_key": "esnaf",
                                    "angle": "time saved", "channel": "any", "metric": "dm",
                                    "prior_confidence": 0.6,
                                }]),
                            )
                            .await
                            .map(|_| ()),
                            _ => unreachable!(),
                        }
                    })
                };
                wait_for_lock_waiters(&db, 1).await;
                let transition = {
                    let deps = deps.clone();
                    let ctx = ctx.clone();
                    let draft_id = draft.id;
                    let previous_id = previous.id;
                    tokio::spawn(async move {
                        if archive {
                            strategy::archive(
                                &deps,
                                &ctx,
                                ArchiveInput {
                                    version_id: previous_id,
                                    confirm: true,
                                },
                            )
                            .await
                        } else {
                            strategy::approve(
                                &deps,
                                &ctx,
                                ApproveInput {
                                    version_id: draft_id,
                                    submitted_at: T0,
                                },
                            )
                            .await
                            .map(|_| ())
                        }
                    })
                };
                wait_for_lock_waiters(&db, 2).await;
                blocker.commit().await.unwrap();
                let (edited, transitioned) =
                    tokio::time::timeout(std::time::Duration::from_secs(5), async {
                        tokio::join!(editor, transition)
                    })
                    .await
                    .unwrap_or_else(|_| {
                        panic!("timeout: iteration {iteration}, archive={archive}, {edit}")
                    });
                edited
                    .unwrap()
                    .unwrap_or_else(|e| panic!("edit {edit}: {e:?}"));
                let transitioned = transitioned.unwrap();
                if !archive && edit != "record" {
                    let err = transitioned.expect_err("editing must withdraw the submission");
                    assert_eq!(err.code, ErrorCode::Conflict);
                    assert_eq!(err.details["reason"], "not_submitted");
                } else {
                    transitioned.unwrap();
                }
                let stored = find(&u, ws, draft.id).await;
                assert_eq!(
                    stored.status,
                    if !archive && edit == "record" {
                        VersionStatus::Approved
                    } else {
                        VersionStatus::Draft
                    }
                );
                assert_eq!(
                    find(&u, ws, previous.id).await.status,
                    if archive || edit == "record" {
                        VersionStatus::Archived
                    } else {
                        VersionStatus::Approved
                    }
                );
                let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
                let count: i64 = sqlx::query_scalar(
                    "select count(*) from ledger_entries where workspace_id = $1 and action = $2",
                )
                .bind(ws.as_uuid())
                .bind(format!("strategy.{edit}"))
                .fetch_one(tx.conn())
                .await
                .unwrap();
                assert_eq!(
                    count, 1,
                    "the edit and its ledger entry must commit together"
                );
                tx.rollback().await.unwrap();
            }
        }
    }
}
