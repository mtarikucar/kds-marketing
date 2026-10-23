//! Journey stage changes pass through the domain reducer in the effects/ledger transaction.
use super::{people, record};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::TenantRepos,
    usecases::{Deps, invalid, required},
};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::{MembershipStatus, Permission, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    pub kind: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub payload: Value,
}
#[derive(Debug, Serialize)]
pub struct ReportOut {
    pub transition: Option<Transition>,
    pub effects: Vec<JourneyEffect>,
    pub duplicate: bool,
}
#[derive(Debug, Serialize)]
pub struct JourneyOut {
    pub status_labels: std::collections::BTreeMap<String, String>,
    pub journey: Journey,
    pub events: Vec<JourneyEvent>,
    pub tasks: Vec<Task>,
    pub notes: Vec<Note>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignOwnerInput {
    pub user_id: Option<UserId>,
}

pub(crate) fn initial(deps: &Deps, ctx: &Ctx, person_id: PersonId, source: Source) -> Journey {
    Journey {
        id: JourneyId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        person_id,
        status: JourneyStatus::New,
        owner: None,
        opened_at: ctx.now,
        closed_at: None,
        lost_reason: None,
        unreachable_attempts: 0,
        source,
        updated_at: ctx.now,
        reduce_input: ReduceInput::default(),
    }
}
pub async fn open(deps: &Deps, ctx: &Ctx, person: PersonId) -> Result<Journey, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let person = people::resolve(r.as_mut(), person).await?;
    if r.journeys().open_for(person.id).await?.is_some() {
        return Err(AppError::conflict("an open journey already exists"));
    }
    let latest = r.journeys().latest_for(person.id).await?;
    if latest
        .as_ref()
        .is_some_and(|j| j.status == JourneyStatus::Lost)
    {
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: "reopen the lost journey first".into(),
            details: json!({"reason":"reopen_required"}),
        });
    }
    let source = if latest
        .as_ref()
        .is_some_and(|j| j.status == JourneyStatus::Won)
    {
        Source::Repeat
    } else {
        person.first_touch.source
    };
    let row = initial(deps, ctx, person.id, source);
    r.journeys().insert(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.journey.opened",
        "journey",
        row.id,
        json!({"person_id":person.id}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
pub async fn get(deps: &Deps, ctx: &Ctx, id: JourneyId) -> Result<JourneyOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let journey = r
        .journeys()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    let events = r.journeys().events(id, 50).await?;
    Ok(JourneyOut {
        status_labels: super::dictionaries::effective_status_labels(r.as_mut()).await?,
        journey,
        events,
        tasks: r.tasks().list(id).await?,
        notes: r.notes().list(id).await?,
    })
}
pub async fn assign_owner(
    deps: &Deps,
    ctx: &Ctx,
    id: JourneyId,
    input: AssignOwnerInput,
) -> Result<Journey, AppError> {
    ctx.require(Permission::InboxManage)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    r.journeys()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    if let Some(user) = input.user_id {
        let member = r
            .memberships()
            .find_by_user(user)
            .await?
            .filter(|m| m.status == MembershipStatus::Active);
        if member.is_none() {
            return Err(AppError::not_found(
                "owner must be an active workspace member",
            ));
        }
    }
    r.journeys().assign_owner(id, input.user_id).await?;
    let row = r
        .journeys()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    record(
        r.as_mut(),
        ctx,
        "inbox.journey.owner_assigned",
        "journey",
        id,
        json!({"user_id":input.user_id}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}

pub async fn report(
    deps: &Deps,
    ctx: &Ctx,
    id: JourneyId,
    input: ReportInput,
) -> Result<ReportOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let key = required(
        "idempotency_key",
        input.idempotency_key.as_deref().unwrap_or_default(),
    )?;
    let kind = parse_kind(&input.kind, input.payload)?;
    let reopen = matches!(kind, JourneyEventKind::Reopened);
    if reopen {
        ctx.require(Permission::InboxManage)?;
        if !ctx.is_owner_or_manager() || !matches!(ctx.actor, Actor::Human { .. }) {
            return Err(AppError {
                code: ErrorCode::Forbidden,
                message: "reopening requires a human owner or manager".into(),
                details: json!({"reason":"owner_or_manager_required"}),
            });
        }
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    // Covers workspace-wide key races even when two requests name different journeys.
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    // Reply phases and terminal effects share conversation → journey lock order.
    let person = r
        .journeys()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?
        .person_id;
    r.conversations().lock_for_person(person).await?;
    let mut journey = r
        .journeys()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    if r.journeys().event_by_key(&key).await?.is_some() {
        record(
            r.as_mut(),
            ctx,
            "inbox.event.duplicate",
            "journey",
            id,
            json!({}),
        )
        .await?;
        r.commit().await?;
        return Ok(ReportOut {
            transition: None,
            effects: vec![],
            duplicate: true,
        });
    }
    let reason_label = if let JourneyEventKind::Lost { reason_key } = &kind {
        Some(
            r.lost_reasons()
                .list()
                .await?
                .into_iter()
                .find(|row| row.key == *reason_key && row.active)
                .ok_or_else(|| invalid("reason_key", "loss requires an active lost reason"))?
                .label,
        )
    } else {
        None
    };
    journey.reduce_input = ReduceInput::new([], reopen).map_err(reduce_error)?;
    let source = match ctx.actor {
        Actor::Human { user_id } => EventSource::Human(user_id),
        Actor::Agent { .. } => EventSource::Agent,
        Actor::System { .. } => EventSource::System,
    };
    let event = JourneyEvent {
        id: JourneyEventId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        journey_id: id,
        source,
        idempotency_key: key,
        kind,
        reason_label,
        at: ctx.now,
    };
    let policy = ReducePolicy {
        unreachable_threshold: r
            .workspace_policy()
            .get()
            .await?
            .inbox
            .unreachable_threshold,
    };
    let transition = reduce(&journey, &event, &policy).map_err(reduce_error)?;
    let out = ReportOut {
        effects: transition.effects().to_vec(),
        transition: Some(transition.clone()),
        duplicate: false,
    };
    r.journeys().apply_transition(id, transition, event).await?;
    apply_effects(r.as_mut(), &journey, &out.effects).await?;
    // Only status/effect metadata, never product, customer content or identity values.
    record(r.as_mut(), ctx, "inbox.event.reported", "journey", id, json!({"kind":input.kind,"from":journey.status,"to":out.transition.as_ref().map(Transition::to)})).await?;
    r.commit().await?;
    Ok(out)
}

pub(crate) async fn apply_effects(
    r: &mut dyn TenantRepos,
    journey: &Journey,
    effects: &[JourneyEffect],
) -> Result<(), AppError> {
    for effect in effects {
        match effect {
            JourneyEffect::CloseTasks | JourneyEffect::CancelOpenTasks => {
                let status = if matches!(effect, JourneyEffect::CloseTasks) {
                    TaskStatus::Done
                } else {
                    TaskStatus::Cancelled
                };
                for task in r.tasks().list(journey.id).await? {
                    if task.status == TaskStatus::Open {
                        r.tasks().set_status(task.id, status).await?;
                    }
                }
            }
            JourneyEffect::CommissionDue { .. } => { /* M2b consumes the stored Won event. */ }
            other => {
                let state = match other {
                    JourneyEffect::CloseConversations => ConvState::Closed,
                    JourneyEffect::ConversationOurs => ConvState::Ours,
                    JourneyEffect::ConversationTheirs => ConvState::Theirs,
                    JourneyEffect::ConversationSnoozed { until } => {
                        ConvState::Snoozed { until: *until }
                    }
                    _ => unreachable!(),
                };
                for conv in r.conversations().lock_for_person(journey.person_id).await? {
                    r.conversations()
                        .update_state(conv.id, state.clone(), None)
                        .await?;
                }
            }
        }
    }
    Ok(())
}
fn reduce_error(e: ReduceError) -> AppError {
    match e {
        ReduceError::Terminal => AppError {
            code: ErrorCode::Conflict,
            message: e.to_string(),
            details: json!({"reason":"terminal"}),
        },
        ReduceError::Duplicate => AppError::conflict("duplicate journey event"),
        ReduceError::NotAllowed(message) => invalid("payload", message),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    connected: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Won {
    product: String,
    amount_minor: i64,
    currency: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lost {
    reason_key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snoozed {
    #[serde(with = "time::serde::rfc3339")]
    until: time::OffsetDateTime,
}
fn parse_kind(kind: &str, payload: Value) -> Result<JourneyEventKind, AppError> {
    Ok(match kind {
        "call_made" => {
            let p: Call = serde_json::from_value(payload)?;
            JourneyEventKind::CallMade {
                connected: p.connected,
            }
        }
        "won" => {
            let p: Won = serde_json::from_value(payload)?;
            required("product", &p.product)?;
            if p.amount_minor < 0
                || p.currency.len() != 3
                || !p.currency.bytes().all(|b| b.is_ascii_uppercase())
            {
                return Err(invalid(
                    "payload",
                    "won requires a nonnegative amount and three-letter uppercase currency",
                ));
            }
            JourneyEventKind::Won {
                product: p.product,
                amount_minor: p.amount_minor,
                currency: p.currency,
            }
        }
        "lost" => {
            let p: Lost = serde_json::from_value(payload)?;
            JourneyEventKind::Lost {
                reason_key: required("reason_key", &p.reason_key)?,
            }
        }
        "snoozed" => {
            let p: Snoozed = serde_json::from_value(payload)?;
            JourneyEventKind::Snoozed { until: p.until }
        }
        "appointment_booked" | "meeting_held" | "quote_accepted" | "reopened" => {
            let _: Empty = serde_json::from_value(payload)?;
            match kind {
                "appointment_booked" => JourneyEventKind::AppointmentBooked,
                "meeting_held" => JourneyEventKind::MeetingHeld,
                "quote_accepted" => JourneyEventKind::QuoteAccepted,
                _ => JourneyEventKind::Reopened,
            }
        }
        _ => return Err(invalid("kind", "event kind is not externally reportable")),
    })
}
