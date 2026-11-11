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

use jt_app::usecases::studio::tiktok;
/// The TikTok posting screen's publish button: the choice, for the slot of the path.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TiktokPostBody {
    pub expected_revision: u64,
    pub post: jt_app::ports::connectors::TiktokPost,
}
pub async fn tiktok_posting(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<SlotId>,
    ApiQuery(_): ApiQuery<work::EmptyInput>,
) -> Result<Json<tiktok::TiktokPostingOut>, ApiError> {
    Ok(Json(tiktok::tiktok_posting(&s.deps, &ctx, id).await?))
}
pub async fn tiktok_metrics(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<SlotId>,
    ApiQuery(_): ApiQuery<work::EmptyInput>,
) -> Result<Json<tiktok::TiktokMetricsOut>, ApiError> {
    Ok(Json(tiktok::tiktok_metrics(&s.deps, &ctx, id).await?))
}
pub async fn tiktok_post(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<SlotId>,
    ApiJson(body): ApiJson<TiktokPostBody>,
) -> Result<Json<ApprovalOut>, ApiError> {
    Ok(Json(
        tiktok::tiktok_post(
            &s.deps,
            &ctx,
            tiktok::TiktokPostInput {
                slot_id: id,
                expected_revision: body.expected_revision,
                post: body.post,
            },
        )
        .await?,
    ))
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

// The materials library (spec 2026-11-03 §5.2): every route answers the JSON its MCP tool answers
// (a list as a bare array); the panel-only ones are a human's decisions (D4).
use jt_app::ports::materials::{CalendarEntry, Material, MaterialId, MaterialPolicy, Olay, OlayId};
use jt_app::ports::materials::{ShootRequest, ShootRequestId};
use jt_app::usecases::studio::library;

/// The JSON `body` with the path's `fields` added, read as `T`: a path field in the body is
/// `VALIDATION`.
fn path_body<T: serde::de::DeserializeOwned>(
    mut body: serde_json::Value,
    fields: &[(&str, serde_json::Value)],
) -> Result<T, ApiError> {
    let object = body.as_object_mut().ok_or_else(|| {
        jt_app::error::AppError::validation("expected object", serde_json::json!({}))
    })?;
    for (field, value) in fields {
        if object.contains_key(*field) {
            return Err(jt_app::error::AppError::validation(
                format!("{field} is a path parameter"),
                serde_json::json!({ "field": field }),
            )
            .into());
        }
        object.insert((*field).to_owned(), value.clone());
    }
    Ok(serde_json::from_value(body).map_err(jt_app::error::AppError::from)?)
}

pub async fn olays_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<library::OlaysQuery>,
) -> Result<Json<Vec<library::OlayListItem>>, ApiError> {
    Ok(Json(library::olays_list(&s.deps, &ctx, q).await?))
}
pub async fn olay_get(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(olay_id): ApiPath<OlayId>,
    ApiQuery(_): ApiQuery<work::EmptyInput>,
) -> Result<Json<library::OlayDetail>, ApiError> {
    Ok(Json(
        library::olay_get(&s.deps, &ctx, library::OlayIdInput { olay_id }).await?,
    ))
}
pub async fn olay_create(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<library::OlayCreateInput>,
) -> Result<Json<Olay>, ApiError> {
    Ok(Json(library::olay_create(&s.deps, &ctx, body).await?))
}
pub async fn olay_update(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<OlayId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<Olay>, ApiError> {
    let input = path_body(body, &[("olay_id", serde_json::json!(id))])?;
    Ok(Json(library::olay_update(&s.deps, &ctx, input).await?))
}
/// A human owner or manager confirms a proposed olay (`{expected_revision}`).
pub async fn olay_confirm(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<OlayId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<Olay>, ApiError> {
    let input = path_body(body, &[("olay_id", serde_json::json!(id))])?;
    Ok(Json(library::olay_confirm(&s.deps, &ctx, input).await?))
}
pub async fn materials_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<library::MaterialsQuery>,
) -> Result<Json<Vec<Material>>, ApiError> {
    Ok(Json(library::materials_list(&s.deps, &ctx, q).await?))
}
pub async fn material_get(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(material_id): ApiPath<MaterialId>,
    ApiQuery(_): ApiQuery<work::EmptyInput>,
) -> Result<Json<library::MaterialDetail>, ApiError> {
    Ok(Json(
        library::material_get(&s.deps, &ctx, library::MaterialIdInput { material_id }).await?,
    ))
}
pub async fn material_add(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<library::MaterialAddInput>,
) -> Result<Json<library::MaterialAddOut>, ApiError> {
    Ok(Json(library::material_add(&s.deps, &ctx, body).await?))
}
pub async fn material_tag(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MaterialId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<Material>, ApiError> {
    let input = path_body(body, &[("material_id", serde_json::json!(id))])?;
    Ok(Json(library::material_tag(&s.deps, &ctx, input).await?))
}
/// A human owner or manager sets the share permission (`{expected_revision, permission}`).
pub async fn material_permission(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MaterialId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<Material>, ApiError> {
    let input = path_body(body, &[("material_id", serde_json::json!(id))])?;
    Ok(Json(
        library::material_permission(&s.deps, &ctx, input).await?,
    ))
}
/// A human owner or manager frees a real material, or takes it back (`{expected_revision, free}`).
pub async fn material_free(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MaterialId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<Material>, ApiError> {
    let input = path_body(body, &[("material_id", serde_json::json!(id))])?;
    Ok(Json(library::material_free(&s.deps, &ctx, input).await?))
}
/// A human owner or manager binds a material to another olay or genel
/// (`{expected_revision, binding}`).
pub async fn material_bind(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MaterialId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<Material>, ApiError> {
    let input = path_body(body, &[("material_id", serde_json::json!(id))])?;
    Ok(Json(library::material_bind(&s.deps, &ctx, input).await?))
}
/// A human owner or manager deletes a material (`{expected_revision, confirm: true}`).
pub async fn material_delete(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MaterialId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<Material>, ApiError> {
    let input = path_body(body, &[("material_id", serde_json::json!(id))])?;
    Ok(Json(library::material_delete(&s.deps, &ctx, input).await?))
}
pub async fn slot_materials(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(slot_id): ApiPath<SlotId>,
    ApiQuery(_): ApiQuery<work::EmptyInput>,
) -> Result<Json<library::SlotMaterialsOut>, ApiError> {
    Ok(Json(
        library::slot_materials(&s.deps, &ctx, library::SlotMaterialsInput { slot_id }).await?,
    ))
}
pub async fn calendar_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<library::CalendarQuery>,
) -> Result<Json<library::CalendarOut>, ApiError> {
    Ok(Json(library::calendar_list(&s.deps, &ctx, q).await?))
}
/// A human owner or manager edits a year's calendar entry or enters its dates.
pub async fn calendar_set(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath((key, year)): ApiPath<(String, i32)>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<CalendarEntry>, ApiError> {
    let input = path_body(
        body,
        &[
            ("key", serde_json::json!(key)),
            ("year", serde_json::json!(year)),
        ],
    )?;
    Ok(Json(library::calendar_set(&s.deps, &ctx, input).await?))
}
/// A human owner or manager sets the materials policy (`{lead_days, reuse_days, recap_days}`).
pub async fn material_policy_set(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<MaterialPolicy>,
) -> Result<Json<MaterialPolicy>, ApiError> {
    Ok(Json(
        library::material_policy_set(&s.deps, &ctx, body).await?,
    ))
}
/// A human owner or manager releases the caption findings of the slot's piece at its revision
/// (`{expected_revision, digest}`, the digest its `material_check` shows).
pub async fn material_check_release(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<SlotId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<work::SlotOut>, ApiError> {
    let input = path_body(body, &[("slot_id", serde_json::json!(id))])?;
    Ok(Json(
        jt_app::usecases::studio::materials::material_check_release(&s.deps, &ctx, input).await?,
    ))
}
pub async fn shoot_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<library::ShootQuery>,
) -> Result<Json<Vec<ShootRequest>>, ApiError> {
    Ok(Json(library::shoot_list(&s.deps, &ctx, q).await?))
}
pub async fn shoot_request(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<library::ShootRequestInput>,
) -> Result<Json<ShootRequest>, ApiError> {
    Ok(Json(library::shoot_request(&s.deps, &ctx, body).await?))
}
pub async fn shoot_resolve(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ShootRequestId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<ShootRequest>, ApiError> {
    let input = path_body(body, &[("request_id", serde_json::json!(id))])?;
    Ok(Json(library::shoot_resolve(&s.deps, &ctx, input).await?))
}

use jt_app::ports::posts::{PackageRequest, PackageRequestId, PostingSettings};
use jt_app::usecases::studio::posts;
pub async fn post_requests(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<posts::PackageQuery>,
) -> Result<Json<Vec<PackageRequest>>, ApiError> {
    Ok(Json(posts::post_requests(&s.deps, &ctx, q).await?))
}
/// An answer to the package request of the path: `{request_key, posts}`.
pub async fn posts_propose(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PackageRequestId>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> Result<Json<posts::PackageProposalOut>, ApiError> {
    let input = path_body(body, &[("request_id", serde_json::json!(id))])?;
    Ok(Json(posts::posts_propose(&s.deps, &ctx, input).await?))
}
pub async fn posts_list(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<posts::PostsQuery>,
) -> Result<Json<posts::PostsOut>, ApiError> {
    Ok(Json(posts::posts_list(&s.deps, &ctx, q).await?))
}
pub async fn weekly_summary(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(q): ApiQuery<posts::SummaryQuery>,
) -> Result<Json<posts::WeeklySummaryOut>, ApiError> {
    Ok(Json(posts::weekly_summary(&s.deps, &ctx, q).await?))
}
/// A human owner or manager sets the posting policy (`{policy, tz}`).
pub async fn posting_policy_set(
    State(s): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<PostingSettings>,
) -> Result<Json<PostingSettings>, ApiError> {
    Ok(Json(posts::posting_policy_set(&s.deps, &ctx, body).await?))
}
