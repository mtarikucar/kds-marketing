//! The comments backfill poll (plan 2026-10-30-inbox-comments-marketplace-plan.md, task M4; spec
//! §6.9, D17, D25): `comments_poll` asks each capability that takes public items for what is new
//! since its cursor, stores it as a delivery's events and consumes it, and reconciles the items
//! whose reply of ours is uncertain. The provider's poll is scripted.

mod support;

use std::sync::Arc;
use std::time::Duration as StdDuration;

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{
    EnvelopeAuthor, EnvelopeStatus, EnvelopeSubject, InboundEventDraft, PublicEnvelope,
};
use jt_app::ports::inbox::OutboxRow;
use jt_app::usecases::jobs::{self, Job};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, EventKind, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{
    FIXED_NOW, FakeAppConfig, PollCall, ScriptedPoller, ScriptedPublic, ScriptedRegistry,
};
use serde_json::{Value, json};
use support::*;
use time::Duration;

/// The Instagram account (Facebook Login).
const IG: &str = "17841400000000001";
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

struct Rig {
    w: World,
    poller: Arc<ScriptedPoller>,
}

/// An active workspace whose platform's comment flags are `flag`, with a scripted Meta poll.
async fn rig_with(flag: bool) -> Rig {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let mut apps = FakeAppConfig::with_all_apps();
    apps.meta.as_mut().unwrap().comment_scopes = flag;
    apps.instagram.as_mut().unwrap().comment_scopes = flag;
    w.deps.apps = Arc::new(apps);
    let poller = Arc::new(ScriptedPoller::new(Provider::Meta));
    w.deps.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_public(Arc::new(ScriptedPublic::new(Provider::Meta)))
            .with_poller(poller.clone()),
    );
    Rig { w, poller }
}

async fn rig() -> Rig {
    rig_with(true).await
}

