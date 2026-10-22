//! Normalised email addresses.

use serde::{Deserialize, Serialize};

/// Maximum length of an email address, in characters.
const MAX_LEN: usize = 254;

/// Why a string is not an acceptable email address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EmailError {
    /// Nothing but whitespace was given.
    #[error("email is empty")]
    Empty,
    /// The address is not shaped like `local@domain.tld`.
    #[error("email is not a valid address")]
    Invalid,
    /// The address is longer than 254 characters.
    #[error("email is longer than 254 characters")]
    TooLong,
}

/// An email address, trimmed and lowercased. Only `Email::parse` constructs one.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct Email(String);

impl Email {
    /// Trims and lowercases `raw`, then requires exactly one `@` with a non-empty local part and a
    /// domain containing a `.`, no whitespace, and at most 254 characters.
    pub fn parse(raw: &str) -> Result<Email, EmailError> {
        let normalised = raw.trim().to_lowercase();
        if normalised.is_empty() {
            return Err(EmailError::Empty);
        }
        if normalised.chars().count() > MAX_LEN {
            return Err(EmailError::TooLong);
        }
        if normalised.chars().any(char::is_whitespace) {
            return Err(EmailError::Invalid);
        }
        let mut parts = normalised.split('@');
        let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(EmailError::Invalid);
        };
        if local.is_empty() || domain.is_empty() || !domain.contains('.') {
            return Err(EmailError::Invalid);
        }
        Ok(Email(normalised))
    }

    /// The normalised address.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Email {
    type Error = EmailError;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Email::parse(&raw)
    }
}
