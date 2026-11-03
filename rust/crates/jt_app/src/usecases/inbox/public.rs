//! Public conversations: comments on posts and marketplace questions (spec
//! 2026-10-30-inbox-comments-marketplace-design.md §6). A conversation stays one person on one
//! capability; each comment or question is a [`PublicItem`] of it.
//!
//! - [`comments_enabled`]: whether a capability's comments (or questions) are taken at all. A
//!   marketplace's always are (its credentials are the switch); a Meta surface's only while the
//!   platform's comment flag for its login is on **and** its grant holds the comment scopes, so
//!   that Meta comment code stays inert until Meta's App Review granted them (spec D11, §11).
//! - `intake`: one inbound event of kind `Comment` or `Question` (its payload a
//!   [`PublicEnvelope`]) into person, conversation, message, item and subject, or a provider's new
//!   state of a known item into that item. No journey is opened (D4), no ledger line written for a
//!   new item (inbound events are records of the outside world).
//! - `settle_state`: a public conversation's state from its items (`Ours` while one is owed).
//! - `subject_fetch`: lock-free and best-effort before the intake's transaction, what the
//!   provider tells of a post or product the inbox does not know yet (or knew more than a day
//!   ago).
//! - Replies (`inbox.reply` on a public conversation, `super::replies`): `reply_fence` (spec
//!   §3.6 rules 2 to 6, at enqueue, claim and approval), `on_receipt` (the item answered or
//!   privately replied, the recipient's direct-message identity linked) and `on_gone`; held
//!   replies are approved ([`approve`]) or discarded ([`discard`]) (§3.7).
//!
//! Nothing here logs an item's text, an author's name or id, or a credential.

use std::collections::BTreeSet;

use jt_capability::{Capability, StoredStatus};
use jt_connector::{EventKind, InboundEvent, comment_grant};
use jt_inbox::public::{
    MAX_EXTERNAL_ID_CHARS, MAX_SUBJECT_IMAGE_URL_CHARS, MAX_SUBJECT_TITLE_CHARS,
    MAX_SUBJECT_URL_CHARS,
};
use jt_inbox::*;
use jt_tenancy::{Permission, WorkspaceStatus};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};

use super::{people, record};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        CapabilityFilter, TenantRepos,
        connectors::{
            EnvelopeStatus, EnvelopeSubject, PlatformAppConfig, PublicEnvelope, PublicTarget,
            SubjectFacts,
        },
        inbox::OutboxRow,
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
    },
};

/// How long a subject the inbox knows is not asked of its provider again.
pub const SUBJECT_REFRESH: Duration = Duration::days(1);

/// The capability kind whose posts a capability of `kind_key` answers comments on: a direct
/// message sibling maps to its surface (`messenger` → `facebook_page`, `instagram_dm` →
/// `instagram`), as the webhook's routing may pick the sibling for the same account; any other
/// kind is its own.
pub fn surface_kind(kind_key: &str) -> &str {
    match kind_key {
        "messenger" => "facebook_page",
        "instagram_dm" => "instagram",
        other => other,
    }
}

