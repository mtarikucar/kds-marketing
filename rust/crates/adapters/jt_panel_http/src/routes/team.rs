//! `/api/team`: the members of the session's current workspace, invitations, accepting one, roles
//! of members and removing them.
//!
//! Writes answer with the changed object (`201` for a new invitation, `200` for a role change)
//! or `204` when nothing is left to show (removal).

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use jt_app::error::ErrorCode;
use jt_app::ports::MemberOut;
use jt_app::usecases::auth::{self, MeOut, Principal};
use jt_app::usecases::team::{self, AcceptInput, InviteInput};
use jt_tenancy::{MembershipId, WorkspaceId};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiJson, ApiPath};
use crate::session::{self, SESSION_COOKIE, WorkspaceCtx};
use crate::state::AppState;

/// `POST /api/team/invites`. An unknown field is refused, as `jeeta.team.invite` refuses it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InviteBody {
    pub email: String,
    pub role_key: String,
}

/// `POST /api/team/invites/accept`. `password` and `display_name` are needed only when no one
/// is signed in.
#[derive(Deserialize)]
pub struct AcceptBody {
    pub token: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// `PATCH /api/team/{membership_id}/role`. An unknown field is refused, as
/// `jeeta.team.set_role` refuses it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetRoleBody {
    pub role_key: String,
}

/// The answer to accepting an invitation. `me` is the new user, present only when accepting
/// created one (and signed them in through the cookie).
#[derive(Serialize)]
pub struct AcceptedBody {
    pub workspace_id: WorkspaceId,
    pub membership_id: MembershipId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub me: Option<MeOut>,
}

/// `200` with the workspace's members and invitations.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<MemberOut>>, ApiError> {
    Ok(Json(team::list(&state.deps, &ctx).await?))
}

/// `201` with the invitation, including its plaintext token: the only time it is ever shown.
/// The response is marked `Cache-Control: no-store`.
pub async fn invite(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<InviteBody>,
) -> Result<Response, ApiError> {
    let input = InviteInput {
        email: body.email,
        role_key: body.role_key,
    };
    let out = team::invite(&state.deps, &ctx, input).await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(out),
    )
        .into_response())
}

/// `200` with the accepted membership. Needs no session: a valid session cookie, if present,
/// makes its user the one who accepts; otherwise the invitee is created from the body and signed
/// in through the cookie, exactly as login does.
pub async fn accept(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<AcceptBody>,
) -> Result<Response, ApiError> {
    let principal = signed_in(&state, &headers).await?;
    let out = team::accept_invite(
        &state.deps,
        AcceptInput {
            token: body.token,
            password: body.password,
            display_name: body.display_name,
            principal: principal.as_ref(),
        },
    )
    .await?;
    let Some(session) = out.session else {
        let body = AcceptedBody {
            workspace_id: out.workspace_id,
            membership_id: out.membership_id,
            me: None,
        };
        return Ok((StatusCode::OK, Json(body)).into_response());
    };
    let cookie = session::session_cookie(&session.token, state.cookie_secure)?;
    let body = AcceptedBody {
        workspace_id: out.workspace_id,
        membership_id: out.membership_id,
        me: Some(session.me),
    };
    Ok((StatusCode::OK, [(header::SET_COOKIE, cookie)], Json(body)).into_response())
}

/// `200` with the member in their new role.
pub async fn set_role(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(membership_id): ApiPath<MembershipId>,
    ApiJson(body): ApiJson<SetRoleBody>,
) -> Result<Json<MemberOut>, ApiError> {
    let member = team::set_role(&state.deps, &ctx, membership_id, &body.role_key).await?;
    Ok(Json(member))
}

/// `204`: the member is removed (or the invitation cancelled).
pub async fn remove(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(membership_id): ApiPath<MembershipId>,
) -> Result<StatusCode, ApiError> {
    team::remove(&state.deps, &ctx, membership_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The user behind the request's session cookie, or `None` when there is no cookie or its
/// session is not valid (unknown, revoked or expired); any other failure is returned.
async fn signed_in(state: &AppState, headers: &HeaderMap) -> Result<Option<Principal>, ApiError> {
    let Some(token) = session::read_cookie(headers, SESSION_COOKIE) else {
        return Ok(None);
    };
    match auth::resolve_session(&state.deps, token).await {
        Ok(principal) => Ok(Some(principal)),
        Err(e) if e.code == ErrorCode::Unauthenticated => Ok(None),
        Err(e) => Err(e.into()),
    }
}
