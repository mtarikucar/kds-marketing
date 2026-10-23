//! Connecting the workspace's accounts through their providers (spec §4.2 rule 1, §6.1, §6.4):
//! `connector.start_oauth`, `connector.complete_oauth`, `connector.confirm_assets`,
//! `connector.set_credentials`, `connector.probe`, `connector.health`, `connector.reconnect`,
//! and `connector.hooks`, the webhook addresses the owner registers at the providers
//! ([`hooks`]).
//!
//! **Two ways in.** Meta and X accounts connect through the platform's provider apps by OAuth: a
//! flow starts ([`start_oauth`], or [`reconnect`] for a capability whose login expired), the
//! provider sends the owner's browser back with a code ([`complete_oauth`], the panel's callback
//! route), and the owner chooses which of the assets the account reaches become capabilities
//! ([`confirm_assets`]); a capability declared before it was connected is connected through a
//! flow bound to it ([`reconnect`]), so the first chosen asset becomes it. NetGSM lines, and a pasted Meta token, are entered by hand
//! ([`set_credentials`]); X has no manual way in.
//!
//! **The OAuth state** is signed with the workspace's MAC key for [`OAUTH_STATE_PURPOSE`] and
//! carries nothing secret; it is accepted for [`STATE_TTL`] after it was issued, only from a
//! session whose current workspace is the one that started it, and only once: the flow is found
//! by the state's hash, and a flow that already holds its assets (or was confirmed and deleted)
//! refuses it. Every refusal of a state is `FORBIDDEN` (Review Focus 4). The PKCE verifier of an
//! X flow is sealed with the flow and never travels in the state or the URL.
//!
//! **Credentials are sealed** (`SecretBox`) into the capability's sealed configuration, and the
//! assets of a flow, credentials included, into the flow until it is confirmed. No answer, ledger
//! entry, log line or `Debug` output holds a token, a password, a code or sealed bytes;
//! `connector_public` holds only the non-secret facts, under these keys:
//!
//! - `provider`: the provider's key; `name`: the provider's name of the account, when it has one;
//! - `hosts`: the hosts its adapter reaches ([`crate::ports::connectors::Connector::hosts`]),
//!   which the workspace's tenant tier is given once the change is committed;
//! - `access`: `Credential::redact_for_public` of the sealed credential (its kind, and for an
//!   OAuth token its `expires_at` and `scopes`), written when it is sealed, so the token's expiry
//!   is read without opening anything ([`health`]);
//! - `asset`: the provider's public facts of an asset connected through OAuth;
//! - `health`: the last probe, `{ok, at, latency_ms, error_kind}`, and `on_connected_error` while
//!   the adapter's connection step last failed (see below); `facts`: what the last successful
//!   probe reported;
//! - `reconnect_required`: `true` once a probe found the login no longer accepted (`Auth`),
//!   `false` again whenever a fresh credential is sealed, after a successful probe, and on
//!   retirement.
//!
//! (Every key is chosen so `connector_public` accepts it: it refuses every key that looks like a
//! secret's name, any containing `auth` or `credential` among them.) What a provider reports (an
//! asset's public facts, a probe's facts) is screened the same way before it is shown or stored:
//! a key that looks like a secret's name is dropped, at any depth.
//!
//! **The connection step.** Once a credential is sealed for a capability (assets confirmed,
//! credentials entered by hand), the adapter's [`Connector::on_connected`] runs with it, before
//! the probe: the provider-side steps of a new connection, such as subscribing a Facebook Page to
//! the platform app's webhooks. What it reports is merged into `connector_public` (screened, and
//! never over a connector-owned key nor over `hosts`, `name` or `external_id`); a failure is never
//! fatal: the connection stands, and the redacted failure is kept in
//! `connector_public.health.on_connected_error` until the step next runs and succeeds. A plain
//! probe never runs it.
//!
//! **Probes** are the system's own trial call, the only way a connector capability is verified
//! (spec §6.4). A probe binds the account: a successful probe counts only when it names, as a
//! string in `facts.account_id`, the identity the credential itself authenticates as (see
//! [`crate::ports::connectors::Connector::probe`]), and that is the capability's external id, or,
//! for a capability without one, an account no other live capability of its kind holds (which the
//! capability then takes). Anything else, no account named included, counts as `Permission`
//! "account mismatch", so a credential can never verify an account it has not shown to be its
//! own. Binding a capability to another account (`rebind_account`) first drops its
//! verification. The run is logged ([`crate::ports::ProbeRunRepo`]), the status follows
//! [`jt_connector::status_after_probe`], and `connector.probe` is written only when the status
//! changed.
//!
//! **Gates.** Every use case here is exempt from the strategy gate (connecting accounts is part
//! of the consultation's prerequisites) and subject to the workspace-status check. Changes need
//! `capabilities.manage`; probing and reading health need `workspace.read` (an agent checks its
//! hands with them).
//!
//! **Locks and the network.** A change of an existing capability locks it first
//! (`CapabilityRepo::lock`), and a change of a flow locks the flow (`OAuthPendingRepo::lock`).
//! A probe, and entering credentials for an existing capability, call the provider while holding
//! the capability's lock, so a concurrent change of the capability waits for the probe's verdict
//! instead of having it written over a newer credential. Completing a flow calls the provider
//! with no transaction open and locks the flow only to store what it found.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::Arc;

use jt_capability::{
    Capability, CapabilityId, CapabilityKind, EffectiveStatus, Evidence, MAX_EXTERNAL_ID_CHARS,
    MAX_NAME_CHARS, NewCapability, Policy, RESERVED_PUBLIC_KEYS, Reach, StoredStatus,
    effective_status, is_secret_looking_key,
};
use jt_connector::{
    ConnectorError, Credential, NetgsmPurpose, OAuthState, ProbeResult, Provider, STATE_TTL,
    pkce_challenge_s256, provider_for_kind, redact_reason, status_after_probe,
};
use jt_tenancy::Permission;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use zeroize::Zeroizing;

use super::auth::{self, Principal};
use super::capabilities::{
    CapabilityOut, append, capability_error, checked_external_id, checked_external_id_of, find,
    locked, not_retired, version_in_force,
};
use super::webhook::{META_HOOK_PATH, NETGSM_HOOK_PATH, netgsm_hook_token};
use super::{Deps, acting_user, hash_token, invalid};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::connectors::{Asset, AssetPublic, Connector, OAuthApp, PlatformAppConfig, Url};
use crate::ports::{
    CapabilityFilter, Masked, OAuthPendingId, OAuthPendingRow, ProbeRun, ProbeRunId, TenantRepos,
};

/// The purpose of the workspace MAC key that signs OAuth states
/// ([`crate::ports::SecretBox::hmac_key`]).
pub const OAUTH_STATE_PURPOSE: &str = "oauth-state";

/// Where a provider sends the owner's browser back to, under the public base URL, followed by
/// `/{provider}`: the redirect URI of every flow. It is the panel's page, not the API: the page
/// reads `state` and `code` from its address and calls the callback route
/// (`GET /api/connectors/oauth/callback/{provider}`) itself, a same-site request that carries the
/// session cookie (`SameSite=Strict`), which the provider's cross-site redirect would not.
pub const OAUTH_CALLBACK_PATH: &str = "/oauth/callback";

/// How long a started flow can be confirmed. Its state is accepted for [`STATE_TTL`] only (the
/// time to sign in at the provider); the owner then has the rest of this time to choose assets.
pub const PENDING_TTL: Duration = Duration::minutes(30);

/// The longest secret (a password, a pasted token) entered by hand, in characters.
pub const MAX_SECRET_CHARS: usize = 4_096;

/// The longest other credential field (a user code, a sender name, a trunk), in characters.
pub const MAX_CREDENTIAL_FIELD_CHARS: usize = 256;

/// The random bytes of a PKCE code verifier (64 characters in base64url).
const PKCE_VERIFIER_BYTES: usize = 48;

/// The random bytes behind an OAuth state's nonce.
const NONCE_BYTES: usize = 16;

/// The `connector_public` key of the reconnection flag.
const RECONNECT_REQUIRED: &str = "reconnect_required";

/// The key, inside `connector_public.health`, of the connection step's last failure.
const ON_CONNECTED_ERROR: &str = "on_connected_error";

/// The `connector_public` keys of the connection itself, which the facts of the connection step
/// never write (beside [`RESERVED_PUBLIC_KEYS`]; a key such as `kind_key` is screened out as
/// secret-looking anyway).
const CONNECTION_KEYS: &[&str] = &["hosts", "name", "external_id"];

/// The `connector_public` keys that describe the account a capability is bound to, dropped when
/// it is bound to another ([`rebind_account`]): the last probe, the probe's facts, the OAuth
/// asset's facts and the account.
const OLD_ACCOUNT_FACTS: &[&str] = &["health", "facts", "asset", "account"];

const NO_SUCH_FLOW: &str = "no such pending connection";
const APP_NOT_CONFIGURED: &str = "provider app not configured";
const NO_ADAPTER: &str = "provider adapter not available";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// What starting an OAuth flow takes: the kind of capability to connect (a Meta kind or `x`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartOAuth {
    pub kind_key: String,
}

/// A started OAuth flow: where to send the owner's browser (an agent hands it to the owner), the
/// flow's id, and until when the provider may call back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StartOut {
    pub authorize_url: String,
    pub pending_id: OAuthPendingId,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

/// The provider's callback: the provider it was addressed to (the redirect URI's last segment),
/// the `state` and `code` it sent back, and the signed-in user whose browser brought them.
/// `Debug` masks the state and the code.
pub struct CompleteOAuth<'a> {
    pub provider: Provider,
    pub state: String,
    pub code: String,
    pub principal: &'a Principal,
}

impl fmt::Debug for CompleteOAuth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CompleteOAuth")
            .field("provider", &self.provider)
            .field("state", &Masked)
            .field("code", &Masked)
            .field("user_id", &self.principal.user_id)
            .finish()
    }
}

