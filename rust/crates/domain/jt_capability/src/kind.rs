//! The closed list of capability kinds (spec §6.2), their groups and how each is reached.

use serde::{Deserialize, Serialize};
use time::Duration;

/// How the system reaches a capability (spec §6.1 "ulaşım yolu").
///
/// A missing reach reads as `Connector`: the one an agent cannot mark verified by its own claim.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Reach {
    /// An adapter inside the system, its credentials sealed; verified by the system's own probe.
    #[default]
    Connector,
    /// A tool or access the agent declares and the system never touches; verified by the agent's
    /// evidence.
    Agent,
    /// A physical device the agent declares and proves with evidence.
    Device,
}

impl Reach {
    /// The stable key, e.g. `"connector"`.
    pub fn key(&self) -> &'static str {
        match self {
            Reach::Connector => "connector",
            Reach::Agent => "agent",
            Reach::Device => "device",
        }
    }

    /// The reach with this key, if any.
    pub fn parse(key: &str) -> Option<Reach> {
        match key {
            "connector" => Some(Reach::Connector),
            "agent" => Some(Reach::Agent),
            "device" => Some(Reach::Device),
            _ => None,
        }
    }
}

/// The group a kind belongs to (the rows of spec §6.2). Budget items and the team are not
/// capability kinds: budget items have their own type ([`crate::BudgetItem`]) and the team lives
/// in tenancy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KindGroup {
    SocialAccount,
    Messaging,
    Telephony,
    Community,
    Ads,
    Calendar,
    Device,
    AgentConnection,
    ComputerAccess,
    ThirdParty,
}

const ALL_GROUPS: &[KindGroup] = &[
    KindGroup::SocialAccount,
    KindGroup::Messaging,
    KindGroup::Telephony,
    KindGroup::Community,
    KindGroup::Ads,
    KindGroup::Calendar,
    KindGroup::Device,
    KindGroup::AgentConnection,
    KindGroup::ComputerAccess,
    KindGroup::ThirdParty,
];

impl KindGroup {
    /// The stable key, e.g. `"agent_connection"`.
    pub fn key(&self) -> &'static str {
        match self {
            KindGroup::SocialAccount => "social_account",
            KindGroup::Messaging => "messaging",
            KindGroup::Telephony => "telephony",
            KindGroup::Community => "community",
            KindGroup::Ads => "ads",
            KindGroup::Calendar => "calendar",
            KindGroup::Device => "device",
            KindGroup::AgentConnection => "agent_connection",
            KindGroup::ComputerAccess => "computer_access",
            KindGroup::ThirdParty => "third_party",
        }
    }

    /// The group with this key, if any.
    pub fn parse(key: &str) -> Option<KindGroup> {
        ALL_GROUPS.iter().copied().find(|g| g.key() == key)
    }

    /// Every group, in the order of [`KINDS`].
    pub fn all() -> &'static [KindGroup] {
        ALL_GROUPS
    }

    /// How a capability of this group is reached unless said otherwise: accounts (social,
    /// messaging, telephony, community, ads, calendar) through a connector, devices as devices,
    /// and agent connections, computer access and third-party tools through the agent.
    pub fn default_reach(&self) -> Reach {
        match self {
            KindGroup::SocialAccount
            | KindGroup::Messaging
            | KindGroup::Telephony
            | KindGroup::Community
            | KindGroup::Ads
            | KindGroup::Calendar => Reach::Connector,
            KindGroup::Device => Reach::Device,
            KindGroup::AgentConnection | KindGroup::ComputerAccess | KindGroup::ThirdParty => {
                Reach::Agent
            }
        }
    }
}

/// One kind of capability. Its `key` is unique across all groups and doubles as a strategy
/// channel name (`instagram`, `mailbox`, ...).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CapabilityKind {
    pub group: KindGroup,
    pub key: &'static str,
}

/// The kind whose external id drops [`META_AD_ACCOUNT_PREFIX`].
const META_ADS: &str = "meta_ads";

/// The prefix Graph puts on an ad account's number in its node id (`act_1234`).
pub const META_AD_ACCOUNT_PREFIX: &str = "act_";

/// The external id of a capability of kind `kind_key` in the one form it is stored and compared
/// in: a Meta ad account (`meta_ads`) is held by its number, which is how its probe names it, so
/// a leading `act_` (Graph's node id, `act_1234`) is dropped; every other kind keeps `id` as
/// given. Trims nothing and checks nothing: callers trim first and validate the result.
pub fn canonical_external_id(kind_key: &str, id: &str) -> String {
    match id.strip_prefix(META_AD_ACCOUNT_PREFIX) {
        Some(number) if kind_key == META_ADS => number.to_owned(),
        _ => id.to_owned(),
    }
}

/// The key of the third-party kind that stands for any other tool; it needs a `key_detail`.
const OTHER_THIRD_PARTY: &str = "other";

/// The key of the voice bridge: the sidecar that is the workspace's phone line for agent calls.
const VOICE_BRIDGE: &str = "voice_bridge";

/// How a kind proves it is alive by reporting itself on a schedule, instead of by a probe or the
/// agent's evidence: its verification goes stale once the last report is older than
/// `stale_after`, and its capability is marked unreachable once it is older than
/// `unreachable_after` (a scheduled job does that).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Heartbeat {
    pub stale_after: Duration,
    pub unreachable_after: Duration,
}

