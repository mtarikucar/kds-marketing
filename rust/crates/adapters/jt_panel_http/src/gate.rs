//! The gate on every API route: a per-route layer built from the route's catalog use case, so it
//! runs whatever extractors the route's handler uses.
//!
//! For a use case it applies to ([`applies`]), the layer resolves the caller's session (sharing
//! the lookup with the handler's [`Authed`] or `WorkspaceCtx`), takes the session's current
//! workspace and its status from the memberships the session resolution has just re-read, and
//! runs [`check_gate`]: `WORKSPACE_INACTIVE` unless the workspace is `active` or the use case's
//! status exemption covers its status, then `STRATEGY_REQUIRED` for a `Gated` use case without
//! an approved strategy. Without a valid session the route answers `401`, without a current workspace
//! `409 CONFLICT` ("no current workspace"), before the handler runs.

use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use jt_app::catalog::{GateMode, StatusExemption, UseCase};
use jt_app::error::AppError;
use jt_app::gate::check_gate;
use jt_app::usecases::auth::Principal;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

use crate::error::ApiError;
use crate::session::Authed;
use crate::state::AppState;

/// Panel-only use cases that do not act in the session's current workspace although they are
/// not status-exempt, so the layer leaves them alone: accepting an invitation acts in the
/// invitation's workspace (and needs no session at all), whose status the use case checks itself.
pub const OUTSIDE_CURRENT_WORKSPACE: &[&str] = &["team.accept_invite"];

/// What the gate layer of one route needs: the shared state and the route's use case.
#[derive(Clone)]
pub struct RouteGate {
    pub state: AppState,
    pub use_case: UseCase,
}

/// Whether the layer checks `uc` at all. It does for every `Gated` use case, and for every use
/// case the workspace-status check can bind, except those of [`OUTSIDE_CURRENT_WORKSPACE`]: the
/// strategy (`strategy.*`) and the pending work (`work.*`) among them, which pass while the
/// workspace awaits payment but not while it is suspended. Only use cases exempt from both checks
/// in every status (`auth.*`, `workspace.*`, `platform.*`) pass untouched; their handlers
/// authenticate the caller themselves where they need to.
pub fn applies(uc: &UseCase) -> bool {
    match uc.gate {
        GateMode::Gated => true,
        GateMode::Exempt => {
            uc.status_exemption != StatusExemption::Always
                && !OUTSIDE_CURRENT_WORKSPACE.contains(&uc.id)
        }
    }
}

/// The session's current workspace and its status, `409 CONFLICT` when there is none.
///
/// `resolve_session` keeps a current workspace only while it is one of the memberships.
pub fn current_workspace(
    principal: &Principal,
) -> Result<(WorkspaceId, WorkspaceStatus), AppError> {
    principal
        .current_workspace
        .and_then(|ws| principal.memberships.iter().find(|m| m.workspace_id == ws))
        .map(|m| (m.workspace_id, m.workspace_status))
        .ok_or_else(|| AppError::conflict("no current workspace"))
}

/// Middleware: lets the request on to the handler, or answers the gate's structured error.
pub async fn require_gate(State(route): State<RouteGate>, req: Request, next: Next) -> Response {
    if !applies(&route.use_case) {
        return next.run(req).await;
    }
    let (mut parts, body) = req.into_parts();
    let checked = async {
        let Authed(principal) = Authed::from_request_parts(&mut parts, &route.state).await?;
        let (ws, status) = current_workspace(&principal)?;
        check_gate(&route.use_case, status, route.state.gate.as_ref(), ws).await?;
        Ok::<(), ApiError>(())
    };
    if let Err(err) = checked.await {
        return err.into_response();
    }
    next.run(Request::from_parts(parts, body)).await
}
