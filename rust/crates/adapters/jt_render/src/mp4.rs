//! A minimal MP4 writer (ISO/IEC 14496-12 and 14496-15) for one H.264 video track and nothing
//! else: `ftyp`, then `moov` (so a player, or Meta's ingest, reads the index before any media:
//! "fast start"), then one `mdat`. No edit list, no fragments, no audio track. Samples are
//! length-prefixed NAL units (4-byte lengths), the parameter sets live in `avcC`.

/// One video track's index and parameter sets.
pub(crate) struct Track {
    pub width: u32,
    pub height: u32,
    /// Media time units per second.
    pub timescale: u32,
    /// Each sample's duration in `timescale` units (a constant frame rate).
    pub sample_delta: u32,
    /// The sequence and picture parameter sets, without start codes.
    pub sps: Vec<u8>,
    pub pps: Vec<u8>,
    /// Each sample's size in bytes, in order.
    pub sizes: Vec<u32>,
    /// The 1-based numbers of the sync (IDR) samples.
    pub sync: Vec<u32>,
    /// Samples per chunk (the last chunk may hold fewer).
    pub chunk_samples: u32,
}

impl Track {
    /// The track's length in its own timescale.
    fn media_duration(&self) -> u64 {
        self.sizes.len() as u64 * u64::from(self.sample_delta)
    }

    /// The track's length in milliseconds.
    pub fn duration_ms(&self) -> u64 {
        self.media_duration() * 1000 / u64::from(self.timescale.max(1))
    }
}

/// A box: its type and payload, length-prefixed.
fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// A full box: version and flags, then the payload.
fn full(kind: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(payload.len() + 4);
    p.push(version);
    p.extend_from_slice(&flags.to_be_bytes()[1..]);
    p.extend_from_slice(payload);
    boxed(kind, &p)
}

fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

struct W(Vec<u8>);

impl W {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn zeros(&mut self, n: usize) -> &mut Self {
        self.0.extend(std::iter::repeat_n(0u8, n));
        self
    }
    fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.0.extend_from_slice(b);
        self
    }
    /// The identity transformation matrix.
    fn matrix(&mut self) -> &mut Self {
        for v in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
            self.u32(v);
        }
        self
    }
    fn done(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

fn ftyp() -> Vec<u8> {
    let mut w = W::new();
    w.bytes(b"isom").u32(0x200);
    for brand in [b"isom", b"iso2", b"avc1", b"mp41"] {
        w.bytes(brand);
    }
    boxed(b"ftyp", &w.done())
}

/// `avcC`: the decoder configuration record (ISO/IEC 14496-15 §5.3.3.1).
fn avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut w = W::new();
    w.u8(1)
        .u8(sps.get(1).copied().unwrap_or(66))
        .u8(sps.get(2).copied().unwrap_or(0))
        .u8(sps.get(3).copied().unwrap_or(40))
        // reserved (6 bits) and lengthSizeMinusOne = 3.
        .u8(0xff)
        // reserved (3 bits) and one SPS.
        .u8(0xe1)
        .u16(sps.len() as u16)
        .bytes(sps)
        .u8(1)
        .u16(pps.len() as u16)
        .bytes(pps);
    boxed(b"avcC", &w.done())
}

/// The sample description: one `avc1` entry with its `avcC` and its colour (BT.709, limited
/// range, as the SPS's VUI says).
fn stsd(t: &Track) -> Vec<u8> {
    let mut colr = W::new();
    colr.bytes(b"nclx").u16(1).u16(1).u16(1).u8(0);
    let mut name = [0u8; 32];
    let label = b"jeeta reel";
    name[0] = label.len() as u8;
    name[1..=label.len()].copy_from_slice(label);
    let mut w = W::new();
    w.zeros(6)
        .u16(1)
        .u16(0)
        .u16(0)
        .zeros(12)
        .u16(t.width as u16)
        .u16(t.height as u16)
        .u32(0x0048_0000)
        .u32(0x0048_0000)
        .u32(0)
        .u16(1)
        .bytes(&name)
        .u16(0x0018)
        .u16(0xffff)
        .bytes(&avcc(&t.sps, &t.pps))
        .bytes(&boxed(b"colr", &colr.done()));
    let avc1 = boxed(b"avc1", &w.done());
    let mut s = W::new();
    s.u32(1).bytes(&avc1);
    full(b"stsd", 0, 0, &s.done())
}

