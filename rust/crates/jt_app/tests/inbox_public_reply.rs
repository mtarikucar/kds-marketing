//! Replies on public conversations (plan 2026-10-30-inbox-comments-marketplace-plan.md, task
//! F6): the reply fence of spec §3.6 at enqueue and again at claim, approval of held replies
//! (§3.7) and the receipts that answer an item (§6.5). Items are taken in through the consumer as
//! in `inbox_public_intake.rs`; the provider is a scripted public surface.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{
    EnvelopeAuthor, EnvelopeStatus, EnvelopeSubject, PUBLIC_ITEM_GONE, PrivateReceipt,
    PublicEnvelope, SendReceipt,
};
use jt_app::usecases::inbox::{consumer, merge, public, replies};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig, PublicCall, ScriptedPublic, ScriptedRegistry};
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};

const IG: &str = "17841400000000001";
const SELLER: &str = "123456";
const FAN: &str = "17841400000000009";
const IG_COMMENTS: &[&str] = &[
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_manage_messages",
];

struct Rig {
    w: World,
    meta: Arc<ScriptedPublic>,
    trendyol: Arc<ScriptedPublic>,
    ig: Capability,
    store: Capability,
    tick: AtomicI64,
}

async fn rig() -> Rig {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let mut apps = FakeAppConfig::with_all_apps();
    apps.meta.as_mut().unwrap().comment_scopes = true;
    apps.instagram.as_mut().unwrap().comment_scopes = true;
    w.deps.apps = Arc::new(apps);
    let meta = Arc::new(ScriptedPublic::new(Provider::Meta));
    let trendyol = Arc::new(ScriptedPublic::new(Provider::Trendyol));
    w.deps.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_public(meta.clone())
            .with_public(trendyol.clone()),
    );
    let ig = capability(&w, "instagram", IG, IG_COMMENTS).await;
    let store = capability(&w, "trendyol", SELLER, &[]).await;
    Rig {
        w,
        meta,
        trendyol,
        ig,
        store,
        tick: AtomicI64::new(0),
    }
}

async fn capability(w: &World, kind: &str, account: &str, scopes: &[&str]) -> Capability {
    let public = match kind {
        "trendyol" => {
            json!({"provider": "trendyol", "access": {"kind": "trendyol_seller", "seller_id": SELLER}})
        }
        _ => {
            json!({"provider": "meta", "access": {"kind": "oauth", "app": "meta", "scopes": scopes}})
        }
    };
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} {account}"),
            external_id: Some(account.into()),
            connector_public: public,
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

fn comment(id: &str, author: &str) -> PublicEnvelope {
    PublicEnvelope {
        kind: PublicKind::Comment,
        account_id: IG.into(),
        external_id: id.into(),
        parent_external_id: None,
        root_external_id: id.into(),
        status: EnvelopeStatus::Open,
        author: EnvelopeAuthor {
            id: Some(author.into()),
            name: Some("a.customer".into()),
            is_self: false,
        },
        text: "Fiyatı nedir?".into(),
        created_at: FIXED_NOW - Duration::minutes(10),
        deadline: None,
        live: false,
        subject: Some(EnvelopeSubject {
            kind: SubjectKind::Post,
            external_id: "17900000000000001".into(),
            title: "Yeni sezon".into(),
            url: None,
            image_url: None,
            facts: json!({}),
        }),
        answer: None,
        rejection: None,
    }
}

fn question(id: &str) -> PublicEnvelope {
    PublicEnvelope {
        kind: PublicKind::Question,
        account_id: SELLER.into(),
        external_id: id.into(),
        root_external_id: id.into(),
        author: EnvelopeAuthor {
            id: Some("cust-1".into()),
            name: None,
            is_self: false,
        },
        text: "Bu ürünün S bedeni var mı?".into(),
        subject: Some(EnvelopeSubject {
            kind: SubjectKind::Product,
            external_id: "PRD-1".into(),
            title: "Boyama seti".into(),
            url: None,
            image_url: None,
            facts: json!({}),
        }),
        ..comment(id, "x")
    }
}

/// Takes `env` in on `cap` through the consumer; the item.
async fn take(r: &Rig, cap: &Capability, env: PublicEnvelope) -> PublicItem {
    let tick = r.tick.fetch_add(1, Ordering::Relaxed);
    let external_id = env.external_id.clone();
    let (provider, kind) = match env.kind {
        PublicKind::Comment => (Provider::Meta, EventKind::Comment),
        PublicKind::Question => (Provider::Trendyol, EventKind::Question),
    };
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: r.w.ws,
        provider,
        capability_id: Some(cap.id),
        external_id: format!("event:{external_id}"),
        kind,
        payload: env.into_payload(json!({})),
        received_at: FIXED_NOW - Duration::minutes(5) + Duration::seconds(tick),
        processed_at: None,
    };
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    t.inbound_events()
        .insert_if_new(event.clone(), None)
        .await
        .unwrap()
        .unwrap();
    t.commit().await.unwrap();
    assert_eq!(
        consumer::consume_event(&r.w.deps, &event, FIXED_NOW - Duration::minutes(4))
            .await
            .unwrap(),
        "consumed"
    );
    item(r, &external_id)
}

