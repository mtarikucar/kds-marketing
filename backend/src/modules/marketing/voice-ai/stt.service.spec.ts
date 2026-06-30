import { SttService } from './stt.service';

describe('SttService', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, STT_PROVIDER: 'deepgram', STT_API_KEY: 'k' }; });
  afterAll(() => { process.env = OLD; });

  it('deepgram: parses transcript from response', async () => {
    const svc = new SttService();
    jest.spyOn<any, any>(svc as any, 'fetchJson').mockResolvedValue({
      results: { channels: [{ alternatives: [{ transcript: 'merhaba dünya' }] }] },
    });
    const r = await svc.transcribeUrl('https://x/rec.mp3');
    expect(r?.text).toBe('merhaba dünya');
    expect(r?.provider).toBe('deepgram');
  });

  it('returns null when not configured', async () => {
    delete process.env.STT_PROVIDER;
    const svc = new SttService();
    expect(await svc.transcribeUrl('https://x/rec.mp3')).toBeNull();
  });
});
