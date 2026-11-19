//! `agent_connections`: agent clients seen through a workspace's API keys, one per (key, client
//! name, client version); and `agent_wakes`, each key's wake row (`0045_agent_wake`): its
//! document in `data`, its sealed token in `sealed` (read only by `wake_sealed`), and the time
//! its pending wake goes out in `due_at`, which `workspaces_with_due_wakes` is the one
//! platform-wide read of.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::wake::AgentWakeRow;
use jt_app::ports::{AgentConnectionRepo, AgentConnectionRow};
use jt_tenancy::{AgentConnectionId, ApiKeyId, WorkspaceId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{dangling, map_sqlx, same_workspace};
use crate::tx::PlatformTx;
use crate::uow::PgTenantRepos;

/// A stored wake document as the application reads it; one that does not parse is `INTERNAL`.
fn wake_of(data: serde_json::Value) -> Result<AgentWakeRow, AppError> {
    serde_json::from_value(data).map_err(|_| AppError::internal("invalid stored agent wake"))
}

/// The workspaces with a wake due at `now`, in id order (see
/// `PlatformRepos::workspaces_with_due_wakes`).
pub(crate) async fn workspaces_with_due_wakes(
    tx: &mut PlatformTx<'_>,
    now: OffsetDateTime,
) -> Result<Vec<WorkspaceId>, AppError> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        // archtest: platform-wide
        "select distinct w.workspace_id from agent_wakes w where w.due_at is not null          and w.due_at <= $1 order by w.workspace_id",
    )
    .bind(now)
    .fetch_all(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "list workspaces with a due wake"))?;
    Ok(ids.into_iter().map(WorkspaceId).collect())
}

#[derive(sqlx::FromRow)]
struct AgentConnectionRecord {
    id: Uuid,
    workspace_id: Uuid,
    api_key_id: Uuid,
    client_name: String,
    client_version: String,
    protocol_version: String,
    first_seen_at: OffsetDateTime,
    last_seen_at: OffsetDateTime,
    tool_calls: i64,
}

impl From<AgentConnectionRecord> for AgentConnectionRow {
    fn from(r: AgentConnectionRecord) -> AgentConnectionRow {
        AgentConnectionRow {
            id: AgentConnectionId(r.id),
            workspace_id: WorkspaceId(r.workspace_id),
            api_key_id: ApiKeyId(r.api_key_id),
            client_name: r.client_name,
            client_version: r.client_version,
            protocol_version: r.protocol_version,
            first_seen_at: r.first_seen_at,
            last_seen_at: r.last_seen_at,
            tool_calls: r.tool_calls,
        }
    }
}

