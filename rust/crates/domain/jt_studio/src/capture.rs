//! When a photo or video was taken, read from its own bytes (spec 2026-11-03 §4.2, §5.3): a JPEG's
//! EXIF `DateTimeOriginal`, a video's `mvhd` creation time. Used to suggest the olay a new material
//! belongs to, never to decide whether it may be used. Nothing is trusted: a segment, box or entry
//! that runs past its parent ends the read with no time.
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

/// The capture time of a stored medium of type `mime`, when its bytes name one: a JPEG's EXIF
/// `DateTimeOriginal` (with its `OffsetTimeOriginal`, else read as Istanbul time, UTC+03, the
/// zone of the Studio calendar), or an MP4's `mvhd` creation time. `None` for any other type, or
/// a time outside 1970–2100.
pub fn capture_time(mime: &str, bytes: &[u8]) -> Option<OffsetDateTime> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" => jpeg_capture_time(bytes),
        "video/mp4" => crate::mp4::creation_time(bytes),
        _ => None,
    }
}

/// One ISO base media box header, for a reader that walks a stored video a header at a time
/// instead of holding it (spec D41): from `head`, the box's first bytes (16 suffice), and `left`,
/// the bytes from its start to its parent's end, the box's type, its whole size (its header
/// included) and its header's length. `None` when it runs past its parent or is shorter than its
/// own header, as [`capture_time`]'s own walk reads a box.
pub fn mp4_box_header(head: &[u8], left: u64) -> Option<([u8; 4], u64, u64)> {
    let kind: [u8; 4] = head.get(4..8)?.try_into().ok()?;
    let (size, header) = crate::mp4::box_size(head, left)?;
    Some((kind, size, header))
}

/// A video's length in milliseconds from its `moov` box's payload alone (its header left out):
/// `mvhd`'s duration, or a fragmented video's `mvex/mehd`.
pub fn mp4_moov_duration_ms(moov: &[u8]) -> Option<u64> {
    crate::mp4::moov_duration_ms(moov)
}

/// A video's capture time from its `moov/mvhd` box's payload alone (its header left out), as
/// [`capture_time`] reads it from the whole file.
pub fn mp4_mvhd_capture_time(mvhd: &[u8]) -> Option<OffsetDateTime> {
    crate::mp4::mvhd_creation_time(mvhd)
}

/// The EXIF tag of the Exif sub-IFD pointer in IFD0.
const EXIF_IFD: u16 = 0x8769;
/// `DateTimeOriginal`: when the picture was taken, `YYYY:MM:DD HH:MM:SS`.
const DATE_TIME_ORIGINAL: u16 = 0x9003;
/// `OffsetTimeOriginal`: its zone, `+HH:MM`.
const OFFSET_TIME_ORIGINAL: u16 = 0x9011;
/// The most IFD entries read.
const MAX_ENTRIES: usize = 512;

/// A JPEG's segments up to its scan data, the first `APP1` Exif segment read.
fn jpeg_capture_time(b: &[u8]) -> Option<OffsetDateTime> {
    if !b.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let marker = b[i + 1];
        match marker {
            // A fill byte before a marker.
            0xFF => {
                i += 1;
                continue;
            }
            // The scan or the end: no metadata after them.
            0xDA | 0xD9 => return None,
            // Markers without a length.
            0x01 | 0xD0..=0xD7 => {
                i += 2;
                continue;
            }
            _ => {}
        }
        let len = usize::from(u16::from_be_bytes([b[i + 2], b[i + 3]]));
        if len < 2 {
            return None;
        }
        let segment = b.get(i + 4..i + 2 + len)?;
        if marker == 0xE1
            && let Some(tiff) = segment.strip_prefix(b"Exif\0\0")
        {
            return exif_time(tiff);
        }
        i += 2 + len;
    }
    None
}

/// A TIFF structure's byte order.
#[derive(Clone, Copy)]
struct Tiff<'a> {
    bytes: &'a [u8],
    little: bool,
}