/// The assets a completed flow found, as the owner chooses from them: never a credential.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingAssetsOut {
    pub pending_id: OAuthPendingId,
    pub assets: Vec<AssetPublic>,
}

/// The owner's choice of assets: their external ids, as [`PendingAssetsOut`] lists them. Each id
/// chooses every asset the flow found with it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmAssets {
    pub pending_id: OAuthPendingId,
    pub selected: Vec<String>,
}

/// Credentials entered by hand, one shape per credential (`kind`): the NetGSM SMS API sub-user
/// of an `sms_line`, the Netsantral user of a `netgsm_pbx`, or a Meta access token pasted for a
/// Meta kind (a Page token for `facebook_page`, a WhatsApp Cloud token for `whatsapp_cloud`, a
/// user token otherwise). Mirrors [`Credential`]'s shapes; X has none (it connects through OAuth
/// only), and neither has İYS, which no capability kind takes yet.
///
/// Read strictly: an unknown shape or field is refused, and so is a field that is not a string,
/// without the refusal repeating any value. `Debug` masks the secrets.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialInput {
    NetgsmSms {
        usercode: String,
        password: String,
        msgheader: String,
    },
    NetgsmPbx {
        username: String,
        password: String,
        #[serde(default)]
        trunk: Option<String>,
        #[serde(default)]
        pbxnum: Option<String>,
    },
    MetaToken {
        access_token: String,
    },
}

impl CredentialInput {
    /// The shape's key, e.g. `"netgsm_sms"`.
    pub fn kind(&self) -> &'static str {
        match self {
            CredentialInput::NetgsmSms { .. } => "netgsm_sms",
            CredentialInput::NetgsmPbx { .. } => "netgsm_pbx",
            CredentialInput::MetaToken { .. } => "meta_token",
        }
    }
}

impl fmt::Debug for CredentialInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CredentialInput::NetgsmSms {
                usercode,
                msgheader,
                ..
            } => f
                .debug_struct("NetgsmSms")
                .field("usercode", usercode)
                .field("password", &Masked)
                .field("msgheader", msgheader)
                .finish(),
            CredentialInput::NetgsmPbx {
                username,
                trunk,
                pbxnum,
                ..
            } => f
                .debug_struct("NetgsmPbx")
                .field("username", username)
                .field("password", &Masked)
                .field("trunk", trunk)
                .field("pbxnum", pbxnum)
                .finish(),
            CredentialInput::MetaToken { .. } => f
                .debug_struct("MetaToken")
                .field("access_token", &Masked)
                .finish(),
        }
    }
}

/// What entering credentials by hand takes: the capability, either an existing one
/// (`capability_id`) or a new one (`kind_key` and `name`), the account it is expected to reach
/// (`external_id`, optional) and the credentials. From JSON, an unknown field is refused.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetCredentials {
    #[serde(default)]
    pub capability_id: Option<CapabilityId>,
    #[serde(default)]
    pub kind_key: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// The provider's id of the account. Absent, the probe's account becomes it; given, the
    /// probe must reach exactly it.
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(deserialize_with = "credential_strict")]
    pub credential: CredentialInput,
}

/// A probe's outcome as it may be shown: never the credential, the reason redacted.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProbeResultPublic {
    pub ok: bool,
    pub latency_ms: u32,
    /// The `ConnectorError` kind of a failure, e.g. `"auth"`.
    pub error_kind: Option<String>,
    /// Why it failed, redacted when the error was built.
    pub error_reason: Option<String>,
    /// What a successful probe reported; `{}` for a failure.
    pub facts: Value,
}

/// A probe's outcome and the capability's stored status after it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProbeOut {
    pub result: ProbeResultPublic,
    pub status: StoredStatus,
}

/// One connector capability's health: its status now, its last probe, and when its token
/// expires, when the provider said.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConnectorHealth {
    pub capability_id: CapabilityId,
    pub kind_key: String,
    pub name: String,
    /// The provider that serves its kind; `None` for a connector kind no provider serves yet.
    pub provider: Option<Provider>,
    pub status: EffectiveStatus,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_probe_at: Option<OffsetDateTime>,
    pub ok: Option<bool>,
    pub error_kind: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub token_expires_at: Option<OffsetDateTime>,
    pub reconnect_required: bool,
}

/// Where the provider's webhooks for the workspace are to be delivered, to register at each
/// provider ([`hooks`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HooksOut {
    /// The platform's Meta webhook (one for every workspace: Meta signs each delivery and the
    /// system routes it by account), when the platform's Meta app is configured.
    pub meta: Option<MetaHook>,
    /// The workspace's NetGSM callback URL for each purpose, in [`NetgsmPurpose::all`]'s order.
    pub netgsm: Vec<NetgsmHook>,
}

/// The Meta webhook's address and where its verify token is set. The token itself is never
/// shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MetaHook {
    pub url: String,
    /// [`VERIFY_TOKEN_HINT`].
    pub verify_token_hint: String,
}

/// One of the workspace's NetGSM callback URLs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetgsmHook {
    /// The purpose's key: `mo`, `events`, `iys`, `voice-report` or `autocall-report`.
    pub purpose: String,
    pub url: String,
}

/// Where the Meta webhook's verify token is set, shown instead of the token.
pub const VERIFY_TOKEN_HINT: &str = "set in the Meta app dashboard";

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// Starts an OAuth flow to connect capabilities of kind `input.kind_key` and returns where to
/// send the owner's browser. Needs `capabilities.manage`.
///
/// The kind must be one OAuth connects (a Meta kind or `x`), else `VALIDATION` naming `kind_key`
/// (a NetGSM kind with `details.reason = "use_set_credentials"`). The provider's app must be
/// configured (`instagram` signs in with the Instagram app, the other Meta kinds with the Meta
/// app, `x` with the X app), else `CONFLICT` "provider app not configured" (`details.reason =
/// "provider_app_not_configured"`, `details.provider`); and its adapter
/// present, else `CONFLICT`. The state is signed for the workspace and holds the provider, the
/// kind, the time and a nonce; for X a PKCE pair is made and its verifier sealed with the flow.
/// The redirect URI is the public base URL followed by [`OAUTH_CALLBACK_PATH`] and the
/// provider's key. `expires_at` is when the state stops being accepted ([`STATE_TTL`]).
///
/// Writes `connector.oauth_started` about the flow (`subject.kind = "oauth_pending"`, payload
/// `provider`, `kind_key`).
pub async fn start_oauth(deps: &Deps, ctx: &Ctx, input: StartOAuth) -> Result<StartOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    begin_oauth(deps, ctx, input.kind_key.trim(), None).await
}

/// Completes the flow the provider called back for, and returns the assets it found for the
/// owner to choose from. The panel's callback route only: the signed-in user's current workspace
/// must be the one that started the flow, and they need `capabilities.manage` there.
///
/// Refused with `FORBIDDEN` (Review Focus 4), and the provider is not asked: no current
/// workspace; a state not signed for it, signed for another provider than `input.provider`,
/// malformed, or issued more than [`STATE_TTL`] ago; a flow that is unknown, expired, or already
/// completed (a state is used once); a reconnection whose capability was retired meanwhile. Then the code is exchanged for a credential and the
/// account's assets are listed; a provider refusal (`Auth`, `Permission`, `Permanent`) is
/// `VALIDATION` with `details = {provider, provider_error, reason}`, and a busy or unreachable
/// provider (`Throttle`, `Transient`) `UPSTREAM_UNAVAILABLE` with
/// `details = {provider, retryable: true, retry_after_s?, reason}`, the reason redacted. Assets of
/// kinds the provider does not serve are dropped, each account is kept once per kind, and keys
/// that look like a secret's name are dropped from their public facts. A flow bound to a
/// capability ([`reconnect`]) keeps only that capability's account when it names one; a declared
/// capability that names none is offered every asset. Either way an account that reaches no
/// asset of the capability's kind (or not its account) is `VALIDATION` with
/// `details.reason = "account_mismatch"`. Of two completions racing on one state, the one that
/// stores its assets second is `FORBIDDEN`, even after asking the provider (the flow is locked
/// and checked again before anything is stored).
///
/// The assets, credentials included, are sealed with the flow and their public facts stored
/// beside them. Writes `connector.oauth_completed` (payload `provider`, `assets`: how many).
pub async fn complete_oauth(
    deps: &Deps,
    input: CompleteOAuth<'_>,
) -> Result<PendingAssetsOut, AppError> {
    let CompleteOAuth {
        provider,
        state,
        code,
        principal,
    } = input;
    let ws = principal
        .current_workspace
        .ok_or_else(|| AppError::forbidden("no current workspace"))?;
    let now = deps.clock.now();
    let ctx = auth::ctx_for(principal, ws, now)?;
    ctx.require(Permission::CapabilitiesManage)?;
    let key = deps.seal.hmac_key(ws, OAUTH_STATE_PURPOSE)?;
    let signed = OAuthState::verify(&state, &key, now).map_err(|_| refused_state())?;
    if signed.workspace_id != ws || signed.provider != provider {
        return Err(refused_state());
    }

    // Read the flow in a bundle of its own: the provider is asked with no transaction open.
    let (flow, verifier, bound) = {
        let mut repos = deps.uow.tenant(ws).await?;
        let flow = repos
            .oauth_pending()
            .find_by_state_hash(&hash_token(&state))
            .await?
            .ok_or_else(refused_state)?;
        let usable = flow.expires_at >= now
            && flow.assets_sealed.is_none()
            && flow.provider == signed.provider
            && flow.kind_key == signed.kind_key;
        if !usable {
            return Err(refused_state());
        }
        let verifier = match &flow.pkce_verifier_sealed {
            Some(sealed) => {
                let plain = deps.seal.open(ws, sealed)?;
                let text = std::str::from_utf8(&plain)
                    .map_err(|_| AppError::internal("the sealed PKCE verifier is not text"))?;
                Some(Zeroizing::new(text.to_owned()))
            }
            None => None,
        };
        let bound = match flow.capability_id {
            Some(id) => {
                let capability = find(repos.as_mut(), id).await?;
                if capability.status == StoredStatus::Retired {
                    return Err(refused_state());
                }
                Some(capability)
            }
            None => None,
        };
        (flow, verifier, bound)
    };

    let app = oauth_app(deps.apps.as_ref(), flow.provider, &flow.kind_key)
        .ok_or_else(|| app_not_configured(flow.provider))?;
    let oauth = deps
        .connectors
        .oauth(flow.provider)
        .ok_or_else(|| AppError::conflict(NO_ADAPTER))?;
    let redirect = callback_url(deps.apps.as_ref(), flow.provider);
    let credential = oauth
        .exchange(
            &app,
            &redirect,
            &code,
            verifier.as_ref().map(|v| v.as_str()),
        )
        .await
        .map_err(|e| provider_error(flow.provider, e))?;
    let mut assets = oauth
        .list_assets(&credential)
        .await
        .map_err(|e| provider_error(flow.provider, e))?;
    drop(credential);
    // Only kinds the provider serves, each account once per kind, no secret-looking facts.
    let mut seen = BTreeSet::new();
    assets.retain(|a| {
        provider_for_kind(&a.kind_key) == Some(flow.provider)
            && seen.insert((a.kind_key.clone(), a.external_id.clone()))
    });
    for asset in &mut assets {
        asset.public = screened(&asset.public);
    }
    if let Some(capability) = &bound {
        // A reconnection keeps its capability's account only; a declared capability's first
        // connection is offered every asset (the first chosen of its kind becomes it), but needs
        // one of its kind.
        if let Some(held) = &capability.external_id {
            assets.retain(|a| a.kind_key == capability.kind_key && a.external_id == *held);
        }
        if !assets.iter().any(|a| a.kind_key == capability.kind_key) {
            return Err(AppError::validation(
                "the account signed in with does not reach this capability's account",
                json!({ "reason": "account_mismatch" }),
            ));
        }
    }
    let public: Vec<AssetPublic> = assets.iter().map(Asset::public_facts).collect();
    let sealed = seal_assets(deps, &ctx, assets)?;
    let public_json = serde_json::to_value(&public)
        .map_err(|_| AppError::internal("the assets' public facts cannot be written"))?;

    let mut repos = deps.uow.tenant(ws).await?;
    let current = repos
        .oauth_pending()
        .lock(flow.id)
        .await?
        .ok_or_else(refused_state)?;
    if current.assets_sealed.is_some() {
        return Err(refused_state());
    }
    repos
        .oauth_pending()
        .set_assets(flow.id, sealed, public_json)
        .await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    append(
        repos.as_mut(),
        &ctx,
        "connector.oauth_completed",
        "oauth_pending",
        flow.id,
        in_force,
        json!({ "provider": flow.provider.key(), "assets": public.len() }),
    )
    .await?;
    repos.commit().await?;
    Ok(PendingAssetsOut {
        pending_id: flow.id,
        assets: public,
    })
}

