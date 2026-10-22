//! The in-memory strategy repos keep the contracts `jt_pg` keeps: one draft and one approved
//! version per workspace (`CONFLICT`), forward-only status moves, sections changed only on a
//! draft, versions of the bundle's own workspace only, and a newest-first consultation log.

use std::sync::Arc;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UserRow;
use jt_app::usecases::Deps;
use jt_ledger::Actor;
use jt_strategy::{
    ConsultationEntry, ConsultationKind, Hypothesis, HypothesisId, HypothesisState, Identity,
    Sections, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::{Email, UserId, WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, deps};
use time::{Duration, OffsetDateTime};

/// The code of a result that must be an error.
fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

/// An in-memory store with the fakes' dependencies over it, as use-case tests build it.
fn setup() -> (InMemoryUow, Deps) {
    let uow = InMemoryUow::new();
    let deps = deps(Arc::new(uow.clone()));
    (uow, deps)
}

/// Creates a workspace and a user, committed.
async fn workspace(deps: &Deps, slug: &str) -> (WorkspaceId, UserId) {
    let (ws, user) = (WorkspaceId::new_v7(), UserId::new_v7());
    let now = deps.clock.now();
    let mut u = deps.uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: user,
            email: Email::parse(&format!("{slug}@example.com")).unwrap(),
            password_hash: "plain:pw".into(),
            display_name: slug.into(),
            created_at: now,
        })
        .await
        .unwrap();
    u.workspaces_create(ws, slug, slug, WorkspaceStatus::Active, now)
        .await
        .unwrap();
    u.commit().await.unwrap();
    (ws, user)
}

fn version(ws: WorkspaceId, number: i32, status: VersionStatus, user: UserId) -> StrategyVersion {
    StrategyVersion {
        id: StrategyVersionId::new_v7(),
        workspace_id: ws,
        number,
        status,
        sections: Sections::default(),
        created_at: FIXED_NOW,
        created_by: Actor::Human { user_id: user },
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
            ..Identity::default()
        },
        ..Sections::default()
    }
}

fn hypothesis(title: &str, confidence: f32) -> Hypothesis {
    Hypothesis {
        id: HypothesisId::new_v7(),
        title: title.into(),
        segment_key: "esnaf".into(),
        angle: "zaman".into(),
        channel: "any".into(),
        metric: "replies".into(),
        confidence,
        state: HypothesisState::Kept,
    }
}

fn note(version: StrategyVersionId, user: UserId, at: OffsetDateTime) -> ConsultationEntry {
    ConsultationEntry::new(
        version,
        ConsultationKind::Note,
        None,
        "not".into(),
        Actor::Human { user_id: user },
        at,
    )
    .unwrap()
}

async fn insert(deps: &Deps, v: &StrategyVersion) {
    let mut t = deps.uow.tenant(v.workspace_id).await.unwrap();
    t.strategy().insert(v.clone()).await.unwrap();
    t.commit().await.unwrap();
}

#[tokio::test]
async fn a_second_approved_version_is_conflict() {
    let (_, deps) = setup();
    let (ws, user) = workspace(&deps, "a").await;
    let (other, _) = workspace(&deps, "b").await;
    let approved = version(ws, 1, VersionStatus::Approved, user);
    insert(&deps, &approved).await;

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .strategy()
        .insert(version(ws, 2, VersionStatus::Approved, user))
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    // The failed call spoils the bundle, as an aborted transaction would.
    assert_eq!(code(t.commit().await), ErrorCode::Internal);

    // Approving a draft while another version is approved is CONFLICT too.
    let draft = version(ws, 2, VersionStatus::Draft, user);
    insert(&deps, &draft).await;
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .strategy()
        .set_status(draft.id, VersionStatus::Approved, FIXED_NOW, Some(user))
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);

    // Archiving the approved one first lets it through.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let s = t.strategy();
    assert_eq!(
        s.set_status(approved.id, VersionStatus::Archived, FIXED_NOW, None)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Approved, FIXED_NOW, Some(user))
            .await
            .unwrap(),
        1
    );
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let current = t.strategy().current_approved().await.unwrap().unwrap();
    assert_eq!(current.id, draft.id);
    assert_eq!(current.approved_by, Some(user));
    assert_eq!(current.approved_at, Some(FIXED_NOW));

    // Another workspace has its own.
    insert(&deps, &version(other, 1, VersionStatus::Approved, user)).await;
}