/// Whether `cap` takes public items: a marketplace (`trendyol`, `hepsiburada`) always; a Meta
/// surface (or its direct-message sibling, read as its surface: [`surface_kind`]) while the
/// platform's comment flag of the app it signed in with is on (`MetaApp::comment_scopes`, or
/// `InstagramApp::comment_scopes` for an Instagram Login grant: `connector_public.access.app =
/// "instagram"`) and its grant (`connector_public.access.scopes`) enables comments
/// ([`jt_connector::comment_grant`]); any other kind never.
///
/// Gates the webhook's intake (a disabled comment is dropped), the consumer (ignored), the reply
/// and moderation fences and the comment polls. The flag keeps every Meta comment path off until
/// the operator turns it on after Meta's App Review, whatever a token happens to hold.
pub fn comments_enabled(apps: &dyn PlatformAppConfig, cap: &Capability) -> bool {
    let kind = surface_kind(&cap.kind_key);
    match kind {
        "trendyol" | "hepsiburada" => true,
        "facebook_page" | "instagram" => {
            let access = &cap.connector_public["access"];
            let flag = if access["app"] == "instagram" {
                apps.instagram_app().is_some_and(|app| app.comment_scopes)
            } else {
                apps.meta_app().is_some_and(|app| app.comment_scopes)
            };
            let scopes: Vec<&str> = access["scopes"]
                .as_array()
                .map(|scopes| scopes.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            flag && comment_grant(kind, &scopes).enabled()
        }
        _ => false,
    }
}

/// The live (not retired) capability whose posts `cap`'s comments are on: `cap` itself for a
/// surface kind; for a direct-message sibling the surface kind's capability holding the same
/// account; `None` without one, or for a kind that has no comments.
pub(crate) async fn surface_capability(
    r: &mut dyn TenantRepos,
    cap: &Capability,
) -> Result<Option<Capability>, AppError> {
    let kind = match cap.kind_key.as_str() {
        "facebook_page" | "instagram" | "trendyol" | "hepsiburada" => {
            return Ok(Some(cap.clone()));
        }
        "messenger" => "facebook_page",
        "instagram_dm" => "instagram",
        _ => return Ok(None),
    };
    let Some(account) = cap.external_id.as_deref().filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    Ok(r.capabilities()
        .list(CapabilityFilter {
            kind: Some(kind),
            ..Default::default()
        })
        .await?
        .into_iter()
        .find(|c| c.status != StoredStatus::Retired && c.external_id.as_deref() == Some(account)))
}

/// Sets public conversation `id`'s state to what its items imply ([`jt_inbox::public::derived_state`]):
/// `Ours` while one is owed, else `Theirs`; a snoozed or closed one is kept. Nothing for a
/// conversation that is gone or not public. The caller holds the workspace's inbox lock.
pub(crate) async fn settle_state(
    r: &mut dyn TenantRepos,
    id: ConversationId,
) -> Result<(), AppError> {
    let Some(conversation) = r.conversations().lock(id).await? else {
        return Ok(());
    };
    if public_channel_for_kind(&conversation.kind_key).is_none() {
        return Ok(());
    }
    let items = r.public_items().for_conversation(id).await?;
    let next = jt_inbox::public::derived_state(&items, &conversation.state);
    if next != conversation.state {
        r.conversations().update_state(id, next, None).await?;
    }
    Ok(())
}

/// Settles, before merge `snapshot` is applied, the state of each conversation that survives it
/// to what its items will imply once the merge moved them there (the items of the conversations
/// it coalesces join the survivor's). Run before the merge's own writes, which stamp every
/// conversation of the two people with the merge's time: written after them, the state's write
/// would be newer than the merge and its undo would read as refused ("edited after merge").
/// Undo needs nothing: it restores the conversations' states with their items.
pub(crate) async fn settle_for_merge(
    r: &mut dyn TenantRepos,
    snapshot: &crate::ports::inbox::MergeSnapshot,
) -> Result<(), AppError> {
    let targets = snapshot.conversation_targets();
    let mut moving: std::collections::BTreeMap<ConversationId, Vec<PublicItemId>> =
        Default::default();
    for parent in &snapshot.public_items {
        let target = targets
            .get(&parent.conversation_id)
            .copied()
            .unwrap_or(parent.conversation_id);
        moving.entry(target).or_default().push(parent.id);
    }
    for (target, ids) in moving {
        let Some(conversation) = r.conversations().lock(target).await? else {
            continue;
        };
        if public_channel_for_kind(&conversation.kind_key).is_none() {
            continue;
        }
        let mut items = r.public_items().for_conversation(target).await?;
        for id in ids {
            if !items.iter().any(|i| i.id == id)
                && let Some(item) = r.public_items().get(id).await?
            {
                items.push(item);
            }
        }
        let next = jt_inbox::public::derived_state(&items, &conversation.state);
        if next != conversation.state {
            r.conversations().update_state(target, next, None).await?;
        }
    }
    Ok(())
}

/// [`settle_state`] for each of `ids`, once each.
pub(crate) async fn settle_states(
    r: &mut dyn TenantRepos,
    ids: impl IntoIterator<Item = ConversationId>,
) -> Result<(), AppError> {
    for id in ids.into_iter().collect::<BTreeSet<_>>() {
        settle_state(r, id).await?;
    }
    Ok(())
}

/// What the provider tells of the subject of public-item `event` (see the module docs): asked
/// only for a comment or question whose subject the inbox does not know, or refreshed more than
/// [`SUBJECT_REFRESH`] before `now`, of a capability that takes public items, in a workspace
/// that receives, through the provider's [`crate::ports::connectors::PublicSurface`]. Lock-free
/// (no transaction is held across the call) and best-effort: every failure reads as nothing, so
/// intake never waits on the provider.
pub(crate) async fn subject_fetch(
    deps: &Deps,
    event: &InboundEvent,
    now: OffsetDateTime,
) -> Option<SubjectFacts> {
    if !matches!(event.kind, EventKind::Comment | EventKind::Question)
        || event.payload["erased_identity"] == true
    {
        return None;
    }
    let envelope = PublicEnvelope::from_payload(&event.payload)?;
    if !matches!(
        envelope.status,
        EnvelopeStatus::Open | EnvelopeStatus::Edited
    ) {
        return None;
    }
    let subject = envelope.subject.as_ref().filter(|s| subject_id_ok(s))?;
    let surface = deps.connectors.public(event.provider)?;
    let (cap, credential) = {
        let mut r = deps.uow.tenant(event.workspace_id).await.ok()?;
        if !matches!(
            r.workspace().get().await.ok()?.status,
            WorkspaceStatus::Active | WorkspaceStatus::PendingPayment
        ) {
            return None;
        }
        let routed = r.capabilities().find(event.capability_id?).await.ok()??;
        let cap = surface_capability(r.as_mut(), &routed).await.ok()??;
        if cap.status == StoredStatus::Retired || !comments_enabled(deps.apps.as_ref(), &cap) {
            return None;
        }
        let known = r
            .public_subjects()
            .find_by_external(cap.id, &subject.external_id)
            .await
            .ok()?;
        if known.is_some_and(|s| s.updated_at > now - SUBJECT_REFRESH) {
            return None;
        }
        let sealed = r.capabilities().read_sealed(cap.id).await.ok()??;
        let credential = open_credential(deps, event.workspace_id, &sealed).ok()?;
        (cap, credential)
    };
    surface
        .subject(&credential, &adapter_public(&cap), &subject.external_id)
        .await
        .ok()?
}

fn malformed() -> AppError {
    AppError::validation("invalid inbound payload", json!({}))
}

/// The kind of item `channel` carries.
fn kind_of(channel: Channel) -> Option<PublicKind> {
    match channel {
        Channel::InstagramComment | Channel::FacebookComment => Some(PublicKind::Comment),
        Channel::TrendyolQuestion | Channel::HepsiburadaQuestion => Some(PublicKind::Question),
        _ => None,
    }
}

/// When an item happened, as far as its message goes: the provider's time, never later than
/// five minutes after the event arrived (a clock ahead of ours cannot date it in the future).
fn item_at(event: &InboundEvent, env: &PublicEnvelope) -> OffsetDateTime {
    env.created_at.min(event.received_at + Duration::minutes(5))
}

fn subject_id_ok(subject: &EnvelopeSubject) -> bool {
    let chars = subject.external_id.chars().count();
    !subject.external_id.trim().is_empty() && chars <= MAX_EXTERNAL_ID_CHARS
}

/// Takes public-item `event` of capability `cap` (already the surface capability: see
/// `consumer::route`) into the inbox (see the module docs), with the subject facts `fetched`
/// before the transaction. Outcomes: `consumed`, `duplicate` (a replay, or our own reply's
/// echo already bound), `deferred` (a question's state before the question itself, or an own
/// comment the inbox cannot yet tell from our replies), `comments_not_enabled`. An erased author
/// is the `erased_identity` refusal (`erased_identity_drop`); a payload without an envelope, or
/// one that does not fit the capability, is a validation error.
pub(crate) async fn intake(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
    fetched: Option<&SubjectFacts>,
) -> Result<&'static str, AppError> {
    if !comments_enabled(deps.apps.as_ref(), cap) {
        return Ok("comments_not_enabled");
    }
    let channel = public_channel_for_kind(&cap.kind_key).ok_or_else(malformed)?;
    let env = PublicEnvelope::from_payload(&event.payload).ok_or_else(malformed)?;
    let event_kind = match event.kind {
        EventKind::Comment => PublicKind::Comment,
        EventKind::Question => PublicKind::Question,
        _ => return Err(malformed()),
    };
    if env.kind != event_kind || kind_of(channel) != Some(env.kind) {
        return Err(malformed());
    }
    let account = cap
        .external_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or_else(malformed)?;
    if env.author.is_self || env.author.id.as_deref() == Some(account) {
        return own(deps, ctx, r, event, cap, &env).await;
    }
    if !matches!(env.status, EnvelopeStatus::Open | EnvelopeStatus::Edited) {
        return status(deps, ctx, r, event, cap, &env).await;
    }
    let identity_channel = channel.identity_channel();
    // An author the provider does not name is a person of this one item.
    let raw = env
        .author
        .id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| match env.kind {
            PublicKind::Comment => format!("c:{}", env.external_id),
            PublicKind::Question => format!("q:{}", env.external_id),
        });
    let key = scope_opaque(
        account,
        &normalise(identity_channel, &raw).map_err(|_| malformed())?,
    );
    super::erasure::check_identity(r, identity_channel, &key).await?;
    if let Some(item) = r
        .public_items()
        .find_by_external(cap.id, &env.external_id)
        .await?
    {
        return match env.status {
            EnvelopeStatus::Edited => revision(deps, ctx, r, event, cap, item, &env, &key).await,
            _ => Ok("duplicate"),
        };
    }
    if r.messages()
        .find_by_external_id(cap.id, &env.external_id)
        .await?
        .is_some()
    {
        return Ok("duplicate");
    }
    // No journey: a commenter or an asker becomes a lead when buying intent shows (D4).
    let person = people::match_or_create_with(
        deps,
        ctx,
        r,
        people::CreateInput {
            display_name: env
                .author
                .name
                .as_deref()
                .map(super::consumer::clean_name)
                .unwrap_or_default(),
            identities: vec![people::IdentityInput {
                channel: identity_channel,
                value: raw,
                capability_id: Some(cap.id),
            }],
            source: Source::Channel(channel),
        },
        Some(0),
        false,
    )
    .await?
    .person;
    let subject_id = match &env.subject {
        Some(subject) if subject_id_ok(subject) => {
            Some(upsert_subject(deps, ctx, r, cap, subject, fetched).await?)
        }
        _ => None,
    };
    let at = item_at(event, &env);
    let conversation = r
        .conversations()
        .upsert_on_inbound(Conversation {
            id: ConversationId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            person_id: person.id,
            capability_id: cap.id,
            kind_key: cap.kind_key.clone(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(at),
            last_outbound_at: None,
            created_at: ctx.now,
            updated_at: ctx.now,
        })
        .await?;
    let Some(message_id) = r
        .messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: conversation.id,
            direction: Direction::Inbound,
            author: Author::Customer,
            body: env.text.clone(),
            external_id: Some(env.external_id.clone()),
            status: MsgStatus::Received,
            cost_minor: None,
            at,
        })
        .await?
    else {
        return Ok("duplicate");
    };
    record_sender(r, person.id, identity_channel, &key, message_id).await?;
    let rules = jt_inbox::public::rules(channel).ok_or_else(malformed)?;
    let item = PublicItem {
        id: PublicItemId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        capability_id: cap.id,
        conversation_id: conversation.id,
        message_id,
        subject_id,
        kind: env.kind,
        external_id: env.external_id.clone(),
        parent_external_id: env.parent_external_id.clone(),
        root_external_id: env.root_external_id.clone(),
        created_at: env.created_at,
        deadline: env.deadline,
        private_reply_until: jt_inbox::public::private_reply_until(
            &rules,
            env.created_at,
            env.live,
        ),
        live: env.live,
        answer: AnswerState::Awaiting,
        moderation: Moderation::Visible,
        private_reply_message_id: None,
        agent_answers: 0,
        checked_at: None,
        updated_at: ctx.now,
    };
    // The item was looked for under the workspace lock: a replay here is a broken invariant.
    if !r.public_items().insert(item).await? {
        return Err(AppError::internal("public item appeared during intake"));
    }
    settle_state(r, conversation.id).await?;
    Ok("consumed")
}

