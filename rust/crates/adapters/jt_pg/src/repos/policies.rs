//! `workspace_policies`: the workspace-wide policies, one row per workspace once set. A workspace
//! without a row has the defaults of `WorkspacePolicy::default`; a check constraint bounds the
//! agent check-in interval.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{WorkspacePolicy, WorkspacePolicyRepo};
use time::OffsetDateTime;

use super::map_sqlx;
use crate::uow::PgTenantRepos;

#[async_trait]
impl WorkspacePolicyRepo for PgTenantRepos {
    async fn get(&mut self) -> Result<WorkspacePolicy, AppError> {
        let ws = self.workspace_id();
        let minutes: Option<i32> = sqlx::query_scalar(
            "select agent_checkin_interval_minutes from workspace_policies \
             where workspace_id = $1",
        )
        .bind(ws.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read workspace policies"))?;
        match minutes {
            None => Ok(WorkspacePolicy::default()),
            Some(minutes) => Ok(WorkspacePolicy {
                agent_checkin_interval_minutes: u32::try_from(minutes).map_err(|_| {
                    AppError::internal("stored agent check-in interval is negative")
                })?,
            }),
        }
    }

    async fn set(&mut self, policy: WorkspacePolicy, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let minutes = i32::try_from(policy.agent_checkin_interval_minutes)
            .map_err(|_| AppError::internal("the agent check-in interval is out of range"))?;
        sqlx::query(
            "insert into workspace_policies (workspace_id, agent_checkin_interval_minutes, \
             updated_at) values ($1, $2, $3) on conflict (workspace_id) do update set \
             agent_checkin_interval_minutes = excluded.agent_checkin_interval_minutes, \
             updated_at = excluded.updated_at",
        )
        .bind(ws.as_uuid())
        .bind(minutes)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store workspace policies"))?;
        Ok(())
    }
}
