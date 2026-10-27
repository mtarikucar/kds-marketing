//! Durable replies: commit the intent, claim under fresh fences, call without locks, then
//! atomically record the result. An uncertain provider write is never retried.
use super::record;
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{
        TenantRepos,
        connectors::{MailMessage, SendReceipt},
        inbox::OutboxRow,
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        failure, required,
    },
};
use jt_capability::{Capability, EffectiveStatus, effective_status};
use jt_connector::{ConnectorError, Credential, Provider, provider_for_kind};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::{Permission, WorkspaceStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Duration;
use uuid::Uuid;

pub use jt_inbox::SendIntent;
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyInput {
    pub text: String,
    pub intent: SendIntent,
    #[serde(default)]
    pub request_key: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyOut {
    pub message_id: MessageId,
    pub state: String,
}

fn output(row: &OutboxRow) -> ReplyOut {
    ReplyOut {
        message_id: row.message_id,
        state: row.state.clone(),
    }
}
fn refused(reason: impl Into<String>) -> AppError {
    let reason = reason.into();
    AppError {
        code: ErrorCode::Forbidden,
        message: reason.clone(),
        details: json!({"reason":reason}),
    }
}
fn fresh(deps: &Deps, ctx: &Ctx) -> Ctx {
    Ctx {
        now: deps.clock.now().max(ctx.now),
        ..ctx.clone()
    }
}

/// Public boundary. A live request key wins even if the conversation has changed since the
/// original response. In-flight repeats return its durable queued response without a new send.
pub async fn reply(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
    input: ReplyInput,
) -> Result<ReplyOut, AppError> {
    let queued = enqueue(deps, ctx, id, input).await?;
    match queued {
        Enqueued::Existing(out) => Ok(out),
        Enqueued::New(id) => send_step(deps, ctx, id).await,
    }
}

#[derive(Debug)]
pub enum Enqueued {
    Existing(ReplyOut),
    New(Uuid),
}

/// Phase A, also usable by trusted internal producers. Every user permission/fence applies.
pub async fn enqueue(
    deps: &Deps,
    ctx: &Ctx,
    id: ConversationId,
    input: ReplyInput,
) -> Result<Enqueued, AppError> {
    enqueue_target(deps, ctx, Target::Conversation(id), input).await
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendInput {
    pub channel: Channel,
    pub text: String,
    pub intent: SendIntent,
    #[serde(default)]
    pub request_key: Option<String>,
}

pub async fn send(
    deps: &Deps,
    ctx: &Ctx,
    person: PersonId,
    input: SendInput,
) -> Result<ReplyOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    if input.intent != SendIntent::Commercial {
        return Err(AppError::validation(
            "send requires commercial intent",
            json!({"field":"intent"}),
        ));
    }
    let input_reply = ReplyInput {
        text: input.text,
        intent: input.intent,
        request_key: input.request_key,
        subject: None,
        in_reply_to: None,
        references: vec![],
    };
    match enqueue_target(
        deps,
        ctx,
        Target::Person(person, input.channel),
        input_reply,
    )
    .await?
    {
        Enqueued::Existing(out) => Ok(out),
        Enqueued::New(id) => send_step(deps, ctx, id).await,
    }
}
pub(super) enum Target {
    Conversation(ConversationId),
    Person(PersonId, Channel),
}
async fn enqueue_target(
    deps: &Deps,
    ctx: &Ctx,
    target: Target,
    input: ReplyInput,
) -> Result<Enqueued, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let result = enqueue_in(deps, ctx, r.as_mut(), target, input, Purpose::Reply).await;
    if result.is_ok()
        || result
            .as_ref()
            .is_err_and(|e| e.code == ErrorCode::Forbidden)
    {
        r.commit().await?;
    }
    result
}

pub(super) enum Purpose<'a> {
    Reply,
    Quote(&'a crate::ports::compliance::QuoteRow, Option<&'a str>),
    Appointment(&'a crate::ports::compliance::AppointmentRow),
}

/// Shared phase A: caller owns the workspace lock and commits related business rows atomically.
pub(super) async fn enqueue_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    target: Target,
    input: ReplyInput,
    purpose: Purpose<'_>,
) -> Result<Enqueued, AppError> {
    ctx.require(Permission::InboxWork)?;
    let key = input
        .request_key
        .as_deref()
        .map(|s| required("request_key", s))
        .transpose()?;
    if let Some(key) = &key
        && let Some(out) = r.request_keys().get(key, ctx.now).await?
    {
        return Ok(Enqueued::Existing(serde_json::from_value(out)?));
    }
    let text = required("text", &input.text)?;
    if text.len() > 1_000_000 {
        return Err(AppError::validation(
            "message too large",
            json!({"field":"text"}),
        ));
    }
    let c = match target {
        Target::Conversation(id) => lock_conversation(r, id).await?,
        Target::Person(person, channel) => {
            let kind = match channel {
                Channel::Sms => "sms_line",
                Channel::Email => "mailbox",
                Channel::WhatsApp => "whatsapp_cloud",
                Channel::Messenger => "messenger",
                Channel::InstagramDm => "instagram_dm",
                _ => {
                    return Err(AppError::validation(
                        "unsupported send channel",
                        json!({"field":"channel"}),
                    ));
                }
            };
            let mut caps = r
                .capabilities()
                .list(crate::ports::CapabilityFilter {
                    kind: Some(kind),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .filter(|c| {
                    effective_status(c, ctx.now) == EffectiveStatus::Verified && c.has_sealed_config
                });
            let cap = caps.next().ok_or_else(|| refused("capability_down"))?;
            if caps.next().is_some() {
                return Err(AppError::conflict("ambiguous send capability"));
            }
            match r.conversations().find(person, cap.id).await? {
                Some(c) => c,
                None => Conversation {
                    id: ConversationId::from(deps.ids.uuid()),
                    workspace_id: ctx.workspace_id,
                    person_id: person,
                    capability_id: cap.id,
                    kind_key: kind.into(),
                    state: ConvState::Open,
                    executor: Executor::Agent,
                    executor_generation: 0,
                    last_inbound_at: None,
                    last_outbound_at: None,
                    created_at: ctx.now,
                    updated_at: ctx.now,
                },
            }
        }
    };
    let id = c.id;
    let j = lock_current_journey(r, c.person_id).await?;
    let author = match ctx.actor {
        Actor::Human { user_id } => Author::Human(user_id),
        Actor::Agent { .. } => Author::Agent,
        Actor::System { .. } => Author::System,
    };
    let cap = capability(r, &c).await?;
    if let Err(error) = fence(
        r,
        ctx,
        &c,
        j.as_ref(),
        &cap,
        c.executor_generation,
        (author, input.intent),
    )
    .await
    {
        if error.code == ErrorCode::Forbidden {
            record(
                r,
                ctx,
                "inbox.send.refused",
                "person",
                c.person_id,
                json!({"person_id":c.person_id,"reason":error.message}),
            )
            .await?;
        }
        return Err(error);
    }
    // Only an accepted send may create a conversation. No inbound time is manufactured.
    if r.conversations().get(id).await?.is_none() {
        r.conversations().insert_for_send(c.clone()).await?;
    }
    // Validate recipient ambiguity before creating any durable outbound intent.
    let recipient = recipient(r, &c, &cap).await?;
    let message_id = MessageId::from(deps.ids.uuid());
    let outbox_id = deps.ids.uuid();
    let mut intent = json!({"kind":input.intent,"request_key":key});
    match &purpose {
        Purpose::Reply => {}
        Purpose::Quote(quote, key) => {
            intent["quote_id"] = json!(quote.id);
            intent["quote_response"] = serde_json::to_value(quote)?;
            intent["request_key"] = json!(key);
        }
        Purpose::Appointment(appointment) => intent["appointment_id"] = json!(appointment.id),
    }

    if cap.kind_key == "mailbox" {
        let base = deps
            .apps
            .public_base_url()
            .ok_or_else(|| AppError::conflict("public base URL required for mail"))?;
        let host = base
            .host_str()
            .ok_or_else(|| AppError::conflict("public base host required for mail"))?;
        let header = |value: &str| -> Result<(), AppError> {
            if value.len() > 998 || value.chars().any(char::is_control) {
                return Err(AppError::validation(
                    "invalid mail header",
                    json!({"field":"mail"}),
                ));
            }
            Ok(())
        };
        let subject = input.subject.unwrap_or_else(|| "Re:".into());
        header(&subject)?;
        let in_reply_to = match input.in_reply_to {
            Some(id) => Some(id),
            None => r
                .messages()
                .recent(c.id, 500)
                .await?
                .into_iter()
                .rev()
                .find(|m| m.direction == Direction::Inbound)
                .and_then(|m| m.external_id)
                .filter(|id| id.starts_with('<') && id.ends_with('>')),
        };
        let mut references = input.references;
        if let Some(id) = &in_reply_to {
            header(id)?;
            if !references.contains(id) {
                references.push(id.clone());
            }
        }
        if references.len() > 50 {
            return Err(AppError::validation(
                "too many mail references",
                json!({"field":"references"}),
            ));
        }
        for reference in &references {
            header(reference)?;
        }
        intent["mail_account"] = json!(cap.external_id);
        intent["mail_hosts"] = cap.connector_public["hosts"].clone();
        let attachments = if let Purpose::Appointment(appointment) = &purpose {
            let sealed = r
                .capabilities()
                .read_sealed(cap.id)
                .await?
                .ok_or_else(|| AppError::conflict("mailbox credentials unavailable"))?;
            let Credential::Mailbox { from_address, .. } =
                open_credential(deps, ctx.workspace_id, &sealed)?
            else {
                return Err(AppError::conflict("mailbox credentials required"));
            };
            vec![crate::ports::connectors::Attachment {
                filename: "appointment.ics".into(),
                mime: "text/calendar".into(),
                bytes: ics(
                    &appointment.appointment,
                    &from_address,
                    &recipient,
                    &appointment.id.to_string(),
                )
                .into_bytes(),
            }]
        } else {
            vec![]
        };
        intent["mail"] = serde_json::to_value(MailMessage {
            to: recipient,
            subject,
            text: text.clone(),
            message_id: format!("<{outbox_id}@{host}>"),
            in_reply_to,
            references,
            attachments,
        })?;
    } else if input.subject.is_some() || input.in_reply_to.is_some() || !input.references.is_empty()
    {
        return Err(AppError::validation(
            "mail headers require an email conversation",
            json!({"field":"subject"}),
        ));
    }
    let row = OutboxRow {
        id: outbox_id,
        workspace_id: ctx.workspace_id,
        conversation_id: id,
        message_id,
        capability_id: c.capability_id,
        intent,
        expected_generation: c.executor_generation,
        fence_snapshot: None,
        conversation_merged: false,
        state: "queued".into(),
        attempts: 0,
        last_error: None,
        created_at: ctx.now,
        updated_at: ctx.now,
    };
    let out = output(&row);
    if let Some(key) = &key
        && !r
            .request_keys()
            .store(key, serde_json::to_value(&out)?, ctx.now)
            .await?
    {
        return Err(AppError::conflict("request key changed while enqueueing"));
    }
    r.messages()
        .insert_if_new(Message {
            id: message_id,
            workspace_id: ctx.workspace_id,
            conversation_id: id,
            direction: Direction::Outbound,
            author,
            body: text,
            external_id: None,
            status: MsgStatus::Queued,
            cost_minor: None,
            at: ctx.now,
        })
        .await?;
    r.outbox().insert(row.clone()).await?;
    record(
        r,
        ctx,
        "inbox.reply.queued",
        "outbox",
        row.id,
        json!({"conversation_id":id,"message_id":message_id}),
    )
    .await?;
    Ok(Enqueued::New(row.id))
}
async fn lock_conversation(
    r: &mut dyn TenantRepos,
    id: ConversationId,
) -> Result<Conversation, AppError> {
    r.conversations()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))
}
async fn lock_current_journey(
    r: &mut dyn TenantRepos,
    person: PersonId,
) -> Result<Option<Journey>, AppError> {
    match super::active_or_latest_journey(r, person).await? {
        Some(j) => r.journeys().lock(j.id).await,
        None => Ok(None),
    }
}
async fn capability(r: &mut dyn TenantRepos, c: &Conversation) -> Result<Capability, AppError> {
    r.capabilities()
        .find(c.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such capability"))
}
async fn fence(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    c: &Conversation,
    j: Option<&Journey>,
    cap: &Capability,
    generation: u32,
    purpose: (Author, SendIntent),
) -> Result<(), AppError> {
    let (author, intent) = purpose;
    let person = r
        .people()
        .get(c.person_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    let channel =
        channel_for_kind(&c.kind_key).ok_or_else(|| refused("unsupported_reply_channel"))?;
    let history = super::consent::history(r, c.person_id).await?;
    let consents: Vec<_> = history
        .consents
        .into_iter()
        .map(|mut row| {
            row.person_id = c.person_id;
            row
        })
        .collect();
    let suppressions: Vec<_> = history
        .suppressions
        .into_iter()
        .map(|mut row| {
            row.person_id = c.person_id;
            row
        })
        .collect();
    may_send(
        &FenceCtx {
            journey_status: j.map(|j| j.status),
            suppressed: suppressions.iter().any(|s| s.channel == channel),
            consent_ok: commercial_allowed(&consents, &suppressions, channel).is_ok(),
            intent,
            person_erased: person.erased_at.is_some(),
            person_merged: person.merged_into.is_some(),
            conversation_state: c.state.clone(),
            expected_generation: generation,
            current_generation: c.executor_generation,
            executor_is_agent: c.executor == Executor::Agent,
            capability_live: effective_status(cap, ctx.now) == EffectiveStatus::Verified
                && cap.has_sealed_config,
        },
        matches!(author, Author::Agent),
    )
    .map_err(|e| refused(e.to_string()))?;
    let window_open = c.last_inbound_at.is_some_and(|at| {
        at <= ctx.now + Duration::minutes(5) && ctx.now - at <= Duration::hours(24)
    });
    if !window_open {
        if intent == SendIntent::Commercial
            && matches!(
                channel,
                Channel::WhatsApp | Channel::Messenger | Channel::InstagramDm
            )
        {
            // Templates and message tags are deferred to M2c; ordinary Meta sends require
            // the provider's window even when local commercial consent is present.
            return Err(AppError::validation(
                "provider_window_closed",
                json!({"reason": "provider_window_closed"}),
            ));
        }
        if intent == SendIntent::Reply {
            return Err(refused("reply_window_closed"));
        }
    }
    // Recovery must honor the same workspace gate as the public surfaces.
    if r.workspace().get().await?.status != WorkspaceStatus::Active {
        return Err(refused("workspace_inactive"));
    }
    if r.strategy().current_approved().await?.is_none() {
        return Err(refused("strategy_required"));
    }
    Ok(())
}

struct Prepared {
    row: OutboxRow,
    message: Message,
    capability: Capability,
    credential: Credential,
    recipient: String,
    provider: Provider,
}
enum Claim {
    Ready(Box<Prepared>),
    Done(ReplyOut),
}

/// Phase B. The workspace serialization lock is shared with merge/journey mutations; inside
/// it, acquire conversation → journey → outbox. All are released before returning Ready.
async fn claim(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<Claim, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.strategy().lock_execution_frame().await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let hint = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    let c = lock_conversation(r.as_mut(), hint.conversation_id).await?;
    let j = lock_current_journey(r.as_mut(), c.person_id).await?;
    let mut row = r
        .outbox()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    if row.state != "queued" {
        return Ok(Claim::Done(output(&row)));
    }
    let message = r
        .messages()
        .get(row.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such message"))?;
    let cap = capability(r.as_mut(), &c).await?;
    if let Some(quote_id) = row.intent.get("quote_id") {
        let quote_id = serde_json::from_value(quote_id.clone())?;
        let quote = r
            .quotes()
            .get(quote_id)
            .await?
            .ok_or_else(|| AppError::internal("outbox quote missing"))?;
        if quote.quote.valid_until <= ctx.now || quote.quote.state == QuoteState::Expired {
            r.quotes().set_state(quote_id, QuoteState::Expired).await?;
            row.state = "refused".into();
            row.last_error = Some("quote_expired".into());
            row.updated_at = ctx.now;
            r.messages()
                .set_status(
                    row.message_id,
                    MsgStatus::Refused {
                        reason: "quote_expired".into(),
                    },
                    None,
                    None,
                )
                .await?;
            save_result(r.as_mut(), ctx, &row).await?;
            r.commit().await?;
            return Ok(Claim::Done(output(&row)));
        }
    }
    if let Some(appointment_id) = row.intent.get("appointment_id") {
        let appointment_id = serde_json::from_value(appointment_id.clone())?;
        let booked = r
            .appointments()
            .get(appointment_id)
            .await?
            .is_some_and(|a| a.appointment.state == AppointmentState::Booked);
        if !booked {
            row.state = "refused".into();
            row.last_error = Some("appointment_not_booked".into());
            row.updated_at = ctx.now;
            r.messages()
                .set_status(
                    row.message_id,
                    MsgStatus::Refused {
                        reason: "appointment_not_booked".into(),
                    },
                    None,
                    None,
                )
                .await?;
            save_result(r.as_mut(), ctx, &row).await?;
            r.commit().await?;
            return Ok(Claim::Done(output(&row)));
        }
    }
    if let Err(e) = fence(
        r.as_mut(),
        ctx,
        &c,
        j.as_ref(),
        &cap,
        row.expected_generation,
        (
            message.author,
            serde_json::from_value(row.intent["kind"].clone())?,
        ),
    )
    .await
    {
        if !matches!(e.code, ErrorCode::Forbidden | ErrorCode::Validation) {
            return Err(e);
        }
        row.state = "refused".into();
        row.last_error = Some(e.message.clone());
        row.updated_at = ctx.now;
        r.messages()
            .set_status(
                row.message_id,
                MsgStatus::Refused {
                    reason: e.message.clone(),
                },
                None,
                None,
            )
            .await?;
        save_result(r.as_mut(), ctx, &row).await?;
        r.commit().await?;
        if e.code == ErrorCode::Validation {
            return Err(e);
        }
        return Ok(Claim::Done(output(&row)));
    }
    let prepared = prepare(deps, r.as_mut(), &c, &cap)
        .await
        .and_then(|prepared| {
            if cap.kind_key == "mailbox" {
                let reason = if row.intent["mail_account"] != json!(cap.external_id)
                    || row.intent["mail_hosts"] != cap.connector_public["hosts"]
                {
                    Some("mailbox_binding_changed")
                } else if row.intent["mail"]["to"].as_str() != Some(prepared.1.as_str()) {
                    Some("reply_recipient_changed")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    return Err(AppError::validation(
                        "email binding changed after enqueue",
                        json!({"reason":reason}),
                    ));
                }
            }
            Ok(prepared)
        });
    let (credential, recipient, provider) = match prepared {
        Ok(p) => p,
        Err(e) if e.code == ErrorCode::Validation => {
            let reason = e
                .details
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("reply_recipient_unavailable")
                .to_owned();
            row.state = "refused".into();
            row.last_error = Some(reason.clone());
            row.updated_at = ctx.now;
            r.messages()
                .set_status(row.message_id, MsgStatus::Refused { reason }, None, None)
                .await?;
            save_result(r.as_mut(), ctx, &row).await?;
            r.commit().await?;
            return Err(e);
        }
        Err(e) => {
            row.state = "failed".into();
            row.last_error = Some("send_configuration_invalid".into());
            row.updated_at = ctx.now;
            r.messages()
                .set_status(row.message_id, MsgStatus::Failed, None, None)
                .await?;
            save_result(r.as_mut(), ctx, &row).await?;
            r.commit().await?;
            // The durable result exposes only a stable state, never credential/identity data.
            let _ = e;
            return Ok(Claim::Done(output(&row)));
        }
    };
    let spend = crate::usecases::studio::budget::reserve_metered(
        r.as_mut(),
        &cap,
        None,
        Some(if cap.kind_key == "sms_line" {
            u64::from(jt_inbox::sms_segments(&message.body))
        } else {
            1
        }),
        format!("outbox:{id}"),
        ctx.now,
    )
    .await?;
    if let Some(spend) = &spend {
        row.intent["spend_reservation"] = json!(spend.id);
    }
    let activity_revision = r.conversations().send_state(c.id).await?.activity_revision;
    let journey_reducer_revision = match &j {
        Some(j) => Some(r.journeys().reducer_revision(j.id).await?),
        None => None,
    };
    row.state = "sending".into();
    row.attempts += 1;
    row.updated_at = ctx.now;
    row.fence_snapshot = Some(
        json!({"conversation_id":c.id,"journey_id":j.as_ref().map(|j|j.id),"journey_updated_at":j.as_ref().map(|j|j.updated_at.unix_timestamp_nanos().to_string()),"journey_reducer_revision":journey_reducer_revision,"journey_status":j.as_ref().map(|j|j.status),"executor_generation":c.executor_generation,"activity_revision":activity_revision,"send_at":ctx.now.unix_timestamp_nanos().to_string(),"person_erased":false,"person_merged":false}),
    );
    r.outbox().update(row.clone()).await?;
    r.commit().await?;
    Ok(Claim::Ready(Box::new(Prepared {
        row,
        message,
        capability: cap,
        credential,
        recipient,
        provider,
    })))
}
async fn prepare(
    deps: &Deps,
    r: &mut dyn TenantRepos,
    c: &Conversation,
    cap: &Capability,
) -> Result<(Credential, String, Provider), AppError> {
    let provider =
        provider_for_kind(&cap.kind_key).ok_or_else(|| refused("unsupported_reply_channel"))?;
    if (cap.kind_key == "sms_line" && deps.connectors.sms(provider).is_none())
        || (cap.kind_key == "mailbox" && deps.connectors.mail_sender(provider).is_none())
        || (!matches!(cap.kind_key.as_str(), "sms_line" | "mailbox")
            && deps.connectors.messaging(provider).is_none())
    {
        return Err(refused("connector_unavailable"));
    }
    let recipient = recipient(r, c, cap).await?;
    let sealed = r
        .capabilities()
        .read_sealed(cap.id)
        .await?
        .ok_or_else(|| refused("capability_down"))?;
    let credential = open_credential(deps, c.workspace_id, &sealed)?;
    Ok((credential, recipient, provider))
}
async fn recipient(
    r: &mut dyn TenantRepos,
    c: &Conversation,
    cap: &Capability,
) -> Result<String, AppError> {
    let channel = match cap.kind_key.as_str() {
        "sms_line" | "whatsapp_cloud" => IdentityChannel::Phone,
        "mailbox" => IdentityChannel::Email,
        "instagram_dm" => IdentityChannel::InstagramDm,
        "messenger" => IdentityChannel::Messenger,
        _ => return Err(refused("unsupported_reply_channel")),
    };
    let binding = r
        .conversations()
        .send_state(c.id)
        .await?
        .last_inbound_identity_id;
    let prefix = cap.external_id.as_ref().map(|id| format!("{id}:"));
    let mut candidates = r
        .identities()
        .list(c.person_id)
        .await?
        .into_iter()
        .filter(|i| i.active && i.channel == channel)
        .filter_map(|i| {
            let value = if matches!(channel, IdentityChannel::Phone | IdentityChannel::Email) {
                Some(i.value_normalized)
            } else {
                prefix
                    .as_ref()
                    .and_then(|p| i.value_normalized.strip_prefix(p))
                    .map(str::to_owned)
            };
            value.map(|value| (i.id, value))
        });
    let invalid = |reason: &str| {
        AppError::validation(
            "reply recipient cannot be determined",
            json!({"reason":reason}),
        )
    };
    if let Some(binding) = binding {
        return candidates
            .find(|(id, _)| *id == binding)
            .map(|(_, value)| value)
            .ok_or_else(|| invalid("reply_recipient_unavailable"));
    }
    let first = candidates
        .next()
        .ok_or_else(|| invalid("reply_recipient_unavailable"))?;
    if candidates.next().is_some() {
        return Err(invalid("ambiguous_reply_recipient"));
    }
    Ok(first.1)
}

/// Claim at most once. A sending or terminal entry is never put to the provider again.
pub async fn send_step(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<ReplyOut, AppError> {
    // Mail intent is stored only by enqueue's mailbox branch. Release this discovery read
    // before refreshing: never wait for another pooled connection while holding inbox locks.
    let mail_queued = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.outbox()
            .get(id)
            .await?
            .is_some_and(|row| row.state == "queued" && row.intent.get("mail").is_some())
    };
    if mail_queued {
        crate::usecases::connector::refresh_tenant_hosts(deps, ctx.workspace_id).await?;
    }
    let ctx = fresh(deps, ctx);
    let p = match claim(deps, &ctx, id).await? {
        Claim::Done(out) => return Ok(out),
        Claim::Ready(p) => p,
    };
    let result = if p.capability.kind_key == "mailbox" {
        let mail: MailMessage = serde_json::from_value(p.row.intent["mail"].clone())?;
        deps.connectors
            .mail_sender(p.provider)
            .ok_or_else(|| AppError::internal("sender disappeared"))?
            .send(ctx.workspace_id, &p.credential, mail)
            .await
    } else if p.capability.kind_key == "sms_line" {
        deps.connectors
            .sms(p.provider)
            .ok_or_else(|| AppError::internal("sender disappeared"))?
            .send(
                &p.credential,
                &p.recipient,
                &p.message.body,
                Some(&id.to_string()),
                p.row.intent["kind"] == "commercial",
            )
            .await
    } else {
        deps.connectors
            .messaging(p.provider)
            .ok_or_else(|| AppError::internal("sender disappeared"))?
            .send_text(
                &p.credential,
                &adapter_public(&p.capability),
                &p.recipient,
                &p.message.body,
            )
            .await
    };
    record_result(deps, &fresh(deps, &ctx), p.row.id, result).await
}

/// Phase C and acceptance reconciliation. The original journey is retained across a later
/// inbound opening a new one. Replayed receipts use the same outbox event key.
pub async fn record_result(
    deps: &Deps,
    ctx: &Ctx,
    id: Uuid,
    result: Result<SendReceipt, ConnectorError>,
) -> Result<ReplyOut, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let out = record_result_in(deps, ctx, r.as_mut(), id, result, false).await?;
    r.commit().await?;
    Ok(out)
}

/// Consumer reconciliation runs inside its event-claim transaction.
pub(super) async fn record_result_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: Uuid,
    result: Result<SendReceipt, ConnectorError>,
    evidence: bool,
) -> Result<ReplyOut, AppError> {
    let hint = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    let c = lock_conversation(r, hint.conversation_id).await?;
    let journey_id = hint
        .fence_snapshot
        .as_ref()
        .and_then(|s| s.get("journey_id"))
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value::<JourneyId>(v.clone()))
        .transpose()?;
    let j = match journey_id {
        Some(id) => r.journeys().lock(id).await?,
        None => None,
    };
    let mut row = r
        .outbox()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    // Recovery may time out a live provider future. Its eventual result still resolves that
    // interrupted claim, including a definite failure; completed failures are never replayed.
    let recovered = row.last_error.as_deref() == Some("send_interrupted");
    if row.state != "sending"
        && !(row.state == "unknown" && (result.is_ok() || recovered || evidence))
    {
        return Ok(output(&row));
    }
    if let Some(spend) = r
        .studio_budget()
        .find_reservation(&format!("outbox:{id}"))
        .await?
    {
        crate::usecases::studio::budget::settle_metered(
            r,
            spend,
            result
                .as_ref()
                .map(|receipt| receipt.cost_minor)
                .map_err(|e| e.kind()),
        )
        .await?;
    }
    let (status, external, cost) = match result {
        Ok(receipt) => {
            let sent_at = row
                .fence_snapshot
                .as_ref()
                .and_then(|s| s.get("send_at"))
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<i128>().ok())
                .and_then(|n| time::OffsetDateTime::from_unix_timestamp_nanos(n).ok())
                .unwrap_or(row.created_at);
            row.state = "sent".into();
            row.last_error = None;
            let terminal = j
                .as_ref()
                .is_some_and(|j| matches!(j.status, JourneyStatus::Won | JourneyStatus::Lost));
            if let Some(j) = &j {
                let key = format!("outbox:{id}");
                if r.journeys().event_by_key(&key).await?.is_none() {
                    let event = JourneyEvent {
                        id: JourneyEventId::from(deps.ids.uuid()),
                        workspace_id: ctx.workspace_id,
                        journey_id: j.id,
                        source: EventSource::System,
                        idempotency_key: key,
                        kind: JourneyEventKind::Replied,
                        reason_label: None,
                        at: sent_at,
                    };
                    let unchanged = row
                        .fence_snapshot
                        .as_ref()
                        .and_then(|s| s.get("journey_updated_at"))
                        .and_then(Value::as_str)
                        == Some(j.updated_at.unix_timestamp_nanos().to_string().as_str());
                    // Notes, task edits and owner assignment touch updated_at but do not
                    // supersede a reply's domain transition. Legacy snapshots stay conservative.
                    let domain_unchanged = row
                        .fence_snapshot
                        .as_ref()
                        .and_then(|s| s.get("journey_reducer_revision"))
                        .and_then(Value::as_i64)
                        == Some(r.journeys().reducer_revision(j.id).await?);
                    // Inbound messages and other same-stage events do not supersede contact.
                    // A newer milestone or closure wins; old snapshots remain conservative.
                    let non_superseding = row
                        .fence_snapshot
                        .as_ref()
                        .filter(|s| s.get("journey_closed") != Some(&json!(true)))
                        .and_then(|s| s.get("journey_status"))
                        .and_then(|s| serde_json::from_value::<JourneyStatus>(s.clone()).ok())
                        .is_some_and(|before| {
                            j.closed_at.is_none()
                                && !matches!(j.status, JourneyStatus::Won | JourneyStatus::Lost)
                                && (before == j.status
                                    || matches!(
                                        (before, j.status),
                                        (JourneyStatus::Contacted, JourneyStatus::Unreachable)
                                            | (
                                                JourneyStatus::Unreachable,
                                                JourneyStatus::Contacted
                                            )
                                    ))
                        });
                    if unchanged || domain_unchanged || non_superseding {
                        let t = reduce(j, &event, &ReducePolicy::default())
                            .map_err(|_| AppError::internal("system reply reduction failed"))?;
                        r.journeys().apply_transition(j.id, t, event).await?;
                    } else {
                        r.journeys().append_historical_reply(event).await?;
                    }
                }
            }
            if let Some(quote_id) = row.intent.get("quote_id") {
                super::quotes::sent_in(
                    deps,
                    ctx,
                    r,
                    serde_json::from_value(quote_id.clone())?,
                    sent_at,
                    row.fence_snapshot
                        .as_ref()
                        .is_some_and(|s| s["journey_closed"] == true),
                )
                .await?;
            }
            if terminal {
                record(
                    r,
                    ctx,
                    "inbox.sent_after_terminal",
                    "outbox",
                    id,
                    json!({"message_id":row.message_id,"journey_id":journey_id}),
                )
                .await?;
            } else if !row.conversation_merged {
                // Coalesced sends reconcile receipts and journeys but never conversation activity,
                // even if undo has restored the original conversation before this receipt.
                // A moved outbox must not compare revisions from different conversations.
                // Send/message bookkeeping never invalidates this independent activity fence.
                let revision = row
                    .fence_snapshot
                    .as_ref()
                    .filter(|s| s.get("conversation_id") == Some(&json!(c.id)))
                    .and_then(|s| s.get("activity_revision"))
                    .and_then(Value::as_i64)
                    .unwrap_or(-1);
                r.conversations()
                    .record_outbound(c.id, revision, sent_at)
                    .await?;
            }
            (
                MsgStatus::Sent,
                Some(receipt.provider_id),
                receipt.cost_minor,
            )
        }
        Err(e) => {
            let reason = failure::failure_reason(provider_for_kind(&c.kind_key), &e);
            tracing::warn!(
                workspace_id = %ctx.workspace_id,
                capability_id = %row.capability_id.0,
                error_kind = e.kind(),
                http_status = ?failure::http_status(&reason),
                provider_code = ?failure::provider_code(&reason),
                "an outbound message could not be sent"
            );
            row.last_error = Some(reason);
            if matches!(e, ConnectorError::Unknown { .. }) {
                row.state = "unknown".into();
                (MsgStatus::Unknown, None, None)
            } else {
                row.state = "failed".into();
                (MsgStatus::Failed, None, None)
            }
        }
    };
    // An early echo can bind the id while provider I/O is still in flight. A delivery
    // report processed before acceptance bookkeeping outranks acceptance or a transport timeout.
    let status = if matches!(status, MsgStatus::Sent | MsgStatus::Unknown) {
        let message = r
            .messages()
            .get(row.message_id)
            .await?
            .ok_or_else(|| AppError::not_found("no such message"))?;
        if message.external_id.is_some()
            && (external.is_none() || message.external_id == external)
            && matches!(message.status, MsgStatus::Delivered | MsgStatus::Failed)
        {
            message.status
        } else {
            status
        }
    } else {
        status
    };
    row.updated_at = ctx.now;
    r.messages()
        .set_status(row.message_id, status, external, cost)
        .await?;
    save_result(r, ctx, &row).await?;
    Ok(output(&row))
}
pub(super) async fn save_result(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    row: &OutboxRow,
) -> Result<(), AppError> {
    r.outbox().update(row.clone()).await?;
    if let Some(key) = row.intent.get("request_key").and_then(Value::as_str) {
        let queued = ReplyOut {
            message_id: row.message_id,
            state: "queued".into(),
        };
        let unknown = ReplyOut {
            message_id: row.message_id,
            state: "unknown".into(),
        };
        let response_value = |delivery: ReplyOut| -> Result<Value, AppError> {
            let delivery = serde_json::to_value(delivery)?;
            Ok(match row.intent.get("quote_response") {
                Some(quote) => json!({"quote":quote,"delivery":delivery}),
                None => delivery,
            })
        };
        let response = response_value(output(row))?;
        if !r
            .request_keys()
            .complete(key, response_value(queued)?, response.clone())
            .await?
        {
            r.request_keys()
                .complete(key, response_value(unknown)?, response)
                .await?;
        }
    }
    record(
        r,
        ctx,
        "inbox.reply.result",
        "outbox",
        row.id,
        // The failure line stays on the outbox entry, which erasure clears; the append-only
        // ledger keeps only its kind.
        json!({"message_id":row.message_id,"state":row.state,"reason":row.last_error.as_deref().map(failure::failure_kind)}),
    )
    .await
}

/// Recover an abandoned sending claim under the same lock order; never resend it. A late
/// receipt may subsequently establish acceptance via record_result.
pub async fn recover_sending(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<bool, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let hint = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    let c = lock_conversation(r.as_mut(), hint.conversation_id).await?;
    lock_current_journey(r.as_mut(), c.person_id).await?;
    let mut row = r
        .outbox()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    if row.state != "sending" || row.updated_at >= ctx.now - Duration::minutes(2) {
        return Ok(false);
    }
    row.state = "unknown".into();
    row.last_error = Some("send_interrupted".into());
    row.updated_at = ctx.now;
    r.messages()
        .set_status(row.message_id, MsgStatus::Unknown, None, None)
        .await?;
    save_result(r.as_mut(), ctx, &row).await?;
    r.commit().await?;
    Ok(true)
}
