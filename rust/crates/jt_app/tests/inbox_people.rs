mod support;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::inbox::people::{self, CreateInput, IdentityInput};
use jt_inbox::{IdentityChannel, Source};
use support::*;

fn input(phone: &str) -> CreateInput {
    CreateInput {
        display_name: "Ada".into(),
        identities: vec![IdentityInput {
            channel: IdentityChannel::Phone,
            value: phone.into(),
            capability_id: None,
        }],
        source: Source::Form,
    }
}

#[tokio::test]
async fn create_matches_existing_identity() {
    let w = world().await;
    let first = people::create(&w.deps, &w.owner_ctx, input("05321234567"))
        .await
        .unwrap();
    let second = people::create(&w.deps, &w.owner_ctx, input("+905321234567"))
        .await
        .unwrap();
    assert!(first.created);
    assert!(!second.created);
    assert_eq!(first.person.id, second.person.id);
}

#[tokio::test]
async fn first_touch_and_person_created_once() {
    let w = world().await;
    let first = people::create(&w.deps, &w.owner_ctx, input("05321234567"))
        .await
        .unwrap();
    let mut next = input("05321234567");
    next.source = Source::Import;
    let second = people::create(&w.deps, &w.owner_ctx, next).await.unwrap();
    assert_eq!(first.person.first_touch, second.person.first_touch);
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.journeys.len(), 1);
    assert_eq!(
        s.ledger
            .iter()
            .filter(|e| e.entry.action.as_str() == "inbox.person.created")
            .count(),
        1
    );
}

#[tokio::test]
async fn create_identity_split_returns_both_ids_and_suggestion() {
    let w = world().await;
    let a = people::create(&w.deps, &w.owner_ctx, input("05321234567"))
        .await
        .unwrap();
    let mut b = input("05321234568");
    b.identities = vec![IdentityInput {
        channel: IdentityChannel::Email,
        value: "ada@example.com".into(),
        capability_id: None,
    }];
    let b = people::create(&w.deps, &w.owner_ctx, b).await.unwrap();
    let mut split = input("05321234567");
    split.identities.push(IdentityInput {
        channel: IdentityChannel::Email,
        value: "ada@example.com".into(),
        capability_id: None,
    });
    let e = people::create(&w.deps, &w.owner_ctx, split)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "identity_split");
    let ids = e.details["person_ids"].as_array().unwrap();
    assert!(ids.contains(&serde_json::json!(a.person.id)));
    assert!(ids.contains(&serde_json::json!(b.person.id)));
    assert!(e.details["merge_suggestion"].is_object());
    assert_eq!(w.uow.snapshot().inbox.merges.len(), 1);
    assert_eq!(w.uow.snapshot().inbox.people.len(), 2);
}

#[tokio::test]
async fn identity_split_suggests_without_stealing() {
    let w = world().await;
    let a = people::create(&w.deps, &w.owner_ctx, input("05321234567"))
        .await
        .unwrap();
    let b = people::create(&w.deps, &w.owner_ctx, input("05321234568"))
        .await
        .unwrap();
    let result = people::add_identity(
        &w.deps,
        &w.owner_ctx,
        a.person.id,
        input("05321234568").identities.remove(0),
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "merge_suggested");
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(t.identities().list(a.person.id).await.unwrap().len(), 1);
    assert_eq!(t.identities().list(b.person.id).await.unwrap().len(), 1);
}

#[tokio::test]
async fn merged_alias_resolves_keeper() {
    let w = world().await;
    let a = people::create(&w.deps, &w.owner_ctx, input("05321234567"))
        .await
        .unwrap();
    let b = people::create(&w.deps, &w.owner_ctx, input("05321234568"))
        .await
        .unwrap();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.people()
        .mark_merged(a.person.id, Some(b.person.id), w.owner_ctx.now)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let result = people::get(&w.deps, &w.owner_ctx, a.person.id)
        .await
        .unwrap();
    assert_eq!(result.person.id, b.person.id);
}

#[tokio::test]
async fn matching_create_ledgers_each_new_identity_once_without_personal_values() {
    let w = world().await;
    let first = people::create(&w.deps, &w.owner_ctx, input("05321234567"))
        .await
        .unwrap();
    let mut next = input("05321234567");
    next.identities.push(IdentityInput {
        channel: IdentityChannel::Email,
        value: "private@example.com".into(),
        capability_id: None,
    });
    for _ in 0..2 {
        let matched = people::create(&w.deps, &w.owner_ctx, next.clone())
            .await
            .unwrap();
        assert!(!matched.created);
        assert_eq!(matched.person.id, first.person.id);
    }
    let state = w.uow.snapshot();
    assert_eq!(state.inbox.identities.len(), 2);
    assert_eq!(
        state
            .ledger
            .iter()
            .filter(|row| row.entry.action.as_str() == "inbox.person.created")
            .count(),
        1
    );
    let identities: Vec<_> = state
        .ledger
        .iter()
        .filter(|row| row.entry.action.as_str() == "inbox.identity.added")
        .collect();
    assert_eq!(identities.len(), 1);
    assert_eq!(
        identities[0].entry.payload,
        serde_json::json!({"channel":"email"})
    );
    assert_eq!(
        identities[0].entry.subject.as_ref().unwrap().id,
        first.person.id.to_string()
    );
}
