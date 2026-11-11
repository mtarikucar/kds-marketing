use crate::{
    error::{ApiError, ApiJson, ApiPath, ApiQuery},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::{
    ports::posts::PostingSettings,
    usecases::{
        social::{
            self,
            accounts::{AccountDetail, SocialAccount},
            schedule::{VersionScheduleInput, VersionScheduleOut, WaitingPackage},
        },
        studio::work::EmptyInput,
    },
};
use serde_json::{Value, json};
use uuid::Uuid;

pub async fn accounts_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<EmptyInput>,
) -> Result<Json<Vec<SocialAccount>>, ApiError> {
    Ok(Json(social::accounts_list(&s.deps, &ctx, q).await?))
}
pub async fn account_get(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiQuery(q): ApiQuery<Value>,
) -> Result<Json<AccountDetail>, ApiError> {
    let i = super::studio::path_body(q, &[("capability_id", json!(id))])?;
    Ok(Json(social::account_get(&s.deps, &ctx, i).await?))
}
pub async fn account_pause(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<PostingSettings>, ApiError> {
    let i = super::studio::path_body(body, &[("capability_id", json!(id))])?;
    Ok(Json(social::account_pause(&s.deps, &ctx, i).await?))
}

pub async fn version_schedule(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<VersionScheduleInput>,
) -> Result<Json<VersionScheduleOut>, ApiError> {
    Ok(Json(social::version_schedule(&s.deps, &ctx, body).await?))
}
pub async fn versions_waiting(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<EmptyInput>,
) -> Result<Json<Vec<WaitingPackage>>, ApiError> {
    Ok(Json(social::versions_waiting(&s.deps, &ctx, q).await?))
}
