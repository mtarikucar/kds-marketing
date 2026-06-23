// tiktok-upload.util.ts
import { safeFetch } from '../../../common/util/safe-fetch';

export const MB = 1024 * 1024;
const MIN_CHUNK = 5 * MB;
const MAX_CHUNK = 64 * MB;
const FINAL_MAX = 128 * MB;
const MAX_CHUNKS = 1000;
const MAX_FILE = 4 * 1024 * MB; // TikTok hard cap 4GB
const DEFAULT_CHUNK = 10 * MB;

export interface ChunkRange {
  index: number;
  start: number;
  end: number; // inclusive byte offset
}
export interface ChunkPlan {
  chunkSize: number;
  totalChunkCount: number;
  ranges: ChunkRange[];
}

/**
 * Compute the TikTok FILE_UPLOAD chunk plan for a video of `videoSize` bytes.
 * Rules (Content Posting media-transfer guide): chunk 5MB..64MB; the final
 * chunk folds in the remainder (<=128MB); <=1000 chunks; files <5MB upload
 * whole. Because chunkSize<=64MB, the folded final chunk is always <128MB.
 */
export function planChunks(videoSize: number): ChunkPlan {
  if (!Number.isInteger(videoSize) || videoSize <= 0) {
    throw new Error('videoSize must be a positive integer');
  }
  if (videoSize < MIN_CHUNK) {
    return { chunkSize: videoSize, totalChunkCount: 1, ranges: [{ index: 0, start: 0, end: videoSize - 1 }] };
  }

  let chunkSize = DEFAULT_CHUNK;
  if (Math.floor(videoSize / chunkSize) > MAX_CHUNKS) {
    chunkSize = Math.min(MAX_CHUNK, Math.ceil(videoSize / MAX_CHUNKS));
  }
  const totalChunkCount = Math.floor(videoSize / chunkSize);

  const ranges: ChunkRange[] = [];
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    ranges.push({ index: i, start, end });
  }
  const finalSize = ranges[totalChunkCount - 1].end - ranges[totalChunkCount - 1].start + 1;
  if (finalSize > FINAL_MAX) {
    // Unreachable while chunkSize<=64MB (final<2*chunkSize<128MB) — guard anyway.
    throw new Error('final chunk would exceed 128MB');
  }
  return { chunkSize, totalChunkCount, ranges };
}

/** PUT each chunk to the TikTok-issued upload_url. Throws on the first failure. */
export async function transferChunks(
  uploadUrl: string,
  bytes: Buffer,
  plan: ChunkPlan,
  contentType = 'video/mp4',
): Promise<void> {
  if (bytes.length > MAX_FILE) {
    throw new Error(`video exceeds TikTok 4GB limit (${bytes.length} bytes)`);
  }
  for (const r of plan.ranges) {
    const slice = bytes.subarray(r.start, r.end + 1);
    const res = await safeFetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${r.start}-${r.end}/${bytes.length}`,
      },
      body: slice,
      timeoutMs: 60_000,
    });
    if (!res.ok && res.status !== 201 && res.status !== 206) {
      throw new Error(`chunk ${r.index} upload failed: HTTP ${res.status}`);
    }
  }
}