/// Records `message` as received from `person`'s identity `key` on `channel`
/// (`MessageRepo::record_inbound_sender`); nothing when the person holds no such identity.
async fn record_sender(
    r: &mut dyn TenantRepos,
    person: PersonId,
    channel: IdentityChannel,
    key: &str,
    message: MessageId,
) -> Result<(), AppError> {
    let identity = r
        .identities()
        .list(person)
        .await?
        .into_iter()
        .find(|i| i.channel == channel && i.value_normalized == key);
    if let Some(identity) = identity {
        r.messages()
            .record_inbound_sender(message, identity.id)
            .await?;
    }
    Ok(())
}

/// A new revision of known `item`'s text (its author edited it): a new inbound message, under
/// the event's own external id, becomes the item's message; its answer state stays.
#[allow(clippy::too_many_arguments)]
async fn revision(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
    item: PublicItem,
    env: &PublicEnvelope,
    key: &str,
) -> Result<&'static str, AppError> {
    if r.messages()
        .find_by_external_id(cap.id, &event.external_id)
        .await?
        .is_some()
    {
        return Ok("duplicate");
    }
    let Some(mut item) = r.public_items().lock(item.id).await? else {
        return Ok("deferred");
    };
    let conversation = r
        .conversations()
        .get(item.conversation_id)
        .await?
        .ok_or_else(|| AppError::internal("public item conversation missing"))?;
    let Some(message_id) = r
        .messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: item.conversation_id,
            direction: Direction::Inbound,
            author: Author::Customer,
            body: env.text.clone(),
            external_id: Some(event.external_id.clone()),
            status: MsgStatus::Received,
            cost_minor: None,
            at: event.received_at,
        })
        .await?
    else {
        return Ok("duplicate");
    };
    let channel = public_channel_for_kind(&cap.kind_key).ok_or_else(malformed)?;
    record_sender(
        r,
        conversation.person_id,
        channel.identity_channel(),
        key,
        message_id,
    )
    .await?;
    item.message_id = message_id;
    item.updated_at = ctx.now;
    r.public_items().update(item.clone()).await?;
    settle_state(r, item.conversation_id).await?;
    Ok("consumed")
}

