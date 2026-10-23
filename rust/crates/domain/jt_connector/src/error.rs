//! The one error shape provider adapters return. Every reason goes through [`redact_reason`].

use time::Duration;

use crate::redact::redact_reason;

/// Why a call to a provider failed (spec §6.4). The only error shape adapters return:
///
/// - `Auth`: the credential is no longer accepted (expired, revoked, wrong password); the
///   capability turns unreachable and needs reconnecting (`reconnect_required`);
/// - `Permission`: the credential is valid but lacks a scope or a role for this call;
/// - `Throttle`: the provider asks to slow down; back off, for `retry_after` when it says;
/// - `Transient`: a network or provider-side failure worth a bounded retry;
/// - `Unknown`: the write may have reached the provider; never retry blindly;
/// - `Permanent`: the request itself cannot succeed (a deleted page, a refused number); record it
///   and stop.
///
/// Build it through the constructors ([`ConnectorError::auth`], ...): they run the reason through
/// [`redact_reason`], so a reason never carries a credential even when it quotes a provider's
/// response or a request URL.
///
/// The variants that carry a `reason` are `#[non_exhaustive]` so that, outside this crate, they
/// cannot be built with a struct expression, only through the redacting constructors: no adapter
/// can put an unredacted provider body into a reason by accident. They can still be matched, with
/// `..`:
///
/// ```
/// use jt_connector::ConnectorError;
///
/// let e = ConnectorError::auth(r#"{"access_token":"EAAB"}"#);
/// match e {
///     ConnectorError::Auth { reason, .. } => assert_eq!(reason, r#"{"access_token":"***"}"#),
///     _ => unreachable!(),
/// }
/// ```
///
/// ```compile_fail,E0639
/// // Refused: a reason-carrying variant built by hand would skip the redaction.
/// let e = jt_connector::ConnectorError::Auth { reason: String::new() };
/// ```
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConnectorError {
    #[error("authentication failed: {reason}")]
    #[non_exhaustive]
    Auth { reason: String },
    #[error("permission denied: {reason}")]
    #[non_exhaustive]
    Permission { reason: String },
    #[error("rate limited{}", retry_text(.retry_after))]
    Throttle { retry_after: Option<Duration> },
    #[error("temporary failure: {reason}")]
    #[non_exhaustive]
    Transient { reason: String },
    /// The write may have reached the provider; never retry blindly.
    #[error("outcome unknown: {reason}")]
    #[non_exhaustive]
    Unknown { reason: String },
    #[error("permanent failure: {reason}")]
    #[non_exhaustive]
    Permanent { reason: String },
}

fn retry_text(retry_after: &Option<Duration>) -> String {
    match retry_after {
        Some(d) => format!(", retry after {} s", d.whole_seconds()),
        None => String::new(),
    }
}

impl ConnectorError {
    /// `Auth`, its reason redacted.
    pub fn auth(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Auth {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// `Permission`, its reason redacted.
    pub fn permission(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Permission {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// `Throttle`; a negative wait reads as no wait.
    pub fn throttle(retry_after: Option<Duration>) -> ConnectorError {
        ConnectorError::Throttle {
            retry_after: retry_after.map(|d| d.max(Duration::ZERO)),
        }
    }

    /// `Transient`, its reason redacted.
    pub fn transient(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Transient {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// The write may have reached the provider; never retry blindly. The reason is redacted.
    pub fn unknown(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Unknown {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// `Permanent`, its reason redacted.
    pub fn permanent(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Permanent {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// The stable key of the variant, e.g. `"throttle"` (what a probe run records).
    pub fn kind(&self) -> &'static str {
        match self {
            ConnectorError::Auth { .. } => "auth",
            ConnectorError::Permission { .. } => "permission",
            ConnectorError::Throttle { .. } => "throttle",
            ConnectorError::Transient { .. } => "transient",
            ConnectorError::Unknown { .. } => "unknown",
            ConnectorError::Permanent { .. } => "permanent",
        }
    }

    /// The reason, for every variant but `Throttle`.
    pub fn reason(&self) -> Option<&str> {
        match self {
            ConnectorError::Auth { reason }
            | ConnectorError::Permission { reason }
            | ConnectorError::Unknown { reason }
            | ConnectorError::Transient { reason }
            | ConnectorError::Permanent { reason } => Some(reason),
            ConnectorError::Throttle { .. } => None,
        }
    }

    /// Whether trying again later may succeed: `Throttle` and `Transient`.
    pub fn is_retriable(&self) -> bool {
        matches!(
            self,
            ConnectorError::Throttle { .. } | ConnectorError::Transient { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_is_redacted_and_never_retriable() {
        let error = ConnectorError::unknown(r#"outcome unknown: {"access_token":"secret"}"#);
        assert_eq!(error.kind(), "unknown");
        assert!(!error.is_retriable());
        assert_eq!(
            error.reason(),
            Some(r#"outcome unknown: {"access_token":"***"}"#)
        );
        assert!(!format!("{error} {error:?}").contains("secret"));
        let probe = crate::ProbeResult::failure(1, error);
        assert_eq!(
            crate::status_after_probe(jt_capability::StoredStatus::Verified, &probe),
            jt_capability::StoredStatus::Verified
        );
    }
}