/// The sample tables, with each chunk's offset from `base` (where the first sample starts).
fn stbl(t: &Track, base: u64) -> Vec<u8> {
    let n = t.sizes.len() as u32;
    let per = t.chunk_samples.max(1);
    let chunks = n.div_ceil(per);
    let mut stts = W::new();
    stts.u32(1).u32(n).u32(t.sample_delta);
    let mut stss = W::new();
    stss.u32(t.sync.len() as u32);
    for s in &t.sync {
        stss.u32(*s);
    }
    let mut stsc = W::new();
    let last = n - per * chunks.saturating_sub(1);
    if chunks > 1 && last != per {
        stsc.u32(2)
            .u32(1)
            .u32(per)
            .u32(1)
            .u32(chunks)
            .u32(last)
            .u32(1);
    } else {
        stsc.u32(1)
            .u32(1)
            .u32(if chunks > 1 { per } else { n })
            .u32(1);
    }
    let mut stsz = W::new();
    stsz.u32(0).u32(n);
    for s in &t.sizes {
        stsz.u32(*s);
    }
    let mut stco = W::new();
    stco.u32(chunks);
    let mut at = base;
    for (i, s) in t.sizes.iter().enumerate() {
        if (i as u32).is_multiple_of(per) {
            stco.u32(at as u32);
        }
        at += u64::from(*s);
    }
    boxed(
        b"stbl",
        &concat(&[
            stsd(t),
            full(b"stts", 0, 0, &stts.done()),
            full(b"stss", 0, 0, &stss.done()),
            full(b"stsc", 0, 0, &stsc.done()),
            full(b"stsz", 0, 0, &stsz.done()),
            full(b"stco", 0, 0, &stco.done()),
        ]),
    )
}

fn moov(t: &Track, base: u64) -> Vec<u8> {
    let ms = t.duration_ms() as u32;
    let mut mvhd = W::new();
    mvhd.u32(0)
        .u32(0)
        .u32(1000)
        .u32(ms)
        .u32(0x0001_0000)
        .u16(0x0100)
        .zeros(10)
        .matrix()
        .zeros(24)
        .u32(2);
    let mut tkhd = W::new();
    tkhd.u32(0)
        .u32(0)
        .u32(1)
        .u32(0)
        .u32(ms)
        .zeros(8)
        .u16(0)
        .u16(0)
        .u16(0)
        .u16(0)
        .matrix()
        .u32(t.width << 16)
        .u32(t.height << 16);
    let mut mdhd = W::new();
    // Language "und", packed as three 5-bit letters.
    mdhd.u32(0)
        .u32(0)
        .u32(t.timescale)
        .u32(t.media_duration() as u32)
        .u16(0x55c4)
        .u16(0);
    let mut hdlr = W::new();
    hdlr.u32(0)
        .bytes(b"vide")
        .zeros(12)
        .bytes(b"VideoHandler\0");
    let mut vmhd = W::new();
    vmhd.u16(0).zeros(6);
    let mut dref = W::new();
    dref.u32(1).bytes(&full(b"url ", 0, 1, &[]));
    let minf = boxed(
        b"minf",
        &concat(&[
            full(b"vmhd", 0, 1, &vmhd.done()),
            boxed(b"dinf", &full(b"dref", 0, 0, &dref.done())),
            stbl(t, base),
        ]),
    );
    let mdia = boxed(
        b"mdia",
        &concat(&[
            full(b"mdhd", 0, 0, &mdhd.done()),
            full(b"hdlr", 0, 0, &hdlr.done()),
            minf,
        ]),
    );
    // Track enabled and in the movie.
    let trak = boxed(b"trak", &concat(&[full(b"tkhd", 0, 3, &tkhd.done()), mdia]));
    boxed(b"moov", &concat(&[full(b"mvhd", 0, 0, &mvhd.done()), trak]))
}

