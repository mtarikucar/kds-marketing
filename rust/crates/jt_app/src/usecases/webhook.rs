//! Webhook intake (spec §4.4, §11): storing what providers send, once, in the workspace it
//! belongs to; NetGSM's per-workspace hook tokens; and the raw-body purge.
//!
//! The webhook gate (`jt_webhook`) authenticates a delivery and parses it with the provider's
//! adapter before anything here runs: Meta's body signature, NetGSM's path token
//! ([`netgsm_hook_open`]). These use cases are not in the catalog: no person or agent calls them,
//! a provider does, through the gate.
//!
//! **Routing (Review Focus 1).** Meta's events name the provider account they arrived for (a
//! page, an Instagram account, a WhatsApp number), and TikTok's the account's open id.
//! [`receive_for_accounts`] (and [`receive_tiktok`], for TikTok's) finds, across every
//! workspace, the one capability that holds that account *connected*
//! ([`crate::ports::PlatformRepos::capability_by_external`]: sealed credentials, verified at
//! least once by a probe, not retired; a verified one before an unreachable one, then the newest)
//! and stores the event in that capability's workspace. An event no workspace holds connected is
//! **dropped**: no tenant row is written anywhere ([`Delivery::Unrouted`]; the gate logs and
//! counts it). So is an event whose workspace is **suspended** ([`Delivery::Inactive`]): a
//! workspace that is active or awaits payment keeps receiving (its accounts stay connected while
//! the payment is settled), a suspended one receives nothing. NetGSM signs nothing: each
//! workspace's callback URL carries a token of its own (HMAC under the workspace's MAC key for
//! [`NETGSM_HOOK_PURPOSE`]), so a NetGSM event is stored in the workspace its URL names, and only
//! once the token matched and while that workspace is active or awaits payment
//! ([`netgsm_hook_open`]).
//!
//! **Deduplication (Review Focus 2).** An event is stored once per `(workspace, provider,
//! external_id)`: a replayed delivery, or the same item twice in one body, is
//! [`Delivery::Duplicate`] and changes nothing. Two deliveries racing on one event store it once
//! (the repository's unique key; the second waits for the first). Within a delivery, the
//! workspaces are written in id order and each one's events in the order of their provider ids,
//! so two deliveries of overlapping events, batched differently, take their locks in one order
//! and cannot deadlock.
//!
//! **What is stored.** Each event with its parsed payload, the time it was received (the clock)
//! and the capability it arrived through when known; and a raw body, **once per delivery and
//! workspace**: beside the first event the delivery newly stores there (a body of a thousand
//! events is not kept a thousand times; its siblings share its `received_at`). The raw body is
//! **the workspace's own**: a NetGSM body names one workspace and is kept as received; a Meta
//! body may batch several workspaces' accounts, so each workspace keeps only the part of it its
//! own events came from ([`ScopedRaw`]: the body as received when that is all of it), and an
//! item no workspace took (unrouted, or of a suspended workspace) is kept nowhere. The body is
//! kept for [`RAW_RETENTION`] and then removed by the daily purge ([`purge_raw`]). When the
//! provider said when the event happened, the payload (an object) also carries `occurred_at`
//! (RFC 3339), unless the provider's item already names that key. Inbound events are records of
//! the outside world: no ledger entry.
//!
//! **TikTok** ([`receive_tiktok`]). One event per delivery, routed by its open id to every
//! workspace holding that `tiktok` account connected (an event naming a post: to the workspace
//! that sent it) and stored there once (by the event's identity: `jt_tiktok::webhook`), its body
//! kept beside it. In the same transaction, an event newly stored takes its effect:
//! `authorization.removed` turns the capability unreachable and asks for a reconnection
//! (`super::connector::authorization_removed`, unless the event predates the capability's last
//! verification), and the event is marked processed; a `post.publish.*` event that moved a post
//! names the post to read back ([`TiktokIntake::resolve`]), which the gate does after answering
//! ([`resolve_hooked`]: the recovery job's own read-back, so the two settle a post alike, and the
//! upgrade of a post settled before TikTok named its public id), and that read marks the event
//! processed (a redelivery names the post again, the read being idempotent). Any other event is
//! left unprocessed, for the agent (`events.pending`). The status poll (`studio_publish_recover`)
//! and the hourly probe stay: a delivery that never arrives changes only how soon a post settles
//! or a lost access shows.

use std::collections::BTreeMap;

