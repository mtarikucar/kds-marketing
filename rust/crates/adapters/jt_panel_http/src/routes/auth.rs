//! `/api/auth/*`: registration, login, logout, `me` and switching workspace.
//!
//! A new session's token travels only in the `jt_session` cookie, never in a response body.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use jt_app::usecases::auth::{self, LoginInput, MeOut, RegisterInput, SessionOut};
use jt_tenancy::WorkspaceId;
use serde::Deserialize;

use crate::error::{ApiError, ApiJson};
use crate::session::{self, Authed, SESSION_COOKIE};
use crate::state::AppState;

/// `POST /api/auth/register`.
#[derive(Deserialize)]
pub struct RegisterBody {
    pub email: String,
    pub password: String,
    pub display_name: String,
    pub workspace_name: String,
}

impl From<RegisterBody> for RegisterInput {
    fn from(body: RegisterBody) -> Self {
        RegisterInput {
            email: body.email,
            password: body.password,
            display_name: body.display_name,
            workspace_name: body.workspace_name,
        }
    }
}

/// `POST /api/auth/login`.
#[derive(Deserialize)]
pub struct LoginBody {
    pub email: String,
    pub password: String,
}

impl From<LoginBody> for LoginInput {
    fn from(body: LoginBody) -> Self {
        LoginInput {
            email: body.email,
            password: body.password,
        }
    }
}

/// `POST /api/auth/switch-workspace`.
#[derive(Deserialize)]
pub struct SwitchBody {
    pub workspace_id: WorkspaceId,
}

/// `201` with the new user as [`MeOut`], signed in through the cookie.
pub async fn register(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<RegisterBody>,
) -> Result<Response, ApiError> {
    let session = auth::register(&state.deps, body.into()).await?;
    signed_in(&state, StatusCode::CREATED, session)
}

/// `200` with the user as [`MeOut`], signed in through the cookie.
pub async fn login(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<LoginBody>,
) -> Result<Response, ApiError> {
    let session = auth::login(&state.deps, body.into()).await?;
    signed_in(&state, StatusCode::OK, session)
}

/// `204`: revokes the cookie's session, if any, and clears the cookie.
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(token) = session::read_cookie(&headers, SESSION_COOKIE) {
        auth::logout(&state.deps, token).await?;
    }
    let clear = session::clear_session_cookie(state.cookie_secure)?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear)]).into_response())
}

/// `200` with the signed-in user.
pub async fn me(State(state): State<AppState>, Authed(principal): Authed) -> Json<MeOut> {
    Json(auth::me(&state.deps, &principal))
}

/// `200` with the signed-in user, now working in the requested workspace.
pub async fn switch_workspace(
    State(state): State<AppState>,
    Authed(principal): Authed,
    ApiJson(body): ApiJson<SwitchBody>,
) -> Result<Json<MeOut>, ApiError> {
    auth::switch_workspace(&state.deps, &principal, body.workspace_id).await?;
    Ok(Json(MeOut {
        current_workspace: Some(body.workspace_id),
        ..auth::me(&state.deps, &principal)
    }))
}

/// The response that opens a session: the cookie with its token, and the user as the body.
fn signed_in(
    state: &AppState,
    status: StatusCode,
    session: SessionOut,
) -> Result<Response, ApiError> {
    let cookie = session::session_cookie(&session.token, state.cookie_secure)?;
    Ok((status, [(header::SET_COOKIE, cookie)], Json(session.me)).into_response())
}
