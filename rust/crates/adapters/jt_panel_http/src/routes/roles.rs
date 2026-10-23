//! `/api/roles`: the roles of the session's current workspace.
//!
//! Writes answer with the changed role (`201` when created, `200` when updated) or `204` when
//! nothing is left to show (deletion).

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jt_app::usecases::roles::{self, CreateRole};
use jt_tenancy::{RoleDef, RoleId};
use serde::Deserialize;

use crate::error::{ApiError, ApiJson, ApiPath};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `POST /api/roles`.
#[derive(Deserialize)]
pub struct CreateRoleBody {
    pub key: String,
    pub name: String,
    pub permissions: Vec<String>,
}

/// `PATCH /api/roles/{role_id}`.
#[derive(Deserialize)]
pub struct UpdateRoleBody {
    pub permissions: Vec<String>,
}

/// `200` with the workspace's roles, system and custom.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<RoleDef>>, ApiError> {
    Ok(Json(roles::list(&state.deps, &ctx).await?))
}

/// `201` with the new custom role.
pub async fn create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CreateRoleBody>,
) -> Result<(StatusCode, Json<RoleDef>), ApiError> {
    let input = CreateRole {
        key: body.key,
        name: body.name,
        permissions: body.permissions,
    };
    let role = roles::create(&state.deps, &ctx, input).await?;
    Ok((StatusCode::CREATED, Json(role)))
}

/// `200` with the role and its new permissions.
pub async fn update(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(role_id): ApiPath<RoleId>,
    ApiJson(body): ApiJson<UpdateRoleBody>,
) -> Result<Json<RoleDef>, ApiError> {
    Ok(Json(
        roles::update(&state.deps, &ctx, role_id, body.permissions).await?,
    ))
}

/// `204`: the custom role is deleted.
pub async fn delete(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(role_id): ApiPath<RoleId>,
) -> Result<StatusCode, ApiError> {
    roles::delete(&state.deps, &ctx, role_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