use jt_capability::{CapabilityId, StoredStatus};
use jt_connector::{InboundEvent, InboundEventId, NetgsmPurpose, Provider, netgsm_token_ok};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use super::Deps;
use crate::error::AppError;
use crate::ports::connectors::InboundEventDraft;
use crate::ports::{CapabilityFilter, TenantRepos};

/// Where Meta delivers its webhooks, under the public base URL.
pub const META_HOOK_PATH: &str = "/hooks/meta";
/// Where NetGSM delivers its callbacks, under the public base URL; followed by
/// `/{workspace_id}/{token}/{purpose}`.
pub const NETGSM_HOOK_PATH: &str = "/hooks/netgsm";
/// Where TikTok delivers its webhooks (the callback URL of the platform's TikTok app, one for
/// every workspace: TikTok signs each delivery and the system routes it by account), under the
/// public base URL.
pub const TIKTOK_HOOK_PATH: &str = "/hooks/tiktok";
/// The purpose of the workspace MAC key NetGSM hook tokens are computed under
/// (`SecretBox::hmac_key`).
pub const NETGSM_HOOK_PURPOSE: &str = "netgsm-hook";
/// How long the raw body of an event is kept (spec §10).
pub const RAW_RETENTION: Duration = Duration::days(30);

/// What became of one event of a delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Stored, as this event.
    Stored(InboundEventId),
    /// The workspace already held it: a replay, changing nothing.
    Duplicate,
    /// No workspace holds its account connected: dropped, nothing written.
    Unrouted,
    /// The workspace that holds its account connected is suspended: dropped, nothing written.
    Inactive,
}

/// Whether a workspace in `status` takes provider events routed to it by account: while it is
/// active or awaits payment, not while it is suspended.
pub fn takes_routed_events(status: WorkspaceStatus) -> bool {
    match status {
        WorkspaceStatus::Active | WorkspaceStatus::PendingPayment => true,
        WorkspaceStatus::Suspended => false,
    }
}

/// What a delivery keeps as the raw body beside the events one workspace stores from it, given
/// their indexes among the delivery's events (ascending): the part of the body those events came
/// from, never another workspace's items nor those of an event no workspace took (the gate cuts
/// the body, which only the provider's adapter can read: `jt_meta::scoped_body`); `None` keeps
/// none. Asked at most once per workspace and delivery, and only while an event may be newly
/// stored there.
pub type ScopedRaw<'a> = dyn Fn(&[usize]) -> Option<Vec<u8>> + Sync + 'a;

/// One event of a provider that names its account: which capability kinds may hold the account
/// (`kind_keys`), the provider's id of the account, and the event.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountEvent {
    pub kind_keys: &'static [&'static str],
    pub external_account_id: String,
    pub draft: InboundEventDraft,
}

/// What a TikTok webhook event asks of the system once stored (see the module docs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TiktokHookEffect {
    /// `authorization.removed`: the account removed the app's access; TikTok's reason, by its key
    /// (`jt_tiktok::webhook::AUTHORIZATION_REASONS`).
    AuthorizationRemoved { reason: String },
    /// A `post.publish.*` event that moved a post (failed, posted, delivered to the creator's
    /// inbox, made public): its publish id, the receipt id of the attempt that sent it.
    PublishMoved { publish_id: String },
    /// Nothing: kept for the agent to read.
    Kept,
}

/// One TikTok webhook event, read and authenticated by the gate.
#[derive(Clone, Debug, PartialEq)]
pub struct TiktokHookEvent {
    /// The account it is about (`user_openid`): a `tiktok` capability's external id; empty when
    /// the event names none (it is then routed nowhere).
    pub open_id: String,
    /// The post it is about (`content.publish_id`), when it names one: it routes the event to the
    /// workspace that sent that post.
    pub publish_id: Option<String>,
    pub effect: TiktokHookEffect,
    pub draft: InboundEventDraft,
}

/// A post a TikTok webhook said moved: what [`resolve_hooked`] reads back, and the event to mark
/// processed once it did (`None` for a redelivery).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookedPublication {
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    pub publish_id: String,
    pub event_id: Option<InboundEventId>,
}

