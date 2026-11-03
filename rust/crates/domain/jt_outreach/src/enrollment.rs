//! Enrollments (spec §3.10, §3.11, D16): their states, why one stopped or was skipped (stable
//! keys, as stored and reported), when the next step is due, what became of a send, and the
//! bounds of the per-recipient personalization an agent writes.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use time::{Duration, OffsetDateTime};

use crate::template::custom_key_ok;
use crate::{CampaignError, Step, chars};

/// The most personalization keys of one enrollment.
pub const MAX_PERSONALIZATION_KEYS: usize = 20;
/// The longest personalization value, in characters.
pub const MAX_PERSONALIZATION_VALUE_CHARS: usize = 500;

/// Where an enrollment stands; at most one `active` enrollment per person in a workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnrollmentStatus {
    Active,
    /// Every step was sent.
    Completed,
    /// A stop rule held ([`StopReason`]).
    Stopped,
    /// Never sent: refused at enrollment ([`SkipReason`]).
    Skipped,
}

impl EnrollmentStatus {
    /// Every status.
    pub const ALL: &[EnrollmentStatus] = &[
        EnrollmentStatus::Active,
        EnrollmentStatus::Completed,
        EnrollmentStatus::Stopped,
        EnrollmentStatus::Skipped,
    ];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            EnrollmentStatus::Active => "active",
            EnrollmentStatus::Completed => "completed",
            EnrollmentStatus::Stopped => "stopped",
            EnrollmentStatus::Skipped => "skipped",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<EnrollmentStatus> {
        EnrollmentStatus::ALL
            .iter()
            .copied()
            .find(|s| s.key() == key)
    }
}

/// Why an active enrollment stopped. Stored and serialised as its key ([`StopReason::key`]):
/// `replied`, …, `refused:<fence reason>`, `missing_variable:<variable key>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum StopReason {
    Replied,
    Bounced,
    Complained,
    Unsubscribed,
    ConsentWithdrawn,
    MeetingBooked,
    JourneyWon,
    JourneyLost,
    PersonErased,
    PersonMerged,
    HumanHoldsConversation,
    DoNotContact,
    CampaignCanceled,
    Manual,
    /// A fence refused the send at enqueue or claim; the fence's reason key.
    Refused(String),
    /// A variable without value or fallback; its key.
    MissingVariable(String),
}

const FIXED_STOPS: &[(&str, StopReason)] = &[
    ("replied", StopReason::Replied),
    ("bounced", StopReason::Bounced),
    ("complained", StopReason::Complained),
    ("unsubscribed", StopReason::Unsubscribed),
    ("consent_withdrawn", StopReason::ConsentWithdrawn),
    ("meeting_booked", StopReason::MeetingBooked),
    ("journey_won", StopReason::JourneyWon),
    ("journey_lost", StopReason::JourneyLost),
    ("person_erased", StopReason::PersonErased),
    ("person_merged", StopReason::PersonMerged),
    (
        "human_holds_conversation",
        StopReason::HumanHoldsConversation,
    ),
    ("do_not_contact", StopReason::DoNotContact),
    ("campaign_canceled", StopReason::CampaignCanceled),
    ("manual", StopReason::Manual),
];

/// A detail after `refused:` or `missing_variable:`: 1 to 64 visible ASCII characters (a key).
fn detail_ok(detail: &str) -> bool {
    (1..=64).contains(&detail.len()) && detail.bytes().all(|b| b.is_ascii_graphic())
}

impl StopReason {
    /// The stable key.
    pub fn key(&self) -> String {
        match self {
            StopReason::Refused(reason) => format!("refused:{reason}"),
            StopReason::MissingVariable(name) => format!("missing_variable:{name}"),
            fixed => FIXED_STOPS
                .iter()
                .find(|(_, r)| r == fixed)
                .map(|(k, _)| (*k).to_owned())
                .expect("every fixed stop reason has a key"),
        }
    }

    /// The reason with this key, if any.
    pub fn parse(key: &str) -> Option<StopReason> {
        if let Some((_, r)) = FIXED_STOPS.iter().find(|(k, _)| *k == key) {
            return Some(r.clone());
        }
        if let Some(reason) = key.strip_prefix("refused:") {
            return detail_ok(reason).then(|| StopReason::Refused(reason.to_owned()));
        }
        let name = key.strip_prefix("missing_variable:")?;
        detail_ok(name).then(|| StopReason::MissingVariable(name.to_owned()))
    }
}

impl Serialize for StopReason {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.key())
    }
}

impl<'de> Deserialize<'de> for StopReason {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<StopReason, D::Error> {
        let key = String::deserialize(d)?;
        StopReason::parse(&key).ok_or_else(|| D::Error::custom("unknown stop reason"))
    }
}