fn item(r: &Rig, external_id: &str) -> PublicItem {
    r.w.uow
        .snapshot()
        .inbox
        .public_items
        .into_iter()
        .find(|i| i.external_id == external_id)
        .unwrap()
}

fn edit_item(r: &Rig, id: PublicItemId, f: impl FnOnce(&mut PublicItem)) {
    r.w.uow.edit(|s| {
        f(s.inbox
            .public_items
            .iter_mut()
            .find(|i| i.id == id)
            .unwrap())
    });
}

fn edit_policy(r: &Rig, id: CapabilityId, f: impl FnOnce(&mut jt_capability::Policy)) {
    r.w.uow.edit(|s| {
        f(&mut s
            .capabilities
            .iter_mut()
            .find(|c| c.capability.id == id)
            .unwrap()
            .capability
            .policy)
    });
}

fn input(item: Option<PublicItemId>, visibility: Option<&str>, text: &str) -> replies::ReplyInput {
    serde_json::from_value(json!({
        "text": text, "intent": "reply", "item_id": item, "visibility": visibility,
    }))
    .unwrap()
}

fn public_reply(item: &PublicItem, text: &str) -> replies::ReplyInput {
    input(Some(item.id), None, text)
}

/// The replies and moderation calls `surface` received (the subject reads of the intake left
/// out).
fn sends(surface: &ScriptedPublic) -> Vec<PublicCall> {
    surface
        .calls()
        .into_iter()
        .filter(|c| !matches!(c, PublicCall::Subject { .. }))
        .collect()
}

fn accepted(id: &str) -> Result<SendReceipt, ConnectorError> {
    Ok(SendReceipt {
        provider_id: id.into(),
        cost_minor: None,
    })
}

async fn agent(r: &Rig) -> jt_app::ctx::Ctx {
    r.w.agent(&["inbox.work"]).await
}

fn reason(e: &jt_app::error::AppError) -> String {
    e.details["reason"].as_str().unwrap_or_default().to_owned()
}

fn outbox(r: &Rig, message: MessageId) -> jt_app::ports::inbox::OutboxRow {
    r.w.uow
        .snapshot()
        .inbox
        .outbox
        .into_iter()
        .find(|o| o.message_id == message)
        .unwrap()
}

fn message(r: &Rig, id: MessageId) -> Message {
    r.w.uow
        .snapshot()
        .inbox
        .messages
        .into_iter()
        .find(|m| m.id == id)
        .unwrap()
}

fn conversation_state(r: &Rig, id: ConversationId) -> ConvState {
    r.w.uow
        .snapshot()
        .inbox
        .conversations
        .into_iter()
        .find(|c| c.id == id)
        .unwrap()
        .state
}

// ---------------------------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn public_reply_requires_item_id() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    let e = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        input(None, None, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "item_required");
    assert_eq!(r.w.entries("inbox.send.refused").len(), 1);
    assert!(sends(&r.meta).is_empty());
    assert!(r.w.uow.snapshot().inbox.outbox.is_empty());
}

#[tokio::test]
async fn item_fields_refused_on_a_dm_conversation() {
    let (w, conversation, _) = support::outbound::setup_channel("whatsapp_cloud").await;
    let item = PublicItemId::new_v7();
    for (item, visibility) in [(Some(item), None), (None, Some("public"))] {
        let e = replies::reply(
            &w.deps,
            &w.owner_ctx,
            conversation,
            input(item, visibility, "Merhaba"),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, jt_app::error::ErrorCode::Validation);
        assert_eq!(reason(&e), "item_requires_public_conversation");
    }
    assert!(w.uow.snapshot().inbox.outbox.is_empty());
}

#[tokio::test]
async fn commercial_refused_on_public() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    let commercial: replies::ReplyInput = serde_json::from_value(json!({
        "text": "Kampanya!", "intent": "commercial", "item_id": c1.id,
    }))
    .unwrap();
    let e = replies::reply(&r.w.deps, &r.w.owner_ctx, c1.conversation_id, commercial)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "commercial_on_public_surface");
    assert!(sends(&r.meta).is_empty());
}

#[tokio::test]
async fn comments_not_enabled_refuses_reply() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    let id = r.ig.id;
    r.w.uow.edit(|s| {
        s.capabilities
            .iter_mut()
            .find(|c| c.capability.id == id)
            .unwrap()
            .capability
            .connector_public["access"]["scopes"] = json!(["instagram_basic"]);
    });
    let e = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "comments_not_enabled");
    assert!(sends(&r.meta).is_empty());
}

