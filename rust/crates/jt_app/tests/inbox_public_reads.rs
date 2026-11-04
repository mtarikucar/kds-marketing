//! Reads, pending work and deadlines of public conversations (plan
//! 2026-10-30-inbox-comments-marketplace-plan.md, task F8; spec §3.11, §6.8): the public part of
//! `inbox.context`, the conversation views, the item a message is, `inbox.pending`'s due items
//! and approvals, `work.pending`'s deadline, approval and comment items, and the response SLA's
//! public cases. Items are taken in through the consumer; the providers are scripted.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{
    EnvelopeAuthor, EnvelopeStatus, EnvelopeSubject, PublicEnvelope, SendReceipt,
};
use jt_app::usecases::inbox::{consumer, context, conversations, people, replies};
use jt_app::usecases::{connector, jobs, work};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig, ScriptedPublic, ScriptedRegistry};
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};

const IG: &str = "17841400000000001";
const SELLER: &str = "123456";
const IG_COMMENTS: &[&str] = &[
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_manage_messages",
];

struct Rig {
    w: World,
    meta: Arc<ScriptedPublic>,
    ig: Capability,
    store: Capability,
    tick: AtomicI64,
}

async fn rig() -> Rig {
    rig_with(true).await
}

async fn rig_with(comment_flag: bool) -> Rig {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let mut apps = FakeAppConfig::with_all_apps();
    apps.meta.as_mut().unwrap().comment_scopes = comment_flag;
    apps.instagram.as_mut().unwrap().comment_scopes = comment_flag;
    w.deps.apps = Arc::new(apps);
    let meta = Arc::new(ScriptedPublic::new(Provider::Meta));
    let trendyol = Arc::new(ScriptedPublic::new(Provider::Trendyol));
    w.deps.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_public(meta.clone())
            .with_public(trendyol),
    );
    let ig = capability(&w, "instagram", IG, IG_COMMENTS).await;
    let store = capability(&w, "trendyol", SELLER, &[]).await;
    Rig {
        w,
        meta,
        ig,
        store,
        tick: AtomicI64::new(0),
    }
}

