//! Security headers on every response: the panel's pages and files, the API, `/healthz` and
//! every fallback.
//!
//! - `X-Content-Type-Options: nosniff`: a browser never second-guesses a declared content type.
//! - `Referrer-Policy: no-referrer`: no URL (an `/invite/<token>` page among them) leaks to
//!   another site through the `Referer` header.
//! - `Content-Security-Policy: frame-ancestors 'none'`: no site may frame the panel
//!   (clickjacking). A response whose own policy already forbids framing (a public link's page,
//!   whose policy is stricter, `jt_webhook::links`) keeps it; any other policy is replaced.

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::http::header::{CONTENT_SECURITY_POLICY, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS};
use axum::middleware::Next;
use axum::response::Response;

/// The headers [`security_headers`] sets, as (name, value).
pub const SECURITY_HEADERS: &[(&str, &str)] = &[
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("content-security-policy", "frame-ancestors 'none'"),
];

/// Whether a content security policy holds the directive `frame-ancestors 'none'`.
fn forbids_framing(policy: &HeaderValue) -> bool {
    policy.to_str().is_ok_and(|p| {
        p.split(';').any(|d| {
            let mut words = d.split_whitespace();
            words
                .next()
                .is_some_and(|w| w.eq_ignore_ascii_case("frame-ancestors"))
                && words.next() == Some("'none'")
                && words.next().is_none()
        })
    })
}

/// Middleware: sets the security headers on the response, replacing any earlier value (a
/// content security policy that already forbids framing is kept), so applying it twice (e.g.
/// once more around a merged router) changes nothing.
pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    let own = headers.get_all(CONTENT_SECURITY_POLICY).iter().count() == 1
        && headers
            .get(CONTENT_SECURITY_POLICY)
            .is_some_and(forbids_framing);
    if !own {
        headers.insert(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'none'"),
        );
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_policy_that_forbids_framing_is_kept() {
        let policy = |s: &'static str| HeaderValue::from_static(s);
        assert!(forbids_framing(&policy("frame-ancestors 'none'")));
        assert!(forbids_framing(&policy(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
        )));
        assert!(!forbids_framing(&policy("default-src 'none'")));
        assert!(!forbids_framing(&policy(
            "frame-ancestors 'none' https://example.invalid"
        )));
        assert!(!forbids_framing(&policy("frame-ancestors 'self'")));
        assert!(!forbids_framing(&policy("frame-ancestors")));
    }
}
