//! Structured application errors: `{ "code": "<UPPER_SNAKE>", "message": "...", "details": {} }`.

use std::fmt;

use jt_tenancy::WorkspaceStatus;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

/// The machine-readable kind of an `AppError`. Serialised as its `as_str()` name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// No valid session, key or token was presented.
    Unauthenticated,
    /// The caller is known but may not do this.
    Forbidden,
    /// The target does not exist, or is not visible to the caller.
    NotFound,
    /// The request clashes with the current state, e.g. a duplicate.
    Conflict,
    /// The input is malformed or breaks a rule.
    Validation,
    /// The use case is gated and the workspace has no approved strategy.
    StrategyRequired,
    /// The use case is gated and the workspace is not active.
    WorkspaceInactive,
    /// An outbound request targeted a host outside the allowlist.
    HostNotAllowed,
    /// Something failed on our side.
    Internal,
}

impl ErrorCode {
    /// The wire name, e.g. `"STRATEGY_REQUIRED"`.
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::Unauthenticated => "UNAUTHENTICATED",
            ErrorCode::Forbidden => "FORBIDDEN",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::Conflict => "CONFLICT",
            ErrorCode::Validation => "VALIDATION",
            ErrorCode::StrategyRequired => "STRATEGY_REQUIRED",
            ErrorCode::WorkspaceInactive => "WORKSPACE_INACTIVE",
            ErrorCode::HostNotAllowed => "HOST_NOT_ALLOWED",
            ErrorCode::Internal => "INTERNAL",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// An error every use case and adapter speaks; adapters map `code` to their transport.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AppError {
    pub code: ErrorCode,
    /// Human-readable text.
    pub message: String,
    /// Machine-readable context; an empty object when there is none.
    pub details: Value,
}

impl AppError {
    fn new(code: ErrorCode, message: impl Into<String>, details: Value) -> Self {
        AppError {
            code,
            message: message.into(),
            details,
        }
    }

    /// `UNAUTHENTICATED`.
    pub fn unauthenticated(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unauthenticated, message, json!({}))
    }

    /// `FORBIDDEN`.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Forbidden, message, json!({}))
    }

    /// `NOT_FOUND`.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message, json!({}))
    }

    /// `CONFLICT`.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message, json!({}))
    }

    /// `VALIDATION`, with `details` naming what was wrong.
    pub fn validation(message: impl Into<String>, details: Value) -> Self {
        Self::new(ErrorCode::Validation, message, details)
    }

    /// `STRATEGY_REQUIRED`: a gated use case was called before a strategy was approved.
    pub fn strategy_required() -> Self {
        Self::new(
            ErrorCode::StrategyRequired,
            "an approved strategy is required first",
            json!({}),
        )
    }

    /// `WORKSPACE_INACTIVE`, with the current status in `details.status`.
    pub fn workspace_inactive(status: WorkspaceStatus) -> Self {
        Self::new(
            ErrorCode::WorkspaceInactive,
            "the workspace is not active",
            json!({ "status": status.key() }),
        )
    }

    /// `HOST_NOT_ALLOWED`, with the refused host in `details.host`.
    pub fn host_not_allowed(host: impl Into<String>) -> Self {
        let host = host.into();
        Self::new(
            ErrorCode::HostNotAllowed,
            format!("outbound host {host} is not allowed"),
            json!({ "host": host }),
        )
    }

    /// `INTERNAL`.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message, json!({}))
    }
}

impl From<serde_json::Error> for AppError {
    /// Malformed or mistyped JSON input is a `VALIDATION` error.
    fn from(err: serde_json::Error) -> Self {
        AppError::validation(format!("invalid input: {err}"), json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialise_as_upper_snake_names() {
        let all = [
            (AppError::unauthenticated("m"), "UNAUTHENTICATED"),
            (AppError::forbidden("m"), "FORBIDDEN"),
            (AppError::not_found("m"), "NOT_FOUND"),
            (AppError::conflict("m"), "CONFLICT"),
            (
                AppError::validation("m", json!({"field": "email"})),
                "VALIDATION",
            ),
            (AppError::strategy_required(), "STRATEGY_REQUIRED"),
            (
                AppError::workspace_inactive(WorkspaceStatus::Suspended),
                "WORKSPACE_INACTIVE",
            ),
            (AppError::host_not_allowed("evil.test"), "HOST_NOT_ALLOWED"),
            (AppError::internal("m"), "INTERNAL"),
        ];
        for (err, name) in all {
            assert_eq!(err.code.as_str(), name);
            let v = serde_json::to_value(&err).unwrap();
            assert_eq!(v["code"], name);
            assert!(v["message"].is_string());
            assert!(v["details"].is_object(), "{name}");
            assert_eq!(v.as_object().unwrap().len(), 3);
        }
    }

    #[test]
    fn details_carry_context() {
        assert_eq!(
            AppError::validation("bad", json!({"field": "email"})).details,
            json!({"field": "email"})
        );
        assert_eq!(
            AppError::workspace_inactive(WorkspaceStatus::PendingPayment).details,
            json!({"status": "pending_payment"})
        );
        assert_eq!(
            AppError::host_not_allowed("evil.test").details,
            json!({"host": "evil.test"})
        );
        assert_eq!(AppError::not_found("x").details, json!({}));
    }

    #[test]
    fn display_is_code_then_message() {
        assert_eq!(
            AppError::not_found("no such role").to_string(),
            "NOT_FOUND: no such role"
        );
    }

    #[test]
    fn json_errors_become_validation() {
        let err: AppError = serde_json::from_str::<u32>("\"x\"").unwrap_err().into();
        assert_eq!(err.code, ErrorCode::Validation);
        assert!(err.message.starts_with("invalid input: "));
    }
}
