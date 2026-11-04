//! Intake of public items (plan 2026-10-30-inbox-comments-marketplace-plan.md, task F5): the
//! webhook gate and the consumer turn a comment or question envelope into person, conversation,
//! message, item and subject, and a provider's new state of a known item into that item.
//! Envelopes are built here; the adapters' parsing is tasks M1, T2 and H1.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{
    EnvelopeAnswer, EnvelopeAuthor, EnvelopeRejection, EnvelopeStatus, EnvelopeSubject,
    InboundEventDraft, PublicEnvelope, SubjectFacts,
};
use jt_app::ports::inbox::OutboxRow;
use jt_app::usecases::inbox::{consumer, merge, people};
use jt_app::usecases::webhook::{self, AccountEvent, AccountRoute, Delivery};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig, PublicCall, ScriptedPublic, ScriptedRegistry};
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};

/// The Instagram account (Facebook Login).
const IG: &str = "17841400000000001";
/// The Facebook Page.
const PAGE: &str = "100000000000001";
/// The Trendyol seller.
const SELLER: &str = "123456";
/// A commenter's Instagram-scoped id.
const FAN: &str = "17841400000000009";
/// The post the comments are on.
const POST: &str = "17900000000000001";

/// An Instagram grant through Facebook Login with the comment scopes.
const IG_COMMENTS: &[&str] = &[
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_manage_messages",
    "pages_show_list",
];
/// A Page token's grant with the comment scopes.
const PAGE_COMMENTS: &[&str] = &[
    "pages_read_engagement",
    "pages_manage_engagement",
    "pages_messaging",
];

struct Rig {
    w: World,
    surface: Arc<ScriptedPublic>,
    tick: AtomicI64,
}

/// An active workspace whose platform has both comment flags on and a scripted Meta public
/// surface.
async fn rig() -> Rig {
    rig_with(true, true).await
}

async fn rig_with(meta_flag: bool, instagram_flag: bool) -> Rig {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let mut apps = FakeAppConfig::with_all_apps();
    apps.meta.as_mut().unwrap().comment_scopes = meta_flag;
    apps.instagram.as_mut().unwrap().comment_scopes = instagram_flag;
    w.deps.apps = Arc::new(apps);
    let surface = Arc::new(ScriptedPublic::new(Provider::Meta));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_public(surface.clone()));
    Rig {
        w,
        surface,
        tick: AtomicI64::new(0),
    }
}

/// `connector_public` of a `kind` capability whose grant is `scopes` through `app`.
fn public_facts(kind: &str, app: &str, scopes: &[&str]) -> Value {
    match kind {
        "trendyol" => {
            json!({"provider": "trendyol", "access": {"kind": "trendyol_seller", "seller_id": SELLER}})
        }
        _ => json!({"provider": "meta", "access": {"kind": "oauth", "app": app, "scopes": scopes}}),
    }
}

/// A connected (sealed, verified) capability of `kind` holding `account`.
async fn capability(w: &World, kind: &str, account: &str, scopes: &[&str]) -> Capability {
    capability_via(w, kind, account, "meta", scopes).await
}

async fn capability_via(
    w: &World,
    kind: &str,
    account: &str,
    app: &str,
    scopes: &[&str],
) -> Capability {
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} {account}"),
            external_id: Some(account.into()),
            connector_public: public_facts(kind, app, scopes),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW);
    let credential = match kind {
        "trendyol" => Credential::TrendyolSeller {
            seller_id: SELLER.into(),
            api_key: "ty-key".into(),
            api_secret: "ty-secret".into(),
        },
        _ => Credential::OAuth {
            access_token: "EAAB-test-token".into(),
            refresh_token: None,
            expires_at: None,
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        },
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities()
        .insert(cap.clone(), Some(sealed))
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().find(cap.id).await.unwrap().unwrap()
}

fn post() -> EnvelopeSubject {
    EnvelopeSubject {
        kind: SubjectKind::Post,
        external_id: POST.into(),
        title: "Yeni sezon".into(),
        url: Some("https://www.instagram.example/p/abc/".into()),
        image_url: None,
        facts: json!({"media_product_type": "FEED"}),
    }
}

/// A top-level comment `id` on [`POST`] of account `account` by `author`.
fn comment_on(account: &str, id: &str, author: Option<&str>) -> PublicEnvelope {
    PublicEnvelope {
        kind: PublicKind::Comment,
        account_id: account.into(),
        external_id: id.into(),
        parent_external_id: None,
        root_external_id: id.into(),
        status: EnvelopeStatus::Open,
        author: EnvelopeAuthor {
            id: author.map(Into::into),
            name: Some("a.customer".into()),
            is_self: false,
        },
        text: "Fiyatı nedir?".into(),
        created_at: FIXED_NOW - Duration::minutes(10),
        deadline: None,
        live: false,
        subject: Some(post()),
        answer: None,
        rejection: None,
    }
}

fn comment(id: &str, author: Option<&str>) -> PublicEnvelope {
    comment_on(IG, id, author)
}

/// Our own comment `id` answering `parent` with `text`.
fn own_reply(id: &str, parent: &str, text: &str) -> PublicEnvelope {
    PublicEnvelope {
        parent_external_id: Some(parent.into()),
        root_external_id: parent.into(),
        author: EnvelopeAuthor {
            id: Some(IG.into()),
            name: None,
            is_self: true,
        },
        text: text.into(),
        ..comment(id, None)
    }
}

/// Customer question `id` to [`SELLER`] by `customer`.
fn question(id: &str, customer: Option<&str>) -> PublicEnvelope {
    PublicEnvelope {
        kind: PublicKind::Question,
        account_id: SELLER.into(),
        external_id: id.into(),
        parent_external_id: None,
        root_external_id: id.into(),
        status: EnvelopeStatus::Open,
        author: EnvelopeAuthor {
            id: customer.map(Into::into),
            name: None,
            is_self: false,
        },
        text: "Bu ürünün S bedeni var mı?".into(),
        created_at: FIXED_NOW - Duration::minutes(30),
        deadline: None,
        live: false,
        subject: Some(EnvelopeSubject {
            kind: SubjectKind::Product,
            external_id: "PRD-1".into(),
            title: "Boyama seti".into(),
            url: None,
            image_url: None,
            facts: json!({"barcode": "8690000000001"}),
        }),
        answer: None,
        rejection: None,
    }
}

