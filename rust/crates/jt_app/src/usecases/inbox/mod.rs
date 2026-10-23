//! Inbox operations shared by the panel, MCP and trusted inbound consumers.
pub mod consumer;
pub mod context;
pub mod conversations;
pub mod dictionaries;
pub mod journeys;
pub mod merge;
pub mod people;
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
