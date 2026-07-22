import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CommunityChannelService } from './community-channel.service';
import { openSecret } from '../../../../common/crypto/secret-box.helper';
import type { RedditTokenBundle } from './community-channel.service';

const OWNED_WEBHOOK = 'https://discord.com/api/webhooks/123456789/abcDEFtoken';

function deps() {
  const store: Record<string, any> = {};
  const prisma = {
    communityChannelConfig: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.workspaceId_provider.workspaceId}:${where.workspaceId_provider.provider}`;
        store[key] = store[key]
          ? { ...store[key], ...update }
          : { id: 'c1', createdAt: new Date('2026-07-22T00:00:00Z'), ...create };
        return store[key];
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const key = `${where.workspaceId_provider.workspaceId}:${where.workspaceId_provider.provider}`;
        return store[key] ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const key = `${where.workspaceId_provider.workspaceId}:${where.workspaceId_provider.provider}`;
        store[key] = { ...store[key], ...data };
        return store[key];
      }),
      findMany: jest.fn(async ({ where }: any) =>
        Object.entries(store)
          .filter(([k]) => k.startsWith(`${where.workspaceId}:`))
          .map(([, v]) => v),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        const key = `${where.workspaceId}:${where.provider}`;
        const existed = !!store[key];
        delete store[key];
        return { count: existed ? 1 : 0 };
      }),
    },
  };
  const svc = new CommunityChannelService(prisma as any);
  return { svc, prisma, store };
}

describe('CommunityChannelService', () => {
  const realKey = process.env.MARKETING_SECRET_KEY;
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = randomBytes(32).toString('base64');
  });
  afterAll(() => {
    if (realKey === undefined) delete process.env.MARKETING_SECRET_KEY;
    else process.env.MARKETING_SECRET_KEY = realKey;
  });

  describe('connectDiscord', () => {
    it('validates, SEALS the webhook (never raw), and upserts a DISCORD config', async () => {
      const { svc, prisma, store } = deps();
      const view = await svc.connectDiscord('ws1', OWNED_WEBHOOK, 'general');

      expect(view).toMatchObject({ provider: 'DISCORD', status: 'ACTIVE', meta: { channelName: 'general' } });
      expect(prisma.communityChannelConfig.upsert).toHaveBeenCalledTimes(1);
      const sealed = store['ws1:DISCORD'].sealedSecret as string;
      expect(sealed).not.toContain('discord.com'); // sealed, not raw
      expect(openSecret(sealed)).toBe(OWNED_WEBHOOK); // round-trips to the URL
    });

    it('accepts ptb/canary/discordapp hosts', async () => {
      const { svc } = deps();
      await expect(
        svc.connectDiscord('ws1', 'https://canary.discord.com/api/webhooks/1/tok'),
      ).resolves.toMatchObject({ provider: 'DISCORD' });
      await expect(
        svc.connectDiscord('ws1', 'https://discordapp.com/api/webhooks/1/tok'),
      ).resolves.toMatchObject({ provider: 'DISCORD' });
    });

    it('rejects a non-Discord / malformed webhook URL', async () => {
      const { svc } = deps();
      await expect(svc.connectDiscord('ws1', 'https://evil.example.com/api/webhooks/1/x')).rejects.toThrow(
        BadRequestException,
      );
      await expect(svc.connectDiscord('ws1', 'https://discord.com/channels/1/2')).rejects.toThrow(
        BadRequestException,
      );
      await expect(svc.connectDiscord('ws1', 'not-a-url')).rejects.toThrow(BadRequestException);
    });
  });

  describe('getDiscordWebhook', () => {
    it('returns the unsealed webhook for a connected workspace', async () => {
      const { svc } = deps();
      await svc.connectDiscord('ws1', OWNED_WEBHOOK);
      await expect(svc.getDiscordWebhook('ws1')).resolves.toBe(OWNED_WEBHOOK);
    });

    it('returns null when the workspace has not connected', async () => {
      const { svc } = deps();
      await expect(svc.getDiscordWebhook('ws1')).resolves.toBeNull();
    });

    it('returns null for a DISCONNECTED row', async () => {
      const { svc, store } = deps();
      await svc.connectDiscord('ws1', OWNED_WEBHOOK);
      store['ws1:DISCORD'].status = 'DISCONNECTED';
      await expect(svc.getDiscordWebhook('ws1')).resolves.toBeNull();
    });
  });

  describe('listConnections / disconnect', () => {
    it('lists non-secret connection views (no sealedSecret leaked)', async () => {
      const { svc } = deps();
      await svc.connectDiscord('ws1', OWNED_WEBHOOK, 'general');
      const list = await svc.listConnections('ws1');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ provider: 'DISCORD', status: 'ACTIVE' });
      expect(JSON.stringify(list[0])).not.toContain('webhooks');
    });

    it('disconnect deletes the row (idempotent)', async () => {
      const { svc } = deps();
      await svc.connectDiscord('ws1', OWNED_WEBHOOK);
      await expect(svc.disconnect('ws1', 'discord')).resolves.toEqual({ disconnected: true });
      await expect(svc.disconnect('ws1', 'discord')).resolves.toEqual({ disconnected: false });
      await expect(svc.getDiscordWebhook('ws1')).resolves.toBeNull();
    });

    it('rejects an unsupported provider', async () => {
      const { svc } = deps();
      await expect(svc.disconnect('ws1', 'myspace')).rejects.toThrow(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────── Reddit

  describe('reddit OAuth', () => {
    const realFetch = global.fetch;
    const OLD = { id: process.env.REDDIT_CLIENT_ID, secret: process.env.REDDIT_CLIENT_SECRET, base: process.env.PUBLIC_BASE_URL };
    beforeEach(() => {
      process.env.REDDIT_CLIENT_ID = 'cid';
      process.env.REDDIT_CLIENT_SECRET = 'csecret';
      process.env.PUBLIC_BASE_URL = 'https://jeetagrowth.com';
    });
    afterEach(() => {
      global.fetch = realFetch;
      for (const [k, v] of [
        ['REDDIT_CLIENT_ID', OLD.id],
        ['REDDIT_CLIENT_SECRET', OLD.secret],
        ['PUBLIC_BASE_URL', OLD.base],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    describe('redditAuthorizeUrl', () => {
      it('builds the authorize URL with the right params (gated on env creds)', () => {
        const { svc } = deps();
        const { url } = svc.redditAuthorizeUrl('ws1', 'signed-state');
        const u = new URL(url);
        expect(u.origin + u.pathname).toBe('https://www.reddit.com/api/v1/authorize');
        expect(u.searchParams.get('client_id')).toBe('cid');
        expect(u.searchParams.get('response_type')).toBe('code');
        expect(u.searchParams.get('state')).toBe('signed-state');
        expect(u.searchParams.get('duration')).toBe('permanent');
        expect(u.searchParams.get('scope')).toBe('submit identity');
        expect(u.searchParams.get('redirect_uri')).toBe(
          'https://jeetagrowth.com/api/marketing/strategy/channels/reddit/callback',
        );
      });

      it('throws when env creds are missing (UI stays inert)', () => {
        delete process.env.REDDIT_CLIENT_ID;
        const { svc } = deps();
        expect(() => svc.redditAuthorizeUrl('ws1', 's')).toThrow(BadRequestException);
      });
    });

    describe('handleRedditCallback', () => {
      it('exchanges the code, SEALS the token bundle, and records the username', async () => {
        const { svc, store } = deps();
        const fetchMock = jest
          .fn()
          // 1) token exchange
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
            text: async () => '',
          })
          // 2) /api/v1/me
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: 'jeeta_bot' }), text: async () => '' });
        global.fetch = fetchMock as any;

        const view = await svc.handleRedditCallback('ws1', 'the-code');
        expect(view).toMatchObject({ provider: 'REDDIT', status: 'ACTIVE', meta: { username: 'jeeta_bot' } });

        // token exchange: basic auth + authorization_code grant
        const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
        expect(String(tokenUrl)).toContain('access_token');
        expect(tokenInit.headers.Authorization).toMatch(/^Basic /);
        expect(String(tokenInit.body)).toContain('grant_type=authorization_code');

        // sealed, not raw
        const sealed = store['ws1:REDDIT'].sealedSecret as string;
        expect(sealed).not.toContain('AT');
        expect(JSON.parse(openSecret(sealed))).toMatchObject({ access: 'AT', refresh: 'RT' });
      });

      it('still connects when username fetch fails (best-effort meta)', async () => {
        const { svc } = deps();
        global.fetch = jest
          .fn()
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }), text: async () => '' })
          .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}), text: async () => 'forbidden' }) as any;
        const view = await svc.handleRedditCallback('ws1', 'the-code');
        expect(view).toMatchObject({ provider: 'REDDIT', meta: null });
      });

      it('throws when the token exchange fails', async () => {
        const { svc } = deps();
        global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}), text: async () => 'invalid_grant' }) as any;
        await expect(svc.handleRedditCallback('ws1', 'bad')).rejects.toThrow(BadRequestException);
      });
    });

    describe('getRedditToken / saveRedditToken', () => {
      it('round-trips a sealed bundle and returns null when not connected', async () => {
        const { svc } = deps();
        await expect(svc.getRedditToken('ws1')).resolves.toBeNull();

        global.fetch = jest
          .fn()
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }), text: async () => '' })
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: 'u' }), text: async () => '' }) as any;
        await svc.handleRedditCallback('ws1', 'code');

        const bundle = await svc.getRedditToken('ws1');
        expect(bundle).toMatchObject({ access: 'AT', refresh: 'RT' });

        const next: RedditTokenBundle = { access: 'AT2', refresh: 'RT2', expiresAt: Date.now() + 1000 };
        await svc.saveRedditToken('ws1', next);
        await expect(svc.getRedditToken('ws1')).resolves.toMatchObject({ access: 'AT2', refresh: 'RT2' });
      });
    });
  });
});
