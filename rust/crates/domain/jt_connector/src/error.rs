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
///   and stop. It may name a [`Cause`]: a refusal whose remedy is neither the content nor the
///   connection (the provider has not approved the platform's app for this, or could not fetch
///   the media it was pointed at), which the use cases tell the owner in its own words.
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
    Permanent {
        reason: String,
        /// Why, when it is one of the closed [`Cause`]s; `None` for any other refusal.
        cause: Option<Cause>,
    },
}

/// Why a `Permanent` refusal cannot succeed when neither the content nor the connection is at
/// fault: what the owner is told instead of "the platform did not accept the content" or
/// "reconnect". Closed: a provider's own code is mapped to one of these by its adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cause {
    /// The provider has not audited (reviewed) the platform's app for this kind of post, so it
    /// refuses it for every account like this one (TikTok's
    /// `unaudited_client_can_only_post_to_private_accounts`): reconnecting does not help, and
    /// trying again fails the same way until the provider passes the app.
    AppNotAudited,
    /// The provider was pointed at a media URL it would not or could not fetch: the URL's host is
    /// not verified as the platform's at the provider (TikTok's `url_ownership_unverified`), or the
    /// download failed or timed out (TikTok's `video_pull_failed`, `photo_pull_failed`). The
    /// platform's configuration or the file server is at fault, not the content.
    MediaUnfetched,
}

impl Cause {
    /// The stable key (`"app_not_audited"`, `"media_unfetched"`), as failure details carry it.
    pub fn key(self) -> &'static str {
        match self {
            Cause::AppNotAudited => "app_not_audited",
            Cause::MediaUnfetched => "media_unfetched",
        }
    }
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
            cause: None,
        }
    }

    /// `Permanent` for `cause`, its reason redacted.
    pub fn permanent_because(cause: Cause, reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Permanent {
            reason: redact_reason(reason.as_ref()),
            cause: Some(cause),
        }
    }

    /// The [`Cause`] of a `Permanent` refusal that names one; `None` for every other error.
    pub fn cause(&self) -> Option<Cause> {
        match self {
            ConnectorError::Permanent { cause, .. } => *cause,
            _ => None,
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
            | ConnectorError::Permanent { reason, .. } => Some(reason),
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
    fn a_cause_is_a_permanent_refusal_and_only_that() {
        let e = ConnectorError::permanent_because(
            Cause::AppNotAudited,
            r#"HTTP 403 unaudited: {"access_token":"secret"}"#,
        );
        assert_eq!(e.kind(), "permanent");
        assert!(!e.is_retriable());
        assert_eq!(e.cause(), Some(Cause::AppNotAudited));
        assert_eq!(
            e.reason(),
            Some(r#"HTTP 403 unaudited: {"access_token":"***"}"#)
        );
        assert_ne!(e, ConnectorError::permanent(e.reason().unwrap()));
        assert_eq!(ConnectorError::permanent("x").cause(), None);
        assert_eq!(ConnectorError::permission("x").cause(), None);
        assert_eq!(Cause::AppNotAudited.key(), "app_not_audited");
        assert_eq!(Cause::MediaUnfetched.key(), "media_unfetched");
    }

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