const fn k(group: KindGroup, key: &'static str) -> CapabilityKind {
    CapabilityKind { group, key }
}

/// The closed list of capability kinds (spec §6.2), grouped and in a stable order. A kind not on
/// it is refused; a stored capability whose kind left the list still reads (see
/// [`crate::Capability::kind`]).
pub const KINDS: &[CapabilityKind] = &[
    k(KindGroup::SocialAccount, "instagram"),
    k(KindGroup::SocialAccount, "facebook_page"),
    k(KindGroup::SocialAccount, "x"),
    k(KindGroup::SocialAccount, "linkedin_page"),
    // A LinkedIn member's own feed (personal posts), beside the organization pages.
    k(KindGroup::SocialAccount, "linkedin_member"),
    k(KindGroup::SocialAccount, "tiktok"),
    k(KindGroup::SocialAccount, "pinterest"),
    k(KindGroup::SocialAccount, "youtube"),
    k(KindGroup::SocialAccount, "google_business"),
    k(KindGroup::Messaging, "whatsapp_cloud"),
    k(KindGroup::Messaging, "instagram_dm"),
    k(KindGroup::Messaging, "messenger"),
    k(KindGroup::Messaging, "sms_line"),
    k(KindGroup::Messaging, "mailbox"),
    k(KindGroup::Messaging, "webchat"),
    k(KindGroup::Telephony, "netgsm_pbx"),
    // The voice bridge (spec 2026-10-27-agent-voice-calls-design.md §6): reached like a device,
    // verified by its own heartbeat ([`CapabilityKind::heartbeat`]).
    k(KindGroup::Telephony, VOICE_BRIDGE),
    k(KindGroup::Community, "discord"),
    k(KindGroup::Community, "reddit"),
    k(KindGroup::Community, "review_google"),
    k(KindGroup::Community, "review_facebook"),
    // A Meta ad account is held by its number; `act_<number>` (Graph's node id) is accepted and
    // stored without the prefix ([`canonical_external_id`]).
    k(KindGroup::Ads, "meta_ads"),
    k(KindGroup::Ads, "tiktok_ads"),
    k(KindGroup::Ads, "linkedin_ads"),
    k(KindGroup::Ads, "google_ads"),
    k(KindGroup::Calendar, "google_calendar"),
    k(KindGroup::Calendar, "outlook_calendar"),
    k(KindGroup::Device, "phone"),
    k(KindGroup::Device, "computer"),
    k(KindGroup::Device, "printer"),
    k(KindGroup::Device, "printer_3d"),
    k(KindGroup::Device, "audio_io"),
    k(KindGroup::Device, "camera"),
    k(KindGroup::Device, "screen"),
    k(KindGroup::Device, "scanner"),
    k(KindGroup::Device, "usb_storage"),
    k(KindGroup::AgentConnection, "claude_code"),
    k(KindGroup::AgentConnection, "codex"),
    k(KindGroup::AgentConnection, "claude_ai"),
    k(KindGroup::AgentConnection, "other_agent"),
    k(KindGroup::ComputerAccess, "filesystem_root"),
    k(KindGroup::ComputerAccess, "browser_profile"),
    k(KindGroup::ComputerAccess, "shell"),
    k(KindGroup::ComputerAccess, "adb"),
    k(KindGroup::ComputerAccess, "screen_control"),
    k(KindGroup::ThirdParty, "notion"),
    k(KindGroup::ThirdParty, "slack"),
    k(KindGroup::ThirdParty, "gmail"),
    k(KindGroup::ThirdParty, "apify"),
    k(KindGroup::ThirdParty, "firecrawl"),
    k(KindGroup::ThirdParty, OTHER_THIRD_PARTY),
];

impl CapabilityKind {
    /// The kind with this key (exact, case-sensitive), if it is on the list.
    pub fn parse(key: &str) -> Option<&'static CapabilityKind> {
        KINDS.iter().find(|k| k.key == key)
    }

    /// How a capability of this kind is reached: its group's [`KindGroup::default_reach`], except
    /// that a kind with a [`Heartbeat`] (the voice bridge) is reached like a device: no connector
    /// adapter holds its credentials, and only its own reports verify it.
    pub fn default_reach(&self) -> Reach {
        if self.heartbeat().is_some() {
            Reach::Device
        } else {
            self.group.default_reach()
        }
    }

    /// How a capability of this kind reports itself, when it does: only the voice bridge, which
    /// registers every 15 seconds, goes stale a minute after its last report and unreachable ten
    /// minutes after it.
    pub fn heartbeat(&self) -> Option<Heartbeat> {
        (self.key == VOICE_BRIDGE).then_some(Heartbeat {
            stale_after: Duration::seconds(60),
            unreachable_after: Duration::minutes(10),
        })
    }

    /// Whether a capability of this kind needs a `key_detail` naming the tool: only the
    /// third-party kind `other`.
    pub fn requires_key_detail(&self) -> bool {
        self.group == KindGroup::ThirdParty && self.key == OTHER_THIRD_PARTY
    }
}

/// The kinds of group `g`, in the order of [`KINDS`].
pub fn kinds_in_group(g: KindGroup) -> impl Iterator<Item = &'static CapabilityKind> {
    KINDS.iter().filter(move |k| k.group == g)
}
