//! Security headers on every response: the panel's pages and files, the API, `/healthz` and
//! every fallback.
//!
//! - `X-Content-Type-Options: nosniff`: a browser never second-guesses a declared content type.
//! - `Referrer-Policy: no-referrer`: no URL (an `/invite/<token>` page among them) leaks to
//!   another site through the `Referer` header.
//! - `Content-Security-Policy: frame-ancestors 'none'`: no site may frame the panel
//!   (clickjacking).

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

/// Middleware: sets the security headers on the response, replacing any earlier value, so
/// applying it twice (e.g. once more around a merged router) changes nothing.
pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    resp
}
