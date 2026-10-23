//! Inbox operations shared by the panel, MCP and trusted inbound consumers.
pub mod appointments;
pub mod commissions;
pub mod consent;
pub mod consumer;
pub mod context;
pub mod conversations;
pub mod dictionaries;
pub mod erasure;
pub mod journeys;
pub mod merge;
pub mod people;
pub mod quotes;
pub mod replies;
pub mod tasks;

use crate::{ctx::Ctx, error::AppError, ports::TenantRepos};
pub use jt_inbox::{ConversationId, JourneyId, MergeId, PersonId, TaskId};
use serde_json::Value;

pub(crate) async fn record(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    kind: &str,
    id: impl std::fmt::Display,
    payload: Value,
) -> Result<(), AppError> {
    let version = super::capabilities::version_in_force(repos).await?;
    super::capabilities::append(repos, ctx, action, kind, id, version, payload).await
}

pub mod schema;

/// An open opportunity takes precedence over newer closed history after a merge.
async fn active_or_latest_journey(
    r: &mut dyn TenantRepos,
    person: PersonId,
) -> Result<Option<jt_inbox::Journey>, AppError> {
    match r.journeys().open_for(person).await? {
        Some(journey) => Ok(Some(journey)),
        None => r.journeys().latest_for(person).await,
    }
}