/// What became of a TikTok webhook event ([`receive_tiktok`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TiktokIntake {
    /// Each workspace it was routed to, in workspace order, and what became of it there; empty
    /// when it was routed nowhere.
    pub stored: Vec<(WorkspaceId, Delivery)>,
    /// Why it was routed nowhere ([`Delivery::Unrouted`] or [`Delivery::Inactive`]); `None` once
    /// it was routed.
    pub dropped: Option<Delivery>,
    /// The posts to read back now, once the delivery is answered: for a `post.publish.*` event
    /// stored, or delivered again, in a workspace.
    pub resolve: Vec<HookedPublication>,
}

impl TiktokIntake {
    fn dropped(delivery: Delivery) -> TiktokIntake {
        TiktokIntake {
            stored: Vec::new(),
            dropped: Some(delivery),
            resolve: Vec::new(),
        }
    }
}

/// Stores TikTok's `event` (see the module docs) in each workspace it is routed to, with the raw
/// body `raw`, takes its effect there when it is newly stored, and answers what became of it.
///
/// Routing: the capabilities holding the event's account connected (sealed credentials, verified
/// once by a probe, not retired: `PlatformRepos::capabilities_holding`), in every workspace that
/// takes routed events; an event naming no account, or one nobody holds connected, is
/// [`Delivery::Unrouted`], and one whose holders' workspaces are all suspended
/// [`Delivery::Inactive`], written nowhere. An event naming a post goes to the workspaces whose
/// capability sent it (an attempt whose receipt is that publish id), else to every holder; any
/// other (`authorization.removed` among them: a lost access reaches every holder) to every
/// holder.
///
/// In each workspace, in one transaction: the capability is locked first when the effect is on it
/// (a probe holding it across its call is waited for before anything else is taken, the erasure
/// lock included), the event stored once (with `InboundEventRepo::insert_if_new`, which takes
/// the erasure lock and scrubs as every inbound insert does; the delivery-level
/// erasure step of [`receive_for_accounts`] is not needed, TikTok's events being about the
/// account and its posts, never a person: `jt_tiktok::webhook` keeps no identity in them, and an
/// event that names a person, such as a comment, must go through [`receive_for_accounts`]), and,
/// when newly stored, its effect taken:
/// `authorization.removed` is `super::connector::authorization_removed` (left alone when the
/// event is older than the capability's last verification: a reconnection since, or the
/// revocation of a retired sibling, which TikTok reports too) and marks the event processed; a
/// post event names the post to read back, the event being marked processed by that read
/// ([`resolve_hooked`]). A failure writes nothing in its workspace, and TikTok's redelivery then
/// stores it there.
pub async fn receive_tiktok(
    deps: &Deps,
    event: TiktokHookEvent,
    raw: &[u8],
) -> Result<TiktokIntake, AppError> {
    use crate::ports::ops::WebhookOutcome;
    let TiktokHookEvent {
        open_id,
        publish_id,
        effect,
        draft,
    } = event;
    let open_id = open_id.trim();
    let now = deps.clock.now();
    let unrouted = |delivery| {
        deps.ops_signals.webhook(WebhookOutcome::Unrouted);
        Ok(TiktokIntake::dropped(delivery))
    };
    if open_id.is_empty() {
        return unrouted(Delivery::Unrouted);
    }
    let holders = {
        let mut platform = deps.uow.platform().await?;
        let connected: Vec<_> = platform
            .capabilities_holding(Provider::Tiktok.kinds(), open_id)
            .await?
            .into_iter()
            .filter(|c| {
                matches!(c.status, StoredStatus::Verified | StoredStatus::Unreachable)
                    && c.last_verified_at.is_some()
            })
            .collect();
        if connected.is_empty() {
            return unrouted(Delivery::Unrouted);
        }
        let mut open: BTreeMap<WorkspaceId, bool> = BTreeMap::new();
        let mut taking = Vec::new();
        for c in connected {
            let takes = match open.get(&c.workspace_id) {
                Some(takes) => *takes,
                None => {
                    let takes = platform
                        .workspace_get(c.workspace_id)
                        .await?
                        .is_some_and(|w| takes_routed_events(w.status));
                    open.insert(c.workspace_id, takes);
                    takes
                }
            };
            if takes {
                taking.push(c);
            }
        }
        if taking.is_empty() {
            return unrouted(Delivery::Inactive);
        }
        taking
    };
    // An event about a post goes where the post was sent from, when any holder sent it.
    let targets = match publish_id.as_deref() {
        Some(publish_id) => {
            let mut sent = Vec::new();
            for c in &holders {
                let mut r = deps.uow.tenant(c.workspace_id).await?;
                if super::studio::publish::attempt_by_receipt(r.as_mut(), c.id, publish_id)
                    .await?
                    .is_some()
                {
                    sent.push(c.clone());
                }
            }
            if sent.is_empty() { holders } else { sent }
        }
        None => holders,
    };
    let mut out = TiktokIntake {
        stored: Vec::new(),
        dropped: None,
        resolve: Vec::new(),
    };
    for c in targets {
        let (ws, id) = (c.workspace_id, c.id);
        let mut repos = deps.uow.tenant(ws).await?;
        let on_capability = matches!(effect, TiktokHookEffect::AuthorizationRemoved { .. });
        if on_capability {
            super::capabilities::locked(repos.as_mut(), id).await?;
        }
        let at = Stamp {
            ws,
            provider: Provider::Tiktok,
            received_at: now,
        };
        let delivery = store(
            deps,
            repos.as_mut(),
            at,
            Some(id),
            draft.clone(),
            Some(raw.to_vec()),
        )
        .await?;
        match (&effect, delivery) {
            (TiktokHookEffect::AuthorizationRemoved { reason }, Delivery::Stored(event_id)) => {
                let ctx = crate::ctx::Ctx {
                    workspace_id: ws,
                    actor: jt_ledger::Actor::System {
                        component: "webhook:tiktok".into(),
                    },
                    permissions: Default::default(),
                    role_key: None,
                    now,
                    agent_connection_id: None,
                };
                super::connector::authorization_removed(
                    repos.as_mut(),
                    &ctx,
                    id,
                    reason,
                    draft.occurred_at,
                )
                .await?;
                repos.inbound_events().mark_processed(event_id, now).await?;
            }
            (
                TiktokHookEffect::PublishMoved { publish_id },
                Delivery::Stored(_) | Delivery::Duplicate,
            ) => {
                // A redelivery's event is the one stored first: still unprocessed when that
                // delivery's read-back never ran or failed, this read-back marks it.
                let event_id = match delivery {
                    Delivery::Stored(event_id) => Some(event_id),
                    _ => repos
                        .inbound_events()
                        .find_external(Provider::Tiktok, &draft.external_id)
                        .await?
                        .filter(|e| e.processed_at.is_none())
                        .map(|e| e.id),
                };
                out.resolve.push(HookedPublication {
                    workspace_id: ws,
                    capability_id: id,
                    publish_id: publish_id.clone(),
                    event_id,
                });
            }
            _ => {}
        }
        repos.commit().await?;
        deps.ops_signals.webhook(WebhookOutcome::Accepted);
        out.stored.push((ws, delivery));
    }
    Ok(out)
}

