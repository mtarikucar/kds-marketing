//! Structured errors over MCP and HTTP: every failure is `{ "code", "message", "details" }`.
//!
//! A failed tool call is a tool result with `is_error: true` that carries the structured error
//! both as its structured content and as its text content. An `INTERNAL` error is logged with
//! its message and details and answered with [`INTERNAL_MESSAGE`] and empty details, so nothing
//! internal leaks.

use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use jt_app::error::{AppError, ErrorCode};
use rmcp::model::CallToolResult;
use serde_json::Value;

/// The only message an `INTERNAL` error carries to the caller; the real one is logged.
pub const INTERNAL_MESSAGE: &str = "internal error";

/// `err` as the caller may see it: unchanged, except an `INTERNAL` error, which is logged and
/// replaced with a bare [`INTERNAL_MESSAGE`].
pub fn public(err: AppError) -> AppError {
    if err.code == ErrorCode::Internal {
        tracing::error!(details = %err.details, "internal error: {}", err.message);
        AppError::internal(INTERNAL_MESSAGE)
    } else {
        err
    }
}

/// The structured JSON of `err` (after [`public`]).
pub fn error_json(err: AppError) -> Value {
    serde_json::to_value(public(err)).unwrap_or_else(
        |_| serde_json::json!({ "code": "INTERNAL", "message": INTERNAL_MESSAGE, "details": {} }),
    )
}

/// A failed tool call: `is_error: true` with the structured error as structured and text
/// content.
pub fn tool_error(err: AppError) -> CallToolResult {
    CallToolResult::structured_error(error_json(err))
}

/// An HTTP answer for an error met before the MCP layer: `401` with `WWW-Authenticate: Bearer`
/// for `UNAUTHENTICATED`, `404` for `NOT_FOUND`, `503` for `UPSTREAM_UNAVAILABLE`, `500`
/// otherwise; the body is the structured error.
pub fn http_error(err: AppError) -> Response {
    let code = err.code;
    let body = Json(error_json(err));
    match code {
        ErrorCode::Unauthenticated => (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            body,
        )
            .into_response(),
        ErrorCode::NotFound => (StatusCode::NOT_FOUND, body).into_response(),
        ErrorCode::UpstreamUnavailable => (StatusCode::SERVICE_UNAVAILABLE, body).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, body).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn internal_errors_hide_their_message_and_details() {
        let mut err = AppError::internal("connection to 10.0.0.5 refused");
        err.details = json!({ "sql": "select secret" });
        assert_eq!(
            error_json(err),
            json!({ "code": "INTERNAL", "message": "internal error", "details": {} })
        );
        let not_found = AppError::not_found("no such role");
        assert_eq!(
            error_json(not_found.clone()),
            serde_json::to_value(&not_found).unwrap()
        );
    }

    #[tokio::test]
    async fn http_errors_map_their_code_to_a_status() {
        let table = [
            (AppError::unauthenticated("invalid api key"), 401),
            (AppError::not_found("unknown session"), 404),
            (
                AppError::upstream_unavailable("meta", "rate limited", None),
                503,
            ),
            (AppError::internal("db down"), 500),
        ];
        for (err, status) in table {
            let resp = http_error(err);
            assert_eq!(resp.status().as_u16(), status);
            assert_eq!(
                resp.headers().contains_key(header::WWW_AUTHENTICATE),
                status == 401
            );
        }
    }

    #[test]
    fn an_unavailable_provider_keeps_its_details_in_a_tool_error() {
        let err = AppError::upstream_unavailable("x", "temporary failure: reset", Some(5));
        let expected = json!({
            "code": "UPSTREAM_UNAVAILABLE",
            "message": "the provider is unavailable; try again later",
            "details": {
                "provider": "x",
                "retryable": true,
                "retry_after_s": 5,
                "reason": "temporary failure: reset",
            },
        });
        assert_eq!(error_json(err.clone()), expected);
        let result = tool_error(err);
        assert_eq!(result.is_error, Some(true));
        assert_eq!(result.structured_content, Some(expected.clone()));
        let text = &result.content[0].as_text().unwrap().text;
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), expected);
    }

    #[test]
    fn tool_errors_carry_the_structured_error_twice() {
        let result = tool_error(AppError::strategy_required());
        assert_eq!(result.is_error, Some(true));
        let structured = result.structured_content.clone().unwrap();
        assert_eq!(structured["code"], "STRATEGY_REQUIRED");
        let text = &result.content[0].as_text().unwrap().text;
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), structured);
    }
}
