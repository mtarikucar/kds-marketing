//! Internal bookings with automatic reminders and optional, fully fenced ICS mail.
use super::{
    quotes::{event_in, lock_live_journey},
    record, replies,
};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{TenantRepos, compliance::AppointmentRow},
    usecases::{Deps, invalid, required},
};
use jt_capability::{EffectiveStatus, effective_status};
use jt_inbox::*;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookInput {
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub ends_at: OffsetDateTime,
    pub location: String,
    pub intent: SendIntent,
}
#[derive(Clone, Debug, Serialize)]
pub struct Notification {
    pub state: String,
    pub message_id: Option<MessageId>,
    #[serde(skip)]
    outbox_id: Option<Uuid>,
}
#[derive(Debug, Serialize)]
pub struct BookOut {
    pub appointment: AppointmentRow,
    pub reminder: Task,
    pub notification: Notification,
}

pub async fn book(
    deps: &Deps,
    ctx: &Ctx,
    journey: JourneyId,
    input: BookInput,
) -> Result<BookOut, AppError> {
    let mut out = enqueue(deps, ctx, journey, input).await?;
    if let Some(id) = out.notification.outbox_id {
        out.notification.state = replies::send_step(deps, ctx, id).await?.state;
    }
    Ok(out)
}

/// Commit the booking, reminder and optional mail together; recovery can dispatch the mail.
pub async fn enqueue(
    deps: &Deps,
    ctx: &Ctx,
    journey: JourneyId,
    input: BookInput,
) -> Result<BookOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let appointment = AppointmentRow {
        id: deps.ids.uuid(),
        workspace_id: ctx.workspace_id,
        created_at: ctx.now,
        appointment: Appointment {
            journey_id: journey,
            starts_at: input.starts_at,
            ends_at: input.ends_at,
            location: required("location", &input.location)?,
            state: AppointmentState::Booked,
        },
    };
    appointment
        .appointment
        .validate()
        .map_err(|_| invalid("ends_at", "invalid appointment interval"))?;
    let due_at = input
        .starts_at
        .checked_sub(Duration::hours(1))
        .ok_or_else(|| invalid("starts_at", "invalid reminder time"))?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let j = lock_live_journey(r.as_mut(), journey).await?;
    let notification = enqueue_mail(
        deps,
        ctx,
        r.as_mut(),
        j.person_id,
        &appointment,
        input.intent,
    )
    .await?;
    r.appointments().insert(appointment.clone()).await?;
    // The reminder uses the booking UUID in its separate table: cancellation is exact, and
    // neither a new port nor title matching is required to find the automatic task.
    let reminder = Task {
        id: TaskId::from(appointment.id),
        workspace_id: ctx.workspace_id,
        journey_id: journey,
        title: "Appointment reminder".into(),
        due_at,
        assignee: j.owner,
        status: TaskStatus::Open,
    };
    r.tasks().insert(reminder.clone()).await?;
    event_in(
        deps,
        ctx,
        r.as_mut(),
        journey,
        format!("appointment:{}:booked", appointment.id),
        JourneyEventKind::AppointmentBooked,
        ctx.now,
    )
    .await?;
    record(r.as_mut(),ctx,"inbox.appointment.booked","appointment",appointment.id,json!({"journey_id":journey,"person_id":j.person_id,"notification":notification.state,"reminder_id":reminder.id})).await?;
    r.commit().await?;
    Ok(BookOut {
        appointment,
        reminder,
        notification,
    })
}

async fn enqueue_mail(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    person: PersonId,
    appointment: &AppointmentRow,
    intent: SendIntent,
) -> Result<Notification, AppError> {
    let unavailable = || Notification {
        state: "unavailable".into(),
        message_id: None,
        outbox_id: None,
    };
    if !r
        .identities()
        .list(person)
        .await?
        .iter()
        .any(|i| i.active && i.channel == IdentityChannel::Email)
    {
        return Ok(unavailable());
    }
    let mut caps = r
        .capabilities()
        .list(crate::ports::CapabilityFilter {
            kind: Some("mailbox"),
            ..Default::default()
        })
        .await?
        .into_iter()
        .filter(|c| {
            effective_status(c, ctx.now) == EffectiveStatus::Verified && c.has_sealed_config
        });
    let Some(_cap) = caps.next() else {
        return Ok(unavailable());
    };
    if caps.next().is_some() {
        return Err(AppError::conflict("ambiguous send capability"));
    }
    let queued = replies::enqueue_in(
        deps,
        ctx,
        r,
        replies::Target::Person(person, Channel::Email),
        replies::ReplyInput {
            text: "Appointment confirmation".into(),
            intent,
            request_key: None,
            subject: Some("Appointment confirmation".into()),
            in_reply_to: None,
            references: vec![],
        },
        replies::Purpose::Appointment(appointment),
    )
    .await;
    let id = match queued {
        Ok(replies::Enqueued::New(id)) => id,
        Ok(replies::Enqueued::Existing(_)) => {
            return Err(AppError::internal("unexpected cached appointment mail"));
        }
        Err(e) if e.code == ErrorCode::Forbidden => {
            return Ok(Notification {
                state: "refused".into(),
                message_id: None,
                outbox_id: None,
            });
        }
        Err(e) => return Err(e),
    };
    let row = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::internal("queued appointment mail missing"))?;
    let notification = Notification {
        state: row.state.clone(),
        message_id: Some(row.message_id),
        outbox_id: Some(id),
    };
    Ok(notification)
}

pub async fn cancel(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<AppointmentRow, AppError> {
    change(deps, ctx, id, AppointmentState::Cancelled).await
}
pub async fn held(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<AppointmentRow, AppError> {
    change(deps, ctx, id, AppointmentState::Held).await
}
async fn change(
    deps: &Deps,
    ctx: &Ctx,
    id: Uuid,
    state: AppointmentState,
) -> Result<AppointmentRow, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let mut row = r
        .appointments()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such appointment"))?;
    if row.appointment.state == state {
        return Ok(row);
    }
    if row.appointment.state != AppointmentState::Booked {
        return Err(AppError::conflict("appointment is no longer booked"));
    }
    let j = lock_live_journey(r.as_mut(), row.appointment.journey_id).await?;
    if state == AppointmentState::Held {
        event_in(
            deps,
            ctx,
            r.as_mut(),
            j.id,
            format!("appointment:{id}:held"),
            JourneyEventKind::MeetingHeld,
            ctx.now,
        )
        .await?;
    }
    r.appointments().set_state(id, state).await?;
    let reminder_id = TaskId::from(id);
    if let Some(reminder) = r.tasks().get(reminder_id).await?
        && reminder.status == TaskStatus::Open
    {
        r.tasks()
            .set_status(
                reminder_id,
                if state == AppointmentState::Held {
                    TaskStatus::Done
                } else {
                    TaskStatus::Cancelled
                },
            )
            .await?;
    }
    row.appointment.state = state;
    record(
        r.as_mut(),
        ctx,
        if state == AppointmentState::Held {
            "inbox.appointment.held"
        } else {
            "inbox.appointment.cancelled"
        },
        "appointment",
        id,
        json!({"journey_id":j.id,"person_id":j.person_id}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
