//! Connector domain (spec §4.2 rule 1, §4.4, §6.1, §6.4, §11): which provider serves which
//! capability kind, the one error taxonomy every provider adapter returns, the shapes of sealed
//! credentials, the signed OAuth state and PKCE, the webhook signature math, inbound events, and
//! how a probe result moves a capability's stored status. Pure, no I/O.
//!
//! Secrets: a [`Credential`] serialises in full only so it can be sealed; its `Debug` masks every
//! secret, and [`Credential::redact_for_public`] gives the facts that may be stored in
//! `connector_public` and shown. The `reason` of a [`ConnectorError`] built through its
//! constructors has been through [`redact_reason`].
//!
//! Every comparison against a secret value (a webhook signature, a hook token, the OAuth state's
//! MAC) runs in constant time.
//!
//! Stored types ([`InboundEvent`], the sealed form of [`Credential`]) are tolerant on read: an
//! unknown field is ignored and a missing optional field reads as the default named on it.

mod credential;
mod crypto;
mod error;
mod event;
mod health;
mod oauth;
mod provider;
mod webhook;

pub use credential::Credential;
pub use error::{ConnectorError, redact_reason};
pub use event::{EventKind, InboundEvent, InboundEventId, dedupe_key};
pub use health::{ProbeResult, status_after_probe};
pub use oauth::{
    OAuthError, OAuthState, STATE_CLOCK_SKEW, STATE_TTL, pkce_challenge_s256, pkce_pair,
};
pub use provider::{Provider, UNSUPPORTED_CONNECTOR_KINDS, provider_for_kind};
pub use webhook::{
    META_SIGNATURE_HEADER, NetgsmPurpose, meta_signature_ok, netgsm_hook_token, netgsm_token_ok,
};

/// Stands in for a secret in `Debug` output.
pub(crate) struct Masked;

impl std::fmt::Debug for Masked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}
