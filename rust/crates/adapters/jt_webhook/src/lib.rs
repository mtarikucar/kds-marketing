//! The webhook gate (spec §4.4, §11): where providers call the system. An inbound HTTP adapter
//! beside the panel's: `jeeta serve` merges [`router`] into its server at `/hooks/*`, outside the
//! panel's session and request-header checks (a provider holds no session) but inside the
//! server's security headers and access log, which names a route by its template, so no hook
//! token reaches the log.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /hooks/meta` | Meta's verification: the `hub.challenge` as `text/plain` when `hub.mode` is `subscribe` and `hub.verify_token` is the platform's (constant time); else `403`; `404` while no Meta app is configured |
//! | `POST /hooks/meta` | `200 EVENT_RECEIVED` once every event is stored or dropped; see **Meta** below |
//! | `POST /hooks/netgsm/{workspace_id}/{token}/{purpose}` | `202` once every event is stored; see **NetGSM** below |
//!
//! **Meta** (synchronous: a delivery is answered only after its events are stored, so a lost
//! answer is a redelivery, never a lost event): no Meta app configured, or no
//! `X-Hub-Signature-256` header, is `401` before the body is read; a body over
//! [`META_BODY_LIMIT`] (3 MB) is `413`; the signature is checked over the raw body before
//! anything is parsed, with the Meta app's secret and, when the platform's Instagram app is
//! configured, with its secret too (Instagram Login webhooks are signed with it), each in
//! constant time: either one signing it passes, neither is `401` with nothing stored. Each event is then
//! routed by its account across workspaces and stored in the one workspace that holds the
//! account connected (`jt_app::usecases::webhook::receive_for_accounts`), while that workspace is
//! active or awaits payment; an event no workspace holds connected (Review Focus 1), or whose
//! workspace is suspended, is dropped with nothing written, with a warning naming only the
//! provider, the reason (`unrouted` or `inactive`), the kind of account and how many (one warning
//! per reason, kind and delivery), and counted ([`counters`]`().unrouted_meta`, both reasons). A
//! signed body that is not a webhook the parser knows is
//! acknowledged, counted and stored as nothing (Meta would only redeliver it). A database
//! failure is `500`: Meta redelivers.
//!
//! **NetGSM** (unsigned: the URL carries the workspace's token per purpose): a path segment that
//! does not decode, an unknown purpose, a malformed workspace id, a token that is not the
//! workspace's for the purpose (constant time), and a workspace that does not exist or is not
//! active are all a bare `404`, before the body is read and with nothing stored, so a refusal
//! reveals nothing. A body over
//! [`NETGSM_BODY_LIMIT`] is `413`. A body the parser cannot read is `202` with nothing stored,
//! a warning (the purpose only) and a count ([`counters`]`().unparseable_netgsm`): NetGSM retries
//! anything else, and retrying cannot improve it. The events are stored synchronously in the
//! URL's workspace (`receive_netgsm`); a database failure is `503`, which NetGSM redelivers.
//!
//! Replays store nothing new (Review Focus 2): events are unique per workspace, provider and
//! provider id. No answer, log line or counter carries a body, an account id or a token.

mod meta;
mod netgsm;
mod raw;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::routing::{get, post};
use jt_app::usecases::Deps;
use jt_app::usecases::webhook::{META_HOOK_PATH, NETGSM_HOOK_PATH};

/// The largest Meta delivery read (WhatsApp Cloud API payloads reach 3 MB); a larger one is
/// `413`.
pub const META_BODY_LIMIT: usize = 3 * 1024 * 1024;
/// The largest NetGSM callback body read; a larger one is `413`.
pub const NETGSM_BODY_LIMIT: usize = 256 * 1024;

/// Meta events dropped because no workspace holds their account connected, or because the one
/// that does is suspended.
static UNROUTED_META: AtomicU64 = AtomicU64::new(0);
/// Signed Meta bodies the parser does not know.
static UNPARSEABLE_META: AtomicU64 = AtomicU64::new(0);
/// NetGSM callback bodies the parser cannot read.
static UNPARSEABLE_NETGSM: AtomicU64 = AtomicU64::new(0);

/// What the gate has dropped since the process started (process metrics: they reset at every
/// start and are never stored).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    /// Meta events dropped: for an account no workspace holds connected, or of a suspended
    /// workspace.
    pub unrouted_meta: u64,
    /// Signed Meta bodies that are not a webhook the parser knows.
    pub unparseable_meta: u64,
    /// NetGSM callback bodies the parser cannot read.
    pub unparseable_netgsm: u64,
}

/// The counters now.
pub fn counters() -> Counters {
    Counters {
        unrouted_meta: UNROUTED_META.load(Ordering::Relaxed),
        unparseable_meta: UNPARSEABLE_META.load(Ordering::Relaxed),
        unparseable_netgsm: UNPARSEABLE_NETGSM.load(Ordering::Relaxed),
    }
}

/// What the gate's routes share: the ports, as the panel and the MCP endpoint get them.
#[derive(Clone)]
pub struct WebhookState {
    pub deps: Arc<Deps>,
}

/// The gate's routes (see the crate docs), with no fallback of their own, so the server's router
/// they are merged into keeps its own.
pub fn router(state: WebhookState) -> Router {
    Router::new()
        .route(META_HOOK_PATH, get(meta::verify).post(meta::receive))
        .route(
            &format!("{NETGSM_HOOK_PATH}/{{workspace_id}}/{{token}}/{{purpose}}"),
            post(netgsm::receive),
        )
        .with_state(state)
}
