//! Tenant module registry; writes never grant agent execution permissions.
use crate::{
    error::{ApiError, ApiJson, ApiPath},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::usecases::modules::{self, InstallInput, ModulesOut, UpdateInput};
pub async fn list(
    State(s): State<AppState>,
    WorkspaceCtx(c): WorkspaceCtx,
) -> Result<Json<ModulesOut>, ApiError> {
    Ok(Json(modules::list(&s.deps, &c).await?))
}
pub async fn install(
    State(s): State<AppState>,
    WorkspaceCtx(c): WorkspaceCtx,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<InstallInput>,
) -> Result<Json<ModulesOut>, ApiError> {
    Ok(Json(modules::install(&s.deps, &c, &id, body).await?))
}
pub async fn update(
    State(s): State<AppState>,
    WorkspaceCtx(c): WorkspaceCtx,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<UpdateInput>,
) -> Result<Json<ModulesOut>, ApiError> {
    Ok(Json(modules::update(&s.deps, &c, &id, body).await?))
}
pub async fn remove(
    State(s): State<AppState>,
    WorkspaceCtx(c): WorkspaceCtx,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ModulesOut>, ApiError> {
    Ok(Json(modules::remove(&s.deps, &c, &id).await?))
}
