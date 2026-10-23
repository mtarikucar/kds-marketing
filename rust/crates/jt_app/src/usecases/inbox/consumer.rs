//! Trusted system consumer. Claims, facts and completion share one tenant transaction.
use super::{journeys, people, record};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{CapabilityFilter, TenantRepos, inbox::ConsumptionOutcome},
    usecases::{Deps, jobs::JobReport},
};
use jt_capability::{Capability, StoredStatus};
use jt_connector::{EventKind, InboundEvent, Provider};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

pub const CONSUMER: &str = "inbox@2";
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
    let Some(mut cap) = r.capabilities().find(id).await? else {
        return Ok("deferred");
    };
    // Webhook routing may select the newer Page/profile capability for this same account.
    if event.provider == Provider::Meta
        && matches!(
            event.kind,
            EventKind::Message | EventKind::MessageEcho | EventKind::Status
        )
        && let Some(kind) = match cap.kind_key.as_str() {
            "facebook_page" => Some("messenger"),
            "instagram" => Some("instagram_dm"),
            _ => None,
        }
    {
        let Some(account) = cap.external_id.as_deref().filter(|id| !id.is_empty()) else {
            return Ok("deferred");
        };
        let sibling = r
            .capabilities()
            .list(CapabilityFilter {
                kind: Some(kind),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|c| {
                c.status != StoredStatus::Retired && c.external_id.as_deref() == Some(account)
            });
        let Some(sibling) = sibling else {
            return Ok("deferred");
        };
        cap = sibling;
    }
    if event.kind == EventKind::Consent {
        return consent_event(deps, ctx, r, event, &cap).await;
    }
    let Some(channel) = channel_for_kind(&cap.kind_key) else {
        return Ok("deferred");
    };
    if event.provider == Provider::Mail
        && channel == Channel::Email
        && event.kind == EventKind::Status
    {
        return mail_evidence(deps, ctx, r, event, &cap).await;
    }
    match event.kind {
        EventKind::Message
            if matches!(
                (event.provider, channel),
                (
                    Provider::Meta,
                    Channel::WhatsApp | Channel::Messenger | Channel::InstagramDm
                ) | (Provider::Netgsm, Channel::Sms)
                    | (Provider::Mail, Channel::Email)
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
// Validate against arrival, not processing time: retries must not make a future timestamp valid.
fn activity_at(event: &InboundEvent) -> OffsetDateTime {
    text(&event.payload, "occurred_at")
        .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
        .filter(|at| *at <= event.received_at + Duration::minutes(5))
        .unwrap_or(event.received_at)
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
        (Provider::Mail, Channel::Email) => (
            text(p, "from"),
            text(p, "text"),
            text(p, "message_id").or(Some(event.external_id.as_str())),
            None,
        ),
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
            last_inbound_at: Some(activity_at(event)),
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
    let initial = journeys::initial(deps, ctx, person.id, source);
    let j = initial.journey().clone();
    r.journeys().insert_initial(initial).await?;
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
    let policy = ReducePolicy {
        unreachable_threshold: r
            .workspace_policy()
            .get()
            .await?
            .inbox
            .unreachable_threshold,
    };
    let transition = reduce(&j, &event, &policy)
        .map_err(|_| AppError::conflict("inbound journey transition refused"))?;
    let effects = transition.effects().to_vec();
    r.journeys()
        .apply_transition(j.id, transition, event)
        .await?;
    journeys::apply_effects(deps, ctx, r, &j, &effects).await?;
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
    // Check message identity before reopening or fencing: replay has no domain effects.
    if r.messages()
        .find_by_external_id(cap.id, &content.external_id)
        .await?
        .is_some()
    {
        return Ok("duplicate");
    }
    let person = contact(deps, ctx, r, cap, channel, &content).await?;
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
            at: activity_at(event),
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
async fn outbound(
    r: &mut dyn TenantRepos,
    cap: &Capability,
    external: &str,
) -> Result<Option<Message>, AppError> {
    Ok(r.messages()
        .find_by_external_id(cap.id, external)
        .await?
        .filter(|m| m.direction == Direction::Outbound))
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
    let candidates = r
        .messages()
        .echo_candidates(conv.id, &content.body, event.received_at)
        .await?;
    match candidates.as_slice() {
        [sent] => {
            // Only bind the provider id. Receipt finalization owns status/cost/outbox transitions.
            r.messages()
                .set_status(
                    sent.id,
                    sent.status.clone(),
                    Some(content.external_id),
                    sent.cost_minor,
                )
                .await?;
            return Ok("consumed");
        }
        [] => {}
        _ => return Ok("deferred"),
    }
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
            at: activity_at(event),
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
    for sibling in r
        .inbound_events()
        .call_events(id, event.received_at)
        .await?
    {
        answered |= text(&sibling.payload, "scenario") == Some("answer");
        if sender.is_none() {
            sender = text(&sibling.payload, "customer_num").map(str::to_owned);
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

/// Correlation requires the exact persisted Message-ID and capability. Never match text, an
/// arbitrary UUID, or a different mailbox's evidence. Claim + result commit together.
async fn mail_evidence(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let Some(mid) = text(&event.payload, "message_id") else {
        return Ok("deferred");
    };
    let Some(id) = mid
        .strip_prefix('<')
        .and_then(|s| s.split_once('@'))
        .and_then(|(id, _)| uuid::Uuid::parse_str(id).ok())
    else {
        return Ok("deferred");
    };
    let Some(row) = r.outbox().get(id).await? else {
        return Ok("deferred");
    };
    if row.capability_id != cap.id || row.intent["mail"]["message_id"].as_str() != Some(mid) {
        return Ok("deferred");
    }
    let result = match text(&event.payload, "status") {
        Some("sent") => Ok(crate::ports::connectors::SendReceipt {
            provider_id: mid.into(),
            cost_minor: None,
        }),
        Some("failed" | "complaint") => Err(jt_connector::ConnectorError::permanent(
            "mail delivery failed",
        )),
        _ => return Ok("deferred"),
    };
    if row.state == "queued" {
        return Ok("deferred");
    }
    super::replies::record_result_in(deps, ctx, r, id, result, true).await?;
    if matches!(text(&event.payload, "status"), Some("failed" | "complaint")) {
        let conversation = r
            .conversations()
            .get(row.conversation_id)
            .await?
            .ok_or_else(malformed)?;
        let reason = if text(&event.payload, "status") == Some("complaint") {
            SuppressionReason::Complaint
        } else {
            SuppressionReason::Bounce
        };
        r.suppressions()
            .insert(Suppression {
                person_id: conversation.person_id,
                channel: Channel::Email,
                reason,
            })
            .await?;
        record(
            r,
            ctx,
            "inbox.suppression.received",
            "person",
            conversation.person_id,
            json!({"person_id":conversation.person_id,"channel":"email","reason":reason}),
        )
        .await?;
        let m = r
            .messages()
            .get(row.message_id)
            .await?
            .ok_or_else(malformed)?;
        r.messages()
            .set_status(m.id, MsgStatus::Failed, m.external_id, m.cost_minor)
            .await?;
    }
    Ok("consumed")
}

async fn consent_event(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let p = &event.payload;
    let (channel, recipient, kind, source) = match event.provider {
        Provider::Netgsm if matches!(cap.kind_key.as_str(), "sms_line" | "netgsm_pbx") => {
            let channel = match text(p, "channel") {
                Some("MESAJ") => Channel::Sms,
                Some("ARAMA") => Channel::Phone,
                Some("EPOSTA") => Channel::Email,
                _ => return Ok("deferred"),
            };
            let kind = match (text(p, "status"), p["granted"].as_bool()) {
                (Some("ONAY"), Some(true)) => ConsentKind::Explicit,
                (Some("RET"), Some(false)) => ConsentKind::Withdrawn,
                _ => return Err(malformed()),
            };
            (
                channel,
                text(p, "recipient").ok_or_else(malformed)?,
                kind,
                ConsentSource::IysSync,
            )
        }
        Provider::Mail
            if cap.kind_key == "mailbox" && p["withdrawn"] == true && p["channel"] == "email" =>
        {
            (
                Channel::Email,
                text(p, "from").ok_or_else(malformed)?,
                ConsentKind::Withdrawn,
                ConsentSource::Customer,
            )
        }
        _ => return Ok("deferred"),
    };
    let at = if kind == ConsentKind::Explicit {
        // Arrival time is not proof of a grant's effective time: delayed callbacks must
        // never manufacture permission newer than a recorded withdrawal.
        let Some(at) = text(p, "occurred_at")
            .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
            .filter(|at| *at <= event.received_at && *at <= ctx.now)
        else {
            return Ok("deferred");
        };
        at
    } else {
        activity_at(event)
    };
    let normalized = normalise(channel.identity_channel(), recipient).map_err(|_| malformed())?;
    let Some(person) = r
        .people()
        .find_by_identity(channel.identity_channel(), &normalized)
        .await?
    else {
        return Ok("deferred");
    };
    let row = Consent {
        id: ConsentId::from(deps.ids.uuid()),
        person_id: person.id,
        channel,
        kind,
        source,
        at,
        sync_state: if source == ConsentSource::IysSync {
            SyncState::Sent
        } else {
            SyncState::Pending
        },
        attempts: 0,
    };
    r.consents().insert(row.clone()).await?;
    if kind == ConsentKind::Withdrawn {
        r.suppressions()
            .insert(Suppression {
                person_id: person.id,
                channel,
                reason: SuppressionReason::Unsubscribe,
            })
            .await?;
    }
    record(
        r,
        ctx,
        "inbox.consent.received",
        "person",
        person.id,
        json!({"person_id":person.id,"consent_id":row.id,"channel":channel,"kind":kind}),
    )
    .await?;
    Ok("consumed")
}
