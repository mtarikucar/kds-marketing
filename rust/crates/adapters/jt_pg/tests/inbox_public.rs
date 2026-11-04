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
async fn outbox_counts_agent_public_replies() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::outbox_counts_agent_public_replies(uow(&db)).await;
}

#[tokio::test]
async fn public_replies_in_flight() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::public_replies_in_flight(uow(&db)).await;
}

#[tokio::test]
async fn outbox_row_of_a_message() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::outbox_row_of_a_message(uow(&db)).await;
}

#[tokio::test]
async fn outbox_rebinds_its_generation() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::outbox_rebinds_its_generation(uow(&db)).await;
}

#[tokio::test]
async fn erasure_refuses_held_replies() {
    let db = TestDb::new().await;
    jt_testkit::inbox_contract::erasure_refuses_held_replies(uow(&db)).await;
}

#[tokio::test]
async fn undo_reads_a_version_1_snapshot() {
    let db = TestDb::new().await;
    jt_testkit::inbox_merge_contract::undo_reads_a_version_1_snapshot(uow(&db)).await;
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
    // An empty author id is no id.
    let mut empty = envelope("comment", None, "9001");
    empty["public"]["author"]["id"] = json!("");
    assert!(event_person(&db, &f, page, &empty, anonymous.id).await);
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

// ---------------------------------------------------------------------------------------------
// One reply in flight per item and visibility (spec D19), through the use cases on PostgreSQL
// ---------------------------------------------------------------------------------------------

/// An active workspace with an approved strategy, an Instagram capability whose grant and
/// platform flag enable comments, a scripted Meta surface and one commenter's conversation.
struct Replying {
    f: Fixture,
    deps: jt_app::usecases::Deps,
    owner: jt_app::ctx::Ctx,
    agent: jt_app::ctx::Ctx,
    meta: Arc<jt_testkit::fakes::ScriptedPublic>,
    conversation: Conversation,
}

async fn replying(db: &TestDb) -> Replying {
    let uow = uow(db);
    let f = Fixture::new(uow.clone()).await;
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    let mut apps = jt_testkit::fakes::FakeAppConfig::with_all_apps();
    apps.meta.as_mut().unwrap().comment_scopes = true;
    deps.apps = Arc::new(apps);
    let meta = Arc::new(jt_testkit::fakes::ScriptedPublic::new(
        jt_connector::Provider::Meta,
    ));
    deps.connectors =
        Arc::new(jt_testkit::fakes::ScriptedRegistry::new().with_public(meta.clone()));
    let scopes = [
        "instagram_basic",
        "instagram_manage_comments",
        "instagram_manage_messages",
    ];
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        f.ws,
        NewCapability {
            kind_key: "instagram".into(),
            name: "Instagram".into(),
            external_id: Some("ig-acct".into()),
            connector_public: json!({"provider": "meta",
                "access": {"kind": "oauth", "app": "meta", "scopes": scopes}}),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = jt_capability::StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW);
    let credential = jt_connector::Credential::OAuth {
        access_token: "test-token".into(),
        refresh_token: None,
        expires_at: None,
        scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
    };
    let sealed = deps
        .seal
        .seal(f.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.capabilities()
        .insert(cap.clone(), Some(sealed))
        .await
        .unwrap();
    t.strategy()
        .insert(jt_strategy::StrategyVersion {
            id: jt_strategy::StrategyVersionId::new_v7(),
            workspace_id: f.ws,
            number: 1,
            status: jt_strategy::VersionStatus::Approved,
            sections: jt_strategy::Sections::default(),
            created_at: FIXED_NOW,
            created_by: jt_ledger::Actor::Human { user_id: f.user },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(f.user),
            archived_at: None,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    let p = f.insert_person("Commenter").await;
    let conversation = f.public_conversation(p.id, cap.id).await;
    let ctx = |actor| jt_app::ctx::Ctx {
        workspace_id: f.ws,
        actor,
        permissions: [jt_tenancy::Permission::InboxWork].into(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let owner = ctx(jt_ledger::Actor::Human { user_id: f.user });
    let connection = jt_tenancy::AgentConnectionId::new_v7();
    let mut agent = ctx(jt_ledger::Actor::Agent {
        connection_id: connection,
        user_id: f.user,
    });
    agent.agent_connection_id = Some(connection);
    Replying {
        f,
        deps,
        owner,
        agent,
        meta,
        conversation,
    }
}

/// An owed comment `external_id` of the conversation, stored.
async fn owed(r: &Replying, external_id: &str, minutes: i64) -> PublicItem {
    let message =
        r.f.comment_message(r.conversation.id, external_id, minutes)
            .await;
    let item =
        r.f.public_item(&r.conversation, message, external_id, minutes);
    let mut t = r.f.uow.tenant(r.f.ws).await.unwrap();
    assert!(t.public_items().insert(item.clone()).await.unwrap());
    t.commit().await.unwrap();
    item
}

fn reply_to(item: &PublicItem, text: &str) -> jt_app::usecases::inbox::replies::ReplyInput {
    serde_json::from_value(json!({"text": text, "intent": "reply", "item_id": item.id})).unwrap()
}

fn accepted(
    id: &str,
) -> Result<jt_app::ports::connectors::SendReceipt, jt_connector::ConnectorError> {
    Ok(jt_app::ports::connectors::SendReceipt {
        provider_id: id.into(),
        cost_minor: None,
    })
}

fn reason(e: &jt_app::error::AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn a_timed_out_reply_refuses_the_agent_another() {
    use jt_app::usecases::inbox::replies;
    let db = TestDb::new().await;
    let r = replying(&db).await;
    let item = owed(&r, "1", 0).await;
    r.meta
        .push_reply_public(Err(jt_connector::ConnectorError::unknown("timed out")));
    let first = replies::reply(
        &r.deps,
        &r.agent,
        r.conversation.id,
        reply_to(&item, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(first.state, "unknown");
    // The agent retries: refused, nothing sent again.
    let e = replies::reply(
        &r.deps,
        &r.agent,
        r.conversation.id,
        reply_to(&item, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "reply_in_flight");
    assert_eq!(r.meta.calls().len(), 1);
    // A human, who can look at the platform, may still answer.
    r.meta.push_reply_public(accepted("r1"));
    let human = replies::reply(
        &r.deps,
        &r.owner,
        r.conversation.id,
        reply_to(&item, "Merhaba, yanıtımız ulaştı mı?"),
    )
    .await
    .unwrap();
    assert_eq!(human.state, "sent");
    assert_eq!(r.meta.calls().len(), 2);
}

#[tokio::test]
async fn a_reply_during_another_ones_send_is_refused() {
    use jt_app::usecases::inbox::replies;
    let db = TestDb::new().await;
    let r = replying(&db).await;
    let item = owed(&r, "1", 0).await;
    // Both enqueued before either is sent: the second is refused.
    let replies::Enqueued::New(first) = replies::enqueue(
        &r.deps,
        &r.owner,
        r.conversation.id,
        reply_to(&item, "Merhaba"),
    )
    .await
    .unwrap() else {
        panic!("a new reply")
    };
    let e = replies::reply(
        &r.deps,
        &r.agent,
        r.conversation.id,
        reply_to(&item, "Selam"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "reply_in_flight");
    // While the first one's provider call runs (the row sending, no lock held), another reply,
    // a human's or the agent's, is refused too.
    let refused = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (deps, owner, agent, conversation, during) = (
        r.deps.clone(),
        r.owner.clone(),
        r.agent.clone(),
        r.conversation.id,
        refused.clone(),
    );
    let target = item.clone();
    r.meta.push_hook(move || async move {
        for ctx in [&owner, &agent] {
            let e = replies::reply(&deps, ctx, conversation, reply_to(&target, "Tekrar"))
                .await
                .unwrap_err();
            during.lock().unwrap().push(reason(&e).to_owned());
        }
    });
    r.meta.push_reply_public(accepted("r1"));
    let sent = replies::send_step(&r.deps, &r.owner, first).await.unwrap();
    assert_eq!(sent.state, "sent");
    assert_eq!(
        *refused.lock().unwrap(),
        ["reply_in_flight", "reply_in_flight"]
    );
    assert_eq!(r.meta.calls().len(), 1);
}

#[tokio::test]
async fn two_concurrent_agent_replies_send_once() {
    use jt_app::usecases::inbox::replies;
    let db = TestDb::new().await;
    let r = replying(&db).await;
    let item = owed(&r, "1", 0).await;
    r.meta.push_reply_public(accepted("r1"));
    let (a, b) = tokio::join!(
        replies::reply(
            &r.deps,
            &r.agent,
            r.conversation.id,
            reply_to(&item, "Merhaba")
        ),
        replies::reply(
            &r.deps,
            &r.agent,
            r.conversation.id,
            reply_to(&item, "Merhaba!")
        ),
    );
    let (sent, refused): (Vec<_>, Vec<_>) = [a, b].into_iter().partition(Result::is_ok);
    assert_eq!(sent.len(), 1);
    let e = refused.into_iter().next().unwrap().unwrap_err();
    // In flight when it came, or already answered by the agent.
    assert!(
        matches!(reason(&e), "reply_in_flight" | "agent_already_replied"),
        "{e:?}"
    );
    assert_eq!(r.meta.calls().len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Moderation (task F7): the provider is called with no lock held
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn moderation_holds_no_postgres_lock_during_the_provider_call() {
    use jt_app::usecases::inbox::public;
    let db = TestDb::new().await;
    let r = replying(&db).await;
    let item = owed(&r, "1", 0).await;
    let (uow, ws, id, conversation) = (r.f.uow.clone(), r.f.ws, item.id, r.conversation.id);
    r.meta.push_hook(move || async move {
        tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            let mut t = uow.tenant(ws).await.unwrap();
            t.people().lock_workspace().await.unwrap();
            t.conversations().lock(conversation).await.unwrap().unwrap();
            t.public_items().lock(id).await.unwrap().unwrap();
            t.commit().await.unwrap();
        })
        .await
        .expect("the provider call holds no lock");
    });
    r.meta.push_moderate(Ok(()));
    let out = public::hide(
        &r.deps,
        &r.owner,
        item.id,
        public::HideInput { hidden: true },
    )
    .await
    .unwrap();
    assert_eq!(out.outcome, "applied");
    assert_eq!(out.item.moderation, Moderation::Hidden);
    let mut t = r.f.uow.tenant(ws).await.unwrap();
    assert_eq!(
        t.public_items()
            .get(item.id)
            .await
            .unwrap()
            .unwrap()
            .moderation,
        Moderation::Hidden
    );
}

// ---------------------------------------------------------------------------------------------
// Erasure of comments and questions (task F9)
// ---------------------------------------------------------------------------------------------

/// A comment of an Instagram commenter and a question of a Trendyol buyer, both taken in through
/// the consumer, then the person of each erased: their events keep ids, states and times, and
/// lose the author, the text, the provider's item and its names; the items stay with no personal
/// text; a later comment of the erased commenter is masked before it is stored.
#[tokio::test]
async fn erasure_masks_comment_and_question_events() {
    use jt_app::usecases::inbox::{consumer, erasure};
    use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
    let db = TestDb::new().await;
    let r = replying(&db).await;
    let mut apps = jt_testkit::fakes::FakeAppConfig::with_all_apps();
    apps.meta.as_mut().unwrap().comment_scopes = true;
    let mut deps = r.deps.clone();
    deps.apps = Arc::new(apps);
    let ws = r.f.ws;
    let mut t = r.f.uow.tenant(ws).await.unwrap();
    let ig = t
        .capabilities()
        .find(r.conversation.capability_id)
        .await
        .unwrap()
        .unwrap();
    drop(t);
    let trendyol = account(&r.f, "trendyol", "seller-1").await;
    let envelope = |kind: &str, account: &str, author: &str, id: &str| {
        json!({
            "public": {
                "kind": kind, "account_id": account, "external_id": id,
                "root_external_id": id, "status": "open",
                "author": {"id": author, "name": "ayse.example", "is_self": false},
                "text": "Fiyatı nedir? 0532 000 00 00", "created_at": "2026-10-30T10:00:00Z"
            },
            "provider_item": {"id": id, "username": "ayse.example", "userName": "Ayşe K."}
        })
    };
    let mut events = Vec::new();
    for (cap, provider, kind, payload) in [
        (
            ig.id,
            Provider::Meta,
            EventKind::Comment,
            envelope("comment", "ig-acct", "5150", "c-1"),
        ),
        (
            trendyol,
            Provider::Trendyol,
            EventKind::Question,
            envelope("question", "seller-1", "777", "q-1"),
        ),
    ] {
        let event = InboundEvent {
            id: InboundEventId::new_v7(),
            workspace_id: ws,
            provider,
            capability_id: Some(cap),
            external_id: format!("event:{}", payload["public"]["external_id"]),
            kind,
            payload,
            received_at: FIXED_NOW,
            processed_at: None,
        };
        let mut t = r.f.uow.tenant(ws).await.unwrap();
        t.inbound_events()
            .insert_if_new(event.clone(), Some(b"raw delivery".to_vec()))
            .await
            .unwrap()
            .unwrap();
        t.commit().await.unwrap();
        consumer::consume_event(&deps, &event, FIXED_NOW)
            .await
            .unwrap();
        events.push(event);
    }
    let ctx = jt_app::ctx::Ctx {
        permissions: jt_tenancy::SystemRole::Owner.permissions(),
        ..r.owner.clone()
    };
    let mut t = r.f.uow.tenant(ws).await.unwrap();
    let items: Vec<PublicItem> = {
        let mut items = Vec::new();
        for (cap, id) in [(ig.id, "c-1"), (trendyol, "q-1")] {
            items.push(
                t.public_items()
                    .find_by_external(cap, id)
                    .await
                    .unwrap()
                    .expect("the item was taken in"),
            );
        }
        items
    };
    let mut people = Vec::new();
    for item in &items {
        people.push(
            t.conversations()
                .get(item.conversation_id)
                .await
                .unwrap()
                .unwrap()
                .person_id,
        );
    }
    drop(t);
    for person in &people {
        erasure::erase(&deps, &ctx, *person, erasure::EraseInput { confirm: true })
            .await
            .unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    for event in &events {
        let (p, raw): (Value, Option<Vec<u8>>) = sqlx::query_as(
            "select payload,raw from inbound_events where workspace_id=$1 and id=$2",
        )
        .bind(ws.as_uuid())
        .bind(event.id.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
        assert!(raw.is_none());
        let public = &p["public"];
        assert_eq!(public["author"], json!(""));
        assert_eq!(public["text"], json!(""));
        assert_eq!(p["provider_item"], json!(""));
        assert_eq!(
            public["external_id"],
            event.payload["public"]["external_id"]
        );
        assert_eq!(public["status"], "open");
    }
    tx.commit().await.unwrap();
    // The items keep ids, states and times only; their messages are scrubbed.
    let mut t = r.f.uow.tenant(ws).await.unwrap();
    for item in &items {
        let stored = t.public_items().get(item.id).await.unwrap().unwrap();
        let text = serde_json::to_string(&stored).unwrap();
        for personal in ["Fiyat", "ayse", "Ayşe", "5150", "777", "0532"] {
            assert!(!text.contains(personal), "{personal} in {text}");
        }
        let message = t.messages().get(stored.message_id).await.unwrap().unwrap();
        assert!(!message.body.contains("Fiyat"));
    }
    // A later comment of the erased commenter is masked before it is stored.
    let mut later = envelope("comment", "ig-acct", "5150", "c-2");
    let erased = erasure::scrub_inbound(t.as_mut(), Some(ig.id), &mut later)
        .await
        .unwrap();
    assert!(erased);
    assert_eq!(later["public"]["text"], json!(""));
    assert_eq!(later["erased_identity"], true);
}