/// Turns the chosen assets of a completed flow into capabilities, probes each, and returns them
/// as they stand after their probes. Needs `capabilities.manage`.
///
/// `selected` (trimmed, each once) must name at least one asset, else `VALIDATION` naming
/// `selected`; ids the flow did not find are `VALIDATION` naming `selected`, listed in
/// `details.unknown`. An unknown flow is `NOT_FOUND`; one past [`PENDING_TTL`], or one the
/// provider has not called back for yet, `CONFLICT`; a provider without an adapter `CONFLICT`.
///
/// A new connection creates one capability per chosen asset: declared, reached through its
/// connector, holding the asset's account (`external_id`), named after it (cut to the longest
/// name allowed), its credential sealed and its public facts in `connector_public`, under the
/// strategy version in force. An account another live capability of the kind holds is
/// `CONFLICT` (`details` naming `kind_key` and `external_id`), and nothing is created.
///
/// A flow bound to a capability ([`reconnect`]) gives that capability (not retired, else
/// `CONFLICT`) the asset of its kind chosen first (`selected[0]`, in the order chosen; else
/// `VALIDATION` naming `selected`): when the capability already holds that account, the new
/// credential is sealed into it (a reconnection); when it holds none (a declared capability's
/// first connection) or another one, it is bound to the asset's account the way every change of
/// a connector's account is (back to `declared`, the old account's facts dropped; an account held
/// elsewhere is `CONFLICT`), the credential sealed and the
/// asset's facts written. Every other chosen asset becomes a new capability, as above (the bound
/// capability's own account is no duplicate). Nothing is written when any of it is refused. The
/// flow is deleted in the same transaction.
///
/// Writes `connector.connected` per capability (payload `kind_key`, `external_id`, and
/// `reconnected: true` for a reconnection, `bound: true` for a bound capability given its account).
/// Once committed, the adapter's hosts are allowed for
/// the workspace (a host that cannot be is logged), and each capability runs the adapter's
/// connection step (see the module docs) and is probed as [`probe`] does, under its lock; a probe
/// that cannot run is logged and does not undo the connection.
pub async fn confirm_assets(
    deps: &Deps,
    ctx: &Ctx,
    input: ConfirmAssets,
) -> Result<Vec<CapabilityOut>, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut selected: Vec<String> = Vec::new();
    for id in &input.selected {
        let id = id.trim();
        if !id.is_empty() && !selected.iter().any(|s| s == id) {
            selected.push(id.to_owned());
        }
    }
    if selected.is_empty() {
        return Err(invalid("selected", "choose at least one asset"));
    }
    let ws = ctx.workspace_id;
    let mut repos = deps.uow.tenant(ws).await?;
    let flow = repos
        .oauth_pending()
        .lock(input.pending_id)
        .await?
        .ok_or_else(|| AppError::not_found(NO_SUCH_FLOW))?;
    if flow.expires_at < ctx.now {
        return Err(AppError::conflict(
            "the connection flow has expired; start it again",
        ));
    }
    let Some(sealed) = &flow.assets_sealed else {
        return Err(AppError::conflict("the provider has not called back yet"));
    };
    let connector = adapter(deps, flow.provider)?;
    let hosts = adapter_hosts(deps, connector.as_ref())?;
    let assets = open_assets(deps, ws, sealed)?;
    let unknown: Vec<&String> = selected
        .iter()
        .filter(|id| !assets.iter().any(|a| &a.external_id == *id))
        .collect();
    if !unknown.is_empty() {
        return Err(AppError::validation(
            "the flow found no asset with these ids",
            json!({ "field": "selected", "unknown": unknown }),
        ));
    }
    let chosen: Vec<Asset> = assets
        .into_iter()
        .filter(|a| selected.contains(&a.external_id))
        .collect();
    let touched = if let Some(id) = flow.capability_id {
        let rest = renew(
            deps,
            repos.as_mut(),
            ctx,
            (&flow, id),
            &selected[0],
            chosen,
            &hosts,
        )
        .await?;
        let mut ids = vec![id];
        if !rest.is_empty() {
            ids.extend(create(deps, repos.as_mut(), ctx, &flow, rest, &hosts).await?);
        }
        ids
    } else {
        create(deps, repos.as_mut(), ctx, &flow, chosen, &hosts).await?
    };
    repos.oauth_pending().delete(flow.id).await?;
    repos.commit().await?;

    allow_hosts(deps, ctx, &hosts);
    let mut out = Vec::with_capacity(touched.len());
    for id in touched {
        if let Err(e) = probe_locked(deps, ctx, id, true).await {
            tracing::warn!(
                workspace_id = %ws,
                capability_id = %id,
                error = %e,
                "a connected capability could not be probed"
            );
        }
        out.push(current(deps, ctx, id).await?);
    }
    Ok(out)
}

/// Enters credentials by hand for an existing capability or a new one, probes them, and returns
/// the capability. Needs `capabilities.manage`.
///
/// The target is `capability_id`, or `kind_key` and `name` for a new capability; both or
/// neither is `VALIDATION` (naming `capability_id`, or `kind_key`, or `name` when only the name
/// is missing). The kind must be one reached through a connector whose provider takes
/// credentials by hand (`sms_line`, `netgsm_pbx` and the Meta kinds), else `VALIDATION` naming
/// `kind_key` (`x`: "this kind connects through OAuth"). The credential's shape must fit the kind
/// (else `VALIDATION` naming `credential.kind`), every field must be 1 to
/// [`MAX_CREDENTIAL_FIELD_CHARS`] characters (a secret up to [`MAX_SECRET_CHARS`]) without
/// control characters (else `VALIDATION` naming `credential.<field>`, never echoing a value), and
/// a pasted Page or WhatsApp token needs its account's id (`external_id`). A new capability is
/// validated as a declaration is (its `name`); an existing one must be the workspace's
/// (`NOT_FOUND`), not retired and not verified (`CONFLICT`: a verified capability keeps its
/// credentials until a probe fails), and a given `external_id` must be the one it holds, if it
/// holds one. An existing capability without an external id given one is rebound
/// (`rebind_account`: back to `declared`, its verification and evidence dropped) before the
/// new binding is probed; an account another live capability of the kind holds is `CONFLICT`
/// naming `kind_key` and `external_id`, before the provider is asked anything. A `meta_ads`
/// external id loses a leading `act_` (`jt_capability::canonical_external_id`).
///
/// The credential is sealed, the adapter's connection step runs with it (see the module docs),
/// then it is probed with the adapter ([`probe`]'s rules, account binding included: the probe
/// must reach the given or held external id; without one, the probe's account becomes it), and
/// written (which clears `reconnect_required`) in one transaction with the capability and its
/// probe. Writes
/// `connector.credentials_set` (payload `kind_key` and `by_agent`; never a value), and
/// `connector.probe` when the status changed. Once committed, the adapter's hosts are allowed for
/// the workspace.
pub async fn set_credentials(
    deps: &Deps,
    ctx: &Ctx,
    input: SetCredentials,
) -> Result<CapabilityOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let SetCredentials {
        capability_id,
        kind_key,
        name,
        external_id,
        credential,
    } = input;
    let external_id = match external_id {
        Some(raw) => Some(checked_external_id(&raw)?),
        None => None,
    };
    let credential = normalised(credential)?;
    match (capability_id, kind_key, name) {
        (Some(id), None, None) => credentials_for(deps, ctx, id, external_id, credential).await,
        (Some(_), _, _) => Err(invalid(
            "capability_id",
            "name either the capability (capability_id) or a new one (kind_key and name), not \
             both",
        )),
        (None, Some(kind_key), Some(name)) => {
            credentials_for_new(deps, ctx, kind_key.trim(), name, external_id, credential).await
        }
        (None, Some(_), None) => Err(invalid("name", "a new capability needs a name")),
        (None, None, _) => Err(invalid(
            "kind_key",
            "name the capability (capability_id) or the kind and name of a new one (kind_key, \
             name)",
        )),
    }
}