async fn capability(w: &World, kind: &str, account: &str, scopes: &[&str]) -> Capability {
    let (public, credential) = match kind {
        "trendyol" => (
            json!({"provider": "trendyol", "access": {"kind": "trendyol_seller", "seller_id": SELLER}}),
            Credential::TrendyolSeller {
                seller_id: SELLER.into(),
                api_key: "ty-key".into(),
                api_secret: "ty-secret".into(),
            },
        ),
        _ => (
            json!({"provider": "meta", "access": {"kind": "oauth", "app": "meta", "scopes": scopes}}),
            Credential::OAuth {
                access_token: "EAAB-test-token".into(),
                refresh_token: None,
                expires_at: None,
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        ),
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

fn comment(id: &str, author: &str, created_at: OffsetDateTime) -> PublicEnvelope {
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
        text: format!("Fiyatı nedir? ({id})"),
        created_at,
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

fn question(id: &str, customer: &str, deadline: Option<OffsetDateTime>) -> PublicEnvelope {
    PublicEnvelope {
        kind: PublicKind::Question,
        account_id: SELLER.into(),
        external_id: id.into(),
        root_external_id: id.into(),
        author: EnvelopeAuthor {
            id: Some(customer.into()),
            name: None,
            is_self: false,
        },
        text: "Bu ürünün S bedeni var mı?".into(),
        deadline,
        subject: Some(EnvelopeSubject {
            kind: SubjectKind::Product,
            external_id: "PRD-1".into(),
            title: "Boyama seti".into(),
            url: None,
            image_url: None,
            facts: json!({}),
        }),
        ..comment(id, "x", FIXED_NOW - Duration::minutes(10))
    }
}

/// Takes `env` in on `cap` through the consumer; the item.
async fn take(r: &Rig, cap: &Capability, env: PublicEnvelope) -> PublicItem {
    let tick = r.tick.fetch_add(1, Ordering::Relaxed);
    take_at(
        r,
        cap,
        env,
        FIXED_NOW - Duration::minutes(5) + Duration::seconds(tick),
    )
    .await
}

/// [`take`], the event stored at `received_at` (and consumed a second later).
async fn take_at(
    r: &Rig,
    cap: &Capability,
    env: PublicEnvelope,
    received_at: OffsetDateTime,
) -> PublicItem {
    let external_id = env.external_id.clone();
    let provider = jt_connector::provider_for_kind(&cap.kind_key).unwrap();
    let kind = match env.kind {
        PublicKind::Comment => EventKind::Comment,
        PublicKind::Question => EventKind::Question,
    };
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: r.w.ws,
        provider,
        capability_id: Some(cap.id),
        external_id: format!("event:{external_id}"),
        kind,
        payload: env.into_payload(json!({})),
        received_at,
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
        consumer::consume_event(&r.w.deps, &event, received_at + Duration::seconds(1))
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

fn reply_to(item: &PublicItem, text: &str) -> replies::ReplyInput {
    serde_json::from_value(json!({"text": text, "intent": "reply", "item_id": item.id})).unwrap()
}

fn accepted(id: &str) -> Result<SendReceipt, ConnectorError> {
    Ok(SendReceipt {
        provider_id: id.into(),
        cost_minor: None,
    })
}

fn require_approval(r: &Rig, id: CapabilityId) {
    r.w.uow.edit(|s| {
        s.capabilities
            .iter_mut()
            .find(|c| c.capability.id == id)
            .unwrap()
            .capability
            .policy
            .requires_human_approval = true;
    });
}

async fn context_json(r: &Rig, ctx: &jt_app::ctx::Ctx, id: ConversationId) -> Value {
    serde_json::to_value(context::context(&r.w.deps, ctx, id).await.unwrap()).unwrap()
}

fn kinds(items: &[work::WorkItem]) -> Vec<Value> {
    items
        .iter()
        .map(|i| serde_json::to_value(i).unwrap())
        .collect()
}

// ---------------------------------------------------------------------------------------------
// inbox.context
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn context_of_a_comment_conversation_has_items_subjects_threads_rules_and_hint() {
    let r = rig().await;
    let c1 = take(
        &r,
        &r.ig,
        comment("1", "fan-1", FIXED_NOW - Duration::minutes(10)),
    )
    .await;
    // Another commenter answers under the same comment.
    let mut under = comment("2", "fan-2", FIXED_NOW - Duration::minutes(8));
    under.parent_external_id = Some("1".into());
    under.root_external_id = "1".into();
    take(&r, &r.ig, under).await;
    let out = context_json(&r, &r.w.owner_ctx, c1.conversation_id).await;
    let public = &out["public"];
    assert_eq!(public["channel"], "instagram_comment");
    assert_eq!(
        public["rules"]["public"]["max"],
        jt_inbox::public::INSTAGRAM_COMMENT_MAX
    );
    assert_eq!(public["rules"]["marketplace"], false);
    assert_eq!(public["rules"]["hide"], true);
    assert!(public["rules"]["private"]["window_s"].as_i64().unwrap() > 0);
    assert_eq!(public["approval_required"], false);
    assert!(public["hint"].as_str().unwrap().contains("journey"));
    let items = public["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    let first = &items[0];
    assert_eq!(first["item"]["id"], json!(c1.id));
    assert_eq!(first["owed"], true);
    assert_eq!(first["subject"]["title"], "Yeni sezon");
    assert!(first["private_reply_until"].is_string());
    let thread = first["thread"].as_array().unwrap();
    assert_eq!(
        thread
            .iter()
            .map(|t| (t["author"].as_str().unwrap(), t["text"].as_str().unwrap()))
            .collect::<Vec<_>>(),
        [
            ("them", "Fiyatı nedir? (1)"),
            ("other", "Fiyatı nedir? (2)")
        ]
    );
    // Our answer joins the thread, and the item is no longer owed.
    r.meta.push_reply_public(accepted("r1"));
    replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        reply_to(&c1, "Merhaba, DM'den yazdık."),
    )
    .await
    .unwrap();
    let out = context_json(&r, &r.w.owner_ctx, c1.conversation_id).await;
    let first = &out["public"]["items"][0];
    assert_eq!(first["owed"], false);
    let authors: Vec<_> = first["thread"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["author"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(authors, ["them", "other", "us"]);
}

#[tokio::test]
async fn context_of_a_question_has_the_deadline_and_the_marketplace_rules() {
    let r = rig().await;
    require_approval(&r, r.store.id);
    let deadline = FIXED_NOW + Duration::hours(20);
    let q = take(&r, &r.store, question("q-1", "cust-1", Some(deadline))).await;
    let out = context_json(&r, &r.w.owner_ctx, q.conversation_id).await;
    let public = &out["public"];
    assert_eq!(public["channel"], "trendyol_question");
    assert_eq!(public["rules"]["marketplace"], true);
    assert_eq!(public["rules"]["one_answer"], true);
    assert!(public["rules"]["private"].is_null());
    assert_eq!(public["approval_required"], true);
    let first = &public["items"][0];
    assert_eq!(
        first["item"]["deadline"],
        json!(
            deadline
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        )
    );
    assert!(first["private_reply_until"].is_null());
    assert_eq!(first["subject"]["kind"], "product");
}

#[tokio::test]
async fn context_of_a_dm_has_no_public_part() {
    let r = rig().await;
    let p = people::create(
        &r.w.deps,
        &r.w.owner_ctx,
        serde_json::from_value(json!({"display_name":"Ada",
            "identities":[{"channel":"phone","value":"05321234567"}],"source":"form"}))
        .unwrap(),
    )
    .await
    .unwrap();
    let sms = r.w.declare("sms_line", "SMS").await;
    let id = ConversationId::new_v7();
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    t.conversations()
        .upsert_on_inbound(Conversation {
            id,
            workspace_id: r.w.ws,
            person_id: p.person.id,
            capability_id: sms.capability.id,
            kind_key: "sms_line".into(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(FIXED_NOW),
            last_outbound_at: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    let out = context_json(&r, &r.w.owner_ctx, id).await;
    assert!(out.get("public").is_none(), "{out}");
    let view = serde_json::to_value(
        conversations::get(&r.w.deps, &r.w.owner_ctx, id)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(view["surface"], "private");
    assert_eq!(view["owed_items"], 0);
    assert_eq!(view["held_replies"], 0);
}

// ---------------------------------------------------------------------------------------------
// Conversation views and messages
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn conversation_view_has_surface_owed_items_next_deadline_and_held_replies() {
    let r = rig().await;
    require_approval(&r, r.store.id);
    let (soon, later) = (
        FIXED_NOW + Duration::hours(3),
        FIXED_NOW + Duration::hours(30),
    );
    let q1 = take(&r, &r.store, question("q-1", "cust-1", Some(later))).await;
    take(&r, &r.store, question("q-2", "cust-1", Some(soon))).await;
    let agent = r.w.agent(&["inbox.work"]).await;
    let out = replies::reply(
        &r.w.deps,
        &agent,
        q1.conversation_id,
        reply_to(&q1, "Evet, S bedeni var."),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "held");
    let view = serde_json::to_value(
        conversations::get(&r.w.deps, &r.w.owner_ctx, q1.conversation_id)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(view["id"], json!(q1.conversation_id));
    assert_eq!(view["surface"], "public");
    assert_eq!(view["channel"], "trendyol_question");
    assert_eq!(view["owed_items"], 2);
    assert_eq!(view["held_replies"], 1);
    assert_eq!(
        view["next_deadline"],
        json!(
            soon.format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        )
    );
    // The list answers the same views.
    let page = serde_json::to_value(
        conversations::list(
            &r.w.deps,
            &r.w.owner_ctx,
            serde_json::from_value(json!({"queue": "all"})).unwrap(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let listed = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == json!(q1.conversation_id))
        .unwrap()
        .clone();
    assert_eq!(listed, view);
}

#[tokio::test]
async fn messages_list_marks_item_messages() {
    let r = rig().await;
    let c1 = take(
        &r,
        &r.ig,
        comment("1", "fan-1", FIXED_NOW - Duration::minutes(10)),
    )
    .await;
    r.meta.push_reply_public(accepted("r1"));
    replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        reply_to(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    let page = serde_json::to_value(
        conversations::messages(
            &r.w.deps,
            &r.w.owner_ctx,
            c1.conversation_id,
            Default::default(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let inbound = items.iter().find(|m| m["direction"] == "inbound").unwrap();
    assert_eq!(inbound["item"]["item_id"], json!(c1.id));
    assert_eq!(inbound["item"]["kind"], "comment");
    assert_eq!(inbound["item"]["answer_state"], "answered");
    assert!(inbound["item"]["visibility"].is_null());
    let ours = items.iter().find(|m| m["direction"] == "outbound").unwrap();
    assert_eq!(ours["item"]["item_id"], json!(c1.id));
    assert_eq!(ours["item"]["visibility"], "public");
}

// ---------------------------------------------------------------------------------------------
// inbox.pending and work.pending
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn pending_lists_public_due_and_approvals() {
    let r = rig().await;
    require_approval(&r, r.store.id);
    let deadline = FIXED_NOW + Duration::hours(5);
    let q1 = take(&r, &r.store, question("q-1", "cust-1", Some(deadline))).await;
    let q2 = take(&r, &r.store, question("q-2", "cust-2", None)).await;
    let agent = r.w.agent(&["inbox.work"]).await;
    let held = replies::reply(
        &r.w.deps,
        &agent,
        q2.conversation_id,
        reply_to(&q2, "Evet, S bedeni stokta var."),
    )
    .await
    .unwrap();
    assert_eq!(held.state, "held");
    // The agent holds both conversations: it sees their owed items, and no approval.
    let mine = serde_json::to_value(context::pending(&r.w.deps, &agent).await.unwrap()).unwrap();
    let due = mine["public_due"].as_array().unwrap();
    assert_eq!(due.len(), 2);
    let first = due.iter().find(|d| d["item_id"] == json!(q1.id)).unwrap();
    assert_eq!(first["conversation_id"], json!(q1.conversation_id));
    assert_eq!(first["channel"], "trendyol_question");
    assert!(first["awaiting_since"].is_string());
    assert!(first["deadline"].is_string());
    assert!(mine["approvals"].as_array().unwrap().is_empty());
    // A human approves: the held reply is theirs to see.
    let theirs =
        serde_json::to_value(context::pending(&r.w.deps, &r.w.owner_ctx).await.unwrap()).unwrap();
    let approvals = theirs["approvals"].as_array().unwrap();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0]["conversation_id"], json!(q2.conversation_id));
    assert_eq!(approvals[0]["item_id"], json!(q2.id));
    assert!(approvals[0]["outbox_id"].is_string());
}

#[tokio::test]
async fn work_answer_deadline_within_24h_sorted_by_urgency() {
    let r = rig().await;
    let in_5h = FIXED_NOW + Duration::hours(5);
    let in_2h = FIXED_NOW + Duration::hours(2);
    let q5 = take(&r, &r.store, question("q-5", "cust-5", Some(in_5h))).await;
    let q2 = take(&r, &r.store, question("q-2", "cust-2", Some(in_2h))).await;
    take(
        &r,
        &r.store,
        question("q-48", "cust-48", Some(FIXED_NOW + Duration::hours(48))),
    )
    .await;
    let agent = r.w.agent(&["inbox.work", "workspace.read"]).await;
    let out = work::pending(&r.w.deps, &agent).await.unwrap();
    let deadlines: Vec<Value> = kinds(&out.items)
        .into_iter()
        .filter(|k| k["kind"] == "answer_deadline")
        .collect();
    assert_eq!(
        deadlines
            .iter()
            .map(|k| k["item_id"].clone())
            .collect::<Vec<_>>(),
        [json!(q2.id), json!(q5.id)]
    );
    assert_eq!(deadlines[0]["conversation_id"], json!(q2.conversation_id));
    let first = out
        .items
        .iter()
        .find(|i| matches!(i.kind, work::WorkKind::AnswerDeadline { .. }))
        .unwrap();
    assert_eq!(first.priority, 1);
}

#[tokio::test]
async fn work_approve_reply_for_humans_only() {
    let r = rig().await;
    require_approval(&r, r.store.id);
    let q = take(&r, &r.store, question("q-1", "cust-1", None)).await;
    let agent = r.w.agent(&["inbox.work", "workspace.read"]).await;
    replies::reply(
        &r.w.deps,
        &agent,
        q.conversation_id,
        reply_to(&q, "Evet, S bedeni stokta var."),
    )
    .await
    .unwrap();
    let human = work::pending(&r.w.deps, &r.w.owner_ctx).await.unwrap();
    let approvals: Vec<Value> = kinds(&human.items)
        .into_iter()
        .filter(|k| k["kind"] == "approve_reply")
        .collect();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0]["conversation_id"], json!(q.conversation_id));
    let agents = work::pending(&r.w.deps, &agent).await.unwrap();
    assert!(
        kinds(&agents.items)
            .iter()
            .all(|k| k["kind"] != "approve_reply")
    );
}

#[tokio::test]
async fn work_enable_comments_when_flag_on_and_grant_missing() {
    for flag in [true, false] {
        let r = rig_with(flag).await;
        // A second Instagram account whose grant lacks the comment scopes.
        let bare = capability(&r.w, "instagram", "17841400000000002", &["instagram_basic"]).await;
        let out = work::pending(&r.w.deps, &r.w.owner_ctx).await.unwrap();
        let enable: Vec<Value> = kinds(&out.items)
            .into_iter()
            .filter(|k| k["kind"] == "enable_comments")
            .collect();
        if flag {
            assert_eq!(enable.len(), 1, "{enable:?}");
            assert_eq!(enable[0]["capability_id"], json!(bare.id));
        } else {
            assert!(enable.is_empty(), "{enable:?}");
        }
    }
}

#[tokio::test]
async fn health_shows_each_surface_its_comment_status() {
    for flag in [true, false] {
        let r = rig_with(flag).await;
        let bare = capability(&r.w, "instagram", "17841400000000002", &["instagram_basic"]).await;
        let mailbox = r.w.declare("mailbox", "Kutu").await.capability;
        let health =
            serde_json::to_value(connector::health(&r.w.deps, &r.w.owner_ctx).await.unwrap())
                .unwrap();
        let comments = |id: CapabilityId| {
            health
                .as_array()
                .unwrap()
                .iter()
                .find(|h| h["capability_id"] == json!(id))
                .map(|h| h["comments"].clone())
                .unwrap()
        };
        // Meta's: off until the platform flag is on (Meta's approval), then per grant.
        let (granted, lacking) = if flag {
            ("on", "reconnect")
        } else {
            ("off", "off")
        };
        assert_eq!(comments(r.ig.id), json!(granted), "flag {flag}");
        assert_eq!(comments(bare.id), json!(lacking), "flag {flag}");
        // A marketplace's questions are always taken; a kind without comments has no status.
        assert_eq!(comments(r.store.id), json!("on"));
        assert_eq!(comments(mailbox.id), Value::Null);
    }
}

// ---------------------------------------------------------------------------------------------
// The response SLA
// ---------------------------------------------------------------------------------------------

fn executor(r: &Rig, id: ConversationId) -> Executor {
    r.w.uow
        .snapshot()
        .inbox
        .conversations
        .into_iter()
        .find(|c| c.id == id)
        .unwrap()
        .executor
}

#[tokio::test]
async fn sla_uses_the_oldest_owed_item() {
    let r = rig().await;
    // An old comment still owed and a fresh one: the old one sets the clock.
    let old = take_at(
        &r,
        &r.ig,
        comment("1", "fan-1", FIXED_NOW - Duration::hours(2)),
        FIXED_NOW - Duration::hours(2),
    )
    .await;
    take(
        &r,
        &r.ig,
        comment("2", "fan-1", FIXED_NOW - Duration::minutes(1)),
    )
    .await;
    assert_eq!(executor(&r, old.conversation_id), Executor::Agent);
    let report = jobs::run_response_sla(&r.w.deps, FIXED_NOW).await;
    assert_eq!(report.changed, 1);
    assert_eq!(
        executor(&r, old.conversation_id),
        Executor::Human { user_id: None }
    );
    // Answered, the old one no longer counts: a fresh conversation is left to the agent.
    let r = rig().await;
    let c1 = take_at(
        &r,
        &r.ig,
        comment("1", "fan-1", FIXED_NOW - Duration::hours(2)),
        FIXED_NOW - Duration::hours(2),
    )
    .await;
    take(
        &r,
        &r.ig,
        comment("2", "fan-1", FIXED_NOW - Duration::minutes(1)),
    )
    .await;
    r.meta.push_reply_public(accepted("r1"));
    replies::reply(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.conversation_id,
        reply_to(&c1, "Merhaba"),
    )
    .await
    .unwrap();
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, FIXED_NOW).await.changed,
        0
    );
    assert_eq!(executor(&r, c1.conversation_id), Executor::Agent);
}

#[tokio::test]
async fn sla_hands_over_two_hours_before_a_deadline() {
    let r = rig().await;
    let mut fresh = question("q-1", "cust-1", Some(FIXED_NOW + Duration::minutes(90)));
    fresh.created_at = FIXED_NOW - Duration::minutes(1);
    let q = take(&r, &r.store, fresh).await;
    let mut calm = question("q-2", "cust-2", Some(FIXED_NOW + Duration::hours(5)));
    calm.created_at = FIXED_NOW - Duration::minutes(1);
    let other = take(&r, &r.store, calm).await;
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, FIXED_NOW).await.changed,
        1
    );
    assert_eq!(
        executor(&r, q.conversation_id),
        Executor::Human { user_id: None }
    );
    assert_eq!(executor(&r, other.conversation_id), Executor::Agent);
    let lines = r.w.entries("inbox.public.deadline_handover");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].payload["item_id"], json!(q.id));
    // Once handed over, nothing more.
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, FIXED_NOW).await.changed,
        0
    );
}

#[tokio::test]
async fn sla_expires_items_past_their_deadline() {
    let r = rig().await;
    let q = take(
        &r,
        &r.store,
        question("q-1", "cust-1", Some(FIXED_NOW + Duration::minutes(30))),
    )
    .await;
    let later = FIXED_NOW + Duration::hours(1);
    jobs::run_response_sla(&r.w.deps, later).await;
    assert!(matches!(
        item(&r, "q-1").answer,
        AnswerState::Expired { .. }
    ));
    let lines = r.w.entries("inbox.public.expired");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].payload["item_id"], json!(q.id));
    let state =
        r.w.uow
            .snapshot()
            .inbox
            .conversations
            .into_iter()
            .find(|c| c.id == q.conversation_id)
            .unwrap()
            .state;
    assert_eq!(state, ConvState::Theirs);
    // Expired once.
    jobs::run_response_sla(&r.w.deps, later).await;
    assert_eq!(r.w.entries("inbox.public.expired").len(), 1);
}

#[tokio::test]
async fn sla_maps_relay_mail_to_amazon() {
    let r = rig().await;
    let mail = r.w.declare("mailbox", "Mail").await;
    let mut ids = Vec::new();
    for email in ["buyer-1@marketplace.amazon.com.tr", "ada@example.com"] {
        let p = people::create(
            &r.w.deps,
            &r.w.owner_ctx,
            serde_json::from_value(json!({"display_name":"Buyer",
                "identities":[{"channel":"email","value":email}],"source":"form"}))
            .unwrap(),
        )
        .await
        .unwrap();
        let id = ConversationId::new_v7();
        let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
        t.conversations()
            .upsert_on_inbound(Conversation {
                id,
                workspace_id: r.w.ws,
                person_id: p.person.id,
                capability_id: mail.capability.id,
                kind_key: "mailbox".into(),
                state: ConvState::Ours,
                executor: Executor::Agent,
                executor_generation: 0,
                last_inbound_at: Some(FIXED_NOW - Duration::hours(2)),
                last_outbound_at: None,
                created_at: FIXED_NOW - Duration::hours(2),
                updated_at: FIXED_NOW - Duration::hours(2),
            })
            .await
            .unwrap();
        t.commit().await.unwrap();
        ids.push(id);
    }
    // Relay mail answers within Amazon's hour; other mail has no response time.
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, FIXED_NOW).await.changed,
        1
    );
    let relay = conversations::get(&r.w.deps, &r.w.owner_ctx, ids[0])
        .await
        .unwrap();
    assert_eq!(relay.executor, Executor::Human { user_id: None });
    assert_eq!(serde_json::to_value(&relay).unwrap()["surface"], "relay");
    assert_eq!(executor(&r, ids[1]), Executor::Agent);
}

#[tokio::test]
async fn sla_defaults_apply_to_stored_policies() {
    let r = rig().await;
    // A policy stored before the public surfaces had response times.
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    let mut policy = t.workspace_policy().get().await.unwrap();
    policy.inbox.max_response_s = [("sms".to_owned(), 60)].into_iter().collect();
    t.workspace_policy().set(policy, FIXED_NOW).await.unwrap();
    t.commit().await.unwrap();
    let mut old = question("q-1", "cust-1", None);
    old.created_at = FIXED_NOW - Duration::hours(2);
    let q = take_at(&r, &r.store, old, FIXED_NOW - Duration::hours(2)).await;
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, FIXED_NOW).await.changed,
        1
    );
    assert_eq!(
        executor(&r, q.conversation_id),
        Executor::Human { user_id: None }
    );
}

