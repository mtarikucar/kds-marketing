//! Strategy-gated inbox routes; bodies and outputs are shared with MCP.
use crate::{
    error::{ApiError, ApiJson, ApiPath, ApiQuery},
    session::WorkspaceCtx,
    state::AppState,
};
use axum::{Json, extract::State};
use jt_app::usecases::inbox::{
    JourneyId, MergeId, PersonId, TaskId, dictionaries, journeys, merge, people, tasks,
};
use serde_json::Value;

fn to_json(value: &impl serde::Serialize) -> Result<Json<Value>, ApiError> {
    let bytes = serde_json::to_vec(value).map_err(jt_app::error::AppError::from)?;
    Ok(Json(
        serde_json::from_slice(&bytes).map_err(jt_app::error::AppError::from)?,
    ))
}
pub async fn people_search(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(input): ApiQuery<people::SearchInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::search(&state.deps, &ctx, input).await?)
}
pub async fn people_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::get(&state.deps, &ctx, id).await?)
}
pub async fn people_create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<people::CreateInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::create(&state.deps, &ctx, input).await?)
}
pub async fn identities_add(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
    ApiJson(input): ApiJson<people::IdentityInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&people::add_identity(&state.deps, &ctx, id, input).await?)
}
pub async fn journeys_open(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::open(&state.deps, &ctx, id).await?)
}
pub async fn events_report(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<journeys::ReportInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::report(&state.deps, &ctx, id, input).await?)
}
pub async fn lost_reasons_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Value>, ApiError> {
    to_json(&dictionaries::list_lost_reasons(&state.deps, &ctx).await?)
}
pub async fn lost_reasons_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<dictionaries::LostReasonInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&dictionaries::set_lost_reason(&state.deps, &ctx, input).await?)
}
pub async fn journeys_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::get(&state.deps, &ctx, id).await?)
}
pub async fn journeys_assign_owner(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<journeys::AssignOwnerInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&journeys::assign_owner(&state.deps, &ctx, id, input).await?)
}

/// Replace workspace status label overrides; unknown stage keys are VALIDATION.
pub async fn status_labels_set(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(input): ApiJson<dictionaries::StatusLabelsInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&dictionaries::set_status_labels(&state.deps, &ctx, input).await?)
}

pub async fn merges_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Value>, ApiError> {
    to_json(&merge::list(&state.deps, &ctx).await?)
}

pub async fn merges_apply(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MergeId>,
    ApiJson(input): ApiJson<merge::ApplyInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&merge::apply(&state.deps, &ctx, id, input).await?)
}

pub async fn merges_undo(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MergeId>,
    ApiJson(input): ApiJson<merge::UndoInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&merge::undo(&state.deps, &ctx, id, input).await?)
}

pub async fn merges_refuse(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<MergeId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&merge::refuse(&state.deps, &ctx, id).await?)
}

pub async fn tasks_create(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<tasks::CreateInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&tasks::create(&state.deps, &ctx, id, input).await?)
}

pub async fn tasks_complete(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<TaskId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&tasks::complete(&state.deps, &ctx, id).await?)
}

pub async fn tasks_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(input): ApiQuery<tasks::ListInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&tasks::list(&state.deps, &ctx, input).await?)
}

pub async fn notes_add(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<tasks::NoteInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&tasks::add_note(&state.deps, &ctx, id, input).await?)
}

use jt_app::usecases::inbox::{ConversationId, conversations, replies};
pub async fn conversations_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(input): ApiQuery<conversations::ListInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::list(&state.deps, &ctx, input).await?)
}
pub async fn conversations_get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::get(&state.deps, &ctx, id).await?)
}
pub async fn messages_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
    ApiQuery(input): ApiQuery<conversations::MessagesInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::messages(&state.deps, &ctx, id, input).await?)
}
pub async fn take_over(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::take_over(&state.deps, &ctx, id).await?)
}
pub async fn hand_to_agent(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::hand_to_agent(&state.deps, &ctx, id).await?)
}
pub async fn snooze(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
    ApiJson(input): ApiJson<conversations::SnoozeInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::snooze(&state.deps, &ctx, id, input).await?)
}
pub async fn unsnooze(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::unsnooze(&state.deps, &ctx, id).await?)
}
pub async fn close(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&conversations::close(&state.deps, &ctx, id).await?)
}
pub async fn reply(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<ConversationId>,
    ApiJson(input): ApiJson<replies::ReplyInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&replies::reply(&state.deps, &ctx, id, input).await?)
}

/// Read queues without a strategy; the normal workspace status gate still runs.
pub async fn pending(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
) -> Result<Json<Value>, ApiError> {
    to_json(&jt_app::usecases::inbox::context::pending(&state.deps, &ctx).await?)
}
pub async fn context(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<jt_app::usecases::inbox::ConversationId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&jt_app::usecases::inbox::context::context(&state.deps, &ctx, id).await?)
}

use jt_app::usecases::inbox::consent;
pub async fn consent_record(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
    ApiJson(input): ApiJson<consent::RecordInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&consent::record_consent(&state.deps, &ctx, id, input).await?)
}
pub async fn consent_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&consent::list(&state.deps, &ctx, id).await?)
}
pub async fn suppressions_add(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
    ApiJson(input): ApiJson<consent::SuppressionInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&consent::add_suppression(&state.deps, &ctx, id, input).await?)
}
pub async fn suppressions_remove(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath((id, channel, reason)): ApiPath<(
        PersonId,
        consent::Channel,
        consent::SuppressionReason,
    )>,
) -> Result<Json<Value>, ApiError> {
    to_json(
        &consent::remove_suppression(
            &state.deps,
            &ctx,
            id,
            consent::SuppressionInput { channel, reason },
        )
        .await?,
    )
}
pub async fn send(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<PersonId>,
    ApiJson(input): ApiJson<jt_app::usecases::inbox::replies::SendInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&jt_app::usecases::inbox::replies::send(&state.deps, &ctx, id, input).await?)
}

use jt_app::usecases::inbox::{appointments, quotes};
pub async fn quotes_send(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<quotes::SendInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&quotes::send(&state.deps, &ctx, id, input).await?)
}
pub async fn quotes_accept(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<uuid::Uuid>,
) -> Result<Json<Value>, ApiError> {
    to_json(&quotes::accept(&state.deps, &ctx, id).await?)
}
pub async fn quotes_list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
) -> Result<Json<Value>, ApiError> {
    to_json(&quotes::list(&state.deps, &ctx, id).await?)
}
pub async fn appointments_book(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<JourneyId>,
    ApiJson(input): ApiJson<appointments::BookInput>,
) -> Result<Json<Value>, ApiError> {
    to_json(&appointments::book(&state.deps, &ctx, id, input).await?)
}
pub async fn appointments_cancel(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<uuid::Uuid>,
) -> Result<Json<Value>, ApiError> {
    to_json(&appointments::cancel(&state.deps, &ctx, id).await?)
}
pub async fn appointments_held(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<uuid::Uuid>,
) -> Result<Json<Value>, ApiError> {
    to_json(&appointments::held(&state.deps, &ctx, id).await?)
}
