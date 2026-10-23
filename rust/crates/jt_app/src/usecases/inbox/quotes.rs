//! Quotes and their durable outbound delivery share one transaction and request-key response.
use super::{record, replies};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{TenantRepos, compliance::QuoteRow},
    usecases::{Deps, invalid, required},
};
use jt_inbox::*;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendInput {
    pub amount_minor: i64,
    pub currency: String,
    #[serde(with = "time::serde::rfc3339")]
    pub valid_until: OffsetDateTime,
    pub file_ref: Option<String>,
    pub channel: Channel,
    pub text: String,
    pub intent: SendIntent,
    pub request_key: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendOut {
    pub quote: QuoteRow,
    pub delivery: replies::ReplyOut,
}

pub async fn send(
    deps: &Deps,
    ctx: &Ctx,
    journey: JourneyId,
    input: SendInput,
) -> Result<SendOut, AppError> {
    let (mut out, queued) = enqueue(deps, ctx, journey, input).await?;
    if let Some(id) = queued {
        out.delivery = replies::send_step(deps, ctx, id).await?;
    }
    Ok(out)
}

/// Exposed to trusted producers/tests; commits phase A without performing provider I/O.
pub async fn enqueue(
    deps: &Deps,
    ctx: &Ctx,
    journey: JourneyId,
    input: SendInput,
) -> Result<(SendOut, Option<Uuid>), AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let key = input
        .request_key
        .as_deref()
        .map(|s| required("request_key", s))
        .transpose()?;
    if let Some(key) = &key
        && let Some(response) = r.request_keys().get(key, ctx.now).await?
    {
        return Ok((
            serde_json::from_value(response)
                .map_err(|_| AppError::conflict("request key belongs to another operation"))?,
            None,
        ));
    }
    let j = lock_live_journey(r.as_mut(), journey).await?;
    let quote = QuoteRow {
        id: deps.ids.uuid(),
        workspace_id: ctx.workspace_id,
        created_at: ctx.now,
        quote: Quote {
            journey_id: journey,
            amount_minor: input.amount_minor,
            currency: input.currency,
            valid_until: input.valid_until,
            file_ref: input.file_ref,
            channel: input.channel,
            state: QuoteState::Sent,
        },
    };
    quote
        .quote
        .validate()
        .map_err(|_| invalid("currency", "invalid ISO 4217 currency"))?;
    if quote.quote.amount_minor < 0 {
        return Err(invalid("amount_minor", "amount must be nonnegative"));
    }
    if quote.quote.valid_until <= ctx.now {
        return Err(invalid("valid_until", "quote must be valid in the future"));
    }
    let enqueued = replies::enqueue_in(
        deps,
        ctx,
        r.as_mut(),
        replies::Target::Person(j.person_id, input.channel),
        replies::ReplyInput {
            text: input.text,
            intent: input.intent,
            request_key: None,
            subject: None,
            in_reply_to: None,
            references: vec![],
        },
        replies::Purpose::Quote(&quote, key.as_deref()),
    )
    .await;
    let id = match enqueued {
        Ok(replies::Enqueued::New(id)) => id,
        Ok(replies::Enqueued::Existing(_)) => {
            return Err(AppError::internal("unexpected cached quote send"));
        }
        Err(e) => {
            if e.code == ErrorCode::Forbidden {
                r.commit().await?;
            }
            return Err(e);
        }
    };
    let row = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::internal("queued send missing"))?;
    let out = SendOut {
        quote: quote.clone(),
        delivery: replies::ReplyOut {
            message_id: row.message_id,
            state: row.state.clone(),
        },
    };
    r.quotes().insert(quote.clone()).await?;
    if let Some(key) = key
        && !r
            .request_keys()
            .store(&key, serde_json::to_value(&out)?, ctx.now)
            .await?
    {
        return Err(AppError::conflict("request key changed while enqueueing"));
    }
    record(
        r.as_mut(),
        ctx,
        "inbox.quote.created",
        "quote",
        quote.id,
        json!({"journey_id":journey,"person_id":j.person_id}),
    )
    .await?;
    r.commit().await?;
    Ok((out, Some(id)))
}

pub async fn list(deps: &Deps, ctx: &Ctx, journey: JourneyId) -> Result<Vec<QuoteRow>, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.journeys()
        .get(journey)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    let mut rows = r.quotes().list(journey).await?;
    for row in &mut rows {
        if row.quote.state == QuoteState::Sent && row.quote.valid_until <= ctx.now {
            row.quote.state = QuoteState::Expired;
        }
    }
    Ok(rows)
}

