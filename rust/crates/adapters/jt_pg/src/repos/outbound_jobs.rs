//! The messages awaiting a delivery report: not stored yet. The table that holds sent messages
//! and their provider job ids belongs to the next milestone (M2's `sms_jobs`); until it exists
//! this repo is a stub that holds nothing: `pending_job_ids` answers no job and `record_status`
//! writes nothing, so the scheduler's delivery-report poll runs without ever asking a provider.
//! Both still refuse a workspace other than the bundle's, as the port says.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::OutboundJobRepo;
use jt_app::ports::connectors::DeliveryStatus;
use jt_tenancy::WorkspaceId;

use super::same_workspace;
use crate::uow::PgTenantRepos;

#[async_trait]
impl OutboundJobRepo for PgTenantRepos {
    async fn pending_job_ids(
        &mut self,
        ws: WorkspaceId,
        _limit: u32,
    ) -> Result<Vec<String>, AppError> {
        same_workspace(self.workspace_id(), ws)?;
        Ok(Vec::new())
    }

    async fn record_status(
        &mut self,
        ws: WorkspaceId,
        _statuses: Vec<DeliveryStatus>,
    ) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), ws)
    }
}
