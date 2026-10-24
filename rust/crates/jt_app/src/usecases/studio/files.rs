//! Durable tenant media ingestion and evidence-based retention. Payloads are never logged.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{connectors::MediaUpload, files::StoredFile},
    usecases::{Deps, ledger_entry},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use jt_studio::*;
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Duration;
use url::Url;

pub const IMAGE_LIMIT: u64 = 25_000_000;
pub const VIDEO_LIMIT: u64 = 200_000_000;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UploadContent {
    BytesBase64 { data: String },
    SourceUrl { url: Url },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileUploadInput {
    pub request_key: String,
    pub filename: String,
    pub mime: String,
    pub content: UploadContent,
}
pub fn invalid() -> AppError {
    AppError::validation("invalid media", json!({"field":"media"}))
}
pub fn limit(mime: &str) -> Result<u64, AppError> {
    match mime {
        "image/jpeg" | "image/png" | "image/webp" | "image/gif" => Ok(IMAGE_LIMIT),
        "video/mp4" => Ok(VIDEO_LIMIT),
        _ => Err(invalid()),
    }
}
pub fn validate_upload(u: &MediaUpload) -> Result<(), AppError> {
    let max = limit(&u.mime)?;
    if u.bytes.is_empty()
        || u.bytes.len() as u64 > max
        || u.filename.is_empty()
        || u.filename.len() > 255
        || u.filename.contains(['/', '\\'])
        || u.filename.chars().any(char::is_control)
        || matches!(u.filename.as_str(), "." | "..")
    {
        return Err(invalid());
    }
    let b = &u.bytes;
    let matches = match u.mime.as_str() {
        "image/jpeg" => b.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => b.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/gif" => b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a"),
        "image/webp" => b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP"),
        "video/mp4" => mp4_file_type(b)
            .is_some_and(|ftyp| mp4_brand(&ftyp[..4]) || ftyp[8..].chunks_exact(4).any(mp4_brand)),
        _ => false,
    };
    if !matches {
        return Err(invalid());
    }
    Ok(())
}
/// Read only the declared ftyp box: major brand, minor version, then four-byte
/// compatible brands. Never interpret following boxes or the minor version as brands.
fn mp4_file_type(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.get(4..8)? != b"ftyp" {
        return None;
    }
    let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
    let (size, header) = match size {
        0 => (bytes.len(), 8),
        1 => (
            usize::try_from(u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)).ok()?,
            16,
        ),
        size => (usize::try_from(size).ok()?, 8),
    };
    let payload = bytes.get(..size)?.get(header..)?;
    if payload.len() < 8 || !(payload.len() - 8).is_multiple_of(4) {
        return None;
    }
    Some(payload)
}

fn mp4_brand(brand: &[u8]) -> bool {
    matches!(
        brand,
        b"isom"
            | b"iso2"
            | b"iso3"
            | b"iso4"
            | b"iso5"
            | b"iso6"
            | b"mp41"
            | b"mp42"
            | b"avc1"
            | b"dash"
            | b"M4V "
    )
}

