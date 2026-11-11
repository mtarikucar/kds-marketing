//! `/api/ads/campaigns`: the ad campaigns of the session's current workspace (design
//! 2026-11-10 §8). A person's decisions (opening, approving, declining, letting go on, ending,
//! changing) are panel-only; an agent proposes through its tool alone.
use crate::{
    error::{ApiError, ApiJson, ApiPath, ApiQuery},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::{
    ports::ads::AdCampaign,
    usecases::ads::{
        self, CampaignDetail, CampaignList, ClaimOut, ListQuery, OpenInput, PreviewOut,
    },
};
use serde_json::{Value, json};
use uuid::Uuid;

fn with_id(body: Value, id: Uuid) -> Result<Value, ApiError> {
    super::studio::path_body(body, &[("campaign_id", json!(id))])
}

pub async fn campaigns_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<ListQuery>,
) -> Result<Json<CampaignList>, ApiError> {
    Ok(Json(ads::campaigns_list(&s.deps, &ctx, q).await?))
}
pub async fn campaign_get(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
) -> Result<Json<CampaignDetail>, ApiError> {
    let i = ads::CampaignIdInput { campaign_id: id };
    Ok(Json(ads::campaign_get(&s.deps, &ctx, i).await?))
}
pub async fn campaign_open(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<OpenInput>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(ads::campaign_open(&s.deps, &ctx, body).await?))
}
/// The body with the path's campaign id, as the use case's input.
fn input<T: serde::de::DeserializeOwned>(body: Value, id: Uuid) -> Result<T, ApiError> {
    Ok(serde_json::from_value(with_id(body, id)?)
        .map_err(|e| jt_app::error::AppError::validation(e.to_string(), json!({})))?)
}
pub async fn campaign_approve(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_approve(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_decline(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_decline(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_pause(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_pause(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_resume(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_resume(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_end(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_end(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_update(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_update(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_release(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_release(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn plan_submit(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::plan_submit(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_move(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<AdCampaign>, ApiError> {
    Ok(Json(
        ads::campaign_move(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn campaign_claim(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Json<ClaimOut>, ApiError> {
    Ok(Json(
        ads::campaign_claim(&s.deps, &ctx, input(body, id)?).await?,
    ))
}
pub async fn ad_preview(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath((id, index)): ApiPath<(Uuid, usize)>,
    ApiQuery(q): ApiQuery<Value>,
) -> Result<Json<PreviewOut>, ApiError> {
    let body = super::studio::path_body(q, &[("campaign_id", json!(id)), ("index", json!(index))])?;
    let i = serde_json::from_value(body)
        .map_err(|e| jt_app::error::AppError::validation(e.to_string(), json!({})))?;
    Ok(Json(ads::ad_preview(&s.deps, &ctx, i).await?))
}
