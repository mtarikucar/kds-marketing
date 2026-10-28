//! A video's length from its ISO base media boxes (ISO/IEC 14496-12): the top-level boxes are
//! walked to `moov`, whose `mvhd` names a timescale and a duration in it. A fragmented video's
//! `mvhd` names none (zero, or all ones for "unknown"); its `mvex/mehd` then names the whole
//! fragment duration in the same timescale. Nothing else is read, and nothing is trusted: a box
//! running past its parent, or shorter than its own header, ends the walk.

/// The duration in milliseconds, or `None` when it cannot be read.
pub(crate) fn duration_ms(bytes: &[u8]) -> Option<u64> {
    let moov = find(bytes, b"moov")?;
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

/// The payload of the first box of type `kind` among the boxes `bytes` holds.
fn find<'a>(mut bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    while bytes.len() >= 8 {
        let size = be32(bytes, 0)?;
        let (size, header) = match size {
            // The box runs to the end of its parent.
            0 => (bytes.len(), 8),
            1 => (usize::try_from(be64(bytes, 8)?).ok()?, 16),
            size => (usize::try_from(size).ok()?, 8),
        };
        if size < header || size > bytes.len() {
            return None;
        }
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
