//! The request-header check against cross-site request forgery.
//!
//! Every request to the API whose method is not safe (anything but `GET`, `HEAD`, `OPTIONS` and
//! `TRACE`, so every `POST`, `PUT`, `PATCH` and `DELETE`) must carry
//! `X-Requested-With: jeeta-panel`. A cross-site form or a simple cross-origin request cannot
//! set a custom header, and a preflighted one is refused by the absence of CORS grants. The check
//! wraps every API route and the API fallbacks, so it runs before authentication and body
//! parsing, and on unknown API paths too.

use axum::extract::Request;
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use jt_app::error::AppError;

use crate::error::ApiError;

/// The header the panel sends with every mutating request.
pub const REQUESTED_WITH_HEADER: &str = "x-requested-with";
/// Its only accepted value.
pub const REQUESTED_WITH_VALUE: &str = "jeeta-panel";

/// Middleware: refuses a request with an unsafe method and without the header with
/// `403 {"code":"FORBIDDEN","message":"missing request header","details":{}}`.
pub async fn require_requested_with(req: Request, next: Next) -> Response {
    if !req.method().is_safe() && !has_requested_with(req.headers()) {
        return ApiError(AppError::forbidden("missing request header")).into_response();
    }
    next.run(req).await
}

/// Whether the first `X-Requested-With` header is exactly `jeeta-panel`.
fn has_requested_with(headers: &HeaderMap) -> bool {
    headers
        .get(REQUESTED_WITH_HEADER)
        .is_some_and(|value| value.as_bytes() == REQUESTED_WITH_VALUE.as_bytes())
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    #[test]
    fn only_the_exact_value_counts() {
        let mut headers = HeaderMap::new();
        assert!(!has_requested_with(&headers));
        for (value, ok) in [
            ("jeeta-panel", true),
            ("Jeeta-Panel", false),
            ("jeeta-panel ", false),
            ("XMLHttpRequest", false),
            ("", false),
        ] {
            headers.insert(REQUESTED_WITH_HEADER, HeaderValue::from_str(value).unwrap());
            assert_eq!(has_requested_with(&headers), ok, "{value:?}");
        }
    }
}