impl Tiff<'_> {
    fn u16(&self, at: usize) -> Option<u16> {
        let b: [u8; 2] = self.bytes.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if self.little {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    }

    fn u32(&self, at: usize) -> Option<u32> {
        let b: [u8; 4] = self.bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if self.little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    }

    /// The 12-byte entry of `tag` in the IFD at `ifd`: its type, count and value field's offset.
    fn entry(&self, ifd: usize, tag: u16) -> Option<(u16, usize, usize)> {
        let count = usize::from(self.u16(ifd)?).min(MAX_ENTRIES);
        (0..count).find_map(|n| {
            let at = ifd + 2 + 12 * n;
            (self.u16(at)? == tag).then_some(())?;
            let count = usize::try_from(self.u32(at + 4)?).ok()?;
            Some((self.u16(at + 2)?, count, at + 8))
        })
    }

    /// The ASCII value of `tag` in the IFD at `ifd`, without its terminating NULs.
    fn ascii(&self, ifd: usize, tag: u16) -> Option<&str> {
        let (kind, count, field) = self.entry(ifd, tag)?;
        if kind != 2 || count == 0 || count > 64 {
            return None;
        }
        let at = if count <= 4 {
            field
        } else {
            usize::try_from(self.u32(field)?).ok()?
        };
        let raw = self.bytes.get(at..at.checked_add(count)?)?;
        std::str::from_utf8(raw)
            .ok()
            .map(|s| s.trim_end_matches('\0'))
    }
}

/// `DateTimeOriginal` of the Exif sub-IFD of the TIFF structure `bytes`.
fn exif_time(bytes: &[u8]) -> Option<OffsetDateTime> {
    let little = match bytes.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let t = Tiff { bytes, little };
    if t.u16(2)? != 42 {
        return None;
    }
    let ifd0 = usize::try_from(t.u32(4)?).ok()?;
    let (kind, _, field) = t.entry(ifd0, EXIF_IFD)?;
    // The pointer is a LONG (4), or of the IFD type (13) some writers use.
    if kind != 4 && kind != 13 {
        return None;
    }
    let exif = usize::try_from(t.u32(field)?).ok()?;
    let local = parse_exif_date_time(t.ascii(exif, DATE_TIME_ORIGINAL)?)?;
    let offset = t
        .ascii(exif, OFFSET_TIME_ORIGINAL)
        .and_then(parse_exif_offset)
        .unwrap_or(UtcOffset::from_hms(3, 0, 0).ok()?);
    let at = local.assume_offset(offset);
    (1970..=2100).contains(&at.year()).then_some(at)
}

fn digits(s: &str) -> Option<u32> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// `YYYY:MM:DD HH:MM:SS`.
fn parse_exif_date_time(s: &str) -> Option<PrimitiveDateTime> {
    let (date, time) = s.trim().split_once(' ')?;
    let mut d = date.split(':');
    let (y, mo, da) = (d.next()?, d.next()?, d.next()?);
    let mut t = time.split(':');
    let (h, mi, se) = (t.next()?, t.next()?, t.next()?);
    if d.next().is_some() || t.next().is_some() {
        return None;
    }
    let date = Date::from_calendar_date(
        i32::try_from(digits(y)?).ok()?,
        Month::try_from(u8::try_from(digits(mo)?).ok()?).ok()?,
        u8::try_from(digits(da)?).ok()?,
    )
    .ok()?;
    let time = Time::from_hms(
        u8::try_from(digits(h)?).ok()?,
        u8::try_from(digits(mi)?).ok()?,
        u8::try_from(digits(se)?).ok()?,
    )
    .ok()?;
    Some(PrimitiveDateTime::new(date, time))
}

/// `+HH:MM` or `-HH:MM`.
fn parse_exif_offset(s: &str) -> Option<UtcOffset> {
    let s = s.trim();
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    let (h, m) = rest.split_once(':')?;
    let (h, m) = (
        i8::try_from(digits(h)?).ok()?,
        i8::try_from(digits(m)?).ok()?,
    );
    UtcOffset::from_hms(sign * h, sign * m, 0).ok()
}
