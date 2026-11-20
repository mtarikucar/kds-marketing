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
        compose::{FilesAddOut, PostDismissOut, PostRequestOut, VersionCancelOut},
        posts::{PostDetail, PostsOut, PostsQuery},
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
/// Paylaşımlar's read (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §3.2).
pub async fn posts(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<PostsQuery>,
) -> Result<Json<PostsOut>, ApiError> {
    Ok(Json(content::posts(&s.deps, &ctx, q).await?))
}
/// One row of Paylaşımlar, listed or not (§3.3).
pub async fn post_get(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(row_id): ApiPath<String>,
    ApiQuery(_): ApiQuery<EmptyInput>,
) -> Result<Json<PostDetail>, ApiError> {
    let i = super::studio::path_body(
        serde_json::json!({}),
        &[("row_id", serde_json::json!(row_id))],
    )?;
    Ok(Json(content::post_get(&s.deps, &ctx, i).await?))
}
/// The composer "Ne paylaşalım?" (§3.4).
pub async fn post_request(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<PostRequestOut>, ApiError> {
    let i = super::studio::path_body(body, &[])?;
    Ok(Json(content::post_request(&s.deps, &ctx, i).await?))
}
/// A person's files for what waits for them (§3.7.1).
pub async fn files_add(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<FilesAddOut>, ApiError> {
    let i = super::studio::path_body(body, &[])?;
    Ok(Json(content::files_add(&s.deps, &ctx, i).await?))
}
/// "Bu yıl geç" (§3.7.2).
pub async fn special_day_skip(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath((key, year)): ApiPath<(String, i32)>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<jt_app::ports::materials::CalendarEntry>, ApiError> {
    let i = super::studio::path_body(
        body,
        &[
            ("key", serde_json::json!(key)),
            ("year", serde_json::json!(year)),
        ],
    )?;
    Ok(Json(content::special_day_skip(&s.deps, &ctx, i).await?))
}
/// A version with no planned post is never planned (§3.7.3).
pub async fn version_cancel(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath((project, version)): ApiPath<(Uuid, Uuid)>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<VersionCancelOut>, ApiError> {
    let i = super::studio::path_body(
        body,
        &[
            ("project_id", serde_json::json!(project)),
            ("version_id", serde_json::json!(version)),
        ],
    )?;
    Ok(Json(content::version_cancel(&s.deps, &ctx, i).await?))
}
/// "Bırak" and "Tamamladım" (§3.7.4); the path names the post's slot.
pub async fn post_dismiss(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(slot): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<PostDismissOut>, ApiError> {
    let i = super::studio::path_body(body, &[("slot_id", serde_json::json!(slot))])?;
    Ok(Json(content::post_dismiss(&s.deps, &ctx, i).await?))
}
