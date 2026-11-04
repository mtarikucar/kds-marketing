// When a photo or video was taken, read in the browser from the file's own bytes, as the server
// reads it when the material is added (`jt_studio::capture_time`): a JPEG's EXIF
// `DateTimeOriginal` (with `OffsetTimeOriginal`, else Istanbul time, UTC+03), an MP4's
// `moov/mvhd` creation time. The upload form uses it to suggest the olay before the material
// exists; the server decides again from the stored bytes. Nothing is trusted: a segment, box or
// entry running past what was read ends the read with no time.

/** How much of a JPEG is read for its EXIF (the APP1 segment sits at the start). */
const JPEG_HEAD = 256 * 1024;
/** How much of a video's `moov` box is read for its `mvhd` (its first child in practice). */
const MOOV_HEAD = 64 * 1024;

function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));

function inRange(at: Date | null): Date | null {
  if (!at || Number.isNaN(at.getTime())) return null;
  const year = at.getUTCFullYear();
  return year >= 1970 && year <= 2100 ? at : null;
}

/** `YYYY:MM:DD HH:MM:SS` at `offset` (`+HH:MM`, else Istanbul). */
function exifInstant(value: string, offset: string | null): Date | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const zone = offset && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : '+03:00';
  return inRange(new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`));
}

/** `DateTimeOriginal` of a JPEG's first APP1 Exif segment, from its first bytes. */
export function jpegCaptureTime(b: Uint8Array): Date | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
      return exifTime(b.subarray(i + 10, i + 2 + len));
    }
    i += 2 + len;
  }
  return null;
}

function exifTime(t: Uint8Array): Date | null {
  const order = ascii(t, 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (at: number) => (at + 2 <= t.length ? view.getUint16(at, little) : null);
  const u32 = (at: number) => (at + 4 <= t.length ? view.getUint32(at, little) : null);
  if (u16(2) !== 42) return null;
  const entry = (ifd: number, tag: number) => {
    const count = Math.min(u16(ifd) ?? 0, 512);
    for (let n = 0; n < count; n++) {
      const at = ifd + 2 + 12 * n;
      if (u16(at) === tag) {
        const kind = u16(at + 2);
        const c = u32(at + 4);
        return kind === null || c === null ? null : { kind, count: c, field: at + 8 };
      }
    }
    return null;
  };
  const text = (ifd: number, tag: number) => {
    const e = entry(ifd, tag);
    if (!e || e.kind !== 2 || e.count === 0 || e.count > 64) return null;
    const at = e.count <= 4 ? e.field : u32(e.field);
    if (at === null || at + e.count > t.length) return null;
    return ascii(t, at, e.count).replace(/\0+$/, '');
  };
  const ifd0 = u32(4);
  if (ifd0 === null) return null;
  const pointer = entry(ifd0, 0x8769);
  if (!pointer || (pointer.kind !== 4 && pointer.kind !== 13)) return null;
  const exif = u32(pointer.field);
  if (exif === null) return null;
  const original = text(exif, 0x9003);
  return original ? exifInstant(original, text(exif, 0x9011)) : null;
}

/** Seconds from 1904-01-01T00:00:00Z, the epoch of ISO base media times, to the Unix epoch. */
const MP4_EPOCH_TO_UNIX = 2_082_844_800;

/** The payload of the first box of type `kind` among the boxes of `b`. */
function findBox(b: Uint8Array, kind: string): Uint8Array | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  while (at + 8 <= b.length) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 0) size = b.length - at;
    else if (size === 1) {
      if (at + 16 > b.length) return null;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    }
    if (size < header || at + size > b.length) return null;
    if (ascii(b, at + 4, 4) === kind) return b.subarray(at + header, at + size);
    at += size;
  }
  return null;
}

/** `mvhd`'s creation time from the start of a `moov` box's payload. */
export function mvhdCreationTime(moov: Uint8Array): Date | null {
  const mvhd = findBox(moov, 'mvhd');
  if (!mvhd || mvhd.length < 12) return null;
  const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
  const seconds =
    mvhd[0] === 0 ? view.getUint32(4) : mvhd[0] === 1 ? Number(view.getBigUint64(4)) : 0;
  return seconds ? inRange(new Date((seconds - MP4_EPOCH_TO_UNIX) * 1000)) : null;
}

/** An MP4's `moov/mvhd` creation time, walking its top-level boxes by their headers. */
async function mp4CaptureTime(file: Blob): Promise<Date | null> {
  let at = 0;
  for (let boxes = 0; at + 8 <= file.size && boxes < 64; boxes++) {
    const head = await readBytes(file.slice(at, at + 16));
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    let header = 8;
    if (size === 0) size = file.size - at;
    else if (size === 1) {
      if (head.length < 16) return null;
      size = Number(view.getBigUint64(8));
      header = 16;
    }
    if (size < header || at + size > file.size) return null;
    if (ascii(head, 4, 4) === 'moov') {
      const end = Math.min(at + size, at + header + MOOV_HEAD);
      return mvhdCreationTime(await readBytes(file.slice(at + header, end)));
    }
    at += size;
  }
  return null;
}

/** When `file` was taken, by its own bytes; `null` when they do not say (or cannot be read). */
export async function captureTime(file: Blob): Promise<Date | null> {
  try {
    if (file.type === 'image/jpeg') {
      return jpegCaptureTime(await readBytes(file.slice(0, JPEG_HEAD)));
    }
    if (file.type === 'video/mp4') return await mp4CaptureTime(file);
  } catch {
    return null;
  }
  return null;
}