/// Probes connector capability `id` with its sealed credentials and returns the outcome and its
/// stored status after it. Needs `workspace.read` (an agent's check of its hands, and a
/// person's).
///
/// An unknown id is `NOT_FOUND`; a capability not reached through a connector, a retired one, one
/// whose kind no provider serves or whose provider has no adapter here, and one without
/// credentials (`CONFLICT` "no credentials") are `CONFLICT`. The capability is locked while the
/// provider is asked. The run is logged; the status follows `status_after_probe`;
/// `connector_public.health` becomes the run; `Auth` sets `connector_public.reconnect_required`
/// and a success clears it, verifies the capability (`last_verified_at`, evidence
/// `{text: "probe", refs: [run id]}`) and keeps its facts in `connector_public.facts`. The
/// account is bound as the module docs say. Writes `connector.probe` (payload `ok`, and
/// `error_kind` for a failure) only when the status changed.
pub async fn probe(deps: &Deps, ctx: &Ctx, id: CapabilityId) -> Result<ProbeOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    probe_locked(deps, ctx, id, false).await
}

/// The health of every connector capability that is not retired, oldest first: its status at
/// `ctx.now`, its last probe (when, whether it succeeded, the error's kind), read from
/// `connector_public.health` (each probe writes it with its run, and binding another account
/// clears it, so it is always the current binding's), and when its token expires, read from
/// `connector_public.access.expires_at` (no sealed credential is opened), and whether it must be
/// reconnected. Needs `workspace.read`.
pub async fn health(deps: &Deps, ctx: &Ctx) -> Result<Vec<ConnectorHealth>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let capabilities = repos
        .capabilities()
        .list(CapabilityFilter::default())
        .await?;
    let mut out = Vec::new();
    for c in capabilities
        .into_iter()
        .filter(|c| c.reach == Reach::Connector && c.status != StoredStatus::Retired)
    {
        let at = |value: &Value| {
            value
                .as_str()
                .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
        };
        let last = &c.connector_public["health"];
        let token_expires_at = at(&c.connector_public["access"]["expires_at"]);
        out.push(ConnectorHealth {
            capability_id: c.id,
            provider: provider_for_kind(&c.kind_key),
            status: effective_status(&c, ctx.now),
            last_probe_at: at(&last["at"]),
            ok: last["ok"].as_bool(),
            error_kind: last["error_kind"].as_str().map(str::to_owned),
            token_expires_at,
            reconnect_required: reconnect_required(&c),
            kind_key: c.kind_key,
            name: c.name,
        });
    }
    Ok(out)
}

/// Starts an OAuth flow bound to capability `id`, so that confirming it gives the capability the
/// asset chosen first ([`confirm_assets`]: renewing its sealed credentials, or binding a declared
/// capability to its first account) instead of only creating capabilities, and returns it as
/// [`start_oauth`] does. Needs `capabilities.manage`.
///
/// An unknown id is `NOT_FOUND`; a capability not reached through a connector, a retired one,
/// one of a kind no provider serves, and one that names no external account unless it is
/// declared (never connected) are `CONFLICT`; a NetGSM capability is `VALIDATION` with
/// `details.reason = "use_set_credentials"` (it takes new credentials by hand). Otherwise as
/// [`start_oauth`]; the ledger payload also names the `capability_id`.
pub async fn reconnect(deps: &Deps, ctx: &Ctx, id: CapabilityId) -> Result<StartOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let capability = {
        let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
        find(repos.as_mut(), id).await?
    };
    reconnectable(&capability)?;
    begin_oauth(deps, ctx, &capability.kind_key, Some(id)).await
}

/// The webhook addresses to register at the providers, under the public base URL (its path kept,
/// without a trailing slash): the platform's Meta webhook ([`META_HOOK_PATH`]) when the Meta app
/// is configured, with [`VERIFY_TOKEN_HINT`] instead of its verify token; and the workspace's
/// NetGSM callback URL for each purpose, `{NETGSM_HOOK_PATH}/{workspace_id}/{token}/{purpose}`,
/// whose token ([`super::webhook::netgsm_hook_token`]) is what lets NetGSM's calls in. The token
/// is a capability of the URL, not a sealed secret, but it lets anyone who holds it store events
/// in the workspace: only who may manage capabilities sees it. Needs `capabilities.manage`.
pub async fn hooks(deps: &Deps, ctx: &Ctx) -> Result<HooksOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let apps = deps.apps.as_ref();
    let meta = apps.meta_app().map(|_| MetaHook {
        url: public_url(apps, META_HOOK_PATH).to_string(),
        verify_token_hint: VERIFY_TOKEN_HINT.to_owned(),
    });
    let mut netgsm = Vec::new();
    for &purpose in NetgsmPurpose::all() {
        let token = netgsm_hook_token(deps, ctx.workspace_id, purpose)?;
        let path = format!(
            "{NETGSM_HOOK_PATH}/{}/{token}/{}",
            ctx.workspace_id,
            purpose.key()
        );
        netgsm.push(NetgsmHook {
            purpose: purpose.key().to_owned(),
            url: public_url(apps, &path).to_string(),
        });
    }
    Ok(HooksOut { meta, netgsm })
}

/// Whether `capability` must be reconnected: `connector_public.reconnect_required` is `true`.
pub(crate) fn reconnect_required(capability: &Capability) -> bool {
    capability.connector_public[RECONNECT_REQUIRED].as_bool() == Some(true)
}

/// `capability`'s public connector fields as they stand once it is retired: no reconnection is
/// asked for any more; the rest (its last probe included) stays for the record.
pub(crate) fn retired_public(capability: &Capability) -> Value {
    let mut public = object(&capability.connector_public);
    public.insert(RECONNECT_REQUIRED.to_owned(), json!(false));
    Value::Object(public)
}

// ---------------------------------------------------------------------------------------------
// OAuth steps
// ---------------------------------------------------------------------------------------------

/// Starts a flow for `kind_key`, bound to capability `bound` for a reconnection (which is locked
/// and checked again in the bundle that writes the flow).
async fn begin_oauth(
    deps: &Deps,
    ctx: &Ctx,
    kind_key: &str,
    bound: Option<CapabilityId>,
) -> Result<StartOut, AppError> {
    let provider = oauth_kind(kind_key)?;
    let app = oauth_app(deps.apps.as_ref(), provider, kind_key)
        .ok_or_else(|| app_not_configured(provider))?;
    let oauth = deps
        .connectors
        .oauth(provider)
        .ok_or_else(|| AppError::conflict(NO_ADAPTER))?;
    let started_by = acting_user(&ctx.actor)
        .ok_or_else(|| AppError::forbidden("only a person or an agent starts an OAuth flow"))?;
    let ws = ctx.workspace_id;

    let state = OAuthState {
        workspace_id: ws,
        provider,
        kind_key: kind_key.to_owned(),
        issued_at: ctx.now,
        nonce: nonce(deps),
    };
    let key = deps.seal.hmac_key(ws, OAUTH_STATE_PURPOSE)?;
    let token = state.sign(&key);
    let (pkce_verifier_sealed, challenge) = if provider == Provider::X {
        // The token generator's random bytes in base64url: exactly what `pkce_pair` makes.
        let verifier = Zeroizing::new(deps.tokens.token(PKCE_VERIFIER_BYTES));
        let challenge = pkce_challenge_s256(&verifier);
        (
            Some(deps.seal.seal(ws, verifier.as_bytes())?),
            Some(challenge),
        )
    } else {
        (None, None)
    };
    let redirect = callback_url(deps.apps.as_ref(), provider);
    // Before anything is written: a refused URL leaves no pending flow and no ledger entry.
    let authorize_url = oauth
        .authorize_url(&app, &redirect, &token, challenge.as_deref())
        .map_err(|e| provider_error(provider, e))?;

    let id = OAuthPendingId(deps.ids.uuid());
    let mut repos = deps.uow.tenant(ws).await?;
    if let Some(capability) = bound {
        let capability = locked(repos.as_mut(), capability).await?;
        reconnectable(&capability)?;
    }
    repos
        .oauth_pending()
        .insert(OAuthPendingRow {
            id,
            workspace_id: ws,
            provider,
            kind_key: kind_key.to_owned(),
            state_hash: hash_token(&token),
            started_by,
            capability_id: bound,
            pkce_verifier_sealed,
            assets_sealed: None,
            assets_public: json!([]),
            expires_at: ctx.now + PENDING_TTL,
            created_at: ctx.now,
        })
        .await?;
    let mut payload = json!({ "provider": provider.key(), "kind_key": kind_key });
    if let Some(capability) = bound {
        payload["capability_id"] = json!(capability);
    }
    let in_force = version_in_force(repos.as_mut()).await?;
    append(
        repos.as_mut(),
        ctx,
        "connector.oauth_started",
        "oauth_pending",
        id,
        in_force,
        payload,
    )
    .await?;
    repos.commit().await?;
    Ok(StartOut {
        authorize_url: authorize_url.to_string(),
        pending_id: id,
        expires_at: ctx.now + STATE_TTL,
    })
}

