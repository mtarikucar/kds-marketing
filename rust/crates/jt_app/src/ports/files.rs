//! Workspace-scoped binary storage, separate from provider publishing.
use super::{connectors::MediaUpload, studio::FileId};
use crate::error::{AppError, ErrorCode};
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
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub cleanup_due_at: Option<OffsetDateTime>,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub deleted_at: Option<OffsetDateTime>,
    pub size_bytes: u64,
}
/// Where the bytes of a file stored as a stream come from ([`FileStore::put_stream`]): chunk
/// after chunk, then `None`. Its error ends the upload, and nothing is stored.
#[async_trait]
pub trait ByteSource: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError>;
}

/// A stored file opened to be read as a stream ([`FileStore::read_stream`]): its type and length,
/// and its bytes, chunk after chunk. A store checks what it read once it has read it all: a file
/// that does not pass (its bytes are not the ones it stored) ends with an error before its last
/// chunk, so a reader that counts the bytes against `size_bytes` never takes it for whole.
pub struct StreamedFile {
    pub mime: String,
    pub size_bytes: u64,
    pub bytes: Box<dyn ByteSource>,
}

/// Bytes held whole, yielded as one chunk: [`FileStore::read_stream`]'s default.
struct Whole(Option<Vec<u8>>);

#[async_trait]
impl ByteSource for Whole {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self.0.take())
    }
}

#[async_trait]
pub trait FileStore: Send + Sync {
    /// Verify active storage with a nonempty write, sync, readback and cleanup outside tenants.
    /// Callers must bound the probe with a timeout.
    async fn probe(&self) -> Result<(), AppError>;
    async fn put(
        &self,
        ws: WorkspaceId,
        id: FileId,
        upload: MediaUpload,
    ) -> Result<StoredFile, AppError>;
    async fn read(&self, ws: WorkspaceId, id: FileId) -> Result<MediaUpload, AppError>;
    /// File `id`, as [`FileStore::read`] reads it, opened to be read as a stream: a store that can
    /// holds a chunk of it in memory at a time (the disk store reads it in chunks, hashing them,
    /// and checks the hash before the last one); this default reads it whole first. What serves
    /// files to the outside (the signed retrieval route) reads them this way, so a large file, or
    /// many reads of one at once, are never held whole.
    async fn read_stream(&self, ws: WorkspaceId, id: FileId) -> Result<StreamedFile, AppError> {
        let upload = self.read(ws, id).await?;
        Ok(StreamedFile {
            mime: upload.mime,
            size_bytes: upload.bytes.len() as u64,
            bytes: Box::new(Whole(Some(upload.bytes))),
        })
    }
    /// Whether file `id` is stored: from what the store keeps of it alone where it can (the disk
    /// store reads its header); this default reads it ([`FileStore::read`], `NOT_FOUND` read as
    /// `false`). Another workspace's file is not this one's.
    async fn exists(&self, ws: WorkspaceId, id: FileId) -> Result<bool, AppError> {
        match self.read(ws, id).await {
            Ok(_) => Ok(true),
            Err(e) if e.code == ErrorCode::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
    /// Stores, as [`FileStore::put`] does and with the same checks, the file of type `mime` named
    /// `filename` whose bytes `source` yields. A store that can keeps at most a chunk in memory
    /// (the disk store writes the chunks to a temporary file, hashing them as they come); this
    /// default reads them all, then puts them. The caller bounds what `source` yields.
    async fn put_stream(
        &self,
        ws: WorkspaceId,
        id: FileId,
        mime: &str,
        filename: &str,
        source: &mut dyn ByteSource,
    ) -> Result<StoredFile, AppError> {
        let mut bytes = Vec::new();
        while let Some(chunk) = source.next_chunk().await? {
            bytes.extend_from_slice(&chunk);
        }
        let upload = MediaUpload {
            bytes,
            mime: mime.to_owned(),
            filename: filename.to_owned(),
        };
        self.put(ws, id, upload).await
    }
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
    async fn probe(&self) -> Result<(), AppError> {
        Err(AppError::internal("file storage is not configured"))
    }
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

/// Checked, bounded tenant HTTP ingestion; the adapter uses the shared egress client.
#[async_trait]
pub trait MediaFetcher: Send + Sync {
    async fn fetch(
        &self,
        ws: WorkspaceId,
        url: &Url,
        mime: &str,
        filename: &str,
    ) -> Result<MediaUpload, AppError>;
}
pub struct UnavailableMediaFetcher;
#[async_trait]
impl MediaFetcher for UnavailableMediaFetcher {
    async fn fetch(
        &self,
        _: WorkspaceId,
        _: &Url,
        _: &str,
        _: &str,
    ) -> Result<MediaUpload, AppError> {
        Err(AppError::internal("media fetch is not configured"))
    }
}

/// Permanent evidence used to derive retention under the Studio control lock.
#[derive(Default)]
pub struct FileUsage {
    pub files: Vec<StoredFile>,
    pub pieces: Vec<(super::studio::SlotId, super::studio::Piece)>,
    pub slots: Vec<super::studio::Slot>,
    pub attempts: Vec<super::studio::PublishAttempt>,
    pub publications: Vec<super::studio::Publication>,
}

/// Enumerates old physical objects so a crash before metadata commit can be repaired.
/// It never decides whether a file is referenced; the application holds the tenant fence.
#[async_trait]
pub trait FileMaintenance: Send + Sync {
    async fn orphan_candidates(
        &self,
        ws: WorkspaceId,
        older_than: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError>;
}
pub struct NoFileMaintenance;
#[async_trait]
impl FileMaintenance for NoFileMaintenance {
    async fn orphan_candidates(
        &self,
        _: WorkspaceId,
        _: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError> {
        Ok(vec![])
    }
}
