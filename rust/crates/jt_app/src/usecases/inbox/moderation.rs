//! Moderation of public items (spec 2026-10-30-inbox-comments-marketplace-design.md §3.8, §6.7):
//! hiding a comment and showing it again ([`hide`]), deleting one ([`delete`]), reporting a
//! marketplace question ([`report`]) and marking items handled ([`mark_handled`]). Reached as
//! `inbox.public.*` through `super::public`.
//!
//! A moderation asks its provider, and the provider is called **without a transaction**: the
//! item and its capability are checked and the credential opened in a first bundle, which is
//! released; the provider is called; a second bundle, under the workspace's inbox lock, re-reads
//! the item and writes what the provider did when the item can still take it. When another
//! moderation got there first (the re-read item no longer takes the event) the call is `skipped`:
//! never a second write, a second ledger line or a second call (bug class "cron-lock pool
//! starvation": no connection is held across provider I/O). Marking handled is local and calls
//! no provider.
//!
//! Nothing here logs an item's text, an author or a credential.

use std::collections::BTreeSet;

use jt_capability::{EffectiveStatus, effective_status};
use jt_connector::{ConnectorError, comment_grant, provider_for_kind};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::public::{comments_enabled, refusal, settle_state, settle_states, surface_kind};
use super::record;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        connectors::{ModerationAction, PUBLIC_ITEM_GONE, PublicTarget, ReportReason},
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential, provider_error},
        invalid,
    },
};

/// The most items one [`mark_handled`] takes.
pub const MAX_HANDLED_BATCH: usize = 100;

/// Hides a comment (`hidden: true`) or shows it again (`false`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HideInput {
    pub hidden: bool,
}

/// Deleting a comment needs `confirm: true`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteInput {
    #[serde(default)]
    pub confirm: bool,
}

/// Why a question is reported.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    pub reason: ReportReason,
}

/// The items to mark handled (1 to [`MAX_HANDLED_BATCH`], repeats counted once) and why.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkHandledInput {
    pub item_ids: Vec<PublicItemId>,
    pub reason: HandledReason,
}

/// A moderation's item as it now is, and what came of the call: `applied`, `unchanged` (the
/// item already was so: nobody was called) or `skipped` (another moderation got there first
/// while the provider was called).
#[derive(Debug, Serialize)]
pub struct ModerationOut {
    pub item: PublicItem,
    pub outcome: &'static str,
}

/// The items marked handled, as they now are.
#[derive(Debug, Serialize)]
pub struct HandledOut {
    pub items: Vec<PublicItem>,
}

/// `inbox.public.hide`: hides comment `id` or shows it again (`inbox.work`; the agent may). A
/// hidden comment is not owed. Refusals: `hide_unsupported` (a marketplace question),
/// `comments_not_enabled`, `item_removed`, `human_holds_conversation` (an agent on a conversation
/// a human holds), `capability_down`; `NOT_FOUND` for an unknown item. Ledger
/// `inbox.public.moderated {item_id, action: "hide" | "unhide"}`.
pub async fn hide(
    deps: &Deps,
    ctx: &Ctx,
    id: PublicItemId,
    input: HideInput,
) -> Result<ModerationOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let action = if input.hidden {
        ModerationAction::Hide
    } else {
        ModerationAction::Unhide
    };
    moderate(deps, ctx, id, action).await
}

/// `inbox.public.delete`: deletes comment `id` on its platform (`inbox.manage`, a human, and
/// `confirm: true`: `agent_cannot_delete`, `VALIDATION` on `confirm`). A deleted comment is not
/// owed and takes nothing more. Refusals as [`hide`], with `delete_unsupported` and
/// `moderation_not_granted` (a grant that may not delete others' comments). Ledger
/// `inbox.public.moderated {item_id, action: "delete"}`.
pub async fn delete(
    deps: &Deps,
    ctx: &Ctx,
    id: PublicItemId,
    input: DeleteInput,
) -> Result<ModerationOut, AppError> {
    ctx.require(Permission::InboxManage)?;
    if !matches!(ctx.actor, Actor::Human { .. }) {
        return Err(refusal("agent_cannot_delete"));
    }
    if !input.confirm {
        return Err(invalid(
            "confirm",
            "confirm must be true to delete a comment",
        ));
    }
    moderate(deps, ctx, id, ModerationAction::Delete).await
}

/// `inbox.public.report`: reports question `id` to its marketplace (`inbox.work`; the agent
/// may), where the surface reports (`report_unsupported` elsewhere). A reported question is not
/// owed. Ledger `inbox.public.moderated {item_id, action: "report", reason}`.
pub async fn report(
    deps: &Deps,
    ctx: &Ctx,
    id: PublicItemId,
    input: ReportInput,
) -> Result<ModerationOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    moderate(
        deps,
        ctx,
        id,
        ModerationAction::Report {
            reason: input.reason,
        },
    )
    .await
}

