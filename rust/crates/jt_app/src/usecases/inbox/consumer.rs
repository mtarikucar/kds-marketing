//! Trusted system consumer. Claims, facts and completion share one tenant transaction.
use super::{journeys, people, record};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        EventOrder, EventQuery, TenantRepos,
        inbox::{ConsumptionOutcome, ConversationQueue},
    },
    usecases::{Deps, jobs::JobReport},
};
use jt_capability::Capability;
use jt_connector::{EventKind, InboundEvent, Provider};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde_json::{Value, json};
use time::OffsetDateTime;

pub const CONSUMER: &str = "inbox@1";
// Stable across inbox consumer versions: activity must not reopen a conversation twice.
const PBX_ACTIVITY: &str = "inbox.pbx_activity";

/// Sweep with a cursor even after failures; the next sweep starts over to retry rollbacks.
pub async fn consume_workspace(deps: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> JobReport {
    let mut report = JobReport::default();
    let mut cursor = None;
    loop {
        let page = async {
            let mut r = deps.uow.tenant(ws).await?;
            if !matches!(
                r.workspace().get().await?.status,
                WorkspaceStatus::Active | WorkspaceStatus::PendingPayment
            ) {
                return Ok(vec![]);
            }
            r.inbound_events()
                .list_for_consumer(CONSUMER, cursor, 100)
                .await
        }
        .await;
        let events = match page {
            Ok(events) => events,
            Err(e) => {
                warn(ws, &e);
                report.failed += 1;
                break;
            }
        };
        if events.is_empty() {
            break;
        }
        for event in events {
            cursor = Some((event.received_at, event.id));
            report.touched += 1;
            match consume(deps, &event, now).await {
                Ok("consumed") => report.changed += 1,
                Ok(_) => report.skipped += 1,
                Err(e) => {
                    report.failed += 1;
                    warn(ws, &e);
                }
            }
        }
    }
    report
}
fn warn(ws: WorkspaceId, e: &AppError) {
    // Adapter errors can contain SQL or personal data: only a structured code reaches logs.
    tracing::warn!(job="inbox_consume",workspace_id=%ws,code=e.code.as_str(),"inbound consumption rolled back");
}
async fn consume(
    deps: &Deps,
    event: &InboundEvent,
    now: OffsetDateTime,
) -> Result<&'static str, AppError> {
    let mut r = deps.uow.tenant(event.workspace_id).await?;
    r.people().lock_workspace().await?;
    if !matches!(
        r.workspace().get().await?.status,
        WorkspaceStatus::Active | WorkspaceStatus::PendingPayment
    ) {
        return Ok("deferred");
    }
    r.people().set_write_time(now).await?;
    if !r.consumption().try_claim(CONSUMER, event.id).await? {
        return Ok("duplicate");
    }
    let ctx = Ctx {
        workspace_id: event.workspace_id,
        actor: Actor::System {
            component: "scheduler:inbox_consume".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now,
        agent_connection_id: None,
    };
    let outcome = route(deps, &ctx, r.as_mut(), event).await?;
    r.consumption()
        .record(
            CONSUMER,
            event.id,
            ConsumptionOutcome {
                consumed_at: now,
                outcome: outcome.into(),
            },
        )
        .await?;
    r.commit().await?;
    Ok(outcome)
}
async fn route(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
) -> Result<&'static str, AppError> {
    let Some(id) = event.capability_id else {
        return Ok("deferred");
    };
    let Some(cap) = r.capabilities().find(id).await? else {
        return Ok("deferred");
    };
    let Some(channel) = channel_for_kind(&cap.kind_key) else {
        return Ok("deferred");
    };
    match event.kind {
        EventKind::Message
            if matches!(
                (event.provider, channel),
                (
                    Provider::Meta,
                    Channel::WhatsApp | Channel::Messenger | Channel::InstagramDm
                ) | (Provider::Netgsm, Channel::Sms)
            ) =>
        {
            message(deps, ctx, r, event, &cap, channel).await
        }
        EventKind::MessageEcho
            if event.provider == Provider::Meta
                && matches!(channel, Channel::Messenger | Channel::InstagramDm) =>
        {
            echo(deps, ctx, r, event, &cap, channel).await
        }
        EventKind::Status
            if event.provider == Provider::Meta
                && matches!(
                    channel,
                    Channel::WhatsApp | Channel::Messenger | Channel::InstagramDm
                ) =>
        {
            status(r, event, &cap).await
        }
        EventKind::CallEvent if event.provider == Provider::Netgsm && channel == Channel::Phone => {
            call(deps, ctx, r, event, &cap).await
        }
        _ => Ok("deferred"),
    }
}
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}
fn malformed() -> AppError {
    AppError::validation("invalid inbound payload", json!({}))
}
struct Content {
    sender: String,
    body: String,
    external_id: String,
    name: String,
}
fn decode(event: &InboundEvent, channel: Channel, echo: bool) -> Result<Content, AppError> {
    let p = &event.payload;
    let (sender, body, id, name) = match (event.provider, channel) {
        (Provider::Meta, Channel::WhatsApp) => (
            text(&p["message"], "from"),
            p["message"]["text"]["body"]
                .as_str()
                .or(p["message"]["button"]["text"].as_str())
                .or(p["message"]["interactive"]["button_reply"]["title"].as_str())
                .or(p["message"]["interactive"]["list_reply"]["title"].as_str()),
            text(&p["message"], "id"),
            p["contact"]["profile"]["name"].as_str(),
        ),
        (Provider::Meta, Channel::Messenger | Channel::InstagramDm) => {
            let m = &p["messaging"];
            (
                text(&m[if echo { "recipient" } else { "sender" }], "id"),
                text(&m["message"], "text").or(text(&m["postback"], "title")),
                text(&m["message"], "mid")
                    .or(text(&m["postback"], "mid"))
                    .or(Some(event.external_id.as_str())),
                None,
            )
        }
        (Provider::Netgsm, Channel::Sms) => (
            text(p, "from"),
            text(p, "text"),
            Some(event.external_id.as_str()),
            None,
        ),
        _ => return Err(malformed()),
    };
    Ok(Content {
        sender: sender.ok_or_else(malformed)?.into(),
        body: body.unwrap_or_default().into(),
        external_id: id.ok_or_else(malformed)?.into(),
        name: name.unwrap_or_default().into(),
    })
}
async fn contact(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Capability,
    channel: Channel,
    content: &Content,
) -> Result<Person, AppError> {
    Ok(people::match_or_create(
        deps,
        ctx,
        r,
        people::CreateInput {
            display_name: content.name.clone(),
            identities: vec![people::IdentityInput {
                channel: channel.identity_channel(),
                value: content.sender.clone(),
                capability_id: Some(cap.id),
            }],
            source: Source::Channel(channel),
        },
        Some(0),
    )
    .await?
    .person)
}
async fn conversation(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
    person: PersonId,
) -> Result<Conversation, AppError> {
    r.conversations()
        .upsert_on_inbound(Conversation {
            id: ConversationId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            person_id: person,
            capability_id: cap.id,
            kind_key: cap.kind_key.clone(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(event.received_at),
            last_outbound_at: None,
            created_at: ctx.now,
            updated_at: ctx.now,
        })
        .await
}
async fn journey(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    person: &Person,
) -> Result<Journey, AppError> {
    if let Some(j) = r.journeys().open_for(person.id).await? {
        return Ok(j);
    }
    let latest = r.journeys().latest_for(person.id).await?;
    if let Some(j) = latest.as_ref().filter(|j| j.status == JourneyStatus::Lost) {
        return Ok(j.clone());
    }
    let source = if latest.is_some_and(|j| j.status == JourneyStatus::Won) {
        Source::Repeat
    } else {
        person.first_touch.source.clone()
    };
    let j = journeys::initial(deps, ctx, person.id, source);
    r.journeys().insert(j.clone()).await?;
    Ok(j)
}
async fn apply(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: Journey,
    key: String,
    kind: JourneyEventKind,
) -> Result<(), AppError> {
    let j = r
        .journeys()
        .lock(journey.id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    let event = JourneyEvent {
        id: JourneyEventId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        journey_id: j.id,
        source: EventSource::System,
        idempotency_key: key,
        kind,
        reason_label: None,
        at: ctx.now,
    };
    let transition = reduce(&j, &event, &ReducePolicy::default())
        .map_err(|_| AppError::conflict("inbound journey transition refused"))?;
    let effects = transition.effects().to_vec();
    r.journeys()
        .apply_transition(j.id, transition, event)
        .await?;
    journeys::apply_effects(r, &j, &effects).await?;
    record(
        r,
        ctx,
        "inbox.event.reported",
        "journey",
        j.id,
        json!({"source":"inbound"}),
    )
    .await
}
async fn message(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
    channel: Channel,
) -> Result<&'static str, AppError> {
    let key = format!("inbound:{}", event.id);
    if r.journeys().event_by_key(&key).await?.is_some() {
        return Ok("duplicate");
    }
    let content = decode(event, channel, false)?;
    let person = contact(deps, ctx, r, cap, channel, &content).await?;
    // Check message identity before reopening or fencing: replay has no domain effects.
    if let Some(conv) = r.conversations().find(person.id, cap.id).await?
        && find_message(r, conv.id, &content.external_id)
            .await?
            .is_some()
    {
        return Ok("duplicate");
    }
    let conv = conversation(deps, ctx, r, event, cap, person.id).await?;
    let inserted = r
        .messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: conv.id,
            direction: Direction::Inbound,
            author: Author::Customer,
            body: content.body,
            external_id: Some(content.external_id),
            status: MsgStatus::Received,
            cost_minor: None,
            at: event.received_at,
        })
        .await?;
    let Some(message_id) = inserted else {
        return Ok("duplicate");
    };
    let normalized = sender_key(cap, channel, &content.sender)?;
    let sender = r
        .identities()
        .list(person.id)
        .await?
        .into_iter()
        .find(|identity| {
            identity.channel == channel.identity_channel()
                && identity.value_normalized == normalized
        })
        .ok_or_else(|| AppError::internal("matched inbound identity missing"))?;
    r.messages()
        .record_inbound_sender(message_id, sender.id)
        .await?;
    r.conversations().lock_for_person(person.id).await?;
    let j = journey(deps, ctx, r, &person).await?;
    if j.status == JourneyStatus::Lost {
        r.conversations()
            .update_executor(conv.id, Executor::Human { user_id: None })
            .await?;
    }
    apply(deps, ctx, r, j, key, JourneyEventKind::MessageReceived).await?;
    Ok("consumed")
}
async fn find_message(
    r: &mut dyn TenantRepos,
    conversation: ConversationId,
    external: &str,
) -> Result<Option<Message>, AppError> {
    let mut cursor = None;
    loop {
        let page = r.messages().page(conversation, cursor, 100).await?;
        if page.is_empty() {
            return Ok(None);
        }
        for m in page {
            cursor = Some((m.at, m.id));
            if m.external_id.as_deref() == Some(external) {
                return Ok(Some(m));
            }
        }
    }
}
async fn outbound(
    r: &mut dyn TenantRepos,
    cap: &Capability,
    external: &str,
) -> Result<Option<Message>, AppError> {
    let mut cursor = None;
    loop {
        let page = r
            .conversations()
            .page(ConversationQueue::All, cursor, 100)
            .await?;
        if page.is_empty() {
            return Ok(None);
        }
        for c in page {
            cursor = Some((c.created_at, c.id));
            if c.capability_id == cap.id
                && let Some(m) = find_message(r, c.id, external).await?
                && m.direction == Direction::Outbound
            {
                return Ok(Some(m));
            }
        }
    }
}
fn sender_key(cap: &Capability, channel: Channel, sender: &str) -> Result<String, AppError> {
    let normalized = normalise(channel.identity_channel(), sender).map_err(|_| malformed())?;
    Ok(match channel.identity_channel() {
        IdentityChannel::Phone | IdentityChannel::Email => normalized,
        _ => scope_opaque(
            cap.external_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or_else(malformed)?,
            &normalized,
        ),
    })
}
async fn echo(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
    channel: Channel,
) -> Result<&'static str, AppError> {
    let content = decode(event, channel, true)?;
    if outbound(r, cap, &content.external_id).await?.is_some() {
        return Ok("duplicate");
    }
    let identity = sender_key(cap, channel, &content.sender)?;
    // An echo cannot establish an inbound reply window. Keep orphan echoes for a later consumer.
    let Some(person) = r
        .people()
        .find_by_identity(channel.identity_channel(), &identity)
        .await?
    else {
        return Ok("deferred");
    };
    let Some(conv) = r.conversations().find(person.id, cap.id).await? else {
        return Ok("deferred");
    };
    r.messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: conv.id,
            direction: Direction::Outbound,
            author: Author::System,
            body: content.body,
            external_id: Some(content.external_id),
            status: MsgStatus::Sent,
            cost_minor: None,
            at: event.received_at,
        })
        .await?;
    Ok("consumed")
}
async fn status(
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let p = &event.payload;
    let (id, status) = if event.provider == Provider::Meta {
        if let Some(id) = text(&p["status"], "id") {
            (
                id,
                match text(&p["status"], "status") {
                    Some("delivered" | "read") => MsgStatus::Delivered,
                    Some("failed") => MsgStatus::Failed,
                    _ => return Ok("deferred"),
                },
            )
        } else if let Some(id) = text(p, "mid") {
            (id, MsgStatus::Delivered)
        } else {
            return Err(malformed());
        }
    } else {
        return Ok("deferred");
    };
    let Some(m) = outbound(r, cap, id).await? else {
        return Ok("deferred");
    };
    r.messages()
        .set_status(m.id, status, m.external_id, m.cost_minor)
        .await?;
    Ok("consumed")
}
async fn call(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let Some(id) = text(&event.payload, "unique_id") else {
        return Ok("deferred");
    };
    let key = format!("call:{id}");
    if r.journeys().event_by_key(&key).await?.is_some() {
        return Ok("duplicate");
    }
    let scenario = text(&event.payload, "scenario").ok_or_else(malformed)?;
    if !matches!(scenario, "inbound_call" | "answer" | "hangup") {
        return Ok("deferred");
    }
    let mut sender = text(&event.payload, "customer_num").map(str::to_owned);
    let mut answered = false;
    let mut cursor = None;
    'history: loop {
        let page = r
            .inbound_events()
            .list(EventQuery {
                pending_only: false,
                provider: Some(Provider::Netgsm),
                kind: Some(EventKind::CallEvent),
                order: EventOrder::OldestFirst { after: cursor },
                limit: 100,
            })
            .await?;
        if page.is_empty() {
            break;
        }
        for e in page {
            let position = (e.received_at, e.id);
            cursor = Some(position);
            if position > (event.received_at, event.id) {
                break 'history;
            }
            if e.capability_id != Some(cap.id) || text(&e.payload, "unique_id") != Some(id) {
                continue;
            }
            answered |= text(&e.payload, "scenario") == Some("answer");
            if sender.is_none() {
                sender = text(&e.payload, "customer_num").map(str::to_owned);
            }
        }
    }
    let content = Content {
        sender: sender.ok_or_else(malformed)?,
        body: String::new(),
        external_id: String::new(),
        name: String::new(),
    };
    let person = contact(deps, ctx, r, cap, Channel::Phone, &content).await?;
    // Terminal-call semantics require a coordinator decision: the reducer refuses CallMade
    // on Lost. Defer without partially reopening/fencing the conversation or inventing a decision.
    if r.journeys()
        .latest_for(person.id)
        .await?
        .is_some_and(|j| j.status == JourneyStatus::Lost)
    {
        return Ok("deferred");
    }
    if scenario != "hangup" && !r.consumption().try_claim(PBX_ACTIVITY, event.id).await? {
        return Ok("duplicate");
    }
    conversation(deps, ctx, r, event, cap, person.id).await?;
    if scenario == "hangup" {
        r.conversations().lock_for_person(person.id).await?;
        let j = journey(deps, ctx, r, &person).await?;
        apply(
            deps,
            ctx,
            r,
            j,
            key,
            JourneyEventKind::CallMade {
                connected: answered,
            },
        )
        .await?;
    } else {
        r.consumption()
            .record(
                PBX_ACTIVITY,
                event.id,
                ConsumptionOutcome {
                    consumed_at: ctx.now,
                    outcome: "consumed".into(),
                },
            )
            .await?;
    }
    Ok("consumed")
}
