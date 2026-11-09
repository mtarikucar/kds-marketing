//! Production workspaces live inside the existing tenant; sources and publications remain canonical.
use crate::error::AppError;
use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_studio::{MaterialId, PostFormat, SlotId};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectSource {
    pub material_id: MaterialId,
    pub revision: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    Open,
    Done,
    Dismissed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectMaterialRequest {
    pub id: Uuid,
    pub text: String,
    pub status: RequestStatus,
    pub material_ids: Vec<MaterialId>,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub resolved_at: Option<OffsetDateTime>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectOutput {
    pub id: Uuid,
    pub title: String,
    pub format: PostFormat,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub target_at: Option<OffsetDateTime>,
    pub capability_id: Option<CapabilityId>,
    /// A target date is not a scheduled publication. This names the canonical existing slot.
    pub slot_id: Option<SlotId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductionProject {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    pub title: String,
    pub brief: String,
    pub revision: u64,
    pub archived: bool,
    pub sources: Vec<ProjectSource>,
    pub requests: Vec<ProjectMaterialRequest>,
    pub outputs: Vec<ProjectOutput>,
    pub production_ids: Vec<Uuid>,
    #[serde(default)]
    pub invalidated_production_ids: Vec<Uuid>,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat")]
    pub updated_at: OffsetDateTime,
}
#[async_trait]
pub trait ProjectRepo: Send + Sync {
    async fn get_project(&mut self, id: Uuid) -> Result<Option<ProductionProject>, AppError>;
    /// At most 101 rows for a 100-row page, newest first, before an exclusive ID cursor.
    async fn list_projects(
        &mut self,
        archived: bool,
        before: Option<Uuid>,
    ) -> Result<Vec<ProductionProject>, AppError>;
    async fn save_project(
        &mut self,
        project: ProductionProject,
        expected: Option<u64>,
    ) -> Result<(), AppError>;
}
