//! Connector domain (spec §4.2 rule 1, §4.4, §6.1, §6.4, §11): which provider serves which
//! capability kind, the one error taxonomy every provider adapter returns, the shapes of sealed
//! credentials, the signed OAuth state and PKCE, the webhook signature math, inbound events, and
//! how a probe result moves a capability's stored status. Pure, no I/O.
//!
//! Secrets: a [`Credential`] serialises in full only so it can be sealed; its `Debug` masks every
//! secret, and [`Credential::redact_for_public`] gives the facts that may be stored in
//! `connector_public` and shown. Every `reason` of a [`ConnectorError`] has been through
//! [`redact_reason`]: outside this crate the variants that carry one can only be built by the
//! redacting constructors. The signed OAuth state holds nothing secret (no PKCE verifier).
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
mod redact;
mod webhook;

pub use credential::{Credential, MailTls};
pub use error::ConnectorError;
pub use event::{EventKind, InboundEvent, InboundEventId, dedupe_key};
pub use health::{ProbeResult, status_after_probe};
pub use oauth::{
    OAuthError, OAuthState, STATE_CLOCK_SKEW, STATE_TTL, pkce_challenge_s256, pkce_pair,
};
pub use provider::{Provider, UNSUPPORTED_CONNECTOR_KINDS, provider_for_kind};
pub use redact::redact_reason;
pub use webhook::{
    META_SIGNATURE_HEADER, NetgsmPurpose, meta_signature_ok, meta_verify_token_ok,
    netgsm_hook_token, netgsm_token_ok,
};

/// Stands in for a secret in `Debug` output.
pub(crate) struct Masked;

impl std::fmt::Debug for Masked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

/// Supported advertising account currencies; unknown units fail closed before a write.
pub fn currency_minor_exponent(currency: &str) -> Option<u8> {
    match currency {
        "JPY" | "KRW" | "VND" | "CLP" | "PYG" => Some(0),
        "TRY" | "EUR" | "USD" | "GBP" | "CAD" | "AUD" | "CHF" => Some(2),
        _ => None,
    }
}