/// What `fetched` and the envelope's `subject` tell of a post or product of `cap`, stored (a new
/// subject, or a refresh with `fetched`) and linked to the Studio publication that made the post
/// when one did; its id. A known subject without new facts is left as it is.
async fn upsert_subject(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Capability,
    subject: &EnvelopeSubject,
    fetched: Option<&SubjectFacts>,
) -> Result<PublicSubjectId, AppError> {
    let known = r
        .public_subjects()
        .find_by_external(cap.id, &subject.external_id)
        .await?;
    if let Some(known) = &known
        && fetched.is_none()
    {
        return Ok(known.id);
    }
    let fit = |s: &str, max: usize| -> String {
        let clean: String = s
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        clean
            .trim()
            .chars()
            .take(max)
            .collect::<String>()
            .trim()
            .to_owned()
    };
    let link = |s: Option<&String>, max: usize| {
        s.map(|s| s.trim().to_owned()).filter(|s| {
            !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
        })
    };
    let mut facts = match &subject.facts {
        Value::Object(fields) => fields.clone(),
        _ => Map::new(),
    };
    if let Some(Value::Object(more)) = fetched.map(|f| &f.facts) {
        facts.extend(more.clone());
    }
    let title = match fetched
        .map(|f| f.title.as_str())
        .filter(|t| !t.trim().is_empty())
    {
        Some(title) => title,
        None => subject.title.as_str(),
    };
    let publication_id = match known.as_ref().and_then(|s| s.publication_id) {
        Some(id) => Some(id),
        // The Studio post this subject is, when Studio published it on this capability.
        None => r
            .studio()
            .list_publications()
            .await?
            .into_iter()
            .find(|p| p.capability_id == cap.id && p.external_id == subject.external_id)
            .map(|p| p.id.as_uuid()),
    };
    let stored = r
        .public_subjects()
        .upsert(PublicSubject {
            id: known
                .as_ref()
                .map_or_else(|| PublicSubjectId::from(deps.ids.uuid()), |s| s.id),
            workspace_id: ctx.workspace_id,
            capability_id: cap.id,
            kind: fetched.map_or(subject.kind, |f| f.kind),
            external_id: subject.external_id.clone(),
            title: fit(title, MAX_SUBJECT_TITLE_CHARS),
            url: link(fetched.and_then(|f| f.url.as_ref()), MAX_SUBJECT_URL_CHARS)
                .or_else(|| link(subject.url.as_ref(), MAX_SUBJECT_URL_CHARS)),
            image_url: link(
                fetched.and_then(|f| f.image_url.as_ref()),
                MAX_SUBJECT_IMAGE_URL_CHARS,
            )
            .or_else(|| link(subject.image_url.as_ref(), MAX_SUBJECT_IMAGE_URL_CHARS)),
            facts: Value::Object(facts),
            publication_id,
            first_seen_at: ctx.now,
            updated_at: ctx.now,
        })
        .await?;
    Ok(stored.id)
}

