//! Workspace policies, including inbox labels and the leads policy. `get` serializes
//! read/modify/write transactions even before the first policy row exists, preserving unrelated
//! settings during concurrent edits; `read` takes no lock. The leads policy is stored as only the
//! keys someone set (`patch_leads`), so every other key keeps following its default.
use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{
    LeadsPolicy, WorkspacePolicy, WorkspacePolicyRepo, leads_policy_of, merge_object,
};
use serde_json::Value;
use time::OffsetDateTime;

use super::map_sqlx;
use crate::uow::PgTenantRepos;

impl PgTenantRepos {
    /// Serializes the workspace's policy writes until commit.
    async fn lock_policies(&mut self) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('workspace-policy:' || $1::uuid::text, 0))")
            .bind(ws.as_uuid()).execute(self.tx.conn()).await
            .map_err(|e| map_sqlx(e, "lock workspace policies"))?;
        Ok(())
    }

    /// The stored policies, read without a lock.
    async fn read_policies(&mut self) -> Result<WorkspacePolicy, AppError> {
        let ws = self.workspace_id();
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
                // A policy stored before a default was added reads with it (key by key).
                let mut inbox = serde_json::from_value::<jt_app::ports::InboxPolicy>(inbox)
                    .map_err(|_| AppError::internal("invalid stored inbox policy"))?
                    .with_default_response_times();
                inbox.status_labels = serde_json::from_value(labels)
                    .map_err(|_| AppError::internal("invalid stored inbox status labels"))?;
                Ok(WorkspacePolicy {
                    agent_checkin_interval_minutes: u32::try_from(minutes).map_err(|_| {
                        AppError::internal("stored agent check-in interval is negative")
                    })?,
                    inbox,
                    leads: leads_policy_of(&leads)?,
                })
            }
        }
    }
}

#[async_trait]
impl WorkspacePolicyRepo for PgTenantRepos {
    async fn get(&mut self) -> Result<WorkspacePolicy, AppError> {
        self.lock_policies().await?;
        self.read_policies().await
    }

    async fn read(&mut self) -> Result<WorkspacePolicy, AppError> {
        self.read_policies().await
    }

    async fn set(&mut self, policy: WorkspacePolicy, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let minutes = i32::try_from(policy.agent_checkin_interval_minutes)
            .map_err(|_| AppError::internal("the agent check-in interval is out of range"))?;
        let inbox = serde_json::to_value(&policy.inbox)
            .map_err(|_| AppError::internal("cannot encode inbox policy"))?;
        let labels = serde_json::to_value(policy.inbox.status_labels)
            .map_err(|_| AppError::internal("cannot encode inbox status labels"))?;
        // The leads policy is not written here: a new row starts it as `{}` (every key its
        // default) and only `patch_leads` changes it.
        sqlx::query(
            "insert into workspace_policies (workspace_id, agent_checkin_interval_minutes, \
             inbox_status_labels, updated_at, inbox_policy) values ($1, $2, $3, $4, $5) on conflict (workspace_id) do update set \
             agent_checkin_interval_minutes = excluded.agent_checkin_interval_minutes, \
             inbox_policy = excluded.inbox_policy, inbox_status_labels = excluded.inbox_status_labels, \
             updated_at = excluded.updated_at",
        )
        .bind(ws.as_uuid())
        .bind(minutes)
        .bind(labels)
        .bind(at)
        .bind(inbox)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store workspace policies"))?;
        Ok(())
    }

    async fn patch_leads(
        &mut self,
        patch: Value,
        at: OffsetDateTime,
    ) -> Result<LeadsPolicy, AppError> {
        if !patch.is_object() {
            return Err(AppError::internal("a leads policy patch is an object"));
        }
        let ws = self.workspace_id();
        self.lock_policies().await?;
        let stored: Option<Value> = sqlx::query_scalar(
            "select leads_policy from workspace_policies where workspace_id = $1",
        )
        .bind(ws.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read the leads policy"))?;
        let mut merged = stored.unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        merge_object(&mut merged, &patch);
        let policy = leads_policy_of(&merged)?;
        // A new row takes every other column's default.
        sqlx::query(
            "insert into workspace_policies (workspace_id, updated_at, leads_policy) \
             values ($1, $2, $3) on conflict (workspace_id) do update set \
             leads_policy = excluded.leads_policy, updated_at = excluded.updated_at",
        )
        .bind(ws.as_uuid())
        .bind(at)
        .bind(&merged)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store the leads policy"))?;
        Ok(policy)
    }
}
