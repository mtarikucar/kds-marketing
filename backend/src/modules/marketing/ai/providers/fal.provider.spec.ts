import { FalProvider } from './fal.provider';

describe('FalProvider', () => {
  const OLD = process.env.FAL_KEY;
  let provider: FalProvider;
  beforeEach(() => { process.env.FAL_KEY = 'fal-test-key'; provider = new FalProvider(); });
  afterEach(() => { process.env.FAL_KEY = OLD; jest.restoreAllMocks(); });

  it('is inert when FAL_KEY is absent', () => {
    delete process.env.FAL_KEY;
    expect(new FalProvider().isConfigured()).toBe(false);
  });

  it('submits to the fal queue and returns the request id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ request_id: 'req-123' }),
    } as any);
    const res = await provider.submit({
      type: 'IMAGE', model: 'fal-ai/qwen-image', prompt: 'a cat',
      webhookUrl: 'https://app/hook',
    });
    expect(res.providerRequestId).toBe('req-123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://queue.fal.run/fal-ai/qwen-image?fal_webhook=https%3A%2F%2Fapp%2Fhook');
    expect((init as any).headers.Authorization).toBe('Key fal-test-key');
  });

  it('maps COMPLETED image output (content_type → mime, dims)', async () => {
    jest.spyOn(global, 'fetch' as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        images: [{ url: 'https://fal/out.png', content_type: 'image/png', width: 1024, height: 1024 }],
      }) } as any);
    const r = await provider.getResult('req-1', 'fal-ai/qwen-image');
    expect(r.status).toBe('COMPLETED');
    expect(r.outputs).toEqual([{ url: 'https://fal/out.png', mime: 'image/png', width: 1024, height: 1024, durationSec: undefined }]);
  });

  it('maps IN_PROGRESS through unchanged', async () => {
    jest.spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }) } as any);
    expect((await provider.getResult('req-1', 'm')).status).toBe('IN_PROGRESS');
  });

  it('maps a content-policy error to BLOCKED, not FAILED', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false, status: 422,
      json: async () => ({ detail: 'NSFW content detected by safety checker' }),
    } as any);
    const r = await provider.getResult('req-1', 'm');
    expect(r.status).toBe('BLOCKED');
    expect(r.error).toMatch(/NSFW/i);
  });

  it('maps a generic provider error to FAILED', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false, status: 500, json: async () => ({ detail: 'internal error' }),
    } as any);
    expect((await provider.getResult('req-1', 'm')).status).toBe('FAILED');
  });
});