/// Reads back the post a TikTok webhook said moved ([`TiktokIntake::resolve`]), as the recovery
/// job would, a late public id included (`super::studio::publish::resolve_observed`), and then
/// marks its event processed: `true` when the post settled or was upgraded now. A read that
/// fails is the error and leaves the event unprocessed, for the agent.
pub async fn resolve_hooked(deps: &Deps, hooked: &HookedPublication) -> Result<bool, AppError> {
    let changed = super::studio::publish::resolve_observed(
        deps,
        hooked.workspace_id,
        hooked.capability_id,
        &hooked.publish_id,
    )
    .await?;
    if let Some(event_id) = hooked.event_id {
        let mut repos = deps.uow.tenant(hooked.workspace_id).await?;
        if repos
            .inbound_events()
            .mark_processed(event_id, deps.clock.now())
            .await?
        {
            repos.commit().await?;
        }
    }
    Ok(changed)
}

/// Reads `hooked` back ([`resolve_hooked`]) in a task of its own, so that TikTok's delivery is
/// answered first. A read that fails is logged (the workspace and the error code, never the post's
/// id) and left to the recovery job, which reads the post again.
pub fn spawn_resolve(deps: std::sync::Arc<Deps>, hooked: HookedPublication) {
    tokio::spawn(async move {
        match resolve_hooked(&deps, &hooked).await {
            Ok(settled) => tracing::debug!(
                provider = "tiktok",
                workspace_id = %hooked.workspace_id,
                settled,
                "a post a webhook named was read back"
            ),
            Err(e) => tracing::warn!(
                provider = "tiktok",
                workspace_id = %hooked.workspace_id,
                code = e.code.as_str(),
                "a post a webhook named could not be read back now; the recovery job reads an unsettled one again"
            ),
        }
    });
}

