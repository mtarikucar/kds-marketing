//! `/api/devices/bridge`: the device bridge's own routes (spec `2026-10-28-device-bridge-design.md`
//! §5.4): its heartbeat, its long-polled commands, its result batches and its file uploads. Served
//! to the bridge's bearer key only ([`crate::bearer`]); each answers `200` with what its use case
//! returns, in `jt_device_protocol`'s bodies. The results route's body is at most
//! `MAX_RESULTS_BODY_BYTES`, the files route's at most `DEVICE_FILE_LIMIT` (both set where the
//! router is built).

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode, header};
use jt_app::error::AppError;
use jt_app::usecases::devices::bridge::{
    self, CommandsOut, CommandsQuery, FileOut, RegisterIn, RegisterOut, ResultsIn, ResultsOut,
};
use jt_app::usecases::files::DEVICE_FILE_LIMIT;
use serde_json::json;

use crate::bearer::DeviceBridgeCtx;
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::state::AppState;

/// `200` with the phones that registered, those refused and why, how often to register again
/// and the longest a poll waits.
pub async fn register(
    State(state): State<AppState>,
    DeviceBridgeCtx(b): DeviceBridgeCtx,
    ApiJson(body): ApiJson<RegisterIn>,
) -> Result<Json<RegisterOut>, ApiError> {
    Ok(Json(bridge::register(&state.deps, &b, body).await?))
}

/// `200` with the commands now the bridge's, after waiting up to `?wait_s=` seconds (25 at most)
/// for one: `?wait_s=&limit=`.
pub async fn commands(
    State(state): State<AppState>,
    DeviceBridgeCtx(b): DeviceBridgeCtx,
    ApiQuery(query): ApiQuery<CommandsQuery>,
) -> Result<Json<CommandsOut>, ApiError> {
    Ok(Json(bridge::commands(&state.deps, &b, query).await?))
}

/// `200` with how many of the batch's results were applied now, before, or not at all.
pub async fn results(
    State(state): State<AppState>,
    DeviceBridgeCtx(b): DeviceBridgeCtx,
    ApiJson(body): ApiJson<ResultsIn>,
) -> Result<Json<ResultsOut>, ApiError> {
    Ok(Json(bridge::results(&state.deps, &b, body).await?))
}

/// `200 {"file_id"}` for the file that is the request's whole body, of the type its
/// `Content-Type` names (`image/png` or `application/octet-stream`): no JSON envelope, no
/// multipart. A body over the route's limit, or one that cannot be read, is `422` naming `body`.
pub async fn files(
    State(state): State<AppState>,
    DeviceBridgeCtx(b): DeviceBridgeCtx,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<FileOut>, ApiError> {
    let body = body.map_err(|rejection| {
        let message = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            format!("a device file is at most {DEVICE_FILE_LIMIT} bytes")
        } else {
            rejection.body_text()
        };
        AppError::validation(message, json!({ "field": "body" }))
    })?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    Ok(Json(
        bridge::files(&state.deps, &b, content_type, Vec::from(body)).await?,
    ))
}
