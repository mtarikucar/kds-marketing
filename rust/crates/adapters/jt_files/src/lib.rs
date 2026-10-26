//! Linux local storage: descriptor-anchored tenant roots, immutable atomic files and signed transport.
mod fetch;
use async_trait::async_trait;
pub use fetch::CheckedMediaFetcher;
use hmac::{Hmac, KeyInit, Mac};
use jt_app::{
    error::AppError,
    ports::{
        Clock,
        connectors::MediaUpload,
        files::{FileStore, StoredFile},
    },
    usecases::studio::files::{VIDEO_LIMIT, validate_upload},
};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use time::{Duration, OffsetDateTime};
use url::Url;
fn storage() -> AppError {
    AppError::internal("file storage unavailable or integrity check failed")
}
fn io<T>(r: std::io::Result<T>) -> Result<T, AppError> {
    r.map_err(|_| storage())
}
fn dir(p: &Path) -> Result<File, AppError> {
    io(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(p))
}
fn anchored(f: &File) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", f.as_raw_fd()))
}
fn root(path: &Path) -> Result<File, AppError> {
    if !path.is_absolute() {
        return Err(storage());
    }
    let mut at = dir(Path::new("/"))?;
    for part in path.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(p) => at = dir(&anchored(&at).join(p))?,
            _ => return Err(storage()),
        }
    }
    Ok(at)
}
/// Existing absolute private directory; no symlink is followed in any component.
#[derive(Clone)]
pub struct DiskFiles {
    root: Arc<File>,
    root_path: PathBuf,
    base: Url,
    key: [u8; 32],
    clock: Arc<dyn Clock>,
}
impl DiskFiles {
    pub fn new(
        path: &Path,
        base: Url,
        key: [u8; 32],
        clock: Arc<dyn Clock>,
    ) -> Result<Self, AppError> {
        if base.scheme() != "https"
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
        {
            return Err(AppError::internal(
                "JEETA_PUBLIC_BASE_URL must be a public HTTPS origin",
            ));
        }
        jt_outbound::validate_public_host(base.host_str().unwrap_or_default())
            .map_err(|_| storage())?;
        Ok(Self {
            root: Arc::new(root(path)?),
            root_path: path.to_owned(),
            base,
            key,
            clock,
        })
    }
    fn check_root_identity(&self) -> Result<(), AppError> {
        let active = io(self.root.metadata())?;
        let configured = io(root(&self.root_path)?.metadata())?;
        if active.dev() != configured.dev() || active.ino() != configured.ino() {
            return Err(storage());
        }
        Ok(())
    }
    fn probe_inner(&self) -> Result<(), AppError> {
        self.check_root_identity()?;
        // Reserved non-tenant namespace. Exclusive creation means cleanup can remove only
        // this invocation's file; concurrent probes never share a name.
        let path = anchored(&self.root).join(format!(".readiness-{}", uuid::Uuid::new_v4()));
        let mut file = io(OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path))?;
        let result = (|| {
            let payload = [0xa5; 4096];
            io(file.write_all(&payload))?;
            io(file.sync_all())?;
            io(file.rewind())?;
            let mut readback = [0; 4096];
            io(file.read_exact(&mut readback))?;
            if readback != payload {
                return Err(storage());
            }
            self.check_root_identity()
        })();
        drop(file);
        // Try cleanup even on write/sync/read failure; all errors stay in a fixed category.
        let removed = io(std::fs::remove_file(&path));
        let synced = io(self.root.sync_all());
        result.and(removed).and(synced)
    }
    fn repair_temps(&self, parent: &File) -> Result<(), AppError> {
        for entry in io(std::fs::read_dir(anchored(parent)))? {
            let entry = io(entry)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.starts_with('.')
                || !name.ends_with(".tmp")
                || uuid::Uuid::parse_str(&name[1..name.len() - 4]).is_err()
            {
                continue;
            }
            let meta = io(entry.path().symlink_metadata())?;
            if meta.is_file()
                && io(meta.modified())?
                    .elapsed()
                    .is_ok_and(|age| age.as_secs() > 86400)
            {
                io(std::fs::remove_file(entry.path()))?;
            }
        }
        io(parent.sync_all())
    }
    fn tenant(&self, ws: WorkspaceId, create: bool) -> Result<File, AppError> {
        if ws.0.is_nil() {
            return Err(storage());
        }
        let p = anchored(&self.root).join(ws.to_string());
        if create {
            match std::fs::create_dir(&p) {
                Ok(()) => io(self.root.sync_all())?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(storage()),
            }
        }
        dir(&p)
    }
    fn load(&self, ws: WorkspaceId, id: FileId) -> Result<(StoredFile, MediaUpload), AppError> {
        let parent = self.tenant(ws, false)?;
        let path = anchored(&parent).join(id.to_string());
        let mut file = io(OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path))?;
        if !io(file.metadata())?.is_file() {
            return Err(storage());
        }
        let mut len = [0u8; 4];
        io(file.read_exact(&mut len))?;
        let n = u32::from_be_bytes(len) as usize;
        if n > 4096 {
            return Err(storage());
        }
        let mut metadata = vec![0; n];
        io(file.read_exact(&mut metadata))?;
        let f: StoredFile = serde_json::from_slice(&metadata).map_err(|_| storage())?;
        if f.id != id || f.workspace_id != ws || f.size_bytes > VIDEO_LIMIT {
            return Err(storage());
        }
        let mut bytes = vec![];
        io(file.take(f.size_bytes + 1).read_to_end(&mut bytes))?;
        if bytes.len() as u64 != f.size_bytes || hex::encode(Sha256::digest(&bytes)) != f.sha256 {
            return Err(storage());
        }
        let u = MediaUpload {
            bytes,
            mime: f.mime.clone(),
            filename: f.filename.clone(),
        };
        validate_upload(&u)?;
        Ok((f, u))
    }
}
impl DiskFiles {
    fn put_inner(
        &self,
        ws: WorkspaceId,
        id: FileId,
        u: MediaUpload,
    ) -> Result<StoredFile, AppError> {
        validate_upload(&u)?;
        if id.0.is_nil() {
            return Err(storage());
        }
        let parent = self.tenant(ws, true)?;
        self.repair_temps(&parent)?;
        let final_path = anchored(&parent).join(id.to_string());
        if final_path.symlink_metadata().is_ok() {
            let (f, old) = self.load(ws, id)?;
            if old == u {
                return Ok(f);
            }
            return Err(AppError::conflict("file identity is immutable"));
        }
        let f = StoredFile {
            id,
            workspace_id: ws,
            mime: u.mime.clone(),
            filename: u.filename.clone(),
            size_bytes: u.bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(&u.bytes)),
            created_at: self.clock.now(),
            cleanup_due_at: None,
            deleted_at: None,
        };
        let header = serde_json::to_vec(&f).map_err(|_| storage())?;
        let tmp = anchored(&parent).join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut out = io(OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&tmp))?;
            io(out.write_all(&(header.len() as u32).to_be_bytes()))?;
            io(out.write_all(&header))?;
            io(out.write_all(&u.bytes))?;
            io(out.sync_all())?;
            // link is an atomic no-replace commit. A crash leaves either no asset or a complete one.
            match std::fs::hard_link(&tmp, &final_path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let (_, old) = self.load(ws, id)?;
                    if old != u {
                        return Err(AppError::conflict("file identity is immutable"));
                    }
                }
                Err(_) => return Err(storage()),
            }
            io(parent.sync_all())?;
            Ok(())
        })();
        let _ = std::fs::remove_file(&tmp);
        result?;
        io(parent.sync_all())?;
        self.load(ws, id).map(|(f, _)| f)
    }
    fn read_inner(&self, ws: WorkspaceId, id: FileId) -> Result<MediaUpload, AppError> {
        self.load(ws, id).map(|(_, u)| u)
    }
    fn delete_inner(&self, ws: WorkspaceId, id: FileId) -> Result<(), AppError> {
        let p = anchored(&self.root).join(ws.to_string());
        if !p.try_exists().map_err(|_| storage())? {
            return Ok(());
        }
        let parent = self.tenant(ws, false)?;
        match std::fs::remove_file(anchored(&parent).join(id.to_string())) {
            Ok(()) => io(parent.sync_all()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(storage()),
        }
    }
    fn provider_url_inner(
        &self,
        ws: WorkspaceId,
        id: FileId,
        expires_at: OffsetDateTime,
    ) -> Result<Url, AppError> {
        let expiry = self.clock.now() + Duration::hours(24);
        if (expires_at - expiry).abs() > Duration::seconds(1) {
            return Err(AppError::validation(
                "file URL lifetime must be 24 hours",
                serde_json::json!({}),
            ));
        }
        self.load(ws, id)?;
        let expires = expiry.unix_timestamp();
        let sig = sign(&self.key, ws, id, expires);
        let mut url = self
            .base
            .join(&format!("files/{id}"))
            .map_err(|_| storage())?;
        url.query_pairs_mut()
            .append_pair("workspace", &ws.to_string())
            .append_pair("expires", &expires.to_string())
            .append_pair("signature", &sig);
        Ok(url)
    }
}
fn mac(key: &[u8; 32], ws: WorkspaceId, id: FileId, expires: i64) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC key");
    mac.update(format!("jeeta.files.v1\n{ws}\n{id}\n{expires}").as_bytes());
    mac
}
fn sign(key: &[u8; 32], ws: WorkspaceId, id: FileId, expires: i64) -> String {
    hex::encode(mac(key, ws, id, expires).finalize().into_bytes())
}
pub fn verify(
    key: &[u8; 32],
    ws: WorkspaceId,
    id: FileId,
    expires: i64,
    signature: &str,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    if expires <= now.unix_timestamp() || expires > (now + Duration::hours(24)).unix_timestamp() {
        return Err(AppError::not_found("file"));
    }
    let bytes = hex::decode(signature).map_err(|_| AppError::not_found("file"))?;
    mac(key, ws, id, expires)
        .verify_slice(&bytes)
        .map_err(|_| AppError::not_found("file"))
}
#[derive(Clone)]
struct Retrieval {
    store: Arc<dyn FileStore>,
    clock: Arc<dyn Clock>,
    key: [u8; 32],
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedQuery {
    workspace: WorkspaceId,
    expires: i64,
    signature: String,
}
pub fn router(store: Arc<dyn FileStore>, clock: Arc<dyn Clock>, key: [u8; 32]) -> axum::Router {
    axum::Router::new()
        .route("/files/{id}", axum::routing::get(retrieve))
        .with_state(Retrieval { store, clock, key })
}
async fn retrieve(
    axum::extract::State(s): axum::extract::State<Retrieval>,
    axum::extract::Path(id): axum::extract::Path<FileId>,
    axum::extract::Query(q): axum::extract::Query<SignedQuery>,
) -> Result<impl axum::response::IntoResponse, axum::http::StatusCode> {
    use axum::http::{StatusCode, header};
    verify(
        &s.key,
        q.workspace,
        id,
        q.expires,
        &q.signature,
        s.clock.now(),
    )
    .map_err(|_| StatusCode::NOT_FOUND)?;
    let u = s
        .store
        .read(q.workspace, id)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((
        [
            (header::CONTENT_TYPE, u.mime),
            (header::CACHE_CONTROL, "private, no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        u.bytes,
    ))
}

#[async_trait]
impl FileStore for DiskFiles {
    async fn probe(&self) -> Result<(), AppError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.probe_inner())
            .await
            .map_err(|_| storage())?
    }
    async fn put(
        &self,
        ws: WorkspaceId,
        id: FileId,
        u: MediaUpload,
    ) -> Result<StoredFile, AppError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.put_inner(ws, id, u))
            .await
            .map_err(|_| storage())?
    }
    async fn read(&self, ws: WorkspaceId, id: FileId) -> Result<MediaUpload, AppError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.read_inner(ws, id))
            .await
            .map_err(|_| storage())?
    }
    async fn delete(&self, ws: WorkspaceId, id: FileId) -> Result<(), AppError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.delete_inner(ws, id))
            .await
            .map_err(|_| storage())?
    }
    async fn provider_url(
        &self,
        ws: WorkspaceId,
        id: FileId,
        e: OffsetDateTime,
    ) -> Result<Url, AppError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.provider_url_inner(ws, id, e))
            .await
            .map_err(|_| storage())?
    }
}

#[async_trait]
impl jt_app::ports::files::FileMaintenance for DiskFiles {
    async fn orphan_candidates(
        &self,
        ws: WorkspaceId,
        older_than: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let path = anchored(&this.root).join(ws.to_string());
            if !path.try_exists().map_err(|_| storage())? {
                return Ok(vec![]);
            }
            let parent = this.tenant(ws, false)?;
            this.repair_temps(&parent)?;
            let mut ids = vec![];
            for entry in io(std::fs::read_dir(anchored(&parent)))? {
                let e = io(entry)?;
                let Some(name) = e.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let Ok(id) = uuid::Uuid::parse_str(&name) else {
                    continue;
                };
                let meta = io(e.path().symlink_metadata())?;
                if meta.is_file() && OffsetDateTime::from(io(meta.modified())?) < older_than {
                    ids.push(FileId(id));
                }
            }
            Ok(ids)
        })
        .await
        .map_err(|_| storage())?
    }
}
