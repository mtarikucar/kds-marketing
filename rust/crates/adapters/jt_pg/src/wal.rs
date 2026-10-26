//! Confirm PostgreSQL archiver success against the configured archive before publishing status.
use sqlx::PgPool;
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

/// Injectable PostgreSQL archiver observation; absence is not success.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ArchiverState {
    /// Last successfully archived segment.
    pub last_archived_wal: Option<String>,
    /// PostgreSQL's success time (never replaced by the observation time).
    pub last_archived_time: Option<OffsetDateTime>,
    /// A failure newer than the success invalidates the observation.
    pub last_failed_time: Option<OffsetDateTime>,
}
/// Read the single PostgreSQL statistics row, without adding a table.
pub async fn observe(pool: &PgPool) -> Result<ArchiverState, sqlx::Error> {
    sqlx::query_as(
        "SELECT last_archived_wal,last_archived_time,last_failed_time FROM pg_stat_archiver",
    )
    .fetch_one(pool)
    .await
}
/// Only confirmed, nonfuture success publishes an atomic, small JSON artifact.
/// Archive/status directories must be operator-owned local storage, not tenant-writable.
pub async fn publish(
    state: &ArchiverState,
    archive: &Path,
    status: &Path,
    now: OffsetDateTime,
) -> std::io::Result<()> {
    let invalid = || std::io::Error::other("wal probe failed");
    let segment = state.last_archived_wal.as_deref().ok_or_else(invalid)?;
    let at = state.last_archived_time.ok_or_else(invalid)?;
    if !archive.is_absolute()
        || !status.is_absolute()
        || segment.len() != 24
        || !segment
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        || at > now
        || state.last_failed_time.is_some_and(|failed| failed >= at)
    {
        return Err(invalid());
    }
    let archive_segment = archive.join(segment);
    let bytes = serde_json::to_vec(
        &serde_json::json!({"archived_at": at.format(&Rfc3339).map_err(|_| invalid())?, "observed_at": now.format(&Rfc3339).map_err(|_| invalid())?}),
    )?;
    let status = status.to_owned();
    // The blocking worker owns its cleanup guard. Dropping this future also drops
    // any eventual worker result; no detached operation can publish a marker.
    let prepared = tokio::task::spawn_blocking(move || {
        let metadata = std::fs::symlink_metadata(archive_segment)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(std::io::Error::other("wal probe failed"));
        }
        Prepared::write(&status, &bytes)
    })
    .await
    .map_err(|_| invalid())??;
    // No await at the commit point: cancellation/timeout cannot report failure
    // while a detached rename subsequently publishes success. Local storage only.
    prepared.commit()
}

struct Prepared {
    temporary: PathBuf,
    destination: PathBuf,
}
impl Prepared {
    fn write(status: &Path, bytes: &[u8]) -> std::io::Result<Self> {
        let temporary = status.join(format!(
            ".wal-status-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        let prepared = Self {
            temporary,
            destination: status.join("wal-status.json"),
        };
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(prepared)
    }
    fn commit(self) -> std::io::Result<()> {
        std::fs::rename(&self.temporary, &self.destination)
    }
}
impl Drop for Prepared {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.temporary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_preparation_cleans_up_without_publishing() {
        let dir = std::env::temp_dir().join(format!("jeeta-wal-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let status = dir.clone();
        let task = tokio::spawn(async move {
            let prepared = tokio::task::spawn_blocking(move || {
                let prepared = Prepared::write(&status, b"confirmed").unwrap();
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                prepared
            })
            .await
            .unwrap();
            prepared.commit().unwrap();
        });
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        release_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while std::fs::read_dir(&dir).unwrap().next().is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(!dir.join("wal-status.json").exists());
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn commit_and_cleanup_leave_only_the_complete_marker() {
        let dir = std::env::temp_dir().join(format!("jeeta-wal-commit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Prepared::write(&dir, b"old").unwrap().commit().unwrap();
        drop(Prepared::write(&dir, b"cancelled").unwrap());
        assert_eq!(std::fs::read(dir.join("wal-status.json")).unwrap(), b"old");
        Prepared::write(&dir, b"confirmed")
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(
            std::fs::read(dir.join("wal-status.json")).unwrap(),
            b"confirmed"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
