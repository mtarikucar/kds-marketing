//! What an owner is told when a provider refuses a send or a publication: one bounded line,
//! `kind: provider: reason`, e.g. `permanent: meta: HTTP 400 OAuthException (#131030): Recipient
//! phone number not in allowed list` or `permanent: x: HTTP 402 CreditsDepleted: ...`. The reason
//! is the adapter's, which every `ConnectorError` constructor has already redacted, so the line
//! carries no credential; it carries no message body either, since adapters never quote one.
use jt_connector::{ConnectorError, Provider};

/// The longest failure line kept.
pub const MAX_FAILURE_CHARS: usize = 300;

/// The error kinds a failure line starts with (`ConnectorError::kind`).
const KINDS: [&str; 6] = [
    "auth",
    "permission",
    "throttle",
    "transient",
    "unknown",
    "permanent",
];

/// The failure line for `e` from `provider`: control characters become spaces and it is cut to
/// [`MAX_FAILURE_CHARS`]. A reason-less error (`Throttle`) is its kind and provider alone.
pub fn failure_reason(provider: Option<Provider>, e: &ConnectorError) -> String {
    let mut text = e.kind().to_owned();
    if let Some(provider) = provider {
        text.push_str(": ");
        text.push_str(provider.key());
    }
    if let Some(reason) = e.reason().map(str::trim).filter(|r| !r.is_empty()) {
        text.push_str(": ");
        text.push_str(reason);
    }
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_FAILURE_CHARS)
        .collect()
}

/// The error kind a failure line starts with, or the whole text when it is not a failure line
/// (a refusal's stable code such as `IZIN_YOK`): what an append-only record keeps of it.
pub fn failure_kind(reason: &str) -> &str {
    match reason.split_once(": ") {
        Some((kind, _)) if KINDS.contains(&kind) => kind,
        _ => reason,
    }
}

/// The provider's numeric error code a failure line quotes as `(#code` (Meta Graph), if any.
pub fn provider_code(reason: &str) -> Option<i64> {
    let rest = &reason[reason.find("(#")? + 2..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// The HTTP status a failure line quotes as `HTTP <status>`, if any.
pub fn http_status(reason: &str) -> Option<u16> {
    let rest = &reason[reason.find("HTTP ")? + 5..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_line_names_kind_provider_and_reason() {
        let e = ConnectorError::permanent(
            "HTTP 400 OAuthException (#131030): Recipient phone number not in allowed list",
        );
        let line = failure_reason(Some(Provider::Meta), &e);
        assert_eq!(
            line,
            "permanent: meta: HTTP 400 OAuthException (#131030): Recipient phone number not in allowed list"
        );
        assert_eq!(failure_kind(&line), "permanent");
        assert_eq!(provider_code(&line), Some(131030));
        assert_eq!(http_status(&line), Some(400));
        let x = failure_reason(
            Some(Provider::X),
            &ConnectorError::permanent("HTTP 402 CreditsDepleted: no credits"),
        );
        assert_eq!(x, "permanent: x: HTTP 402 CreditsDepleted: no credits");
        assert_eq!(http_status(&x), Some(402));
        assert_eq!(provider_code(&x), None);
    }

    #[test]
    fn a_failure_line_is_bounded_single_line_and_secret_free() {
        let e = ConnectorError::transient(format!(
            "line one{}line two {{\"access_token\":\"EAAB\"}} {}",
            char::from(10),
            "x".repeat(400)
        ));
        let line = failure_reason(None, &e);
        assert!(line.starts_with("transient: line one line two"), "{line}");
        assert!(!line.contains("EAAB"), "{line}");
        assert!(!line.chars().any(char::is_control));
        assert_eq!(line.chars().count(), MAX_FAILURE_CHARS);
        assert_eq!(
            failure_reason(Some(Provider::X), &ConnectorError::throttle(None)),
            "throttle: x"
        );
    }

    #[test]
    fn a_refusal_code_is_kept_whole() {
        assert_eq!(failure_kind("IZIN_YOK"), "IZIN_YOK");
        assert_eq!(failure_kind("refused: client: x"), "refused: client: x");
        assert_eq!(failure_kind("throttle"), "throttle");
    }
}