/// A comment of the account itself (see `intake`): our reply's echo, bound to our reply in
/// flight to the same parent with the same text (its outbox intent's target is the parent: spec
/// §6.4 step 2; its provider id set: the receipt finalises it), or else an answer given outside
/// Jeeta, recorded as a system message on the parent item's conversation and answering the
/// parent (`AnsweredElsewhere`). A comment
/// answering no item the inbox knows is consumed with nothing written; two replies of ours it
/// could be are deferred (the receipts bind them meanwhile).
async fn own(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
    env: &PublicEnvelope,
) -> Result<&'static str, AppError> {
    if r.messages()
        .find_by_external_id(cap.id, &env.external_id)
        .await?
        .is_some()
    {
        return Ok("duplicate");
    }
    let Some(parent) = env.parent_external_id.as_deref() else {
        return Ok("consumed");
    };
    let Some(parent) = r.public_items().find_by_external(cap.id, parent).await? else {
        return Ok("consumed");
    };
    let Some(parent) = r.public_items().lock(parent.id).await? else {
        return Ok("consumed");
    };
    // Our replies in flight with the same text, to this parent: a reply to another item of the
    // conversation is not this comment.
    let mut candidates = Vec::new();
    for sent in r
        .messages()
        .echo_candidates(parent.conversation_id, &env.text, event.received_at)
        .await?
    {
        let to_parent = r.outbox().for_message(sent.id).await?.is_some_and(|row| {
            row.intent["public"]["target"]["external_id"].as_str()
                == Some(parent.external_id.as_str())
        });
        if to_parent {
            candidates.push(sent);
        }
    }
    match candidates.as_slice() {
        [sent] => {
            // Only the provider id: the receipt owns status, outbox and item transitions.
            r.messages()
                .set_status(
                    sent.id,
                    sent.status.clone(),
                    Some(env.external_id.clone()),
                    sent.cost_minor,
                )
                .await?;
            return Ok("consumed");
        }
        [] => {}
        _ => return Ok("deferred"),
    }
    let message_id = r
        .messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: parent.conversation_id,
            direction: Direction::Outbound,
            author: Author::System,
            body: env.text.clone(),
            external_id: Some(env.external_id.clone()),
            status: MsgStatus::Sent,
            cost_minor: None,
            at: item_at(event, env),
        })
        .await?;
    if let Ok(next) = jt_inbox::public::apply(
        &parent,
        ItemEvent::AnsweredElsewhere { message_id },
        ctx.now,
    ) {
        r.public_items().update(next).await?;
    }
    settle_state(r, parent.conversation_id).await?;
    Ok("consumed")
}

