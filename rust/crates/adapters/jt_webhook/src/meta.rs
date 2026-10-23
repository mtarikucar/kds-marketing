//! `GET /hooks/meta` (the verification handshake) and `POST /hooks/meta` (signed deliveries); see
//! the crate docs for the answers.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use jt_app::usecases::webhook::{self, AccountEvent, Delivery};
use jt_connector::{META_SIGNATURE_HEADER, Provider, meta_signature_ok, meta_verify_token_ok};
use jt_meta::webhook::{ParseError, kinds_of_hint, parse};

use crate::{META_BODY_LIMIT, UNPARSEABLE_META, UNROUTED_META, WebhookState, raw};

/// What Meta is answered once a delivery is handled.
const RECEIVED: &str = "EVENT_RECEIVED";

/// The logged reason of an event dropped because no workspace holds its account connected.
const UNROUTED: &str = "unrouted";
/// The logged reason of an event dropped because the workspace holding its account is suspended.
const INACTIVE: &str = "inactive";

/// The longest `hub.challenge` echoed back.
const MAX_CHALLENGE_CHARS: usize = 256;

/// The verification handshake: the challenge, as `text/plain`, for the platform's verify token
/// and `hub.mode=subscribe`; `403` otherwise (a challenge that is not a plain token of at most
/// [`MAX_CHALLENGE_CHARS`] letters, digits, `-`, `_` or `.` included: Meta sends a number, and
/// nothing else is reflected); `404` while no Meta app is configured.
pub(crate) async fn verify(
    State(state): State<WebhookState>,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(app) = state.deps.apps.meta_app() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (mut mode, mut token, mut challenge) = (None, None, None);
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "hub.mode" => mode = Some(value.into_owned()),
            "hub.verify_token" => token = Some(value.into_owned()),
            "hub.challenge" => challenge = Some(value.into_owned()),
            _ => {}
        }
    }
    match (mode.as_deref(), token, challenge) {
        (Some("subscribe"), Some(token), Some(challenge))
            if meta_verify_token_ok(&app.verify_token, &token) && plain(&challenge) =>
        {
            (StatusCode::OK, challenge).into_response()
        }
        _ => StatusCode::FORBIDDEN.into_response(),
    }
}

/// Whether `challenge` may be echoed: 1 to [`MAX_CHALLENGE_CHARS`] letters, digits, `-`, `_` or
/// `.`.
fn plain(challenge: &str) -> bool {
    (1..=MAX_CHALLENGE_CHARS).contains(&challenge.len())
        && challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// A signed delivery (see the crate docs).
pub(crate) async fn receive(
    State(state): State<WebhookState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let deps = state.deps.as_ref();
    let Some(app) = deps.apps.meta_app() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(signature) = headers
        .get(META_SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let raw = match raw::read(body, META_BODY_LIMIT).await {
        Ok(raw) => raw,
        Err(e) => return e.status().into_response(),
    };
    // Both secrets are tried, every time (`|`, not `||`): which one signed tells nothing.
    let instagram = deps.apps.instagram_app();
    let signed = meta_signature_ok(app.app_secret.as_bytes(), &raw, &signature)
        | instagram.is_some_and(|ig| meta_signature_ok(ig.app_secret.as_bytes(), &raw, &signature));
    if !signed {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let parsed = match parse(&raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            UNPARSEABLE_META.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                provider = "meta",
                reason = parse_reason(&e),
                "signed webhook body is not a webhook the parser knows: acknowledged, nothing stored"
            );
            return received();
        }
    };
    let hints: Vec<&'static str> = parsed.iter().map(|p| p.kind_hint).collect();
    let events = parsed
        .into_iter()
        .map(|p| AccountEvent {
            kind_keys: kinds_of_hint(p.kind_hint),
            external_account_id: p.external_account_id,
            draft: p.event,
        })
        .collect();
    match webhook::receive_for_accounts(deps, Provider::Meta, events, &raw).await {
        Ok(deliveries) => {
            // One warning per reason and kind of account, however many events a delivery drops.
            let mut dropped: BTreeMap<(&'static str, &'static str), u64> = BTreeMap::new();
            for (delivery, kind_hint) in deliveries.iter().zip(hints) {
                let reason = match delivery {
                    Delivery::Unrouted => UNROUTED,
                    Delivery::Inactive => INACTIVE,
                    Delivery::Stored(_) | Delivery::Duplicate => continue,
                };
                *dropped.entry((reason, kind_hint)).or_default() += 1;
            }
            for ((reason, kind_hint), events) in dropped {
                UNROUTED_META.fetch_add(events, Ordering::Relaxed);
                tracing::warn!(
                    provider = "meta",
                    reason,
                    kind_hint,
                    events,
                    "{}",
                    match reason {
                        INACTIVE =>
                            "webhook events for an account of a suspended workspace: dropped",
                        _ => "webhook events for an account no workspace holds connected: dropped",
                    }
                );
            }
            received()
        }
        Err(e) => {
            tracing::error!(
                provider = "meta",
                code = e.code.as_str(),
                "cannot store webhook events; the provider will redeliver"
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `200 EVENT_RECEIVED`.
fn received() -> Response {
    (StatusCode::OK, RECEIVED).into_response()
}

/// Why a signed body was not parsed, without anything it said.
fn parse_reason(e: &ParseError) -> &'static str {
    match e {
        ParseError::NotJson => "not_json",
        ParseError::NoObject => "no_object",
        ParseError::UnknownObject(_) => "unknown_object",
        ParseError::NoEntries => "no_entries",
    }
}
