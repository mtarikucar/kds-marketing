//! The in-memory knowledge base keeps the contract `jt_pg` keeps
//! (`jt_testkit::knowledge_contract`), and a second seeding bundle waits for the first.

use std::sync::Arc;

use jt_app::ports::UserRow;
use jt_app::usecases::Deps;
use jt_knowledge::{KnowledgeSettings, SeedSource};
use jt_tenancy::{Email, UserId, WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, deps};

/// Creates a workspace and a user, committed.
async fn workspace(deps: &Deps, slug: &str) -> WorkspaceId {
    let (ws, user) = (WorkspaceId::new_v7(), UserId::new_v7());
    let mut u = deps.uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: user,
            email: Email::parse(&format!("{slug}@example.com")).unwrap(),
            password_hash: "plain:pw".into(),
            display_name: slug.into(),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    u.workspaces_create(ws, slug, slug, WorkspaceStatus::Active, FIXED_NOW)
        .await
        .unwrap();
    u.commit().await.unwrap();
    ws
}

#[tokio::test]
async fn the_in_memory_knowledge_base_keeps_the_repository_contract() {
    let uow = InMemoryUow::new();
    let deps = deps(Arc::new(uow.clone()));
    let a = workspace(&deps, "kb-a").await;
    let b = workspace(&deps, "kb-b").await;
    jt_testkit::knowledge_contract::exercise(&uow, a, b).await;
}

#[tokio::test]
async fn a_second_seeding_bundle_waits_for_the_first_and_seeds_nothing() {
    use jt_app::ports::UnitOfWork;
    let uow = InMemoryUow::new();
    let deps = deps(Arc::new(uow.clone()));
    let ws = workspace(&deps, "kb-seed").await;
    let settings = KnowledgeSettings::new(ws, SeedSource::Empty, FIXED_NOW);
    let mut first = uow.tenant(ws).await.unwrap();
    assert!(first.knowledge().insert_settings(&settings).await.unwrap());
    let second = {
        let (uow, settings) = (uow.clone(), settings.clone());
        tokio::spawn(async move {
            let mut r = uow.tenant(ws).await.unwrap();
            let inserted = r.knowledge().insert_settings(&settings).await.unwrap();
            r.commit().await.unwrap();
            inserted
        })
    };
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(
        !second.is_finished(),
        "the second waits for the first bundle's lock"
    );
    first.commit().await.unwrap();
    assert!(
        !second.await.unwrap(),
        "it reads the settings the first committed, and seeds nothing"
    );
}

#[tokio::test]
async fn settings_of_a_workspace_that_does_not_exist_are_refused() {
    let uow = InMemoryUow::new();
    let ws = WorkspaceId::new_v7();
    let mut r = jt_app::ports::UnitOfWork::tenant(&uow, ws).await.unwrap();
    let e = r
        .knowledge()
        .insert_settings(&KnowledgeSettings::new(ws, SeedSource::Empty, FIXED_NOW))
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::NotFound);
}
