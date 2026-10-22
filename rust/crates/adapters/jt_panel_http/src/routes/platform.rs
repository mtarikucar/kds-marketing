//! `/api/platform/*`: the platform console. An operator logs in, lists every workspace and
//! changes a workspace's status.
//!
//! A new operator session's token travels only in the `jt_platform` cookie, never in a response
//! body. Every other route needs that cookie ([`PlatformAuthed`]); a user's `jt_session` cookie
//! does not open them.

use axum::Json;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use jt_app::usecases::auth::LoginInput;
use jt_app::usecases::platform::{self, WorkspaceAdminOut};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::{ApiError, ApiJson, ApiPath};
use crate::platform_session::{PlatformAuthed, platform_cookie};
use crate::state::AppState;

/// `POST /api/platform/login`.
#[derive(Deserialize)]
pub struct PlatformLoginBody {
    pub email: String,
    pub password: String,
}

/// `PATCH /api/platform/workspaces/{workspace_id}/status`.
#[derive(Deserialize)]
pub struct SetStatusBody {
    /// `pending_payment`, `active` or `suspended`.
    pub status: WorkspaceStatus,
}

/// The answer to an operator login: when the session ends. The token is in the cookie.
#[derive(Serialize)]
pub struct PlatformSignedIn {
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

/// `200` with the session's expiry, signed in through the `jt_platform` cookie.
pub async fn login(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<PlatformLoginBody>,
) -> Result<Response, ApiError> {
    let input = LoginInput {
        email: body.email,
        password: body.password,
    };
    let session = platform::login(&state.deps, input).await?;
    let cookie = platform_cookie(&session.token, state.cookie_secure)?;
    let body = PlatformSignedIn {
        expires_at: session.expires_at,
    };
    Ok(([(header::SET_COOKIE, cookie)], Json(body)).into_response())
}

/// `200` with every workspace, newest first, with its owner's email and member count.
pub async fn list_workspaces(
    State(state): State<AppState>,
    PlatformAuthed(pctx): PlatformAuthed,
) -> Result<Json<Vec<WorkspaceAdminOut>>, ApiError> {
    Ok(Json(platform::list_workspaces(&state.deps, &pctx).await?))
}

/// `200` with the workspace in its new status.
pub async fn set_status(
    State(state): State<AppState>,
    PlatformAuthed(pctx): PlatformAuthed,
    ApiPath(workspace_id): ApiPath<WorkspaceId>,
    ApiJson(body): ApiJson<SetStatusBody>,
) -> Result<Json<WorkspaceAdminOut>, ApiError> {
    let out = platform::set_status(&state.deps, &pctx, workspace_id, body.status).await?;
    Ok(Json(out))
}
