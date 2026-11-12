//! Conversation reads, executor handovers and snooze actions shared by both surfaces.
use super::record;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        inbox::{ConversationQueue, OutboxRow},
    },
    usecases::{Deps, invalid},
};
use jt_inbox::{
    Channel, ConvState, Conversation, ConversationId, Direction, Executor, Message, MsgStatus,
    PublicItemId, PublicKind, Visibility, conversation_channel, public_channel_for_kind,
};
use jt_ledger::Actor;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListInput {
    #[serde(default)]
    pub queue: ConversationQueue,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessagesInput {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}
#[derive(Debug, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}
/// A message as the inbox lists it: the stored message and, for an outbound one that failed or
/// whose outcome is unknown, the failure line its send recorded (`kind: provider: reason`,
/// [`crate::usecases::failure`]), else `null`.
///
/// On a public conversation, `item` names the comment the message is (an inbound
/// one) or answers (ours, with its visibility); absent on a direct conversation.
///
/// `attachments` are the email's files (spec 2026-10-30-leads-pool-outreach-design.md §3.15):
/// each kept, skipped (with why) or deleted, oldest first; empty for any other message.
#[derive(Debug, Serialize)]
pub struct MessageView {
    #[serde(flatten)]
    pub message: Message,
    pub failure_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<MessageItem>,
    pub attachments: Vec<super::attachments::AttachmentView>,
}

/// The public item a message is or answers.
#[derive(Debug, Serialize)]
pub struct MessageItem {
    pub item_id: PublicItemId,
    pub kind: PublicKind,
    /// The item's answer state key (`awaiting`, `pending`, `answered`, …).
    pub answer_state: &'static str,
    /// For our reply, in front of everyone or privately; `None` for the item's own message.
    pub visibility: Option<Visibility>,
}

/// A conversation as the inbox lists it (spec §6.8): the stored conversation and what its
/// items and replies say, computed (nothing of it is stored). `surface` is `public` for a
/// comment conversation, `relay` for buyer mail relayed by Amazon, else
/// `private`; `owed_items` and `next_deadline` count the owed items of a public one; and
/// `held_replies` the replies waiting for a human.
#[derive(Debug, Serialize)]
pub struct ConversationView {
    #[serde(flatten)]
    pub conversation: Conversation,
    pub surface: &'static str,
    pub channel: Option<Channel>,
    pub owed_items: u32,
    #[serde(with = "time::serde::rfc3339::option")]
    pub next_deadline: Option<OffsetDateTime>,
    pub held_replies: u32,
}

impl std::ops::Deref for ConversationView {
    type Target = Conversation;
    fn deref(&self) -> &Conversation {
        &self.conversation
    }
}

/// `conversation`'s view, its held replies among `held`.
pub(crate) async fn view(
    r: &mut dyn TenantRepos,
    conversation: Conversation,
    held: &[OutboxRow],
) -> Result<ConversationView, AppError> {
    let (surface, owed_items, next_deadline) =
        if public_channel_for_kind(&conversation.kind_key).is_some() {
            let items = r.public_items().for_conversation(conversation.id).await?;
            let owed: Vec<_> = items.iter().filter(|i| i.awaiting()).collect();
            (
                "public",
                u32::try_from(owed.len()).unwrap_or(u32::MAX),
                owed.iter().filter_map(|i| i.deadline).min(),
            )
        } else if super::public::relay_of(r, &conversation).await?.is_some() {
            ("relay", 0, None)
        } else {
            ("private", 0, None)
        };
    let held_replies = held
        .iter()
        .filter(|row| row.conversation_id == conversation.id)
        .count();
    Ok(ConversationView {
        surface,
        channel: conversation_channel(&conversation.kind_key),
        owed_items,
        next_deadline,
        held_replies: u32::try_from(held_replies).unwrap_or(u32::MAX),
        conversation,
    })
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnoozeInput {
    #[serde(with = "time::serde::rfc3339")]
    pub until: OffsetDateTime,
}
fn cursor(raw: Option<&str>) -> Result<Option<(OffsetDateTime, Uuid)>, AppError> {
    raw.map(|v| {
        let (at, id) = v
            .split_once('/')
            .ok_or_else(|| invalid("cursor", "invalid cursor"))?;
        let at = at
            .parse::<i128>()
            .ok()
            .and_then(|v| OffsetDateTime::from_unix_timestamp_nanos(v).ok())
            .ok_or_else(|| invalid("cursor", "invalid cursor"))?;
        let id = Uuid::parse_str(id).map_err(|_| invalid("cursor", "invalid cursor"))?;
        Ok((at, id))
    })
    .transpose()
}
fn encode(at: OffsetDateTime, id: impl std::fmt::Display) -> String {
    format!("{}/{id}", at.unix_timestamp_nanos())
}
fn limit(n: Option<u32>) -> u32 {
    n.unwrap_or(50).clamp(1, 499)
}
pub async fn list(
    deps: &Deps,
    ctx: &Ctx,
    input: ListInput,
) -> Result<Page<ConversationView>, AppError> {
    ctx.require(Permission::InboxWork)?;
    let after = cursor(input.cursor.as_deref())?.map(|(t, id)| (t, id.into()));
    let limit = limit(input.limit);
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut items = r
        .conversations()
        .page(input.queue, after, limit + 1)
        .await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next_cursor = if more {
        items.last().map(|r| encode(r.created_at, r.id))
    } else {
        None
    };
    let held = super::context::held_replies(r.as_mut(), ctx.now).await?;
    let mut views = Vec::with_capacity(items.len());
    for c in items {
        views.push(view(r.as_mut(), c, &held).await?);
    }
    Ok(Page {
        items: views,
        next_cursor,
    })
}
pub async fn get(deps: &Deps, ctx: &Ctx, id: ConversationId) -> Result<ConversationView, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let conversation = r
        .conversations()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))?;
    let held = super::context::held_replies(r.as_mut(), ctx.now).await?;
    view(r.as_mut(), conversation, &held).await
}
pub async fn messages(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
    input: MessagesInput,
) -> Result<Page<MessageView>, AppError> {
    ctx.require(Permission::InboxWork)?;
    let after = cursor(input.cursor.as_deref())?.map(|(t, id)| (t, id.into()));
    let limit = limit(input.limit);
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let conversation = r
        .conversations()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))?;
    let public = public_channel_for_kind(&conversation.kind_key).is_some();
    let mut items = r.messages().page(id, after, limit + 1).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next_cursor = if more {
        items.last().map(|r| encode(r.at, r.id))
    } else {
        None
    };
    let failed: Vec<_> = items
        .iter()
        .filter(|m| {
            m.direction == Direction::Outbound
                && matches!(m.status, MsgStatus::Failed | MsgStatus::Unknown)
        })
        .map(|m| m.id)
        .collect();
    let reasons = r.outbox().failure_reasons(&failed).await?;
    let ids: Vec<_> = items.iter().map(|m| m.id).collect();
    let files = r.mail_files().for_messages(&ids).await?;
    let mut views = Vec::with_capacity(items.len());
    for message in items {
        let item = if public {
            message_item(r.as_mut(), &message).await?
        } else {
            None
        };
        views.push(MessageView {
            failure_reason: reasons
                .iter()
                .find(|(id, _)| *id == message.id)
                .map(|(_, reason)| reason.clone()),
            item,
            attachments: files
                .iter()
                .filter(|f| f.message_id == Some(message.id))
                .map(Into::into)
                .collect(),
            message,
        });
    }
    Ok(Page {
        items: views,
        next_cursor,
    })
}
async fn mutate(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
    state: Option<ConvState>,
    executor: Option<Executor>,
    action: &str,
) -> Result<Conversation, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    r.conversations()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))?;
    if let Some(state) = state {
        r.conversations().update_state(id, state, None).await?;
    }
    if let Some(executor) = executor {
        r.conversations().update_executor(id, executor).await?;
    }
    let row = r
        .conversations()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))?;
    record(
        r.as_mut(),
        ctx,
        action,
        "conversation",
        id,
        json!({"state":row.state,"executor":row.executor,"generation":row.executor_generation}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
pub async fn take_over(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
) -> Result<Conversation, AppError> {
    ctx.require(Permission::InboxWork)?;
    let Actor::Human { user_id } = ctx.actor else {
        return Err(invalid("executor", "executor must be a person"));
    };
    mutate(
        deps,
        ctx,
        id,
        None,
        Some(Executor::Human {
            user_id: Some(user_id),
        }),
        "inbox.conversation.taken_over",
    )
    .await
}
pub async fn hand_to_agent(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
) -> Result<Conversation, AppError> {
    mutate(
        deps,
        ctx,
        id,
        None,
        Some(Executor::Agent),
        "inbox.conversation.handed_to_agent",
    )
    .await
}
pub async fn snooze(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
    input: SnoozeInput,
) -> Result<Conversation, AppError> {
    ctx.require(Permission::InboxWork)?;
    if input.until <= ctx.now {
        return Err(invalid("until", "snooze must end in the future"));
    }
    mutate(
        deps,
        ctx,
        id,
        Some(ConvState::Snoozed { until: input.until }),
        None,
        "inbox.conversation.snoozed",
    )
    .await
}
pub async fn unsnooze(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
) -> Result<Conversation, AppError> {
    mutate(
        deps,
        ctx,
        id,
        Some(ConvState::Ours),
        None,
        "inbox.conversation.unsnoozed",
    )
    .await
}
pub async fn close(deps: &Deps, ctx: &Ctx, id: ConversationId) -> Result<Conversation, AppError> {
    mutate(
        deps,
        ctx,
        id,
        Some(ConvState::Closed),
        None,
        "inbox.conversation.closed",
    )
    .await
}

/// The public item `message` is (an inbound one: `PublicItemRepo::item_for_message`) or answers
/// (ours: its outbox intent's item, with the reply's visibility).
async fn message_item(
    r: &mut dyn TenantRepos,
    message: &Message,
) -> Result<Option<MessageItem>, AppError> {
    let (item, visibility) = match message.direction {
        Direction::Inbound => (r.public_items().item_for_message(message.id).await?, None),
        Direction::Outbound => {
            let Some(row) = r.outbox().for_message(message.id).await? else {
                return Ok(None);
            };
            let Some(intent) = super::public::intent_of(&row.intent)? else {
                return Ok(None);
            };
            (
                r.public_items().get(intent.item_id).await?,
                Some(intent.visibility),
            )
        }
    };
    Ok(item.map(|item| MessageItem {
        item_id: item.id,
        kind: item.kind,
        answer_state: item.answer.key(),
        visibility,
    }))
}
