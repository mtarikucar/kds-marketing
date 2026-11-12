//! Moderation of public items (plan 2026-10-30-inbox-comments-marketplace-plan.md, task F7; spec
//! §3.8, §6.7): hide and unhide, delete and mark handled, each with its refusals, the
//! provider called outside any transaction and a lost race skipped. Items are taken in through
//! the consumer; the providers are scripted public surfaces.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{
    EnvelopeAuthor, EnvelopeStatus, EnvelopeSubject, ModerationAction, PUBLIC_ITEM_GONE,
    PublicEnvelope,
};
use jt_app::usecases::inbox::{consumer, public};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig, PublicCall, ScriptedPublic, ScriptedRegistry};
use serde_json::json;
use support::*;
use time::Duration;

const IG: &str = "17841400000000001";
const IG_COMMENTS: &[&str] = &[
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_manage_messages",
];

struct Rig {
    w: World,
    meta: Arc<ScriptedPublic>,
    ig: Capability,
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
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_public(meta.clone()));
    let ig = capability(&w, "instagram", IG, IG_COMMENTS).await;
    Rig {
        w,
        meta,
        ig,
        tick: AtomicI64::new(0),
    }
}

async fn capability(w: &World, kind: &str, account: &str, scopes: &[&str]) -> Capability {
    let public =
        json!({"provider": "meta", "access": {"kind": "oauth", "app": "meta", "scopes": scopes}});
    let credential = Credential::OAuth {
        access_token: "EAAB-test-token".into(),
        refresh_token: None,
        expires_at: None,
        scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
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

/// Takes `env` in on `cap` through the consumer; the item.
async fn take(r: &Rig, cap: &Capability, env: PublicEnvelope) -> PublicItem {
    let tick = r.tick.fetch_add(1, Ordering::Relaxed);
    let external_id = env.external_id.clone();
    let provider = jt_connector::provider_for_kind(&cap.kind_key).unwrap();
    let kind = match env.kind {
        PublicKind::Comment => EventKind::Comment,
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

/// The moderation calls `surface` received.
fn moderations(surface: &ScriptedPublic) -> Vec<ModerationAction> {
    surface
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            PublicCall::Moderate { action, .. } => Some(action),
            _ => None,
        })
        .collect()
}

fn reason(e: &jt_app::error::AppError) -> String {
    e.details["reason"].as_str().unwrap_or_default().to_owned()
}

async fn agent(r: &Rig, scopes: &[&str]) -> jt_app::ctx::Ctx {
    r.w.agent(scopes).await
}

fn hidden(hidden: bool) -> public::HideInput {
    public::HideInput { hidden }
}

// ---------------------------------------------------------------------------------------------
// Hide and unhide
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn agent_hides_and_unhides() {
    let r = rig().await;
    let agent = agent(&r, &["inbox.work"]).await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    assert_eq!(conversation_state(&r, c1.conversation_id), ConvState::Ours);
    r.meta.push_moderate(Ok(()));
    let out = public::hide(&r.w.deps, &agent, c1.id, hidden(true))
        .await
        .unwrap();
    assert_eq!(out.outcome, "applied");
    assert_eq!(out.item.moderation, Moderation::Hidden);
    assert_eq!(item(&r, "1").moderation, Moderation::Hidden);
    // A hidden comment is not owed.
    assert_eq!(
        conversation_state(&r, c1.conversation_id),
        ConvState::Theirs
    );
    let lines = r.w.entries("inbox.public.moderated");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].payload["action"], "hide");
    assert_eq!(lines[0].payload["item_id"], json!(c1.id));
    // Hiding it again changes nothing and calls nobody.
    let again = public::hide(&r.w.deps, &agent, c1.id, hidden(true))
        .await
        .unwrap();
    assert_eq!(again.outcome, "unchanged");
    assert_eq!(moderations(&r.meta), [ModerationAction::Hide]);

    r.meta.push_moderate(Ok(()));
    let out = public::hide(&r.w.deps, &agent, c1.id, hidden(false))
        .await
        .unwrap();
    assert_eq!(out.outcome, "applied");
    assert_eq!(item(&r, "1").moderation, Moderation::Visible);
    assert_eq!(conversation_state(&r, c1.conversation_id), ConvState::Ours);
    assert_eq!(
        moderations(&r.meta),
        [ModerationAction::Hide, ModerationAction::Unhide]
    );
    assert_eq!(r.w.entries("inbox.public.moderated").len(), 2);
}

