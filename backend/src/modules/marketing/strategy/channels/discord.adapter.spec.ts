import { isDiscordConfigured, postToDiscord, resolveDiscordWebhookUrl } from './discord.adapter';

const OWNED_WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

describe('discord.adapter', () => {
  const realFetch = global.fetch;
  const realEnv = process.env.DISCORD_WEBHOOK_URL;

  afterEach(() => {
    global.fetch = realFetch;
    if (realEnv === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = realEnv;
    jest.restoreAllMocks();
  });

  describe('isDiscordConfigured / resolveDiscordWebhookUrl', () => {
    it('is false / null when no webhook env is set (safe default → stage a draft)', async () => {
      delete process.env.DISCORD_WEBHOOK_URL;
      await expect(resolveDiscordWebhookUrl('ws1')).resolves.toBeNull();
      await expect(isDiscordConfigured('ws1')).resolves.toBe(false);
    });

    it('is true / the URL when the global webhook env is set', async () => {
      process.env.DISCORD_WEBHOOK_URL = OWNED_WEBHOOK;
      await expect(resolveDiscordWebhookUrl('ws1')).resolves.toBe(OWNED_WEBHOOK);
      await expect(isDiscordConfigured('ws1')).resolves.toBe(true);
    });

    it('treats a blank/whitespace env as not-configured', async () => {
      process.env.DISCORD_WEBHOOK_URL = '   ';
      await expect(isDiscordConfigured('ws1')).resolves.toBe(false);
    });
  });

  describe('postToDiscord', () => {
    it('POSTs the content JSON to the webhook and returns ok on 2xx', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg-1' }),
        text: async () => '',
      });
      global.fetch = fetchMock as any;

      const r = await postToDiscord(OWNED_WEBHOOK, { content: 'gm community 🌱' });

      expect(r).toEqual({ ok: true, id: 'msg-1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain(OWNED_WEBHOOK);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ content: 'gm community 🌱' });
    });

    it('returns ok with no id on a 204 (empty body) response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => {
          throw new Error('no body');
        },
        text: async () => '',
      }) as any;

      const r = await postToDiscord(OWNED_WEBHOOK, { content: 'hi' });
      expect(r.ok).toBe(true);
      expect(r.id).toBeUndefined();
    });

    it('returns {ok:false,error} on a non-2xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => 'Unauthorized',
      }) as any;

      const r = await postToDiscord(OWNED_WEBHOOK, { content: 'hi' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('401');
    });

    it('returns {ok:false,error} when fetch throws (network/SSRF)', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const r = await postToDiscord(OWNED_WEBHOOK, { content: 'hi' });
      expect(r).toEqual({ ok: false, error: 'ECONNREFUSED' });
    });
  });
});
