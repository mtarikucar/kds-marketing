//! `/api/capability-groups`: the capability groups of the session's current workspace (spec
//! §6.3), each with its members.
//!
//! Creating answers `201`; renaming, adding and removing a member answer the group as it now
//! stands (`200`), and deleting answers `200` with the confirmation `{group_id, deleted: true}`:
//! each the same JSON its MCP tool answers.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jt_app::usecases::groups::{self, GroupOut};
use jt_capability::{CapabilityGroupId, CapabilityId};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiJson, ApiPath};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `POST /api/capability-groups`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupBody {
    pub name: String,
    #[serde(default)]
    pub purpose: Option<String>,
}

/// `PATCH /api/capability-groups/{group_id}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameBody {
    pub name: String,
}

/// `POST /api/capability-groups/{group_id}/members`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddMemberBody {
    pub capability_id: CapabilityId,
}

/// The answer to deleting a group, as `jeeta.capability.groups_delete` answers it.
#[derive(Serialize)]
pub struct DeletedBody {
    pub group_id: CapabilityGroupId,
    /// Always `true`.
    pub deleted: bool,
}

/// `200` with every group and its members, oldest group first.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<GroupOut>>, ApiError> {
    Ok(Json(groups::list(&state.deps, &ctx).await?))
}

/// `201` with the new group, no members.
pub async fn create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<GroupBody>,
) -> Result<(StatusCode, Json<GroupOut>), ApiError> {
    let group = groups::create(&state.deps, &ctx, body.name, body.purpose).await?;
    Ok((StatusCode::CREATED, Json(group)))
}

/// `200` with the renamed group.
pub async fn rename(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityGroupId>,
    ApiJson(body): ApiJson<RenameBody>,
) -> Result<Json<GroupOut>, ApiError> {
    Ok(Json(
        groups::rename(&state.deps, &ctx, id, body.name).await?,
    ))
}

/// `200` with `{group_id, deleted: true}`: the group is deleted; its members stay.
pub async fn delete(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityGroupId>,
) -> Result<Json<DeletedBody>, ApiError> {
    groups::delete(&state.deps, &ctx, id).await?;
    Ok(Json(DeletedBody {
        group_id: id,
        deleted: true,
    }))
}

/// `200` with the group and its new member.
pub async fn add_member(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityGroupId>,
    ApiJson(body): ApiJson<AddMemberBody>,
) -> Result<Json<GroupOut>, ApiError> {
    Ok(Json(
        groups::add_member(&state.deps, &ctx, id, body.capability_id).await?,
    ))
}

/// `200` with the group, without the capability among its members.
pub async fn remove_member(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath((id, capability)): ApiPath<(CapabilityGroupId, CapabilityId)>,
) -> Result<Json<GroupOut>, ApiError> {
    Ok(Json(
        groups::remove_member(&state.deps, &ctx, id, capability).await?,
    ))
}
