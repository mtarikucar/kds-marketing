use crate::{
    error::{ApiError, ApiJson, ApiPath},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::usecases::{
    content::{
        self,
        areas::{AreaOut, ClaimOut},
    },
    studio::projects::ProjectDetail,
};
use serde_json::Value;
use uuid::Uuid;
pub async fn area_claim(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<ClaimOut>, ApiError> {
    let i = super::studio::path_body(body, &[("project_id", serde_json::json!(id))])?;
    Ok(Json(content::area_claim(&s.deps, &ctx, i).await?))
}
pub async fn area_progress(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AreaOut>, ApiError> {
    let i = super::studio::path_body(body, &[("project_id", serde_json::json!(id))])?;
    Ok(Json(content::area_progress(&s.deps, &ctx, i).await?))
}
pub async fn area_release(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AreaOut>, ApiError> {
    let i = super::studio::path_body(body, &[("project_id", serde_json::json!(id))])?;
    Ok(Json(content::area_release(&s.deps, &ctx, i).await?))
}
pub async fn area_deliver(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AreaOut>, ApiError> {
    let i = super::studio::path_body(body, &[("project_id", serde_json::json!(id))])?;
    Ok(Json(content::area_deliver(&s.deps, &ctx, i).await?))
}
pub async fn area_redo(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<ProjectDetail>, ApiError> {
    let i = super::studio::path_body(body, &[("project_id", serde_json::json!(id))])?;
    Ok(Json(content::area_redo(&s.deps, &ctx, i).await?))
}
pub async fn delivery_accept(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<ProjectDetail>, ApiError> {
    let i = super::studio::path_body(body, &[("project_id", serde_json::json!(id))])?;
    Ok(Json(content::delivery_accept(&s.deps, &ctx, i).await?))
}
