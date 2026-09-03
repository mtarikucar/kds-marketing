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

  const svc = (webhook: string | null) => ({ getDiscordWebhook: jest.fn(async () => webhook) }) as any;

  describe('isDiscordConfigured / resolveDiscordWebhookUrl', () => {
    it('is false / null when the workspace has not connected (safe default → draft)', async () => {
      delete process.env.DISCORD_WEBHOOK_URL;
      await expect(resolveDiscordWebhookUrl('ws1', svc(null))).resolves.toBeNull();
      await expect(isDiscordConfigured('ws1', svc(null))).resolves.toBe(false);
    });

    it('uses the per-workspace sealed webhook from the service', async () => {
      const s = svc(OWNED_WEBHOOK);
      await expect(resolveDiscordWebhookUrl('ws1', s)).resolves.toBe(OWNED_WEBHOOK);
      await expect(isDiscordConfigured('ws1', s)).resolves.toBe(true);
      expect(s.getDiscordWebhook).toHaveBeenCalledWith('ws1');
    });

    it('IGNORES a global env webhook: an unconnected workspace never posts into another server', async () => {
      // There used to be a `DISCORD_WEBHOOK_URL` fallback here "for
      // single-tenant/dev". The caller is an unattended executor that runs on a
      // clock for every armed tenant, so that one env var did not configure a
      // deployment — it redirected every workspace that never connected Discord
      // into ONE server, under someone else's name, with nobody in any of those
      // workspaces able to see it. Unconfigured must mean inert, not elsewhere.
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/999/global';
      await expect(resolveDiscordWebhookUrl('ws1', svc(null))).resolves.toBeNull();
      await expect(isDiscordConfigured('ws1', svc(null))).resolves.toBe(false);
    });

    it('is inert when no service is supplied at all', async () => {
      process.env.DISCORD_WEBHOOK_URL = OWNED_WEBHOOK;
      await expect(resolveDiscordWebhookUrl('ws1')).resolves.toBeNull();
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