/// A provider's new state of a known item (see `intake`): `answered` confirms our answer in
/// review when the provider shows its text, else answers the item elsewhere (the shown answer
/// recorded as a system message); `rejected` refuses our answer in review (ledger
/// `inbox.public.answer_rejected`); `expired`, `removed` and `reported` as named. A state the
/// item cannot take changes nothing. An unknown question is `deferred` (its `open` state comes
/// first); an unknown comment is consumed.
async fn status(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    cap: &Capability,
    env: &PublicEnvelope,
) -> Result<&'static str, AppError> {
    let found = r
        .public_items()
        .find_by_external(cap.id, &env.external_id)
        .await?;
    let item = match found {
        Some(item) => r.public_items().lock(item.id).await?,
        None => None,
    };
    let Some(item) = item else {
        return Ok(match env.kind {
            PublicKind::Question => "deferred",
            PublicKind::Comment => "consumed",
        });
    };
    let shown = env
        .answer
        .as_ref()
        .map(|a| a.text.trim())
        .filter(|t| !t.is_empty());
    let next = match env.status {
        EnvelopeStatus::Answered => match &item.answer {
            AnswerState::Answered { .. } => return Ok("consumed"),
            AnswerState::Pending { message_id } => {
                let ours = r.messages().get(*message_id).await?;
                let confirmed = match shown {
                    None => true,
                    Some(text) => ours.is_some_and(|m| m.body.trim() == text),
                };
                if confirmed {
                    jt_inbox::public::apply(&item, ItemEvent::AnswerConfirmed, ctx.now)
                } else {
                    let message_id = elsewhere(deps, ctx, r, event, &item, env).await?;
                    jt_inbox::public::apply(
                        &item,
                        ItemEvent::AnsweredElsewhere { message_id },
                        ctx.now,
                    )
                }
            }
            AnswerState::Awaiting | AnswerState::Rejected { .. } => {
                let message_id = elsewhere(deps, ctx, r, event, &item, env).await?;
                jt_inbox::public::apply(&item, ItemEvent::AnsweredElsewhere { message_id }, ctx.now)
            }
            AnswerState::Handled { .. } | AnswerState::Expired { .. } => {
                return Ok("consumed");
            }
        },
        EnvelopeStatus::Rejected => {
            let reason = env
                .rejection
                .as_ref()
                .map(|r| r.reason.trim().chars().take(500).collect::<String>())
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| "rejected".into());
            let next =
                jt_inbox::public::apply(&item, ItemEvent::AnswerRejected { reason }, ctx.now);
            if next.is_ok() {
                record(
                    r,
                    ctx,
                    "inbox.public.answer_rejected",
                    "public_item",
                    item.id,
                    json!({"item_id": item.id, "conversation_id": item.conversation_id}),
                )
                .await?;
            }
            next
        }
        EnvelopeStatus::Expired => jt_inbox::public::apply(&item, ItemEvent::Expired, ctx.now),
        EnvelopeStatus::Removed => jt_inbox::public::apply(&item, ItemEvent::Removed, ctx.now),
        EnvelopeStatus::Reported => jt_inbox::public::apply(&item, ItemEvent::Reported, ctx.now),
        // In the platform's review: our receipt already made it pending.
        EnvelopeStatus::Pending | EnvelopeStatus::Open | EnvelopeStatus::Edited => {
            return Ok("consumed");
        }
    };
    if let Ok(next) = next {
        r.public_items().update(next).await?;
        settle_state(r, item.conversation_id).await?;
    }
    Ok("consumed")
}

/// The answer a provider shows for `item`, given outside Jeeta, as an outbound system message
/// of its conversation; `None` when the provider shows no text.
async fn elsewhere(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    event: &InboundEvent,
    item: &PublicItem,
    env: &PublicEnvelope,
) -> Result<Option<MessageId>, AppError> {
    let Some(answer) = env.answer.as_ref().filter(|a| !a.text.trim().is_empty()) else {
        return Ok(None);
    };
    let at = answer
        .at
        .unwrap_or(event.received_at)
        .min(event.received_at + Duration::minutes(5));
    r.messages()
        .insert_if_new(Message {
            id: MessageId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            conversation_id: item.conversation_id,
            direction: Direction::Outbound,
            author: Author::System,
            body: answer.text.clone(),
            external_id: None,
            status: MsgStatus::Sent,
            cost_minor: None,
            at,
        })
        .await
}

// ---------------------------------------------------------------------------------------------
// Replies: the fence, receipts, approval
// ---------------------------------------------------------------------------------------------

/// A refusal of a reply on a public conversation: `FORBIDDEN` with the refusal's key as its
/// reason (the outbox's `refused` handling and `inbox.send.refused` read it).
pub(crate) fn refusal(reason: impl std::fmt::Display) -> AppError {
    let reason = reason.to_string();
    AppError {
        code: crate::error::ErrorCode::Forbidden,
        message: reason.clone(),
        details: json!({ "reason": reason }),
    }
}

/// Why `text` may not be sent as a reply of `visibility` on public `conversation` (on
/// `channel`): spec §3.6 rule 5 (`jt_inbox::public::check_text`) against the person's own active
/// phone numbers and email addresses; `None` when it may.
pub(crate) async fn text_refusal(
    r: &mut dyn TenantRepos,
    conversation: &Conversation,
    channel: Channel,
    visibility: Visibility,
    text: &str,
) -> Result<Option<PublicRefusal>, AppError> {
    let rules = jt_inbox::public::rules(channel)
        .ok_or_else(|| AppError::internal("a public conversation without rules"))?;
    let contacts: Vec<String> = r
        .identities()
        .list(conversation.person_id)
        .await?
        .into_iter()
        .filter(|i| {
            i.active && matches!(i.channel, IdentityChannel::Phone | IdentityChannel::Email)
        })
        .map(|i| i.value_normalized)
        .collect();
    Ok(jt_inbox::public::check_text(&rules, visibility, text, &contacts).err())
}

/// What a reply on a public conversation answers, once fenced ([`reply_fence`]).
pub(crate) struct Fenced {
    pub item: PublicItem,
    pub target: PublicTarget,
}