#[tokio::test]
async fn a_second_draft_is_conflict() {
    let (_, deps) = setup();
    let (ws, user) = workspace(&deps, "a").await;
    insert(&deps, &version(ws, 1, VersionStatus::Draft, user)).await;

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .strategy()
        .insert(version(ws, 2, VersionStatus::Draft, user))
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);

    // A taken number is CONFLICT as well.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .strategy()
        .insert(version(ws, 1, VersionStatus::Archived, user))
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);

    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(t.strategy().next_number().await.unwrap(), 2);
}

#[tokio::test]
async fn set_status_moves_only_forward_and_counts_rows() {
    let (_, deps) = setup();
    let (ws, user) = workspace(&deps, "a").await;
    let draft = version(ws, 1, VersionStatus::Draft, user);
    insert(&deps, &draft).await;

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let s = t.strategy();
    let at = FIXED_NOW + Duration::hours(1);
    assert_eq!(
        s.set_status(
            StrategyVersionId::new_v7(),
            VersionStatus::Archived,
            at,
            None
        )
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Approved, at, Some(user))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Approved, at, Some(user))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Archived, at, None)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.set_status(draft.id, VersionStatus::Archived, at, None)
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let stored = t.strategy().find(draft.id).await.unwrap().unwrap();
    assert_eq!(stored.status, VersionStatus::Archived);
    assert_eq!(stored.approved_at, Some(at));
    assert_eq!(stored.archived_at, Some(at));
    // A version never returns to draft.
    let r = t
        .strategy()
        .set_status(draft.id, VersionStatus::Draft, at, None)
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
    drop(t);

    // An approver who is no user is NOT_FOUND.
    let other = version(ws, 2, VersionStatus::Draft, user);
    insert(&deps, &other).await;
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .strategy()
        .set_status(
            other.id,
            VersionStatus::Approved,
            at,
            Some(UserId::new_v7()),
        )
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
}

#[tokio::test]
async fn sections_and_submission_change_only_on_a_draft() {
    let (_, deps) = setup();
    let (ws, user) = workspace(&deps, "a").await;
    let draft = version(ws, 1, VersionStatus::Draft, user);
    insert(&deps, &draft).await;

    let mut t = deps.uow.tenant(ws).await.unwrap();
    t.strategy()
        .update_sections(draft.id, sections("Kahve"), FIXED_NOW)
        .await
        .unwrap();
    t.strategy()
        .set_submitted(draft.id, Some(FIXED_NOW))
        .await
        .unwrap();
    // Buffered: another bundle does not see it before commit.
    let mut other = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        other.strategy().find(draft.id).await.unwrap(),
        Some(draft.clone())
    );
    drop(other);
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let stored = t.strategy().find(draft.id).await.unwrap().unwrap();
    assert_eq!(stored.sections, sections("Kahve"));
    assert_eq!(stored.submitted_at, Some(FIXED_NOW));
    let r = t
        .strategy()
        .update_sections(StrategyVersionId::new_v7(), sections("x"), FIXED_NOW)
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);

    let mut t = deps.uow.tenant(ws).await.unwrap();
    t.strategy()
        .set_status(draft.id, VersionStatus::Approved, FIXED_NOW, Some(user))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .strategy()
        .update_sections(draft.id, sections("Çay"), FIXED_NOW)
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t.strategy().set_submitted(draft.id, None).await;
    assert_eq!(code(r), ErrorCode::Conflict);
}

#[tokio::test]
async fn versions_list_newest_first_within_the_workspace() {
    let (_, deps) = setup();
    let (ws, user) = workspace(&deps, "a").await;
    let (other, _) = workspace(&deps, "b").await;
    let v1 = version(ws, 1, VersionStatus::Archived, user);
    let v2 = version(ws, 2, VersionStatus::Approved, user);
    let theirs = version(other, 1, VersionStatus::Draft, user);
    for v in [&v1, &v2, &theirs] {
        insert(&deps, v).await;
    }

    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(t.strategy().list().await.unwrap(), vec![v2.clone(), v1]);
    assert_eq!(t.strategy().find(theirs.id).await.unwrap(), None);
    assert_eq!(t.strategy().current_draft().await.unwrap(), None);
    assert_eq!(t.strategy().next_number().await.unwrap(), 3);
    let r = t
        .strategy()
        .insert(version(other, 2, VersionStatus::Archived, user))
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
}

