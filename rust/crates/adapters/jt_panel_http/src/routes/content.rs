use crate::error::ApiQuery;
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
        views::{AreasOut, OlayViewOut, QueueOut, TreeOut},
    },
    studio::{
        projects::{ProjectDetail, ProjectQuery},
        work::EmptyInput,
    },
};
use serde_json::Value;
use uuid::Uuid;
/// The content page's tree (design 2026-11-18 §5).
pub async fn tree(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(_): ApiQuery<EmptyInput>,
) -> Result<Json<TreeOut>, ApiError> {
    Ok(Json(content::tree(&s.deps, &ctx).await?))
}
/// "Analiz sırası".
pub async fn analysis_queue(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(_): ApiQuery<EmptyInput>,
) -> Result<Json<QueueOut>, ApiError> {
    Ok(Json(content::analysis_queue(&s.deps, &ctx).await?))
}
/// A page of the production line, each area with its pipeline.
pub async fn areas(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<ProjectQuery>,
) -> Result<Json<AreasOut>, ApiError> {
    Ok(Json(content::areas(&s.deps, &ctx, q).await?))
}
/// One olay (or `genel`) with its flow, contents, files and "Eksikler".
pub async fn olay_view(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<String>,
    ApiQuery(_): ApiQuery<EmptyInput>,
) -> Result<Json<OlayViewOut>, ApiError> {
    let i = super::studio::path_body(serde_json::json!({}), &[("olay_id", serde_json::json!(id))])?;
    Ok(Json(content::olay_view(&s.deps, &ctx, i).await?))
}
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