/// `inbox.public.mark_handled`: marks owed items handled with `reason` (`inbox.work`; the agent
/// may), all or none: an item the workspace does not hold is `NOT_FOUND`, one that is not owed
/// any more `item_not_owed`, one of a conversation a human holds `human_holds_conversation` for an
/// agent. Local only: no provider is told. One ledger line `inbox.public.handled {item_ids,
/// reason}` for the batch.
pub async fn mark_handled(
    deps: &Deps,
    ctx: &Ctx,
    input: MarkHandledInput,
) -> Result<HandledOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let ids: Vec<PublicItemId> = {
        let mut seen = BTreeSet::new();
        input
            .item_ids
            .into_iter()
            .filter(|id| seen.insert(*id))
            .collect()
    };
    if ids.is_empty() || ids.len() > MAX_HANDLED_BATCH {
        return Err(invalid(
            "item_ids",
            "between 1 and 100 items are marked handled at once",
        ));
    }
    let by = match ctx.actor {
        Actor::Human { user_id } => EventSource::Human(user_id),
        Actor::Agent { .. } => EventSource::Agent,
        Actor::System { .. } => EventSource::System,
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let mut next = Vec::with_capacity(ids.len());
    for id in &ids {
        let item = locked(r.as_mut(), *id).await?;
        agent_may_act(r.as_mut(), ctx, &item).await?;
        let handled = jt_inbox::public::apply(
            &item,
            ItemEvent::MarkedHandled {
                by,
                reason: input.reason,
            },
            ctx.now,
        )
        .map_err(|_| refusal(PublicRefusal::ItemNotOwed))?;
        next.push(handled);
    }
    for item in &next {
        r.public_items().update(item.clone()).await?;
    }
    settle_states(r.as_mut(), next.iter().map(|i| i.conversation_id)).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.public.handled",
        "public_item",
        ids[0],
        json!({"item_ids": ids, "reason": input.reason}),
    )
    .await?;
    r.commit().await?;
    Ok(HandledOut { items: next })
}

/// Item `id`, locked after its conversation (the reply path's order); `NOT_FOUND` when the
/// workspace holds no such item.
async fn locked(r: &mut dyn TenantRepos, id: PublicItemId) -> Result<PublicItem, AppError> {
    let not_found = || AppError::not_found("no such item");
    let item = r.public_items().get(id).await?.ok_or_else(not_found)?;
    r.conversations().lock(item.conversation_id).await?;
    r.public_items().lock(id).await?.ok_or_else(not_found)
}

/// `human_holds_conversation` when an agent acts on an item of a conversation a human holds.
async fn agent_may_act(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    item: &PublicItem,
) -> Result<(), AppError> {
    if !matches!(ctx.actor, Actor::Agent { .. }) {
        return Ok(());
    }
    let conversation = r
        .conversations()
        .get(item.conversation_id)
        .await?
        .ok_or_else(|| AppError::internal("a public item's conversation is gone"))?;
    if conversation.executor != Executor::Agent {
        return Err(refusal("human_holds_conversation"));
    }
    Ok(())
}

/// The item event a moderation makes once its provider did it.
fn event_of(action: ModerationAction) -> ItemEvent {
    match action {
        ModerationAction::Hide => ItemEvent::Hidden,
        ModerationAction::Unhide => ItemEvent::Unhidden,
        ModerationAction::Delete => ItemEvent::Deleted,
        ModerationAction::Report { .. } => ItemEvent::Reported,
    }
}

/// What a moderation's ledger line says it did.
fn ledger_of(id: PublicItemId, action: ModerationAction) -> Value {
    match action {
        ModerationAction::Hide => json!({"item_id": id, "action": "hide"}),
        ModerationAction::Unhide => json!({"item_id": id, "action": "unhide"}),
        ModerationAction::Delete => json!({"item_id": id, "action": "delete"}),
        ModerationAction::Report { reason } => {
            json!({"item_id": id, "action": "report", "reason": reason})
        }
    }
}

