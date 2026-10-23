//! Stable erasure keys; callers retain tenant scope in persistence.

use sha2::{Digest, Sha256};

use crate::IdentityChannel;

/// SHA-256 hex of `identity_namespace + NUL + normalized_identity`.
///
/// Opaque identities MUST already include the canonical provider account via `scope_opaque`,
/// exactly as they do for matching/storage. Phones/emails remain shared across accounts.
/// This is a replay-prevention key, not an anonymization guarantee for low-entropy identities.
pub fn identity_hash(channel: IdentityChannel, normalized: &str) -> String {
    let namespace = match channel {
        IdentityChannel::Phone => "phone",
        IdentityChannel::Email => "email",
        IdentityChannel::InstagramDm => "instagram_dm",
        IdentityChannel::Messenger => "messenger",
        IdentityChannel::Webchat => "webchat",
    };
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0]);
    hash.update(normalized.as_bytes());
    let mut encoded = String::with_capacity(64);
    for byte in hash.finalize() {
        use std::fmt::Write;
        write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}
