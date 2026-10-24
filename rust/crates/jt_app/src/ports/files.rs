//! Workspace-scoped binary storage, separate from provider publishing.
use super::{connectors::MediaUpload, studio::FileId};
use crate::error::AppError;
use async_trait::async_trait;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use url::Url;
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StoredFile {
    pub id: FileId,
    pub workspace_id: WorkspaceId,
    pub mime: String,
    pub filename: String,
    pub sha256: String,
    pub created_at: OffsetDateTime,
    pub cleanup_due_at: Option<OffsetDateTime>,
    pub deleted_at: Option<OffsetDateTime>,
    pub size_bytes: u64,
}
#[async_trait]
pub trait FileStore: Send + Sync {
    async fn put(
        &self,
        ws: WorkspaceId,
        id: FileId,
        upload: MediaUpload,
    ) -> Result<StoredFile, AppError>;
    async fn read(&self, ws: WorkspaceId, id: FileId) -> Result<MediaUpload, AppError>;
    async fn provider_url(
        &self,
        ws: WorkspaceId,
        id: FileId,
        expires_at: OffsetDateTime,
    ) -> Result<Url, AppError>;
    async fn delete(&self, ws: WorkspaceId, id: FileId) -> Result<(), AppError>;
}
/// Before T5 wires a disk adapter, every operation refuses explicitly.
pub struct UnavailableFileStore;
#[async_trait]
impl FileStore for UnavailableFileStore {
    async fn put(
        &self,
        _ws: WorkspaceId,
        _id: FileId,
        _upload: MediaUpload,
    ) -> Result<StoredFile, AppError> {
        Err(AppError::internal("file storage is not configured"))
    }
    async fn read(&self, _ws: WorkspaceId, _id: FileId) -> Result<MediaUpload, AppError> {
        Err(AppError::internal("file storage is not configured"))
    }
    async fn provider_url(
        &self,
        _ws: WorkspaceId,
        _id: FileId,
        _expires_at: OffsetDateTime,
    ) -> Result<Url, AppError> {
        Err(AppError::internal("file storage is not configured"))
    }
    async fn delete(&self, _ws: WorkspaceId, _id: FileId) -> Result<(), AppError> {
        Err(AppError::internal("file storage is not configured"))
    }
}
