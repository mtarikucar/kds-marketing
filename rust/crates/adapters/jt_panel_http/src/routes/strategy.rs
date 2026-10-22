//! `/api/strategy`: the strategy of the session's current workspace and the consultation that
//! works it out (spec §5).
//!
//! Reading answers the approved version and the draft with its gaps; the consultation opens a
//! draft, records questions, answers, assumptions and notes, writes sections and hypotheses and
//! submits; an owner or a manager approves, or archives the version in force by naming it. Every
//! write answers the draft as it now stands (`200`), but recording an entry, which answers its
//! id (`201`), and archiving, which answers the confirmation `{version_id, archived: true}`
//! (`200`), exactly as `jeeta.strategy.archive` does. A request that is not valid,
//! a draft not ready for approval among them, is `422 VALIDATION` with `details.gaps` where the
//! use case lists them.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jt_app::usecases::strategy::{
    self, ArchiveInput, DEFAULT_CONSULTATION_PAGE, RecordInput, RecordKind, StrategyOut,
    VersionOut, VersionSummary,
};
use jt_strategy::{ConsultationEntry, ConsultationEntryId, StrategyVersionId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `POST /api/strategy/consultation/entries`.
#[derive(Deserialize)]
pub struct RecordBody {
    pub kind: RecordKind,
    /// The section the entry is about, if any.
    #[serde(default)]
    pub section_key: Option<String>,
    pub text: String,
}

/// The answer to recording an entry.
#[derive(Serialize)]
pub struct RecordedBody {
    pub id: ConsultationEntryId,
}

/// The answer to archiving, as `jeeta.strategy.archive` answers it.
#[derive(Serialize)]
pub struct ArchivedBody {
    pub version_id: StrategyVersionId,
    /// Always `true`.
    pub archived: bool,
}

/// `POST /api/strategy/archive`: the approved version meant, and the confirmation (missing reads
/// as `false`, which is refused).
#[derive(Deserialize)]
pub struct ArchiveBody {
    pub version_id: StrategyVersionId,
    #[serde(default)]
    pub confirm: bool,
}

/// `GET /api/strategy/versions/{version_id}/consultation?limit=&before_at=&before_id=`; every
/// parameter is optional, but `before_at` and `before_id` (the previous page's last entry) come
/// together.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsultationQuery {
    /// At most this many entries: default 50, at most 500 (a larger value is capped).
    pub limit: Option<u32>,
    /// The `at` of the previous page's last entry.
    pub before_at: Option<String>,
    /// The `id` of the previous page's last entry.
    pub before_id: Option<ConsultationEntryId>,
}

/// `200` with the approved version, the draft and the draft's gaps.
pub async fn get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<StrategyOut>, ApiError> {
    Ok(Json(strategy::get(&state.deps, &ctx).await?))
}

/// `200` with the open draft: a new one, or the one already open.
pub async fn start_consultation(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<VersionOut>, ApiError> {
    Ok(Json(strategy::start_consultation(&state.deps, &ctx).await?))
}

/// `201` with the new entry's id.
pub async fn record(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<RecordBody>,
) -> Result<(StatusCode, Json<RecordedBody>), ApiError> {
    let input = RecordInput {
        kind: body.kind,
        section_key: body.section_key,
        text: body.text,
    };
    let id = strategy::record(&state.deps, &ctx, input).await?;
    Ok((StatusCode::CREATED, Json(RecordedBody { id })))
}

/// `200` with the draft after writing the section named in the path; the body is the section's
/// value as it is stored (an object, a list or a flag).
pub async fn write_section(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(section_key): ApiPath<String>,
    ApiJson(value): ApiJson<Value>,
) -> Result<Json<VersionOut>, ApiError> {
    Ok(Json(
        strategy::write_section(&state.deps, &ctx, section_key, value).await?,
    ))
}

/// `200` with the draft after replacing its hypotheses; the body is the list of hypotheses as
/// written (each with its `id` when kept, without one when new).
pub async fn set_hypotheses(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(hypotheses): ApiJson<Value>,
) -> Result<Json<VersionOut>, ApiError> {
    Ok(Json(
        strategy::set_hypotheses(&state.deps, &ctx, hypotheses).await?,
    ))
}

/// `200` with the submitted draft.
pub async fn submit(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<VersionOut>, ApiError> {
    Ok(Json(strategy::submit(&state.deps, &ctx).await?))
}

/// `200` with the version now in force.
pub async fn approve(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<VersionOut>, ApiError> {
    Ok(Json(strategy::approve(&state.deps, &ctx).await?))
}

/// `200` with `{version_id, archived: true}`: the named version is archived and the workspace has
/// no strategy in force.
pub async fn archive(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<ArchiveBody>,
) -> Result<Json<ArchivedBody>, ApiError> {
    let input = ArchiveInput {
        version_id: body.version_id,
        confirm: body.confirm,
    };
    strategy::archive(&state.deps, &ctx, input).await?;
    Ok(Json(ArchivedBody {
        version_id: body.version_id,
        archived: true,
    }))
}

/// `200` with every version, newest first.
pub async fn list_versions(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Vec<VersionSummary>>, ApiError> {
    Ok(Json(strategy::list_versions(&state.deps, &ctx).await?))
}

/// `200` with one page of the version's consultation log, newest first.
pub async fn consultation(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(version_id): ApiPath<StrategyVersionId>,
    ApiQuery(query): ApiQuery<ConsultationQuery>,
) -> Result<Json<Vec<ConsultationEntry>>, ApiError> {
    let before = strategy::consultation_cursor(query.before_at.as_deref(), query.before_id)?;
    let limit = query.limit.unwrap_or(DEFAULT_CONSULTATION_PAGE);
    Ok(Json(
        strategy::consultation(&state.deps, &ctx, version_id, limit, before).await?,
    ))
}