/// The reply fence of a public conversation (spec §3.6 rules 2 to 6; rule 1, commercial intent,
/// is the caller's, before the domain fence): run at enqueue (`count_cap`, rule 6) and again at
/// claim and approval. `item_id` names the item replied to on `conversation` of `cap` (on
/// `channel`), `text` the reply, `by_agent` whether the agent sends it. The item is locked.
///
/// Rule 4 also holds one reply in flight per item and visibility (spec D19): `reply_in_flight`
/// while another reply of the item with that visibility is held, queued or sending (`except`,
/// the row being claimed or approved, left out). An uncertain one (`unknown`) counts for the
/// agent only, until reconciliation settles it: a human can look at the platform first.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reply_fence(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    conversation: &Conversation,
    cap: &Capability,
    channel: Channel,
    item_id: Option<PublicItemId>,
    visibility: Visibility,
    text: &str,
    by_agent: bool,
    count_cap: bool,
    except: Option<uuid::Uuid>,
) -> Result<Fenced, AppError> {
    // 2. A Meta surface without the comment grant (a marketplace's always holds).
    if !comments_enabled(deps.apps.as_ref(), cap) {
        return Err(refusal(PublicRefusal::CommentsNotEnabled));
    }
    // 3. The item, of this conversation.
    let id = item_id.ok_or_else(|| refusal(PublicRefusal::ItemRequired))?;
    let item = r
        .public_items()
        .lock(id)
        .await?
        .filter(|item| item.conversation_id == conversation.id)
        .ok_or_else(|| refusal(PublicRefusal::ItemNotInConversation))?;
    let rules = jt_inbox::public::rules(channel)
        .ok_or_else(|| AppError::internal("a public conversation without rules"))?;
    // 4. The item takes this reply now.
    jt_inbox::public::reply_allowed(&item, &rules, visibility, by_agent, ctx.now)
        .map_err(refusal)?;
    // One reply in flight per item and visibility (the workspace's inbox lock is held).
    let in_flight = r
        .outbox()
        .public_replies_in_flight(item.id, visibility, except)
        .await?;
    if in_flight.iter().any(|state| by_agent || state != "unknown") {
        return Err(refusal("reply_in_flight"));
    }
    // 5. The text: bounds, the person's own contact data, a marketplace's contact data.
    if let Some(refused) = text_refusal(r, conversation, channel, visibility, text).await? {
        return Err(refusal(refused));
    }
    // 6. The capability's daily cap on the agent's public replies, counted under its lock with
    // every row of the day but refused ones: held and in-flight replies count.
    if count_cap && by_agent && visibility == Visibility::Public {
        let locked = crate::usecases::capabilities::locked(r, cap.id).await?;
        if let Some(cap_per_day) = locked.policy.daily_ops_cap {
            let (day_start, _) = crate::usecases::calls::local_day(&locked, ctx.now);
            let today = r
                .outbox()
                .agent_public_replies_since(cap.id, day_start)
                .await?;
            if today >= cap_per_day {
                return Err(refusal("daily_ops_cap"));
            }
        }
    }
    let subject_external_id = match item.subject_id {
        Some(id) => r.public_subjects().get(id).await?.map(|s| s.external_id),
        None => None,
    };
    let target = PublicTarget {
        kind: item.kind,
        external_id: item.external_id.clone(),
        parent_external_id: item.parent_external_id.clone(),
        subject_external_id,
    };
    Ok(Fenced { item, target })
}

/// What an outbox intent says of its public item: `None` for a reply that is not one.
pub(crate) struct Intent {
    pub item_id: PublicItemId,
    pub visibility: Visibility,
    pub target: PublicTarget,
}

/// The public part of outbox `intent` (`intent.public`), if any.
pub(crate) fn intent_of(intent: &Value) -> Result<Option<Intent>, AppError> {
    let Some(public) = intent.get("public") else {
        return Ok(None);
    };
    Ok(Some(Intent {
        item_id: serde_json::from_value(public["item_id"].clone())?,
        visibility: serde_json::from_value(public["visibility"].clone())?,
        target: serde_json::from_value(public["target"].clone())?,
    }))
}

/// A public reply's receipt (spec §6.5), in the result's transaction: the item answered
/// (`AnswerSent`: pending on a moderated surface; `agent_answers` counted for the agent's own
/// answer) or privately replied (`PrivateReplySent`, and the recipient's direct-message id linked
/// to the person, D5), and the conversation's state settled. A receipt is a fact: taken from any
/// state.
pub(crate) async fn on_receipt(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    row: &OutboxRow,
    recipient: Option<&str>,
) -> Result<(), AppError> {
    let Some(intent) = intent_of(&row.intent)? else {
        return Ok(());
    };
    let Some(item) = r.public_items().lock(intent.item_id).await? else {
        return Ok(());
    };
    let cap = r
        .capabilities()
        .find(item.capability_id)
        .await?
        .ok_or_else(|| AppError::internal("a public item's capability is gone"))?;
    let channel = public_channel_for_kind(&cap.kind_key)
        .ok_or_else(|| AppError::internal("a public item on a private kind"))?;
    let rules = jt_inbox::public::rules(channel)
        .ok_or_else(|| AppError::internal("a public conversation without rules"))?;
    let author = r
        .messages()
        .get(row.message_id)
        .await?
        .map(|m| m.author)
        .ok_or_else(|| AppError::not_found("no such message"))?;
    let event = match intent.visibility {
        Visibility::Public => ItemEvent::AnswerSent {
            message_id: row.message_id,
            moderated: rules.moderated,
        },
        Visibility::Private => ItemEvent::PrivateReplySent {
            message_id: row.message_id,
        },
    };
    let mut next = jt_inbox::public::apply(&item, event, ctx.now)
        .map_err(|_| AppError::internal("a receipt was refused by its item"))?;
    if intent.visibility == Visibility::Public && author == Author::Agent {
        next.agent_answers = next.agent_answers.saturating_add(1);
    }
    r.public_items().update(next).await?;
    if intent.visibility == Visibility::Private
        && let Some(recipient) = recipient.filter(|r| !r.trim().is_empty())
    {
        link_recipient(deps, ctx, r, &cap, &item, recipient).await?;
    }
    settle_state(r, item.conversation_id).await
}

