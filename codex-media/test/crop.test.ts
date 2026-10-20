import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fitToAspect, TARGET_SIZE } from '../src/image.ts';
import { png } from './helpers.ts';

test('target sizes keep the long edge ≤ 2048 and match the ratio', () => {
  for (const [ratio, [w, h]] of Object.entries(TARGET_SIZE)) {
    const [rw, rh] = ratio.split(':').map(Number) as [number, number];
    assert.ok(Math.max(w, h) <= 2048);
    assert.ok(Math.abs(w / h - rw / rh) < 0.005, ratio);
  }
});

test('941×1672 with 9:16 → 1080×1920 PNG', async () => {
  const out = await fitToAspect(await png(941, 1672), '9:16');
  assert.deepEqual([out.width, out.height], [1080, 1920]);
  const meta = await sharp(out.buffer).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 1080, 1920]);
});

test('1254×1254 with 4:5 → centre crop to 4:5 (1080×1350)', async () => {
  // 1254 wide: red 0-99, green middle, blue last 100 px. A 4:5 centre crop keeps 1003 px → drops ~125 px per side.
  const green = await png(1254, 1254, { r: 0, g: 200, b: 0 });
  const red = await png(100, 1254, { r: 220, g: 0, b: 0 });
  const blue = await png(100, 1254, { r: 0, g: 0, b: 220 });
  const input = await sharp(green).composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 1154, top: 0 }]).png().toBuffer();
  const out = await fitToAspect(input, '4:5');
  assert.deepEqual([out.width, out.height], [1080, 1350]);
  const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
  assert.deepEqual(px(0, 600), [0, 200, 0], 'left edge is centre (green), not the red stripe');
  assert.deepEqual(px(1079, 600), [0, 200, 0], 'right edge is green, not the blue stripe');
});

test('a ratio already within 1% is only scaled, not cropped', async () => {
  const out = await fitToAspect(await png(1254, 1254), '1:1');
  assert.deepEqual([out.width, out.height], [1080, 1080]);
});
