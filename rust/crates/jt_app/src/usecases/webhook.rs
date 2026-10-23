//! Webhook intake (spec §4.4, §11): storing what providers send, once, in the workspace it
//! belongs to; NetGSM's per-workspace hook tokens; and the raw-body purge.
//!
//! The webhook gate (`jt_webhook`) authenticates a delivery and parses it with the provider's
//! adapter before anything here runs: Meta's body signature, NetGSM's path token
//! ([`netgsm_hook_open`]). These use cases are not in the catalog: no person or agent calls them,
//! a provider does, through the gate.
//!
//! **Routing (Review Focus 1).** Meta's events name the provider account they arrived for (a
//! page, an Instagram account, a WhatsApp number). [`receive_for_accounts`] finds, across every
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
//! and the capability it arrived through when known; and the raw body as received, **once per
//! delivery and workspace**: beside the first event the delivery newly stores there (a body of a
//! thousand events is not kept a thousand times; its siblings share its `received_at`). The body
//! is kept for [`RAW_RETENTION`] and then removed by [`purge_raw`]. When the provider said when the event
//! happened, the payload (an object) also carries `occurred_at` (RFC 3339), unless the provider's
//! item already names that key. Inbound events are records of the outside world: no ledger
//! entry.

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

/// One event of a provider that names its account: which capability kinds may hold the account
/// (`kind_keys`), the provider's id of the account, and the event.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountEvent {
    pub kind_keys: &'static [&'static str],
    pub external_account_id: String,
    pub draft: InboundEventDraft,
}

/// Stores each of `events` of `provider` in the workspace that holds its account connected (see
/// the module docs), with the raw body `raw`, and answers what became of each, in order: an event
/// whose workspace is suspended is [`Delivery::Inactive`] and written nowhere. Each workspace's
/// events are written in one transaction of their own, so a failure leaves the workspaces written
/// before it stored: the provider's redelivery then finds those as duplicates.
pub async fn receive_for_accounts(
    deps: &Deps,
    provider: Provider,
    events: Vec<AccountEvent>,
    raw: &[u8],
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
        let items = drafts
            .into_iter()
            .map(|(i, capability, draft)| (i, Some(capability), draft))
            .collect();
        let at = Stamp {
            ws,
            provider,
            received_at,
        };
        store_all(deps, repos.as_mut(), at, items, Some(raw), &mut out).await?;
        repos.commit().await?;
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
    store_all(deps, repos.as_mut(), at, items, Some(raw), &mut out).await?;
    repos.commit().await?;
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

/// Removes the raw body of every event received before `cutoff`, in every workspace (one
/// transaction per workspace, [`purge_raw_in`]), and answers how many bodies it removed. The
/// events themselves stay. Stops at the first workspace that fails; the scheduler's daily purge
/// (`super::jobs::run_purge_raw_bodies`) calls [`purge_raw_in`] for each workspace itself, so one
/// failing workspace does not hold the others back.
pub async fn purge_raw(deps: &Deps, cutoff: OffsetDateTime) -> Result<u64, AppError> {
    let workspaces = {
        let mut platform = deps.uow.platform().await?;
        platform.workspaces_list().await?
    };
    let mut removed = 0;
    for workspace in workspaces {
        removed += purge_raw_in(deps, workspace.id, cutoff).await?;
    }
    Ok(removed)
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
/// The raw body, when there is one (a poll has none), is kept once: beside the first event this
/// call newly stores; every later event of the delivery in this workspace keeps none (they share
/// its `received_at`).
async fn store_all(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    at: Stamp,
    mut items: Vec<(usize, Option<CapabilityId>, InboundEventDraft)>,
    raw: Option<&[u8]>,
    out: &mut [Delivery],
) -> Result<(), AppError> {
    items.sort_by(|a, b| a.2.external_id.cmp(&b.2.external_id));
    let mut raw_kept = false;
    for (i, capability, draft) in items {
        let body = raw.filter(|_| !raw_kept).map(<[u8]>::to_vec);
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
