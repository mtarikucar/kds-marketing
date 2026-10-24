//! Studio controls use the same strict DTOs and services as MCP.
use crate::{
    error::{ApiError, ApiJson},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::ports::studio::StudioControl;
use jt_app::usecases::studio::control::{
    self, ApprovalInput, ApprovalOut, BrakeInput, StudioPolicyInput,
};
pub async fn brake(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<BrakeInput>,
) -> Result<Json<StudioControl>, ApiError> {
    Ok(Json(control::brake(&s.deps, &ctx, body).await?))
}
pub async fn policy_set(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<StudioPolicyInput>,
) -> Result<Json<StudioControl>, ApiError> {
    Ok(Json(control::policy_set(&s.deps, &ctx, body).await?))
}
pub async fn approve(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<ApprovalInput>,
) -> Result<Json<ApprovalOut>, ApiError> {
    Ok(Json(control::approve(&s.deps, &ctx, body).await?))
}

use crate::error::{ApiPath, ApiQuery};
use jt_app::ports::studio::SlotId;
use jt_app::usecases::studio::{trends, work};
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelBody {
    pub expected_revision: u64,
    pub reason: String,
}
pub async fn pending(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(_): ApiQuery<work::EmptyInput>,
) -> Result<Json<work::PendingStudioOut>, ApiError> {
    Ok(Json(work::pending(&s.deps, &ctx).await?))
}
pub async fn slot_get(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<SlotId>,
    ApiQuery(_): ApiQuery<work::EmptyInput>,
) -> Result<Json<work::SlotOut>, ApiError> {
    Ok(Json(work::slot_get(&s.deps, &ctx, id).await?))
}
pub async fn slot_cancel(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<SlotId>,
    ApiJson(body): ApiJson<CancelBody>,
) -> Result<Json<work::SlotOut>, ApiError> {
    Ok(Json(
        work::slot_cancel(
            &s.deps,
            &ctx,
            work::CancelSlotInput {
                slot_id: id,
                expected_revision: body.expected_revision,
                reason: body.reason,
            },
        )
        .await?,
    ))
}
pub async fn trend_record(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<trends::TrendInput>,
) -> Result<Json<jt_app::ports::studio::TrendSignal>, ApiError> {
    Ok(Json(trends::trend_record(&s.deps, &ctx, body).await?))
}
pub async fn hypothesis_propose(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<jt_strategy::HypothesisInput>,
) -> Result<Json<trends::HypothesisProposalOut>, ApiError> {
    Ok(Json(trends::hypothesis_propose(&s.deps, &ctx, body).await?))
}

pub async fn file_upload(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<jt_app::usecases::studio::files::FileUploadInput>,
) -> Result<Json<jt_app::ports::files::StoredFile>, ApiError> {
    Ok(Json(
        jt_app::usecases::studio::files::file_upload(&s.deps, &ctx, body).await?,
    ))
}
pub async fn piece_submit(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<SlotId>,
    ApiJson(mut body): ApiJson<serde_json::Value>,
) -> Result<Json<work::SlotOut>, ApiError> {
    let object = body.as_object_mut().ok_or_else(|| {
        jt_app::error::AppError::validation("expected object", serde_json::json!({}))
    })?;
    if object.contains_key("slot_id") {
        return Err(jt_app::error::AppError::validation(
            "slot_id is a path parameter",
            serde_json::json!({}),
        )
        .into());
    }
    object.insert("slot_id".into(), serde_json::json!(id));
    let input = serde_json::from_value(body).map_err(|_| {
        jt_app::error::AppError::validation("invalid piece input", serde_json::json!({}))
    })?;
    Ok(Json(
        jt_app::usecases::studio::pieces::piece_submit(&s.deps, &ctx, input).await?,
    ))
}

pub async fn learned(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<jt_app::usecases::studio::learning::LearnedQuery>,
) -> Result<Json<jt_app::usecases::studio::learning::LearnedOut>, ApiError> {
    Ok(Json(
        jt_app::usecases::studio::learning::learned(&s.deps, &ctx, q).await?,
    ))
}
pub async fn judgment_record(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(i): ApiJson<jt_app::usecases::studio::learning::JudgmentInput>,
) -> Result<Json<jt_app::usecases::studio::learning::JudgmentOut>, ApiError> {
    Ok(Json(
        jt_app::usecases::studio::learning::judgment_record(&s.deps, &ctx, i).await?,
    ))
}

use jt_app::usecases::studio::ads;
pub async fn adsets_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(body): ApiQuery<ads::AdSetsQuery>,
) -> Result<Json<Vec<jt_app::ports::connectors::AdSet>>, ApiError> {
    Ok(Json(ads::adsets_list(&s.deps, &ctx, body).await?))
}
pub async fn adset_bind(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<ads::BindAdSetInput>,
) -> Result<Json<jt_app::ports::studio::AdSetBinding>, ApiError> {
    Ok(Json(ads::adset_bind(&s.deps, &ctx, body).await?))
}
pub async fn budget_move(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<ads::BudgetMoveInput>,
) -> Result<Json<ads::BudgetMoveOut>, ApiError> {
    Ok(Json(ads::budget_move(&s.deps, &ctx, body).await?))
}

use jt_app::usecases::studio::views;
pub async fn overview(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(input): ApiQuery<views::StudioQuery>,
) -> Result<Json<views::StudioOverview>, ApiError> {
    Ok(Json(views::overview(&s.deps, &ctx, input).await?))
}
pub async fn ledger(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(input): ApiQuery<views::StudioLedgerQuery>,
) -> Result<Json<views::StudioLedgerPage>, ApiError> {
    Ok(Json(views::ledger(&s.deps, &ctx, input).await?))
}
pub async fn ledger_export(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<views::StudioLedgerExportInput>,
) -> Result<Json<views::LedgerExportOut>, ApiError> {
    Ok(Json(views::ledger_export(&s.deps, &ctx, input).await?))
}
