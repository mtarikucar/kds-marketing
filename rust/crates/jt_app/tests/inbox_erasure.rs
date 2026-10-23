mod support;
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::inbox::{erasure, journeys, people},
};
use jt_inbox::*;
use serde_json::json;
use support::*;

async fn setup() -> (World, PersonId) {
    let w = world().await;
    let p = people::create(&w.deps, &w.owner_ctx, serde_json::from_value(json!({"display_name":"Ada", "source":"form", "identities":[{"channel":"email","value":" Ada@Example.com "}]})).unwrap()).await.unwrap().person;
    (w, p.id)
}
#[tokio::test]
async fn erase_requires_confirm_manage() {
    let (w, p) = setup().await;
    let mut ctx = w.owner_ctx.clone();
    ctx.permissions.remove(&jt_tenancy::Permission::InboxManage);
    assert_eq!(
        erasure::erase(&w.deps, &ctx, p, erasure::EraseInput { confirm: true })
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        erasure::erase(
            &w.deps,
            &w.owner_ctx,
            p,
            erasure::EraseInput { confirm: false }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Validation
    );
    assert!(w.uow.snapshot().inbox.erasure_logs.is_empty());
}
#[tokio::test]
async fn erase_keeps_anonymous_ids_amounts_and_tombstone() {
    let (w, p) = setup().await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    journeys::report(&w.deps,&w.owner_ctx,j,serde_json::from_value(json!({"kind":"won","idempotency_key":"sale","payload":{"product":"Ada private plan","amount_minor":15000,"currency":"TRY"}})).unwrap()).await.unwrap();
    let before = w.uow.snapshot();
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.people[0].id, p);
    assert_eq!(after.inbox.people[0].display_name, "silinmiş kişi");
    assert!(after.inbox.people[0].erased_at.is_some());
    assert!(after.inbox.identities.is_empty());
    assert_eq!(after.inbox.erasure_logs.len(), 1);
    assert_eq!(after.inbox.erased_identities.len(), 1);
    assert_eq!(after.inbox.commissions, before.inbox.commissions);
    assert_eq!(after.inbox.events[0].id, before.inbox.events[0].id);
    assert!(
        matches!(&after.inbox.events[0].kind,JourneyEventKind::Won{product,amount_minor:15000,..} if product.is_empty())
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        r.erasure()
            .is_erased_identity(
                IdentityChannel::Email,
                &identity_hash(IdentityChannel::Email, "ada@example.com")
            )
            .await
            .unwrap()
    );
    let err=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada", "source":"form", "identities":[{"channel":"email","value":"ada@example.com"}]})).unwrap()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
}