#[async_trait]
impl AgentConnectionRepo for PgTenantRepos {
    /// One statement inserts or, on the (key, client name, client version) key, updates
    /// `last_seen_at` and `protocol_version`; `xmax = 0` tells a fresh row from an updated one.
    /// The API key must belong to this workspace (foreign keys ignore row-level security), else
    /// `INTERNAL`.
    async fn upsert_on_initialize(
        &mut self,
        row: AgentConnectionRow,
    ) -> Result<(AgentConnectionId, bool), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        let key: Option<i32> =
            sqlx::query_scalar("select 1 from api_keys where workspace_id = $1 and id = $2")
                .bind(ws.as_uuid())
                .bind(row.api_key_id.as_uuid())
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "find API key"))?;
        if key.is_none() {
            return Err(dangling("agent_connections.api_key_id"));
        }
        let stored: Option<(Uuid, bool)> = sqlx::query_as(
            "insert into agent_connections (id, workspace_id, api_key_id, client_name, \
             client_version, protocol_version, first_seen_at, last_seen_at, tool_calls) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             on conflict (api_key_id, client_name, client_version) do update \
             set last_seen_at = excluded.last_seen_at, \
             protocol_version = excluded.protocol_version \
             where agent_connections.workspace_id = excluded.workspace_id \
             returning id, (xmax = 0) as created",
        )
        .bind(row.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(row.api_key_id.as_uuid())
        .bind(&row.client_name)
        .bind(&row.client_version)
        .bind(&row.protocol_version)
        .bind(row.first_seen_at)
        .bind(row.last_seen_at)
        .bind(row.tool_calls)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "upsert agent connection"))?;
        let (id, created) =
            stored.ok_or_else(|| AppError::internal("the agent connection belongs elsewhere"))?;
        Ok((AgentConnectionId(id), created))
    }

    async fn touch_tool_call(
        &mut self,
        id: AgentConnectionId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query(
            "update agent_connections set tool_calls = tool_calls + 1, last_seen_at = $3 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count agent tool call"))?;
        Ok(())
    }

    async fn list(&mut self) -> Result<Vec<AgentConnectionRow>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<AgentConnectionRecord> = sqlx::query_as(
            "select id, workspace_id, api_key_id, client_name, client_version, protocol_version, \
             first_seen_at, last_seen_at, tool_calls from agent_connections \
             where workspace_id = $1 order by first_seen_at, id",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list agent connections"))?;
        Ok(records.into_iter().map(AgentConnectionRow::from).collect())
    }

    async fn find(
        &mut self,
        id: AgentConnectionId,
    ) -> Result<Option<AgentConnectionRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<AgentConnectionRecord> = sqlx::query_as(
            "select id, workspace_id, api_key_id, client_name, client_version, protocol_version, \
             first_seen_at, last_seen_at, tool_calls from agent_connections \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find agent connection"))?;
        Ok(record.map(AgentConnectionRow::from))
    }

    async fn wakes(&mut self) -> Result<Vec<AgentWakeRow>, AppError> {
        let ws = self.workspace_id();
        let data: Vec<serde_json::Value> = sqlx::query_scalar(
            "select data from agent_wakes where workspace_id = $1 order by api_key_id",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list agent wakes"))?;
        data.into_iter().map(wake_of).collect()
    }

    async fn wake_lock(&mut self, key: ApiKeyId) -> Result<Option<AgentWakeRow>, AppError> {
        let ws = self.workspace_id();
        let data: Option<serde_json::Value> = sqlx::query_scalar(
            "select data from agent_wakes where workspace_id = $1 and api_key_id = $2              for update",
        )
        .bind(ws.as_uuid())
        .bind(key.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock agent wake"))?;
        data.map(wake_of).transpose()
    }

    /// The key must be this workspace's (a foreign key ignores row-level security), else
    /// `INTERNAL`.
    async fn wake_save(&mut self, row: AgentWakeRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let key: Option<i32> =
            sqlx::query_scalar("select 1 from api_keys where workspace_id = $1 and id = $2")
                .bind(ws.as_uuid())
                .bind(row.api_key_id.as_uuid())
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "find API key"))?;
        if key.is_none() {
            return Err(dangling("agent_wakes.api_key_id"));
        }
        let data = serde_json::to_value(&row)
            .map_err(|_| AppError::internal("the agent wake cannot be stored"))?;
        sqlx::query(
            "insert into agent_wakes (workspace_id, api_key_id, data, due_at)              values ($1, $2, $3, $4)              on conflict (workspace_id, api_key_id) do update              set data = excluded.data, due_at = excluded.due_at",
        )
        .bind(ws.as_uuid())
        .bind(row.api_key_id.as_uuid())
        .bind(data)
        .bind(row.due_at())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store agent wake"))?;
        Ok(())
    }

    async fn wake_set_sealed(
        &mut self,
        key: ApiKeyId,
        sealed: Option<Vec<u8>>,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update agent_wakes set sealed = $3 where workspace_id = $1 and api_key_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(key.as_uuid())
        .bind(sealed)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store agent wake token"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such wake row"));
        }
        Ok(())
    }

    async fn wake_sealed(&mut self, key: ApiKeyId) -> Result<Option<Vec<u8>>, AppError> {
        let ws = self.workspace_id();
        let sealed: Option<Option<Vec<u8>>> = sqlx::query_scalar(
            "select sealed from agent_wakes where workspace_id = $1 and api_key_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(key.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read agent wake token"))?;
        Ok(sealed.flatten())
    }
}
