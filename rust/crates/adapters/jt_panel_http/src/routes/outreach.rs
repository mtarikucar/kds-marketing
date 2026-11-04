//! `/api/outreach`: email outreach for a person in the panel (spec
//! `2026-10-30-leads-pool-outreach-design.md` §3.10–§3.16, §7.1). Every route answers `200` with
//! the JSON its MCP tool answers. `audience-preview` is `POST` although it only reads: its body
//! carries filters, which never go into a URL.

use axum::Json;
use axum::extract::State;
use jt_app::ports::outreach::EnrollmentRow;
use jt_app::usecases::outreach::{
    self, ApproveInput, CampaignListInput, CampaignListOut, CampaignOut, CampaignSaveInput,
    ControlInput, EnrollInput, EnrollOut, EnrollmentListInput, EnrollmentListOut, LaunchInput,
    PersonalizeInput, PersonalizeOut, PreviewInput, PreviewOut, SettingsInput, SettingsOut,
    StopInput, TemplateListInput, TemplateListOut, TemplateOut, TemplateSaveInput, TestSendInput,
    TestSendOut, report,
};
use jt_outreach::{CampaignId, EnrollmentId, TemplateId};

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `200` with a page of templates: `?include_archived&limit&before_at&before_id`.
pub async fn templates_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<TemplateListInput>,
) -> Result<Json<TemplateListOut>, ApiError> {
    Ok(Json(
        outreach::templates_list(&state.deps, &ctx, query).await?,
    ))
}

/// `200` with the saved template and what it uses; `409` for a stale revision.
pub async fn templates_save(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<TemplateSaveInput>,
) -> Result<Json<TemplateOut>, ApiError> {
    Ok(Json(
        outreach::templates_save(&state.deps, &ctx, body).await?,
    ))
}

/// `200` with the archived template.
pub async fn templates_archive(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<TemplateId>,
) -> Result<Json<TemplateOut>, ApiError> {
    Ok(Json(
        outreach::templates_archive(&state.deps, &ctx, id).await?,
    ))
}

/// `200` with a page of campaigns: `?status&limit&before_at&before_id`.
pub async fn campaigns_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<CampaignListInput>,
) -> Result<Json<CampaignListOut>, ApiError> {
    Ok(Json(
        outreach::campaigns_list(&state.deps, &ctx, query).await?,
    ))
}

/// `200` with the campaign.
pub async fn campaigns_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CampaignId>,
) -> Result<Json<CampaignOut>, ApiError> {
    Ok(Json(outreach::campaigns_get(&state.deps, &ctx, id).await?))
}

/// `200` with the saved campaign (the next revision of an existing one).
pub async fn campaigns_save(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CampaignSaveInput>,
) -> Result<Json<CampaignOut>, ApiError> {
    Ok(Json(
        outreach::campaigns_save(&state.deps, &ctx, body).await?,
    ))
}

/// `200` with what enrolling the audience would do now; writes nothing.
pub async fn audience_preview(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<PreviewInput>,
) -> Result<Json<PreviewOut>, ApiError> {
    Ok(Json(
        outreach::audience_preview(&state.deps, &ctx, body).await?,
    ))
}

/// `200` with the launched campaign; `403` while the platform switch is off.
pub async fn campaigns_launch(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CampaignId>,
    ApiJson(body): ApiJson<LaunchInput>,
) -> Result<Json<CampaignOut>, ApiError> {
    Ok(Json(
        outreach::campaigns_launch(&state.deps, &ctx, id, body).await?,
    ))
}

/// `200` with the approved campaign.
pub async fn campaigns_approve(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CampaignId>,
    ApiJson(body): ApiJson<ApproveInput>,
) -> Result<Json<CampaignOut>, ApiError> {
    Ok(Json(
        outreach::campaigns_approve(&state.deps, &ctx, id, body).await?,
    ))
}

/// `200` with the campaign paused, resumed or canceled.
pub async fn campaigns_control(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CampaignId>,
    ApiJson(body): ApiJson<ControlInput>,
) -> Result<Json<CampaignOut>, ApiError> {
    Ok(Json(
        outreach::campaigns_control(&state.deps, &ctx, id, body).await?,
    ))
}

/// `200` with what the enrollment did.
pub async fn enroll(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CampaignId>,
    ApiJson(body): ApiJson<EnrollInput>,
) -> Result<Json<EnrollOut>, ApiError> {
    Ok(Json(outreach::enroll(&state.deps, &ctx, id, body).await?))
}

/// `200` with a page of the campaign's enrollments: `?status&limit&after`, answering
/// `{items, next}`.
pub async fn enrollments_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CampaignId>,
    ApiQuery(query): ApiQuery<EnrollmentListInput>,
) -> Result<Json<EnrollmentListOut>, ApiError> {
    Ok(Json(
        outreach::enrollments_list(&state.deps, &ctx, id, query).await?,
    ))
}

/// `200` with the stopped enrollment (body `{}`); `409` when it is not active.
pub async fn enrollments_stop(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<EnrollmentId>,
    ApiJson(body): ApiJson<StopInput>,
) -> Result<Json<EnrollmentRow>, ApiError> {
    Ok(Json(
        outreach::enrollments_stop(&state.deps, &ctx, id, body).await?,
    ))
}

/// `200` with how many enrollments were personalized.
pub async fn personalize(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<PersonalizeInput>,
) -> Result<Json<PersonalizeOut>, ApiError> {
    Ok(Json(outreach::personalize(&state.deps, &ctx, body).await?))
}

/// `200` with the test email's state (body `{}`, or `{step}`); sent to the caller's own login
/// address only.
pub async fn test_send(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CampaignId>,
    ApiJson(body): ApiJson<TestSendInput>,
) -> Result<Json<TestSendOut>, ApiError> {
    Ok(Json(
        outreach::test_send(&state.deps, &ctx, id, body).await?,
    ))
}

/// `200` with outreach's report: `?campaign_id&from&to&group_by` (RFC 3339 instants;
/// `[from, to)`).
pub async fn report(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<report::ReportInput>,
) -> Result<Json<report::ReportOut>, ApiError> {
    Ok(Json(report::report(&state.deps, &ctx, query).await?))
}

/// `200` with the outreach settings.
pub async fn settings_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<SettingsOut>, ApiError> {
    Ok(Json(outreach::settings_get(&state.deps, &ctx).await?))
}

/// `200` with the settings after the change.
pub async fn settings_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<SettingsInput>,
) -> Result<Json<SettingsOut>, ApiError> {
    Ok(Json(outreach::settings_set(&state.deps, &ctx, body).await?))
}
