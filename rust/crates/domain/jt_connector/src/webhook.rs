//! Webhook authentication: Meta's body signature and NetGSM's path tokens. Both are checked
//! before the body is parsed.

use jt_tenancy::WorkspaceId;

use crate::crypto::{ct_eq, from_hex, hmac_sha256, to_hex};

/// The header Meta signs webhook bodies in.
pub const META_SIGNATURE_HEADER: &str = "X-Hub-Signature-256";

/// Whether `header` (the value of [`META_SIGNATURE_HEADER`]) is `sha256=` followed by the 64
/// lowercase hex digits of HMAC-SHA256 over the raw body `raw` under the app secret. Compared in
/// constant time. A malformed header, and an empty (unset) app secret, verify nothing.
pub fn meta_signature_ok(app_secret: &[u8], raw: &[u8], header: &str) -> bool {
    if app_secret.is_empty() {
        return false;
    }
    let Some(given) = header.strip_prefix("sha256=").and_then(from_hex::<32>) else {
        return false;
    };
    ct_eq(&hmac_sha256(app_secret, raw), &given)
}

/// Whether `given`, the `hub.verify_token` of Meta's webhook verification request, is the
/// platform's verify token `expected`, compared in constant time. An unset (empty) `expected`
/// matches nothing.
pub fn meta_verify_token_ok(expected: &str, given: &str) -> bool {
    !expected.is_empty() && ct_eq(expected.as_bytes(), given.as_bytes())
}

/// What a NetGSM callback URL is for. NetGSM signs nothing, so each URL carries a token of its
/// own ([`netgsm_hook_token`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NetgsmPurpose {
    /// Incoming SMS (mobile originated).
    Mo,
    /// Netsantral call events.
    Events,
    /// İYS consent changes.
    Iys,
    /// Voice message reports.
    VoiceReport,
    /// Auto-call reports.
    AutocallReport,
}

const ALL_PURPOSES: &[NetgsmPurpose] = &[
    NetgsmPurpose::Mo,
    NetgsmPurpose::Events,
    NetgsmPurpose::Iys,
    NetgsmPurpose::VoiceReport,
    NetgsmPurpose::AutocallReport,
];

impl NetgsmPurpose {
    /// The stable key, e.g. `"voice-report"`: the last segment of the callback URL
    /// (`mo`, `events`, `iys`, `voice-report`, `autocall-report`) and the `<purpose>` of the
    /// token's HMAC input ([`netgsm_hook_token`]).
    pub fn key(&self) -> &'static str {
        match self {
            NetgsmPurpose::Mo => "mo",
            NetgsmPurpose::Events => "events",
            NetgsmPurpose::Iys => "iys",
            NetgsmPurpose::VoiceReport => "voice-report",
            NetgsmPurpose::AutocallReport => "autocall-report",
        }
    }

    /// The purpose with this key (exact, case-sensitive), if any.
    pub fn parse(key: &str) -> Option<NetgsmPurpose> {
        ALL_PURPOSES.iter().copied().find(|p| p.key() == key)
    }

    /// Every purpose, in a stable order.
    pub fn all() -> &'static [NetgsmPurpose] {
        ALL_PURPOSES
    }
}

/// The token in the URL of a workspace's NetGSM callback for `purpose`: the 64 lowercase hex
/// digits of HMAC-SHA256 under the workspace's hook key `seal_key` over
/// `"netgsm-hook:<workspace uuid>:<purpose>"` (the uuid hyphenated, lowercase), `purpose` being a
/// [`NetgsmPurpose::key`]. Deterministic, so it is computed again to check a request, never
/// stored.
pub fn netgsm_hook_token(seal_key: &[u8; 32], workspace: WorkspaceId, purpose: &str) -> String {
    let message = format!("netgsm-hook:{workspace}:{purpose}");
    to_hex(&hmac_sha256(seal_key, message.as_bytes()))
}

/// Whether the token `given` in a request equals `expected` exactly, compared in constant time.
/// An empty `expected` matches nothing.
pub fn netgsm_token_ok(expected: &str, given: &str) -> bool {
    !expected.is_empty() && ct_eq(expected.as_bytes(), given.as_bytes())
}