fn with_status(mut env: PublicEnvelope, status: EnvelopeStatus) -> PublicEnvelope {
    env.status = status;
    env
}

fn provider_of(cap: &Capability) -> Provider {
    match cap.kind_key.as_str() {
        "trendyol" => Provider::Trendyol,
        "hepsiburada" => Provider::Hepsiburada,
        _ => Provider::Meta,
    }
}

fn kind_of(env: &PublicEnvelope) -> EventKind {
    match env.kind {
        PublicKind::Comment => EventKind::Comment,
        PublicKind::Question => EventKind::Question,
    }
}

/// Stores `env` as inbound event `external_id` of `cap` and consumes it; the outcome.
async fn deliver(r: &Rig, cap: &Capability, external_id: &str, env: PublicEnvelope) -> String {
    let kind = kind_of(&env);
    let payload = env.into_payload(json!({"id": external_id, "userName": "Ayşe Kaya"}));
    deliver_raw(r, cap, external_id, kind, payload).await
}

async fn deliver_raw(
    r: &Rig,
    cap: &Capability,
    external_id: &str,
    kind: EventKind,
    payload: Value,
) -> String {
    let tick = r.tick.fetch_add(1, Ordering::Relaxed);
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: r.w.ws,
        provider: provider_of(cap),
        capability_id: Some(cap.id),
        external_id: external_id.into(),
        kind,
        payload,
        received_at: FIXED_NOW + Duration::seconds(tick),
        processed_at: None,
    };
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    t.inbound_events()
        .insert_if_new(event.clone(), None)
        .await
        .unwrap()
        .expect("a new inbound event");
    t.commit().await.unwrap();
    consumer::consume_event(&r.w.deps, &event, now(tick))
        .await
        .unwrap()
        .to_owned()
}

fn now(tick: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(1) + Duration::seconds(tick)
}

fn item(s: &jt_testkit::fakes::MemState, external_id: &str) -> PublicItem {
    s.inbox
        .public_items
        .iter()
        .find(|i| i.external_id == external_id)
        .cloned()
        .unwrap_or_else(|| panic!("no item {external_id}"))
}

fn conversation(s: &jt_testkit::fakes::MemState, id: ConversationId) -> Conversation {
    s.inbox
        .conversations
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .unwrap()
}

// ---------------------------------------------------------------------------------------------
// New items
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn ig_comment_creates_person_conversation_message_item_and_subject_without_a_journey() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    let c1 = comment("18000000000000001", Some(FAN));
    let created_at = c1.created_at;
    assert_eq!(
        deliver(&r, &ig, "comment:18000000000000001", c1).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let inbox = &s.inbox;
    assert_eq!(inbox.people.len(), 1);
    let person = &inbox.people[0];
    assert_eq!(person.display_name, "a.customer");
    assert_eq!(
        person.first_touch.source,
        Source::Channel(Channel::InstagramComment)
    );
    assert_eq!(inbox.identities.len(), 1);
    let identity = &inbox.identities[0];
    assert_eq!(identity.channel, IdentityChannel::InstagramCommenter);
    assert_eq!(identity.value_normalized, format!("{IG}:{FAN}"));
    assert_eq!(inbox.conversations.len(), 1);
    let conv = &inbox.conversations[0];
    assert_eq!(
        (conv.person_id, conv.capability_id, conv.kind_key.as_str()),
        (person.id, ig.id, "instagram")
    );
    assert_eq!(conv.state, ConvState::Ours);
    assert_eq!(inbox.messages.len(), 1);
    let message = &inbox.messages[0];
    assert_eq!(
        (message.direction, &message.author, message.body.as_str()),
        (Direction::Inbound, &Author::Customer, "Fiyatı nedir?")
    );
    assert_eq!(message.external_id.as_deref(), Some("18000000000000001"));
    assert_eq!(message.status, MsgStatus::Received);
    assert_eq!(inbox.message_senders.get(&message.id), Some(&identity.id));
    let item = item(&s, "18000000000000001");
    assert_eq!(item.conversation_id, conv.id);
    assert_eq!(item.message_id, message.id);
    assert_eq!(item.kind, PublicKind::Comment);
    assert_eq!(item.root_external_id, "18000000000000001");
    assert_eq!(item.answer, AnswerState::Awaiting);
    assert_eq!(item.moderation, Moderation::Visible);
    assert_eq!(item.created_at, created_at);
    assert_eq!(
        item.private_reply_until,
        Some(created_at + Duration::days(7))
    );
    assert!(!item.live);
    assert_eq!(item.agent_answers, 0);
    assert_eq!(inbox.public_subjects.len(), 1);
    let subject = &inbox.public_subjects[0];
    assert_eq!(item.subject_id, Some(subject.id));
    assert_eq!(
        (
            subject.kind,
            subject.external_id.as_str(),
            subject.title.as_str()
        ),
        (SubjectKind::Post, POST, "Yeni sezon")
    );
    assert_eq!(
        subject.url.as_deref(),
        Some("https://www.instagram.example/p/abc/")
    );
    assert_eq!(subject.facts["media_product_type"], "FEED");
    // No journey, and no ledger line for an item (inbound events record the outside world).
    assert!(inbox.journeys.is_empty() && inbox.events.is_empty());
    assert!(r.w.ledger("inbox.public").is_empty());
}

#[tokio::test]
async fn commenter_identity_is_scoped_to_the_account() {
    let r = rig().await;
    let first = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    let other = capability(&r.w, "instagram", "17841400000000002", IG_COMMENTS).await;
    assert_eq!(
        deliver(&r, &first, "comment:1", comment("1", Some(FAN))).await,
        "consumed"
    );
    assert_eq!(
        deliver(
            &r,
            &other,
            "comment:2",
            comment_on("17841400000000002", "2", Some(FAN))
        )
        .await,
        "consumed"
    );
    let s = r.w.uow.snapshot().inbox;
    // The same id on two accounts is two people: an app-scoped id means nothing elsewhere.
    assert_eq!(s.people.len(), 2);
    let mut values: Vec<_> = s
        .identities
        .iter()
        .map(|i| (i.channel, i.value_normalized.clone()))
        .collect();
    values.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(
        values,
        [
            (IdentityChannel::InstagramCommenter, format!("{IG}:{FAN}")),
            (
                IdentityChannel::InstagramCommenter,
                format!("17841400000000002:{FAN}")
            ),
        ]
    );
}

