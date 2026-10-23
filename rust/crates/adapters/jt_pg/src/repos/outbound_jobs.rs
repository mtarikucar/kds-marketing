//! Provider delivery polling, scoped by tenant and capability, with a 72-hour horizon.
use super::{map_sqlx, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{
        MAX_PENDING_JOBS, OutboundJobRepo,
        connectors::{DeliveryState, DeliveryStatus},
        inbox::OutboundJobRow,
    },
};
use jt_capability::CapabilityId;
use jt_tenancy::WorkspaceId;
use uuid::Uuid;

#[async_trait]
impl OutboundJobRepo for PgTenantRepos {
    async fn insert(&mut self, row: OutboundJobRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        super::inbox::reference(
            self.tx.conn(),
            ws,
            "capabilities",
            row.capability_id.as_uuid(),
        )
        .await?;
        if let Some(message) = row.message_id {
            super::inbox::reference(self.tx.conn(), ws, "messages", message.as_uuid()).await?;
        }
        let data = serde_json::to_value(row)
            .map_err(|_| AppError::internal("cannot encode outbound job"))?;
        let n=sqlx::query("insert into outbound_jobs select * from jsonb_populate_record(null::outbound_jobs,$1) on conflict do nothing")
            .bind(data).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert outbound job"))?.rows_affected();
        if n == 0 {
            Err(AppError::conflict("outbound job already exists"))
        } else {
            Ok(())
        }
    }
    async fn get(
        &mut self,
        capability: CapabilityId,
        id: Uuid,
    ) -> Result<Option<OutboundJobRow>, AppError> {
        let row:Option<serde_json::Value>=sqlx::query_scalar("select to_jsonb(j) from outbound_jobs j where workspace_id=$1 and capability_id=$2 and id=$3")
            .bind(self.workspace_id().as_uuid()).bind(capability.as_uuid()).bind(id).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"read outbound job"))?;
        row.map(|r| {
            serde_json::from_value(r).map_err(|_| AppError::internal("invalid outbound job"))
        })
        .transpose()
    }
    async fn pending_job_ids(
        &mut self,
        ws: WorkspaceId,
        capability_id: CapabilityId,
        limit: u32,
    ) -> Result<Vec<String>, AppError> {
        same_workspace(self.workspace_id(), ws)?;
        let now = super::inbox::write_time(self).await?;
        sqlx::query_scalar("select provider_job_id from outbound_jobs where workspace_id=$1 and capability_id=$2 and state in ('queued','sent') and provider_job_id is not null and created_at > $3 - interval '72 hours' and created_at <= $3 order by created_at,id limit $4")
            .bind(ws.as_uuid()).bind(capability_id.as_uuid()).bind(now).bind(i64::from(limit.clamp(1,MAX_PENDING_JOBS)))
            .fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"pending outbound jobs"))
    }
    async fn record_status(
        &mut self,
        ws: WorkspaceId,
        capability_id: CapabilityId,
        statuses: Vec<DeliveryStatus>,
    ) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), ws)?;
        let now = super::inbox::write_time(self).await?;
        for status in statuses {
            let state = match status.status {
                DeliveryState::Delivered => Some("delivered"),
                DeliveryState::Failed => Some("failed"),
                DeliveryState::Pending | DeliveryState::Unknown(_) => None,
            };
            let data = serde_json::to_value(&status)
                .map_err(|_| AppError::internal("cannot encode delivery status"))?;
            sqlx::query("update outbound_jobs set last_status=$4,state=coalesce($5,state),updated_at=$6 where workspace_id=$1 and capability_id=$2 and provider_job_id=$3")
                .bind(ws.as_uuid()).bind(capability_id.as_uuid()).bind(status.job_id).bind(data).bind(state).bind(now)
                .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"record delivery status"))?;
        }
        Ok(())
    }
}