/// Stores each of `events` of `provider` in the workspace that holds its account connected (see
/// the module docs), each workspace's with the raw body `raw` gives for its own events (asked
/// with exactly their indexes, never another workspace's nor a dropped event's), and answers what
/// became of each, in order: an event whose workspace is suspended is [`Delivery::Inactive`] and
/// written nowhere. Each workspace's events are written in one transaction of their own, so a
/// failure leaves the workspaces written before it stored: the provider's redelivery then finds
/// those as duplicates.
pub async fn receive_for_accounts(
    deps: &Deps,
    provider: Provider,
    events: Vec<AccountEvent>,
    raw: &ScopedRaw<'_>,
) -> Result<Vec<Delivery>, AppError> {
    let mut out = vec![Delivery::Unrouted; events.len()];
    let mut by_workspace: BTreeMap<WorkspaceId, Vec<(usize, CapabilityId, InboundEventDraft)>> =
        BTreeMap::new();
    {
        let mut platform = deps.uow.platform().await?;
        // Each workspace's status, read once per delivery.
        let mut open: BTreeMap<WorkspaceId, bool> = BTreeMap::new();
        for (i, event) in events.into_iter().enumerate() {
            let routed = platform
                .capability_by_external(event.kind_keys, &event.external_account_id)
                .await?;
            let Some(capability) = routed else {
                continue;
            };
            let ws = capability.workspace_id;
            let takes = match open.get(&ws) {
                Some(takes) => *takes,
                None => {
                    let takes = platform
                        .workspace_get(ws)
                        .await?
                        .is_some_and(|w| takes_routed_events(w.status));
                    open.insert(ws, takes);
                    takes
                }
            };
            if takes {
                by_workspace
                    .entry(ws)
                    .or_default()
                    .push((i, capability.id, event.draft));
            } else {
                out[i] = Delivery::Inactive;
            }
        }
    }
    let received_at = deps.clock.now();
    // Workspaces in id order, then each one's events in the order of their ids (`store_all`):
    // two deliveries of the same events take their locks in the same order.
    for (ws, drafts) in by_workspace {
        let mut repos = deps.uow.tenant(ws).await?;
        // This workspace's events only (ascending: pushed in the delivery's order).
        let own: Vec<usize> = drafts.iter().map(|(i, _, _)| *i).collect();
        let scoped = || raw(&own);
        let items = drafts
            .into_iter()
            .map(|(i, capability, draft)| (i, Some(capability), draft))
            .collect();
        let at = Stamp {
            ws,
            provider,
            received_at,
        };
        store_all(deps, repos.as_mut(), at, items, Some(&scoped), &mut out).await?;
        repos.commit().await?;
    }
    for delivery in &out {
        use crate::ports::ops::WebhookOutcome;
        deps.ops_signals.webhook(match delivery {
            Delivery::Unrouted | Delivery::Inactive => WebhookOutcome::Unrouted,
            _ => WebhookOutcome::Accepted,
        });
    }
    Ok(out)
}

/// The token of workspace `ws`'s NetGSM callback URL for `purpose`
/// (`jt_connector::netgsm_hook_token` under the workspace's MAC key for
/// [`NETGSM_HOOK_PURPOSE`]). Not a secret to hide from the owner: it is what makes the URL theirs,
/// shown only to who may manage capabilities (`connector.hooks`).
pub fn netgsm_hook_token(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: NetgsmPurpose,
) -> Result<String, AppError> {
    let key = deps.seal.hmac_key(ws, NETGSM_HOOK_PURPOSE)?;
    Ok(jt_connector::netgsm_hook_token(&key, ws, purpose.key()))
}

/// Whether a NetGSM callback naming workspace `ws`, `token` and `purpose` is taken: the token is
/// the workspace's for that purpose (compared in constant time, before anything is read from the
/// database), and the workspace exists and is `active` or `pending_payment`. `false` tells the
/// caller nothing more:
/// the gate answers every refusal alike.
pub async fn netgsm_hook_open(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: NetgsmPurpose,
    token: &str,
) -> Result<bool, AppError> {
    let expected = netgsm_hook_token(deps, ws, purpose)?;
    if !netgsm_token_ok(&expected, token) {
        return Ok(false);
    }
    let mut platform = deps.uow.platform().await?;
    let workspace = platform.workspace_get(ws).await?;
    Ok(workspace.is_some_and(|w| takes_routed_events(w.status)))
}

