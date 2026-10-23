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
            .collect()
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
async fn reference(
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
mod request_keys;
mod tasks_notes;

#[cfg(test)]
mod usecase_contracts;
