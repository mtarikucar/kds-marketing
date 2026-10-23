//! Structured errors over HTTP: every failure is `{ "code", "message", "details" }` with the
//! status [`status_of`] its code, including rejected JSON bodies, malformed path parameters and
//! query strings, and unknown API routes.

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, FromRequestParts, Path, Query, Request};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use jt_app::error::{AppError, ErrorCode};
use serde::de::DeserializeOwned;
use serde_json::json;

/// The only message an `INTERNAL` error carries over the wire; the real one is logged.
pub const INTERNAL_MESSAGE: &str = "internal error";

/// An [`AppError`] on its way to the client.
#[derive(Debug)]
pub struct ApiError(pub AppError);

impl From<AppError> for ApiError {
    fn from(err: AppError) -> Self {
        ApiError(err)
    }
}

/// The HTTP status of an error code.
pub fn status_of(code: ErrorCode) -> StatusCode {
    match code {
        ErrorCode::Unauthenticated => StatusCode::UNAUTHORIZED,
        ErrorCode::Forbidden => StatusCode::FORBIDDEN,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::Conflict => StatusCode::CONFLICT,
        ErrorCode::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCode::StrategyRequired => StatusCode::CONFLICT,
        ErrorCode::WorkspaceInactive => StatusCode::LOCKED,
        ErrorCode::HostNotAllowed => StatusCode::FORBIDDEN,
        ErrorCode::UpstreamUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl IntoResponse for ApiError {
    /// The structured error as JSON. An `INTERNAL` error is logged with its message and details
    /// and answered with [`INTERNAL_MESSAGE`] and empty details, so nothing internal leaks.
    fn into_response(self) -> Response {
        let ApiError(err) = self;
        let body = if err.code == ErrorCode::Internal {
            tracing::error!(details = %err.details, "internal error: {}", err.message);
            AppError::internal(INTERNAL_MESSAGE)
        } else {
            err
        };
        (status_of(body.code), Json(body)).into_response()
    }
}

/// `NOT_FOUND` for a path, or a method on a path, the router does not serve.
pub async fn not_found() -> ApiError {
    ApiError(AppError::not_found("no such route"))
}

/// A JSON request body. Unlike `axum::Json`, every rejection (a missing JSON content type,
/// malformed JSON, missing fields or wrong types) is a structured `422 VALIDATION` error.
#[derive(Debug)]
pub struct ApiJson<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ApiJson(value)),
            Err(rejection) => Err(ApiError(json_rejection(&rejection))),
        }
    }
}

/// Path parameters. Unlike `axum::extract::Path`, a parameter that does not parse (e.g. an id
/// that is not a UUID) is a structured `422 VALIDATION` error.
#[derive(Debug)]
pub struct ApiPath<T>(pub T);

impl<T, S> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Path::<T>::from_request_parts(parts, state).await {
            Ok(Path(value)) => Ok(ApiPath(value)),
            Err(rejection) => Err(ApiError(AppError::validation(
                rejection.body_text(),
                json!({}),
            ))),
        }
    }
}

/// A query string. Unlike `axum::extract::Query`, a parameter that does not parse (e.g. a
/// `limit` that is not a number) is a structured `422 VALIDATION` error.
#[derive(Debug)]
pub struct ApiQuery<T>(pub T);

impl<T, S> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(ApiQuery(value)),
            Err(rejection) => Err(ApiError(AppError::validation(
                rejection.body_text(),
                json!({}),
            ))),
        }
    }
}

fn json_rejection(rejection: &JsonRejection) -> AppError {
    let message = match rejection {
        JsonRejection::MissingJsonContentType(_) => {
            "expected a JSON body with Content-Type: application/json".to_owned()
        }
        other => other.body_text(),
    };
    AppError::validation(message, json!({}))
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use jt_tenancy::WorkspaceStatus;
    use serde_json::Value;

    use super::*;

    async fn render(err: AppError) -> (StatusCode, Value) {
        let resp = ApiError(err).into_response();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn codes_map_to_their_statuses_with_the_structured_body() {
        let table = [
            (AppError::unauthenticated("m"), 401),
            (AppError::forbidden("m"), 403),
            (AppError::not_found("m"), 404),
            (AppError::conflict("m"), 409),
            (AppError::validation("m", json!({ "field": "email" })), 422),
            (AppError::strategy_required(), 409),
            (
                AppError::workspace_inactive(WorkspaceStatus::Suspended),
                423,
            ),
            (AppError::host_not_allowed("evil.test"), 403),
            (
                AppError::upstream_unavailable("meta", "rate limited", Some(30)),
                503,
            ),
            (AppError::internal("m"), 500),
        ];
        for (err, status) in table {
            let code = err.code.as_str();
            let (got, body) = render(err.clone()).await;
            assert_eq!(got.as_u16(), status, "{code}");
            assert_eq!(body["code"], code);
            if err.code != ErrorCode::Internal {
                assert_eq!(body, serde_json::to_value(&err).unwrap());
            }
        }
    }

    #[tokio::test]
    async fn an_unavailable_provider_passes_its_details_through() {
        let err = AppError::upstream_unavailable("meta", "rate limited", Some(30));
        let (status, body) = render(err).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            json!({
                "code": "UPSTREAM_UNAVAILABLE",
                "message": "the provider is unavailable; try again later",
                "details": {
                    "provider": "meta",
                    "retryable": true,
                    "retry_after_s": 30,
                    "reason": "rate limited",
                },
            })
        );
    }

    #[tokio::test]
    async fn internal_errors_hide_their_message_and_details() {
        let mut err = AppError::internal("connection to 10.0.0.5 refused for user app");
        err.details = json!({ "sql": "select secret" });
        let (status, body) = render(err).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body,
            json!({ "code": "INTERNAL", "message": "internal error", "details": {} })
        );
    }
}