#[tokio::test]
async fn second_comment_same_person_same_conversation_two_items() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    assert_eq!(
        deliver(&r, &ig, "comment:2", comment("2", Some(FAN))).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    assert_eq!(s.inbox.people.len(), 1);
    assert_eq!(s.inbox.conversations.len(), 1);
    assert_eq!(s.inbox.messages.len(), 2);
    assert_eq!(s.inbox.public_items.len(), 2);
    let conv = s.inbox.conversations[0].id;
    assert!(
        s.inbox
            .public_items
            .iter()
            .all(|i| i.conversation_id == conv)
    );
    // One subject for the post both are on.
    assert_eq!(s.inbox.public_subjects.len(), 1);
}

#[tokio::test]
async fn replayed_comment_is_a_duplicate() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    let before = r.w.uow.snapshot().inbox;
    // The same comment again under another event id (a poll after the webhook).
    assert_eq!(
        deliver(&r, &ig, "poll:comment:1", comment("1", Some(FAN))).await,
        "duplicate"
    );
    let after = r.w.uow.snapshot().inbox;
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.public_items, before.public_items);
    assert_eq!(after.people, before.people);
}

#[tokio::test]
async fn facebook_comment_without_author_is_a_one_off_person() {
    let r = rig().await;
    let page = capability(&r.w, "facebook_page", PAGE, PAGE_COMMENTS).await;
    for id in ["100_1", "100_2"] {
        assert_eq!(
            deliver(
                &r,
                &page,
                &format!("comment:{id}"),
                comment_on(PAGE, id, None)
            )
            .await,
            "consumed"
        );
    }
    let s = r.w.uow.snapshot().inbox;
    // Facebook names no author without the page's user-content permission: each comment is a
    // person of its own.
    assert_eq!(s.people.len(), 2);
    let mut values: Vec<_> = s
        .identities
        .iter()
        .map(|i| (i.channel, i.value_normalized.clone()))
        .collect();
    values.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(
        values,
        [
            (
                IdentityChannel::FacebookCommenter,
                format!("{PAGE}:c:100_1")
            ),
            (
                IdentityChannel::FacebookCommenter,
                format!("{PAGE}:c:100_2")
            ),
        ]
    );
}

