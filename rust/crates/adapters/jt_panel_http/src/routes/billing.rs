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

pub async fn activate(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    input: Result<ApiJson<billing::ActivateInput>, ApiError>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    // Parsing diagnostics can contain submitted secrets. Every invalid body spends a guess
    // against a usable challenge and receives the same sanitized validation error.
    let input = input
        .map(|ApiJson(input)| input)
        .unwrap_or(billing::ActivateInput {
            code: String::new(),
        });
    let result = billing::activate(&state.deps, &ctx, input)
        .await
        .map(Json)
        .map_err(ApiError::from);
    ([(axum::http::header::CACHE_CONTROL, "no-store")], result).into_response()
}
