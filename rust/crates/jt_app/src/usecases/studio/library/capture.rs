//! A new material's capture time, read from its stored file without holding it (spec §4.2, §5.3,
//! D41): a JPEG's first [`JPEG_HEAD`] bytes, where its EXIF segment is; a video's boxes walked a
//! header at a time to `moov/mvhd`, the boxes in between skipped unread. Other types name none.
//! What is read is a suggestion of the material's olay, never a check of the file.
use crate::{error::AppError, ports::files::StoredFile, usecases::Deps};
use jt_studio::{capture_time, mp4_box_header, mp4_moov_duration_ms, mp4_mvhd_capture_time};
use time::OffsetDateTime;

/// The bytes of a JPEG read for its capture time: its EXIF `APP1` segment is at most 64 KiB and
/// comes before the image data.
pub(crate) const JPEG_HEAD: usize = 128 * 1024;
/// The most boxes walked at one level of a video.
const MAX_BOXES: usize = 64;
/// The bytes a box header takes at most (a 64-bit size).
const BOX_HEAD: usize = 16;
/// The largest `mvhd` box read (version 1: 120 bytes).
const MAX_MVHD: u64 = 256;
/// The largest `moov` box read for a video's length: a story's video (at most a minute) has a
/// small one; a larger one names no length the server reads.
const MAX_MOOV: u64 = 4 * 1024 * 1024;

/// A box found in the walk: where its payload starts and where it ends, in the file.
struct Found {
    payload: u64,
    end: u64,
}

/// When the photo or video `f` was taken, as its bytes say; `None` when they say nothing.
pub(crate) async fn capture_time_of(
    d: &Deps,
    f: &StoredFile,
) -> Result<Option<OffsetDateTime>, AppError> {
    match f.mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" => {
            let head = d
                .files
                .read_range(f.workspace_id, f.id, 0, JPEG_HEAD)
                .await?;
            Ok(capture_time("image/jpeg", &head))
        }
        "video/mp4" => {
            let Some(moov) = find(d, f, 0, f.size_bytes, b"moov").await? else {
                return Ok(None);
            };
            let Some(mvhd) = find(d, f, moov.payload, moov.end, b"mvhd").await? else {
                return Ok(None);
            };
            let len = mvhd.end - mvhd.payload;
            if len > MAX_MVHD {
                return Ok(None);
            }
            let payload = d
                .files
                .read_range(f.workspace_id, f.id, mvhd.payload, len as usize)
                .await?;
            Ok(mp4_mvhd_capture_time(&payload))
        }
        _ => Ok(None),
    }
}

/// What the video `f` says of itself: how long it lasts, in milliseconds, as its `moov` box
/// says (`mvhd`, or a fragmented video's `mvex/mehd`; `None` when it says nothing the server
/// reads), and whether that `moov` comes before its media data (`mdat`), as Meta reads it ("fast
/// start"). Its box headers are walked to `moov`, then that box alone is read, never the media.
pub(crate) async fn video_facts_of(
    d: &Deps,
    f: &StoredFile,
) -> Result<(Option<u64>, bool), AppError> {
    let mdat = find(d, f, 0, f.size_bytes, b"mdat").await?;
    let Some(moov) = find(d, f, 0, f.size_bytes, b"moov").await? else {
        return Ok((None, false));
    };
    let first = mdat.is_none_or(|m| moov.payload < m.payload);
    let len = moov.end - moov.payload;
    if len > MAX_MOOV {
        return Ok((None, first));
    }
    let payload = d
        .files
        .read_range(f.workspace_id, f.id, moov.payload, len as usize)
        .await?;
    Ok((mp4_moov_duration_ms(&payload), first))
}

/// The first box of type `kind` among the boxes from byte `at` to byte `end` of `f`, reading
/// their headers alone.
async fn find(
    d: &Deps,
    f: &StoredFile,
    mut at: u64,
    end: u64,
    kind: &[u8; 4],
) -> Result<Option<Found>, AppError> {
    for _ in 0..MAX_BOXES {
        if end.saturating_sub(at) < 8 {
            return Ok(None);
        }
        let head = d
            .files
            .read_range(f.workspace_id, f.id, at, BOX_HEAD)
            .await?;
        let Some((found, size, header)) = mp4_box_header(&head, end - at) else {
            return Ok(None);
        };
        if &found == kind {
            return Ok(Some(Found {
                payload: at + header,
                end: at + size,
            }));
        }
        at += size;
    }
    Ok(None)
}
