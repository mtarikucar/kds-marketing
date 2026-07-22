import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CommunityChannelService } from './community-channel.service';
import { openSecret } from '../../../../common/crypto/secret-box.helper';

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
});
