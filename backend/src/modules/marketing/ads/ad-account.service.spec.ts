import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdAccountService } from './ad-account.service';
import * as metaClient from './meta-ads.client';
import * as tiktokClient from './tiktok-ads.client';
import * as linkedinClient from './linkedin-ads.client';
import * as adsTypes from './ads.types';
import * as secretBox from '../../../common/crypto/secret-box.helper';
import { pullMetaBreakdowns } from './meta-ads-breakdown.client';

jest.mock('./meta-ads-breakdown.client', () => ({ pullMetaBreakdowns: jest.fn().mockResolvedValue([]) }));
const mockBreakdownPull = pullMetaBreakdowns as jest.Mock;

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
      updateMany: jest.fn(),
    },
    adMetricBreakdown: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
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
    jest.spyOn(adsTypes, 'isLinkedinAdsConfigured').mockReturnValue(true);
    // Safe defaults so awaited writes (and markError's `.catch`) resolve.
    prisma.adAccount.update.mockResolvedValue({});
    prisma.adAccount.upsert.mockResolvedValue({});
    prisma.adAccount.delete.mockResolvedValue({});
    prisma.adMetric.upsert.mockResolvedValue({});
    prisma.adMetric.updateMany.mockResolvedValue({ count: 0 });
    mockBreakdownPull.mockReset().mockResolvedValue([]);
  });

  describe('getBreakdown', () => {
    it('groups by placement with a recomputed ROAS and window-aware leads', async () => {
      prisma.adAccount.findMany.mockResolvedValue([{ id: 'a1' }]);
      prisma.adMetricBreakdown.findMany.mockResolvedValue([
        { placement: 'facebook:feed', adSetId: '', adSetName: null, adId: '', adName: null, breakdownValue: '', spend: '10.00', impressions: 100, clicks: 5, leads: 2, conversionValue: '40.00', leads1dClick: 1, leads7dClick: 2, leads1dView: 0, convValue1dClick: '20.00', convValue7dClick: '40.00', convValue1dView: '0' },
        { placement: 'facebook:feed', adSetId: '', adSetName: null, adId: '', adName: null, breakdownValue: '', spend: '10.00', impressions: 50, clicks: 3, leads: 1, conversionValue: '20.00', leads1dClick: 1, leads7dClick: 1, leads1dView: 0, convValue1dClick: '10.00', convValue7dClick: '20.00', convValue1dView: '0' },
      ]);
      const res = await svc.getBreakdown(WS, '2026-06-01', '2026-06-30', { dimension: 'placement' });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ key: 'facebook:feed', spend: 20, leads: 3, revenue: 60, roas: 3 });
      // The findMany filter is workspace-scoped and placement-only.
      const where = prisma.adMetricBreakdown.findMany.mock.calls[0][0].where;
      expect(where.workspaceId).toBe(WS);
      expect(where.placement).toEqual({ not: '' });
    });

    it('uses the 7d_click window figures when requested', async () => {
      prisma.adAccount.findMany.mockResolvedValue([{ id: 'a1' }]);
      prisma.adMetricBreakdown.findMany.mockResolvedValue([
        { placement: '', adSetId: '', adSetName: null, adId: '', adName: null, breakdownType: 'age', breakdownValue: '25-34', spend: '10.00', impressions: 100, clicks: 5, leads: 9, conversionValue: '90.00', leads1dClick: 3, leads7dClick: 7, leads1dView: 0, convValue1dClick: '30.00', convValue7dClick: '70.00', convValue1dView: '0' },
      ]);
      const res = await svc.getBreakdown(WS, '2026-06-01', '2026-06-30', { dimension: 'age', window: '7d_click' });
      expect(res.rows[0]).toMatchObject({ key: '25-34', leads: 7, revenue: 70 });
      expect(prisma.adMetricBreakdown.findMany.mock.calls[0][0].where.breakdownType).toBe('age');
    });

    it('returns empty when the workspace has no ad accounts', async () => {
      prisma.adAccount.findMany.mockResolvedValue([]);
      const res = await svc.getBreakdown(WS, '2026-06-01', '2026-06-30', { dimension: 'ad' });
      expect(res.rows).toEqual([]);
      expect(prisma.adMetricBreakdown.findMany).not.toHaveBeenCalled();
    });
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

    it('seals + upserts a LINKEDIN ad account', async () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
      jest.spyOn(secretBox, 'sealSecret').mockReturnValue('v1:sealed');
      prisma.adAccount.upsert.mockResolvedValue({ id: 'a1', provider: 'LINKEDIN' });
      await svc.connect(WS, {
        provider: 'LINKEDIN',
        externalAdId: '512345',
        displayName: 'Acme Ads',
        accessToken: 'li-tok',
        currency: 'USD',
      } as any);
      const arg = prisma.adAccount.upsert.mock.calls[0][0] as any;
      expect(arg.where.workspaceId_provider_externalAdId.provider).toBe('LINKEDIN');
      expect(arg.create.accessToken).toBe('v1:sealed');
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
      expect(res).toEqual({ totals: { spend: 0, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 }, byDay: [], byProvider: {} });
      expect(prisma.adMetric.findMany).not.toHaveBeenCalled();
    });

    it('aggregates rows into totals, byDay and byProvider (with recomputed ROAS)', async () => {
      prisma.adAccount.findMany.mockResolvedValue([
        { id: 'a1', provider: 'META' },
        { id: 'a2', provider: 'TIKTOK' },
      ]);
      prisma.adMetric.findMany.mockResolvedValue([
        { adAccountId: 'a1', date: new Date('2026-06-01T00:00:00Z'), spend: '10.50', impressions: 100, clicks: 5, leads: 1, revenue: '42.00' },
        { adAccountId: 'a1', date: new Date('2026-06-02T00:00:00Z'), spend: '4.50', impressions: 50, clicks: 2, leads: 0, revenue: '0' },
        { adAccountId: 'a2', date: new Date('2026-06-01T00:00:00Z'), spend: '5.00', impressions: 20, clicks: 3, leads: 2, revenue: '0' },
      ]);

      const res = await svc.getMetrics(WS, '2026-06-01', '2026-06-30');
      // ROAS is recomputed from aggregated revenue/spend, never a sum of per-row roas.
      expect(res.totals).toEqual({ spend: 20, impressions: 170, clicks: 10, leads: 3, revenue: 42, roas: 42 / 20 });
      expect(res.byProvider.META).toEqual({ spend: 15, impressions: 150, clicks: 7, leads: 1, revenue: 42, roas: 42 / 15 });
      // No revenue on TikTok → ROAS is 0 (rendered as a dash by the UI).
      expect(res.byProvider.TIKTOK).toEqual({ spend: 5, impressions: 20, clicks: 3, leads: 2, revenue: 0, roas: 0 });
      const day1 = res.byDay.find((d) => d.date === '2026-06-01');
      expect(day1).toEqual({ date: '2026-06-01', spend: 15.5, impressions: 120, clicks: 8, leads: 3, revenue: 42, roas: 42 / 15.5 });
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

    it('writes provider conversionValue ALWAYS and backfills revenue only while it is 0 (CRM wins)', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockResolvedValue([
        { date: '2026-06-01', campaignId: 'c1', spend: 10, impressions: 100, clicks: 5, leads: 1, conversionValue: 25.5 },
      ]);

      await svc.pullAccount(account, '2026-06-01', '2026-06-03');

      const up = prisma.adMetric.upsert.mock.calls[0][0] as any;
      expect(String(up.create.conversionValue)).toBe('25.5');
      expect(String(up.update.conversionValue)).toBe('25.5');
      // revenue is NEVER unconditionally written by the pull …
      expect(up.create.revenue).toBeUndefined();
      expect(up.update.revenue).toBeUndefined();
      // … it is backfilled via a guarded updateMany that only matches revenue=0
      expect(prisma.adMetric.updateMany).toHaveBeenCalledTimes(1);
      const um = prisma.adMetric.updateMany.mock.calls[0][0] as any;
      expect(um.where).toEqual({
        workspaceId: WS,
        adAccountId: 'a1',
        date: new Date('2026-06-01T00:00:00.000Z'),
        campaignId: 'c1',
        revenue: 0,
      });
      expect(String(um.data.revenue)).toBe('25.5');
    });

    it('skips the revenue backfill when the provider reports no purchase value', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(metaClient, 'pullMetaInsights').mockResolvedValue([
        { date: '2026-06-01', campaignId: 'c1', spend: 10, impressions: 100, clicks: 5, leads: 1, conversionValue: 0 },
      ]);
      await svc.pullAccount(account, '2026-06-01', '2026-06-03');
      expect(prisma.adMetric.updateMany).not.toHaveBeenCalled();
      // conversionValue 0 still mirrors the provider on the update path
      expect(String((prisma.adMetric.upsert.mock.calls[0][0] as any).update.conversionValue)).toBe('0');
    });

    it('leaves conversionValue untouched for a provider row that does not carry it (no CRM clobber)', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(tiktokClient, 'pullTiktokInsights').mockResolvedValue([
        { date: '2026-06-01', campaignId: 'c9', spend: 8, impressions: 500, clicks: 25, leads: 4 },
      ]);
      await svc.pullAccount({ ...account, provider: 'TIKTOK', externalAdId: 'adv_9' }, '2026-06-01', '2026-06-03');
      const up = prisma.adMetric.upsert.mock.calls[0][0] as any;
      expect(up.update.conversionValue).toBeUndefined();
      expect(prisma.adMetric.updateMany).not.toHaveBeenCalled();
    });

    it('dispatches to the TikTok client for a TikTok account', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      const ttSpy = jest.spyOn(tiktokClient, 'pullTiktokInsights').mockResolvedValue([]);
      prisma.adAccount.update.mockResolvedValue({});
      await svc.pullAccount({ ...account, provider: 'TIKTOK', externalAdId: 'adv_9' }, '2026-06-01', '2026-06-03');
      expect(ttSpy).toHaveBeenCalledWith('plain', 'adv_9', '2026-06-01', '2026-06-03');
    });

    it('dispatches to the LinkedIn client for a LinkedIn account', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      const liSpy = jest.spyOn(linkedinClient, 'pullLinkedinInsights').mockResolvedValue([]);
      prisma.adAccount.update.mockResolvedValue({});
      await svc.pullAccount(
        { ...account, provider: 'LINKEDIN', externalAdId: '512345' },
        '2026-06-01',
        '2026-06-03',
      );
      expect(liSpy).toHaveBeenCalledWith('plain', '512345', '2026-06-01', '2026-06-03');
    });

    it('marks TOKEN_EXPIRED on a LinkedIn auth error', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      const err: any = new Error('LinkedIn ads 401: invalid token');
      err.isAuthError = true;
      jest.spyOn(linkedinClient, 'pullLinkedinInsights').mockRejectedValue(err);
      const written = await svc.pullAccount(
        { ...account, provider: 'LINKEDIN', externalAdId: '512345' },
        '2026-06-01',
        '2026-06-03',
      );
      expect(written).toBe(0);
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.status).toBe('TOKEN_EXPIRED');
      expect(upd.data.lastError).toBe('reauth_required');
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

    it('sets status=TOKEN_EXPIRED (not just lastError) when TikTok throws an auth-signal error', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(tiktokClient, 'pullTiktokInsights').mockRejectedValue(
        new Error('access_token is invalid or expired (code: 40105)'),
      );
      const tiktokAccount = { ...account, provider: 'TIKTOK', externalAdId: 'adv_9' };
      const written = await svc.pullAccount(tiktokAccount, '2026-06-01', '2026-06-03');
      expect(written).toBe(0);
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      expect(upd.data.status).toBe('TOKEN_EXPIRED');
      expect(upd.data.lastError).toBe('reauth_required');
      expect(upd.data.lastPulledAt).toBeInstanceOf(Date);
    });

    it('does NOT set TOKEN_EXPIRED for a non-auth TikTok error (keeps regular lastError)', async () => {
      jest.spyOn(secretBox, 'openSecret').mockReturnValue('plain');
      jest.spyOn(tiktokClient, 'pullTiktokInsights').mockRejectedValue(
        new Error('Rate limit exceeded'),
      );
      const tiktokAccount = { ...account, provider: 'TIKTOK', externalAdId: 'adv_9' };
      const written = await svc.pullAccount(tiktokAccount, '2026-06-01', '2026-06-03');
      expect(written).toBe(0);
      const upd = prisma.adAccount.update.mock.calls[0][0] as any;
      // status must NOT be TOKEN_EXPIRED for a non-auth error
      expect(upd.data.status).toBeUndefined();
      expect(upd.data.lastError).toContain('Rate limit');
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

    it('reports LINKEDIN configuration in status', () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
      expect(svc.status()).toHaveProperty('LINKEDIN');
    });
  });
});
