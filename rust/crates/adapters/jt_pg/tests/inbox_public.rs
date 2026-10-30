//! Public items on PostgreSQL (migration 0019): the shared repo contracts, the erasure mask of the
//! public-item envelope, the event matching of a commenter, merges, and reconciliation order.

use std::sync::Arc;

use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_inbox::*;
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_testkit::TestDb;
use jt_testkit::fakes::FIXED_NOW;
use jt_testkit::inbox_contract::Fixture;
use serde_json::{Value, json};

fn uow(db: &TestDb) -> Arc<PgUnitOfWork> {
    Arc::new(PgUnitOfWork::new(db.pool.clone()))
}

#[tokio::test]
async fn public_items_contract() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::public_items_contract(uow(&db)).await;
}

#[tokio::test]
async fn public_subjects_contract() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::public_subjects_contract(uow(&db)).await;
}

#[tokio::test]
async fn public_cursors_contract() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::public_cursors_contract(uow(&db)).await;
}

#[tokio::test]
async fn reconcile_order_rotates() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::reconcile_order_rotates(uow(&db)).await;
}

#[tokio::test]
async fn merge_moves_items_and_undo_restores_them() {
    let db = TestDb::new().await;
    jt_testkit::inbox_merge_contract::public_items_follow_merges_and_undo(uow(&db)).await;
}

