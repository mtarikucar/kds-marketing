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
//! counts it). NetGSM signs nothing: each workspace's callback URL carries a token of its own
//! (HMAC under the workspace's MAC key for [`NETGSM_HOOK_PURPOSE`]), so a NetGSM event is stored
//! in the workspace its URL names, and only once the token matched.
//!
//! **Deduplication (Review Focus 2).** An event is stored once per `(workspace, provider,
//! external_id)`: a replayed delivery, or the same item twice in one body, is
//! [`Delivery::Duplicate`] and changes nothing. Two deliveries racing on one event store it once
//! (the repository's unique key; the second waits for the first).
//!
//! **What is stored.** Each event with its parsed payload, the time it was received (the clock),
//! the capability it arrived through when known, and a copy of the raw body as received, kept for
//! [`RAW_RETENTION`] and then removed by [`purge_raw`]. When the provider said when the event
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
/// the module docs), with the raw body `raw`, and answers what became of each, in order. Each
/// workspace's events are written in one transaction of their own, so a failure leaves the
/// workspaces written before it stored: the provider's redelivery then finds those as duplicates.
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
        for (i, event) in events.into_iter().enumerate() {
            let routed = platform
                .capability_by_external(event.kind_keys, &event.external_account_id)
                .await?;
            if let Some(capability) = routed {
                by_workspace
                    .entry(capability.workspace_id)
                    .or_default()
                    .push((i, capability.id, event.draft));
            }
        }
    }
    let received_at = deps.clock.now();
    for (ws, drafts) in by_workspace {
        let mut repos = deps.uow.tenant(ws).await?;
        for (i, capability, draft) in drafts {
            out[i] = store(
                deps,
                repos.as_mut(),
                ws,
                provider,
                Some(capability),
                draft,
                raw,
                received_at,
            )
            .await?;
        }
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
/// database), and the workspace exists and is `active`. `false` tells the caller nothing more:
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
    Ok(workspace.is_some_and(|w| w.status == WorkspaceStatus::Active))
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
    let mut out = Vec::with_capacity(drafts.len());
    for draft in drafts {
        out.push(
            store(
                deps,
                repos.as_mut(),
                ws,
                Provider::Netgsm,
                capability,
                draft,
                raw,
                received_at,
            )
            .await?,
        );
    }
    repos.commit().await?;
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
/// transaction per workspace), and answers how many bodies it removed. The events themselves
/// stay. Not a catalog use case: the scheduler runs it daily with [`raw_cutoff`].
pub async fn purge_raw(deps: &Deps, cutoff: OffsetDateTime) -> Result<u64, AppError> {
    let workspaces = {
        let mut platform = deps.uow.platform().await?;
        platform.workspaces_list().await?
    };
    let mut removed = 0;
    for workspace in workspaces {
        let mut repos = deps.uow.tenant(workspace.id).await?;
        let n = repos.inbound_events().purge_raw_before(cutoff).await?;
        if n > 0 {
            repos.commit().await?;
            removed += n;
        }
    }
    Ok(removed)
}

/// Stores one event in the open bundle `repos` of workspace `ws`.
#[allow(clippy::too_many_arguments)]
async fn store(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    ws: WorkspaceId,
    provider: Provider,
    capability_id: Option<CapabilityId>,
    draft: InboundEventDraft,
    raw: &[u8],
    received_at: OffsetDateTime,
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
        workspace_id: ws,
        provider,
        capability_id,
        external_id,
        kind,
        payload,
        received_at,
        processed_at: None,
    };
    Ok(
        match repos
            .inbound_events()
            .insert_if_new(event, Some(raw.to_vec()))
            .await?
        {
            Some(id) => Delivery::Stored(id),
            None => Delivery::Duplicate,
        },
    )
}