#[tokio::test]
async fn comment_event_on_messenger_capability_is_remapped_to_the_page() {
    let r = rig().await;
    let page = capability(&r.w, "facebook_page", PAGE, PAGE_COMMENTS).await;
    let messenger = capability(&r.w, "messenger", PAGE, PAGE_COMMENTS).await;
    assert_eq!(
        deliver(
            &r,
            &messenger,
            "comment:100_1",
            comment_on(PAGE, "100_1", Some("42"))
        )
        .await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let conv = &s.inbox.conversations[0];
    assert_eq!(
        (conv.capability_id, conv.kind_key.as_str()),
        (page.id, "facebook_page")
    );
    assert_eq!(item(&s, "100_1").capability_id, page.id);
    assert_eq!(s.inbox.identities[0].value_normalized, format!("{PAGE}:42"));
}

#[tokio::test]
async fn comment_event_on_messenger_capability_without_a_page_capability_is_no_surface() {
    let r = rig().await;
    let messenger = capability(&r.w, "messenger", PAGE, PAGE_COMMENTS).await;
    assert_eq!(
        deliver(
            &r,
            &messenger,
            "comment:100_1",
            comment_on(PAGE, "100_1", Some("42"))
        )
        .await,
        "no_surface"
    );
    let s = r.w.uow.snapshot().inbox;
    assert!(s.people.is_empty() && s.messages.is_empty() && s.public_items.is_empty());
}

// ---------------------------------------------------------------------------------------------
// The webhook gate
// ---------------------------------------------------------------------------------------------

fn comment_event(account: &str, id: &str) -> AccountEvent {
    AccountEvent {
        kind_keys: &["facebook_page", "messenger", "instagram", "instagram_dm"],
        external_account_id: account.into(),
        route: AccountRoute::ExternalId,
        draft: InboundEventDraft {
            external_id: format!("comment:{id}"),
            kind: EventKind::Comment,
            payload: comment_on(account, id, Some("42")).into_payload(json!({})),
            occurred_at: None,
        },
    }
}

async fn receive(r: &Rig, events: Vec<AccountEvent>) -> Vec<Delivery> {
    webhook::receive_for_accounts(&r.w.deps, Provider::Meta, events, &|_: &[usize]| None)
        .await
        .unwrap()
}

#[tokio::test]
async fn comment_routed_to_messenger_is_kept_when_the_page_grant_holds() {
    let r = rig().await;
    let page = capability(&r.w, "facebook_page", PAGE, PAGE_COMMENTS).await;
    // The newest capability of the account wins the routing: the messenger sibling.
    let messenger = capability(&r.w, "messenger", PAGE, PAGE_COMMENTS).await;
    let out = receive(&r, vec![comment_event(PAGE, "100_1")]).await;
    assert!(matches!(out[..], [Delivery::Stored(_)]), "{out:?}");
    let stored = r.w.uow.snapshot().inbound_events;
    assert_eq!(stored.len(), 1);
    assert!(
        [Some(page.id), Some(messenger.id)].contains(&stored[0].event.capability_id),
        "{:?}",
        stored[0].event.capability_id
    );
    let report = jt_app::usecases::jobs::run_inbox_consume(&r.w.deps, now(0)).await;
    assert_eq!((report.changed, report.failed), (1, 0));
    let s = r.w.uow.snapshot();
    assert_eq!(item(&s, "100_1").capability_id, page.id);
}

#[tokio::test]
async fn comment_not_stored_when_comments_are_not_enabled() {
    // The grant lacks the comment scopes (today's Facebook Login grant), flags on.
    let r = rig().await;
    capability(
        &r.w,
        "facebook_page",
        PAGE,
        &[
            "pages_show_list",
            "pages_read_engagement",
            "pages_messaging",
        ],
    )
    .await;
    assert_eq!(
        receive(&r, vec![comment_event(PAGE, "100_1")]).await,
        [Delivery::Disabled]
    );
    // A figurunica-like Instagram Login grant (basic, content publishing), both flags on.
    capability_via(
        &r.w,
        "instagram",
        IG,
        "instagram",
        &[
            "instagram_business_basic",
            "instagram_business_content_publish",
        ],
    )
    .await;
    assert_eq!(
        receive(&r, vec![comment_event(IG, "1")]).await,
        [Delivery::Disabled]
    );
    assert!(r.w.uow.snapshot().inbound_events.is_empty());
    // A direct message for the same account is stored as before.
    let dm = AccountEvent {
        kind_keys: &["facebook_page", "messenger"],
        external_account_id: PAGE.into(),
        route: AccountRoute::ExternalId,
        draft: InboundEventDraft {
            external_id: "m_1".into(),
            kind: EventKind::Message,
            payload: json!({"messaging": {"sender": {"id": "42"}, "message": {"mid": "m_1", "text": "Merhaba"}}}),
            occurred_at: None,
        },
    };
    assert!(matches!(
        receive(&r, vec![dm]).await[..],
        [Delivery::Stored(_)]
    ));

    // The grant holds the scopes but the platform's flag is off: dropped all the same.
    for (meta, instagram) in [(false, true), (false, false)] {
        let r = rig_with(meta, instagram).await;
        capability(&r.w, "facebook_page", PAGE, PAGE_COMMENTS).await;
        assert_eq!(
            receive(&r, vec![comment_event(PAGE, "100_1")]).await,
            [Delivery::Disabled],
            "{meta} {instagram}"
        );
        assert!(r.w.uow.snapshot().inbound_events.is_empty());
    }
    // An Instagram Login grant follows the Instagram flag, not Meta's.
    let r = rig_with(true, false).await;
    capability_via(
        &r.w,
        "instagram",
        IG,
        "instagram",
        &[
            "instagram_business_basic",
            "instagram_business_manage_comments",
        ],
    )
    .await;
    assert_eq!(
        receive(&r, vec![comment_event(IG, "1")]).await,
        [Delivery::Disabled]
    );
    let r = rig_with(false, true).await;
    capability_via(
        &r.w,
        "instagram",
        IG,
        "instagram",
        &[
            "instagram_business_basic",
            "instagram_business_manage_comments",
        ],
    )
    .await;
    assert!(matches!(
        receive(&r, vec![comment_event(IG, "1")]).await[..],
        [Delivery::Stored(_)]
    ));
}

#[tokio::test]
async fn comment_ignored_by_consumer_when_grant_later_revoked() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    // Stored while the grant held; the owner reconnected without the comment scopes since.
    let id = ig.id;
    r.w.uow.edit(|s| {
        let stored = s
            .capabilities
            .iter_mut()
            .find(|c| c.capability.id == id)
            .unwrap();
        stored.capability.connector_public["access"]["scopes"] = json!(["instagram_basic"]);
    });
    let ig = {
        let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
        t.capabilities().find(id).await.unwrap().unwrap()
    };
    assert_eq!(
        deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await,
        "comments_not_enabled"
    );
    let s = r.w.uow.snapshot().inbox;
    assert!(s.people.is_empty() && s.messages.is_empty() && s.public_items.is_empty());
    assert!(r.surface.calls().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Our own comments
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn own_comment_marks_the_parent_answered_elsewhere() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    assert_eq!(
        deliver(&r, &ig, "comment:2", own_reply("2", "1", "DM attık")).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    // Our comment is no person and no item of its own.
    assert_eq!(s.inbox.people.len(), 1);
    assert_eq!(s.inbox.public_items.len(), 1);
    let parent = item(&s, "1");
    let AnswerState::Answered {
        by: AnsweredBy::Elsewhere,
        message_id: Some(answer),
        ..
    } = parent.answer
    else {
        panic!("answered elsewhere expected: {:?}", parent.answer);
    };
    let message = s.inbox.messages.iter().find(|m| m.id == answer).unwrap();
    assert_eq!(
        (message.direction, &message.author, message.body.as_str()),
        (Direction::Outbound, &Author::System, "DM attık")
    );
    assert_eq!(message.external_id.as_deref(), Some("2"));
    assert_eq!(
        conversation(&s, parent.conversation_id).state,
        ConvState::Theirs
    );
    // Its replay changes nothing.
    assert_eq!(
        deliver(&r, &ig, "poll:comment:2", own_reply("2", "1", "DM attık")).await,
        "duplicate"
    );
}

#[tokio::test]
async fn own_comment_binds_our_sending_reply() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    let s = r.w.uow.snapshot();
    let parent = item(&s, "1");
    // Our reply is in flight: its row is sending, its message has no provider id yet.
    let reply = MessageId::new_v7();
    let ws = r.w.ws;
    let conversation_id = parent.conversation_id;
    r.w.uow.edit(|s| {
        s.inbox.messages.push(Message {
            id: reply,
            workspace_id: ws,
            conversation_id,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: "Merhaba, DM'den yazdık".into(),
            external_id: None,
            status: MsgStatus::Queued,
            cost_minor: None,
            at: FIXED_NOW,
        });
        s.inbox.outbox.push(OutboxRow {
            id: uuid::Uuid::now_v7(),
            workspace_id: ws,
            conversation_id,
            message_id: reply,
            capability_id: ig.id,
            intent: json!({"kind": "reply", "public": {"item_id": parent.id, "visibility": "public", "target": {"kind": "comment", "external_id": "1"}}}),
            expected_generation: 0,
            fence_snapshot: Some(
                json!({"send_at": FIXED_NOW.unix_timestamp_nanos().to_string()}),
            ),
            conversation_merged: false,
            state: "sending".into(),
            attempts: 1,
            last_error: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        });
    });
    assert_eq!(
        deliver(
            &r,
            &ig,
            "comment:2",
            own_reply("2", "1", "Merhaba, DM'den yazdık")
        )
        .await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let bound = s.inbox.messages.iter().find(|m| m.id == reply).unwrap();
    assert_eq!(bound.external_id.as_deref(), Some("2"));
    // The receipt finalises the reply: the item and the message's status wait for it.
    assert_eq!(bound.status, MsgStatus::Queued);
    assert_eq!(item(&s, "1").answer, AnswerState::Awaiting);
    assert_eq!(s.inbox.messages.len(), 2);
}

// ---------------------------------------------------------------------------------------------
// A provider's new states
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn edited_comment_adds_a_revision_and_keeps_the_answer_state() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    let answered = AnswerState::Answered {
        by: AnsweredBy::Us,
        message_id: None,
        at: FIXED_NOW,
    };
    let state = answered.clone();
    r.w.uow
        .edit(move |s| s.inbox.public_items[0].answer = state);
    let mut edited = with_status(comment("1", Some(FAN)), EnvelopeStatus::Edited);
    edited.text = "Fiyatı nedir? Kargo dahil mi?".into();
    assert_eq!(
        deliver(&r, &ig, "comment:1:edited:1700000000", edited).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let item = item(&s, "1");
    assert_eq!(s.inbox.messages.len(), 2);
    let revision = s
        .inbox
        .messages
        .iter()
        .find(|m| m.id == item.message_id)
        .unwrap();
    assert_eq!(revision.body, "Fiyatı nedir? Kargo dahil mi?");
    assert_eq!(
        revision.external_id.as_deref(),
        Some("comment:1:edited:1700000000")
    );
    assert_eq!(revision.direction, Direction::Inbound);
    assert_eq!(item.answer, answered);
    // An edit of a comment the inbox does not know is a new item.
    let mut unknown = with_status(comment("9", Some(FAN)), EnvelopeStatus::Edited);
    unknown.text = "Merhaba".into();
    assert_eq!(
        deliver(&r, &ig, "comment:9:edited:1700000001", unknown).await,
        "consumed"
    );
    assert_eq!(r.w.uow.snapshot().inbox.public_items.len(), 2);
}

#[tokio::test]
async fn removed_comment_is_removed_and_not_owed() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    assert_eq!(
        deliver(
            &r,
            &ig,
            "comment:1:removed",
            with_status(comment("1", Some(FAN)), EnvelopeStatus::Removed)
        )
        .await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let item = item(&s, "1");
    assert_eq!(item.moderation, Moderation::Removed);
    assert!(!item.awaiting());
    assert_eq!(
        conversation(&s, item.conversation_id).state,
        ConvState::Theirs
    );
    // A removal of a comment the inbox never saw is consumed with nothing written.
    assert_eq!(
        deliver(
            &r,
            &ig,
            "comment:7:removed",
            with_status(comment("7", Some(FAN)), EnvelopeStatus::Removed)
        )
        .await,
        "consumed"
    );
    assert_eq!(r.w.uow.snapshot().inbox.public_items.len(), 1);
}

#[tokio::test]
async fn question_open_then_answered_elsewhere() {
    let r = rig().await;
    let store = capability(&r.w, "trendyol", SELLER, &[]).await;
    assert_eq!(
        deliver(&r, &store, "q:501:open:", question("501", Some("cust-77"))).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let asked = item(&s, "501");
    assert_eq!(asked.kind, PublicKind::Question);
    assert_eq!(asked.private_reply_until, None);
    assert_eq!(
        s.inbox.identities[0].channel,
        IdentityChannel::TrendyolBuyer
    );
    assert_eq!(
        s.inbox.identities[0].value_normalized,
        format!("{SELLER}:cust-77")
    );
    let subject = &s.inbox.public_subjects[0];
    assert_eq!(
        (subject.kind, subject.title.as_str()),
        (SubjectKind::Product, "Boyama seti")
    );
    assert_eq!(
        conversation(&s, asked.conversation_id).state,
        ConvState::Ours
    );
    // Answered in the seller panel, with a text Jeeta never sent.
    let mut answered = with_status(question("501", Some("cust-77")), EnvelopeStatus::Answered);
    answered.answer = Some(EnvelopeAnswer {
        text: "Evet, S beden stokta.".into(),
        at: Some(FIXED_NOW),
    });
    assert_eq!(
        deliver(&r, &store, "q:501:answered:2026-10-30T09:00:00Z", answered).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let item = item(&s, "501");
    let AnswerState::Answered {
        by: AnsweredBy::Elsewhere,
        message_id: Some(answer),
        ..
    } = item.answer
    else {
        panic!("answered elsewhere expected: {:?}", item.answer);
    };
    let message = s.inbox.messages.iter().find(|m| m.id == answer).unwrap();
    assert_eq!(
        (message.direction, &message.author, message.body.as_str()),
        (
            Direction::Outbound,
            &Author::System,
            "Evet, S beden stokta."
        )
    );
    assert_eq!(
        conversation(&s, item.conversation_id).state,
        ConvState::Theirs
    );
}

#[tokio::test]
async fn our_pending_answer_is_confirmed_or_rejected_by_the_marketplace() {
    let r = rig().await;
    let store = capability(&r.w, "trendyol", SELLER, &[]).await;
    for id in ["601", "602"] {
        deliver(
            &r,
            &store,
            &format!("q:{id}:open:"),
            question(id, Some("cust-1")),
        )
        .await;
    }
    // Our answers are in the marketplace's review.
    let s = r.w.uow.snapshot();
    let conversation_id = item(&s, "601").conversation_id;
    let ws = r.w.ws;
    let ours = [MessageId::new_v7(), MessageId::new_v7()];
    r.w.uow.edit(move |s| {
        for (i, id) in ["601", "602"].into_iter().enumerate() {
            s.inbox.messages.push(Message {
                id: ours[i],
                workspace_id: ws,
                conversation_id,
                direction: Direction::Outbound,
                author: Author::Agent,
                body: "Evet, S beden mevcut.".into(),
                external_id: None,
                status: MsgStatus::Sent,
                cost_minor: None,
                at: FIXED_NOW,
            });
            let item = s
                .inbox
                .public_items
                .iter_mut()
                .find(|item| item.external_id == id)
                .unwrap();
            item.answer = AnswerState::Pending {
                message_id: ours[i],
            };
        }
    });
    let mut published = with_status(question("601", Some("cust-1")), EnvelopeStatus::Answered);
    published.answer = Some(EnvelopeAnswer {
        text: " Evet, S beden mevcut. ".into(),
        at: None,
    });
    assert_eq!(
        deliver(&r, &store, "q:601:answered:t1", published).await,
        "consumed"
    );
    let mut refused = with_status(question("602", Some("cust-1")), EnvelopeStatus::Rejected);
    refused.rejection = Some(EnvelopeRejection {
        reason: "Cevabınız içerik kurallarına uymuyor".into(),
        at: None,
    });
    assert_eq!(
        deliver(&r, &store, "q:602:rejected:t2", refused).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    assert!(matches!(
        item(&s, "601").answer,
        AnswerState::Answered { by: AnsweredBy::Us, message_id: Some(m), .. } if m == ours[0]
    ));
    let rejected = item(&s, "602");
    assert!(matches!(
        &rejected.answer,
        AnswerState::Rejected { message_id: Some(m), .. } if *m == ours[1]
    ));
    // Owed again: the conversation is ours.
    assert!(rejected.awaiting());
    assert_eq!(conversation(&s, conversation_id).state, ConvState::Ours);
    let entries = r.w.entries("inbox.public.answer_rejected");
    assert_eq!(entries.len(), 1);
    assert_eq!(payload(&entries[0])["item_id"], json!(rejected.id));
    // The ledger keeps no text of the platform's.
    assert!(!wire(&entries).contains("içerik"));
}

#[tokio::test]
async fn question_status_for_an_unknown_item_is_deferred() {
    let r = rig().await;
    let store = capability(&r.w, "trendyol", SELLER, &[]).await;
    let mut answered = with_status(question("700", Some("cust-1")), EnvelopeStatus::Answered);
    answered.answer = Some(EnvelopeAnswer {
        text: "Evet".into(),
        at: None,
    });
    assert_eq!(
        deliver(&r, &store, "q:700:answered:t", answered).await,
        "deferred"
    );
    let s = r.w.uow.snapshot().inbox;
    assert!(s.people.is_empty() && s.messages.is_empty() && s.public_items.is_empty());
}

#[tokio::test]
async fn trendyol_buyer_without_customer_id_is_a_one_off_person() {
    let r = rig().await;
    let store = capability(&r.w, "trendyol", SELLER, &[]).await;
    deliver(&r, &store, "q:801:open:", question("801", None)).await;
    deliver(&r, &store, "q:802:open:", question("802", None)).await;
    let s = r.w.uow.snapshot().inbox;
    assert_eq!(s.people.len(), 2);
    let mut values: Vec<_> = s
        .identities
        .iter()
        .map(|i| i.value_normalized.clone())
        .collect();
    values.sort();
    assert_eq!(
        values,
        [format!("{SELLER}:q:801"), format!("{SELLER}:q:802")]
    );
}

#[tokio::test]
async fn trendyol_name_hidden_when_show_user_name_false() {
    let r = rig().await;
    let store = capability(&r.w, "trendyol", SELLER, &[]).await;
    // The adapter leaves the name out of the envelope when the buyer hides it; the name in the
    // provider's own item (here `userName`) is never read.
    deliver(&r, &store, "q:901:open:", question("901", Some("cust-9"))).await;
    let s = r.w.uow.snapshot();
    assert_eq!(s.inbox.people[0].display_name, "");
    assert!(!wire(&s.inbox.people).contains("Ayşe"));
    // A name the envelope gives is kept.
    let mut named = question("902", Some("cust-8"));
    named.author.name = Some("  Ayşe K.\u{7} ".into());
    deliver(&r, &store, "q:902:open:", named).await;
    let s = r.w.uow.snapshot();
    assert!(s.inbox.people.iter().any(|p| p.display_name == "Ayşe K."));
}

#[tokio::test]
async fn erased_commenter_is_dropped() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    let ws = r.w.ws;
    let hash = identity_hash(IdentityChannel::InstagramCommenter, &format!("{IG}:{FAN}"));
    r.w.uow.edit(move |s| {
        s.inbox
            .erased_identities
            .push((ws, IdentityChannel::InstagramCommenter, hash))
    });
    assert_eq!(
        deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await,
        "erased_identity_drop"
    );
    let s = r.w.uow.snapshot().inbox;
    assert!(s.people.is_empty() && s.messages.is_empty() && s.public_items.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Subjects, state, echoes, merges
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn subject_is_fetched_once_and_linked_to_the_studio_publication() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    let publication = jt_studio::Publication {
        id: jt_studio::PublicationId::new_v7(),
        chain: jt_studio::Chain {
            workspace_id: r.w.ws,
            born_version_id: jt_strategy::StrategyVersionId::new_v7(),
            hypothesis_id: jt_strategy::HypothesisId::new_v7(),
            arm_id: jt_studio::ArmId::new_v7(),
        },
        slot_id: jt_studio::SlotId::new_v7(),
        piece_id: jt_studio::PieceId::new_v7(),
        capability_id: ig.id,
        account_id: Some(IG.into()),
        executed_version_id: jt_strategy::StrategyVersionId::new_v7(),
        external_id: POST.into(),
        url: None,
        published_at: FIXED_NOW - Duration::days(1),
        actor: jt_ledger::Actor::System {
            component: "test".into(),
        },
        attempt_id: jt_studio::PublishAttemptId::new_v7(),
    };
    let publication_id = publication.id.as_uuid();
    r.w.uow
        .edit(move |s| s.studio.publications.push(publication));
    r.surface.push_subject(Ok(Some(SubjectFacts {
        kind: SubjectKind::Post,
        title: "Yeni sezon kitleri geldi".into(),
        url: Some("https://www.instagram.example/p/abc/".into()),
        image_url: Some("https://cdn.instagram.example/abc.jpg".into()),
        facts: json!({"media_product_type": "REELS"}),
    })));
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    deliver(
        &r,
        &ig,
        "comment:2",
        comment("2", Some("17841400000000010")),
    )
    .await;
    // Asked once: the second comment's subject is known and fresh.
    let asked: Vec<_> = r
        .surface
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            PublicCall::Subject {
                subject_external_id,
                public,
            } => Some((subject_external_id, public["external_id"].clone())),
            _ => None,
        })
        .collect();
    assert_eq!(asked, [(POST.to_owned(), json!(IG))]);
    let s = r.w.uow.snapshot();
    assert_eq!(s.inbox.public_subjects.len(), 1);
    let subject = &s.inbox.public_subjects[0];
    assert_eq!(subject.title, "Yeni sezon kitleri geldi");
    assert_eq!(
        subject.image_url.as_deref(),
        Some("https://cdn.instagram.example/abc.jpg")
    );
    assert_eq!(subject.facts["media_product_type"], "REELS");
    assert_eq!(subject.publication_id, Some(publication_id));
    assert!(
        s.inbox
            .public_items
            .iter()
            .all(|i| i.subject_id == Some(subject.id))
    );
}

#[tokio::test]
async fn conversation_state_is_ours_while_an_item_is_owed() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    deliver(&r, &ig, "comment:2", comment("2", Some(FAN))).await;
    let conv = item(&r.w.uow.snapshot(), "1").conversation_id;
    deliver(
        &r,
        &ig,
        "comment:1:removed",
        with_status(comment("1", Some(FAN)), EnvelopeStatus::Removed),
    )
    .await;
    // The second comment is still owed.
    assert_eq!(
        conversation(&r.w.uow.snapshot(), conv).state,
        ConvState::Ours
    );
    deliver(&r, &ig, "comment:3", own_reply("3", "2", "Teşekkürler")).await;
    assert_eq!(
        conversation(&r.w.uow.snapshot(), conv).state,
        ConvState::Theirs
    );
    // A closed conversation stays closed while its items settle; a new comment reopens it.
    r.w.uow.edit(move |s| {
        s.inbox
            .conversations
            .iter_mut()
            .find(|c| c.id == conv)
            .unwrap()
            .state = ConvState::Closed;
    });
    deliver(
        &r,
        &ig,
        "comment:2:removed",
        with_status(comment("2", Some(FAN)), EnvelopeStatus::Removed),
    )
    .await;
    assert_eq!(
        conversation(&r.w.uow.snapshot(), conv).state,
        ConvState::Closed
    );
    deliver(&r, &ig, "comment:4", comment("4", Some(FAN))).await;
    assert_eq!(
        conversation(&r.w.uow.snapshot(), conv).state,
        ConvState::Ours
    );
}

#[tokio::test]
async fn private_reply_echo_is_a_duplicate_not_a_deferral() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    let dm = capability(&r.w, "instagram_dm", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    // Our private reply went out from the comment's conversation, with Meta's message id.
    let conversation_id = item(&r.w.uow.snapshot(), "1").conversation_id;
    let ws = r.w.ws;
    r.w.uow.edit(move |s| {
        s.inbox.messages.push(Message {
            id: MessageId::new_v7(),
            workspace_id: ws,
            conversation_id,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: "DM'den yazdık".into(),
            external_id: Some("m_PRIVATE-1".into()),
            status: MsgStatus::Sent,
            cost_minor: None,
            at: FIXED_NOW,
        })
    });
    let echo = json!({"messaging": {
        "sender": {"id": IG},
        "recipient": {"id": "998877"},
        "message": {"mid": "m_PRIVATE-1", "text": "DM'den yazdık", "is_echo": true},
    }});
    assert_eq!(
        deliver_raw(&r, &dm, "m_PRIVATE-1", EventKind::MessageEcho, echo).await,
        "duplicate"
    );
    let s = r.w.uow.snapshot().inbox;
    assert_eq!(s.messages.len(), 2);
    assert_eq!(s.people.len(), 1);
}

#[tokio::test]
async fn merged_commenters_conversation_state_follows_their_items() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    deliver(
        &r,
        &ig,
        "comment:2",
        comment("2", Some("17841400000000010")),
    )
    .await;
    let s = r.w.uow.snapshot();
    let (a, b) = (item(&s, "1"), item(&s, "2"));
    let keep = conversation(&s, a.conversation_id).person_id;
    let other = conversation(&s, b.conversation_id).person_id;
    // A's comment needed no reply: A's conversation is theirs; B's is ours.
    let (a_id, a_conv) = (a.id, a.conversation_id);
    r.w.uow.edit(move |s| {
        for i in &mut s.inbox.public_items {
            if i.id == a_id {
                i.answer = AnswerState::Handled {
                    by: EventSource::System,
                    reason: HandledReason::NoReplyNeeded,
                    at: FIXED_NOW,
                };
            }
        }
        for c in &mut s.inbox.conversations {
            if c.id == a_conv {
                c.state = ConvState::Theirs;
            }
        }
    });
    // Both turn out to be one person (the same phone number).
    let ctx = at(&r.w.owner_ctx, now(100));
    for person in [other, keep] {
        let input =
            serde_json::from_value(json!({"channel": "phone", "value": "05321234568"})).unwrap();
        people::add_identity(&r.w.deps, &ctx, person, input)
            .await
            .unwrap();
    }
    let suggested = merge::list(&r.w.deps, &ctx).await.unwrap().remove(0);
    merge::apply(&r.w.deps, &ctx, suggested.id, merge::ApplyInput { keep })
        .await
        .unwrap();
    let s = r.w.uow.snapshot();
    let (a, b) = (item(&s, "1"), item(&s, "2"));
    // B's owed comment joined A's conversation, which is ours now.
    assert_eq!(a.conversation_id, b.conversation_id);
    assert_eq!(conversation(&s, a.conversation_id).state, ConvState::Ours);
    // The undo puts each back, with its state.
    merge::undo(
        &r.w.deps,
        &at(&ctx, now(200)),
        suggested.id,
        merge::UndoInput { confirm: true },
    )
    .await
    .unwrap();
    let s = r.w.uow.snapshot();
    let (a, b) = (item(&s, "1"), item(&s, "2"));
    assert_ne!(a.conversation_id, b.conversation_id);
    assert_eq!(conversation(&s, a.conversation_id).state, ConvState::Theirs);
    assert_eq!(conversation(&s, b.conversation_id).state, ConvState::Ours);
}

// ---------------------------------------------------------------------------------------------
// Own comments: bound by parent (spec §6.4 step 2), and only as written
// ---------------------------------------------------------------------------------------------

/// Our reply in flight on `item` (`target`), with `text`: a message without a provider id and a
/// sending outbox row.
fn reply_in_flight(r: &Rig, item: &PublicItem, target: &str, text: &str) -> MessageId {
    let reply = MessageId::new_v7();
    let ws = r.w.ws;
    let (conversation_id, item_id, capability_id) =
        (item.conversation_id, item.id, item.capability_id);
    let (target, text) = (target.to_owned(), text.to_owned());
    r.w.uow.edit(move |s| {
        s.inbox.messages.push(Message {
            id: reply,
            workspace_id: ws,
            conversation_id,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: text,
            external_id: None,
            status: MsgStatus::Queued,
            cost_minor: None,
            at: FIXED_NOW,
        });
        s.inbox.outbox.push(OutboxRow {
            id: uuid::Uuid::now_v7(),
            workspace_id: ws,
            conversation_id,
            message_id: reply,
            capability_id,
            intent: json!({"kind": "reply", "public": {"item_id": item_id, "visibility": "public",
                "target": {"kind": "comment", "external_id": target}}}),
            expected_generation: 0,
            fence_snapshot: Some(json!({"send_at": FIXED_NOW.unix_timestamp_nanos().to_string()})),
            conversation_merged: false,
            state: "sending".into(),
            attempts: 1,
            last_error: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        });
    });
    reply
}

#[tokio::test]
async fn own_comment_binds_only_our_reply_to_its_parent() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    deliver(&r, &ig, "comment:2", comment("2", Some(FAN))).await;
    let s = r.w.uow.snapshot();
    // Our reply to the second comment is in flight, with the same text.
    let to_second = reply_in_flight(&r, &item(&s, "2"), "2", "Teşekkürler");
    // Our comment under the first one is not that reply: answered outside Jeeta.
    assert_eq!(
        deliver(&r, &ig, "comment:3", own_reply("3", "1", "Teşekkürler")).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let unbound = s.inbox.messages.iter().find(|m| m.id == to_second).unwrap();
    assert_eq!(unbound.external_id, None);
    assert!(matches!(
        item(&s, "1").answer,
        AnswerState::Answered {
            by: AnsweredBy::Elsewhere,
            ..
        }
    ));
    // Our comment under the second one is: bound.
    assert_eq!(
        deliver(&r, &ig, "comment:4", own_reply("4", "2", "Teşekkürler")).await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let bound = s.inbox.messages.iter().find(|m| m.id == to_second).unwrap();
    assert_eq!(bound.external_id.as_deref(), Some("4"));
    assert_eq!(item(&s, "2").answer, AnswerState::Awaiting);
}

#[tokio::test]
async fn our_removed_comment_never_answers_the_parent() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    let before = r.w.uow.snapshot().inbox;
    for status in [
        EnvelopeStatus::Removed,
        EnvelopeStatus::Answered,
        EnvelopeStatus::Reported,
    ] {
        assert_eq!(
            deliver(
                &r,
                &ig,
                &format!("comment:2:{status:?}"),
                with_status(own_reply("2", "1", "Teşekkürler"), status)
            )
            .await,
            "consumed",
            "{status:?}"
        );
    }
    let after = r.w.uow.snapshot().inbox;
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.public_items, before.public_items);
}