/// Why a person was not enrolled; the audience preview counts these.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    NoDeliverableEmail,
    Suppressed,
    /// Neither an effective consent nor the business-recipient basis (D17).
    NoBasis,
    DoNotContact,
    /// The person is active in another campaign.
    ActiveElsewhere,
    /// Erased or merged.
    PersonGone,
    JourneyClosed,
    /// A prospect left for the next refresh: the day's promotions are used up.
    PromotionCap,
}

impl SkipReason {
    /// Every reason.
    pub const ALL: &[SkipReason] = &[
        SkipReason::NoDeliverableEmail,
        SkipReason::Suppressed,
        SkipReason::NoBasis,
        SkipReason::DoNotContact,
        SkipReason::ActiveElsewhere,
        SkipReason::PersonGone,
        SkipReason::JourneyClosed,
        SkipReason::PromotionCap,
    ];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            SkipReason::NoDeliverableEmail => "no_deliverable_email",
            SkipReason::Suppressed => "suppressed",
            SkipReason::NoBasis => "no_basis",
            SkipReason::DoNotContact => "do_not_contact",
            SkipReason::ActiveElsewhere => "active_elsewhere",
            SkipReason::PersonGone => "person_gone",
            SkipReason::JourneyClosed => "journey_closed",
            SkipReason::PromotionCap => "promotion_cap",
        }
    }

    /// The reason with this key, if any.
    pub fn parse(key: &str) -> Option<SkipReason> {
        SkipReason::ALL.iter().copied().find(|r| r.key() == key)
    }
}

/// What became of one outreach send, as the outbox and the mail evidence record it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendOutcome {
    Queued,
    Sent,
    Failed,
    /// The provider may or may not have sent it (never retried blindly).
    Unknown,
    /// A fence refused it at claim.
    Refused,
    Bounced,
    Complained,
}

impl SendOutcome {
    /// Every outcome.
    pub const ALL: &[SendOutcome] = &[
        SendOutcome::Queued,
        SendOutcome::Sent,
        SendOutcome::Failed,
        SendOutcome::Unknown,
        SendOutcome::Refused,
        SendOutcome::Bounced,
        SendOutcome::Complained,
    ];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            SendOutcome::Queued => "queued",
            SendOutcome::Sent => "sent",
            SendOutcome::Failed => "failed",
            SendOutcome::Unknown => "unknown",
            SendOutcome::Refused => "refused",
            SendOutcome::Bounced => "bounced",
            SendOutcome::Complained => "complained",
        }
    }

    /// The outcome with this key, if any.
    pub fn parse(key: &str) -> Option<SendOutcome> {
        SendOutcome::ALL.iter().copied().find(|o| o.key() == key)
    }

    /// Whether an outcome may follow this one: a queued send is sent, failed, unknown or
    /// refused; an unknown one is settled by later evidence (sent, failed, bounced,
    /// complained); a sent one can still bounce or draw a complaint. Nothing else moves.
    pub fn can_become(self, next: SendOutcome) -> bool {
        use SendOutcome::*;
        matches!(
            (self, next),
            (Queued, Sent | Failed | Unknown | Refused)
                | (Unknown, Sent | Failed | Bounced | Complained)
                | (Sent, Bounced | Complained)
        )
    }

    /// Whether the email (may have) reached the provider: what the auto-pause rates count.
    pub fn left_the_mailbox(self) -> bool {
        matches!(
            self,
            SendOutcome::Sent
                | SendOutcome::Unknown
                | SendOutcome::Bounced
                | SendOutcome::Complained
        )
    }
}

/// After step `sent` (1-based) went out at `sent_at`: the next step's number and when it is
/// due (its `delay_days` later), or `None` when `sent` was the last.
pub fn next_step_after(
    steps: &[Step],
    sent: u8,
    sent_at: OffsetDateTime,
) -> Option<(u8, OffsetDateTime)> {
    let next = steps.get(usize::from(sent))?;
    Some((
        sent + 1,
        sent_at + Duration::days(i64::from(next.delay_days)),
    ))
}

/// The per-recipient values an agent writes (spec §3.10): at most
/// [`MAX_PERSONALIZATION_KEYS`] `custom.*` keys (`[a-z0-9_]{1,32}`, without the `custom.`
/// prefix), each value 1 to [`MAX_PERSONALIZATION_VALUE_CHARS`] characters without control
/// characters other than line breaks. Whether the campaign uses a key is the application's.
pub fn validate_personalization(values: &BTreeMap<String, String>) -> Result<(), CampaignError> {
    let invalid = |reason| CampaignError::Invalid {
        field: "personalization",
        reason,
    };
    if values.len() > MAX_PERSONALIZATION_KEYS {
        return Err(invalid("too_many"));
    }
    for (key, value) in values {
        if !custom_key_ok(key) {
            return Err(invalid("custom_key"));
        }
        if value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r'))
        {
            return Err(invalid("control_character"));
        }
        if value.trim().is_empty() || chars(value) > MAX_PERSONALIZATION_VALUE_CHARS {
            return Err(invalid("length"));
        }
    }
    Ok(())
}
