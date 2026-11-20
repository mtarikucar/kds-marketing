//! `/api/knowledge`: the knowledge base of the session's current workspace (design 2026-11-19
//! "Paylaşımlar and Bilgi bankası" §4): the owner's cards, Kurallar, Hedefler, the notes a
//! person writes to the agents and the agents' proposals.
//!
//! Reading needs `workspace.read` and seeds a workspace not seeded yet; every write is the
//! owner's page's: `team.manage` and a person in person (an agent's key is refused
//! `human_required`), with `budget.manage` for a cap and the role owner or manager for lowering
//! post approval, as the use cases check. A write answers what it changed (`200`), a new card or
//! note `201`. A stale revision is `409 CONFLICT` naming what changed (`card_changed`,
//! `rules_changed`, `goals_changed`, `proposal_superseded`, …); a value the knowledge base does
//! not take is `422 VALIDATION` naming its field.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jt_app::usecases::knowledge::cards::{
    self, CardArchiveInput, CardCreateInput, CardUpdateInput, HistoryOut,
};
use jt_app::usecases::knowledge::notes::{self, NoteAddInput, NoteWithdrawInput};
use jt_app::usecases::knowledge::proposals;
use jt_app::usecases::knowledge::read::{self, KnowledgeOut};
use jt_app::usecases::knowledge::rules::{
    self, GoalsInput, GoalsOut, PostApprovalInput, RulesInput, RulesOut,
};
use jt_knowledge::{Card, KnowledgeCardId, KnowledgeNoteId, KnowledgeProposalId, Note, Proposal};
use serde::Deserialize;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `GET /api/knowledge/cards/{card_id}/history?before=`: the page before the revision `before`
/// (the previous page's `next_before`), newest first.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    pub before: Option<u64>,
}

/// `200` with the knowledge base.
pub async fn get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<KnowledgeOut>, ApiError> {
    Ok(Json(read::knowledge_get(&state.deps, &ctx).await?))
}

/// `201` with the new card.
pub async fn card_create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<CardCreateInput>,
) -> Result<(StatusCode, Json<Card>), ApiError> {
    let card = cards::card_create(&state.deps, &ctx, body).await?;
    Ok((StatusCode::CREATED, Json(card)))
}

/// `200` with the card as it now is.
pub async fn card_update(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(card_id): ApiPath<KnowledgeCardId>,
    ApiJson(body): ApiJson<CardUpdateInput>,
) -> Result<Json<Card>, ApiError> {
    Ok(Json(
        cards::card_update(&state.deps, &ctx, card_id, body).await?,
    ))
}

/// `200` with the card removed (`archived: true`) or restored.
pub async fn card_archive(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(card_id): ApiPath<KnowledgeCardId>,
    ApiJson(body): ApiJson<CardArchiveInput>,
) -> Result<Json<Card>, ApiError> {
    Ok(Json(
        cards::card_archive(&state.deps, &ctx, card_id, body).await?,
    ))
}

/// `200` with one page of the card's revisions, newest first.
pub async fn card_history(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(card_id): ApiPath<KnowledgeCardId>,
    ApiQuery(query): ApiQuery<HistoryQuery>,
) -> Result<Json<HistoryOut>, ApiError> {
    Ok(Json(
        cards::card_history(&state.deps, &ctx, card_id, query.before).await?,
    ))
}

/// `200` with the rules box as stored, and how many ad campaigns a lowered ad budget stopped.
pub async fn rules_save(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<RulesInput>,
) -> Result<Json<RulesOut>, ApiError> {
    Ok(Json(rules::rules_save(&state.deps, &ctx, body).await?))
}

/// `200` with the goals as stored.
pub async fn goals_save(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<GoalsInput>,
) -> Result<Json<GoalsOut>, ApiError> {
    Ok(Json(rules::goals_save(&state.deps, &ctx, body).await?))
}

/// `200` with the rules box after one account went into or out of the approval list.
pub async fn post_approval_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<PostApprovalInput>,
) -> Result<Json<RulesOut>, ApiError> {
    Ok(Json(
        rules::post_approval_set(&state.deps, &ctx, body).await?,
    ))
}

/// `201` with the new note, open (a replay of its `request_key` answers the same note).
pub async fn note_add(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<NoteAddInput>,
) -> Result<(StatusCode, Json<Note>), ApiError> {
    let note = notes::note_add(&state.deps, &ctx, body).await?;
    Ok((StatusCode::CREATED, Json(note)))
}

/// `200` with the note taken back.
pub async fn note_withdraw(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(note_id): ApiPath<KnowledgeNoteId>,
    ApiJson(body): ApiJson<NoteWithdrawInput>,
) -> Result<Json<Note>, ApiError> {
    Ok(Json(
        notes::note_withdraw(&state.deps, &ctx, note_id, body).await?,
    ))
}

/// `200` with the proposal added.
pub async fn proposal_accept(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(proposal_id): ApiPath<KnowledgeProposalId>,
) -> Result<Json<Proposal>, ApiError> {
    Ok(Json(
        proposals::proposal_accept(&state.deps, &ctx, proposal_id).await?,
    ))
}

/// `200` with the proposal skipped.
pub async fn proposal_skip(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(proposal_id): ApiPath<KnowledgeProposalId>,
) -> Result<Json<Proposal>, ApiError> {
    Ok(Json(
        proposals::proposal_skip(&state.deps, &ctx, proposal_id).await?,
    ))
}