async fn mask(db: &TestDb, payload: Value) -> Value {
    sqlx::query_scalar("select inbox_mask_personal($1)")
        .bind(payload)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn mask_personal_blanks_the_envelope() {
    let db = TestDb::new().await;
    // Made-up ids, handle and text.
    let envelope = json!({
        "public": {
            "kind": "comment", "account_id": "ig-acct", "external_id": "1789",
            "parent_external_id": null, "root_external_id": "1789", "status": "open",
            "author": {"id": "5150", "name": "ayse.example", "is_self": false},
            "text": "Fiyatı nedir?", "created_at": "2026-10-30T10:00:00Z", "deadline": null,
            "live": false,
            "subject": {"kind": "post", "external_id": "m1", "title": "Yeni sezon",
                        "url": "https://example.com/p/1", "image_url": null, "facts": {}},
            "answer": {"text": "Merhaba", "at": "2026-10-30T11:00:00Z"}
        },
        "provider_item": {"id": "1789", "text": "Fiyatı nedir?", "username": "ayse.example"}
    });
    let masked = mask(&db, envelope).await;
    let public = &masked["public"];
    assert_eq!(public["author"], json!(""));
    assert_eq!(public["text"], json!(""));
    assert_eq!(masked["provider_item"], json!(""));
    assert_eq!(public["answer"]["text"], json!(""));
    // `subject` was a masked key already (a mail's subject): the post or product goes whole.
    assert_eq!(public["subject"], json!(""));
    // Ids, states and times stay.
    for key in [
        "kind",
        "account_id",
        "external_id",
        "root_external_id",
        "status",
        "created_at",
    ] {
        assert_ne!(public[key], json!(""), "{key}");
    }
    assert_eq!(public["answer"]["at"], json!("2026-10-30T11:00:00Z"));

    // Names under every spelling the providers use, and Facebook's string comment text.
    let names = mask(
        &db,
        json!({
            "username": "ayse.example", "userName": "Ayşe Y.", "customerName": "Ayşe Y.",
            "message": "Merhaba", "item": {"message": "Merhaba", "id": "c1"}
        }),
    )
    .await;
    assert_eq!(
        names,
        json!({
            "username": "", "userName": "", "customerName": "", "message": "",
            "item": {"message": "", "id": "c1"}
        })
    );
    // WhatsApp's message object keeps its id and loses its body, as before.
    let whatsapp = mask(
        &db,
        json!({"message": {"id": "wamid.1", "from": "905321234567", "text": {"body": "hi"}}}),
    )
    .await;
    assert_eq!(
        whatsapp,
        json!({"message": {"id": "wamid.1", "from": "", "text": ""}})
    );
}

/// A capability of `kind_key` on the made-up account `external_id`.
async fn account(f: &Fixture, kind_key: &str, external_id: &str) -> CapabilityId {
    let c = Capability::new(
        CapabilityId::new_v7(),
        f.ws,
        NewCapability {
            kind_key: kind_key.into(),
            name: kind_key.into(),
            external_id: Some(external_id.into()),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
    c.id
}

async fn identity(f: &Fixture, person: PersonId, channel: IdentityChannel, value: &str) {
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.identities()
        .insert(Identity {
            id: IdentityId::new_v7(),
            workspace_id: f.ws,
            person_id: person,
            channel,
            value_normalized: value.into(),
            value_display: value.into(),
            active: true,
            first_seen_at: FIXED_NOW,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
}

async fn event_person(
    db: &TestDb,
    f: &Fixture,
    cap: CapabilityId,
    p: &Value,
    person: PersonId,
) -> bool {
    let mut tx = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    // No match is SQL `null` (`null or false`), which its `where` callers read as false.
    let found: bool = sqlx::query_scalar("select coalesce(inbox_event_person($1,$2,$3,$4), false)")
        .bind(f.ws.as_uuid())
        .bind(cap.as_uuid())
        .bind(p)
        .bind(person.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    found
}

fn envelope(kind: &str, author: Option<&str>, external_id: &str) -> Value {
    json!({
        "public": {
            "kind": kind, "account_id": "acct", "external_id": external_id,
            "root_external_id": external_id, "status": "open",
            "author": {"id": author, "name": "someone", "is_self": false},
            "text": "?", "created_at": "2026-10-30T10:00:00Z"
        },
        "provider_item": {}
    })
}

#[tokio::test]
async fn event_person_finds_a_commenter() {
    let db = TestDb::new().await;
    let f = Fixture::new(uow(&db)).await;
    let instagram = account(&f, "instagram", "ig-acct").await;
    let instagram_dm = account(&f, "instagram_dm", "ig-acct").await;
    let page = account(&f, "facebook_page", "page-acct").await;
    let trendyol = account(&f, "trendyol", "seller-1").await;
    let commenter = f.insert_person("Commenter").await;
    let other = f.insert_person("Other").await;
    let anonymous = f.insert_person("Anonymous").await;
    let buyer = f.insert_person("Buyer").await;
    identity(
        &f,
        commenter.id,
        IdentityChannel::InstagramCommenter,
        "ig-acct:5150",
    )
    .await;
    identity(&f, other.id, IdentityChannel::InstagramDm, "ig-acct:5150").await;
    identity(
        &f,
        anonymous.id,
        IdentityChannel::FacebookCommenter,
        "page-acct:c:9001",
    )
    .await;
    identity(&f, buyer.id, IdentityChannel::TrendyolBuyer, "seller-1:777").await;

    let comment = envelope("comment", Some("5150"), "1789");
    // The commenter, scoped by the capability's account, on the surface or its DM sibling.
    assert!(event_person(&db, &f, instagram, &comment, commenter.id).await);
    assert!(event_person(&db, &f, instagram_dm, &comment, commenter.id).await);
    // A DM identity with the same raw id is another namespace.
    assert!(!event_person(&db, &f, instagram, &comment, other.id).await);
    // Another author, or another account, is not them.
    let stranger = envelope("comment", Some("6160"), "1790");
    assert!(!event_person(&db, &f, instagram, &stranger, commenter.id).await);
    assert!(!event_person(&db, &f, page, &comment, commenter.id).await);
    // An author without an id is the one-off person intake made for the comment.
    let unnamed = envelope("comment", None, "9001");
    assert!(event_person(&db, &f, page, &unnamed, anonymous.id).await);
    assert!(
        !event_person(
            &db,
            &f,
            page,
            &envelope("comment", None, "9002"),
            anonymous.id
        )
        .await
    );
    // A marketplace buyer in the seller's namespace.
    let question = envelope("question", Some("777"), "q-1");
    assert!(event_person(&db, &f, trendyol, &question, buyer.id).await);
    assert!(!event_person(&db, &f, instagram, &question, buyer.id).await);
    // A payload without an envelope matches as before.
    assert!(!event_person(&db, &f, instagram, &json!({"text": "5150"}), commenter.id).await);
}