/// Links a private reply's recipient (the commenter's direct-message id, VERIFY V-M5) to the
/// item's person in the capability's direct-message namespace: added when nobody holds it, a
/// merge suggestion when another person does (ledger `inbox.public.identity_linked`).
async fn link_recipient(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Capability,
    item: &PublicItem,
    recipient: &str,
) -> Result<(), AppError> {
    let channel = match cap.kind_key.as_str() {
        "instagram" => IdentityChannel::InstagramDm,
        "facebook_page" => IdentityChannel::Messenger,
        _ => return Ok(()),
    };
    let Some(account) = cap.external_id.as_deref().filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let Ok(value) = normalise(channel, recipient) else {
        return Ok(());
    };
    let Some(conversation) = r.conversations().get(item.conversation_id).await? else {
        return Ok(());
    };
    let outcome = people::link_identity(
        deps,
        ctx,
        r,
        conversation.person_id,
        channel,
        scope_opaque(account, &value),
        value,
    )
    .await?;
    if matches!(outcome, "added" | "merge_suggested") {
        record(
            r,
            ctx,
            "inbox.public.identity_linked",
            "public_item",
            item.id,
            json!({"item_id": item.id, "channel": channel, "outcome": outcome}),
        )
        .await?;
    }
    Ok(())
}

/// A public reply the provider refused because its item is gone (`PUBLIC_ITEM_GONE`): the item
/// is removed, and the conversation's state settled. In the result's transaction.
pub(crate) async fn on_gone(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    row: &OutboxRow,
) -> Result<(), AppError> {
    let Some(intent) = intent_of(&row.intent)? else {
        return Ok(());
    };
    let Some(item) = r.public_items().lock(intent.item_id).await? else {
        return Ok(());
    };
    if let Ok(next) = jt_inbox::public::apply(&item, ItemEvent::Removed, ctx.now) {
        r.public_items().update(next).await?;
    }
    settle_state(r, item.conversation_id).await
}

/// What approving a held reply may change.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveInput {
    /// The text to send instead of the draft's; fenced as the reply.
    #[serde(default)]
    pub text: Option<String>,
}

/// Approves held reply `outbox_id` (spec §3.7, D20): a human with `inbox.work` (`human_required`
/// otherwise). An edited text, which replaces the draft's, is checked first (spec §3.6 rule 5):
/// refused, the error is `VALIDATION` with the refusal as `details.reason`, and the reply stays
/// held for another try. Then the full fence runs again with the approver as the author; a
/// refusal is the error, and only one saying the item can no longer take the reply
/// (`item_removed`, `deadline_passed`, `already_answered`, `item_not_in_conversation`,
/// `reply_in_flight`) also refuses the reply (the panel shows why); any other (`capability_down`,
/// `workspace_inactive`, …) leaves it held. Once fenced, the message's author becomes the approver
/// (the drafter stays in `intent.public.drafted_by`), the row is queued and sent. Ledger
/// `inbox.public.approved {edited}`.
pub async fn approve(
    deps: &Deps,
    ctx: &Ctx,
    outbox_id: uuid::Uuid,
    input: ApproveInput,
) -> Result<super::replies::ReplyOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let jt_ledger::Actor::Human { user_id } = ctx.actor else {
        return Err(refusal("human_required"));
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let result =
        super::replies::approve_in(deps, ctx, r.as_mut(), outbox_id, user_id, input.text).await;
    match &result {
        Ok(_) => r.commit().await?,
        Err(e) if e.code == crate::error::ErrorCode::Forbidden => r.commit().await?,
        Err(_) => {}
    }
    result?;
    super::replies::send_step(deps, ctx, outbox_id).await
}

/// Discards held reply `outbox_id` (spec §3.7): a human with `inbox.work`, or the agent
/// connection that drafted it (`not_the_drafter` otherwise). The row is refused with reason
/// `discarded`, its message too. Ledger `inbox.public.discarded`.
pub async fn discard(
    deps: &Deps,
    ctx: &Ctx,
    outbox_id: uuid::Uuid,
) -> Result<super::replies::ReplyOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let out = super::replies::discard_in(ctx, r.as_mut(), outbox_id).await?;
    r.commit().await?;
    Ok(out)
}