#[tokio::test]
async fn moderation_without_grant_refused() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    // The platform's comment flag is turned off: no comment path runs.
    let mut apps = FakeAppConfig::with_all_apps();
    apps.meta.as_mut().unwrap().comment_scopes = false;
    let mut deps = r.w.deps.clone();
    deps.apps = Arc::new(apps);
    let e = public::hide(&deps, &r.w.owner_ctx, c1.id, hidden(true))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "comments_not_enabled");
    let e = public::delete(
        &deps,
        &r.w.owner_ctx,
        c1.id,
        public::DeleteInput { confirm: true },
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "comments_not_enabled");
    assert!(moderations(&r.meta).is_empty());
}

#[tokio::test]
async fn moderation_provider_call_sees_its_own_check_released() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    // During the provider call a reply's receipt answers the item: written meanwhile, it stays.
    let uow = r.w.uow.clone();
    let ws = r.w.ws;
    let id = c1.id;
    r.meta.push_hook(move || async move {
        let mut t = uow.tenant(ws).await.unwrap();
        t.people().lock_workspace().await.unwrap();
        let mut item = t.public_items().lock(id).await.unwrap().unwrap();
        item.agent_answers = 1;
        item.updated_at = FIXED_NOW + Duration::seconds(1);
        t.public_items().update(item).await.unwrap();
        t.commit().await.unwrap();
    });
    r.meta.push_moderate(Ok(()));
    let out = public::hide(&r.w.deps, &r.w.owner_ctx, c1.id, hidden(true))
        .await
        .unwrap();
    assert_eq!(out.outcome, "applied");
    let after = item(&r, "1");
    assert_eq!(after.moderation, Moderation::Hidden);
    assert_eq!(
        after.agent_answers, 1,
        "the write made during the call is kept"
    );
}

#[tokio::test]
async fn lost_race_is_skipped_not_doubled() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    // Another hide finished while ours was at the provider.
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
            i.moderation = Moderation::Hidden;
            i.updated_at = FIXED_NOW + Duration::seconds(1);
        });
    });
    r.meta.push_moderate(Ok(()));
    let out = public::hide(&r.w.deps, &r.w.owner_ctx, c1.id, hidden(true))
        .await
        .unwrap();
    assert_eq!(out.outcome, "skipped");
    assert_eq!(out.item.moderation, Moderation::Hidden);
    assert!(r.w.entries("inbox.public.moderated").is_empty());
    assert_eq!(moderations(&r.meta).len(), 1);
}

#[tokio::test]
async fn a_gone_comment_is_marked_removed() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    r.meta
        .push_moderate(Err(ConnectorError::permanent(PUBLIC_ITEM_GONE)));
    let e = public::hide(&r.w.deps, &r.w.owner_ctx, c1.id, hidden(true))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "item_removed");
    assert_eq!(item(&r, "1").moderation, Moderation::Removed);
    assert_eq!(
        conversation_state(&r, c1.conversation_id),
        ConvState::Theirs
    );
    // Another provider refusal changes nothing.
    let c2 = take(&r, &r.ig, comment("2", "fan-2")).await;
    r.meta.push_moderate(Err(ConnectorError::transient("busy")));
    let e = public::hide(&r.w.deps, &r.w.owner_ctx, c2.id, hidden(true))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::UpstreamUnavailable);
    assert_eq!(item(&r, "2").moderation, Moderation::Visible);
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn delete_needs_manage_confirm_and_a_human() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    // An agent never deletes, whatever its scopes (`agent_cannot_delete`).
    let manager_agent = agent(&r, &["inbox.work", "inbox.manage"]).await;
    let e = public::delete(
        &r.w.deps,
        &manager_agent,
        c1.id,
        public::DeleteInput { confirm: true },
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "agent_cannot_delete");
    // A human needs inbox.manage.
    let mut worker = r.w.owner_ctx.clone();
    worker
        .permissions
        .remove(&jt_tenancy::Permission::InboxManage);
    let e = public::delete(
        &r.w.deps,
        &worker,
        c1.id,
        public::DeleteInput { confirm: true },
    )
    .await
    .unwrap_err();
    assert_forbidden(&e, "inbox.manage");
    // And confirm: true.
    let e = public::delete(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.id,
        public::DeleteInput { confirm: false },
    )
    .await
    .unwrap_err();
    assert_invalid(&e, "confirm");
    assert!(moderations(&r.meta).is_empty());
    assert_eq!(item(&r, "1").moderation, Moderation::Visible);
}

