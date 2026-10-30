//! Linux local storage: descriptor-anchored tenant roots, immutable atomic files and signed transport.
//! A file is its metadata header (length, then JSON) and its bytes; a streamed upload
//! ([`FileStore::put_stream`]) is written chunk by chunk to a temporary file, hashed as it comes,
//! and only then given its header and linked into place, so memory holds a chunk at a time. The
//! signed retrieval route ([`router`]) serves a file the same way: read [`READ_CHUNK`] bytes at a
//! time ([`FileStore::read_stream`]), hashed as they are read, the last chunk given out only once
//! the hash is the header's; a few files at a time ([`MAX_CONCURRENT_READS`]), and never held by
//! a client that stopped reading ([`READ_IDLE`], [`READ_DEADLINE`]).
mod fetch;
mod serve;
use async_trait::async_trait;
pub use fetch::CheckedMediaFetcher;
use hmac::{Hmac, KeyInit, Mac};
use jt_app::{
    error::{AppError, ErrorCode},
    ports::{
        Clock,
        connectors::MediaUpload,
        files::{ByteSource, FileStore, StoredFile, StreamedFile},
    },
    usecases::files::{
        DEVICE_FILE_LIMIT, HEAD_BYTES, OCTET_STREAM, STORED_LIMIT, filename_ok, streams,
        validate_stored, validate_stored_head,
    },
    usecases::studio::files::{invalid, limit},
};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
pub use serve::{
    DEVICE_PURPOSE, MAX_CONCURRENT_READS, READ_DEADLINE, READ_IDLE, READ_TURN_WAIT, READS_PER_FILE,
    READS_PER_WORKSPACE, ReadLimits, router, router_with_limits,
};
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
/// The most bytes one read of a file being served takes ([`FileStore::read_stream`]): what memory
/// holds of it at a time, whatever its size and however many read it at once.
pub const READ_CHUNK: usize = 64 * 1024;
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
/// A temporary file in a tenant directory, removed when dropped (a stream that failed part way, or
/// the parts of one that was linked into place). It holds its directory open, so its path stays
/// valid.
struct Temp {
    path: PathBuf,
    _dir: Arc<File>,
}
impl Temp {
    fn new(dir: &Arc<File>) -> Self {
        Self {
            path: anchored(dir).join(format!(".{}.tmp", uuid::Uuid::new_v4())),
            _dir: dir.clone(),
        }
    }
    fn create(&self) -> Result<File, AppError> {
        io(OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.path))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
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
    /// File `id`'s metadata, read from its header alone, with the file's length checked against
    /// it: no byte of the file is read. `NOT_FOUND` when there is no such file.
    fn load_meta(&self, ws: WorkspaceId, id: FileId) -> Result<StoredFile, AppError> {
        self.open_checked(ws, id).map(|(f, _)| f)
    }
    /// File `id` opened to be served a chunk at a time ([`FileStore::read_stream`]): its header
    /// checked as [`DiskFiles::load_meta`] checks it, and its metadata as [`validate_stored`]
    /// would (a type the store keeps, a size within that type's limit, a name it takes); the file
    /// positioned at its first byte, whose bytes [`Serving`] checks as they are read.
    fn stream_inner(&self, ws: WorkspaceId, id: FileId) -> Result<(StoredFile, File), AppError> {
        let (f, file) = self.open_checked(ws, id)?;
        let fits = match f.mime.as_str() {
            OCTET_STREAM => f.size_bytes <= DEVICE_FILE_LIMIT,
            mime => limit(mime).is_ok_and(|max| f.size_bytes > 0 && f.size_bytes <= max),
        };
        if !fits || !filename_ok(&f.filename) {
            return Err(storage());
        }
        Ok((f, file))
    }
    /// File `id` opened, its metadata read from its header alone and the file's length checked
    /// against it, positioned at its first byte: no byte of the file is read. `NOT_FOUND` when
    /// there is no such file.
    fn open_checked(&self, ws: WorkspaceId, id: FileId) -> Result<(StoredFile, File), AppError> {
        let tenant = anchored(&self.root).join(ws.to_string());
        if !tenant.try_exists().map_err(|_| storage())? {
            return Err(AppError::not_found("file"));
        }
        let parent = self.tenant(ws, false)?;
        let opened = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(anchored(&parent).join(id.to_string()));
        let mut file = match opened {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::not_found("file"));
            }
            Err(_) => return Err(storage()),
        };
        let meta = io(file.metadata())?;
        if !meta.is_file() {
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
        if f.id != id
            || f.workspace_id != ws
            || f.size_bytes > STORED_LIMIT
            || meta.len() != 4 + n as u64 + f.size_bytes
        {
            return Err(storage());
        }
        Ok((f, file))
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
        if f.id != id || f.workspace_id != ws || f.size_bytes > STORED_LIMIT {
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
        validate_stored(&u)?;
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
        validate_stored(&u)?;
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
        self.load_meta(ws, id)
    }
    /// The first half of a streamed put: the tenant directory, and the temporary file the bytes
    /// are written to. A file that is already there is `CONFLICT`: a streamed file is new.
    fn stream_open(
        &self,
        ws: WorkspaceId,
        id: FileId,
    ) -> Result<(Arc<File>, Temp, File), AppError> {
        if id.0.is_nil() {
            return Err(storage());
        }
        let parent = Arc::new(self.tenant(ws, true)?);
        self.repair_temps(&parent)?;
        if anchored(&parent)
            .join(id.to_string())
            .symlink_metadata()
            .is_ok()
        {
            return Err(AppError::conflict("file identity is immutable"));
        }
        let data = Temp::new(&parent);
        let file = data.create()?;
        Ok((parent, data, file))
    }
    /// The second half of a streamed put: the header of `f` and the bytes of `data` written to a
    /// second temporary file, which is synced and linked into place as file `f.id` (no-replace, as
    /// [`DiskFiles::put_inner`] commits). Both temporary files go.
    fn stream_commit(
        &self,
        parent: &Arc<File>,
        data: &Temp,
        f: StoredFile,
    ) -> Result<StoredFile, AppError> {
        let header = serde_json::to_vec(&f).map_err(|_| storage())?;
        let whole = Temp::new(parent);
        let mut out = whole.create()?;
        io(out.write_all(&(header.len() as u32).to_be_bytes()))?;
        io(out.write_all(&header))?;
        let mut bytes = io(OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&data.path))?;
        if io(std::io::copy(&mut bytes, &mut out))? != f.size_bytes {
            return Err(storage());
        }
        io(out.sync_all())?;
        drop(out);
        match std::fs::hard_link(&whole.path, anchored(parent).join(f.id.to_string())) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(AppError::conflict("file identity is immutable"));
            }
            Err(_) => return Err(storage()),
        }
        io(parent.sync_all())?;
        Ok(f)
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
    /// A URL that reads file `id` until `expires_at`: after now and at most 24 hours (and a
    /// second's grace) ahead, the longest [`verify_for`] accepts, signed for `purpose` (`None`: a
    /// provider's, as studio hands its media out for 24 hours; [`DEVICE_PURPOSE`]: a device's
    /// download or an agent's file address, served from a pool of its own).
    fn signed_url(
        &self,
        ws: WorkspaceId,
        id: FileId,
        expires_at: OffsetDateTime,
        purpose: Option<&str>,
    ) -> Result<Url, AppError> {
        let now = self.clock.now();
        if expires_at <= now || expires_at - now > Duration::hours(24) + Duration::seconds(1) {
            return Err(AppError::validation(
                "a file URL lives at most 24 hours",
                serde_json::json!({}),
            ));
        }
        self.load_meta(ws, id)?;
        let expires = expires_at
            .unix_timestamp()
            .min((now + Duration::hours(24)).unix_timestamp());
        let sig = sign(&self.key, ws, id, expires, purpose);
        let mut url = self
            .base
            .join(&format!("files/{id}"))
            .map_err(|_| storage())?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("workspace", &ws.to_string())
                .append_pair("expires", &expires.to_string())
                .append_pair("signature", &sig);
            if let Some(purpose) = purpose {
                query.append_pair("purpose", purpose);
            }
        }
        Ok(url)
    }
}
/// The signature of an address: `jeeta.files.v1` for a provider's (no purpose, as every address
/// was before purposes), `jeeta.files.v2` with the purpose for any other, so an address of one
/// purpose never verifies as another's.
fn mac(
    key: &[u8; 32],
    ws: WorkspaceId,
    id: FileId,
    expires: i64,
    purpose: Option<&str>,
) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC key");
    let text = match purpose {
        None => format!("jeeta.files.v1\n{ws}\n{id}\n{expires}"),
        Some(purpose) => format!("jeeta.files.v2\n{ws}\n{id}\n{expires}\n{purpose}"),
    };
    mac.update(text.as_bytes());
    mac
}
fn sign(
    key: &[u8; 32],
    ws: WorkspaceId,
    id: FileId,
    expires: i64,
    purpose: Option<&str>,
) -> String {
    hex::encode(mac(key, ws, id, expires, purpose).finalize().into_bytes())
}
/// [`verify_for`] a provider's address (signed without a purpose).
pub fn verify(
    key: &[u8; 32],
    ws: WorkspaceId,
    id: FileId,
    expires: i64,
    signature: &str,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    verify_for(key, ws, id, expires, None, signature, now)
}
/// `Ok` when `signature` signs file `id` of workspace `ws` until `expires` for `purpose`, and
/// `expires` is after `now` and at most 24 hours ahead; else `NOT_FOUND`.
pub fn verify_for(
    key: &[u8; 32],
    ws: WorkspaceId,
    id: FileId,
    expires: i64,
    purpose: Option<&str>,
    signature: &str,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    if expires <= now.unix_timestamp() || expires > (now + Duration::hours(24)).unix_timestamp() {
        return Err(AppError::not_found("file"));
    }
    let bytes = hex::decode(signature).map_err(|_| AppError::not_found("file"))?;
    mac(key, ws, id, expires, purpose)
        .verify_slice(&bytes)
        .map_err(|_| AppError::not_found("file"))
}
/// A stored file's bytes as they are served ([`FileStore::read_stream`]): read at most
/// [`READ_CHUNK`] bytes at a time, hashed as they come. The chunk that completes the file is given
/// out only once nothing follows it and the hash of all of them is the header's; else, as when the
/// file ends short of its header's length, the read ends with an error, so the reader never
/// receives the file whole.
struct Serving {
    file: tokio::fs::File,
    /// The bytes still to read.
    left: u64,
    hasher: Sha256,
    /// The header's hash.
    sha256: String,
    done: bool,
}
impl Serving {
    /// `Ok` when what was read is the stored file: nothing follows it, and its hash is the
    /// header's. The read is over either way.
    async fn check_end(&mut self) -> Result<(), AppError> {
        use tokio::io::AsyncReadExt as _;
        self.done = true;
        let mut extra = [0u8; 1];
        let more = self.file.read(&mut extra).await.map_err(|_| storage())?;
        let hash = hex::encode(std::mem::replace(&mut self.hasher, Sha256::new()).finalize());
        if more != 0 || hash != self.sha256 {
            return Err(storage());
        }
        Ok(())
    }
}
#[async_trait]
impl ByteSource for Serving {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        use tokio::io::AsyncReadExt as _;
        if self.done {
            return Ok(None);
        }
        if self.left == 0 {
            // An empty file: there is only its hash to check.
            self.check_end().await?;
            return Ok(None);
        }
        let want = usize::try_from(self.left).map_or(READ_CHUNK, |left| left.min(READ_CHUNK));
        let mut chunk = vec![0; want];
        let n = match self.file.read(&mut chunk).await {
            Ok(n) if n > 0 => n,
            // Shorter than its header says, or unreadable.
            _ => {
                self.done = true;
                return Err(storage());
            }
        };
        chunk.truncate(n);
        self.left -= n as u64;
        self.hasher.update(&chunk);
        if self.left == 0 {
            self.check_end().await?;
        }
        Ok(Some(chunk))
    }
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
    async fn exists(&self, ws: WorkspaceId, id: FileId) -> Result<bool, AppError> {
        let this = self.clone();
        let header = tokio::task::spawn_blocking(move || this.load_meta(ws, id))
            .await
            .map_err(|_| storage())?;
        match header {
            Ok(_) => Ok(true),
            Err(e) if e.code == ErrorCode::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
    async fn read_stream(&self, ws: WorkspaceId, id: FileId) -> Result<StreamedFile, AppError> {
        let this = self.clone();
        let (f, file) = tokio::task::spawn_blocking(move || this.stream_inner(ws, id))
            .await
            .map_err(|_| storage())??;
        Ok(StreamedFile {
            mime: f.mime,
            size_bytes: f.size_bytes,
            bytes: Box::new(Serving {
                file: tokio::fs::File::from_std(file),
                left: f.size_bytes,
                hasher: Sha256::new(),
                sha256: f.sha256,
                done: false,
            }),
        })
    }
    async fn put_stream(
        &self,
        ws: WorkspaceId,
        id: FileId,
        mime: &str,
        filename: &str,
        source: &mut dyn ByteSource,
    ) -> Result<StoredFile, AppError> {
        use tokio::io::AsyncWriteExt as _;
        if !streams(mime) {
            // A type whose check reads the whole file: put whole.
            let mut bytes = Vec::new();
            while let Some(chunk) = source.next_chunk().await? {
                if (bytes.len() + chunk.len()) as u64 > STORED_LIMIT {
                    return Err(invalid());
                }
                bytes.extend_from_slice(&chunk);
            }
            let upload = MediaUpload {
                bytes,
                mime: mime.to_owned(),
                filename: filename.to_owned(),
            };
            return self.put(ws, id, upload).await;
        }
        if !filename_ok(filename) {
            return Err(invalid());
        }
        let this = self.clone();
        let (parent, data, file) = tokio::task::spawn_blocking(move || this.stream_open(ws, id))
            .await
            .map_err(|_| storage())??;
        let mut out = tokio::fs::File::from_std(file);
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        let mut head = Vec::with_capacity(HEAD_BYTES);
        while let Some(chunk) = source.next_chunk().await? {
            size += chunk.len() as u64;
            if size > STORED_LIMIT {
                return Err(invalid());
            }
            let wanted = (HEAD_BYTES - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..wanted]);
            hasher.update(&chunk);
            out.write_all(&chunk).await.map_err(|_| storage())?;
        }
        out.flush().await.map_err(|_| storage())?;
        out.sync_all().await.map_err(|_| storage())?;
        drop(out);
        validate_stored_head(mime, filename, size, &head)?;
        let f = StoredFile {
            id,
            workspace_id: ws,
            mime: mime.to_owned(),
            filename: filename.to_owned(),
            size_bytes: size,
            sha256: hex::encode(hasher.finalize()),
            created_at: self.clock.now(),
            cleanup_due_at: None,
            deleted_at: None,
        };
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.stream_commit(&parent, &data, f))
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
        tokio::task::spawn_blocking(move || this.signed_url(ws, id, e, None))
            .await
            .map_err(|_| storage())?
    }
    async fn device_url(
        &self,
        ws: WorkspaceId,
        id: FileId,
        e: OffsetDateTime,
    ) -> Result<Url, AppError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.signed_url(ws, id, e, Some(DEVICE_PURPOSE)))
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