// ---------------------------------------------------------------------------------------------
// Erasure (task F9)
// ---------------------------------------------------------------------------------------------

/// The person of item `external_id`.
fn person_of(s: &jt_testkit::fakes::MemState, external_id: &str) -> PersonId {
    conversation(s, item(s, external_id).conversation_id).person_id
}

/// The stored payload of event `external_id`.
fn payload_of(s: &jt_testkit::fakes::MemState, external_id: &str) -> Value {
    s.inbound_events
        .iter()
        .find(|e| e.event.external_id == external_id)
        .unwrap()
        .event
        .payload
        .clone()
}

async fn erase(r: &Rig, person: PersonId) {
    jt_app::usecases::inbox::erasure::erase(
        &r.w.deps,
        &r.w.owner_ctx,
        person,
        jt_app::usecases::inbox::erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn erase_commenter_scrubs_messages_and_payloads() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    let store = capability(&r.w, "trendyol", SELLER, &[]).await;
    assert_eq!(
        deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await,
        "consumed"
    );
    assert_eq!(
        deliver(&r, &store, "q:1", question("q-1", Some("777"))).await,
        "consumed"
    );
    // Someone else's comment.
    assert_eq!(
        deliver(
            &r,
            &ig,
            "comment:2",
            comment("2", Some("17841400000000077"))
        )
        .await,
        "consumed"
    );
    let s = r.w.uow.snapshot();
    let (commenter, buyer) = (person_of(&s, "1"), person_of(&s, "q-1"));
    erase(&r, commenter).await;
    erase(&r, buyer).await;
    let s = r.w.uow.snapshot();
    for (event, external_id) in [("comment:1", "1"), ("q:1", "q-1")] {
        let payload = payload_of(&s, event);
        let public = &payload["public"];
        assert_eq!(public["author"], json!(""), "{event}");
        assert_eq!(public["text"], json!(""), "{event}");
        assert_eq!(payload["provider_item"], json!(""), "{event}");
        // Ids, states and times stay.
        assert_eq!(public["external_id"], external_id, "{event}");
        assert_eq!(public["status"], "open", "{event}");
        let message = s
            .inbox
            .messages
            .iter()
            .find(|m| m.id == item(&s, external_id).message_id)
            .unwrap();
        assert!(!message.body.contains("Fiyat") && !message.body.contains("bedeni"));
    }
    assert!(
        s.inbox
            .identities
            .iter()
            .all(|i| !i.value_normalized.contains(FAN) && !i.value_normalized.contains("777"))
    );
    // The other commenter's event is untouched.
    let kept = payload_of(&s, "comment:2");
    assert_eq!(kept["public"]["text"], "Fiyatı nedir?");
    assert_eq!(kept["provider_item"]["userName"], "Ayşe Kaya");
}

#[tokio::test]
async fn erased_commenter_new_comment_dropped() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    let person = person_of(&r.w.uow.snapshot(), "1");
    erase(&r, person).await;
    // Masked before it is stored, as the webhook and the polls store it.
    let mut payload = comment("3", Some(FAN)).into_payload(json!({"userName": "Ayşe Kaya"}));
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    assert!(
        jt_app::usecases::inbox::erasure::scrub_inbound(t.as_mut(), Some(ig.id), &mut payload)
            .await
            .unwrap()
    );
    drop(t);
    assert_eq!(payload["public"]["text"], json!(""));
    assert_eq!(payload["public"]["author"], json!(""));
    assert_eq!(payload["erased_identity"], true);
    // And dropped by the consumer: no person, message or item.
    let before = r.w.uow.snapshot().inbox;
    assert_eq!(
        deliver(&r, &ig, "comment:3", comment("3", Some(FAN))).await,
        "erased_identity_drop"
    );
    let after = r.w.uow.snapshot().inbox;
    assert_eq!(after.people.len(), before.people.len());
    assert_eq!(after.messages.len(), before.messages.len());
    assert_eq!(after.public_items.len(), before.public_items.len());
}

#[tokio::test]
async fn items_keep_no_personal_text() {
    let r = rig().await;
    let ig = capability(&r.w, "instagram", IG, IG_COMMENTS).await;
    deliver(&r, &ig, "comment:1", comment("1", Some(FAN))).await;
    let s = r.w.uow.snapshot();
    let person = person_of(&s, "1");
    let before = item(&s, "1");
    erase(&r, person).await;
    let s = r.w.uow.snapshot();
    let after = item(&s, "1");
    // The item stays, with its ids, states and times; nothing in it is personal.
    assert_eq!(
        (after.id, after.answer.clone(), after.moderation),
        (before.id, before.answer.clone(), before.moderation)
    );
    let text = serde_json::to_string(&after).unwrap();
    for personal in ["Fiyat", "a.customer", "Ayşe", FAN] {
        assert!(!text.contains(personal), "{personal} in {text}");
    }
}
