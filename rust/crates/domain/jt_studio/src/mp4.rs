//! A video's length and creation time from its ISO base media boxes (ISO/IEC 14496-12): the
//! top-level boxes are walked to `moov`, whose `mvhd` names a creation time, a timescale and a
//! duration in it. A fragmented video's `mvhd` names no duration (zero, or all ones for
//! "unknown"); its `mvex/mehd` then names the whole fragment duration in the same timescale.
//! Nothing else is read, and nothing is trusted: a box running past its parent, or shorter than
//! its own header, ends the walk.

/// The duration in milliseconds, or `None` when it cannot be read.
pub(crate) fn duration_ms(bytes: &[u8]) -> Option<u64> {
    moov_duration_ms(find(bytes, b"moov")?)
}

/// The duration in milliseconds a `moov` box's payload (its header left out) names, as
/// [`duration_ms`] reads it from the whole file.
pub(crate) fn moov_duration_ms(moov: &[u8]) -> Option<u64> {
    let mvhd = find(moov, b"mvhd")?;
    let version = *mvhd.first()?;
    // version(1) flags(3), then creation and modification times (4 or 8 each).
    let (timescale, duration) = match version {
        0 => (be32(mvhd, 12)?, unknown32(be32(mvhd, 16)?)),
        1 => (be32(mvhd, 20)?, unknown64(be64(mvhd, 24)?)),
        _ => return None,
    };
    if timescale == 0 {
        return None;
    }
    let duration = match duration {
        Some(d) if d > 0 => d,
        _ => fragment_duration(moov)?,
    };
    let ms = u128::from(duration) * 1000 / u128::from(timescale);
    u64::try_from(ms).ok()
}

/// Seconds from 1904-01-01T00:00:00Z, the epoch of ISO base media times, to the Unix epoch.
const MP4_EPOCH_TO_UNIX: i64 = 2_082_844_800;

/// When the video was made, from `moov/mvhd`'s creation time (seconds since 1904-01-01 UTC, 4 or
/// 8 bytes after the version and flags); `None` when it is zero (not set), unreadable, or outside
/// 1970–2100.
pub(crate) fn creation_time(bytes: &[u8]) -> Option<time::OffsetDateTime> {
    mvhd_creation_time(find(find(bytes, b"moov")?, b"mvhd")?)
}

/// The creation time an `mvhd` box's payload (`mvhd`, its header left out) names, as
/// [`creation_time`] reads it.
pub(crate) fn mvhd_creation_time(mvhd: &[u8]) -> Option<time::OffsetDateTime> {
    let seconds = match *mvhd.first()? {
        0 => u64::from(be32(mvhd, 4)?),
        1 => be64(mvhd, 4)?,
        _ => return None,
    };
    if seconds == 0 {
        return None;
    }
    let unix = i64::try_from(seconds).ok()? - MP4_EPOCH_TO_UNIX;
    let at = time::OffsetDateTime::from_unix_timestamp(unix).ok()?;
    (1970..=2100).contains(&at.year()).then_some(at)
}

/// `moov/mvex/mehd`'s fragment duration, when it names one.
fn fragment_duration(moov: &[u8]) -> Option<u64> {
    let mehd = find(find(moov, b"mvex")?, b"mehd")?;
    let duration = match *mehd.first()? {
        0 => unknown32(be32(mehd, 4)?),
        1 => unknown64(be64(mehd, 4)?),
        _ => None,
    }?;
    (duration > 0).then_some(duration)
}

/// A box's whole size (its header included) and its header's length, from `head`, its first
/// bytes (8, or 16 for a 64-bit size), and `left`, the bytes from its start to its parent's end:
/// `None` when it runs past its parent or is shorter than its own header.
pub(crate) fn box_size(head: &[u8], left: u64) -> Option<(u64, u64)> {
    let (size, header) = match be32(head, 0)? {
        // The box runs to the end of its parent.
        0 => (left, 8),
        1 => (be64(head, 8)?, 16),
        size => (u64::from(size), 8),
    };
    (size >= header && size <= left).then_some((size, header))
}

/// The payload of the first box of type `kind` among the boxes `bytes` holds.
fn find<'a>(mut bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    while bytes.len() >= 8 {
        let (size, header) = box_size(bytes, bytes.len() as u64)?;
        let (size, header) = (usize::try_from(size).ok()?, usize::try_from(header).ok()?);
        if &bytes[4..8] == kind {
            return Some(&bytes[header..size]);
        }
        bytes = &bytes[size..];
    }
    None
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn be64(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

/// A 32-bit duration, all ones meaning unknown.
fn unknown32(d: u32) -> Option<u64> {
    (d != u32::MAX).then_some(u64::from(d))
}

fn unknown64(d: u64) -> Option<u64> {
    (d != u64::MAX).then_some(d)
}
