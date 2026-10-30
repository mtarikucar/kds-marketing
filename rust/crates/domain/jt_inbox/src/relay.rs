//! Marketplace mail relays: buyer messages a marketplace forwards to the seller's mailbox from a
//! relay address (spec 2026-10-30-inbox-comments-marketplace-design.md §8.4). Derived, not
//! stored: a conversation is a relay conversation when its bound inbound email identity is a
//! relay address. Pure, no I/O.

use serde::{Deserialize, Serialize};
use time::Duration;

use crate::public::{has_email, has_link};

/// A marketplace whose buyer messages reach the seller's mailbox through a relay address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relay {
    /// Amazon.com.tr's buyer-seller messaging.
    AmazonTr,
}

/// The domain Amazon.com.tr relays buyer messages from. VERIFY V-A1 (spec §12): confirmed from a
/// real relay mail before task A1 merges.
pub const AMAZON_TR_RELAY_DOMAIN: &str = "marketplace.amazon.com.tr";

/// How long the seller has to answer a relayed buyer message, from its receipt. VERIFY V-A3
/// (spec §12), with Amazon's current buyer-seller messaging rules.
pub const RELAY_DEADLINE: Duration = Duration::hours(24);

/// The suffix Amazon puts after a buyer's name in a relay mail's `From`. VERIFY V-A2 (spec §12).
const AMAZON_DISPLAY_SUFFIX: &str = " - Amazon Marketplace";

/// The relay `email_normalized` (a normalised address: trimmed, lower case) sends from: one
/// whose domain is exactly [`AMAZON_TR_RELAY_DOMAIN`] (no subdomain, nothing after it).
pub fn marketplace_relay(email_normalized: &str) -> Option<Relay> {
    let (local, domain) = email_normalized.split_once('@')?;
    (!local.is_empty() && !local.contains('@') && domain == AMAZON_TR_RELAY_DOMAIN)
        .then_some(Relay::AmazonTr)
}

/// The first Amazon order id in `text` (a subject or a body): three, seven and seven digits
/// joined by dashes (`405-1234567-1234567`), with no digit right before or after it.
pub fn amazon_order_id(text: &str) -> Option<String> {
    const SHAPE: [usize; 3] = [3, 7, 7];
    const LEN: usize = 3 + 1 + 7 + 1 + 7;
    let bytes = text.as_bytes();
    let matches_at = |start: usize| {
        let mut i = start;
        for (group, len) in SHAPE.iter().enumerate() {
            if group > 0 {
                if bytes.get(i) != Some(&b'-') {
                    return false;
                }
                i += 1;
            }
            for _ in 0..*len {
                if !bytes.get(i).is_some_and(u8::is_ascii_digit) {
                    return false;
                }
                i += 1;
            }
        }
        !bytes.get(i).is_some_and(u8::is_ascii_digit)
    };
    (0..bytes.len().saturating_sub(LEN - 1))
        .filter(|&start| start == 0 || !bytes[start - 1].is_ascii_digit())
        .find(|&start| matches_at(start))
        .map(|start| text[start..start + LEN].to_owned())
}

/// A relay mail's `From` display name without Amazon's " - Amazon Marketplace" suffix, trimmed.
pub fn relay_display_name(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_suffix(AMAZON_DISPLAY_SUFFIX)
        .or_else(|| (trimmed == AMAZON_DISPLAY_SUFFIX.trim_start()).then_some(""))
        .unwrap_or(trimmed)
        .trim()
        .to_owned()
}

/// Stable reasons a reply on a relay conversation is refused. `Display` and serde give the
/// `snake_case` key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum RelayRefusal {
    /// Commercial intent on a relay conversation.
    #[error("commercial_on_relay")]
    CommercialOnRelay,
    /// The reply holds a link or an email address. VERIFY V-A3 (spec §12).
    #[error("link_in_relay_reply")]
    LinkInRelayReply,
}

/// Whether `text` may answer a relayed buyer message: never with commercial intent, never with
/// a link (`http://`, `https://`, `www.`) or an email address.
pub fn relay_reply_allowed(text: &str, commercial: bool) -> Result<(), RelayRefusal> {
    if commercial {
        return Err(RelayRefusal::CommercialOnRelay);
    }
    if has_link(text) || has_email(text) {
        return Err(RelayRefusal::LinkInRelayReply);
    }
    Ok(())
}
