//! `POST /hooks/tiktok`: TikTok's signed webhooks; see the crate docs for the answers.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use jt_app::ports::ops::WebhookOutcome;
use jt_app::usecases::webhook::{self, Delivery};
use jt_connector::{TIKTOK_SIGNATURE_HEADER, TIKTOK_SIGNATURE_TOLERANCE, tiktok_signature_ok};
use jt_tiktok::webhook::{ParseError, parse};

use crate::{TIKTOK_BODY_LIMIT, UNPARSEABLE_TIKTOK, UNROUTED_TIKTOK, WebhookState, raw};

/// A signed delivery (see the crate docs).
pub(crate) async fn receive(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let deps = state.deps.as_ref();
    let Some(app) = deps.apps.tiktok_app() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(signature) = headers
        .get(TIKTOK_SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let raw = match raw::read(body, TIKTOK_BODY_LIMIT).await {
        Ok(raw) => raw,
        Err(e) => return e.status().into_response(),
    };
    let signed = tiktok_signature_ok(
        app.client_secret.as_bytes(),
        &raw,
        &signature,
        deps.clock.now(),
        TIKTOK_SIGNATURE_TOLERANCE,
    );
    if !signed {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let hook = match parse(&raw) {
        Ok(hook) => hook,
        Err(e) => {
            UNPARSEABLE_TIKTOK.fetch_add(1, Ordering::Relaxed);
            deps.ops_signals.webhook(WebhookOutcome::Unresolved);
            tracing::warn!(
                provider = "tiktok",
                reason = match e {
                    ParseError::NotJson => "not_json",
                    ParseError::NoEvent => "no_event",
                },
                "signed webhook body is not a webhook the parser knows: acknowledged, nothing stored"
            );
            return received();
        }
    };
    // Signed with the client secret, yet sent for another app: nothing to route it to.
    if hook.client_key != app.client_key {
        UNROUTED_TIKTOK.fetch_add(1, Ordering::Relaxed);
        deps.ops_signals.webhook(WebhookOutcome::Unrouted);
        tracing::warn!(
            provider = "tiktok",
            reason = "client_key_mismatch",
            "signed webhook names another client key: acknowledged, nothing stored"
        );
        return received();
    }
    let event = hook.event.clone();
    match webhook::receive_tiktok(deps, hook.into_event(), &raw).await {
        Ok(intake) => {
            match intake.delivery {
                Delivery::Unrouted | Delivery::Inactive => {
                    UNROUTED_TIKTOK.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(
                        provider = "tiktok",
                        reason = if intake.delivery == Delivery::Inactive {
                            "inactive"
                        } else {
                            "unrouted"
                        },
                        event = %loggable(&event),
                        "webhook event for an account no active workspace holds connected: dropped"
                    );
                }
                Delivery::Stored(_) | Delivery::Duplicate => {}
            }
            if let Some(hooked) = intake.resolve {
                webhook::spawn_resolve(Arc::clone(&state.deps), hooked);
            }
            received()
        }
        Err(e) => {
            tracing::error!(
                provider = "tiktok",
                code = e.code.as_str(),
                "cannot store a webhook event; the provider will redeliver"
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// The event's name as logged: TikTok's own names (letters, digits, `.` and `_`) as they are,
/// anything else as `other`.
fn loggable(event: &str) -> &str {
    let plain = event.len() <= 64
        && event
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_');
    if plain { event } else { "other" }
}

/// `200`, which is all TikTok reads.
fn received() -> Response {
    StatusCode::OK.into_response()
}
