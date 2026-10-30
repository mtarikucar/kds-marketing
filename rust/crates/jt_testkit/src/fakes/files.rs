//! Restartable in-memory media fixture; production uses the disk adapter.
use async_trait::async_trait;
use jt_app::ports::connectors::Url;
use jt_app::{
    error::AppError,
    ports::{
        connectors::MediaUpload,
        files::{ByteSource, FileStore, StoredFile},
    },
};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};
use time::OffsetDateTime;
#[derive(Default)]
pub struct MemoryFiles {
    pub probe_hangs: std::sync::atomic::AtomicBool,
    pub probe_write_fails: std::sync::atomic::AtomicBool,
    pub files: Mutex<HashMap<(WorkspaceId, FileId), MediaUpload>>,
}
#[async_trait]
impl FileStore for MemoryFiles {
    async fn probe(&self) -> Result<(), AppError> {
        if self.probe_hangs.load(std::sync::atomic::Ordering::Acquire) {
            std::future::pending::<()>().await;
        }
        if self
            .probe_write_fails
            .load(std::sync::atomic::Ordering::Acquire)
        {
            Err(AppError::internal("file probe payload write failed"))
        } else {
            Ok(())
        }
    }
    async fn put(
        &self,
        ws: WorkspaceId,
        id: FileId,
        u: MediaUpload,
    ) -> Result<StoredFile, AppError> {
        jt_app::usecases::files::validate_stored(&u)?;
        let f = StoredFile {
            id,
            workspace_id: ws,
            mime: u.mime.clone(),
            filename: u.filename.clone(),
            size_bytes: u.bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(&u.bytes)),
            created_at: super::FIXED_NOW,
            cleanup_due_at: None,
            deleted_at: None,
        };
        let mut files = self.files.lock().unwrap();
        if files.get(&(ws, id)).is_some_and(|old| old != &u) {
            return Err(AppError::conflict("file identity is immutable"));
        }
        files.insert((ws, id), u);
        Ok(f)
    }
    async fn read(&self, ws: WorkspaceId, id: FileId) -> Result<MediaUpload, AppError> {
        self.files
            .lock()
            .unwrap()
            .get(&(ws, id))
            .cloned()
            .ok_or_else(|| AppError::not_found("file"))
    }
    async fn delete(&self, ws: WorkspaceId, id: FileId) -> Result<(), AppError> {
        self.files.lock().unwrap().remove(&(ws, id));
        Ok(())
    }
    async fn provider_url(
        &self,
        ws: WorkspaceId,
        id: FileId,
        _: OffsetDateTime,
    ) -> Result<Url, AppError> {
        self.read(ws, id).await?;
        Ok(format!("https://files.example.com/files/{id}")
            .parse()
            .unwrap())
    }
}

/// A [`ByteSource`] over chunks held in memory: a test's upload.
pub struct Chunks(pub std::collections::VecDeque<Vec<u8>>);

impl Chunks {
    /// `bytes` in one chunk.
    pub fn of(bytes: &[u8]) -> Chunks {
        Chunks([bytes.to_vec()].into())
    }
}

#[async_trait]
impl ByteSource for Chunks {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self.0.pop_front())
    }
}
