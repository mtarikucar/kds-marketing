//! Tenant inbox repositories. JSON conversion is confined to typed PostgreSQL records; keys,
//! relationships, partial uniqueness and mutable state remain ordinary constrained columns.

use jt_app::error::AppError;
use jt_tenancy::WorkspaceId;
use sqlx::{PgConnection, postgres::PgQueryResult};
use uuid::Uuid;

macro_rules! one {
    ($q:expr, $this:expr, $ty:ty) => {{
        let row: Option<serde_json::Value> = $q
            .fetch_optional($this.tx.conn())
            .await
            .map_err(|e| super::map_sqlx(e, "read inbox row"))?;
        row.map(|v| {
            serde_json::from_value::<$ty>(v)
                .map_err(|_| AppError::internal("invalid stored inbox row"))
        })
        .transpose()
    }};
}
macro_rules! many {
    ($q:expr, $this:expr, $ty:ty) => {{
        let rows: Vec<serde_json::Value> = $q
            .fetch_all($this.tx.conn())
            .await
            .map_err(|e| super::map_sqlx(e, "list inbox rows"))?;
        rows.into_iter()
            .map(|v| {
                serde_json::from_value::<$ty>(v)
                    .map_err(|_| AppError::internal("invalid stored inbox row"))
            })
            .collect::<Result<Vec<$ty>, AppError>>()
    }};
}
macro_rules! value {
    ($v:expr) => {
        serde_json::to_value($v).map_err(|_| AppError::internal("cannot encode inbox row"))?
    };
}

pub(super) use super::{map_sqlx, same_workspace};

fn changed(done: PgQueryResult) -> Result<(), AppError> {
    if done.rows_affected() == 0 {
        Err(AppError::not_found("no such inbox row"))
    } else {
        Ok(())
    }
}
fn inserted(done: PgQueryResult) -> Result<(), AppError> {
    if done.rows_affected() == 0 {
        Err(AppError::conflict("inbox key is already taken"))
    } else {
        Ok(())
    }
}

/// Check tenant relationships before writing, matching the established repo NOT_FOUND contract.
pub(super) async fn reference(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    kind: &str,
    id: Uuid,
) -> Result<(), AppError> {
    let sql = match kind {
        "people" => "select 1 from people where workspace_id = $1 and id = $2",
        "conversations" => "select 1 from conversations where workspace_id = $1 and id = $2",
        "journeys" => "select 1 from journeys where workspace_id = $1 and id = $2",
        "capabilities" => "select 1 from capabilities where workspace_id = $1 and id = $2",
        "messages" => "select 1 from messages where workspace_id = $1 and id = $2",
        "inbound_events" => "select 1 from inbound_events where workspace_id = $1 and id = $2",
        "public_subjects" => "select 1 from public_subjects where workspace_id = $1 and id = $2",
        "studio_publications" => {
            "select 1 from studio_publications where workspace_id = $1 and id = $2"
        }
        _ => return Err(AppError::internal("unknown inbox reference")),
    };
    let found: Option<i32> = sqlx::query_scalar(sql)
        .bind(ws.as_uuid())
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(|e| map_sqlx(e, "find inbox reference"))?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such inbox reference"))
}

mod consumption;
mod conversations;
mod identities;
mod journeys;
pub(crate) mod lost_reasons;
mod merges;
mod messages;
mod outbox;
mod people;
mod public_cursors;
mod public_items;
mod public_subjects;
mod request_keys;
mod tasks_notes;

#[cfg(test)]
mod usecase_contracts;

/// The caller can pin the transaction's logical clock; direct repository users use wall time.
pub(super) async fn write_time(
    repos: &mut crate::uow::PgTenantRepos,
) -> Result<time::OffsetDateTime, AppError> {
    sqlx::query_scalar("select coalesce(nullif(current_setting('app.inbox_write_at',true), '')::timestamptz, clock_timestamp())")
        .fetch_one(repos.tx.conn()).await.map_err(|e| map_sqlx(e,"inbox write time"))
}
async fn touch_person(
    repos: &mut crate::uow::PgTenantRepos,
    id: jt_inbox::PersonId,
) -> Result<(), AppError> {
    let at = write_time(repos).await?;
    sqlx::query("update people set updated_at=greatest(updated_at+interval '1 microsecond',$3) where workspace_id=$1 and id=$2")
        .bind(repos.workspace_id().as_uuid()).bind(id.as_uuid()).bind(at)
        .execute(repos.tx.conn()).await.map_err(|e| map_sqlx(e,"touch person"))?;
    Ok(())
}
async fn touch_journey(
    repos: &mut crate::uow::PgTenantRepos,
    id: jt_inbox::JourneyId,
) -> Result<(), AppError> {
    let at = write_time(repos).await?;
    let parent: Option<Uuid> = sqlx::query_scalar("update journeys set updated_at=greatest(updated_at+interval '1 microsecond',$3) where workspace_id=$1 and id=$2 returning person_id")
        .bind(repos.workspace_id().as_uuid()).bind(id.as_uuid()).bind(at)
        .fetch_optional(repos.tx.conn()).await.map_err(|e| map_sqlx(e,"touch journey"))?;
    if let Some(id) = parent {
        touch_person(repos, id.into()).await?;
    }
    Ok(())
}
async fn touch_conversation(
    repos: &mut crate::uow::PgTenantRepos,
    id: jt_inbox::ConversationId,
) -> Result<(), AppError> {
    let at = write_time(repos).await?;
    let parent: Option<Uuid> = sqlx::query_scalar("update conversations set updated_at=greatest(updated_at+interval '1 microsecond',$3) where workspace_id=$1 and id=$2 returning person_id")
        .bind(repos.workspace_id().as_uuid()).bind(id.as_uuid()).bind(at)
        .fetch_optional(repos.tx.conn()).await.map_err(|e| map_sqlx(e,"touch conversation"))?;
    if let Some(id) = parent {
        touch_person(repos, id.into()).await?;
    }
    Ok(())
}

mod appointments;
mod attribution;
mod commissions;
mod consents;
mod erasure;
mod mail_cursors;
mod quotes;
mod suppressions;