/// The provider whose OAuth flow connects `kind_key`, else `VALIDATION` naming `kind_key`.
fn oauth_kind(kind_key: &str) -> Result<Provider, AppError> {
    let kind = connector_kind(kind_key)?;
    match provider_for_kind(kind.key) {
        Some(Provider::Netgsm) => Err(AppError::validation(
            "this kind connects with credentials entered by hand (connector.set_credentials)",
            json!({ "field": "kind_key", "reason": "use_set_credentials" }),
        )),
        Some(provider) => Ok(provider),
        None => Err(invalid("kind_key", "no provider connects this kind yet")),
    }
}

/// The kind `kind_key` when it is reached through a connector, else `VALIDATION` naming
/// `kind_key`.
fn connector_kind(kind_key: &str) -> Result<&'static CapabilityKind, AppError> {
    let kind = CapabilityKind::parse(kind_key)
        .ok_or_else(|| invalid("kind_key", &format!("unknown capability kind {kind_key:?}")))?;
    if kind.default_reach() != Reach::Connector {
        return Err(invalid(
            "kind_key",
            "only a capability reached through a connector connects through a provider",
        ));
    }
    Ok(kind)
}

/// The app the flow for `kind_key` runs under, when configured: Instagram Login for
/// `instagram`, the Meta app for the other Meta kinds, the X app for `x`.
fn oauth_app(apps: &dyn PlatformAppConfig, provider: Provider, kind_key: &str) -> Option<OAuthApp> {
    match provider {
        Provider::Meta if kind_key == "instagram" => apps.instagram_app().map(OAuthApp::Instagram),
        Provider::Meta => apps.meta_app().map(OAuthApp::Meta),
        Provider::X => apps.x_app().map(OAuthApp::X),
        Provider::Netgsm => None,
    }
}

/// The redirect URI of `provider`'s flows: the public base URL (its path kept, without a
/// trailing slash), [`OAUTH_CALLBACK_PATH`] and the provider's key.
fn callback_url(apps: &dyn PlatformAppConfig, provider: Provider) -> Url {
    public_url(apps, &format!("{OAUTH_CALLBACK_PATH}/{}", provider.key()))
}

/// The public base URL (its path kept, without a trailing slash) followed by `path`, which
/// starts with `/`; no query, no fragment.
fn public_url(apps: &dyn PlatformAppConfig, path: &str) -> Url {
    let mut url = apps.public_base_url();
    let base = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{base}{path}"));
    url.set_query(None);
    url.set_fragment(None);
    url
}

/// A state's nonce: [`NONCE_BYTES`] random bytes from the token generator, through SHA-256 so
/// any encoding of the token fits.
fn nonce(deps: &Deps) -> [u8; NONCE_BYTES] {
    let token = Zeroizing::new(deps.tokens.token(NONCE_BYTES));
    let digest = Sha256::digest(token.as_bytes());
    let mut nonce = [0u8; NONCE_BYTES];
    nonce.copy_from_slice(&digest[..NONCE_BYTES]);
    nonce
}

/// `CONFLICT` "provider app not configured" for a flow of `provider`, naming the reason
/// (`provider_app_not_configured`) and the provider in `details`.
fn app_not_configured(provider: Provider) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: APP_NOT_CONFIGURED.into(),
        details: json!({ "reason": "provider_app_not_configured", "provider": provider.key() }),
    }
}

/// `FORBIDDEN` for every refused OAuth state, with the same message whatever the reason.
fn refused_state() -> AppError {
    AppError::forbidden("the OAuth state is not valid for this workspace, or was already used")
}

/// A provider's refusal, from a call made on the caller's behalf, as the caller sees it:
/// - `Auth`, `Permission`, `Permanent` (trying again will not help): `VALIDATION` with
///   `details = {provider, provider_error, reason}` (the error's kind and its redacted reason);
/// - `Throttle`, `Transient` (the provider is busy or unreachable): `UPSTREAM_UNAVAILABLE` with
///   `details = {provider, retryable: true, retry_after_s?, reason}` ([`AppError::upstream_unavailable`]).
///
/// A probe's failure is never such an error: it is the probe's result.
fn provider_error(provider: Provider, e: ConnectorError) -> AppError {
    match &e {
        ConnectorError::Throttle { retry_after } => AppError::upstream_unavailable(
            provider.key(),
            "rate limited",
            retry_after.map(|wait| wait.whole_seconds()),
        ),
        ConnectorError::Transient { reason, .. } => {
            AppError::upstream_unavailable(provider.key(), reason, None)
        }
        ConnectorError::Auth { .. }
        | ConnectorError::Permission { .. }
        | ConnectorError::Permanent { .. } => AppError::validation(
            format!("the provider refused ({})", e.kind()),
            json!({ "provider": provider.key(), "provider_error": e.kind(), "reason": e.reason() }),
        ),
    }
}

