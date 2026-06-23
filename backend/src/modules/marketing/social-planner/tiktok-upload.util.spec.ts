// tiktok-upload.util.spec.ts
import { planChunks, MB } from './tiktok-upload.util';

describe('planChunks', () => {
  it('uploads a sub-5MB file as a single whole chunk', () => {
    const size = 3 * MB;
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBe(1);
    expect(plan.chunkSize).toBe(size);
    expect(plan.ranges).toEqual([{ index: 0, start: 0, end: size - 1 }]);
  });

  it('splits a large file into >=5MB chunks with the remainder folded into the last', () => {
    const size = 25 * MB; // with 10MB default chunk -> floor(25/10)=2 chunks
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBe(2);
    expect(plan.chunkSize).toBe(10 * MB);
    expect(plan.ranges[0]).toEqual({ index: 0, start: 0, end: 10 * MB - 1 });
    // last chunk absorbs the remainder (10MB..25MB)
    expect(plan.ranges[1]).toEqual({ index: 1, start: 10 * MB, end: size - 1 });
    const lastSize = plan.ranges[1].end - plan.ranges[1].start + 1;
    expect(lastSize).toBeLessThanOrEqual(128 * MB);
  });

  it('grows chunk size to stay within 1000 chunks', () => {
    const size = 12_000 * MB; // 12GB hypothetical — would be >1000 chunks at 10MB
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBeLessThanOrEqual(1000);
    expect(plan.chunkSize).toBeLessThanOrEqual(64 * MB);
    expect(plan.chunkSize).toBeGreaterThanOrEqual(5 * MB);
  });

  it('rejects an empty file', () => {
    expect(() => planChunks(0)).toThrow();
  });
});
