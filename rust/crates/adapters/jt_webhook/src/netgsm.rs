//! `POST /hooks/netgsm/{workspace_id}/{token}/{purpose}`: NetGSM's callbacks; see the crate docs
//! for the answers.

use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jt_app::usecases::webhook;
use jt_connector::NetgsmPurpose;
use jt_tenancy::WorkspaceId;

use crate::{NETGSM_BODY_LIMIT, UNPARSEABLE_NETGSM, WebhookState, raw};

/// A callback (see the crate docs). The URL is checked, in constant time for the token, before
/// the body is read; every refusal of the URL is the same bare `404`, a segment that does not
/// even decode (bad percent-encoding, not UTF-8) included.
pub(crate) async fn receive(
    State(state): State<WebhookState>,
    path: Result<Path<(String, String, String)>, PathRejection>,
    body: Body,
) -> StatusCode {
    let Ok(Path((workspace_id, token, purpose))) = path else {
        return StatusCode::NOT_FOUND;
    };
    let deps = state.deps.as_ref();
    let (Some(purpose), Ok(ws)) = (
        NetgsmPurpose::parse(&purpose),
        workspace_id.parse::<WorkspaceId>(),
    ) else {
        return StatusCode::NOT_FOUND;
    };
    match webhook::netgsm_hook_open(deps, ws, purpose, &token).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND,
        Err(e) => {
            tracing::error!(
                provider = "netgsm",
                purpose = purpose.key(),
                code = e.code.as_str(),
                "cannot check a callback; the provider will redeliver"
            );
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    }
    let raw = match raw::read(body, NETGSM_BODY_LIMIT).await {
        Ok(raw) => raw,
        Err(e) => return e.status(),
    };
    let drafts = match jt_netgsm::webhook::parse(purpose, &raw) {
        Ok(drafts) => drafts,
        Err(_) => {
            UNPARSEABLE_NETGSM.fetch_add(1, Ordering::Relaxed);
            deps.ops_signals
                .webhook(jt_app::ports::ops::WebhookOutcome::Unresolved);
            tracing::warn!(
                provider = "netgsm",
                purpose = purpose.key(),
                "callback body the parser cannot read: accepted, nothing stored"
            );
            return StatusCode::ACCEPTED;
        }
    };
    if drafts.is_empty() {
        deps.ops_signals
            .webhook(jt_app::ports::ops::WebhookOutcome::Unresolved);
        tracing::warn!(
            provider = "netgsm",
            reason = "no_routable_events",
            "authenticated callback accepted, nothing stored"
        );
        return StatusCode::ACCEPTED;
    }
    match webhook::receive_netgsm(deps, ws, purpose, drafts, &raw).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(e) => {
            tracing::error!(
                provider = "netgsm",
                purpose = purpose.key(),
                code = e.code.as_str(),
                "cannot store callback events; the provider will redeliver"
            );
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}
