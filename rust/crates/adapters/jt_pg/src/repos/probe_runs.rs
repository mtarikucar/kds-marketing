//! `probe_runs`: the append-only log of connector probes, read newest first per capability.
//!
//! Runs reference their capability together with the workspace (a composite foreign key), and
//! `append` checks first that the capability is this workspace's, so another workspace's
//! capability is `NOT_FOUND` before the key would refuse it. `latency_ms` is a 32-bit `integer`:
//! a longer latency is stored as `i32::MAX`. A trigger refuses every update and delete.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{MAX_PROBE_PAGE, ProbeRun, ProbeRunId, ProbeRunRepo};
use jt_capability::CapabilityId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capabilities::ensure_capability;
use super::{map_sqlx, same_workspace};
use crate::uow::PgTenantRepos;

/// The columns every read selects.
const COLUMNS: &str = "id, workspace_id, capability_id, at, ok, error_kind, latency_ms, facts";

#[derive(sqlx::FromRow)]
struct RunRecord {
    id: Uuid,
    workspace_id: Uuid,
    capability_id: Uuid,
    at: OffsetDateTime,
    ok: bool,
    error_kind: Option<String>,
    latency_ms: i32,
    facts: serde_json::Value,
}

impl RunRecord {
    fn into_run(self) -> Result<ProbeRun, AppError> {
        Ok(ProbeRun {
            id: ProbeRunId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            capability_id: CapabilityId(self.capability_id),
            at: self.at,
            ok: self.ok,
            error_kind: self.error_kind,
            latency_ms: u32::try_from(self.latency_ms)
                .map_err(|_| AppError::internal("stored probe_runs.latency_ms is negative"))?,
            facts: self.facts,
        })
    }
}

#[async_trait]
impl ProbeRunRepo for PgTenantRepos {
    async fn append(&mut self, run: ProbeRun) -> Result<ProbeRunId, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, run.workspace_id)?;
        ensure_capability(self.tx.conn(), ws, run.capability_id).await?;
        let done = sqlx::query(
            "insert into probe_runs (id, workspace_id, capability_id, at, ok, error_kind, \
             latency_ms, facts) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing",
        )
        .bind(run.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(run.capability_id.as_uuid())
        .bind(run.at)
        .bind(run.ok)
        .bind(&run.error_kind)
        .bind(i32::try_from(run.latency_ms).unwrap_or(i32::MAX))
        .bind(&run.facts)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "append probe run"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("the probe run id is already taken"));
        }
        Ok(run.id)
    }

    async fn latest(&mut self, capability_id: CapabilityId) -> Result<Option<ProbeRun>, AppError> {
        Ok(ProbeRunRepo::list(self, capability_id, 1).await?.pop())
    }

    async fn list(
        &mut self,
        capability_id: CapabilityId,
        limit: u32,
    ) -> Result<Vec<ProbeRun>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<RunRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from probe_runs where workspace_id = $1 and capability_id = $2 \
             order by at desc, id desc limit $3"
        ))
        .bind(ws.as_uuid())
        .bind(capability_id.as_uuid())
        .bind(i64::from(limit.clamp(1, MAX_PROBE_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list probe runs"))?;
        records.into_iter().map(RunRecord::into_run).collect()
    }
}
