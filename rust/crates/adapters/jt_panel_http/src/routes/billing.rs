//! Tenant payment status and evidence-only bank-transfer reports.
use crate::{
    error::{ApiError, ApiJson},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::usecases::billing::{self, BillingStatusOut, PaymentOut, ReportPaymentInput};

pub async fn status(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<BillingStatusOut>, ApiError> {
    Ok(Json(billing::status(&state.deps, &ctx).await?))
}
pub async fn report_payment(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<ReportPaymentInput>,
) -> Result<Json<PaymentOut>, ApiError> {
    Ok(Json(
        billing::report_payment(&state.deps, &ctx, input).await?,
    ))
}
