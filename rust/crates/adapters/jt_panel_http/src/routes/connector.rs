//! `/api/connectors`: connecting the accounts of the session's current workspace through their
//! providers (spec §6.1, §6.4): starting an OAuth flow (or one that reconnects a capability),
//! confirming the assets a completed flow found, entering credentials by hand, probing a
//! connector capability, reading every connector's health and the webhook addresses to register
//! at the providers. The flow's callback, which only the owner's browser brings back, is
//! [`super::oauth_callback`].
//!
//! Every route answers `200` with the JSON its MCP tool answers: a started flow
//! (`{authorize_url, pending_id, expires_at}`; the tool adds a `handoff` sentence for the agent),
//! the capabilities a confirmation made or renewed, the capability credentials were entered for,
//! a probe's outcome with the status after it, the list of connectors' health. Bodies are read
//! strictly: an unknown field is `422 VALIDATION`, and a refused credential never repeats a value
//! (`connector::SetCredentials`). A probe and a reconnection take no body.

use axum::Json;
use axum::extract::State;
use jt_app::ports::OAuthPendingId;
use jt_app::usecases::capabilities::CapabilityOut;
use jt_app::usecases::connector::{
    self, ConfirmAssets, ConnectorHealth, HooksOut, ProbeOut, SetCredentials, StartOAuth, StartOut,
};
use jt_capability::CapabilityId;
use serde::Deserialize;

use crate::error::{ApiError, ApiJson, ApiPath};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `POST /api/connectors/oauth/{pending_id}/confirm`: the external ids of the assets to connect,
/// as the callback listed them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmBody {
    pub selected: Vec<String>,
}

/// `200` with the started flow: where to send the browser. The body is `{kind_key}`, a Meta kind
/// or `x` (a NetGSM kind is `422`, `details.reason = "use_set_credentials"`).
pub async fn start_oauth(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<StartOAuth>,
) -> Result<Json<StartOut>, ApiError> {
    Ok(Json(connector::start_oauth(&state.deps, &ctx, body).await?))
}

/// `200` with the capabilities the chosen assets became (or the one a reconnection renewed), as
/// they stand after their probes.
pub async fn confirm_assets(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(pending_id): ApiPath<OAuthPendingId>,
    ApiJson(body): ApiJson<ConfirmBody>,
) -> Result<Json<Vec<CapabilityOut>>, ApiError> {
    let input = ConfirmAssets {
        pending_id,
        selected: body.selected,
    };
    Ok(Json(
        connector::confirm_assets(&state.deps, &ctx, input).await?,
    ))
}

/// `200` with the capability the credentials were entered for, after their probe. The body is
/// [`SetCredentials`]: `{capability_id}` or `{kind_key, name}`, an optional `external_id`, and the
/// `credential` (`mailbox`, `netgsm_sms`, `netgsm_iys`, `netgsm_pbx` or `meta_token`).
/// IYS requires capability_id of an existing live SMS line and matching usercode; its separate
/// sealed slot leaves the SMS credential untouched, with brand_code in connector_public.iys.
pub async fn set_credentials(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<SetCredentials>,
) -> Result<Json<CapabilityOut>, ApiError> {
    Ok(Json(
        connector::set_credentials(&state.deps, &ctx, body).await?,
    ))
}

/// `200` with the probe's outcome and the capability's stored status after it.
pub async fn probe(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
) -> Result<Json<ProbeOut>, ApiError> {
    Ok(Json(connector::probe(&state.deps, &ctx, id).await?))
}

/// `200` with the health of every connector capability that is not retired, oldest first.
pub async fn health(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<ConnectorHealth>>, ApiError> {
    Ok(Json(connector::health(&state.deps, &ctx).await?))
}

/// `200` with the webhook addresses to register at the providers: `{meta, netgsm}`, the Meta
/// webhook (`null` without the platform's Meta app) and the workspace's NetGSM callback URL per
/// purpose, each carrying the workspace's hook token (`capabilities.manage` only).
pub async fn hooks(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<HooksOut>, ApiError> {
    Ok(Json(connector::hooks(&state.deps, &ctx).await?))
}

/// `200` with a flow bound to the capability, started as `start_oauth` starts one.
pub async fn reconnect(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
) -> Result<Json<StartOut>, ApiError> {
    Ok(Json(connector::reconnect(&state.deps, &ctx, id).await?))
}