/// The most room a header for `frames` samples takes: `ftyp`, then `moov` as if every sample were
/// its own chunk and a sync sample and each parameter set 256 bytes, then a `free` box's header.
pub(crate) fn header_room(width: u32, height: u32, frames: u32) -> usize {
    let t = Track {
        width,
        height,
        timescale: 1,
        sample_delta: 1,
        sps: vec![0; 256],
        pps: vec![0; 256],
        sizes: vec![0; frames as usize],
        sync: (1..=frames).collect(),
        chunk_samples: 1,
    };
    // `stsc` may take a second entry (12 bytes) that this layout does not.
    ftyp().len() + moov(&t, 0).len() + 8 + 16
}

/// Completes a file written into `media`, whose first `reserved + 8` bytes were left for the
/// header and the samples follow: `ftyp` and `moov` are written at its start, a `free` box fills
/// the rest of the room, then the `mdat` header. Nothing is copied but the header.
pub(crate) fn finish(t: &Track, mut media: Vec<u8>, reserved: usize) -> Vec<u8> {
    let header = [ftyp(), moov(t, (reserved + 8) as u64)].concat();
    let gap = reserved.checked_sub(header.len());
    match gap {
        Some(gap) if gap == 0 || gap >= 8 => {
            media[..header.len()].copy_from_slice(&header);
            if gap > 0 {
                let at = header.len();
                media[at..at + 4].copy_from_slice(&(gap as u32).to_be_bytes());
                media[at + 4..at + 8].copy_from_slice(b"free");
                media[at + 8..reserved].fill(0);
            }
            let size = (media.len() - reserved) as u32;
            media[reserved..reserved + 4].copy_from_slice(&size.to_be_bytes());
            media[reserved + 4..reserved + 8].copy_from_slice(b"mdat");
            media
        }
        // The room was too small (not expected): the samples are copied behind a header.
        _ => {
            let samples = media.split_off(reserved + 8);
            drop(media);
            write(t, samples)
        }
    }
}

