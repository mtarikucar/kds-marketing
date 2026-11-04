//! Durable replies: commit the intent, claim under fresh fences, call without locks, then
//! atomically record the result. An uncertain provider write is never retried.
use super::record;
use crate::{
    catalog::{self, GateMode},
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{
        TenantRepos,
        connectors::{MailMessage, PUBLIC_ITEM_GONE, SendReceipt},
        inbox::OutboxRow,
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        failure, required,
        studio::budget::is_metered,
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
    /// The comment or question replied to: required on a public conversation, refused on a
    /// private one (`item_requires_public_conversation`).
    #[serde(default)]
    pub item_id: Option<PublicItemId>,
    /// In front of everyone (the default) or privately to the item's author; public
    /// conversations only.
    #[serde(default)]
    pub visibility: Option<Visibility>,
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
/// The subject of a reply to mail whose subject is `original`: "Re: " and the original, its line
/// breaks and other control characters turned into single spaces, without a second reply prefix
/// ("Re:", "RE:", "Ynt:", "Aw:"), at most a header line (998 bytes); "Re:" when nothing is known.
fn reply_subject(original: Option<&str>) -> String {
    let flat: String = original
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return "Re:".into();
    }
    let lower = flat.to_lowercase();
    let mut subject = if ["re:", "ynt:", "aw:"].iter().any(|p| lower.starts_with(p)) {
        flat
    } else {
        format!("Re: {flat}")
    };
    if subject.len() > 998 {
        let mut end = 998;
        while !subject.is_char_boundary(end) {
            end -= 1;
        }
        subject.truncate(end);
    }
    subject
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
        item_id: None,
        visibility: None,
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

/// The use case that queues a send for `target` and `purpose`. It is recorded in the send's
/// intent (`use_case`), so a claim, recovery included, honours that use case's strategy gate again.
fn queued_by(target: &Target, purpose: &Purpose<'_>) -> &'static str {
    match (target, purpose) {
        (_, Purpose::Quote(..)) => "inbox.quotes.send",
        (_, Purpose::Appointment(_)) => "inbox.appointments.book",
        (Target::Conversation(_), Purpose::Reply) => "inbox.reply",
        (Target::Person(..), Purpose::Reply) => "inbox.send",
    }
}

/// The strategy gate of the use case a send's intent records. A send that records none was
/// queued before sends recorded it, when every send was queued behind the gate: it stays gated.
fn gate_of(use_case: Option<&str>) -> GateMode {
    use_case
        .and_then(catalog::find)
        .map_or(GateMode::Gated, |uc| uc.gate)
}

/// The strategy gate a send is held to: its use case's (`gate_of`), but always gated when the
/// send opens a conversation, which is contact nobody asked for (a quote or a booking mailed on a
/// channel the customer never wrote on included). Both facts are recorded in the send's intent.
fn send_gate(use_case: Option<&str>, opens_conversation: bool) -> GateMode {
    if opens_conversation {
        GateMode::Gated
    } else {
        gate_of(use_case)
    }
}

/// The strategy gate queued send `row` is held to again at claim and approval: `send_gate` of the
/// use case and the conversation opening its intent records.
fn queued_gate(row: &OutboxRow) -> GateMode {
    send_gate(
        row.intent.get("use_case").and_then(Value::as_str),
        row.intent
            .get("opens_conversation")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

/// How long after the customer's last message a commercial message in a conversation that is not
/// closed still answers them rather than reaching out to them: seven days, a working week of
/// back-and-forth (a quote a few days after the question). Later, or once the conversation is
/// closed, a commercial message is outreach and needs an approved strategy, on every channel.
/// Meta's channels refuse one outside their 24-hour window anyway; email and SMS have none.
pub const ANSWERING_WINDOW: Duration = Duration::days(7);

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
    let use_case = queued_by(&target, &purpose);
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
    let opens_conversation = r.conversations().get(id).await?.is_none();
    // A comment or question is answered by naming it; a direct message never names one.
    let public = public_channel_for_kind(&c.kind_key).is_some();
    if !public && (input.item_id.is_some() || input.visibility.is_some()) {
        return Err(AppError::validation(
            "item_id and visibility need a public conversation",
            json!({"field":"item_id","reason":"item_requires_public_conversation"}),
        ));
    }
    if public && !matches!(purpose, Purpose::Reply) {
        return Err(AppError::validation(
            "a public conversation takes replies only",
            json!({"field":"conversation_id","reason":"public_conversation_takes_replies_only"}),
        ));
    }
    let visibility = input.visibility.unwrap_or_default();
    let j = lock_current_journey(r, c.person_id).await?;
    let author = match ctx.actor {
        Actor::Human { user_id } => Author::Human(user_id),
        Actor::Agent { .. } => Author::Agent,
        Actor::System { .. } => Author::System,
    };
    let cap = capability(r, &c).await?;
    let fenced = fence_all(
        deps,
        r,
        ctx,
        Fencing {
            c: &c,
            j: j.as_ref(),
            cap: &cap,
            generation: c.executor_generation,
            author,
            intent: input.intent,
            text: &text,
            public: Some((input.item_id, visibility)),
            count_cap: true,
            except: None,
            gate: send_gate(Some(use_case), opens_conversation),
        },
    )
    .await;
    let fenced = match fenced {
        Ok(fenced) => fenced,
        Err(error) => {
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
    };
    // Only an accepted send may create a conversation. No inbound time is manufactured.
    if opens_conversation {
        r.conversations().insert_for_send(c.clone()).await?;
    }
    // Validate recipient ambiguity before creating any durable outbound intent. A public reply
    // goes to its item, never to an identity.
    let recipient = if public {
        String::new()
    } else {
        recipient(r, &c, &cap).await?
    };
    let message_id = MessageId::from(deps.ids.uuid());
    let outbox_id = deps.ids.uuid();
    let mut intent = json!({
        "kind": input.intent,
        "request_key": key,
        "use_case": use_case,
        "opens_conversation": opens_conversation,
    });
    // An agent's (or the system's) reply on a capability that requires approval waits for a
    // human (spec §3.7); a human's never does.
    let mut held = false;
    if let Some(fenced) = &fenced {
        intent["public"] = json!({
            "item_id": fenced.item.id,
            "visibility": visibility,
            "target": fenced.target,
            "drafted_by": ctx.actor,
        });
        held = cap.policy.requires_human_approval && !matches!(ctx.actor, Actor::Human { .. });
    }
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
        let subject = match input.subject {
            Some(subject) => subject,
            None => {
                let original = match &in_reply_to {
                    Some(id) => r.inbound_events().mail_subject(cap.id, id).await?,
                    None => None,
                };
                reply_subject(original.as_deref())
            }
        };
        header(&subject)?;
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
        state: if held { "held" } else { "queued" }.into(),
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
    if held {
        record(
            r,
            ctx,
            "inbox.public.held",
            "outbox",
            row.id,
            json!({"conversation_id":id,"message_id":message_id,"item_id":row.intent["public"]["item_id"]}),
        )
        .await?;
    }
    Ok(Enqueued::New(row.id))
}

/// What one fencing of a reply reads (see [`fence_all`]).
struct Fencing<'a> {
    c: &'a Conversation,
    j: Option<&'a Journey>,
    cap: &'a Capability,
    generation: u32,
    author: Author,
    intent: SendIntent,
    text: &'a str,
    /// On a public conversation, the item named and the reply's visibility.
    public: Option<(Option<PublicItemId>, Visibility)>,
    /// Whether the capability's daily cap is counted (at enqueue only: the row itself counts
    /// afterwards).
    count_cap: bool,
    /// The row being claimed or approved, which is not in its own way (`reply_in_flight`).
    except: Option<Uuid>,
    /// The strategy gate the send is held to (`send_gate`): at enqueue from its use case, at
    /// claim and approval from what its intent records.
    gate: GateMode,
}

/// Every fence of a reply: on a public conversation commercial intent first (spec §3.6 rule
/// 1), then the domain fence, then the public fence (rules 2 to 6,
/// [`super::public::reply_fence`]); what the public fence fenced, `None` on a private
/// conversation. Run at enqueue, at claim and at approval.
async fn fence_all(
    deps: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    f: Fencing<'_>,
) -> Result<Option<super::public::Fenced>, AppError> {
    let channel = public_channel_for_kind(&f.c.kind_key);
    if channel.is_some() && f.intent == SendIntent::Commercial {
        return Err(super::public::refusal(
            PublicRefusal::CommercialOnPublicSurface,
        ));
    }
    fence(
        r,
        ctx,
        f.c,
        f.j,
        f.cap,
        f.generation,
        (f.author, f.intent, f.gate),
    )
    .await?;
    let Some(channel) = channel else {
        return Ok(None);
    };
    let (item_id, visibility) = f.public.unwrap_or((None, Visibility::Public));
    super::public::reply_fence(
        deps,
        ctx,
        r,
        f.c,
        f.cap,
        channel,
        item_id,
        visibility,
        f.text,
        matches!(f.author, Author::Agent),
        f.count_cap,
        f.except,
    )
    .await
    .map(Some)
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
    purpose: (Author, SendIntent, GateMode),
) -> Result<(), AppError> {
    let (author, intent, gate) = purpose;
    let person = r
        .people()
        .get(c.person_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    let channel =
        conversation_channel(&c.kind_key).ok_or_else(|| refused("unsupported_reply_channel"))?;
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
    // A public item's own rules replace the direct-message window (spec §3.6).
    let window_open = channel.is_public()
        || c.last_inbound_at.is_some_and(|at| {
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
    // Recovery must honor the same workspace gate as the public surfaces: the status check for
    // every send, the strategy for one held to the gate (`send_gate`). Whatever queued it, two
    // more sends need the strategy: a commercial message to a customer who is no longer talking
    // (outreach, see ANSWERING_WINDOW), and a metered send, whose spend is reserved in the
    // approved strategy's budget frame; without one each is refused here, never left queued to be
    // sent late.
    if r.workspace().get().await?.status != WorkspaceStatus::Active {
        return Err(refused("workspace_inactive"));
    }
    let answering = !matches!(c.state, ConvState::Closed)
        && c.last_inbound_at.is_some_and(|at| {
            at <= ctx.now + Duration::minutes(5) && ctx.now - at <= ANSWERING_WINDOW
        });
    let outreach = intent == SendIntent::Commercial && !answering;
    if (gate == GateMode::Gated || outreach || is_metered(cap))
        && r.strategy().current_approved().await?.is_none()
    {
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
    // The whole fence again, the public one included (an item may have been answered, removed
    // or expired since enqueue); the daily cap counted this row at enqueue.
    let public = super::public::intent_of(&row.intent)?;
    if let Err(e) = fence_all(
        deps,
        r.as_mut(),
        ctx,
        Fencing {
            c: &c,
            j: j.as_ref(),
            cap: &cap,
            generation: row.expected_generation,
            author: message.author,
            intent: serde_json::from_value(row.intent["kind"].clone())?,
            text: &message.body,
            public: public.as_ref().map(|p| (Some(p.item_id), p.visibility)),
            count_cap: false,
            except: Some(row.id),
            gate: queued_gate(&row),
        },
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
    let public = public_channel_for_kind(&cap.kind_key).is_some();
    let unavailable = if public {
        deps.connectors.public(provider).is_none()
    } else {
        (cap.kind_key == "sms_line" && deps.connectors.sms(provider).is_none())
            || (cap.kind_key == "mailbox" && deps.connectors.mail_sender(provider).is_none())
            || (!matches!(cap.kind_key.as_str(), "sms_line" | "mailbox")
                && deps.connectors.messaging(provider).is_none())
    };
    if unavailable {
        return Err(refused("connector_unavailable"));
    }
    // A public reply goes to its item (the intent's target), never to an identity.
    let recipient = if public {
        String::new()
    } else {
        recipient(r, c, cap).await?
    };
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
    // A private reply's receipt names its recipient's direct-message id, when the provider does.
    let mut recipient = None;
    let result = if let Some(public) = super::public::intent_of(&p.row.intent)? {
        let surface = deps
            .connectors
            .public(p.provider)
            .ok_or_else(|| AppError::internal("public surface disappeared"))?;
        let facts = adapter_public(&p.capability);
        match public.visibility {
            Visibility::Public => {
                surface
                    .reply_public(&p.credential, &facts, &public.target, &p.message.body)
                    .await
            }
            Visibility::Private => surface
                .reply_private(&p.credential, &facts, &public.target, &p.message.body)
                .await
                .map(|receipt| {
                    recipient = receipt.recipient_id;
                    SendReceipt {
                        provider_id: receipt.provider_id,
                        cost_minor: None,
                    }
                }),
        }
    } else if p.capability.kind_key == "mailbox" {
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
    record_result_for(deps, &fresh(deps, &ctx), p.row.id, result, recipient).await
}

/// Phase C and acceptance reconciliation. The original journey is retained across a later
/// inbound opening a new one. Replayed receipts use the same outbox event key.
pub async fn record_result(
    deps: &Deps,
    ctx: &Ctx,
    id: Uuid,
    result: Result<SendReceipt, ConnectorError>,
) -> Result<ReplyOut, AppError> {
    record_result_for(deps, ctx, id, result, None).await
}

/// [`record_result`], with the recipient a private reply's receipt named.
async fn record_result_for(
    deps: &Deps,
    ctx: &Ctx,
    id: Uuid,
    result: Result<SendReceipt, ConnectorError>,
    recipient: Option<String>,
) -> Result<ReplyOut, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let out = record_result_with(deps, ctx, r.as_mut(), id, result, false, recipient).await?;
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
    record_result_with(deps, ctx, r, id, result, evidence, None).await
}

/// [`record_result_in`], with the recipient a private reply's receipt named. A public reply's
/// receipt answers its item, in this transaction (`super::public::on_receipt`); a public reply
/// refused because its item is gone ([`PUBLIC_ITEM_GONE`]) fails with `item_removed` and
/// removes the item.
async fn record_result_with(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: Uuid,
    result: Result<SendReceipt, ConnectorError>,
    evidence: bool,
    recipient: Option<String>,
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
            let gone = row.intent.get("public").is_some()
                && matches!(&e, ConnectorError::Permanent { reason, .. } if reason == PUBLIC_ITEM_GONE);
            row.last_error = Some(if gone { "item_removed".into() } else { reason });
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
    if row.intent.get("public").is_some() {
        match row.state.as_str() {
            "sent" => super::public::on_receipt(deps, ctx, r, &row, recipient.as_deref()).await?,
            "failed" if row.last_error.as_deref() == Some("item_removed") => {
                super::public::on_gone(r, ctx, &row).await?;
            }
            _ => {}
        }
    }
    Ok(output(&row))
}

/// The fence refusals of an approval that refuse the held reply itself: its item can no longer
/// take it (spec D20). Any other refusal (`workspace_inactive`, `capability_down`, the text)
/// leaves the reply held.
const ITEM_STATE_REFUSALS: &[&str] = &[
    "item_removed",
    "deadline_passed",
    "already_answered",
    "item_not_in_conversation",
    "reply_in_flight",
];

/// [`super::public::approve`] inside its transaction (the workspace lock held): the approver's
/// edited `text` is checked first (`VALIDATION`, the reply still held); then the held row is
/// fenced again with `approver` as its author on the text (the draft's when `None`) and queued
/// with its message revised. A fence refusal is the error; an item-state one
/// ([`ITEM_STATE_REFUSALS`]) also refuses the row and its message with that reason, any other
/// leaves the reply held (spec D20).
pub(super) async fn approve_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: Uuid,
    approver: jt_tenancy::UserId,
    text: Option<String>,
) -> Result<(), AppError> {
    let hint = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    let c = lock_conversation(r, hint.conversation_id).await?;
    let j = lock_current_journey(r, c.person_id).await?;
    let mut row = r
        .outbox()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    if row.state != "held" {
        return Err(not_held());
    }
    let message = r
        .messages()
        .get(row.message_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such message"))?;
    let text = match text {
        Some(text) => required("text", &text)?,
        None => message.body.clone(),
    };
    let edited = text != message.body;
    let author = Author::Human(approver);
    let cap = capability(r, &c).await?;
    let public = super::public::intent_of(&row.intent)?;
    // The approver's edit first: refused, the draft stays held for another try.
    if edited
        && let Some(public) = &public
        && let Some(channel) = public_channel_for_kind(&c.kind_key)
        && let Some(refused) =
            super::public::text_refusal(r, &c, channel, public.visibility, &text).await?
    {
        return Err(AppError::validation(
            refused.to_string(),
            json!({"field":"text","reason":refused.to_string()}),
        ));
    }
    let fenced = fence_all(
        deps,
        r,
        ctx,
        Fencing {
            c: &c,
            j: j.as_ref(),
            cap: &cap,
            // The approver decides for the conversation as it now is: a hand-over since the
            // draft (a take-over, the response SLA) does not strand it (spec D22).
            generation: c.executor_generation,
            author,
            intent: serde_json::from_value(row.intent["kind"].clone())?,
            text: &text,
            public: public.as_ref().map(|p| (Some(p.item_id), p.visibility)),
            count_cap: false,
            except: Some(row.id),
            gate: queued_gate(&row),
        },
    )
    .await;
    if let Err(e) = fenced {
        let item_state = e.code == ErrorCode::Forbidden
            && e.details["reason"]
                .as_str()
                .is_some_and(|reason| ITEM_STATE_REFUSALS.contains(&reason));
        if item_state {
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
            save_result(r, ctx, &row).await?;
            record(
                r,
                ctx,
                "inbox.send.refused",
                "person",
                c.person_id,
                json!({"person_id":c.person_id,"reason":e.message}),
            )
            .await?;
        }
        return Err(e);
    }
    r.messages()
        .revise_queued(row.message_id, author, &text)
        .await?;
    row.state = "queued".into();
    row.updated_at = ctx.now;
    if row.expected_generation != c.executor_generation {
        r.outbox()
            .set_expected_generation(row.id, c.executor_generation)
            .await?;
        row.expected_generation = c.executor_generation;
    }
    r.outbox().update(row.clone()).await?;
    record(
        r,
        ctx,
        "inbox.public.approved",
        "outbox",
        row.id,
        json!({"outbox_id":row.id,"message_id":row.message_id,"edited":edited}),
    )
    .await
}

/// [`super::public::discard`] inside its transaction (the workspace lock held).
pub(super) async fn discard_in(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: Uuid,
) -> Result<ReplyOut, AppError> {
    let hint = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    lock_conversation(r, hint.conversation_id).await?;
    let mut row = r
        .outbox()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such outbox entry"))?;
    if row.state != "held" {
        return Err(not_held());
    }
    let drafted = &row.intent["public"]["drafted_by"];
    let allowed = match &ctx.actor {
        Actor::Human { .. } => true,
        Actor::Agent { connection_id, .. } => {
            drafted["kind"] == "agent" && drafted["connection_id"] == json!(connection_id)
        }
        Actor::System { .. } => false,
    };
    if !allowed {
        return Err(refused("not_the_drafter"));
    }
    row.state = "refused".into();
    row.last_error = Some("discarded".into());
    row.updated_at = ctx.now;
    r.messages()
        .set_status(
            row.message_id,
            MsgStatus::Refused {
                reason: "discarded".into(),
            },
            None,
            None,
        )
        .await?;
    save_result(r, ctx, &row).await?;
    record(
        r,
        ctx,
        "inbox.public.discarded",
        "outbox",
        row.id,
        json!({"outbox_id":row.id,"message_id":row.message_id,"item_id":row.intent["public"]["item_id"]}),
    )
    .await?;
    Ok(output(&row))
}

/// The refusal of approving or discarding a reply that is not held (any more).
fn not_held() -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: "reply not held".into(),
        details: json!({"reason":"reply_not_held"}),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_subject_answers_the_original_once() {
        assert_eq!(reply_subject(Some("Help\r\n  needed")), "Re: Help needed");
        assert_eq!(reply_subject(Some("RE: Fiyat")), "RE: Fiyat");
        assert_eq!(reply_subject(Some("Ynt: Teklif")), "Ynt: Teklif");
        assert_eq!(reply_subject(Some("  \t ")), "Re:");
        assert_eq!(reply_subject(None), "Re:");
        let long = reply_subject(Some(&"ş".repeat(600)));
        assert!(
            long.len() <= 998 && long.starts_with("Re: ş"),
            "{}",
            long.len()
        );
    }
}
