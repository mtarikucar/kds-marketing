//! `/api/devices/bridge`: the device bridge's own routes (spec `2026-10-28-device-bridge-design.md`
//! §5.4): its heartbeat, its long-polled commands, its result batches and its file uploads. Served
//! to the bridge's bearer key only ([`crate::bearer`], which refuses any other key before a body
//! is read); each answers `200` with what its use case returns, in `jt_device_protocol`'s bodies.
//! The results route's body is at most `MAX_RESULTS_BODY_BYTES` (set where the router is built); a
//! file upload's body is read as a stream and bounded by its use case.

use axum::Json;
use axum::body::{Body, BodyDataStream};
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::{HeaderMap, StatusCode, header};
use futures_util::StreamExt;
use jt_app::error::AppError;
use jt_app::ports::files::ByteSource;
use jt_app::usecases::devices::bridge::{
    self, CommandsOut, CommandsQuery, FileOut, MAX_RESULTS_BODY_BYTES, RegisterIn, RegisterOut,
    ResultsIn, ResultsOut,
};
use serde_json::json;

use crate::bearer::DeviceBridgeCtx;
use crate::error::{ApiError, ApiJson, ApiQuery, json_rejection};
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

/// `200` with how many of the batch's results were applied now, before, or not at all. A body
/// over `MAX_RESULTS_BODY_BYTES` is `422` naming `body` (the bridge logs the field and splits the
/// batch); any other body that is not a batch is `422` as every JSON body is.
pub async fn results(
    State(state): State<AppState>,
    DeviceBridgeCtx(b): DeviceBridgeCtx,
    body: Result<Json<ResultsIn>, JsonRejection>,
) -> Result<Json<ResultsOut>, ApiError> {
    let Json(body) = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::validation(
                format!("a results batch is at most {MAX_RESULTS_BODY_BYTES} bytes"),
                json!({ "field": "body" }),
            )
        } else {
            json_rejection(&rejection)
        }
    })?;
    Ok(Json(bridge::results(&state.deps, &b, body).await?))
}

/// A request body as the file store takes it, chunk by chunk.
struct BodySource(BodyDataStream);

#[async_trait::async_trait]
impl ByteSource for BodySource {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        match self.0.next().await {
            None => Ok(None),
            Some(Ok(chunk)) => Ok(Some(chunk.to_vec())),
            Some(Err(_)) => Err(AppError::validation(
                "the file's body could not be read",
                json!({ "field": "body" }),
            )),
        }
    }
}

/// `200 {"file_id"}` for the file that is the request's whole body, of the type its
/// `Content-Type` names (`image/png` or `application/octet-stream`): no JSON envelope, no
/// multipart. The body is streamed, never held whole; a `Content-Length` over the type's limit is
/// refused before it is read, and so is a body that grows past it as it is read, or that cannot be
/// read (`422` naming `body`).
pub async fn files(
    State(state): State<AppState>,
    DeviceBridgeCtx(b): DeviceBridgeCtx,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<FileOut>, ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let declared_len = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let mut source = BodySource(body.into_data_stream());
    Ok(Json(
        bridge::files(&state.deps, &b, content_type, declared_len, &mut source).await?,
    ))
}
