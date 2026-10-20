import sharp from 'sharp';
import type { AspectRatio } from './config.js';

/** Output size per ratio (long edge ≤ 2048; social-friendly 1080 short edge). */
export const TARGET_SIZE: Record<AspectRatio, [number, number]> = {
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '3:4': [1080, 1440],
  '4:3': [1440, 1080],
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
};

export interface FittedImage { buffer: Buffer; width: number; height: number }

/**
 * Codex has no aspect parameter; the prompt asks for a ratio and the model roughly follows it
 * (941×1672 for 9:16). Centre-crop to the exact ratio when it is off by more than 1 %, then
 * scale to the target size and return a PNG.
 */
export async function fitToAspect(input: Buffer, ratio: AspectRatio): Promise<FittedImage> {
  const [tw, th] = TARGET_SIZE[ratio];
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!w || !h) throw new Error('generated image has no dimensions');
  let pipeline = sharp(input).rotate();
  const want = tw / th;
  if (Math.abs(w / h - want) / want > 0.01) {
    const cw = w / h > want ? Math.round(h * want) : w;
    const ch = w / h > want ? h : Math.round(w / want);
    pipeline = pipeline.extract({ left: Math.floor((w - cw) / 2), top: Math.floor((h - ch) / 2), width: cw, height: ch });
  }
  const buffer = await pipeline.resize(tw, th, { fit: 'fill' }).png().toBuffer();
  return { buffer, width: tw, height: th };
}