/// Stores NetGSM's `drafts` for `purpose` in workspace `ws` (whose hook must have opened, see
/// [`netgsm_hook_open`]), with the raw body `raw`, in one transaction, and answers what became of
/// each, in order. Each event is attached to the workspace's single live (not retired) capability
/// of the purpose's kind ([`netgsm_purpose_kind`]); with none, or several, it is attached to
/// none.
pub async fn receive_netgsm(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: NetgsmPurpose,
    drafts: Vec<InboundEventDraft>,
    raw: &[u8],
) -> Result<Vec<Delivery>, AppError> {
    let received_at = deps.clock.now();
    let mut repos = deps.uow.tenant(ws).await?;
    let live: Vec<CapabilityId> = repos
        .capabilities()
        .list(CapabilityFilter {
            kind: Some(netgsm_purpose_kind(purpose)),
            ..CapabilityFilter::default()
        })
        .await?
        .into_iter()
        .filter(|c| c.status != StoredStatus::Retired)
        .map(|c| c.id)
        .collect();
    let capability = match live[..] {
        [only] => Some(only),
        _ => None,
    };
    let mut out = vec![Delivery::Duplicate; drafts.len()];
    let items = drafts
        .into_iter()
        .enumerate()
        .map(|(i, draft)| (i, capability, draft))
        .collect();
    let at = Stamp {
        ws,
        provider: Provider::Netgsm,
        received_at,
    };
    // The body names this workspace alone: kept as received.
    let whole = || Some(raw.to_vec());
    store_all(deps, repos.as_mut(), at, items, Some(&whole), &mut out).await?;
    repos.commit().await?;
    for _ in &out {
        deps.ops_signals
            .webhook(crate::ports::ops::WebhookOutcome::Accepted);
        if capability.is_none() {
            deps.ops_signals
                .webhook(crate::ports::ops::WebhookOutcome::Unresolved);
        }
    }
    Ok(out)
}

/// Stores the `drafts` a poll of `provider` found (NetGSM's inbox backup), attached to
/// `capability`, in the open bundle `repos` of workspace `ws`, received at `received_at`, and
/// answers what became of each, in order. As a delivery's events are: once per provider id, so a
/// message the webhook already stored (or an earlier poll did) is a [`Delivery::Duplicate`], and
/// written in the order of their provider ids; a poll has no raw body, so none is kept.
pub(crate) async fn store_polled(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    ws: WorkspaceId,
    provider: Provider,
    capability: Option<CapabilityId>,
    drafts: Vec<InboundEventDraft>,
    received_at: OffsetDateTime,
) -> Result<Vec<Delivery>, AppError> {
    let mut out = vec![Delivery::Duplicate; drafts.len()];
    let items = drafts
        .into_iter()
        .enumerate()
        .map(|(i, draft)| (i, capability, draft))
        .collect();
    let at = Stamp {
        ws,
        provider,
        received_at,
    };
    store_all(deps, repos, at, items, None, &mut out).await?;
    Ok(out)
}

/// The capability kind a NetGSM callback purpose belongs to: incoming SMS and İYS consent to the
/// SMS line (`sms_line`), call events and voice and auto-call reports to the PBX (`netgsm_pbx`).
pub fn netgsm_purpose_kind(purpose: NetgsmPurpose) -> &'static str {
    match purpose {
        NetgsmPurpose::Mo | NetgsmPurpose::Iys => "sms_line",
        NetgsmPurpose::Events | NetgsmPurpose::VoiceReport | NetgsmPurpose::AutocallReport => {
            "netgsm_pbx"
        }
    }
}

/// The cutoff of [`purge_raw`] at `now`: bodies received more than [`RAW_RETENTION`] before it go.
pub fn raw_cutoff(now: OffsetDateTime) -> OffsetDateTime {
    now - RAW_RETENTION
}

/// What [`purge_raw`] did: how many bodies it removed, and in how many workspaces it could not
/// (each logged; the others are purged all the same).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RawPurge {
    pub removed: u64,
    pub failed: u32,
}

