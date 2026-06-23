// tiktok-upload.util.spec.ts
import { safeFetch } from '../../../common/util/safe-fetch';
import { planChunks, transferChunks, MB } from './tiktok-upload.util';

jest.mock('../../../common/util/safe-fetch');
const mockedFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;
const putResp = (status: number) => ({ ok: status >= 200 && status < 300, status } as unknown as Response);

describe('planChunks', () => {
  it('uploads a sub-5MB file as a single whole chunk', () => {
    const size = 3 * MB;
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBe(1);
    expect(plan.chunkSize).toBe(size);
    expect(plan.ranges).toEqual([{ index: 0, start: 0, end: size - 1 }]);
  });

  it('uploads a [5MB,10MB) file as a single whole chunk (no 0-chunk crash)', () => {
    const size = 7 * MB; // between the 5MB min and the 10MB default chunk
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
    const size = 12_000 * MB; // would be >1000 chunks at 10MB
    const plan = planChunks(size);
    expect(plan.totalChunkCount).toBeLessThanOrEqual(1000);
    expect(plan.chunkSize).toBeLessThanOrEqual(64 * MB);
    expect(plan.chunkSize).toBeGreaterThanOrEqual(5 * MB);
  });

  it('rejects an empty file', () => {
    expect(() => planChunks(0)).toThrow();
  });
});

describe('transferChunks', () => {
  afterEach(() => jest.resetAllMocks());

  it('rejects a file over the TikTok 4GB cap before any upload', async () => {
    const oversized = { length: 5 * 1024 * MB } as unknown as Buffer; // 5GB
    await expect(transferChunks('https://upload', oversized, planChunks(10 * MB))).rejects.toThrow(/4GB/);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('PUTs the whole-file chunk with correct Content-Range/Length headers', async () => {
    mockedFetch.mockResolvedValue(putResp(200));
    const bytes = Buffer.alloc(1000, 1);
    await transferChunks('https://upload', bytes, planChunks(1000), 'video/mp4');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('https://upload');
    expect((init as any).method).toBe('PUT');
    expect((init as any).headers['Content-Range']).toBe('bytes 0-999/1000');
    expect((init as any).headers['Content-Length']).toBe('1000');
    expect((init as any).headers['Content-Type']).toBe('video/mp4');
  });

  it('throws when a chunk upload returns a non-2xx status', async () => {
    mockedFetch.mockResolvedValue(putResp(500));
    const bytes = Buffer.alloc(1000, 1);
    await expect(transferChunks('https://upload', bytes, planChunks(1000))).rejects.toThrow(/chunk 0 upload failed: HTTP 500/);
  });
});
