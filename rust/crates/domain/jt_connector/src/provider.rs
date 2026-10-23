//! The providers the system connects to, and the capability kinds each one serves.

use serde::{Deserialize, Serialize};

/// A provider with an adapter inside the system (spec §13 M1: Meta, NetGSM, X).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    /// Facebook Pages, Instagram, Messenger, WhatsApp Cloud, Meta Ads and lead-gen forms.
    Meta,
    /// SMS, the Netsantral PBX and İYS consent records.
    Netgsm,
    /// Posts on X.
    X,
    /// SMTP and IMAP mailbox.
    Mail,
}

const ALL: &[Provider] = &[
    Provider::Meta,
    Provider::Netgsm,
    Provider::X,
    Provider::Mail,
];

/// The capability kinds Meta serves.
const META_KINDS: &[&str] = &[
    "instagram",
    "facebook_page",
    "whatsapp_cloud",
    "instagram_dm",
    "messenger",
    "meta_ads",
    "review_facebook",
];

/// The capability kinds NetGSM serves.
const NETGSM_KINDS: &[&str] = &["sms_line", "netgsm_pbx"];

/// The capability kinds X serves.
const X_KINDS: &[&str] = &["x"];

/// The connector kinds of the closed list ([`jt_capability::KINDS`] whose reach is
/// [`jt_capability::Reach::Connector`]) that no provider serves yet. Every connector kind is
/// either served by exactly one [`Provider`] or listed here, so a new connector kind cannot be
/// forgotten: the crate's tests fail until it is placed.
pub const UNSUPPORTED_CONNECTOR_KINDS: &[&str] = &[
    "linkedin_page",
    "tiktok",
    "pinterest",
    "youtube",
    "google_business",
    "webchat",
    "discord",
    "reddit",
    "review_google",
    "tiktok_ads",
    "linkedin_ads",
    "google_ads",
    "google_calendar",
    "outlook_calendar",
];

impl Provider {
    /// The stable key, e.g. `"netgsm"`; also the egress scope name of its adapter.
    pub fn key(&self) -> &'static str {
        match self {
            Provider::Meta => "meta",
            Provider::Netgsm => "netgsm",
            Provider::X => "x",
            Provider::Mail => "mail",
        }
    }

    /// The provider with this key (exact, case-sensitive), if any.
    pub fn parse(key: &str) -> Option<Provider> {
        ALL.iter().copied().find(|p| p.key() == key)
    }

    /// Every provider, in a stable order.
    pub fn all() -> &'static [Provider] {
        ALL
    }

    /// The capability kinds this provider serves, by [`jt_capability::CapabilityKind::key`].
    pub fn kinds(&self) -> &'static [&'static str] {
        match self {
            Provider::Meta => META_KINDS,
            Provider::Netgsm => NETGSM_KINDS,
            Provider::X => X_KINDS,
            Provider::Mail => &["mailbox"],
        }
    }
}

/// The provider that serves the capability kind `kind_key` (exact, case-sensitive); `None` for a
/// kind no provider serves (one of [`UNSUPPORTED_CONNECTOR_KINDS`], a device, agent or
/// third-party kind) and for a key off the closed list.
pub fn provider_for_kind(kind_key: &str) -> Option<Provider> {
    ALL.iter().copied().find(|p| p.kinds().contains(&kind_key))
}