/// Removes the raw body of every event received before `cutoff`, in every workspace (one
/// transaction per workspace, [`purge_raw_in`]); the events themselves stay. As the scheduler's
/// daily purge (`super::jobs::run_purge_raw_bodies`) does: a workspace that cannot be purged is
/// logged and counted, and the others are purged all the same. Only a failure to list the
/// workspaces is an error (nothing could be purged then).
pub async fn purge_raw(deps: &Deps, cutoff: OffsetDateTime) -> Result<RawPurge, AppError> {
    let workspaces = {
        let mut platform = deps.uow.platform().await?;
        platform.workspaces_list().await?
    };
    let mut out = RawPurge::default();
    for workspace in workspaces {
        match purge_raw_in(deps, workspace.id, cutoff).await {
            Ok(removed) => out.removed += removed,
            Err(e) => {
                out.failed += 1;
                tracing::warn!(
                    workspace_id = %workspace.id,
                    code = e.code.as_str(),
                    "the raw bodies of a workspace could not be purged; the others are"
                );
            }
        }
    }
    Ok(out)
}

/// Removes the raw body of every event of workspace `ws` received before `cutoff`, in one
/// transaction, and answers how many bodies it removed.
pub async fn purge_raw_in(
    deps: &Deps,
    ws: WorkspaceId,
    cutoff: OffsetDateTime,
) -> Result<u64, AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    let removed = repos.inbound_events().purge_raw_before(cutoff).await?;
    if removed > 0 {
        repos.commit().await?;
    }
    Ok(removed)
}

/// Where and when one delivery's events are stored: the workspace, the provider and the time they
/// were received.
#[derive(Clone, Copy)]
struct Stamp {
    ws: WorkspaceId,
    provider: Provider,
    received_at: OffsetDateTime,
}

/// Stores one delivery's `items` (each the index of its answer in `out`, its capability and the
/// event) in the open bundle `repos` of the stamp's workspace, writing each answer into `out`.
///
/// The events are written in the order of their provider ids (stable, so a repeated id keeps
/// its place), whatever their order in the body: two transactions storing overlapping events
/// then take the unique-key locks in the same order and never wait on each other in a circle.
/// The raw body, when there is one (a poll has none), is made by `raw` when first needed (once)
/// and kept once: beside the first event this call newly stores; every later event of the
/// delivery in this workspace keeps none (they share its `received_at`).
async fn store_all(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    at: Stamp,
    mut items: Vec<(usize, Option<CapabilityId>, InboundEventDraft)>,
    raw: Option<&(dyn Fn() -> Option<Vec<u8>> + Sync)>,
    out: &mut [Delivery],
) -> Result<(), AppError> {
    // Serialize with erasure before inspecting tombstones or retaining any raw batch.
    repos.people().lock_workspace().await?;
    let mut scrubbed = false;
    for (_, capability, draft) in &mut items {
        scrubbed |=
            super::inbox::erasure::scrub_inbound(repos, *capability, &mut draft.payload).await?;
    }
    let raw = if scrubbed { None } else { raw };
    items.sort_by(|a, b| a.2.external_id.cmp(&b.2.external_id));
    let mut made: Option<Option<Vec<u8>>> = None;
    let mut raw_kept = false;
    for (i, capability, draft) in items {
        let body = match raw {
            Some(raw) if !raw_kept => made.get_or_insert_with(raw).clone(),
            _ => None,
        };
        let delivery = store(deps, repos, at, capability, draft, body).await?;
        raw_kept |= matches!(delivery, Delivery::Stored(_));
        out[i] = delivery;
    }
    Ok(())
}

/// Stores one event, with the raw body `raw` when given, in the open bundle `repos`.
async fn store(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    at: Stamp,
    capability_id: Option<CapabilityId>,
    draft: InboundEventDraft,
    raw: Option<Vec<u8>>,
) -> Result<Delivery, AppError> {
    let InboundEventDraft {
        external_id,
        kind,
        mut payload,
        occurred_at,
    } = draft;
    if let (Some(at), Value::Object(fields)) = (occurred_at, &mut payload)
        && !fields.contains_key("occurred_at")
        && let Ok(text) = at.format(&Rfc3339)
    {
        fields.insert("occurred_at".to_owned(), Value::String(text));
    }
    let event = InboundEvent {
        id: InboundEventId(deps.ids.uuid()),
        workspace_id: at.ws,
        provider: at.provider,
        capability_id,
        external_id,
        kind,
        payload,
        received_at: at.received_at,
        processed_at: None,
    };
    Ok(
        match repos.inbound_events().insert_if_new(event, raw).await? {
            Some(id) => Delivery::Stored(id),
            None => Delivery::Duplicate,
        },
    )
}
