//! Durable requests for external agents to create derivatives while retaining original sources.
use crate::error::AppError;
use async_trait::async_trait;
use jt_studio::MaterialId;
use jt_tenancy::{AgentConnectionId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductionKind {
    Edit,
    Crop,
    Poster,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductionStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductionSource {
    pub material_id: MaterialId,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialProduction {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    pub kind: ProductionKind,
    pub instructions: String,
    pub sources: Vec<ProductionSource>,
    pub status: ProductionStatus,
    pub output_material_id: Option<MaterialId>,
    pub last_error_code: Option<String>,
    pub revision: u64,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat")]
    pub updated_at: OffsetDateTime,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductionLease {
    pub token_hash: String,
    pub owner: AgentConnectionId,
    #[serde(with = "jt_studio::time_compat")]
    pub expires_at: OffsetDateTime,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductionRecord {
    pub production: MaterialProduction,
    pub lease: Option<ProductionLease>,
}
impl ProductionRecord {
    pub fn claimable(&self, now: OffsetDateTime) -> bool {
        self.production.status == ProductionStatus::Pending
            || (self.production.status == ProductionStatus::Running
                && self.lease.as_ref().is_some_and(|l| l.expires_at <= now))
    }
}
#[async_trait]
pub trait ProductionRepo: Send + Sync {
    async fn get_production(&mut self, id: Uuid) -> Result<Option<ProductionRecord>, AppError>;
    async fn list_productions(&mut self) -> Result<Vec<ProductionRecord>, AppError>;
    /// The caller holds the Studio control lock; expected revision is None on insert only.
    async fn save_production(
        &mut self,
        row: ProductionRecord,
        expected_revision: Option<u64>,
    ) -> Result<(), AppError>;
}