#[tokio::test]
async fn every_public_refusal_is_reached_through_inbox_reply() {
    let r = rig().await;
    let agent = agent(&r).await;
    let human = r.w.owner_ctx.clone();
    let past = FIXED_NOW - Duration::hours(1);
    // One case per refusal of spec §3.6 rule 4 and 5: the item made so, the reply, who sends.
    type Setup = Box<dyn Fn(&mut PublicItem)>;
    /// (the refusal expected, a question?, the item made so, the visibility, the text, by the
    /// agent?)
    type Case = (
        &'static str,
        bool,
        Setup,
        Option<&'static str>,
        &'static str,
        bool,
    );
    let none: fn() -> Setup = || Box::new(|_| {});
    let cases: Vec<Case> = vec![
        (
            "item_removed",
            false,
            Box::new(|i| i.moderation = Moderation::Removed),
            None,
            "Merhaba",
            false,
        ),
        (
            "live_comment_public_reply",
            false,
            Box::new(|i| i.live = true),
            None,
            "Merhaba",
            false,
        ),
        (
            "deadline_passed",
            true,
            Box::new(move |i| i.deadline = Some(past)),
            None,
            "Evet, S beden var.",
            false,
        ),
        (
            "already_answered",
            true,
            Box::new(|i| {
                i.answer = AnswerState::Pending {
                    message_id: i.message_id,
                }
            }),
            None,
            "Evet, S beden var.",
            false,
        ),
        (
            "agent_already_replied",
            false,
            Box::new(|i| {
                i.agent_answers = 1;
                i.answer = AnswerState::Answered {
                    by: AnsweredBy::Us,
                    message_id: None,
                    at: FIXED_NOW,
                };
            }),
            None,
            "Bir daha",
            true,
        ),
        (
            "item_not_owed",
            false,
            Box::new(|i| {
                i.answer = AnswerState::Handled {
                    by: EventSource::System,
                    reason: HandledReason::NoReplyNeeded,
                    at: FIXED_NOW,
                };
            }),
            None,
            "Merhaba",
            true,
        ),
        (
            "private_reply_unsupported",
            true,
            none(),
            Some("private"),
            "Evet, S beden var.",
            false,
        ),
        (
            "private_window_closed",
            false,
            Box::new(move |i| i.private_reply_until = Some(past)),
            Some("private"),
            "Merhaba",
            false,
        ),
        (
            "private_reply_used",
            false,
            Box::new(|i| i.private_reply_message_id = Some(i.message_id)),
            Some("private"),
            "Merhaba",
            false,
        ),
        ("text_too_short", true, none(), None, "Evet var.", false),
        ("text_too_long", false, none(), None, "", false),
        (
            "contact_data_in_public_reply",
            false,
            none(),
            None,
            "Sizi 0532 000 00 01'den arıyoruz",
            false,
        ),
        (
            "contact_data_in_marketplace_answer",
            true,
            none(),
            None,
            "Detaylar için www.example.com adresine bakın",
            true,
        ),
    ];
    for (n, (expected, is_question, change, visibility, text, by_agent)) in
        cases.into_iter().enumerate()
    {
        let (cap, env) = if is_question {
            (r.store.clone(), question(&format!("q{n}")))
        } else {
            (r.ig.clone(), comment(&format!("c{n}"), &format!("fan-{n}")))
        };
        let taken = take(&r, &cap, env).await;
        edit_item(&r, taken.id, |i| change(i));
        if expected == "contact_data_in_public_reply" {
            // The commenter's own phone, which the reply repeats written another way.
            let person =
                r.w.uow
                    .snapshot()
                    .inbox
                    .conversations
                    .into_iter()
                    .find(|c| c.id == taken.conversation_id)
                    .unwrap()
                    .person_id;
            jt_app::usecases::inbox::people::add_identity(
                &r.w.deps,
                &human,
                person,
                serde_json::from_value(json!({"channel": "phone", "value": "+905320000001"}))
                    .unwrap(),
            )
            .await
            .unwrap();
        }
        let text = if expected == "text_too_long" {
            "a".repeat(jt_inbox::public::INSTAGRAM_COMMENT_MAX + 1)
        } else {
            text.to_owned()
        };
        let ctx = if by_agent { &agent } else { &human };
        let before = sends(&r.meta).len() + sends(&r.trendyol).len();
        let e = replies::reply(
            &r.w.deps,
            ctx,
            taken.conversation_id,
            input(Some(taken.id), visibility, &text),
        )
        .await
        .unwrap_err();
        assert_eq!(reason(&e), expected, "{expected}");
        assert_eq!(
            sends(&r.meta).len() + sends(&r.trendyol).len(),
            before,
            "{expected}: no provider call"
        );
    }
    // The item of another conversation.
    let a = take(&r, &r.ig, comment("x1", "fan-a")).await;
    let b = take(&r, &r.ig, comment("x2", "fan-b")).await;
    let e = replies::reply(
        &r.w.deps,
        &human,
        a.conversation_id,
        public_reply(&b, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "item_not_in_conversation");
    // Every refusal is in the ledger, with its reason.
    let refused = r.w.entries("inbox.send.refused");
    assert_eq!(refused.len(), 14);
}

#[tokio::test]
async fn daily_ops_cap_counts_agent_public_replies() {
    let r = rig().await;
    let agent = agent(&r).await;
    edit_policy(&r, r.ig.id, |p| p.daily_ops_cap = Some(2));
    let items: Vec<_> = [
        ("1", "fan-1"),
        ("2", "fan-2"),
        ("3", "fan-3"),
        ("4", "fan-4"),
    ]
    .into_iter()
    .map(|(id, fan)| comment(id, fan))
    .collect();
    let mut taken = Vec::new();
    for env in items {
        taken.push(take(&r, &r.ig, env).await);
    }
    // One agent reply goes out, one stays uncertain: both count.
    r.meta.push_reply_public(accepted("r1"));
    r.meta
        .push_reply_public(Err(ConnectorError::unknown("timed out")));
    for item in &taken[..2] {
        replies::reply(
            &r.w.deps,
            &agent,
            item.conversation_id,
            public_reply(item, "Merhaba"),
        )
        .await
        .unwrap();
    }
    let e = replies::reply(
        &r.w.deps,
        &agent,
        taken[2].conversation_id,
        public_reply(&taken[2], "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "daily_ops_cap");
    // A human is not capped.
    r.meta.push_reply_public(accepted("r3"));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        taken[2].conversation_id,
        public_reply(&taken[2], "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    // Held replies count too: with approval on, a new day's two held drafts fill the cap.
    let r = rig().await;
    let agent = agent_at(&r, FIXED_NOW).await;
    edit_policy(&r, r.ig.id, |p| {
        p.daily_ops_cap = Some(1);
        p.requires_human_approval = true;
    });
    let a = take(&r, &r.ig, comment("1", "fan-1")).await;
    let b = take(&r, &r.ig, comment("2", "fan-2")).await;
    let out = replies::reply(
        &r.w.deps,
        &agent,
        a.conversation_id,
        public_reply(&a, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "held");
    let e = replies::reply(
        &r.w.deps,
        &agent,
        b.conversation_id,
        public_reply(&b, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "daily_ops_cap");
    // A cap of zero stops the agent's public replies (the kill switch of spec §11).
    edit_policy(&r, r.ig.id, |p| p.daily_ops_cap = Some(0));
    let e = replies::reply(
        &r.w.deps,
        &agent,
        b.conversation_id,
        public_reply(&b, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "daily_ops_cap");
}

async fn agent_at(r: &Rig, now: OffsetDateTime) -> jt_app::ctx::Ctx {
    at(&agent(r).await, now)
}

#[tokio::test]
async fn agent_answers_a_rejected_question_once_more() {
    let r = rig().await;
    let agent = agent(&r).await;
    let q = take(&r, &r.store, question("501")).await;
    for round in 0..2 {
        r.trendyol.push_reply_public(accepted(&format!("a{round}")));
        let out = replies::reply(
            &r.w.deps,
            &agent,
            q.conversation_id,
            public_reply(&q, "Evet, S beden stokta var."),
        )
        .await
        .unwrap();
        assert_eq!(out.state, "sent", "{round}");
        let pending = item(&r, "501");
        assert!(
            matches!(pending.answer, AnswerState::Pending { .. }),
            "{round}"
        );
        assert_eq!(pending.agent_answers, round + 1);
        // Trendyol refuses the answer in review.
        edit_item(&r, q.id, |i| {
            let AnswerState::Pending { message_id } = i.answer else {
                unreachable!()
            };
            i.answer = AnswerState::Rejected {
                reason: "uygun değil".into(),
                message_id: Some(message_id),
                at: FIXED_NOW,
            };
        });
    }
    // Twice refused: only a human answers it now.
    let e = replies::reply(
        &r.w.deps,
        &agent,
        q.conversation_id,
        public_reply(&q, "Evet, S beden stokta var."),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "agent_already_replied");
    r.trendyol.push_reply_public(accepted("a3"));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        q.conversation_id,
        public_reply(&q, "Evet, S beden stokta var."),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
}

#[tokio::test]
async fn fence_runs_again_at_claim() {
    let r = rig().await;
    let agent = agent(&r).await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    let replies::Enqueued::New(id) = replies::enqueue(
        &r.w.deps,
        &agent,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap() else {
        panic!("a new reply")
    };
    // Answered in the Instagram app between enqueue and claim.
    edit_item(&r, c1.id, |i| {
        i.answer = AnswerState::Answered {
            by: AnsweredBy::Elsewhere,
            message_id: None,
            at: FIXED_NOW,
        }
    });
    let out = replies::send_step(&r.w.deps, &agent, id).await.unwrap();
    assert_eq!(out.state, "refused");
    assert!(sends(&r.meta).is_empty());
    assert_eq!(
        message(&r, out.message_id).status,
        MsgStatus::Refused {
            reason: "item_not_owed".into()
        }
    );
}

// ---------------------------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------------------------

/// A held agent reply on a new comment of `rig`'s Instagram capability (approval on).
async fn held(r: &Rig, text: &str) -> (PublicItem, replies::ReplyOut, jt_app::ctx::Ctx) {
    edit_policy(r, r.ig.id, |p| p.requires_human_approval = true);
    let c1 = take(r, &r.ig, comment("1", FAN)).await;
    let agent = agent(r).await;
    let out = replies::reply(
        &r.w.deps,
        &agent,
        c1.conversation_id,
        public_reply(&c1, text),
    )
    .await
    .unwrap();
    (c1, out, agent)
}

#[tokio::test]
async fn agent_reply_is_held_when_capability_requires_approval() {
    let r = rig().await;
    let (c1, out, _) = held(&r, "Merhaba, DM attık").await;
    assert_eq!(out.state, "held");
    let row = outbox(&r, out.message_id);
    assert_eq!(row.state, "held");
    assert_eq!(row.intent["public"]["item_id"], json!(c1.id));
    assert_eq!(row.intent["public"]["visibility"], "public");
    assert_eq!(row.intent["public"]["drafted_by"]["kind"], "agent");
    assert_eq!(row.intent["public"]["target"]["external_id"], "1");
    assert_eq!(message(&r, out.message_id).status, MsgStatus::Queued);
    assert!(sends(&r.meta).is_empty());
    assert_eq!(r.w.entries("inbox.public.held").len(), 1);
    assert_eq!(item(&r, "1").answer, AnswerState::Awaiting);
}

#[tokio::test]
async fn human_reply_is_never_held() {
    let r = rig().await;
    edit_policy(&r, r.ig.id, |p| p.requires_human_approval = true);
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    r.meta.push_reply_public(accepted("r1"));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    assert!(r.w.entries("inbox.public.held").is_empty());
}

#[tokio::test]
async fn held_rows_are_never_claimed_or_recovered() {
    let r = rig().await;
    let (_, out, agent) = held(&r, "Merhaba").await;
    let row = outbox(&r, out.message_id);
    assert_eq!(
        replies::send_step(&r.w.deps, &agent, row.id)
            .await
            .unwrap()
            .state,
        "held"
    );
    let report =
        jt_app::usecases::jobs::run_outbox_recover(&r.w.deps, FIXED_NOW + Duration::hours(2)).await;
    assert_eq!(report.failed, 0);
    assert_eq!(outbox(&r, out.message_id).state, "held");
    assert!(sends(&r.meta).is_empty());
}

#[tokio::test]
async fn approve_by_human_sends_with_the_approver_as_author() {
    let r = rig().await;
    let (_, out, _) = held(&r, "Merhaba, DM attık").await;
    let row = outbox(&r, out.message_id);
    r.meta.push_reply_public(accepted("r1"));
    let approved = public::approve(
        &r.w.deps,
        &r.w.owner_ctx,
        row.id,
        public::ApproveInput::default(),
    )
    .await
    .unwrap();
    assert_eq!(approved.state, "sent");
    let sent = message(&r, out.message_id);
    assert_eq!(sent.author, Author::Human(r.w.owner));
    assert_eq!(sent.body, "Merhaba, DM attık");
    // The drafting agent stays on the intent.
    assert_eq!(
        outbox(&r, out.message_id).intent["public"]["drafted_by"]["kind"],
        "agent"
    );
    let entries = r.w.entries("inbox.public.approved");
    assert_eq!(entries.len(), 1);
    assert_eq!(payload(&entries[0])["edited"], false);
    // A human's answer: the agent has given none.
    let answered = item(&r, "1");
    assert!(matches!(
        answered.answer,
        AnswerState::Answered {
            by: AnsweredBy::Us,
            ..
        }
    ));
    assert_eq!(answered.agent_answers, 0);
}

#[tokio::test]
async fn approve_with_edit_replaces_the_text_and_refences() {
    let r = rig().await;
    let (_, out, _) = held(&r, "Merhaba").await;
    let row = outbox(&r, out.message_id);
    // The edited text is fenced: too long for Instagram.
    let e = public::approve(
        &r.w.deps,
        &r.w.owner_ctx,
        row.id,
        public::ApproveInput {
            text: Some("a".repeat(jt_inbox::public::INSTAGRAM_COMMENT_MAX + 1)),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "text_too_long");
    assert!(sends(&r.meta).is_empty());
    // A refused approval refuses the reply: the panel shows why.
    assert_eq!(outbox(&r, out.message_id).state, "refused");

    let r = rig().await;
    let (_, out, _) = held(&r, "Merhaba").await;
    let row = outbox(&r, out.message_id);
    r.meta.push_reply_public(accepted("r1"));
    let approved = public::approve(
        &r.w.deps,
        &r.w.owner_ctx,
        row.id,
        public::ApproveInput {
            text: Some("Merhaba! Detayları DM'den yazdık.".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(approved.state, "sent");
    assert_eq!(
        message(&r, out.message_id).body,
        "Merhaba! Detayları DM'den yazdık."
    );
    match &sends(&r.meta)[..] {
        [PublicCall::ReplyPublic { text, target, .. }] => {
            assert_eq!(text, "Merhaba! Detayları DM'den yazdık.");
            assert_eq!(target.external_id, "1");
        }
        calls => panic!("one public reply expected: {calls:?}"),
    }
    assert_eq!(
        payload(&r.w.entries("inbox.public.approved")[0])["edited"],
        true
    );
}

#[tokio::test]
async fn approve_refused_for_agents() {
    let r = rig().await;
    let (_, out, agent) = held(&r, "Merhaba").await;
    let row = outbox(&r, out.message_id);
    let e = public::approve(&r.w.deps, &agent, row.id, public::ApproveInput::default())
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "human_required");
    assert_eq!(outbox(&r, out.message_id).state, "held");
}

#[tokio::test]
async fn approve_refused_when_the_item_stopped_being_answerable() {
    let r = rig().await;
    let (c1, out, _) = held(&r, "Merhaba").await;
    edit_item(&r, c1.id, |i| i.moderation = Moderation::Removed);
    let row = outbox(&r, out.message_id);
    let e = public::approve(
        &r.w.deps,
        &r.w.owner_ctx,
        row.id,
        public::ApproveInput::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "item_removed");
    assert_eq!(outbox(&r, out.message_id).state, "refused");
    assert_eq!(
        message(&r, out.message_id).status,
        MsgStatus::Refused {
            reason: "item_removed".into()
        }
    );
    assert!(sends(&r.meta).is_empty());
}

#[tokio::test]
async fn discard_by_drafter_or_human_only() {
    let r = rig().await;
    let (_, out, drafter) = held(&r, "Merhaba").await;
    let row = outbox(&r, out.message_id);
    let other = agent(&r).await;
    let e = public::discard(&r.w.deps, &other, row.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "not_the_drafter");
    let discarded = public::discard(&r.w.deps, &drafter, row.id).await.unwrap();
    assert_eq!(discarded.state, "refused");
    assert_eq!(
        message(&r, out.message_id).status,
        MsgStatus::Refused {
            reason: "discarded".into()
        }
    );
    assert_eq!(r.w.entries("inbox.public.discarded").len(), 1);
    // A discarded reply is no longer held.
    let e = public::discard(&r.w.deps, &r.w.owner_ctx, row.id)
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Conflict);

    // A human discards an agent's draft.
    let r = rig().await;
    let (_, out, _) = held(&r, "Merhaba").await;
    let row = outbox(&r, out.message_id);
    assert_eq!(
        public::discard(&r.w.deps, &r.w.owner_ctx, row.id)
            .await
            .unwrap()
            .state,
        "refused"
    );
}

#[tokio::test]
async fn a_merge_refuses_a_held_reply_like_a_queued_one() {
    let r = rig().await;
    // The other commenter's conversation is the older one: it survives the merge.
    let c2 = take(&r, &r.ig, comment("2", "17841400000000010")).await;
    let (c1, out, _) = held(&r, "Merhaba").await;
    let person = |id: ConversationId| {
        r.w.uow
            .snapshot()
            .inbox
            .conversations
            .into_iter()
            .find(|c| c.id == id)
            .unwrap()
            .person_id
    };
    let (a, b) = (person(c1.conversation_id), person(c2.conversation_id));
    for p in [a, b] {
        jt_app::usecases::inbox::people::add_identity(
            &r.w.deps,
            &r.w.owner_ctx,
            p,
            serde_json::from_value(json!({"channel": "phone", "value": "05321234568"})).unwrap(),
        )
        .await
        .unwrap();
    }
    let suggestion = merge::list(&r.w.deps, &r.w.owner_ctx)
        .await
        .unwrap()
        .remove(0);
    // The held reply's conversation is coalesced into the older one.
    merge::apply(
        &r.w.deps,
        &r.w.owner_ctx,
        suggestion.id,
        merge::ApplyInput { keep: b },
    )
    .await
    .unwrap();
    let row = outbox(&r, out.message_id);
    assert_eq!(row.conversation_id, c2.conversation_id);
    assert_eq!(row.state, "refused");
    assert_eq!(row.last_error.as_deref(), Some("conversation_merged"));
    // Its refusal is ledgered with the merge, as a queued one's.
    let results = r.w.entries("inbox.reply.result");
    assert_eq!(results.len(), 1);
    assert_eq!(payload(&results[0])["state"], "refused");
    assert_eq!(payload(&results[0])["message_id"], json!(out.message_id));
    let _ = (a, c1);
}

// ---------------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn public_reply_receipt_answers_the_item() {
    let r = rig().await;
    let agent = agent(&r).await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    r.meta.push_reply_public(accepted("17900000000000077"));
    let out = replies::reply(
        &r.w.deps,
        &agent,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    let answered = item(&r, "1");
    assert_eq!(answered.agent_answers, 1);
    assert!(matches!(
        answered.answer,
        AnswerState::Answered { by: AnsweredBy::Us, message_id: Some(m), .. } if m == out.message_id
    ));
    assert_eq!(
        message(&r, out.message_id).external_id.as_deref(),
        Some("17900000000000077")
    );
    assert_eq!(
        conversation_state(&r, c1.conversation_id),
        ConvState::Theirs
    );
    match &sends(&r.meta)[..] {
        [
            PublicCall::ReplyPublic {
                target,
                public,
                credential,
                ..
            },
        ] => {
            assert_eq!(target.kind, PublicKind::Comment);
            assert_eq!(target.external_id, "1");
            assert_eq!(
                target.subject_external_id.as_deref(),
                Some("17900000000000001")
            );
            assert_eq!(public["external_id"], IG);
            assert!(matches!(credential, Credential::OAuth { .. }));
        }
        calls => panic!("one public reply expected: {calls:?}"),
    }
}

#[tokio::test]
async fn late_receipt_answers_a_handled_or_expired_item() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    // Marked handled while the reply was on its way: the receipt is a fact all the same.
    let uow = r.w.uow.clone();
    let id = c1.id;
    r.meta.push_hook(move || async move {
        uow.edit(|s| {
            let i = s
                .inbox
                .public_items
                .iter_mut()
                .find(|i| i.id == id)
                .unwrap();
            i.answer = AnswerState::Expired { at: FIXED_NOW };
        });
    });
    r.meta.push_reply_public(accepted("r1"));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    assert!(matches!(
        item(&r, "1").answer,
        AnswerState::Answered {
            by: AnsweredBy::Us,
            ..
        }
    ));
}

#[tokio::test]
async fn trendyol_answer_receipt_is_pending() {
    let r = rig().await;
    let q = take(&r, &r.store, question("501")).await;
    r.trendyol.push_reply_public(accepted("ans-1"));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        q.conversation_id,
        public_reply(&q, "Evet, S beden stokta var."),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    assert!(matches!(
        item(&r, "501").answer,
        AnswerState::Pending { message_id } if message_id == out.message_id
    ));
    // In review, not owed.
    assert_eq!(conversation_state(&r, q.conversation_id), ConvState::Theirs);
}

#[tokio::test]
async fn private_reply_marks_the_item_and_links_the_dm_identity() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    r.meta.push_reply_private(Ok(PrivateReceipt {
        provider_id: "m_PRIVATE-1".into(),
        recipient_id: Some("998877".into()),
    }));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        input(Some(c1.id), Some("private"), "Fiyatı DM'den yazdık"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    let replied = item(&r, "1");
    assert_eq!(replied.private_reply_message_id, Some(out.message_id));
    // Still owed publicly: a private reply is not the public answer.
    assert_eq!(replied.answer, AnswerState::Awaiting);
    assert_eq!(
        message(&r, out.message_id).external_id.as_deref(),
        Some("m_PRIVATE-1")
    );
    let s = r.w.uow.snapshot().inbox;
    let person = s
        .conversations
        .iter()
        .find(|c| c.id == c1.conversation_id)
        .unwrap()
        .person_id;
    assert!(s.identities.iter().any(|i| i.person_id == person
        && i.channel == IdentityChannel::InstagramDm
        && i.value_normalized == format!("{IG}:998877")));
    let linked = r.w.entries("inbox.public.identity_linked");
    assert_eq!(linked.len(), 1);
    assert!(!wire(&linked).contains("998877"));
    assert!(matches!(
        &sends(&r.meta)[..],
        [PublicCall::ReplyPrivate { .. }]
    ));
}

#[tokio::test]
async fn private_reply_identity_collision_suggests_a_merge() {
    let r = rig().await;
    let dm = capability(&r.w, "instagram_dm", IG, IG_COMMENTS).await;
    // The commenter already wrote a direct message: another person holds that identity.
    let other = jt_app::usecases::inbox::people::create(
        &r.w.deps,
        &r.w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "DM person",
            "identities": [{"channel": "instagram_dm", "value": "998877", "capability_id": dm.id}],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    r.meta.push_reply_private(Ok(PrivateReceipt {
        provider_id: "m_PRIVATE-1".into(),
        recipient_id: Some("998877".into()),
    }));
    replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        input(Some(c1.id), Some("private"), "Fiyatı DM'den yazdık"),
    )
    .await
    .unwrap();
    let suggestions = merge::list(&r.w.deps, &r.w.owner_ctx).await.unwrap();
    assert_eq!(suggestions.len(), 1);
    assert!([suggestions[0].source_id, suggestions[0].target_id].contains(&other.id));
    // The identity stays with the person who held it.
    let s = r.w.uow.snapshot().inbox;
    let holders: Vec<_> = s
        .identities
        .iter()
        .filter(|i| i.channel == IdentityChannel::InstagramDm)
        .map(|i| i.person_id)
        .collect();
    assert_eq!(holders, [other.id]);
}

#[tokio::test]
async fn removed_item_error_marks_removed_and_fails_the_send() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    r.meta
        .push_reply_public(Err(ConnectorError::permanent(PUBLIC_ITEM_GONE)));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "failed");
    let row = outbox(&r, out.message_id);
    assert_eq!(row.last_error.as_deref(), Some("item_removed"));
    let gone = item(&r, "1");
    assert_eq!(gone.moderation, Moderation::Removed);
    assert!(!gone.awaiting());
    assert_eq!(
        conversation_state(&r, c1.conversation_id),
        ConvState::Theirs
    );
}

#[tokio::test]
async fn unknown_is_never_resent() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    r.meta
        .push_reply_public(Err(ConnectorError::unknown("timed out")));
    let out = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "unknown");
    let row = outbox(&r, out.message_id);
    assert_eq!(
        replies::send_step(&r.w.deps, &r.w.owner_ctx, row.id)
            .await
            .unwrap()
            .state,
        "unknown"
    );
    jt_app::usecases::jobs::run_outbox_recover(&r.w.deps, FIXED_NOW + Duration::hours(2)).await;
    assert_eq!(sends(&r.meta).len(), 1);
    assert_eq!(item(&r, "1").answer, AnswerState::Awaiting);
}

#[tokio::test]
async fn replied_applies_only_with_a_journey() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    r.meta.push_reply_public(accepted("r1"));
    replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    let s = r.w.uow.snapshot().inbox;
    assert!(s.journeys.is_empty() && s.events.is_empty());
    // A commenter with a journey (buying intent shown) is contacted by a public reply.
    let c2 = take(&r, &r.ig, comment("2", FAN)).await;
    let person = s
        .conversations
        .iter()
        .find(|c| c.id == c1.conversation_id)
        .unwrap()
        .person_id;
    jt_app::usecases::inbox::journeys::open(&r.w.deps, &r.w.owner_ctx, person)
        .await
        .unwrap();
    r.meta.push_reply_public(accepted("r2"));
    replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c2.conversation_id,
        public_reply(&c2, "Merhaba"),
    )
    .await
    .unwrap();
    let s = r.w.uow.snapshot().inbox;
    assert!(s.events.iter().any(|e| e.kind == JourneyEventKind::Replied));
}

#[tokio::test]
async fn state_stays_ours_while_another_item_is_owed() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    take(&r, &r.ig, comment("2", FAN)).await;
    r.meta.push_reply_public(accepted("r1"));
    replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(conversation_state(&r, c1.conversation_id), ConvState::Ours);
    let _: Value = json!({});
}

// ---------------------------------------------------------------------------------------------
// Replies in flight (spec D19)
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_reply_in_flight_refuses_another_on_the_same_item() {
    let r = rig().await;
    let agent = agent(&r).await;
    let c1 = take(&r, &r.ig, comment("1", FAN)).await;
    // A: the agent's reply timed out. Uncertain, it counts as answered for the agent.
    r.meta
        .push_reply_public(Err(ConnectorError::unknown("timed out")));
    let out = replies::reply(
        &r.w.deps,
        &agent,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "unknown");
    let e = replies::reply(
        &r.w.deps,
        &agent,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "reply_in_flight");
    assert_eq!(sends(&r.meta).len(), 1);
    // A human, who can look at the platform, may still answer it.
    r.meta.push_reply_public(accepted("r1"));
    let human = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        public_reply(&c1, "Merhaba, yanıtımız ulaştı mı?"),
    )
    .await
    .unwrap();
    assert_eq!(human.state, "sent");

    // B: two replies before either is sent: the second is refused, whoever sends it.
    let c2 = take(&r, &r.ig, comment("2", "fan-2")).await;
    let replies::Enqueued::New(first) = replies::enqueue(
        &r.w.deps,
        &r.w.owner_ctx,
        c2.conversation_id,
        public_reply(&c2, "Merhaba"),
    )
    .await
    .unwrap() else {
        panic!("a new reply")
    };
    for ctx in [&r.w.owner_ctx, &agent] {
        let e = replies::reply(
            &r.w.deps,
            ctx,
            c2.conversation_id,
            public_reply(&c2, "Tekrar merhaba"),
        )
        .await
        .unwrap_err();
        assert_eq!(reason(&e), "reply_in_flight");
    }
    // The first one is not in its own way at claim.
    r.meta.push_reply_public(accepted("r2"));
    assert_eq!(
        replies::send_step(&r.w.deps, &r.w.owner_ctx, first)
            .await
            .unwrap()
            .state,
        "sent"
    );

    // A private reply in flight refuses another private one, not a public one.
    let c3 = take(&r, &r.ig, comment("3", "fan-3")).await;
    replies::enqueue(
        &r.w.deps,
        &r.w.owner_ctx,
        c3.conversation_id,
        input(Some(c3.id), Some("private"), "DM'den yazdık"),
    )
    .await
    .unwrap();
    let e = replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c3.conversation_id,
        input(Some(c3.id), Some("private"), "DM'den yine yazdık"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "reply_in_flight");
    r.meta.push_reply_public(accepted("r3"));
    assert_eq!(
        replies::reply(
            &r.w.deps,
            &r.w.owner_ctx,
            c3.conversation_id,
            public_reply(&c3, "Merhaba"),
        )
        .await
        .unwrap()
        .state,
        "sent"
    );
}

#[tokio::test]
async fn a_held_reply_refuses_another_and_its_own_approval_goes() {
    let r = rig().await;
    let (c1, out, agent) = held(&r, "Merhaba").await;
    // Another reply on the item, while one waits for approval.
    let e = replies::reply(
        &r.w.deps,
        &agent,
        c1.conversation_id,
        public_reply(&c1, "Merhaba"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "reply_in_flight");
    // The held one's approval is not in its own way.
    let row = outbox(&r, out.message_id);
    r.meta.push_reply_public(accepted("r1"));
    let approved = public::approve(
        &r.w.deps,
        &r.w.owner_ctx,
        row.id,
        public::ApproveInput::default(),
    )
    .await
    .unwrap();
    assert_eq!(approved.state, "sent");
}