/// The whole file: `ftyp`, `moov`, then `mdat` holding `media` (the samples, in order).
pub(crate) fn write(t: &Track, media: Vec<u8>) -> Vec<u8> {
    let ftyp = ftyp();
    // The chunk offsets are fixed-size fields, so the index's size does not depend on them.
    let size = moov(t, 0).len();
    let base = (ftyp.len() + size + 8) as u64;
    let moov = moov(t, base);
    let mut out = Vec::with_capacity(base as usize + media.len());
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&moov);
    out.extend_from_slice(&((media.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(&media);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The top-level boxes of `file`: (type, start, size).
    fn top(file: &[u8]) -> Vec<([u8; 4], usize, usize)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at + 8 <= file.len() {
            let size = u32::from_be_bytes(file[at..at + 4].try_into().unwrap()) as usize;
            out.push((file[at + 4..at + 8].try_into().unwrap(), at, size));
            assert!(size >= 8);
            at += size;
        }
        assert_eq!(at, file.len(), "boxes tile the file");
        out
    }

    fn find<'a>(b: &'a [u8], path: &[&[u8; 4]]) -> Option<&'a [u8]> {
        let (first, rest) = path.split_first()?;
        let mut at = 0;
        while at + 8 <= b.len() {
            let size = u32::from_be_bytes(b[at..at + 4].try_into().ok()?) as usize;
            if &b[at + 4..at + 8] == *first {
                let body = &b[at + 8..at + size];
                return if rest.is_empty() {
                    Some(body)
                } else {
                    find(body, rest)
                };
            }
            at += size.max(8);
        }
        None
    }

    #[test]
    fn a_file_finished_in_place_is_the_file_written_whole_with_a_free_box() {
        let sizes: Vec<u32> = (0..75).map(|i| 10 + i % 7).collect();
        let mut samples = Vec::new();
        for (i, s) in sizes.iter().enumerate() {
            samples.extend_from_slice(&(i as u32).to_be_bytes());
            samples.extend(std::iter::repeat_n(0xcd, *s as usize - 4));
        }
        let t = Track {
            width: 1080,
            height: 1920,
            timescale: 15360,
            sample_delta: 512,
            sps: vec![0x67, 66, 0xc0, 40, 1, 2],
            pps: vec![0x68, 3],
            sizes: sizes.clone(),
            sync: vec![1, 61],
            chunk_samples: 30,
        };
        let reserved = header_room(1080, 1920, 75);
        let mut media = vec![0u8; reserved + 8];
        media.extend_from_slice(&samples);
        let file = finish(&t, media, reserved);
        let boxes = top(&file);
        let kinds: Vec<_> = boxes.iter().map(|b| b.0).collect();
        assert_eq!(kinds, [*b"ftyp", *b"moov", *b"free", *b"mdat"]);
        let moov = &file[boxes[1].1 + 8..boxes[1].1 + boxes[1].2];
        let stco = find(moov, &[b"trak", b"mdia", b"minf", b"stbl", b"stco"]).unwrap();
        for (chunk, first) in [0u32, 30, 60].into_iter().enumerate() {
            let off = u32::from_be_bytes(stco[8 + chunk * 4..12 + chunk * 4].try_into().unwrap())
                as usize;
            assert_eq!(
                u32::from_be_bytes(file[off..off + 4].try_into().unwrap()),
                first
            );
        }
        // The samples are where the index says, unchanged.
        assert_eq!(&file[file.len() - samples.len()..], &samples[..]);
    }

    #[test]
    fn the_index_comes_first_and_points_at_each_chunk() {
        let sizes: Vec<u32> = (0..75).map(|i| 10 + i % 7).collect();
        let mut media = Vec::new();
        for (i, s) in sizes.iter().enumerate() {
            // Each sample starts with its 4-byte length (here its own number).
            media.extend_from_slice(&(i as u32).to_be_bytes());
            media.extend(std::iter::repeat_n(0xab, *s as usize - 4));
        }
        let t = Track {
            width: 1080,
            height: 1920,
            timescale: 15360,
            sample_delta: 512,
            sps: vec![0x67, 66, 0xc0, 40, 1, 2],
            pps: vec![0x68, 3],
            sizes: sizes.clone(),
            sync: vec![1, 61],
            chunk_samples: 30,
        };
        let file = write(&t, media);
        let boxes = top(&file);
        let kinds: Vec<_> = boxes.iter().map(|b| b.0).collect();
        assert_eq!(kinds, [*b"ftyp", *b"moov", *b"mdat"]);
        let moov = &file[boxes[1].1 + 8..boxes[1].1 + boxes[1].2];
        // stco: three chunks (30, 30, 15 samples), each offset at its first sample.
        let stco = find(moov, &[b"trak", b"mdia", b"minf", b"stbl", b"stco"]).unwrap();
        let n = u32::from_be_bytes(stco[4..8].try_into().unwrap());
        assert_eq!(n, 3);
        for (chunk, first) in [0u32, 30, 60].into_iter().enumerate() {
            let off = u32::from_be_bytes(stco[8 + chunk * 4..12 + chunk * 4].try_into().unwrap())
                as usize;
            assert_eq!(
                u32::from_be_bytes(file[off..off + 4].try_into().unwrap()),
                first
            );
        }
        let stsc = find(moov, &[b"trak", b"mdia", b"minf", b"stbl", b"stsc"]).unwrap();
        assert_eq!(u32::from_be_bytes(stsc[4..8].try_into().unwrap()), 2);
        // 75 frames at 30 fps: 2.5 s, in mvhd (ms) and mdhd (media units).
        let mvhd = find(moov, &[b"mvhd"]).unwrap();
        assert_eq!(u32::from_be_bytes(mvhd[16..20].try_into().unwrap()), 2500);
        let mdhd = find(moov, &[b"trak", b"mdia", b"mdhd"]).unwrap();
        assert_eq!(
            u32::from_be_bytes(mdhd[16..20].try_into().unwrap()),
            75 * 512
        );
        let avcc = find(moov, &[b"trak", b"mdia", b"minf", b"stbl", b"stsd"]).unwrap();
        assert!(avcc.windows(4).any(|w| w == b"avcC"));
        assert!(find(moov, &[b"trak", b"edts"]).is_none(), "no edit list");
    }
}
