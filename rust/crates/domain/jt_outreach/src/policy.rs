//! The workspace's outreach policy (spec §6.1, the `outreach` part of the leads policy): stored
//! as JSON and read key by key, so a missing key reads as its default. The defaults keep cold
//! email locked: no business-recipient basis (D17), approval off (owner rule 3), İYS lookup on,
//! click tracking off (D20).

use jt_inbox::Channel;
use jt_tenancy::UserId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{Frequency, WarmupPolicy, line};

/// The channels the business-recipient basis may ever cover: every messaging channel (owner
/// decision 2026-11-10, spec 2026-11-10-prospects-pool-redesign-design.md; email only before).
/// Each workspace's owner still opens them one by one with the counsel's confirmation. A voice
/// call and web chat are not contacts a workspace starts on this basis.
pub const B2B_BASIS_CHANNELS: &[Channel] = &[
    Channel::Email,
    Channel::Sms,
    Channel::WhatsApp,
    Channel::InstagramDm,
    Channel::Messenger,
];

/// The longest sender company name, in characters.
pub const MAX_SENDER_COMPANY_CHARS: usize = 200;
/// The longest sender address, in characters.
pub const MAX_SENDER_ADDRESS_CHARS: usize = 300;

/// A human owner's record that the workspace's counsel confirmed the business-recipient basis
/// (or turning the İYS lookup off): without it neither counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegalAck {
    pub counsel_confirmed: bool,
    pub note: String,
    /// The owner who recorded it.
    pub by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// The outreach part of the leads policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct OutreachPolicy {
    /// Every campaign launch waits for a human's approval of its revision.
    pub requires_approval: bool,
    /// The channels on which a `business` recipient without consent may get outreach. Empty by
    /// default; read through [`OutreachPolicy::b2b_channels`].
    pub b2b_basis: Vec<Channel>,
    /// Look a business address up in İYS before its first business-basis send.
    pub require_iys_lookup: bool,
    pub legal_ack: Option<LegalAck>,
    pub sender_company: String,
    pub sender_address: String,
    pub privacy_notice_url: String,
    pub warmup: WarmupPolicy,
    pub frequency: Frequency,
    /// Whether a new campaign tracks clicks unless it says otherwise.
    pub click_tracking_default: bool,
}

impl Default for OutreachPolicy {
    fn default() -> Self {
        OutreachPolicy {
            requires_approval: false,
            b2b_basis: Vec::new(),
            require_iys_lookup: true,
            legal_ack: None,
            sender_company: String::new(),
            sender_address: String::new(),
            privacy_notice_url: String::new(),
            warmup: WarmupPolicy::default(),
            frequency: Frequency::default(),
            click_tracking_default: false,
        }
    }
}

impl OutreachPolicy {
    /// The channels the business-recipient basis covers now: none unless a [`LegalAck`] with
    /// `counsel_confirmed` is recorded, and then only those of `b2b_basis` that are in
    /// [`B2B_BASIS_CHANNELS`]. A stored policy naming another channel never widens it.
    pub fn b2b_channels(&self) -> Vec<Channel> {
        if !self.legal_ack.as_ref().is_some_and(|a| a.counsel_confirmed) {
            return Vec::new();
        }
        let mut out: Vec<Channel> = Vec::new();
        for c in &self.b2b_basis {
            if B2B_BASIS_CHANNELS.contains(c) && !out.contains(c) {
                out.push(*c);
            }
        }
        out
    }

    /// Whether the footer's sender identity is configured (F10): a company and an address on
    /// one line each, and the privacy notice as an `http(s)` link.
    pub fn sender_identity_complete(&self) -> bool {
        let privacy = self.privacy_notice_url.trim();
        line(&self.sender_company, 1, MAX_SENDER_COMPANY_CHARS).is_ok()
            && line(&self.sender_address, 1, MAX_SENDER_ADDRESS_CHARS).is_ok()
            && !privacy.chars().any(char::is_control)
            && url::Url::parse(privacy).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.host_str().is_some_and(|h| !h.is_empty())
            })
    }
}