/// `CONFLICT` (or `VALIDATION` for NetGSM) unless `capability` can be reconnected by OAuth.
fn reconnectable(capability: &Capability) -> Result<(), AppError> {
    if capability.reach != Reach::Connector {
        return Err(AppError::conflict(
            "only a capability reached through a connector is reconnected",
        ));
    }
    not_retired(capability)?;
    match provider_for_kind(&capability.kind_key) {
        Some(Provider::Netgsm) => {
            return Err(AppError::validation(
                "a NetGSM capability takes new credentials by hand (connector.set_credentials)",
                json!({ "reason": "use_set_credentials" }),
            ));
        }
        None => return Err(AppError::conflict("no provider connects this kind yet")),
        Some(Provider::Meta | Provider::X) => {}
    }
    // A declared capability is connected for the first time through a flow bound to it; any
    // other must name the account it reconnects.
    if capability.external_id.is_none() && capability.status != StoredStatus::Declared {
        return Err(AppError::conflict(
            "the capability names no external account to reconnect",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Confirming assets
// ---------------------------------------------------------------------------------------------

/// An asset as sealed with its flow: every field, its credential included. Private, so the
/// serialisable form of an asset exists only between sealing and opening.
#[derive(Serialize, Deserialize)]
struct SealedAsset {
    kind_key: String,
    external_id: String,
    name: String,
    credential: Credential,
    public: Value,
}

/// `assets` sealed for the context's workspace.
fn seal_assets(deps: &Deps, ctx: &Ctx, assets: Vec<Asset>) -> Result<Vec<u8>, AppError> {
    let sealed: Vec<SealedAsset> = assets
        .into_iter()
        .map(|a| SealedAsset {
            kind_key: a.kind_key,
            external_id: a.external_id,
            name: a.name,
            credential: a.credential,
            public: a.public,
        })
        .collect();
    let plain = Zeroizing::new(
        serde_json::to_vec(&sealed).map_err(|_| AppError::internal("assets cannot be sealed"))?,
    );
    deps.seal.seal(ctx.workspace_id, &plain)
}

/// The assets sealed with a flow, opened.
fn open_assets(
    deps: &Deps,
    ws: jt_tenancy::WorkspaceId,
    sealed: &[u8],
) -> Result<Vec<Asset>, AppError> {
    let plain = deps.seal.open(ws, sealed)?;
    let assets: Vec<SealedAsset> = serde_json::from_slice(&plain)
        .map_err(|_| AppError::internal("the sealed assets cannot be read"))?;
    Ok(assets
        .into_iter()
        .map(|a| Asset {
            kind_key: a.kind_key,
            external_id: a.external_id,
            name: a.name,
            credential: a.credential,
            public: a.public,
        })
        .collect())
}

/// Creates a capability per asset of a new connection, in `repos`, and returns their ids.
async fn create(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    flow: &OAuthPendingRow,
    chosen: Vec<Asset>,
    hosts: &[String],
) -> Result<Vec<CapabilityId>, AppError> {
    let in_force = version_in_force(repos).await?;
    let live: Vec<Capability> = repos
        .capabilities()
        .list(CapabilityFilter::default())
        .await?
        .into_iter()
        .filter(|c| c.status != StoredStatus::Retired)
        .collect();
    for asset in &chosen {
        let held = live.iter().any(|c| {
            c.kind_key == asset.kind_key && c.external_id.as_deref() == Some(&asset.external_id)
        });
        if held {
            return Err(account_taken(&asset.kind_key, &asset.external_id));
        }
    }
    let mut ids = Vec::with_capacity(chosen.len());
    for asset in chosen {
        let public = connected_public(
            &Value::Object(Map::new()),
            flow.provider,
            Some(&asset.name),
            hosts,
            asset.credential.redact_for_public(),
            Some(&asset.public),
        );
        let mut capability = Capability::new(
            CapabilityId(deps.ids.uuid()),
            ctx.workspace_id,
            NewCapability {
                kind_key: asset.kind_key.clone(),
                key_detail: None,
                name: fitted_name(&asset.name, &asset.external_id),
                description: String::new(),
                external_id: Some(asset.external_id.clone()),
                connector_public: public,
                policy: Policy::default(),
            },
            ctx.now,
        )
        .map_err(capability_error)?;
        if capability.reach != Reach::Connector {
            return Err(AppError::internal(
                "a provider listed an asset of a kind not reached through a connector",
            ));
        }
        capability.declared_by_connection = ctx.agent_connection_id;
        capability.strategy_version_id = in_force.map(|v| v.as_uuid());
        let sealed = seal_credential(deps, ctx, &asset.credential)?;
        repos
            .capabilities()
            .insert(capability.clone(), Some(sealed))
            .await
            .map_err(|e| match e.code {
                // Another connection took the account since the check above.
                ErrorCode::Conflict => account_taken(&asset.kind_key, &asset.external_id),
                _ => e,
            })?;
        append(
            repos,
            ctx,
            "connector.connected",
            "capability",
            capability.id,
            in_force,
            json!({ "kind_key": asset.kind_key, "external_id": asset.external_id }),
        )
        .await?;
        ids.push(capability.id);
    }
    Ok(ids)
}

/// Gives capability `id`, the one the flow is bound to, the chosen asset of its kind whose id is
/// `first` (the one chosen first), in `repos`: the new credential sealed into it, renewing its
/// connection when it already holds that account, else binding it to the asset's account through
/// [`rebind_account`]. Returns the other chosen assets.
async fn renew(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    (flow, id): (&OAuthPendingRow, CapabilityId),
    first: &str,
    mut chosen: Vec<Asset>,
    hosts: &[String],
) -> Result<Vec<Asset>, AppError> {
    let mut capability = locked(repos, id).await?;
    not_retired(&capability)?;
    let Some(at) = chosen
        .iter()
        .position(|a| a.external_id == first && a.kind_key == capability.kind_key)
    else {
        return Err(invalid(
            "selected",
            "the asset chosen first becomes the capability, so it must be of the capability's kind",
        ));
    };
    let asset = chosen.remove(at);
    let sealed = seal_credential(deps, ctx, &asset.credential)?;
    let renewing = capability.external_id.as_deref() == Some(asset.external_id.as_str());
    if !renewing {
        rebind_account(
            repos,
            &mut capability,
            Some(asset.external_id.clone()),
            Some(sealed.clone()),
            ctx.now,
        )
        .await?;
    }
    capability.connector_public = connected_public(
        &capability.connector_public,
        flow.provider,
        Some(&asset.name),
        hosts,
        asset.credential.redact_for_public(),
        Some(&asset.public),
    );
    capability.updated_at = ctx.now;
    repos.capabilities().update(capability.clone()).await?;
    if renewing {
        repos
            .capabilities()
            .set_sealed(id, Some(sealed), ctx.now)
            .await?;
    }
    let in_force = version_in_force(repos).await?;
    let mut payload = json!({ "kind_key": capability.kind_key, "external_id": asset.external_id });
    payload[if renewing { "reconnected" } else { "bound" }] = json!(true);
    append(
        repos,
        ctx,
        "connector.connected",
        "capability",
        id,
        in_force,
        payload,
    )
    .await?;
    Ok(chosen)
}

/// `CONFLICT`: a live capability of `kind_key` already holds the account `external_id`.
pub(crate) fn account_taken(kind_key: &str, external_id: &str) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: "a capability of this kind already holds the account".into(),
        details: json!({ "kind_key": kind_key, "external_id": external_id }),
    }
}

/// A capability name from a provider's name of an account: control characters as spaces,
/// trimmed, cut to [`MAX_NAME_CHARS`] characters; the external id when nothing is left.
fn fitted_name(name: &str, external_id: &str) -> String {
    let fit = |raw: &str| -> String {
        let cleaned: String = raw
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        cleaned
            .trim()
            .chars()
            .take(MAX_NAME_CHARS)
            .collect::<String>()
            .trim()
            .to_owned()
    };
    let name = fit(name);
    if name.is_empty() {
        fit(external_id)
    } else {
        name
    }
}

// ---------------------------------------------------------------------------------------------
// Credentials by hand
// ---------------------------------------------------------------------------------------------

/// The provider whose credentials `kind` takes by hand, else `VALIDATION` naming `kind_key`.
fn manual_provider(kind: &CapabilityKind) -> Result<Provider, AppError> {
    match provider_for_kind(kind.key) {
        Some(Provider::X) => Err(invalid("kind_key", "this kind connects through OAuth")),
        Some(provider) => Ok(provider),
        None => Err(invalid("kind_key", "no provider connects this kind yet")),
    }
}

/// [`set_credentials`] for a new capability of `kind_key` called `name`.
async fn credentials_for_new(
    deps: &Deps,
    ctx: &Ctx,
    kind_key: &str,
    name: String,
    external_id: Option<String>,
    input: CredentialInput,
) -> Result<CapabilityOut, AppError> {
    let kind = connector_kind(kind_key)?;
    let provider = manual_provider(kind)?;
    let external_id = external_id
        .map(|e| checked_external_id_of(kind.key, &e))
        .transpose()?;
    let credential = built_credential(kind.key, provider, input, external_id.as_deref())?;
    let connector = adapter(deps, provider)?;
    let hosts = adapter_hosts(deps, connector.as_ref())?;
    let public = connected_public(
        &Value::Object(Map::new()),
        provider,
        None,
        &hosts,
        credential.redact_for_public(),
        None,
    );
    let mut capability = Capability::new(
        CapabilityId(deps.ids.uuid()),
        ctx.workspace_id,
        NewCapability {
            kind_key: kind.key.to_owned(),
            key_detail: None,
            name,
            description: String::new(),
            external_id,
            connector_public: public,
            policy: Policy::default(),
        },
        ctx.now,
    )
    .map_err(capability_error)?;
    capability.declared_by_connection = ctx.agent_connection_id;

    // An account another live capability of the kind holds is refused before the provider is
    // asked anything (the insert catches a race with another connection).
    if let Some(account) = &capability.external_id {
        let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
        if account_held_elsewhere(repos.as_mut(), &capability, account).await? {
            return Err(account_taken(&capability.kind_key, account));
        }
    }
    let sealed = seal_credential(deps, ctx, &credential)?;
    // A new row has no one to wait for: the provider is asked before the transaction opens.
    let public = adapter_public(&capability);
    let step = connector.on_connected(&credential, &public).await;
    let result = connector.probe(&credential, &public).await;
    drop(credential);
    merge_connection_step(&mut capability, step);

    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    capability.strategy_version_id = in_force.map(|v| v.as_uuid());
    repos
        .capabilities()
        .insert(capability.clone(), Some(sealed))
        .await
        .map_err(|e| match (&capability.external_id, e.code) {
            (Some(external_id), ErrorCode::Conflict) => {
                account_taken(&capability.kind_key, external_id)
            }
            _ => e,
        })?;
    record_credentials(repos.as_mut(), ctx, &capability, in_force).await?;
    let id = capability.id;
    apply_probe(deps, repos.as_mut(), ctx, capability, result).await?;
    let out = current_in(repos.as_mut(), ctx, id).await?;
    repos.commit().await?;
    allow_hosts(deps, ctx, &hosts);
    Ok(out)
}

/// [`set_credentials`] for existing capability `id`.
async fn credentials_for(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    external_id: Option<String>,
    input: CredentialInput,
) -> Result<CapabilityOut, AppError> {
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut capability = locked(repos.as_mut(), id).await?;
    if capability.reach != Reach::Connector {
        return Err(invalid(
            "kind_key",
            "only a capability reached through a connector takes credentials",
        ));
    }
    not_retired(&capability)?;
    let kind = connector_kind(&capability.kind_key)?;
    let external_id = external_id
        .map(|e| checked_external_id_of(kind.key, &e))
        .transpose()?;
    let provider = manual_provider(kind)?;
    if capability.status == StoredStatus::Verified {
        return Err(AppError::conflict(
            "a verified capability keeps its credentials until a probe fails",
        ));
    }
    let bound = match (&capability.external_id, external_id) {
        (Some(held), Some(given)) if *held != given => {
            return Err(invalid(
                "external_id",
                "the capability holds another external account",
            ));
        }
        (Some(held), _) => Some(held.clone()),
        (None, given) => given,
    };
    // A new account for the capability: its earlier verification proved nothing about it.
    let rebinding = bound != capability.external_id;
    if rebinding
        && let Some(account) = &bound
        && account_held_elsewhere(repos.as_mut(), &capability, account).await?
    {
        return Err(account_taken(&capability.kind_key, account));
    }
    let credential = built_credential(kind.key, provider, input, bound.as_deref())?;
    let connector = adapter(deps, provider)?;
    let hosts = adapter_hosts(deps, connector.as_ref())?;
    capability.connector_public = connected_public(
        &capability.connector_public,
        provider,
        None,
        &hosts,
        credential.redact_for_public(),
        None,
    );
    capability.updated_at = ctx.now;

    // The provider is asked while the capability is locked (see the module docs), about the
    // binding being written.
    let probing = Capability {
        external_id: bound.clone(),
        ..capability.clone()
    };
    let sealed = seal_credential(deps, ctx, &credential)?;
    let public = adapter_public(&probing);
    let step = connector.on_connected(&credential, &public).await;
    let result = connector.probe(&credential, &public).await;
    drop(credential);

    if rebinding {
        rebind_account(
            repos.as_mut(),
            &mut capability,
            bound,
            Some(sealed),
            ctx.now,
        )
        .await?;
    } else {
        repos.capabilities().update(capability.clone()).await?;
        repos
            .capabilities()
            .set_sealed(id, Some(sealed), ctx.now)
            .await?;
    }
    // After a rebinding dropped the old account's facts, so the step's outcome is the new one's.
    merge_connection_step(&mut capability, step);
    let in_force = version_in_force(repos.as_mut()).await?;
    record_credentials(repos.as_mut(), ctx, &capability, in_force).await?;
    apply_probe(deps, repos.as_mut(), ctx, capability, result).await?;
    let out = current_in(repos.as_mut(), ctx, id).await?;
    repos.commit().await?;
    allow_hosts(deps, ctx, &hosts);
    Ok(out)
}

/// Writes `connector.credentials_set` about `capability`.
async fn record_credentials(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    capability: &Capability,
    in_force: Option<jt_strategy::StrategyVersionId>,
) -> Result<(), AppError> {
    let by_agent = matches!(ctx.actor, jt_ledger::Actor::Agent { .. });
    append(
        repos,
        ctx,
        "connector.credentials_set",
        "capability",
        capability.id,
        in_force,
        json!({ "kind_key": capability.kind_key, "by_agent": by_agent }),
    )
    .await
}

/// `input` with every field checked: identifiers trimmed, secrets as given; each 1 to its limit
/// in characters, without control characters, else `VALIDATION` naming `credential.<field>`.
fn normalised(input: CredentialInput) -> Result<CredentialInput, AppError> {
    let field = |name: &str, raw: &str| checked_field(name, raw, MAX_CREDENTIAL_FIELD_CHARS, true);
    let secret = |name: &str, raw: &str| checked_field(name, raw, MAX_SECRET_CHARS, false);
    let optional = |name: &str, raw: Option<String>| raw.map(|v| field(name, &v)).transpose();
    Ok(match input {
        CredentialInput::NetgsmSms {
            usercode,
            password,
            msgheader,
        } => CredentialInput::NetgsmSms {
            usercode: field("usercode", &usercode)?,
            password: secret("password", &password)?,
            msgheader: field("msgheader", &msgheader)?,
        },
        CredentialInput::NetgsmPbx {
            username,
            password,
            trunk,
            pbxnum,
        } => CredentialInput::NetgsmPbx {
            username: field("username", &username)?,
            password: secret("password", &password)?,
            trunk: optional("trunk", trunk)?,
            pbxnum: optional("pbxnum", pbxnum)?,
        },
        // A pasted token is trimmed: the whitespace around it comes from copying it.
        CredentialInput::MetaToken { access_token } => CredentialInput::MetaToken {
            access_token: checked_field("access_token", &access_token, MAX_SECRET_CHARS, true)?,
        },
    })
}

/// One credential field checked (see [`normalised`]); the refusal never repeats the value.
fn checked_field(name: &str, raw: &str, max: usize, trim: bool) -> Result<String, AppError> {
    let value = if trim { raw.trim() } else { raw };
    let field = format!("credential.{name}");
    if value.trim().is_empty() {
        return Err(invalid(&field, &format!("{field} must not be blank")));
    }
    if value.chars().count() > max {
        return Err(invalid(
            &field,
            &format!("{field} must be at most {max} characters"),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid(
            &field,
            &format!("{field} must not hold control characters"),
        ));
    }
    Ok(value.to_owned())
}

/// The credential `input` makes for a capability of `kind_key`, served by `provider`, holding
/// the account `external_id`; `VALIDATION` naming `credential.kind` when the shape does not fit
/// the kind, or `external_id` when a pasted Page or WhatsApp token comes without its account.
fn built_credential(
    kind_key: &str,
    provider: Provider,
    input: CredentialInput,
    external_id: Option<&str>,
) -> Result<Credential, AppError> {
    let account = |what: &str| {
        external_id.map(str::to_owned).ok_or_else(|| {
            invalid(
                "external_id",
                &format!("a pasted {what} token needs its id in external_id"),
            )
        })
    };
    let shape = input.kind();
    match (provider, kind_key, input) {
        (
            Provider::Netgsm,
            "sms_line",
            CredentialInput::NetgsmSms {
                usercode,
                password,
                msgheader,
            },
        ) => Ok(Credential::NetgsmSms {
            usercode,
            password,
            msgheader,
        }),
        (
            Provider::Netgsm,
            "netgsm_pbx",
            CredentialInput::NetgsmPbx {
                username,
                password,
                trunk,
                pbxnum,
            },
        ) => Ok(Credential::NetgsmPbx {
            username,
            password,
            trunk,
            pbxnum,
        }),
        (Provider::Meta, "facebook_page", CredentialInput::MetaToken { access_token }) => {
            Ok(Credential::PageToken {
                page_id: account("page")?,
                token: access_token,
            })
        }
        (Provider::Meta, "whatsapp_cloud", CredentialInput::MetaToken { access_token }) => {
            // A pasted token's expiry is not known (a system user's token has none).
            Ok(Credential::WhatsAppCloud {
                phone_number_id: account("WhatsApp phone number")?,
                token: access_token,
                waba_id: None,
                expires_at: None,
            })
        }
        (Provider::Meta, _, CredentialInput::MetaToken { access_token }) => Ok(Credential::OAuth {
            access_token,
            refresh_token: None,
            expires_at: None,
            scopes: Vec::new(),
        }),
        _ => {
            let expected = match (provider, kind_key) {
                (Provider::Netgsm, "sms_line") => "netgsm_sms",
                (Provider::Netgsm, _) => "netgsm_pbx",
                _ => "meta_token",
            };
            Err(AppError::validation(
                format!("a {kind_key} capability takes {expected} credentials, not {shape}"),
                json!({ "field": "credential.kind", "expected": expected }),
            ))
        }
    }
}

/// [`SetCredentials::credential`] read strictly, its refusal repeating no value: an unknown or a
/// missing field keeps serde's message (which names the field only); an unknown `kind` and every
/// other refusal (a field that is not a string, a credential that is not an object) get a fixed
/// one.
fn credential_strict<'de, D: Deserializer<'de>>(d: D) -> Result<CredentialInput, D::Error> {
    let value = Value::deserialize(d)?;
    serde_json::from_value(value).map_err(|e| {
        let message = e.to_string();
        let message = if message.starts_with("unknown field")
            || message.starts_with("missing field")
        {
            format!("invalid credential: {message}")
        } else if message.starts_with("unknown variant") {
            "invalid credential: `kind` must be netgsm_sms, netgsm_pbx or meta_token".to_owned()
        } else {
            "invalid credential: it must be an object with a `kind` and string fields".to_owned()
        };
        serde::de::Error::custom(message)
    })
}

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------

/// [`probe`] without its permission check: also run for capabilities just connected, which
/// first run the adapter's connection step (`connected`; see the module docs).
async fn probe_locked(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    connected: bool,
) -> Result<ProbeOut, AppError> {
    let ws = ctx.workspace_id;
    let mut repos = deps.uow.tenant(ws).await?;
    let mut capability = locked(repos.as_mut(), id).await?;
    if capability.reach != Reach::Connector {
        return Err(AppError::conflict(
            "only a capability reached through a connector is probed",
        ));
    }
    not_retired(&capability)?;
    let provider = provider_for_kind(&capability.kind_key)
        .ok_or_else(|| AppError::conflict("no provider connects this kind yet"))?;
    let connector = adapter(deps, provider)?;
    let sealed = repos
        .capabilities()
        .read_sealed(id)
        .await?
        .ok_or_else(|| AppError::conflict("no credentials"))?;
    let credential = open_credential(deps, ws, &sealed)?;
    let public = adapter_public(&capability);
    let step = if connected {
        Some(connector.on_connected(&credential, &public).await)
    } else {
        None
    };
    let result = connector.probe(&credential, &public).await;
    drop(credential);
    if let Some(step) = step {
        merge_connection_step(&mut capability, step);
    }
    let out = apply_probe(deps, repos.as_mut(), ctx, capability, result).await?;
    repos.commit().await?;
    Ok(out)
}

/// Records probe `result` of `capability` (read through `lock` in `repos`): binds the account,
/// logs the run, moves the status, updates the public connector fields and writes
/// `connector.probe` when the status changed (see [`probe`]).
async fn apply_probe(
    deps: &Deps,
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    mut capability: Capability,
    mut result: ProbeResult,
) -> Result<ProbeOut, AppError> {
    // Whatever the adapter reported, no secret-looking key goes further: not into the probe log,
    // the public fields or the answer.
    result.facts = screened(&result.facts);
    let result = bound_to_account(repos, &mut capability, result).await?;
    let run_id = ProbeRunId(deps.ids.uuid());
    repos
        .probe_runs()
        .append(ProbeRun::from_result(
            run_id,
            ctx.workspace_id,
            capability.id,
            ctx.now,
            &result,
        ))
        .await?;
    let previous = capability.status;
    let status = status_after_probe(previous, &result);
    let error = if result.ok {
        None
    } else {
        result.error.as_ref()
    };
    let error_kind = error.map(|e| e.kind().to_owned());

    let mut public = object(&capability.connector_public);
    let mut health = json!({
        "ok": result.ok,
        "at": rfc3339(ctx.now)?,
        "latency_ms": result.latency_ms,
        "error_kind": error_kind,
    });
    // The connection step's failure outlives the probes until the step runs again.
    if let Some(failure) = public.get("health").and_then(|h| h.get(ON_CONNECTED_ERROR)) {
        health[ON_CONNECTED_ERROR] = failure.clone();
    }
    public.insert("health".to_owned(), health);
    if result.ok {
        public.insert(RECONNECT_REQUIRED.to_owned(), json!(false));
        // The last success's facts replace the previous ones (screened above).
        if result.facts.is_object() {
            public.insert("facts".to_owned(), result.facts.clone());
        } else {
            public.remove("facts");
        }
        capability.last_verified_at = Some(ctx.now);
        capability.evidence = Some(Evidence {
            text: "probe".into(),
            refs: vec![run_id.to_string()],
        });
    } else if matches!(error, Some(ConnectorError::Auth { .. })) {
        public.insert(RECONNECT_REQUIRED.to_owned(), json!(true));
    }
    capability.connector_public = Value::Object(public);
    capability.status = status;
    capability.updated_at = ctx.now;
    repos.capabilities().update(capability.clone()).await?;

    if status != previous {
        let mut payload = json!({ "ok": result.ok });
        if let Some(kind) = &error_kind {
            payload["error_kind"] = json!(kind);
        }
        let in_force = version_in_force(repos).await?;
        append(
            repos,
            ctx,
            "connector.probe",
            "capability",
            capability.id,
            in_force,
            payload,
        )
        .await?;
    }
    Ok(ProbeOut {
        result: ProbeResultPublic {
            ok: result.ok,
            latency_ms: result.latency_ms,
            error_kind,
            error_reason: error.and_then(|e| e.reason()).map(str::to_owned),
            facts: result.facts.clone(),
        },
        status,
    })
}

/// `result` once the account it reached is checked against `capability`'s (see the module docs):
/// a success counts only when it names, as a string in `facts.account_id`, the capability's
/// external id, or, for a capability without one, an account no other live capability of its kind
/// holds (which the capability then takes). Anything else (no account named, or not as a string,
/// another account, an account held elsewhere) becomes `Permission` "account mismatch": a
/// credential never verifies an account it has not shown to be its own.
async fn bound_to_account(
    repos: &mut dyn TenantRepos,
    capability: &mut Capability,
    result: ProbeResult,
) -> Result<ProbeResult, AppError> {
    if !result.ok {
        return Ok(result);
    }
    let mismatch = || {
        ProbeResult::failure(
            result.latency_ms,
            ConnectorError::permission("account mismatch"),
        )
    };
    let Some(account) = result.facts["account_id"].as_str().map(str::to_owned) else {
        return Ok(mismatch());
    };
    if account.trim().is_empty() || account.chars().count() > MAX_EXTERNAL_ID_CHARS {
        return Ok(mismatch());
    }
    match &capability.external_id {
        Some(held) if *held == account => Ok(result),
        Some(_) => Ok(mismatch()),
        None => {
            if account_held_elsewhere(repos, capability, &account).await? {
                return Ok(mismatch());
            }
            capability.external_id = Some(account);
            Ok(result)
        }
    }
}

/// Whether a live capability of `capability`'s kind, other than it, holds `account`.
pub(crate) async fn account_held_elsewhere(
    repos: &mut dyn TenantRepos,
    capability: &Capability,
    account: &str,
) -> Result<bool, AppError> {
    let kind = CapabilityKind::parse(&capability.kind_key).map(|k| k.key);
    Ok(repos
        .capabilities()
        .list(CapabilityFilter {
            kind,
            ..CapabilityFilter::default()
        })
        .await?
        .iter()
        .any(|c| {
            c.id != capability.id
                && c.kind_key == capability.kind_key
                && c.status != StoredStatus::Retired
                && c.external_id.as_deref() == Some(account)
        }))
}

/// Binds `capability` (read through `lock` in `repos`) to the external account `external_id` as
/// an unproven binding, and writes it: whatever verified the previous binding proved nothing about
/// this one, so it reads `declared` again (a retired capability stays retired) with no
/// verification time and no evidence, its sealed credentials become `sealed` (`None` removes
/// them), and no reconnection is asked for (a declared capability reads as not connected on its
/// own). The public facts of the old account go with it: its last probe (`health`, which
/// [`health`] reads), the probe's facts, the OAuth asset's facts and the account (`facts`,
/// `asset`, `account`), and, when no credential replaces the dropped one, its public facts
/// (`access`, whose expiry would otherwise name a token that no longer exists). The provider and
/// the hosts stay, being the kind's. Every change of a connector capability's external
/// account goes through here (entering credentials for a new account here; editing a
/// capability's external id in `capability.update`), before anything probes the new binding.
/// An account another live capability of the kind holds is `CONFLICT` naming `kind_key` and
/// `external_id`, and nothing is written.
pub(crate) async fn rebind_account(
    repos: &mut dyn TenantRepos,
    capability: &mut Capability,
    external_id: Option<String>,
    sealed: Option<Vec<u8>>,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    if let Some(account) = &external_id
        && account_held_elsewhere(repos, capability, account).await?
    {
        return Err(account_taken(&capability.kind_key, account));
    }
    capability.external_id = external_id;
    if capability.status != StoredStatus::Retired {
        capability.status = StoredStatus::Declared;
    }
    capability.last_verified_at = None;
    capability.evidence = None;
    let mut public = object(&capability.connector_public);
    for key in OLD_ACCOUNT_FACTS {
        public.remove(*key);
    }
    if sealed.is_none() {
        public.remove("access");
    }
    public.insert(RECONNECT_REQUIRED.to_owned(), json!(false));
    capability.connector_public = Value::Object(public);
    capability.updated_at = at;
    repos.capabilities().update(capability.clone()).await?;
    repos
        .capabilities()
        .set_sealed(capability.id, sealed, at)
        .await
}

/// `value` without any object key, at any depth (inside arrays too), that looks like a secret's
/// name ([`jt_capability::is_secret_looking_key`]): what a provider reports is shown and stored
/// only so screened.
fn screened(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !is_secret_looking_key(key))
                .map(|(key, v)| (key.clone(), screened(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(screened).collect()),
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------------------------

/// The adapter of `provider`, else `CONFLICT`.
fn adapter(deps: &Deps, provider: Provider) -> Result<Arc<dyn Connector>, AppError> {
    deps.connectors
        .connector(provider)
        .ok_or_else(|| AppError::conflict(NO_ADAPTER))
}

/// The hosts `connector` reaches, each checked with the tenant host registry before anything is
/// written.
fn adapter_hosts(deps: &Deps, connector: &dyn Connector) -> Result<Vec<String>, AppError> {
    let hosts: Vec<String> = connector.hosts().iter().map(|h| (*h).to_owned()).collect();
    for host in &hosts {
        deps.hosts.check(host)?;
    }
    Ok(hosts)
}

/// Allows `hosts` for the context's workspace, after a commit; a host that cannot be allowed is
/// logged, since the committed change holds.
fn allow_hosts(deps: &Deps, ctx: &Ctx, hosts: &[String]) {
    let distinct: BTreeSet<&String> = hosts.iter().collect();
    for host in distinct {
        if let Err(e) = deps.hosts.allow(ctx.workspace_id, host) {
            tracing::warn!(
                workspace_id = %ctx.workspace_id,
                host,
                error = %e,
                "a connector's host could not be allowed"
            );
        }
    }
}

/// `public` (an object, or none) with the facts of a connection whose credential is being
/// sealed: the provider, the account's name when given, the adapter's hosts added to those
/// already named, the credential's public facts (`access`), the asset's when given, and
/// `reconnect_required` cleared.
fn connected_public(
    public: &Value,
    provider: Provider,
    name: Option<&str>,
    hosts: &[String],
    access: Value,
    asset: Option<&Value>,
) -> Value {
    let mut out = object(public);
    out.insert("provider".to_owned(), json!(provider.key()));
    if let Some(name) = name {
        out.insert("name".to_owned(), json!(name));
    }
    let mut all: Vec<String> = out
        .get("hosts")
        .and_then(Value::as_array)
        .map(|named| {
            named
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    for host in hosts {
        if !all.iter().any(|h| h.trim().eq_ignore_ascii_case(host)) {
            all.push(host.clone());
        }
    }
    out.insert("hosts".to_owned(), json!(all));
    out.insert("access".to_owned(), access);
    if let Some(asset) = asset {
        out.insert("asset".to_owned(), asset.clone());
    }
    // A fresh credential is being sealed: nothing asks to be reconnected until a probe of it
    // fails with `Auth`.
    out.insert(RECONNECT_REQUIRED.to_owned(), json!(false));
    Value::Object(out)
}

/// `value`'s fields, or none when it is not an object.
fn object(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

/// `capability`'s `connector_public` as adapters are handed it
/// ([`crate::ports::connectors::Connector`]): the stored fields with `kind_key` set from the
/// capability's kind and, when it holds one, `external_id` from its external account, so what an
/// adapter acts on is the capability's own, whatever the stored fields say (a tenant may write
/// keys the connector does not reserve). Never stored: `kind_key` could not be (the public fields
/// refuse every key containing `key`), and both are the capability's own columns.
pub(crate) fn adapter_public(capability: &Capability) -> Value {
    let mut public = object(&capability.connector_public);
    public.insert("kind_key".to_owned(), json!(capability.kind_key));
    match &capability.external_id {
        Some(account) => public.insert("external_id".to_owned(), json!(account)),
        None => public.remove("external_id"),
    };
    Value::Object(public)
}

/// The outcome `step` of the adapter's connection step, written into `capability`'s public
/// fields (see the module docs): an object's keys merged in, screened and never over a
/// connector-owned or connection key, and any earlier failure cleared; a failure kept, redacted,
/// in `health.on_connected_error`.
fn merge_connection_step(capability: &mut Capability, step: Result<Value, ConnectorError>) {
    let mut public = object(&capability.connector_public);
    let mut health = public.get("health").map(object).unwrap_or_default();
    match step {
        Ok(facts) => {
            if let Value::Object(facts) = screened(&facts) {
                for (key, value) in facts {
                    let owned = RESERVED_PUBLIC_KEYS.contains(&key.as_str())
                        || CONNECTION_KEYS.contains(&key.as_str());
                    if !owned {
                        public.insert(key, value);
                    }
                }
            }
            health.remove(ON_CONNECTED_ERROR);
        }
        Err(e) => {
            health.insert(
                ON_CONNECTED_ERROR.to_owned(),
                json!(redact_reason(&e.to_string())),
            );
        }
    }
    if health.is_empty() {
        public.remove("health");
    } else {
        public.insert("health".to_owned(), Value::Object(health));
    }
    capability.connector_public = Value::Object(public);
}

/// `credential` sealed for the context's workspace.
fn seal_credential(deps: &Deps, ctx: &Ctx, credential: &Credential) -> Result<Vec<u8>, AppError> {
    let plain = Zeroizing::new(
        serde_json::to_vec(credential)
            .map_err(|_| AppError::internal("the credentials cannot be sealed"))?,
    );
    deps.seal.seal(ctx.workspace_id, &plain)
}

/// The credential sealed in `sealed`, opened for `ws`.
fn open_credential(
    deps: &Deps,
    ws: jt_tenancy::WorkspaceId,
    sealed: &[u8],
) -> Result<Credential, AppError> {
    let plain = deps.seal.open(ws, sealed)?;
    serde_json::from_slice(&plain)
        .map_err(|_| AppError::internal("the sealed credentials cannot be read"))
}

/// Capability `id` as it stands, at `ctx.now`, read in a bundle of its own.
async fn current(deps: &Deps, ctx: &Ctx, id: CapabilityId) -> Result<CapabilityOut, AppError> {
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    current_in(repos.as_mut(), ctx, id).await
}

/// Capability `id` as it stands in `repos`, at `ctx.now`.
async fn current_in(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    id: CapabilityId,
) -> Result<CapabilityOut, AppError> {
    Ok(CapabilityOut::at(find(repos, id).await?, ctx.now))
}

/// `at` in RFC 3339.
fn rfc3339(at: OffsetDateTime) -> Result<String, AppError> {
    at.format(&Rfc3339)
        .map_err(|_| AppError::internal("a time cannot be written in RFC 3339"))
}
