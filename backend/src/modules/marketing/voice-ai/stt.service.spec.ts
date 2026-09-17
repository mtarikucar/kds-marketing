import { SttService } from './stt.service';
import { safeFetch } from '../../../common/util/safe-fetch';
import { LocalInferenceService } from '../ai/local-inference.service';

jest.mock('../../../common/util/safe-fetch', () => ({ safeFetch: jest.fn() }));

describe('SttService', () => {
  const OLD = process.env;
  const oldFetch = global.fetch;
  beforeEach(() => {
    process.env = {
      ...OLD,
      STT_PROVIDER: 'deepgram',
      STT_API_KEY: 'k',
      LOCAL_AI_URL: 'http://local-ai:8000',
      LOCAL_AI_TOKEN: 'local-test-token-with-at-least-32-characters',
    };
    global.fetch = jest.fn();
    jest.mocked(safeFetch).mockReset();
  });
  afterEach(() => {
    process.env = OLD;
    global.fetch = oldFetch;
  });

  it('deepgram: parses transcript from response', async () => {
    const svc = new SttService();
    jest.spyOn<any, any>(svc as any, 'fetchJson').mockResolvedValue({
      results: {
        channels: [{ alternatives: [{ transcript: 'merhaba dünya' }] }],
      },
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

  function workspacePolicy(provider = 'LOCAL', enabled = true) {
    return {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          aiSpendPolicy: { jobs: { 'stt.minute': { provider, enabled } } },
        }),
      },
    };
  }

  it('routes workspace LOCAL transcription without requiring a paid API key', async () => {
    delete process.env.STT_PROVIDER;
    delete process.env.STT_API_KEY;
    const prisma = workspacePolicy();
    const svc = new SttService(prisma as any, new LocalInferenceService());
    jest.mocked(safeFetch).mockResolvedValue(new Response('audio bytes'));
    jest
      .mocked(global.fetch)
      .mockResolvedValue(
        new Response(
          JSON.stringify({ text: 'Merhaba', language: 'tr', model: 'whisper' }),
        ),
      );
    const paid = jest.spyOn(svc as any, 'fetchJson');
    await expect(
      svc.transcribeUrl('https://recordings.example/test.wav', {
        workspaceId: 'ws-1',
        language: 'tr',
      }),
    ).resolves.toEqual({
      text: 'Merhaba',
      provider: 'local-whisper',
      language: 'tr',
    });
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { aiSpendPolicy: true },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.mocked(global.fetch).mock.calls[0][0]).toBe(
      'http://local-ai:8000/transcribe',
    );
    expect(paid).not.toHaveBeenCalled();
  });

  it.each([503, 422, 504])(
    'never falls back to configured paid STT when LOCAL returns %s',
    async (status) => {
      const svc = new SttService(
        workspacePolicy() as any,
        new LocalInferenceService(),
      );
      jest.mocked(safeFetch).mockResolvedValue(new Response('audio bytes'));
      jest
        .mocked(global.fetch)
        .mockResolvedValue(new Response('local model failure', { status }));
      const paid = jest.spyOn(svc as any, 'fetchJson');
      await expect(
        svc.transcribeUrl('https://recordings.example/test.wav', {
          workspaceId: 'ws-1',
        }),
      ).rejects.toThrow('LOCAL_AI_UNAVAILABLE');
      expect(paid).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(jest.mocked(global.fetch).mock.calls[0][0]).toBe(
        'http://local-ai:8000/transcribe',
      );
    },
  );

  it.each(['LOCAL', 'API'])(
    'workspace disabling blocks every fetch on %s',
    async (provider) => {
      const svc = new SttService(
        workspacePolicy(provider, false) as any,
        new LocalInferenceService(),
      );
      const paid = jest.spyOn(svc as any, 'fetchJson');
      await expect(
        svc.transcribeUrl('https://recordings.example/test.wav', {
          workspaceId: 'ws-1',
        }),
      ).rejects.toMatchObject({
        response: { code: 'AI_SPEND_DISABLED', action: 'stt.minute' },
      });
      expect(safeFetch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(paid).not.toHaveBeenCalled();
    },
  );

  it.each(['ws-1', '', '  ', null])(
    'fails closed for supplied workspace %j without policy DI',
    async (workspaceId) => {
      const svc = new SttService();
      const paid = jest.spyOn(svc as any, 'fetchJson').mockResolvedValue({
        results: {
          channels: [{ alternatives: [{ transcript: 'paid fallback' }] }],
        },
      });
      await expect(
        svc.transcribeUrl('https://recordings.example/test.wav', {
          workspaceId,
        }),
      ).rejects.toThrow('AI_JOB_POLICY_UNAVAILABLE');
      expect(paid).not.toHaveBeenCalled();
      expect(safeFetch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('fails closed when LOCAL DI is missing', async () => {
    const svc = new SttService(workspacePolicy() as any);
    const paid = jest.spyOn(svc as any, 'fetchJson');
    await expect(
      svc.transcribeUrl('https://recordings.example/test.wav', {
        workspaceId: 'ws-1',
      }),
    ).rejects.toThrow('LOCAL_AI_NOT_CONFIGURED');
    expect(paid).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails closed for an unsupported stored STT provider', async () => {
    const svc = new SttService(workspacePolicy('MCP') as any);
    const paid = jest.spyOn(svc as any, 'fetchJson').mockResolvedValue({});
    await expect(
      svc.transcribeUrl('https://recordings.example/test.wav', {
        workspaceId: 'ws-1',
      }),
    ).rejects.toMatchObject({ response: { code: 'AI_PROVIDER_INVALID' } });
    expect(paid).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when workspace policy lookup fails', async () => {
    const prisma = workspacePolicy();
    prisma.workspace.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    const svc = new SttService(prisma as any, new LocalInferenceService());
    await expect(
      svc.transcribeUrl('https://recordings.example/test.wav', {
        workspaceId: 'ws-1',
      }),
    ).rejects.toThrow('database unavailable');
    expect(safeFetch).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('preserves explicitly permitted workspace API transcription', async () => {
    const svc = new SttService(workspacePolicy('API') as any);
    jest.spyOn(svc as any, 'fetchJson').mockResolvedValue({
      results: { channels: [{ alternatives: [{ transcript: 'allowed' }] }] },
    });
    await expect(
      svc.transcribeUrl('https://recordings.example/test.wav', {
        workspaceId: 'ws-1',
      }),
    ).resolves.toMatchObject({ text: 'allowed', provider: 'deepgram' });
  });
});
