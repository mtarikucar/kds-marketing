//! `agent_connections`: agent clients seen through a workspace's API keys, one per (key, client
//! name, client version).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{AgentConnectionRepo, AgentConnectionRow};
use jt_tenancy::{AgentConnectionId, ApiKeyId, WorkspaceId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{dangling, map_sqlx, same_workspace};
use crate::uow::PgTenantRepos;

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
}
