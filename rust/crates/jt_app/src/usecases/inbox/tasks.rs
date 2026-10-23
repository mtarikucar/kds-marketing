//! Follow-up tasks and private notes shared by all inbox surfaces.
use super::record;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::inbox::TaskQueue,
    usecases::{Deps, required},
};
use jt_inbox::{EventSource, JourneyId, Note, NoteId, Task, TaskId, TaskStatus};
use jt_ledger::Actor;
use jt_tenancy::{MembershipStatus, Permission, UserId};
use serde::Deserialize;
use serde_json::json;
use time::OffsetDateTime;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub title: String,
    #[serde(with = "time::serde::rfc3339")]
    pub due_at: OffsetDateTime,
    #[serde(default)]
    pub assignee: Option<UserId>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListInput {
    #[serde(default)]
    pub queue: TaskQueue,
    #[serde(default)]
    pub assignee: Option<UserId>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteInput {
    pub text: String,
}

pub async fn create(
    deps: &Deps,
    ctx: &Ctx,
    journey: JourneyId,
    input: CreateInput,
) -> Result<Task, AppError> {
    ctx.require(Permission::InboxWork)?;
    let title = required("title", &input.title)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let j = r
        .journeys()
        .lock(journey)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    super::erasure::check_person(r.as_mut(), j.person_id).await?;
    if let Some(user) = input.assignee {
        let member = r
            .memberships()
            .find_by_user(user)
            .await?
            .filter(|m| m.status == MembershipStatus::Active);
        if member.is_none() {
            return Err(AppError::not_found(
                "assignee must be an active workspace member",
            ));
        }
    }
    let row = Task {
        id: TaskId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        journey_id: journey,
        title,
        due_at: input.due_at,
        assignee: input.assignee,
        status: TaskStatus::Open,
    };
    r.tasks().insert(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.task.created",
        "task",
        row.id,
        json!({"journey_id":journey,"assignee":row.assignee}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}

pub async fn complete(deps: &Deps, ctx: &Ctx, id: TaskId) -> Result<Task, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let mut row = r
        .tasks()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such task"))?;
    match row.status {
        TaskStatus::Done => return Ok(row),
        TaskStatus::Cancelled => {
            return Err(AppError::conflict("a cancelled task cannot be completed"));
        }
        TaskStatus::Open => {}
    }
    r.tasks().set_status(id, TaskStatus::Done).await?;
    row.status = TaskStatus::Done;
    record(
        r.as_mut(),
        ctx,
        "inbox.task.completed",
        "task",
        id,
        json!({"journey_id":row.journey_id}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}

pub async fn list(deps: &Deps, ctx: &Ctx, input: ListInput) -> Result<Vec<Task>, AppError> {
    ctx.require(Permission::InboxWork)?;
    deps.uow
        .tenant(ctx.workspace_id)
        .await?
        .tasks()
        .query(input.queue, input.assignee, ctx.now)
        .await
}

pub async fn add_note(
    deps: &Deps,
    ctx: &Ctx,
    journey: JourneyId,
    input: NoteInput,
) -> Result<Note, AppError> {
    ctx.require(Permission::InboxWork)?;
    let text = required("text", &input.text)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let j = r
        .journeys()
        .lock(journey)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    super::erasure::check_person(r.as_mut(), j.person_id).await?;
    let author = match ctx.actor {
        Actor::Human { user_id } => EventSource::Human(user_id),
        Actor::Agent { .. } => EventSource::Agent,
        Actor::System { .. } => EventSource::System,
    };
    let row = Note {
        id: NoteId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        journey_id: journey,
        author,
        text,
        at: ctx.now,
    };
    r.notes().insert(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.note.added",
        "note",
        row.id,
        json!({"journey_id":journey}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
