//! Conversation reads, executor handovers and snooze actions shared by both surfaces.
use super::record;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::inbox::ConversationQueue,
    usecases::{Deps, invalid},
};
use jt_inbox::{ConvState, Conversation, ConversationId, Direction, Executor, Message, MsgStatus};
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
#[derive(Debug, Serialize)]
pub struct MessageView {
    #[serde(flatten)]
    pub message: Message,
    pub failure_reason: Option<String>,
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
) -> Result<Page<Conversation>, AppError> {
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
    Ok(Page { items, next_cursor })
}
pub async fn get(deps: &Deps, ctx: &Ctx, id: ConversationId) -> Result<Conversation, AppError> {
    ctx.require(Permission::InboxWork)?;
    deps.uow
        .tenant(ctx.workspace_id)
        .await?
        .conversations()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))
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
    r.conversations()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))?;
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
    let items = items
        .into_iter()
        .map(|message| MessageView {
            failure_reason: reasons
                .iter()
                .find(|(id, _)| *id == message.id)
                .map(|(_, reason)| reason.clone()),
            message,
        })
        .collect();
    Ok(Page { items, next_cursor })
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
