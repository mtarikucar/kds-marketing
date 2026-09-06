import { RunwareProvider } from './runware.provider';

const OLD = process.env.RUNWARE_API_KEY;
const originalFetch = global.fetch;
let provider: RunwareProvider;
const fetchMock = jest.fn();

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response);
}

beforeEach(() => {
  process.env.RUNWARE_API_KEY = 'rw-test';
  provider = new RunwareProvider();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  fetchMock.mockReset();
});
afterEach(() => {
  process.env.RUNWARE_API_KEY = OLD;
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
});

const IMAGE = { type: 'IMAGE' as const, model: 'fal-ai/qwen-image', prompt: 'x' };

describe('RunwareProvider', () => {
  it('is inert without RUNWARE_API_KEY', async () => {
    delete process.env.RUNWARE_API_KEY;
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.submit(IMAGE)).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits one task with a bearer key and returns the client uuid', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [{ taskType: 'imageInference', taskUUID: 'echo' }] }));
    const { providerRequestId } = await provider.submit(IMAGE);
    expect(providerRequestId).toMatch(/^[0-9a-f-]{36}$/);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.runware.ai/v1');
    expect(init.headers.Authorization).toBe('Bearer rw-test');
    const body = JSON.parse(init.body);
    expect(body).toHaveLength(1);
    expect(body[0].taskUUID).toBe(providerRequestId);
  });

  it('surfaces a rejected submit (HTTP ok, errors[] present) as a thrown error', async () => {
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'invalidModel', message: 'Unknown model', taskUUID: 'x' }] }));
    await expect(provider.submit(IMAGE)).rejects.toThrow(/invalidModel: Unknown model/);
  });

  it('surfaces a non-2xx submit with its status', async () => {
    fetchMock.mockReturnValueOnce(json({}, 402));
    await expect(provider.submit(IMAGE)).rejects.toThrow(/runware submit failed \(402\)/);
  });

  it('polls with getResponse and reports processing as IN_PROGRESS', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [{ taskType: 'videoInference', taskUUID: 'u1', status: 'processing', progress: 12 }] }));
    const r = await provider.getResult('u1', 'bytedance/seedance-2.5/text-to-video');
    expect(r.status).toBe('IN_PROGRESS');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([{ taskType: 'getResponse', taskUUID: 'u1' }]);
  });

  it('treats an empty poll (no item, no error) as still running', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('IN_PROGRESS');
  });

  it('completes with the media URL and the reported cost', async () => {
    fetchMock.mockReturnValueOnce(json({
      data: [{ taskType: 'videoInference', taskUUID: 'u1', status: 'success', videoURL: 'https://vm.runware.ai/v.mp4', cost: 1.152 }],
    }));
    const r = await provider.getResult('u1', 'bytedance/seedance-2.5/text-to-video');
    expect(r).toEqual({
      status: 'COMPLETED', outputs: [expect.objectContaining({ url: 'https://vm.runware.ai/v.mp4' })], costUsd: 1.152,
    });
  });

  it('completes a sync-shaped image item that carries no status field', async () => {
    fetchMock.mockReturnValueOnce(json({ data: [{ taskType: 'imageInference', taskUUID: 'u1', imageURL: 'https://im/x.png', cost: 0.0058 }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('COMPLETED');
  });

  it('maps a safety code to BLOCKED and any other error to FAILED', async () => {
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'contentPolicyViolation', message: 'blocked', taskUUID: 'u1' }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('BLOCKED');
    fetchMock.mockReturnValueOnce(json({ data: [{ taskUUID: 'u1', status: 'error', error: { code: 'timeoutProvider', message: 'slow' } }] }));
    expect(await provider.getResult('u1', 'fal-ai/qwen-image')).toEqual({ status: 'FAILED', error: 'timeoutProvider: slow' });
    fetchMock.mockReturnValueOnce(json({ data: [{ taskUUID: 'u1', status: 'success', imageURL: 'https://im/x.png', NSFWContent: true }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('BLOCKED');
  });

  it('ignores errors that belong to another task', async () => {
    fetchMock.mockReturnValueOnce(json({
      data: [{ taskUUID: 'u1', status: 'processing' }], errors: [{ code: 'x', message: 'y', taskUUID: 'other' }],
    }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('IN_PROGRESS');
  });

  it('fails a poll that cannot be recovered by polling again (bad key, plain 400)', async () => {
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'invalidApiKey', message: 'nope' }] }, 401));
    expect(await provider.getResult('u1', 'fal-ai/qwen-image')).toEqual({ status: 'FAILED', error: 'invalidApiKey: nope' });
    fetchMock.mockReturnValueOnce(json(null, 400));
    expect(await provider.getResult('u1', 'fal-ai/qwen-image')).toEqual({ status: 'FAILED', error: 'runware poll failed (400)' });
  });

  it('keeps the job in flight on a transient poll failure — Runware still renders and bills it', async () => {
    for (const status of [429, 503, 504]) {
      fetchMock.mockReturnValueOnce(json(null, status));
      expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('IN_PROGRESS');
    }
    // An unaddressed rate-limit error in a 200 body is about the poll, not the task.
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'providerRateLimitExceeded', message: 'slow down' }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('IN_PROGRESS');
    // …but the same code ADDRESSED to the task is the task's own verdict.
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'timeoutProvider', message: 'gave up', taskUUID: 'u1' }] }));
    expect(await provider.getResult('u1', 'fal-ai/qwen-image')).toEqual({ status: 'FAILED', error: 'timeoutProvider: gave up' });
  });

  it('maps a moderation refusal by MESSAGE to BLOCKED when the code is generic', async () => {
    fetchMock.mockReturnValueOnce(json({ errors: [{ code: 'providerError', message: 'Prompt was flagged by content moderation', taskUUID: 'u1' }] }));
    expect((await provider.getResult('u1', 'fal-ai/qwen-image')).status).toBe('BLOCKED');
  });
});
