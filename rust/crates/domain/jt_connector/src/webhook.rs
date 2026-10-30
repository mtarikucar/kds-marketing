//! Webhook authentication: Meta's and TikTok's body signatures and NetGSM's path tokens. Each is
//! checked before the body is parsed.

use jt_tenancy::WorkspaceId;
use time::{Duration, OffsetDateTime};

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

/// The header TikTok signs webhook bodies in (<https://developers.tiktok.com/doc/webhooks-verification>;
/// header names are case-insensitive, TikTok's own example writes `Tiktok-Signature`).
pub const TIKTOK_SIGNATURE_HEADER: &str = "TikTok-Signature";

/// How far from now a TikTok signature's timestamp may be, either way. The verification guide
/// names no window (a payload whose timestamp is too old "you can" reject); five minutes is the
/// example TikTok's in-app purchase webhook guide gives
/// (<https://developers.tiktok.com/docs/en/in-app-purchases>).
pub const TIKTOK_SIGNATURE_TOLERANCE: Duration = Duration::minutes(5);

/// The longest timestamp read from a TikTok signature header, in digits (Unix seconds: ten until
/// the year 2286).
const MAX_TIMESTAMP_DIGITS: usize = 12;

/// Whether `header` (the value of [`TIKTOK_SIGNATURE_HEADER`]) signs the raw body `raw` under the
/// client secret, as of `now`: the header is comma-separated `prefix=value` elements (spaces
/// around them ignored), exactly one `t` (Unix seconds, decimal digits only) and at least one `s`
/// (64 lowercase hex digits), and one of the `s` values is HMAC-SHA256 under the client secret
/// over `"{t}.{raw}"` (the timestamp as the header writes it, a dot, the body as received),
/// compared in constant time; and `t` is within `tolerance` of `now`, either way (an older
/// signature is a replay). Any other element is ignored. A malformed header, and an empty (unset)
/// client secret, verify nothing.
pub fn tiktok_signature_ok(
    client_secret: &[u8],
    raw: &[u8],
    header: &str,
    now: OffsetDateTime,
    tolerance: Duration,
) -> bool {
    if client_secret.is_empty() {
        return false;
    }
    let mut timestamp: Option<&str> = None;
    let mut signatures: Vec<[u8; 32]> = Vec::new();
    for element in header.split(',') {
        let Some((prefix, value)) = element.trim().split_once('=') else {
            return false;
        };
        match prefix {
            "t" if timestamp.is_none() => timestamp = Some(value),
            "t" => return false,
            "s" => match from_hex::<32>(value) {
                Some(signature) => signatures.push(signature),
                None => return false,
            },
            _ => {}
        }
    }
    let Some(timestamp) = timestamp.filter(|t| {
        (1..=MAX_TIMESTAMP_DIGITS).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit())
    }) else {
        return false;
    };
    if signatures.is_empty() {
        return false;
    }
    let Some(signed_at) = timestamp
        .parse::<i64>()
        .ok()
        .and_then(|t| OffsetDateTime::from_unix_timestamp(t).ok())
    else {
        return false;
    };
    let mut message = Vec::with_capacity(timestamp.len() + 1 + raw.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.push(b'.');
    message.extend_from_slice(raw);
    let expected = hmac_sha256(client_secret, &message);
    // Every signature compared, whichever matches: the time taken tells nothing.
    let signed = signatures
        .iter()
        .fold(false, |any, given| any | ct_eq(&expected, given));
    signed && (now - signed_at).abs() <= tolerance
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
