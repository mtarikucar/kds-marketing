//! Reading a request body up to a limit, as received (the bytes a signature covers and the raw
//! copy kept beside the events).

use std::error::Error;

use axum::body::{Body, Bytes, to_bytes};
use axum::http::StatusCode;
use http_body_util::LengthLimitError;

/// Why a body was not read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BodyError {
    /// It is longer than the limit: `413`.
    TooLarge,
    /// It did not arrive whole: `400`.
    Unreadable,
}

impl BodyError {
    pub(crate) fn status(self) -> StatusCode {
        match self {
            BodyError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            BodyError::Unreadable => StatusCode::BAD_REQUEST,
        }
    }
}

/// The whole body, at most `limit` bytes.
pub(crate) async fn read(body: Body, limit: usize) -> Result<Bytes, BodyError> {
    to_bytes(body, limit).await.map_err(|e| {
        if over_limit(&e) {
            BodyError::TooLarge
        } else {
            BodyError::Unreadable
        }
    })
}

/// Whether `e`, or what caused it, is the limit being exceeded.
fn over_limit(e: &(dyn Error + 'static)) -> bool {
    let mut cause: Option<&(dyn Error + 'static)> = Some(e);
    while let Some(c) = cause {
        if c.is::<LengthLimitError>() {
            return true;
        }
        cause = c.source();
    }
    false
}
