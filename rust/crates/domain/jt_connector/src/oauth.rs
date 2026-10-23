//! The signed OAuth `state` and PKCE (RFC 7636, S256).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};

use crate::crypto::{ct_eq, from_hex, hmac_sha256, to_hex};
use crate::provider::Provider;

/// How long a state is accepted after it was issued (inclusive).
pub const STATE_TTL: Duration = Duration::minutes(10);

/// How far in the future an issue time may lie (clocks of two instances disagreeing) before the
/// state is refused.
pub const STATE_CLOCK_SKEW: Duration = Duration::minutes(1);

/// What an OAuth flow carries through the provider and back: who started it, for which kind, and
/// when. Signed with a workspace key so the callback can trust it ([`OAuthState::sign`],
/// [`OAuthState::verify`]).
///
/// The payload is signed, not encrypted: anyone who sees the authorize URL or the callback URL
/// can read it, so it holds nothing secret. In particular it never holds a PKCE code verifier: a
/// verifier there would ride the browser redirect beside the authorization code and defeat PKCE.
/// The verifier ([`pkce_pair`]) stays server-side, sealed with the pending flow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthState {
    pub workspace_id: WorkspaceId,
    pub provider: Provider,
    /// The capability kind being connected, e.g. `"instagram"`.
    pub kind_key: String,
    #[serde(with = "time::serde::timestamp::nanoseconds")]
    pub issued_at: OffsetDateTime,
    /// Random bytes that make every state unique.
    #[serde(with = "crate::crypto::hex16")]
    pub nonce: [u8; 16],
}

/// Why a state token was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, thiserror::Error)]
pub enum OAuthError {
    /// Issued more than [`STATE_TTL`] ago, or more than [`STATE_CLOCK_SKEW`] in the future.
    #[error("the OAuth state has expired")]
    Expired,
    /// The signature does not match the payload under this key.
    #[error("the OAuth state's signature does not match")]
    BadSignature,
    /// Not a state token at all.
    #[error("the OAuth state is malformed")]
    Malformed,
}

impl OAuthState {
    /// The state as a token: `base64url(JSON payload)` (no padding), a `.`, and the 64 lowercase
    /// hex digits of HMAC-SHA256 over the JSON payload bytes under `key`. URL-safe as is.
    pub fn sign(&self, key: &[u8; 32]) -> String {
        // Every field serialises without fail: strings, an id, a timestamp as an integer and
        // the nonce as hex.
        let payload = serde_json::to_vec(self).expect("an OAuth state always serialises");
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            to_hex(&hmac_sha256(key, &payload))
        )
    }

    /// The state in `token`, once its signature matches under `key` (compared in constant time)
    /// and it is no older than [`STATE_TTL`] at `now`. Nothing in the payload is read before the
    /// signature is checked. Refuses with `Malformed` (not `payload.signature`, payload not
    /// base64url, signature not 64 lowercase hex digits, or a signed payload that is not a
    /// state), `BadSignature`, or `Expired`, in that order.
    pub fn verify(
        token: &str,
        key: &[u8; 32],
        now: OffsetDateTime,
    ) -> Result<OAuthState, OAuthError> {
        let (encoded, signature) = token.split_once('.').ok_or(OAuthError::Malformed)?;
        if encoded.is_empty() {
            return Err(OAuthError::Malformed);
        }
        let payload = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| OAuthError::Malformed)?;
        let given = from_hex::<32>(signature).ok_or(OAuthError::Malformed)?;
        if !ct_eq(&hmac_sha256(key, &payload), &given) {
            return Err(OAuthError::BadSignature);
        }
        let state: OAuthState =
            serde_json::from_slice(&payload).map_err(|_| OAuthError::Malformed)?;
        if now - state.issued_at > STATE_TTL || state.issued_at - now > STATE_CLOCK_SKEW {
            return Err(OAuthError::Expired);
        }
        Ok(state)
    }
}

/// A PKCE pair from 48 random bytes: the code verifier (their unpadded base64url, 64 characters)
/// and its S256 challenge ([`pkce_challenge_s256`]).
pub fn pkce_pair(random: [u8; 48]) -> (String, String) {
    let verifier = URL_SAFE_NO_PAD.encode(random);
    let challenge = pkce_challenge_s256(&verifier);
    (verifier, challenge)
}

/// The S256 code challenge of a code verifier: unpadded base64url of SHA-256 over its ASCII bytes
/// (RFC 7636 §4.2).
pub fn pkce_challenge_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