/// A connected (sealed, verified) Instagram capability holding `account`, granted `scopes`.
async fn capability(w: &World, account: &str, scopes: &[&str]) -> Capability {
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "instagram".into(),
            name: format!("instagram {account}"),
            external_id: Some(account.into()),
            connector_public: json!({"provider": "meta", "access": {"kind": "oauth", "app": "meta", "scopes": scopes}}),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW);
    let credential = Credential::OAuth {
        access_token: "EAAB-test-token".into(),
        refresh_token: None,
        expires_at: None,
        scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
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

/// Comment `id` on [`POST`] by [`FAN`] (answering `parent` when there is one, ours when `own`).
fn envelope(id: &str, parent: Option<&str>, text: &str, own: bool) -> PublicEnvelope {
    PublicEnvelope {
        kind: PublicKind::Comment,
        account_id: IG.into(),
        external_id: id.into(),
        parent_external_id: parent.map(Into::into),
        root_external_id: parent.unwrap_or(id).into(),
        status: EnvelopeStatus::Open,
        author: EnvelopeAuthor {
            id: Some(if own { IG } else { FAN }.into()),
            name: Some("a.customer".into()),
            is_self: own,
        },
        text: text.into(),
        created_at: FIXED_NOW - Duration::minutes(10),
        deadline: None,
        live: false,
        subject: Some(EnvelopeSubject {
            kind: SubjectKind::Post,
            external_id: POST.into(),
            title: String::new(),
            url: None,
            image_url: None,
            facts: Value::Null,
        }),
        answer: None,
        rejection: None,
    }
}

/// The draft a poll finds for `env`, keyed as the webhook keys it.
fn draft(env: PublicEnvelope) -> InboundEventDraft {
    InboundEventDraft {
        external_id: format!("comment:{}:open", env.external_id),
        kind: EventKind::Comment,
        payload: env.clone().into_payload(json!({ "id": env.external_id })),
        occurred_at: Some(env.created_at),
    }
}

fn items(r: &Rig) -> Vec<PublicItem> {
    r.w.uow.snapshot().inbox.public_items
}

fn polls(r: &Rig) -> Vec<PollCall> {
    r.poller
        .calls()
        .into_iter()
        .filter(|c| matches!(c, PollCall::Poll { .. }))
        .collect()
}

#[tokio::test]
async fn comments_poll_skips_capabilities_without_grant() {
    // The flag is on; the grant lacks the comment scopes.
    let r = rig().await;
    capability(&r.w, IG, &["instagram_basic", "pages_show_list"]).await;
    let report = jobs::run_comments_poll(&r.w.deps, FIXED_NOW).await;
    assert_eq!((report.touched, report.failed), (0, 0));
    assert!(r.poller.calls().is_empty());
    // The grant holds them; the platform's flag is off.
    let r = rig_with(false).await;
    capability(&r.w, IG, IG_COMMENTS).await;
    let report = jobs::run_comments_poll(&r.w.deps, FIXED_NOW).await;
    assert_eq!(report.touched, 0);
    assert!(r.poller.calls().is_empty());
}

#[tokio::test]
async fn comments_poll_stores_like_webhooks_and_dedupes() {
    let r = rig().await;
    let cap = capability(&r.w, IG, IG_COMMENTS).await;
    let first = draft(envelope("c-1", None, "Fiyatı nedir?", false));
    r.poller
        .push_poll(Ok((vec![first.clone()], json!({ "counts": { "m-1": 1 } }))));
    let report = jobs::run_comments_poll(&r.w.deps, FIXED_NOW).await;
    assert_eq!((report.touched, report.changed, report.failed), (1, 1, 0));
    // Stored and consumed as the webhook's would be: an owed item.
    let stored = items(&r);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].external_id, "c-1");
    assert_eq!(stored[0].capability_id, cap.id);
    assert_eq!(stored[0].answer, AnswerState::Awaiting);
    // The next run starts from the stored cursor; the same comment again is a duplicate.
    r.poller
        .push_poll(Ok((vec![first], json!({ "counts": { "m-1": 1 } }))));
    let report = jobs::run_comments_poll(&r.w.deps, FIXED_NOW).await;
    assert_eq!((report.changed, report.skipped), (0, 1));
    assert_eq!(items(&r).len(), 1);
    let cursors: Vec<Value> = polls(&r)
        .into_iter()
        .map(|c| match c {
            PollCall::Poll { cursor, .. } => cursor,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(cursors, [json!({}), json!({ "counts": { "m-1": 1 } })]);
}

/// Our public reply to item `external_id`, timed out: its message `unknown`, its outbox row too.
fn uncertain_reply(r: &Rig, external_id: &str, text: &str) -> MessageId {
    let item = items(r)
        .into_iter()
        .find(|i| i.external_id == external_id)
        .unwrap();
    let reply = MessageId::new_v7();
    let ws = r.w.ws;
    let text = text.to_owned();
    let target = external_id.to_owned();
    r.w.uow.edit(move |s| {
        s.inbox.messages.push(Message {
            id: reply,
            workspace_id: ws,
            conversation_id: item.conversation_id,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: text,
            external_id: None,
            status: MsgStatus::Unknown,
            cost_minor: None,
            at: FIXED_NOW,
        });
        s.inbox.outbox.push(OutboxRow {
            id: uuid::Uuid::now_v7(),
            workspace_id: ws,
            conversation_id: item.conversation_id,
            message_id: reply,
            capability_id: item.capability_id,
            intent: json!({"kind": "reply", "public": {"item_id": item.id, "visibility": "public",
                "target": {"kind": "comment", "external_id": target}}}),
            expected_generation: 0,
            fence_snapshot: Some(json!({"send_at": FIXED_NOW.unix_timestamp_nanos().to_string()})),
            conversation_merged: false,
            state: "unknown".into(),
            attempts: 1,
            last_error: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        });
    });
    reply
}

#[tokio::test]
async fn comments_poll_binds_unknown_replies_by_reconciliation() {
    let r = rig().await;
    capability(&r.w, IG, IG_COMMENTS).await;
    r.poller.push_poll(Ok((
        vec![draft(envelope("c-1", None, "Fiyatı nedir?", false))],
        json!({}),
    )));
    jobs::run_comments_poll(&r.w.deps, FIXED_NOW).await;
    let uncertain = uncertain_reply(&r, "c-1", "DM attık.");
    // The poll finds nothing new; the reconciliation finds our reply under the item.
    r.poller.push_reconcile(Ok(vec![draft(envelope(
        "c-2",
        Some("c-1"),
        "DM attık.",
        true,
    ))]));
    let report = jobs::run_comments_poll(&r.w.deps, FIXED_NOW + Duration::minutes(5)).await;
    assert_eq!(report.failed, 0);
    let targets: Vec<Vec<String>> = r
        .poller
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            PollCall::Reconcile { targets, .. } => {
                Some(targets.into_iter().map(|t| t.external_id).collect())
            }
            _ => None,
        })
        .collect();
    assert_eq!(targets, [vec!["c-1".to_owned()]]);
    let s = r.w.uow.snapshot();
    let message = s.inbox.messages.iter().find(|m| m.id == uncertain).unwrap();
    assert_eq!(message.external_id.as_deref(), Some("c-2"));
    assert_eq!(message.status, MsgStatus::Sent);
    let row = s
        .inbox
        .outbox
        .iter()
        .find(|o| o.message_id == uncertain)
        .unwrap();
    assert_eq!(row.state, "sent");
    let item = s
        .inbox
        .public_items
        .iter()
        .find(|i| i.external_id == "c-1")
        .unwrap();
    assert!(matches!(
        item.answer,
        AnswerState::Answered {
            by: AnsweredBy::Us,
            ..
        }
    ));
}

/// The provider is asked between two transactions: what another writer commits while it answers
/// (here, another run's cursor) is seen afterwards, and this run's drafts and cursor are then
/// dropped rather than written over it.
#[tokio::test]
async fn comments_poll_holds_no_transaction_during_io() {
    let r = rig().await;
    let cap = capability(&r.w, IG, IG_COMMENTS).await.id;
    let (uow, ws) = (r.w.uow.clone(), r.w.ws);
    r.poller.push_hook(move || async move {
        let mut t = uow.tenant(ws).await.unwrap();
        t.people().lock_workspace().await.unwrap();
        t.public_cursors()
            .store(cap, json!({ "moved": true }), FIXED_NOW)
            .await
            .unwrap();
        t.commit().await.unwrap();
    });
    r.poller.push_poll(Ok((
        vec![draft(envelope("c-1", None, "Fiyatı nedir?", false))],
        json!({ "counts": { "m-1": 1 } }),
    )));
    let report = tokio::time::timeout(
        StdDuration::from_secs(10),
        jobs::run_comments_poll(&r.w.deps, FIXED_NOW),
    )
    .await
    .expect("the poll must not wait on the writer that ran while the provider answered");
    assert_eq!((report.touched, report.changed, report.failed), (1, 0, 0));
    assert!(items(&r).is_empty());
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    assert_eq!(
        t.public_cursors().get(cap).await.unwrap(),
        Some(json!({ "moved": true }))
    );
}

#[test]
fn comments_poll_is_a_job_of_its_own() {
    assert!(Job::ALL.contains(&Job::CommentsPoll));
    assert_eq!(Job::CommentsPoll.name(), "comments_poll");
    assert_eq!(Job::CommentsPoll.lock_name(), "jeeta.jobs.comments_poll");
}