/// The moderation of `id` by `action` (see the module docs).
async fn moderate(
    deps: &Deps,
    ctx: &Ctx,
    id: PublicItemId,
    action: ModerationAction,
) -> Result<ModerationOut, AppError> {
    // 1. Check, open the credential, release.
    let (cap, credential, target) = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let item = r
            .public_items()
            .get(id)
            .await?
            .ok_or_else(|| AppError::not_found("no such item"))?;
        let cap = r
            .capabilities()
            .find(item.capability_id)
            .await?
            .ok_or_else(|| AppError::internal("a public item's capability is gone"))?;
        let rules = public_channel_for_kind(&cap.kind_key)
            .and_then(jt_inbox::public::rules)
            .ok_or_else(|| AppError::internal("a public item on a private kind"))?;
        let (supported, unsupported) = match action {
            ModerationAction::Hide | ModerationAction::Unhide => (rules.hide, "hide_unsupported"),
            ModerationAction::Delete => (rules.delete, "delete_unsupported"),
            ModerationAction::Report { .. } => (rules.report, "report_unsupported"),
        };
        if !supported {
            return Err(refusal(unsupported));
        }
        if !comments_enabled(deps.apps.as_ref(), &cap) {
            return Err(refusal(PublicRefusal::CommentsNotEnabled));
        }
        if action == ModerationAction::Delete && !rules.marketplace {
            let scopes: Vec<&str> = cap.connector_public["access"]["scopes"]
                .as_array()
                .map(|scopes| scopes.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if !comment_grant(surface_kind(&cap.kind_key), &scopes).delete_others {
                return Err(refusal("moderation_not_granted"));
            }
        }
        if matches!(item.moderation, Moderation::Deleted | Moderation::Removed) {
            return Err(refusal(PublicRefusal::ItemRemoved));
        }
        agent_may_act(r.as_mut(), ctx, &item).await?;
        if jt_inbox::public::apply(&item, event_of(action), ctx.now).is_err() {
            // Already so: nobody is called.
            return Ok(ModerationOut {
                item,
                outcome: "unchanged",
            });
        }
        if effective_status(&cap, ctx.now) != EffectiveStatus::Verified || !cap.has_sealed_config {
            return Err(refusal("capability_down"));
        }
        let sealed = r
            .capabilities()
            .read_sealed(cap.id)
            .await?
            .ok_or_else(|| refusal("capability_down"))?;
        let credential = open_credential(deps, ctx.workspace_id, &sealed)?;
        let subject_external_id = match item.subject_id {
            Some(subject) => r
                .public_subjects()
                .get(subject)
                .await?
                .map(|s| s.external_id),
            None => None,
        };
        let target = PublicTarget {
            kind: item.kind,
            external_id: item.external_id.clone(),
            parent_external_id: item.parent_external_id.clone(),
            subject_external_id,
        };
        (cap, credential, target)
    };
    // 2. The provider, with no transaction open.
    let provider = provider_for_kind(&cap.kind_key)
        .ok_or_else(|| AppError::internal("a public capability without a provider"))?;
    let surface = deps
        .connectors
        .public(provider)
        .ok_or_else(|| refusal("connector_unavailable"))?;
    let result = surface
        .moderate(&credential, &adapter_public(&cap), &target, action)
        .await;
    // 3. What the provider did, written on the item as it now is.
    let ctx = Ctx {
        now: deps.clock.now().max(ctx.now),
        ..ctx.clone()
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let current = locked(r.as_mut(), id).await?;
    match result {
        Ok(()) => {}
        // A comment to delete that is gone already: what was asked holds (spec D24).
        Err(ConnectorError::Permanent { reason, .. })
            if reason == PUBLIC_ITEM_GONE && action == ModerationAction::Delete => {}
        Err(ConnectorError::Permanent { reason, .. }) if reason == PUBLIC_ITEM_GONE => {
            if let Ok(next) = jt_inbox::public::apply(&current, ItemEvent::Removed, ctx.now) {
                r.public_items().update(next).await?;
                settle_state(r.as_mut(), current.conversation_id).await?;
                r.commit().await?;
            }
            return Err(refusal(PublicRefusal::ItemRemoved));
        }
        Err(e) => {
            tracing::warn!(
                workspace_id = %ctx.workspace_id,
                capability_id = %cap.id.0,
                error_kind = e.kind(),
                "a public item could not be moderated"
            );
            return Err(provider_error(provider, e));
        }
    }
    let Ok(next) = jt_inbox::public::apply(&current, event_of(action), ctx.now) else {
        // Another moderation got there first: nothing is written twice.
        return Ok(ModerationOut {
            item: current,
            outcome: "skipped",
        });
    };
    r.public_items().update(next.clone()).await?;
    settle_state(r.as_mut(), next.conversation_id).await?;
    record(
        r.as_mut(),
        &ctx,
        "inbox.public.moderated",
        "public_item",
        id,
        ledger_of(id, action),
    )
    .await?;
    r.commit().await?;
    Ok(ModerationOut {
        item: next,
        outcome: "applied",
    })
}