pub(crate) fn key(key: &str) -> Result<(), AppError> {
    if key.trim().is_empty() || key.len() > 200 {
        Err(AppError::validation(
            "request key required (max 200 bytes)",
            json!({"field":"request_key"}),
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn encode<T: Serialize>(i: &T) -> Result<Value, AppError> {
    serde_json::to_value(i).map_err(|_| invalid())
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, AppError> {
    serde_json::from_value(v).map_err(|_| AppError::internal("invalid receipt"))
}
/// Physical reads and metadata checks run under the caller's control fence when adopting a file.
pub(crate) async fn available(
    d: &Deps,
    ws: WorkspaceId,
    f: &StoredFile,
) -> Result<MediaUpload, AppError> {
    use sha2::{Digest, Sha256};
    if f.workspace_id != ws || f.deleted_at.is_some() {
        return Err(AppError::not_found("file"));
    }
    let u = d.files.read(ws, f.id).await?;
    validate_upload(&u)?;
    let hash: String = Sha256::digest(&u.bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if u.bytes.len() as u64 != f.size_bytes
        || u.mime != f.mime
        || u.filename != f.filename
        || hash != f.sha256
    {
        return Err(invalid());
    }
    Ok(u)
}
pub async fn upload_bytes(
    d: &Deps,
    ws: WorkspaceId,
    id: FileId,
    u: MediaUpload,
) -> Result<StoredFile, AppError> {
    validate_upload(&u)?;
    d.files.put(ws, id, u).await
}
#[derive(Default)]
pub(crate) struct Staging {
    pub files: Vec<StoredFile>,
    ids: Vec<FileId>,
    pub commit_started: bool,
}
impl Staging {
    pub fn new() -> Self {
        Self {
            files: vec![],
            ids: vec![],
            commit_started: false,
        }
    }
    pub async fn put(
        &mut self,
        d: &Deps,
        ws: WorkspaceId,
        u: MediaUpload,
    ) -> Result<StoredFile, AppError> {
        let id = FileId(d.ids.uuid());
        self.ids.push(id);
        let f = upload_bytes(d, ws, id, u).await?;
        self.files.push(f.clone());
        Ok(f)
    }
    pub async fn compensate(&self, d: &Deps, ws: WorkspaceId) {
        if !self.commit_started {
            for id in &self.ids {
                let _ = d.files.delete(ws, *id).await;
            }
        }
    }
}
pub async fn file_upload(d: &Deps, ctx: &Ctx, i: FileUploadInput) -> Result<StoredFile, AppError> {
    let mut stage = Staging::new();
    let result = file_upload_in(d, ctx, i, &mut stage).await;
    stage.compensate(d, ctx.workspace_id).await;
    result
}
async fn file_upload_in(
    d: &Deps,
    ctx: &Ctx,
    i: FileUploadInput,
    stage: &mut Staging,
) -> Result<StoredFile, AppError> {
    ctx.require(Permission::StudioWork)?;
    key(&i.request_key)?;
    limit(&i.mime)?;
    // Only a digest of bytes/URLs reaches request storage.
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        super::work::gated(r.as_mut(), ctx).await?;
        if let Some(v) = r
            .studio()
            .request_replay("studio.file_upload", &i.request_key, &payload)
            .await?
        {
            return decode(v);
        }
    }
    let upload = match i.content {
        UploadContent::BytesBase64 { data } => {
            if data.len() as u64 > 4 * limit(&i.mime)?.div_ceil(3) {
                return Err(invalid());
            }
            MediaUpload {
                bytes: STANDARD.decode(data).map_err(|_| invalid())?,
                mime: i.mime,
                filename: i.filename,
            }
        }
        UploadContent::SourceUrl { url } => {
            d.media_fetch
                .fetch(ctx.workspace_id, &url, &i.mime, &i.filename)
                .await?
        }
    };
    validate_upload(&upload)?;
    // Fresh IDs make failed or competing uploads independent. No byte write occurs under a DB lock.
    let file = stage.put(d, ctx.workspace_id, upload).await?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    super::work::gated(r.as_mut(), ctx).await?;
    if let Some(v) = r
        .studio()
        .request_replay("studio.file_upload", &i.request_key, &payload)
        .await?
    {
        return decode(v);
    }
    available(d, ctx.workspace_id, &file).await?;
    r.studio().save_file(file.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.file_upload",
            "studio_file",
            file.id,
            json!({"sha256":file.sha256,"size_bytes":file.size_bytes,"mime":file.mime}),
        )?)
        .await?;
    r.studio()
        .request_receipt(
            "studio.file_upload",
            &i.request_key,
            &payload,
            &encode(&file)?,
        )
        .await?;
    stage.commit_started = true;
    r.commit().await?;
    Ok(file)
}
pub(crate) fn uses(p: &Piece, id: FileId) -> bool {
    p.media
        .iter()
        .chain(p.adaptations.values().flat_map(|a| a.media.iter()))
        .any(|m| matches!(m,MediaAsset::File{id:i} if *i==id))
}
pub async fn cleanup_files(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let now = d.clock.now();
    let mut r = d.uow.tenant(ws).await?;
    // Maintenance remains valid without a live strategy. Lock excludes new references until deletion is marked.
    r.studio_control().lock_control().await?;
    let usage = r.studio().file_usage().await?;
    let mut count = 0;
    // A 24-hour grace separates abandoned submissions from writes still in progress.
    // The shared control lock prevents a delayed metadata commit from racing reconciliation.
    let known: std::collections::HashSet<_> = usage.files.iter().map(|f| f.id).collect();
    for id in d
        .file_maintenance
        .orphan_candidates(ws, now - Duration::hours(24))
        .await?
    {
        if !known.contains(&id) {
            d.files.delete(ws, id).await?;
        }
    }
    for mut f in usage.files {
        if f.deleted_at.is_some() {
            continue;
        }
        let pending = usage.pieces.iter().any(|(id, p)| {
            uses(p, f.id)
                && usage.slots.iter().any(|s| {
                    s.id == *id
                        && matches!(s.state, SlotState::Planned | SlotState::Ready)
                        && s.revision == p.revision
                })
        });
        let unknown = usage.attempts.iter().any(|a| {
            uses(a.piece(), f.id)
                && matches!(
                    a.state(),
                    PublishState::Queued | PublishState::Sending | PublishState::Unknown
                )
        });
        let last = usage
            .publications
            .iter()
            .filter(|p| {
                usage
                    .pieces
                    .iter()
                    .any(|(_, piece)| piece.id == p.piece_id && uses(piece, f.id))
            })
            .map(|p| p.published_at)
            .max();
        f.cleanup_due_at = last.map(|at| at + Duration::days(30));
        if !pending && !unknown && f.cleanup_due_at.is_some_and(|at| now >= at) {
            d.files.delete(ws, f.id).await?;
            f.deleted_at = Some(now);
            count += 1;
        }
        r.studio().save_file(f).await?;
    }
    r.commit().await?;
    Ok(count)
}
/// Build provider transport at dispatch time, reloading durable bytes for X.
pub async fn resolve_media(
    d: &Deps,
    ws: WorkspaceId,
    media: &[MediaAsset],
    for_x: bool,
) -> Result<(Vec<Url>, Vec<MediaUpload>), AppError> {
    let mut urls = vec![];
    let mut bytes = vec![];
    for m in media {
        match m {
            MediaAsset::File { id } => {
                let mut r = d.uow.tenant(ws).await?;
                let f = r
                    .studio()
                    .get_file(*id)
                    .await?
                    .ok_or_else(|| AppError::not_found("file"))?;
                if f.deleted_at.is_some() {
                    return Err(AppError::not_found("file"));
                }
                drop(r);
                if for_x {
                    let u = d.files.read(ws, *id).await?;
                    validate_upload(&u)?;
                    bytes.push(u)
                } else {
                    urls.push(
                        d.files
                            .provider_url(ws, *id, d.clock.now() + Duration::hours(24))
                            .await?,
                    )
                }
            }
            MediaAsset::HostedUrl {
                url,
                mime,
                size_bytes,
            } => {
                let u = d.media_fetch.fetch(ws, url, mime, "asset").await?;
                validate_upload(&u)?;
                if u.bytes.len() as u64 != *size_bytes {
                    return Err(invalid());
                }
                if for_x {
                    bytes.push(u)
                } else {
                    urls.push(url.clone())
                }
            }
            MediaAsset::Bytes { .. } => return Err(invalid()),
        }
    }
    Ok((urls, bytes))
}
