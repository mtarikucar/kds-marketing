//! Trusted system consumer. Claims, facts and completion share one tenant transaction.
use super::{journeys, people, record};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{CapabilityFilter, TenantRepos, inbox::ConsumptionOutcome},
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        jobs::JobReport,
    },
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
/// The longest sender name kept from a provider, in characters.
const MAX_SENDER_NAME: usize = 200;

/// Sweep with a cursor even after failures; the next sweep starts over to retry rollbacks.
pub async fn consume_workspace(deps: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> JobReport {
    let mut report = JobReport::default();
    if let Err(e) = release_deferrals(deps, ws, now).await {
        warn(ws, &e);
        report.failed += 1;
    }
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
            match consume_event(deps, &event, now).await {
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
/// Makes the deferred events whose retry is due claimable again, and gives up on those older
/// than `DEFERRAL_GIVE_UP` (C5): each abandoned event writes `inbox.event.abandoned` once.
async fn release_deferrals(
    deps: &Deps,
    ws: WorkspaceId,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let mut r = deps.uow.tenant(ws).await?;
    let abandoned = r.consumption().release_due_deferrals(CONSUMER, now).await?;
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::System {
            component: "scheduler:inbox_consume".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now,
        agent_connection_id: None,
    };
    for id in abandoned {
        record(
            r.as_mut(),
            &ctx,
            "inbox.event.abandoned",
            "inbound_event",
            id,
            json!({ "event_id": id }),
        )
        .await?;
    }
    r.commit().await
}
fn warn(ws: WorkspaceId, e: &AppError) {
    // Adapter errors can contain SQL or personal data: only a structured code reaches logs.
    tracing::warn!(job="inbox_consume",workspace_id=%ws,code=e.code.as_str(),"inbound consumption failed");
}
/// Trusted system entry point; transport callers must use the authenticated event intake.
pub async fn consume_event(
    deps: &Deps,
    event: &InboundEvent,
    now: OffsetDateTime,
) -> Result<&'static str, AppError> {
    let lead = super::leadgen::fetch(deps, event).await?;
    let name = sender_name(deps, event).await;
    let subject = super::public::subject_fetch(deps, event, now).await;
    let mut r = deps.uow.tenant(event.workspace_id).await?;
    r.people().lock_workspace().await?;
    if !matches!(
        r.workspace().get().await?.status,
        WorkspaceStatus::Active | WorkspaceStatus::PendingPayment
    ) {
        return Ok("deferred");
    }
    r.people().set_write_time(now).await?;
    // Form splits must leave an actionable review suggestion but remain retryable. The
    // workspace lock serializes matching; successful form effects and their claim still
    // commit in this one transaction. Duplicate claims roll back all tentative effects.
    let claim_after_intake = lead.is_some();
    if !claim_after_intake && !r.consumption().try_claim(CONSUMER, event.id).await? {
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
    let outcome = match route(
        deps,
        &ctx,
        r.as_mut(),
        event,
        lead.as_ref(),
        name.as_deref(),
        subject.as_ref(),
    )
    .await
    {
        Err(e) if claim_after_intake && e.details["reason"] == "identity_split" => {
            // match_or_create detects a split before mutating any person or identity.
            // Only its idempotent review suggestion and ledger entry have been written.
            r.commit().await?;
            return Err(e);
        }
        Err(e) if e.details["reason"] == "erased_identity" => "erased_identity_drop",
        result => result?,
    };
    // An email the consumer made no message of keeps no file (spec
    // 2026-10-30-leads-pool-outreach-design.md §3.15, D108): its sender erased, a duplicate, or
    // any other outcome but a deferral (a later run may still make the message). The rows lose
    // their names in this transaction; the bytes go once it commits (best effort: the store's
    // daily sweep deletes what no record keeps).
    let files = if outcome == "deferred" {
        vec![]
    } else {
        drop_files(r.as_mut(), event, now).await?
    };
    if claim_after_intake && !r.consumption().try_claim(CONSUMER, event.id).await? {
        return Ok("duplicate");
    }
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
    delete_bytes(deps, event.workspace_id, files).await;
    Ok(outcome)
}
/// Erases the files of email event `event` that no message holds (none for another event);
/// the ids whose bytes go once the bundle commits.
async fn drop_files(
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    now: OffsetDateTime,
) -> Result<Vec<jt_studio::FileId>, AppError> {
    match event.capability_id {
        Some(capability)
            if event.provider == Provider::Mail && event.kind == EventKind::Message =>
        {
            r.mail_files()
                .erase_event(capability, &event.external_id, now)
                .await
        }
        _ => Ok(vec![]),
    }
}
/// Deletes the bytes of `files` from the store, best effort.
async fn delete_bytes(deps: &Deps, ws: WorkspaceId, files: Vec<jt_studio::FileId>) {
    for file in files {
        let _ = deps.files.delete(ws, file).await;
    }
}
async fn route(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    lead: Option<&super::leadgen::Fetched>,
    sender_name: Option<&str>,
    subject: Option<&crate::ports::connectors::SubjectFacts>,
) -> Result<&'static str, AppError> {
    // TikTok's webhooks are about the account and its posts, never a conversation: the intake
    // takes their effect (`webhook::receive_tiktok`); here they are done with, never deferred.
    if event.provider == Provider::Tiktok {
        return Ok("not_inbox");
    }
    let mut erased = event.payload["erased_identity"] == true;
    if let Some(person) = event.payload["person_id"]
        .as_str()
        .and_then(|s| s.parse::<PersonId>().ok())
    {
        erased |= r.erasure().get(person).await?.is_some();
    }
    // Scrubbed mail delivery facts remain useful; they must reconcile uncertain sends.
    if erased && !(event.provider == Provider::Mail && event.kind == EventKind::Status) {
        return Ok("erased_identity_drop");
    }
    let id = match event.capability_id {
        Some(id) => id,
        // Stored while none or several capabilities of its kind were live: attached now that
        // exactly one is (the event itself keeps no capability).
        None => match netgsm_capability_now(r, event).await? {
            Some(id) => id,
            None => return Ok("deferred"),
        },
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
    // A Page's or an account's comment may be routed to its direct-message sibling: comments
    // live on the surface capability holding the same account.
    if event.provider == Provider::Meta && event.kind == EventKind::Comment {
        cap = match super::public::surface_capability(r, &cap).await? {
            Some(surface) => surface,
            None => return Ok("no_surface"),
        };
    }
    if matches!(event.kind, EventKind::Comment | EventKind::Question) {
        return super::public::intake(deps, ctx, r, event, &cap, subject).await;
    }
    if event.kind == EventKind::LeadGen {
        return match lead {
            Some(lead) => super::leadgen::intake(deps, ctx, r, &cap, lead).await,
            None => Ok("deferred"),
        };
    }
    if event.kind == EventKind::Consent {
        return consent_event(deps, ctx, r, event, &cap).await;
    }
    // A number onboarded beside the WhatsApp Business app: its shared history and contacts, what
    // the business sends from the app, and its account's own events.
    if event.provider == Provider::Meta && cap.kind_key == "whatsapp_cloud" {
        match event.kind {
            EventKind::History => return history(deps, ctx, r, event, &cap).await,
            EventKind::ContactSync => return app_contact(deps, ctx, r, event, &cap).await,
            EventKind::AccountUpdate => return account_update(ctx, r, event, &cap).await,
            EventKind::MessageEcho if event.payload.get("echo").is_some() => {
                return app_echo(deps, ctx, r, event, &cap).await;
            }
            _ => {}
        }
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
            message(deps, ctx, r, event, &cap, channel, sender_name).await
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
        // Voice-message and auto-call reports: read, ledgered, no journey effect (V0-T3).
        EventKind::Status if event.provider == Provider::Netgsm && channel == Channel::Phone => {
            netgsm_report(ctx, r, event).await
        }
        _ => Ok("deferred"),
    }
}
/// The single live capability of the kind a NetGSM event belongs to (`sms_line` for an SMS,
/// `netgsm_pbx` for a call event or a voice report), if exactly one is live.
async fn netgsm_capability_now(
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
) -> Result<Option<jt_capability::CapabilityId>, AppError> {
    if event.provider != Provider::Netgsm {
        return Ok(None);
    }
    let kind = match event.kind {
        EventKind::Message | EventKind::Consent => "sms_line",
        EventKind::CallEvent | EventKind::Status => "netgsm_pbx",
        _ => return Ok(None),
    };
    let live: Vec<_> = r
        .capabilities()
        .list(CapabilityFilter {
            kind: Some(kind),
            ..Default::default()
        })
        .await?
        .into_iter()
        .filter(|c| c.status != StoredStatus::Retired)
        .collect();
    Ok(match live[..] {
        [ref only] => Some(only.id),
        _ => None,
    })
}
/// A NetGSM voice-message or auto-call report: consumed with a ledger line naming its kind and
/// state, never a number.
async fn netgsm_report(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
) -> Result<&'static str, AppError> {
    let report = if event.payload.get("relation_id").is_some() {
        "voice-report"
    } else if event.payload.get("job_id").is_some() {
        "autocall-report"
    } else {
        return Ok("deferred");
    };
    let state = text(&event.payload, "state")
        .or_else(|| text(&event.payload, "status"))
        .map(|s| s.chars().take(40).collect::<String>());
    record(
        r,
        ctx,
        "inbox.netgsm_report",
        "inbound_event",
        event.id,
        json!({ "report": report, "state": state }),
    )
    .await?;
    Ok("consumed")
}
/// Lock-free and best-effort, like the lead-gen read: the name Meta shows for the sender of a
/// direct message whose identity no person holds yet (a known sender keeps the name it has).
/// Never asked for an erased sender or in a workspace that does not receive; every failure
/// reads as no name, so ingest never waits on the provider.
async fn sender_name(deps: &Deps, event: &InboundEvent) -> Option<String> {
    if event.provider != Provider::Meta
        || event.kind != EventKind::Message
        || event.payload["erased_identity"] == true
    {
        return None;
    }
    let sender = text(&event.payload["messaging"]["sender"], "id")?;
    let (cap, credential) = {
        let mut r = deps.uow.tenant(event.workspace_id).await.ok()?;
        if !matches!(
            r.workspace().get().await.ok()?.status,
            WorkspaceStatus::Active | WorkspaceStatus::PendingPayment
        ) {
            return None;
        }
        let cap = r.capabilities().find(event.capability_id?).await.ok()??;
        let channel = match cap.kind_key.as_str() {
            "messenger" | "facebook_page" => Channel::Messenger,
            "instagram_dm" | "instagram" => Channel::InstagramDm,
            _ => return None,
        };
        if cap.status == StoredStatus::Retired {
            return None;
        }
        let key = sender_key(&cap, channel, sender).ok()?;
        super::erasure::check_identity(r.as_mut(), channel.identity_channel(), &key)
            .await
            .ok()?;
        if r.people()
            .find_by_identity(channel.identity_channel(), &key)
            .await
            .ok()?
            .is_some()
        {
            return None;
        }
        let sealed = r.capabilities().read_sealed(cap.id).await.ok()??;
        let credential = open_credential(deps, event.workspace_id, &sealed).ok()?;
        (cap, credential)
    };
    let name = deps
        .connectors
        .messaging(Provider::Meta)?
        .sender_name(&credential, &adapter_public(&cap), sender)
        .await
        .ok()??;
    Some(clean_name(&name)).filter(|name| !name.is_empty())
}
/// A sender's name as a person's display name: trimmed, without control characters, at most
/// [`MAX_SENDER_NAME`] characters.
pub(super) fn clean_name(name: &str) -> String {
    let name: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_SENDER_NAME)
        .collect();
    name.trim().to_owned()
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
            text(p, "name"),
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
        name: name.map(clean_name).unwrap_or_default(),
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
pub(crate) async fn journey(
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
    apply_from(deps, ctx, r, journey, key, kind, EventSource::System).await
}

/// Applies journey event `kind` keyed `key` to `journey` as `source` reported it, with its
/// effects and the `inbox.event.reported` ledger entry (a call's outcome comes through here).
pub(crate) async fn apply_from(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: Journey,
    key: String,
    kind: JourneyEventKind,
    source: EventSource,
) -> Result<(), AppError> {
    let origin = if matches!(source, EventSource::System) {
        "inbound"
    } else {
        "call"
    };
    let j = r
        .journeys()
        .lock(journey.id)
        .await?
        .ok_or_else(|| AppError::not_found("no such journey"))?;
    let event = JourneyEvent {
        id: JourneyEventId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        journey_id: j.id,
        source,
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
    let kind = event.kind.clone();
    r.journeys()
        .apply_transition(j.id, transition, event)
        .await?;
    journeys::apply_effects(deps, ctx, r, &j, &effects).await?;
    crate::usecases::outreach::hooks::on_journey_event(r, ctx, j.id, &kind).await?;
    record(
        r,
        ctx,
        "inbox.event.reported",
        "journey",
        j.id,
        json!({ "source": origin }),
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
    sender_name: Option<&str>,
) -> Result<&'static str, AppError> {
    let key = format!("inbound:{}", event.id);
    if r.journeys().event_by_key(&key).await?.is_some() {
        return Ok("duplicate");
    }
    let mut content = decode(event, channel, false)?;
    if content.name.is_empty()
        && let Some(name) = sender_name
    {
        content.name = name.to_owned();
    }
    super::erasure::check_identity(
        r,
        channel.identity_channel(),
        &sender_key(cap, channel, &content.sender)?,
    )
    .await?;
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
    // The email's files, stored when it was polled, are the message's and the person's.
    if channel == Channel::Email {
        r.mail_files()
            .link_event_to_message(cap.id, &event.external_id, message_id, person.id)
            .await?;
    }
    r.conversations().lock_for_person(person.id).await?;
    let j = journey(deps, ctx, r, &person).await?;
    if j.status == JourneyStatus::Lost {
        r.conversations()
            .update_executor(conv.id, Executor::Human { user_id: None })
            .await?;
    }
    apply(deps, ctx, r, j, key, JourneyEventKind::MessageReceived).await?;
    // A reply to an outreach email stops the person's sequence (spec
    // 2026-10-30-leads-pool-outreach-design.md §3.14); the conversation is ours as for any
    // inbound, so the agent answers.
    let in_reply_to = (channel == Channel::Email)
        .then(|| text(&event.payload, "in_reply_to"))
        .flatten();
    crate::usecases::outreach::hooks::on_inbound(
        r,
        ctx,
        person.id,
        in_reply_to,
        activity_at(event),
    )
    .await?;
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
    // A private reply to a comment is sent from the comment's conversation, on the surface
    // capability of the same account: its echo is ours, never an orphan to defer.
    if let Some(surface) = super::public::surface_capability(r, cap).await?
        && surface.id != cap.id
        && outbound(r, &surface, &content.external_id).await?.is_some()
    {
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
        .echo_candidates(conv.id, &content.body, event.received_at, false)
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
    let scenario = text(&event.payload, "scenario").ok_or_else(malformed)?;
    // A call placed from Jeeta follows the PBX: its session is answered, hung up and, from the
    // call record, given its duration, recording and cost (V0-T3).
    let session = follow_session(deps, ctx, r, event, id, scenario).await?;
    let key = format!("call:{id}");
    if r.journeys().event_by_key(&key).await?.is_some() {
        return Ok("duplicate");
    }
    if scenario == "cdr" {
        // A call record only fills in a session; the journey hears of a call at its hangup.
        return Ok("consumed");
    }
    if !matches!(scenario, "inbound_call" | "answer" | "hangup") {
        return Ok("deferred");
    }
    // The rep already reported how the call went (`calls.end`): the journey has it.
    if scenario == "hangup" && session.as_ref().is_some_and(|s| s.outcome.is_some()) {
        return Ok("consumed");
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
    // The reducer refuses CallMade on a lost journey, and reopening it is a person's decision:
    // the call surfaces the conversation (ours, on a lost journey: a reopen question in
    // `work.pending`) and the journey is left as it is (C5).
    if r.journeys()
        .latest_for(person.id)
        .await?
        .is_some_and(|j| j.status == JourneyStatus::Lost)
    {
        if scenario != "hangup" && !r.consumption().try_claim(PBX_ACTIVITY, event.id).await? {
            return Ok("duplicate");
        }
        conversation(deps, ctx, r, event, cap, person.id).await?;
        if scenario != "hangup" {
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
        return Ok("consumed");
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

/// The call session a NetGSM call event belongs to (by the `crm_id` the PBX was given when the
/// call was placed, else by the PBX's call id it learned from an earlier event), brought up to
/// date: answered, hung up (the PBX's status word as the cause), or, from a call record, ended
/// with its duration and recording and charged ([`crate::usecases::calls::charge`]). `None` for a
/// call Jeeta did not place.
async fn follow_session(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    unique_id: &str,
    scenario: &str,
) -> Result<Option<jt_calls::CallSession>, AppError> {
    let by_crm = match text(&event.payload, "crm_id") {
        Some(crm) => r.calls().lock_by_crm_id(crm).await?,
        None => None,
    };
    let Some(mut session) = (match by_crm {
        Some(s) => Some(s),
        None => r.calls().lock_by_pbx_id(unique_id).await?,
    }) else {
        return Ok(None);
    };
    session
        .pbx_unique_id
        .get_or_insert_with(|| unique_id.to_owned());
    let policy = r.calls().policy().await?;
    let at = activity_at(event);
    let duration = event.payload["duration_sec"]
        .as_f64()
        .or_else(|| text(&event.payload, "duration_sec").and_then(|d| d.parse().ok()))
        .filter(|d| d.is_finite() && *d >= 0.0)
        .map(|d| d.round().min(f64::from(u32::MAX)) as u32);
    let recording = text(&event.payload, "recording")
        .filter(|r| !r.is_empty())
        .map(str::to_owned);
    let step = match scenario {
        "answer" => jt_calls::reduce(&mut session, &jt_calls::BridgeEvent::Answered, at, &policy),
        "hangup" | "cdr" => {
            let cause = text(&event.payload, "status")
                .unwrap_or("normal")
                .to_owned();
            if scenario == "cdr" && session.answered_at.is_none() && duration.is_some_and(|d| d > 0)
            {
                // The call record says it was talked through: answered that long before its end.
                let talked = time::Duration::seconds(i64::from(duration.unwrap_or(0)));
                jt_calls::reduce(
                    &mut session,
                    &jt_calls::BridgeEvent::Answered,
                    at - talked,
                    &policy,
                );
            }
            jt_calls::reduce(
                &mut session,
                &jt_calls::BridgeEvent::Hangup { cause },
                at,
                &policy,
            )
        }
        _ => jt_calls::Step::default(),
    };
    if let Some(d) = duration.filter(|_| matches!(scenario, "hangup" | "cdr")) {
        session.duration_s = Some(d);
    }
    if let Some(link) = recording.filter(|_| session.recording != jt_calls::RecordingState::Off) {
        session.recording = jt_calls::RecordingState::Recording {
            file_ref: Some(link),
        };
    }
    if !step.turns.is_empty() {
        r.calls().append_turns(session.id, step.turns).await?;
    }
    if scenario == "cdr" {
        crate::usecases::calls::charge(deps, ctx, r, &mut session).await?;
    }
    r.calls().update(session.clone(), ctx.now).await?;
    Ok(Some(session))
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
    // An outreach email's bounce or complaint is recorded on its send before the evidence
    // settles the entry (an unknown send becomes bounced, not failed), and stops the sequence.
    if let Some(status @ ("failed" | "complaint")) = text(&event.payload, "status") {
        crate::usecases::outreach::hooks::on_bounce(r, ctx, &row, status == "complaint").await?;
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
        // An email whose subject is `unsubscribe` is the `mailto:` fallback of a commercial
        // email's `List-Unsubscribe` (spec 2026-10-30-leads-pool-outreach-design.md §3.14): from
        // a person an outreach email reached in the last 90 days, an unsubscribe from it.
        let mailto = event.provider == Provider::Mail
            && text(p, "subject").is_some_and(|s| s.trim().eq_ignore_ascii_case("unsubscribe"));
        if !(mailto
            && crate::usecases::outreach::links::unsubscribed_by_mail(r, ctx, person.id, at)
                .await?)
        {
            crate::usecases::outreach::hooks::on_withdrawn(r, ctx, person.id, channel).await?;
        }
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

// ---------------------------------------------------------------------------------------------
// A WhatsApp number onboarded beside the WhatsApp Business app
// ---------------------------------------------------------------------------------------------

/// The person a WhatsApp Business app's item is about (its customer's number `number`), matched
/// or created as a live message's sender is, under `source`; the erased are refused as for any
/// inbound item.
async fn app_person(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Capability,
    number: &str,
    name: &str,
    source: Source,
) -> Result<Person, AppError> {
    let channel = Channel::WhatsApp;
    super::erasure::check_identity(
        r,
        channel.identity_channel(),
        &sender_key(cap, channel, number)?,
    )
    .await?;
    Ok(people::match_or_create(
        deps,
        ctx,
        r,
        people::CreateInput {
            display_name: clean_name(name),
            identities: vec![people::IdentityInput {
                channel: channel.identity_channel(),
                value: number.to_owned(),
                capability_id: Some(cap.id),
            }],
            source,
        },
        Some(0),
    )
    .await?
    .person)
}

/// The person's conversation with `cap`, or a new one with nothing owed in it: open, with no
/// inbound activity (so no reply is owed and no customer service window opens), as a send to a
/// new person starts one.
async fn quiet_conversation(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Capability,
    person: PersonId,
) -> Result<Conversation, AppError> {
    if let Some(c) = r.conversations().find(person, cap.id).await? {
        return Ok(c);
    }
    let c = Conversation {
        id: ConversationId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        person_id: person,
        capability_id: cap.id,
        kind_key: cap.kind_key.clone(),
        state: ConvState::Open,
        executor: Executor::Agent,
        executor_generation: 0,
        last_inbound_at: None,
        last_outbound_at: None,
        created_at: ctx.now,
        updated_at: ctx.now,
    };
    r.conversations().insert_for_send(c.clone()).await?;
    Ok(c)
}

/// Whether two WhatsApp numbers are one: their digits match.
fn same_number(a: &str, b: &str) -> bool {
    let digits = |s: &str| s.chars().filter(char::is_ascii_digit).collect::<String>();
    let (a, b) = (digits(a), digits(b));
    !a.is_empty() && a == b
}

/// The text of a WhatsApp item (`text.body`, else a media item's caption); empty for anything
/// else (a media placeholder of the history among them: the inbox keeps no media).
fn whatsapp_text(item: &Value) -> String {
    item["text"]["body"]
        .as_str()
        .or_else(|| {
            item["type"]
                .as_str()
                .and_then(|kind| item[kind]["caption"].as_str())
        })
        .unwrap_or_default()
        .to_owned()
}

/// A message of a WhatsApp Business app's shared history (`EventKind::History`,
/// `{history_message, thread, business_number}`): filed in the person's conversation at its own
/// time, from the customer, or from the business (`business_app`) when the business sent it.
/// The past is owed nothing: a conversation it creates is open with no inbound activity, no
/// journey event is written, no window opens. A message already filed (its `wamid`, by a live
/// webhook or an earlier delivery) is not filed again. A chunk's progress and a refusal to share
/// are recorded (`inbox.whatsapp_history`), the refusal under its code.
async fn history(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let p = &event.payload;
    if let Some(chunk) = p.get("history_chunk") {
        record(
            r,
            ctx,
            "inbox.whatsapp_history",
            "capability",
            cap.id,
            json!({
                "phase": chunk["phase"],
                "chunk_order": chunk["chunk_order"],
                "progress": chunk["progress"],
                "messages": p["messages"],
            }),
        )
        .await?;
        return Ok("consumed");
    }
    if let Some(error) = p.get("history_error") {
        record(
            r,
            ctx,
            "inbox.whatsapp_history",
            "capability",
            cap.id,
            json!({ "declined": true, "code": error["code"] }),
        )
        .await?;
        return Ok("consumed");
    }
    let m = &p["history_message"];
    let (Some(wamid), Some(customer)) = (text(m, "id"), text(p, "thread")) else {
        return Err(malformed());
    };
    if r.messages()
        .find_by_external_id(cap.id, wamid)
        .await?
        .is_some()
    {
        return Ok("duplicate");
    }
    let from_business = text(m, "to").is_some()
        || text(m, "from")
            .zip(text(p, "business_number"))
            .is_some_and(|(from, business)| same_number(from, business));
    let source = Source::Channel(Channel::WhatsApp);
    let person = app_person(deps, ctx, r, cap, customer, "", source).await?;
    let conv = quiet_conversation(deps, ctx, r, cap, person.id).await?;
    let (direction, author, status) = if from_business {
        (Direction::Outbound, Author::BusinessApp, MsgStatus::Sent)
    } else {
        (Direction::Inbound, Author::Customer, MsgStatus::Received)
    };
    let inserted = r
        .messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: conv.id,
            direction,
            author,
            body: whatsapp_text(m),
            external_id: Some(wamid.to_owned()),
            status,
            cost_minor: None,
            at: activity_at(event),
        })
        .await?;
    let Some(message_id) = inserted else {
        return Ok("duplicate");
    };
    if direction == Direction::Inbound {
        // The consumer's contract for every new inbound message; an older one never becomes
        // the conversation's latest sender.
        let normalized = sender_key(cap, Channel::WhatsApp, customer)?;
        let sender = r
            .identities()
            .list(person.id)
            .await?
            .into_iter()
            .find(|i| i.channel == IdentityChannel::Phone && i.value_normalized == normalized)
            .ok_or_else(|| AppError::internal("matched history identity missing"))?;
        r.messages()
            .record_inbound_sender(message_id, sender.id)
            .await?;
    }
    Ok("consumed")
}

/// What the business sent from the WhatsApp Business app (`smb_message_echoes`,
/// `EventKind::MessageEcho` with `{echo}`): an outbound message authored `business_app` in the
/// person's conversation (one with nothing owed is started when there is none). Deduplicated by
/// its `wamid` only, against every message filed (what Jeeta sent included, once its send
/// recorded the `wamid`): the business typed it on the phone, so a send of Jeeta's in flight with
/// the same text is not it. When it is newer than the conversation's last inbound message and
/// the conversation was owed a reply, the business answered from the phone: the conversation
/// turns `theirs` and the customer's messages it answered leave `events.pending`
/// ([`settle_answered`]), so no agent answers again. Nothing else reacts to it.
async fn app_echo(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let e = &event.payload["echo"];
    let (Some(wamid), Some(customer)) = (text(e, "id"), text(e, "to")) else {
        return Err(malformed());
    };
    if r.messages()
        .find_by_external_id(cap.id, wamid)
        .await?
        .is_some()
    {
        return Ok("duplicate");
    }
    let body = whatsapp_text(e);
    let source = Source::Channel(Channel::WhatsApp);
    let person = app_person(deps, ctx, r, cap, customer, "", source).await?;
    let conv = quiet_conversation(deps, ctx, r, cap, person.id).await?;
    let at = activity_at(event);
    let inserted = r
        .messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: conv.id,
            direction: Direction::Outbound,
            author: Author::BusinessApp,
            body,
            external_id: Some(wamid.to_owned()),
            status: MsgStatus::Sent,
            cost_minor: None,
            at,
        })
        .await?;
    if inserted.is_none() {
        return Ok("duplicate");
    }
    let answered =
        conv.state == ConvState::Ours && conv.last_inbound_at.is_some_and(|inbound| at >= inbound);
    if answered {
        r.conversations()
            .update_state(conv.id, ConvState::Theirs, Some(at))
            .await?;
        settle_answered(ctx, r, cap, conv.id, at).await?;
    }
    Ok("consumed")
}

/// How many of a conversation's latest messages [`settle_answered`] looks through.
const ANSWERED_SCAN: u32 = 50;

/// The customer's messages of conversation `conv` that the business answered from the phone (at
/// or before `answered_at`) and that still wait in `events.pending`, marked processed: the owner
/// replied, so no agent is put to them afterwards (owner decision 2026-11-03: the conversation
/// goes `theirs` and the agent stays out). Each is found by its `wamid`, among the latest
/// [`ANSWERED_SCAN`] messages; one already processed keeps its time.
async fn settle_answered(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Capability,
    conv: ConversationId,
    answered_at: OffsetDateTime,
) -> Result<(), AppError> {
    for m in r.messages().recent(conv, ANSWERED_SCAN).await? {
        let Some(wamid) = m.external_id.as_deref() else {
            continue;
        };
        if m.direction != Direction::Inbound || m.at > answered_at {
            continue;
        }
        if let Some(e) = r
            .inbound_events()
            .find_external(Provider::Meta, wamid)
            .await?
            && e.processed_at.is_none()
            && e.capability_id == Some(cap.id)
        {
            r.inbound_events().mark_processed(e.id, ctx.now).await?;
        }
    }
    Ok(())
}

/// A contact of the WhatsApp Business app (`smb_app_state_sync`, `EventKind::ContactSync`,
/// `{state_sync}`): an `add` becomes a person with that phone identity, named as the app names
/// them, matched as any first contact is (an existing identity is reused, its person kept as it
/// is); a `remove` changes nobody (an address book is not an erasure request) and is only
/// recorded (`inbox.whatsapp_contact_removed`, without the number).
async fn app_contact(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let item = &event.payload["state_sync"];
    let Some(number) = text(&item["contact"], "phone_number") else {
        return Err(malformed());
    };
    match text(item, "action") {
        Some("add") => {
            let name = text(&item["contact"], "full_name")
                .or_else(|| text(&item["contact"], "first_name"))
                .unwrap_or_default();
            app_person(deps, ctx, r, cap, number, name, Source::Import).await?;
            Ok("consumed")
        }
        Some("remove") => {
            record(
                r,
                ctx,
                "inbox.whatsapp_contact_removed",
                "capability",
                cap.id,
                json!({}),
            )
            .await?;
            Ok("consumed")
        }
        _ => Ok("deferred"),
    }
}

/// A WhatsApp Business Account's own event (`account_update`, `{account_update}`): a
/// disconnection (`PARTNER_REMOVED`, with Meta's `disconnection_info.reason`) or an offboarding
/// (`ACCOUNT_OFFBOARDED`) turns every live `whatsapp_cloud` capability of the workspace whose asset
/// names that account `unreachable`, asking for a reconnection with the reason
/// (`super::super::connector::authorization_removed`: left alone when verified since the event).
/// Any other account event is not the inbox's (kept for the agent).
async fn account_update(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
) -> Result<&'static str, AppError> {
    let value = &event.payload["account_update"];
    let Some(what @ ("PARTNER_REMOVED" | "ACCOUNT_OFFBOARDED")) = text(value, "event") else {
        return Ok("not_inbox");
    };
    let account = text(&value["waba_info"], "waba_id")
        .or_else(|| cap.connector_public["asset"]["waba_id"].as_str())
        .ok_or_else(malformed)?
        .to_owned();
    let reason = match text(&value["disconnection_info"], "reason") {
        Some(why) => format!(
            "WhatsApp {what}: {}",
            why.chars().take(60).collect::<String>()
        ),
        None => format!("WhatsApp {what}"),
    };
    let held: Vec<_> = r
        .capabilities()
        .list(CapabilityFilter {
            kind: Some("whatsapp_cloud"),
            ..Default::default()
        })
        .await?
        .into_iter()
        .filter(|c| {
            c.status != StoredStatus::Retired
                && c.connector_public["asset"]["waba_id"].as_str() == Some(account.as_str())
        })
        .map(|c| c.id)
        .collect();
    let occurred_at =
        text(&event.payload, "occurred_at").and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok());
    for id in held {
        crate::usecases::connector::authorization_removed(r, ctx, id, &reason, occurred_at).await?;
    }
    Ok("consumed")
}