pub async fn accept(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<QuoteRow, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let mut row = r
        .quotes()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such quote"))?;
    if row.quote.state == QuoteState::Accepted {
        return Ok(row);
    }
    if row.quote.state == QuoteState::Expired || row.quote.valid_until <= ctx.now {
        r.quotes().set_state(id, QuoteState::Expired).await?;
        record(
            r.as_mut(),
            ctx,
            "inbox.quote.expired",
            "quote",
            id,
            json!({"journey_id":row.quote.journey_id}),
        )
        .await?;
        r.commit().await?;
        return Err(AppError::conflict("quote expired"));
    }
    if r.journeys()
        .event_by_key(&format!("quote:{id}:sent"))
        .await?
        .filter(|event| {
            event.source == EventSource::System
                && event.kind == JourneyEventKind::QuoteSent
                && event.journey_id == row.quote.journey_id
        })
        .is_none()
    {
        return Err(AppError::conflict("quote delivery is not confirmed"));
    }
    lock_live_journey(r.as_mut(), row.quote.journey_id).await?;
    event_in(
        deps,
        ctx,
        r.as_mut(),
        row.quote.journey_id,
        format!("quote:{id}:accepted"),
        JourneyEventKind::QuoteAccepted,
        ctx.now,
    )
    .await?;
    r.quotes().set_state(id, QuoteState::Accepted).await?;
    row.quote.state = QuoteState::Accepted;
    record(
        r.as_mut(),
        ctx,
        "inbox.quote.accepted",
        "quote",
        id,
        json!({"journey_id":row.quote.journey_id}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}

pub(super) async fn lock_live_journey(
    r: &mut dyn TenantRepos,
    id: JourneyId,
) -> Result<Journey, AppError> {
    let j = lock_journey(r, id).await?;
    if j.closed_at.is_some() || matches!(j.status, JourneyStatus::Won | JourneyStatus::Lost) {
        return Err(AppError::conflict("journey is terminal"));
    }
    Ok(j)
}

pub(super) async fn lock_journey(
    r: &mut dyn TenantRepos,
    id: JourneyId,
) -> Result<Journey, AppError> {
    let j = r
        .journeys()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    r.conversations().lock_for_person(j.person_id).await?;
    let j = r
        .journeys()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    let person = r
        .people()
        .get(j.person_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    if person.erased_at.is_some() || person.merged_into.is_some() {
        return Err(AppError::conflict("person unavailable"));
    }
    Ok(j)
}

pub(super) async fn sent_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: Uuid,
    at: OffsetDateTime,
    journey_closed: bool,
) -> Result<(), AppError> {
    let quote = r
        .quotes()
        .get(id)
        .await?
        .ok_or_else(|| AppError::internal("outbox quote missing"))?;
    apply_event_in(
        r,
        JourneyEvent {
            id: JourneyEventId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            journey_id: quote.quote.journey_id,
            source: EventSource::System,
            idempotency_key: format!("quote:{id}:sent"),
            kind: JourneyEventKind::QuoteSent,
            reason_label: None,
            at,
        },
        journey_closed,
    )
    .await?;
    record(
        r,
        ctx,
        "inbox.quote.sent",
        "quote",
        id,
        json!({"journey_id":quote.quote.journey_id}),
    )
    .await
}

pub(super) async fn event_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: JourneyId,
    key: String,
    kind: JourneyEventKind,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    apply_event_in(
        r,
        JourneyEvent {
            id: JourneyEventId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            journey_id: journey,
            source: EventSource::System,
            idempotency_key: key,
            kind,
            reason_label: None,
            at,
        },
        false,
    )
    .await
}

async fn apply_event_in(
    r: &mut dyn TenantRepos,
    event: JourneyEvent,
    historical: bool,
) -> Result<(), AppError> {
    if let Some(existing) = r.journeys().event_by_key(&event.idempotency_key).await? {
        return if existing.source == EventSource::System
            && existing.kind == event.kind
            && existing.journey_id == event.journey_id
        {
            Ok(())
        } else {
            Err(AppError::conflict("business event key collision"))
        };
    }
    let j = r
        .journeys()
        .lock(event.journey_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    if event.kind == JourneyEventKind::QuoteSent
        && (historical || matches!(j.status, JourneyStatus::Won | JourneyStatus::Lost))
    {
        return r.journeys().append_historical_reply(event).await;
    }
    let transition = reduce(&j, &event, &ReducePolicy::default())
        .map_err(|e| AppError::conflict(e.to_string()))?;
    r.journeys().apply_transition(j.id, transition, event).await
}
