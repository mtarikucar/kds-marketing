//! `POST /hooks/tiktok`: TikTok's signed webhooks; see the crate docs for the answers.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use jt_app::ports::ops::WebhookOutcome;
use jt_app::usecases::webhook::{self, Delivery};
use jt_connector::{TIKTOK_SIGNATURE_HEADER, TIKTOK_SIGNATURE_TOLERANCE, tiktok_signature_check};
use jt_tiktok::webhook::{ParseError, parse};

use crate::{
    REJECTED_TIKTOK, TIKTOK_BODY_LIMIT, UNPARSEABLE_TIKTOK, UNROUTED_TIKTOK, WebhookState, raw,
};

/// The least time between two warnings about refused TikTok deliveries, in seconds: a burst of
/// forged or stale deliveries is one line a minute, the counter counts them all.
const REFUSAL_WARNING_EVERY_S: i64 = 60;

/// When the last warning about a refused delivery was written (Unix seconds by the deps' clock).
static LAST_REFUSAL_WARNING: AtomicI64 = AtomicI64::new(i64::MIN);

/// A delivery refused before anything was stored, `401`: counted ([`REJECTED_TIKTOK`]), and a
/// warning naming only `reason` (`no_app`, `missing_header`, `malformed`, `mismatch`, `stale`),
/// at most once a minute.
fn refused(now: i64, reason: &'static str) -> Response {
    REJECTED_TIKTOK.fetch_add(1, Ordering::Relaxed);
    let last = LAST_REFUSAL_WARNING.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= REFUSAL_WARNING_EVERY_S
        && LAST_REFUSAL_WARNING
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        tracing::warn!(
            provider = "tiktok",
            reason,
            refused = REJECTED_TIKTOK.load(Ordering::Relaxed),
            "a webhook delivery's signature was refused: 401, nothing stored (one warning a minute)"
        );
    }
    StatusCode::UNAUTHORIZED.into_response()
}

/// A signed delivery (see the crate docs).
pub(crate) async fn receive(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let deps = state.deps.as_ref();
    let Some(app) = deps.apps.tiktok_app() else {
        return refused(deps.clock.now().unix_timestamp(), "no_app");
    };
    let Some(signature) = headers
        .get(TIKTOK_SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    else {
        return refused(deps.clock.now().unix_timestamp(), "missing_header");
    };
    let raw = match raw::read(body, TIKTOK_BODY_LIMIT).await {
        Ok(raw) => raw,
        Err(e) => return e.status().into_response(),
    };
    if let Err(e) = tiktok_signature_check(
        app.client_secret.as_bytes(),
        &raw,
        &signature,
        deps.clock.now(),
        TIKTOK_SIGNATURE_TOLERANCE,
    ) {
        return refused(deps.clock.now().unix_timestamp(), e.reason());
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
            if let Some(dropped) = intake.dropped {
                UNROUTED_TIKTOK.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(
                    provider = "tiktok",
                    reason = if dropped == Delivery::Inactive {
                        "inactive"
                    } else {
                        "unrouted"
                    },
                    event = %loggable(&event),
                    "webhook event for an account no active workspace holds connected: dropped"
                );
            }
            for hooked in intake.resolve {
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
