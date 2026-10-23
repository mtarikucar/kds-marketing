//! Contact channels and normalisation of identity keys.

use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{IdentityId, PersonId, epoch};

/// The channel through which a person contacts the workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    /// WhatsApp messages, matched by phone number.
    WhatsApp,
    /// Instagram direct messages, matched within the provider account.
    InstagramDm,
    /// Messenger messages, matched within the provider account.
    Messenger,
    /// SMS messages, matched by phone number.
    Sms,
    /// Email messages, matched by email address.
    Email,
    /// Web chat, matched within the provider account.
    Webchat,
    /// Telephone calls, matched by phone number.
    Phone,
}

impl Channel {
    /// The identity key shared by contacts on this channel.
    pub const fn identity_channel(self) -> IdentityChannel {
        match self {
            Self::WhatsApp | Self::Sms | Self::Phone => IdentityChannel::Phone,
            Self::Email => IdentityChannel::Email,
            Self::InstagramDm => IdentityChannel::InstagramDm,
            Self::Messenger => IdentityChannel::Messenger,
            Self::Webchat => IdentityChannel::Webchat,
        }
    }
}

/// The namespace of an identity key; phone contacts share one namespace across channels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityChannel {
    /// A normalised E.164 phone number.
    Phone,
    /// A trimmed, lower-case email address.
    Email,
    /// An account-scoped Instagram id.
    InstagramDm,
    /// An account-scoped Messenger id.
    Messenger,
    /// An account-scoped web chat id.
    Webchat,
}

/// The contact channel of a messaging or telephone capability; `None` for other kinds.
pub fn channel_for_kind(kind_key: &str) -> Option<Channel> {
    match kind_key {
        "whatsapp_cloud" => Some(Channel::WhatsApp),
        "instagram_dm" => Some(Channel::InstagramDm),
        "messenger" => Some(Channel::Messenger),
        "sms_line" => Some(Channel::Sms),
        "mailbox" => Some(Channel::Email),
        "webchat" => Some(Channel::Webchat),
        "netgsm_pbx" => Some(Channel::Phone),
        _ => None,
    }
}

/// A rejected identity value. Errors never include the personal value itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum IdentityError {
    /// The value is empty or malformed for its identity channel.
    #[error("invalid identity")]
    Invalid,
}

/// Normalise a contact identity without I/O.
///
/// Phones discard non-ASCII-digits, preserving a leading `+`. Turkish local `0XXXXXXXXXX`
/// becomes `+90XXXXXXXXXX`; other numbers gain a `+` and must contain 8–15 digits.
/// Emails are trimmed, lower-cased, and require exactly one `@` with nonempty sides and no
/// whitespace or control characters. Opaque ids are only trimmed and checked for emptiness.
/// The application layer must apply [`scope_opaque`] to opaque ids before storage, matching,
/// uniqueness checks or tombstoning; this function does not know the provider account.
pub fn normalise(channel: IdentityChannel, raw: &str) -> Result<String, IdentityError> {
    let raw = raw.trim();
    match channel {
        IdentityChannel::Phone => {
            let mut digits: String = raw.chars().filter(char::is_ascii_digit).collect();
            if !raw.starts_with('+') && digits.len() == 11 && digits.starts_with('0') {
                digits = format!("90{}", &digits[1..]);
            }
            if !(8..=15).contains(&digits.len()) {
                return Err(IdentityError::Invalid);
            }
            Ok(format!("+{digits}"))
        }
        IdentityChannel::Email => {
            let Some((local, domain)) = raw.split_once('@') else {
                return Err(IdentityError::Invalid);
            };
            if local.is_empty()
                || domain.is_empty()
                || domain.contains('@')
                || raw.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                return Err(IdentityError::Invalid);
            }
            Ok(raw.to_lowercase())
        }
        IdentityChannel::InstagramDm | IdentityChannel::Messenger | IdentityChannel::Webchat => {
            if raw.is_empty() {
                Err(IdentityError::Invalid)
            } else {
                Ok(raw.to_owned())
            }
        }
    }
}

/// Scope a normalised opaque id to a capability's canonical provider account external id.
///
/// Call after [`normalise`] for Instagram, Messenger and web chat, before storing or matching.
/// Both arguments must already be validated; this preserves their case and content exactly.
/// Phone numbers and email addresses are shared identities and must not be scoped this way.
pub fn scope_opaque(external_id: &str, raw: &str) -> String {
    format!("{external_id}:{raw}")
}

/// A person's contact identity. Only active identities participate in matching and uniqueness.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    /// The identity record's id.
    pub id: IdentityId,
    /// The tenant that owns the identity.
    pub workspace_id: WorkspaceId,
    /// The person this identity belongs to.
    pub person_id: PersonId,
    /// The namespace used when matching the value.
    pub channel: IdentityChannel,
    /// The normalised key, including account scope for opaque channels.
    pub value_normalized: String,
    /// The original human-facing value; missing reads as empty.
    #[serde(default)]
    pub value_display: String,
    /// Whether matching may use this identity; missing reads as true.
    #[serde(default = "active_default")]
    pub active: bool,
    /// When first observed; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub first_seen_at: OffsetDateTime,
}

fn active_default() -> bool {
    true
}
