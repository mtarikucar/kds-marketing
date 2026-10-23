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
                    error = %e,
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
