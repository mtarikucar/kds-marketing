//! Workspace policies, including inbox labels. Reads serialize read/modify/write transactions
//! even before the first policy row exists, preserving unrelated settings during concurrent edits.
use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{WorkspacePolicy, WorkspacePolicyRepo};
use serde_json::Value;
use time::OffsetDateTime;

use super::map_sqlx;
use crate::uow::PgTenantRepos;

#[async_trait]
impl WorkspacePolicyRepo for PgTenantRepos {
    async fn get(&mut self) -> Result<WorkspacePolicy, AppError> {
        let ws = self.workspace_id();
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('workspace-policy:' || $1::uuid::text, 0))")
            .bind(ws.as_uuid()).execute(self.tx.conn()).await
            .map_err(|e| map_sqlx(e, "lock workspace policies"))?;
        let row: Option<(i32, Value, Value, Value)> = sqlx::query_as(
            "select agent_checkin_interval_minutes, inbox_status_labels, inbox_policy, leads_policy from workspace_policies where workspace_id = $1",
        )
        .bind(ws.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read workspace policies"))?;
        match row {
            None => Ok(WorkspacePolicy::default()),
            Some((minutes, labels, inbox, leads)) => {
                let mut inbox: jt_app::ports::InboxPolicy = serde_json::from_value(inbox)
                    .map_err(|_| AppError::internal("invalid stored inbox policy"))?;
                inbox.status_labels = serde_json::from_value(labels)
                    .map_err(|_| AppError::internal("invalid stored inbox status labels"))?;
                Ok(WorkspacePolicy {
                    agent_checkin_interval_minutes: u32::try_from(minutes).map_err(|_| {
                        AppError::internal("stored agent check-in interval is negative")
                    })?,
                    inbox,
                    leads: serde_json::from_value(leads)
                        .map_err(|_| AppError::internal("invalid stored leads policy"))?,
                })
            }
        }
    }

    async fn set(&mut self, policy: WorkspacePolicy, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let minutes = i32::try_from(policy.agent_checkin_interval_minutes)
            .map_err(|_| AppError::internal("the agent check-in interval is out of range"))?;
        let inbox = serde_json::to_value(&policy.inbox)
            .map_err(|_| AppError::internal("cannot encode inbox policy"))?;
        let labels = serde_json::to_value(policy.inbox.status_labels)
            .map_err(|_| AppError::internal("cannot encode inbox status labels"))?;
        let leads = serde_json::to_value(&policy.leads)
            .map_err(|_| AppError::internal("cannot encode leads policy"))?;
        sqlx::query(
            "insert into workspace_policies (workspace_id, agent_checkin_interval_minutes, \
             inbox_status_labels, updated_at, inbox_policy, leads_policy) values ($1, $2, $3, $4, $5, $6) on conflict (workspace_id) do update set \
             agent_checkin_interval_minutes = excluded.agent_checkin_interval_minutes, \
             inbox_policy = excluded.inbox_policy, inbox_status_labels = excluded.inbox_status_labels, \
             leads_policy = excluded.leads_policy, updated_at = excluded.updated_at",
        )
        .bind(ws.as_uuid())
        .bind(minutes)
        .bind(labels)
        .bind(at)
        .bind(inbox)
        .bind(leads)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store workspace policies"))?;
        Ok(())
    }
}
