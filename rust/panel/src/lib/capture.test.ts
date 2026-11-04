import { describe, expect, it } from 'vitest';
import { captureTime, jpegCaptureTime } from './capture';

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const le16 = (n: number) => [n & 0xff, n >> 8];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A JPEG whose EXIF names `original` (and `offset` when given), little-endian. */
function jpeg(original: string, offset?: string): Uint8Array {
  const exifAt = 26;
  const entries = offset ? 2 : 1;
  const dataAt = exifAt + 2 + 12 * entries + 4;
  const tiff = [
    ...ascii('II'), ...le16(42), ...le32(8),
    ...le16(1), ...le16(0x8769), ...le16(4), ...le32(1), ...le32(exifAt), ...le32(0),
    ...le16(entries),
    ...le16(0x9003), ...le16(2), ...le32(20), ...le32(dataAt),
    ...(offset ? [...le16(0x9011), ...le16(2), ...le32(7), ...le32(dataAt + 20)] : []),
    ...le32(0),
    ...ascii(`${original}\0`),
    ...(offset ? ascii(`${offset}\0`) : []),
  ];
  const payload = [...ascii('Exif\0\0'), ...tiff];
  const len = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...payload, 0xff, 0xda]);
}

/** An MP4 whose `moov/mvhd` (version 0) names `at` as its creation time. */
function mp4(at: Date): Uint8Array {
  const ftyp = [...be32(16), ...ascii('ftypisom'), ...be32(0)];
  const seconds = Math.floor(at.getTime() / 1000) + 2_082_844_800;
  const mvhd = [...be32(28), ...ascii('mvhd'), 0, 0, 0, 0, ...be32(seconds), ...be32(seconds), ...be32(1000), ...be32(5000)];
  const moov = [...be32(8 + mvhd.length), ...ascii('moov'), ...mvhd];
  return new Uint8Array([...ftyp, ...moov]);
}

describe('capture time, read as the server reads it', () => {
  it("reads a JPEG's DateTimeOriginal with its offset, else as Istanbul time", async () => {
    expect(jpegCaptureTime(jpeg('2026:11:16 14:30:00', '+01:00'))?.toISOString()).toBe('2026-11-16T13:30:00.000Z');
    expect(jpegCaptureTime(jpeg('2026:11:16 14:30:00'))?.toISOString()).toBe('2026-11-16T11:30:00.000Z');
    const file = new File([jpeg('2026:11:16 14:30:00')], 'a.jpg', { type: 'image/jpeg' });
    expect((await captureTime(file))?.toISOString()).toBe('2026-11-16T11:30:00.000Z');
  });

  it("reads an MP4's mvhd creation time", async () => {
    const at = new Date('2026-11-16T11:30:00Z');
    const file = new File([mp4(at)], 'v.mp4', { type: 'video/mp4' });
    expect((await captureTime(file))?.toISOString()).toBe(at.toISOString());
  });

  it('says nothing for bytes that do not name a time', async () => {
    expect(jpegCaptureTime(new Uint8Array([0xff, 0xd8, 0xff, 0xda]))).toBeNull();
    expect(jpegCaptureTime(jpeg('not a date'))).toBeNull();
    expect(await captureTime(new File(['x'], 'p.png', { type: 'image/png' }))).toBeNull();
    expect(await captureTime(new File(['xxxxxxxxxxxx'], 'v.mp4', { type: 'video/mp4' }))).toBeNull();
  });
});