#[tokio::test]
async fn delete_marks_deleted_and_not_owed() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    r.meta.push_moderate(Ok(()));
    let out = public::delete(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.id,
        public::DeleteInput { confirm: true },
    )
    .await
    .unwrap();
    assert_eq!(out.outcome, "applied");
    assert_eq!(item(&r, "1").moderation, Moderation::Deleted);
    assert_eq!(
        conversation_state(&r, c1.conversation_id),
        ConvState::Theirs
    );
    assert_eq!(moderations(&r.meta), [ModerationAction::Delete]);
    assert_eq!(
        r.w.entries("inbox.public.moderated")[0].payload["action"],
        "delete"
    );
    // A deleted comment is gone: nothing more is done to it.
    let e = public::hide(&r.w.deps, &r.w.owner_ctx, c1.id, hidden(true))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "item_removed");
    assert_eq!(moderations(&r.meta).len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Mark handled
// ---------------------------------------------------------------------------------------------

fn handled(ids: Vec<PublicItemId>, reason: &str) -> public::MarkHandledInput {
    serde_json::from_value(json!({"item_ids": ids, "reason": reason})).unwrap()
}

#[tokio::test]
async fn mark_handled_batch_up_to_100_and_one_ledger_line() {
    let r = rig().await;
    let agent = agent(&r, &["inbox.work"]).await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    let c2 = take(&r, &r.ig, comment("2", "fan-2")).await;
    let c3 = take(&r, &r.ig, comment("3", "fan-3")).await;
    let out = public::mark_handled(
        &r.w.deps,
        &agent,
        handled(vec![c1.id, c2.id, c3.id, c1.id], "no_reply_needed"),
    )
    .await
    .unwrap();
    assert_eq!(out.items.len(), 3);
    for id in ["1", "2", "3"] {
        assert!(
            matches!(
                item(&r, id).answer,
                AnswerState::Handled {
                    by: EventSource::Agent,
                    reason: HandledReason::NoReplyNeeded,
                    ..
                }
            ),
            "{id}"
        );
    }
    assert_eq!(
        conversation_state(&r, c1.conversation_id),
        ConvState::Theirs
    );
    assert_eq!(
        conversation_state(&r, c3.conversation_id),
        ConvState::Theirs
    );
    let lines = r.w.entries("inbox.public.handled");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].payload["reason"], "no_reply_needed");
    assert_eq!(lines[0].payload["item_ids"].as_array().unwrap().len(), 3);
    // No provider is told.
    assert!(
        r.meta
            .calls()
            .iter()
            .all(|c| matches!(c, PublicCall::Subject { .. }))
    );
    // Between 1 and 100 items.
    let e = public::mark_handled(&r.w.deps, &agent, handled(vec![], "spam"))
        .await
        .unwrap_err();
    assert_invalid(&e, "item_ids");
    let many: Vec<_> = (0..101).map(|_| PublicItemId::new_v7()).collect();
    let e = public::mark_handled(&r.w.deps, &agent, handled(many, "spam"))
        .await
        .unwrap_err();
    assert_invalid(&e, "item_ids");
}

#[tokio::test]
async fn mark_handled_refuses_a_foreign_or_closed_item() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    let c2 = take(&r, &r.ig, comment("2", "fan-2")).await;
    // An item the workspace does not hold: nothing is marked.
    let e = public::mark_handled(
        &r.w.deps,
        &r.w.owner_ctx,
        handled(vec![c1.id, PublicItemId::new_v7()], "spam"),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(item(&r, "1").answer, AnswerState::Awaiting);
    // An item no longer owed: nothing is marked either.
    public::mark_handled(&r.w.deps, &r.w.owner_ctx, handled(vec![c2.id], "spam"))
        .await
        .unwrap();
    let e = public::mark_handled(
        &r.w.deps,
        &r.w.owner_ctx,
        handled(vec![c1.id, c2.id], "duplicate"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "item_not_owed");
    assert_eq!(item(&r, "1").answer, AnswerState::Awaiting);
    assert_eq!(r.w.entries("inbox.public.handled").len(), 1);
}

#[tokio::test]
async fn deleting_a_comment_already_gone_records_it_deleted() {
    let r = rig().await;
    let c1 = take(&r, &r.ig, comment("1", "fan-1")).await;
    // Deleted on the platform meanwhile (by its author, or by us on another device).
    r.meta
        .push_moderate(Err(ConnectorError::permanent(PUBLIC_ITEM_GONE)));
    let out = public::delete(
        &r.w.deps,
        &r.w.owner_ctx,
        c1.id,
        public::DeleteInput { confirm: true },
    )
    .await
    .unwrap();
    // What was asked is what holds: the comment is gone.
    assert_eq!(out.outcome, "applied");
    assert_eq!(item(&r, "1").moderation, Moderation::Deleted);
    let lines = r.w.entries("inbox.public.moderated");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].payload["action"], "delete");
    assert_eq!(
        conversation_state(&r, c1.conversation_id),
        ConvState::Theirs
    );
}