#[tokio::test]
async fn sla_clock_starts_when_the_item_is_taken_in() {
    let r = rig().await;
    // Written two hours ago, it reaches the inbox only now (a backfill, a late webhook).
    let taken = FIXED_NOW - Duration::minutes(1);
    let late = take_at(
        &r,
        &r.ig,
        comment("1", "fan-1", FIXED_NOW - Duration::hours(2)),
        taken,
    )
    .await;
    assert_eq!(late.taken_at, Some(taken));
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, FIXED_NOW).await.changed,
        0
    );
    assert_eq!(executor(&r, late.conversation_id), Executor::Agent);
    // An hour after it was taken in, it is overdue.
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, taken + Duration::minutes(61))
            .await
            .changed,
        1
    );
}

#[tokio::test]
async fn sla_leaves_an_item_whose_answer_waits_for_approval() {
    let r = rig().await;
    require_approval(&r, r.store.id);
    // Overdue and due within two hours, but the agent's answer only waits for a human now.
    let two_hours_ago = FIXED_NOW - Duration::hours(2);
    let mut old = question("q-1", "cust-1", Some(FIXED_NOW + Duration::minutes(90)));
    old.created_at = two_hours_ago;
    let q = take_at(&r, &r.store, old, two_hours_ago).await;
    let agent = r.w.agent(&["inbox.work"]).await;
    let held = replies::reply(
        &r.w.deps,
        &agent,
        q.conversation_id,
        reply_to(&q, "Evet, S bedeni stokta var."),
    )
    .await
    .unwrap();
    assert_eq!(held.state, "held");
    assert_eq!(
        jobs::run_response_sla(&r.w.deps, FIXED_NOW).await.changed,
        0
    );
    assert_eq!(executor(&r, q.conversation_id), Executor::Agent);
    assert!(r.w.entries("inbox.public.deadline_handover").is_empty());
}
