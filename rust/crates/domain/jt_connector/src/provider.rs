//! The providers the system connects to, and the capability kinds each one serves.

use serde::{Deserialize, Serialize};

/// A provider with an adapter inside the system (spec §13 M1: Meta, NetGSM, X; then mail,
/// TikTok and LinkedIn; then the marketplaces, spec 2026-10-30-inbox-comments-marketplace-design
/// §5.3, each its own egress scope; then Google, for its ad accounts, design
/// 2026-11-11-reklam-platformlari-design).
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
    /// Posts on a TikTok account (Login Kit and the Content Posting API).
    Tiktok,
    /// Posts on a LinkedIn member's own feed and on the organization pages they administer.
    Linkedin,
    /// Customer questions on a Trendyol seller's products.
    Trendyol,
    /// Customer questions on a Hepsiburada merchant's products.
    Hepsiburada,
    /// Ad campaigns in a Google Ads account.
    Google,
}

const ALL: &[Provider] = &[
    Provider::Meta,
    Provider::Netgsm,
    Provider::X,
    Provider::Mail,
    Provider::Tiktok,
    Provider::Linkedin,
    Provider::Trendyol,
    Provider::Hepsiburada,
    Provider::Google,
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

/// The capability kinds TikTok serves: an account that posts, and an ad account.
const TIKTOK_KINDS: &[&str] = &["tiktok", "tiktok_ads"];

/// The capability kinds LinkedIn serves: a member's own feed, an organization page, and an ad
/// account.
const LINKEDIN_KINDS: &[&str] = &["linkedin_member", "linkedin_page", "linkedin_ads"];

/// The connector kinds of the closed list ([`jt_capability::KINDS`] whose reach is
/// [`jt_capability::Reach::Connector`]) that no provider serves yet. Every connector kind is
/// either served by exactly one [`Provider`] or listed here, so a new connector kind cannot be
/// forgotten: the crate's tests fail until it is placed.
pub const UNSUPPORTED_CONNECTOR_KINDS: &[&str] = &[
    "pinterest",
    "youtube",
    "google_business",
    "webchat",
    "discord",
    "reddit",
    "review_google",
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
            Provider::Tiktok => "tiktok",
            Provider::Linkedin => "linkedin",
            Provider::Trendyol => "trendyol",
            Provider::Hepsiburada => "hepsiburada",
            Provider::Google => "google",
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
            Provider::Tiktok => TIKTOK_KINDS,
            Provider::Linkedin => LINKEDIN_KINDS,
            Provider::Trendyol => &["trendyol"],
            Provider::Hepsiburada => &["hepsiburada"],
            Provider::Google => &["google_ads"],
        }
    }
}

/// The provider that serves the capability kind `kind_key` (exact, case-sensitive); `None` for a
/// kind no provider serves (one of [`UNSUPPORTED_CONNECTOR_KINDS`], a device, agent or
/// third-party kind) and for a key off the closed list.
pub fn provider_for_kind(kind_key: &str) -> Option<Provider> {
    ALL.iter().copied().find(|p| p.kinds().contains(&kind_key))
}