#[tokio::test]
async fn hypotheses_need_a_version_of_the_workspace() {
    let (_, deps) = setup();
    let (ws, user) = workspace(&deps, "a").await;
    let (other, _) = workspace(&deps, "b").await;
    let v1 = version(ws, 1, VersionStatus::Draft, user);
    let theirs = version(other, 1, VersionStatus::Draft, user);
    insert(&deps, &v1).await;
    insert(&deps, &theirs).await;
    let (h1, h2, h3) = (
        hypothesis("one", 0.25),
        hypothesis("two", 0.5),
        hypothesis("three", 0.75),
    );

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let h = t.hypotheses();
    h.replace_all(v1.id, vec![h1.clone(), h2.clone()])
        .await
        .unwrap();
    h.replace_all(v1.id, vec![h2.clone(), h3.clone()])
        .await
        .unwrap();
    h.set_state(v1.id, h2.id, HypothesisState::Retired)
        .await
        .unwrap();
    h.upsert(v1.id, h1.clone()).await.unwrap();
    let h3_edited = Hypothesis {
        title: "three, edited".into(),
        ..h3.clone()
    };
    h.upsert(v1.id, h3_edited.clone()).await.unwrap();
    let retired = Hypothesis {
        state: HypothesisState::Retired,
        ..h2.clone()
    };
    assert_eq!(
        h.list(v1.id).await.unwrap(),
        vec![retired, h3_edited, h1.clone()]
    );
    t.commit().await.unwrap();

    for r in [
        {
            let mut t = deps.uow.tenant(ws).await.unwrap();
            t.hypotheses().replace_all(theirs.id, vec![]).await
        },
        {
            let mut t = deps.uow.tenant(ws).await.unwrap();
            t.hypotheses().upsert(theirs.id, h1.clone()).await
        },
        {
            let mut t = deps.uow.tenant(ws).await.unwrap();
            t.hypotheses()
                .set_state(v1.id, HypothesisId::new_v7(), HypothesisState::Kept)
                .await
        },
    ] {
        assert_eq!(code(r), ErrorCode::NotFound);
    }
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .hypotheses()
        .replace_all(v1.id, vec![h1.clone(), h1.clone()])
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .hypotheses()
        .upsert(v1.id, hypothesis("unsure", f32::NAN))
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
    drop(t);
    let mut t = deps.uow.tenant(other).await.unwrap();
    assert_eq!(t.hypotheses().list(v1.id).await.unwrap(), vec![]);
}

#[tokio::test]
async fn consultation_lists_newest_first_with_limit_and_before() {
    let (_, deps) = setup();
    let (ws, user) = workspace(&deps, "a").await;
    let (other, _) = workspace(&deps, "b").await;
    let v1 = version(ws, 1, VersionStatus::Draft, user);
    insert(&deps, &v1).await;
    let entries: Vec<ConsultationEntry> = (0..3)
        .map(|i| note(v1.id, user, FIXED_NOW + Duration::minutes(i)))
        .collect();

    let mut t = deps.uow.tenant(ws).await.unwrap();
    for e in &entries {
        assert_eq!(t.consultation().append(e.clone()).await.unwrap(), e.id);
    }
    t.commit().await.unwrap();

    let newest_first: Vec<ConsultationEntry> = entries.iter().rev().cloned().collect();
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let c = t.consultation();
    assert_eq!(c.list(v1.id, 10, None).await.unwrap(), newest_first);
    assert_eq!(c.list(v1.id, 2, None).await.unwrap(), newest_first[..2]);
    assert_eq!(c.list(v1.id, 0, None).await.unwrap(), newest_first[..1]);
    assert_eq!(
        c.list(v1.id, 10, Some(entries[1].at)).await.unwrap(),
        entries[..1]
    );
    assert_eq!(
        code(c.append(entries[0].clone()).await),
        ErrorCode::Conflict
    );
    drop(t);

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .consultation()
        .append(note(StrategyVersionId::new_v7(), user, FIXED_NOW))
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);
    let mut t = deps.uow.tenant(other).await.unwrap();
    assert_eq!(
        t.consultation().list(v1.id, 10, None).await.unwrap(),
        vec![]
    );
}

#[tokio::test]
async fn deps_builder_wires_the_fakes() {
    let (_, deps) = setup();
    assert_eq!(deps.clock.now(), FIXED_NOW);
    assert_eq!(deps.ids.uuid(), uuid::Uuid::from_u128(1));
    let tokens: Vec<String> = (0..100).map(|_| deps.tokens.token(32)).collect();
    let distinct: std::collections::BTreeSet<&String> = tokens.iter().collect();
    assert_eq!(distinct.len(), tokens.len());
    assert!(deps.hasher.verify("pw", "plain:pw").await.unwrap());
    let (ws, _) = workspace(&deps, "a").await;
    let sealed = deps.seal.seal(ws, b"secret").unwrap();
    assert_eq!(deps.seal.open(ws, &sealed).unwrap().as_slice(), b"secret");
}
