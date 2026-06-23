import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdAccountService } from './ad-account.service';
import * as metaClient from './meta-ads.client';
import * as tiktokClient from './tiktok-ads.client';
import * as adsTypes from './ads.types';
import * as secretBox from '../../../common/crypto/secret-box.helper';

const WS = 'ws-1';

function makePrisma() {
  return {
    adAccount: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    adMetric: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
}

describe('AdAccountService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: AdAccountService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new AdAccountService(prisma as any);
    jest.restoreAllMocks();
    // Both providers enabled by default; individual tests override to test the gate.
    jest.spyOn(adsTypes, 'isMetaAdsConfigured').mockReturnValue(true);
    jest.spyOn(adsTypes, 'isTiktokAdsConfigured').mockReturnValue(true);
    // Safe defaults so awaited writes (and markError's `.catch`) resolve.
    prisma.adAccount.update.mockResolvedValue({});
    prisma.adAccount.upsert.mockResolvedValue({});
    prisma.adAccount.delete.mockResolvedValue({});
    prisma.adMetric.upsert.mockResolvedValue({});
  });

  describe('connect', () => {
    it('rejects an unknown provider', async () => {
      await expect(
        svc.connect(WS, { provider: 'GOOGLE', externalAdId: 'x', accessToken: 't' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects connecting a provider whose app is not configured on the platform', async () => {
      jest.spyOn(adsTypes, 'isMetaAdsConfigured').mockReturnValue(false);
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
      await expect(
        svc.connect(WS, { provider: 'META', externalAdId: 'act_1', accessToken: 't' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.adAccount.upsert).not.toHaveBeenCalled();
    });

    it('rejects when secret storage is not configured', async () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(false);
      await expect(
        svc.connect(WS, { provider: 'META', externalAdId: 'act_1', accessToken: 't' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('seals the token and upserts with an inline workspaceId (never echoes the token)', async () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
      const sealSpy = jest.spyOn(secretBox, 'sealSecret').mockReturnValue('v1:sealed');
      prisma.adAccount.upsert.mockResolvedValue({ id: 'a1', provider: 'META' });

      await svc.connect(WS, {
        provider: 'META',
        externalAdId: 'act_42',
        displayName: 'My Ads',
        accessToken: 'super-secret',
        currency: 'USD',
      } as any);

      expect(sealSpy).toHaveBeenCalledWith('super-secret');
      const arg = prisma.adAccount.upsert.mock.calls[0][0] as any;
      expect(arg.where.workspaceId_provider_externalAdId).toEqual({
        workspaceId: WS,
        provider: 'META',
        externalAdId: 'act_42',
      });
      expect(arg.create.workspaceId).toBe(WS);
      expect(arg.create.accessToken).toBe('v1:sealed');
      expect(arg.update.accessToken).toBe('v1:sealed');
      // The select must NOT leak the sealed token.
      expect(arg.select.accessToken).toBeUndefined();
    });
  });

  describe('list', () => {
    it('selects the public fields and never the sealed accessToken', async () => {
      prisma.adAccount.findMany.mockResolvedValue([]);
      await svc.list(WS);
      const arg = prisma.adAccount.findMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ workspaceId: WS });
      expect(arg.select.accessToken).toBeUndefined();
      expect(arg.select.refreshToken).toBeUndefined();
      expect(arg.select.id).toBe(true);
      expect(arg.select.status).toBe(true);
    });
  });

  describe('remove', () => {
    it('404s an account in another workspace', async () => {
      prisma.adAccount.findFirst.mockResolvedValue(null);
      await expect(svc.remove(WS, 'a1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.adAccount.delete).not.toHaveBeenCalled();
    });

    it('scopes the lookup by (id, workspaceId) then deletes by id', async () => {
      prisma.adAccount.findFirst.mockResolvedValue({ id: 'a1', workspaceId: WS });
      prisma.adAccount.delete.mockResolvedValue({});
      await svc.remove(WS, 'a1');
      expect(prisma.adAccount.findFirst.mock.calls[0][0]).toEqual({
        where: { id: 'a1', workspaceId: WS },
      });
      expect(prisma.adAccount.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    });
  });

  describe('getMetrics', () => {
    it('returns empty totals when the workspace has no accounts', async () => {
      prisma.adAccount.findMany.mockResolvedValue([]);
      const res = await svc.getMetrics(WS, '2026-06-01', '2026-06-30');
      expect(res).toEqual({ totals: { spend: 0, impressions: 0, clicks: 0, leads: 0 }, byDay: [], byProvider: {} });
      expect(prisma.adMetric.findMany).not.toHaveBeenCalled();
    });

    it('aggregates rows into totals, byDay and byProvider', async () => {
      prisma.adAccount.findMany.mockResolvedValue([
        { id: 'a1', provider: 'META' },
        { id: 'a2', provider: 'TIKTOK' },
      ]);
      prisma.adMetric.findMany.mockResolvedValue([
        { adAccountId: 'a1', date: new Date('2026-06-01T00:00:00Z'), spend: '10.50', impressions: 100, clicks: 5, leads: 1 },
        { adAccountId: 'a1', date: new Date('2026-06-02T00:00:00Z'), spend: '4.50', impressions: 50, clicks: 2, leads: 0 },
        { adAccountId: 'a2', date: new Date('2026-06-01T00:00:00Z'), spend: '5.00', impressions: 20, clicks: 3, leads: 2 },
      ]);

      const res = await svc.getMetrics(WS, '2026-06-01', '2026-06-30');
      expect(res.totals).toEqual({ spend: 20, impressions: 170, clicks: 10, leads: 3 });
      expect(res.byProvider.META).toEqual({ spend: 15, impressions: 150, clicks: 7, leads: 1 });
      expect(res.byProvider.TIKTOK).toEqual({ spend: 5, impressions: 20, clicks: 3, leads: 2 });
      const day1 = res.byDay.find((d) => d.date === '2026-06-01');
      expect(day1).toEqual({ date: '2026-06-01', spend: 15.5, impressions: 120, clicks: 8, leads: 3 });
      // metric query is workspace-scoped AND constrained to this workspace's accounts
      const arg = prisma.adMetric.findMany.mock.calls[0][0] as any;
      expect(arg.where.workspaceId).toBe(WS);
      expect(arg.where.adAccountId).toEqual({ in: ['a1', 'a2'] });
    });

    it('passes the provider filter through to the account lookup', async () => {
      prisma.adAccount.findMany.mockResolvedValue([]);
      await svc.getMetrics(WS, '2026-06-01', '2026-06-30', 'META');
      expect(prisma.adAccount.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, provider: 'META' });
    });
  });

  describe('pullAccount', () => {
    const account = {
      id: 'a1',
      workspaceId: WS,
      provider: 'META',
      externalAdId: 'act_1',
      accessToken: 'v1:sealed',
    };

    it('short-circuits (markError, no decrypt/HTTP) when the provider is not configured', async () => {
      jest.spyOn(adsTypes, 'isMetaAdsConfigured').mockReturnValue(false);
      const openSpy = jest.spyOn(secretBox, 'openSecret');
      const metaSpy = jest.spyOn(metaClient, 'pullMetaInsights');
      const written = await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(written).toBe(0);
      expect(openSpy).not.toHaveBeenCalled();
      expect(metaSpy).not.toHaveBeenCalled();
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.lastError).toContain('not configured');
    });

    it('records lastError (not throwing) when a metric DB write fails, stamping lastPulledAt', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockResolvedValue([
        { date: '2026-06-01', campaignId: 'c1', spend: 1, impressions: 1, clicks: 1, leads: 0 },
      ]);
      prisma.adMetric.upsert.mockRejectedValue(new Error('deadlock detected'));
      const written = await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(written).toBe(0);
      // markError stamps lastPulledAt so a never-pulled row rotates out of the queue front.
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.lastError).toContain('deadlock');
      expect(upd.data.lastPulledAt).toBeInstanceOf(Date);
    });

    it('marks lastError and writes nothing when the token cannot be decrypted', async () => {
      jest.spyOn(secretBox, 'openSecret').mockImplementation(() => {
        throw new Error('bad key');
      });
      const metaSpy = jest.spyOn(metaClient, 'pullMetaInsights');
      const written = await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(written).toBe(0);
      expect(metaSpy).not.toHaveBeenCalled();
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.where).toEqual({ id: 'a1' });
      expect(upd.data.lastError).toContain('decrypt');
      expect(prisma.adMetric.upsert).not.toHaveBeenCalled();
    });

    it('records lastError (not throwing) when the provider client fails', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockRejectedValue(new Error('Meta ads 400: bad token'));
      const written = await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(written).toBe(0);
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.lastError).toContain('Meta ads 400');
      expect(prisma.adMetric.upsert).not.toHaveBeenCalled();
    });

    it('marks TOKEN_EXPIRED + reauth_required on a Meta auth error', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      const err: any = new Error('Meta ads 401: invalid OAuth token');
      err.isAuthError = true; // set by meta-ads.client from the helper's classification
      jest.spyOn(metaClient, 'pullMetaInsights').mockRejectedValue(err);
      const written = await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(written).toBe(0);
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.status).toBe('TOKEN_EXPIRED');
      expect(upd.data.lastError).toBe('reauth_required');
      expect(prisma.adMetric.upsert).not.toHaveBeenCalled();
    });

    it('does NOT mark TOKEN_EXPIRED for a non-auth provider error', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockRejectedValue(new Error('Meta ads 500: server error'));
      await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.status).toBeUndefined();
      expect(upd.data.lastError).toContain('Meta ads 500');
    });

    it('a successful pull resets status to ACTIVE (recovery from reauth)', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockResolvedValue([
        { date: '2026-06-01', campaignId: 'c1', spend: 1, impressions: 1, clicks: 1, leads: 0 },
      ]);
      await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.status).toBe('ACTIVE');
      expect(upd.data.lastError).toBeNull();
    });

    it('idempotently upserts each row with an inline workspaceId, then clears lastError', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockResolvedValue([
        { date: '2026-06-01', campaignId: 'c1', spend: 10, impressions: 100, clicks: 5, leads: 1, raw: { x: 1 } },
        { date: '2026-06-02', campaignId: '', spend: 2, impressions: 9, clicks: 0, leads: 0 },
      ]);
      prisma.adMetric.upsert.mockResolvedValue({});
      prisma.adAccount.update.mockResolvedValue({});

      const written = await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(written).toBe(2);
      expect(prisma.adMetric.upsert).toHaveBeenCalledTimes(2);
      const first = prisma.adMetric.upsert.mock.calls[0][0] as any;
      expect(first.where.adAccountId_date_campaignId).toEqual({
        adAccountId: 'a1',
        date: new Date('2026-06-01T00:00:00.000Z'),
        campaignId: 'c1',
      });
      expect(first.create.workspaceId).toBe(WS);
      expect(first.create.adAccountId).toBe('a1');
      // success path clears lastError on the account
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.lastError).toBeNull();
      expect(upd.data.lastPulledAt).toBeInstanceOf(Date);
    });

    it('dispatches to the TikTok client for a TikTok account', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      const ttSpy = jest.spyOn(tiktokClient, 'pullTiktokInsights').mockResolvedValue([]);
      prisma.adAccount.update.mockResolvedValue({});
      await svc.pullAccount({ ...account, provider: 'TIKTOK', externalAdId: 'adv_9' }, '2026-06-01', '2026-06-03');
      expect(ttSpy).toHaveBeenCalledWith('plain', 'adv_9', '2026-06-01', '2026-06-03');
    });

    it('skips rows with an unparseable date', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockResolvedValue([
        { date: 'not-a-date', campaignId: '', spend: 1, impressions: 1, clicks: 1, leads: 0 },
      ]);
      prisma.adAccount.update.mockResolvedValue({});
      const written = await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(prisma.adMetric.upsert).not.toHaveBeenCalled();
      // rows.length is still returned (1), but nothing was written
      expect(written).toBe(1);
    });
  });

  describe('pullNow', () => {
    it('404s an account in another workspace', async () => {
      prisma.adAccount.findFirst.mockResolvedValue(null);
      await expect(svc.pullNow(WS, 'a1', 7)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('status', () => {
    it('reports provider + secret-box configuration flags', () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
      const s = svc.status();
      expect(s).toHaveProperty('META');
      expect(s).toHaveProperty('TIKTOK');
      expect(s.secretBoxConfigured).toBe(true);
    });
  });
});
