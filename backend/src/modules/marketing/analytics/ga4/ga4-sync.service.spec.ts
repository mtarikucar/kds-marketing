import { Prisma } from '@prisma/client';
import { Ga4SyncService } from './ga4-sync.service';
import { Ga4ApiError, Ga4Row } from './ga4-data.client';

const WS = 'ws-1';
const NOW = new Date('2026-10-21T08:15:00.000Z');

const conn = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  workspaceId: WS,
  propertyId: 'properties/123',
  enabled: true,
  lastSyncedAt: new Date('2026-10-20T08:00:00.000Z'),
  ...over,
});

const r = (date: string, key: string, sessions: number, purchaseValue = 0): Ga4Row => ({
  date,
  key,
  sessions,
  totalUsers: sessions - 1,
  newUsers: 1,
  conversions: 2,
  purchaseCount: purchaseValue ? 1 : 0,
  purchaseValue,
});

function build() {
  const prisma: any = {
    ga4DailyStat: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
    },
    ga4Connection: { update: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops));
  const oauth = { accessToken: jest.fn().mockResolvedValue('ya29.live') };
  const data = {
    runReport: jest.fn(async (_t: string, _p: string, opts: { dimension: string }) => ({
      currency: 'TRY',
      rows:
        opts.dimension === 'TOTAL'
          ? [r('2026-10-19', '', 100, 6998), r('2026-10-20', '', 80)]
          : opts.dimension === 'SOURCE_MEDIUM'
            ? [r('2026-10-20', 'google / cpc', 50), r('2026-10-20', 'instagram / paid_social', 30)]
            : [r('2026-10-20', 'ekim-hediye', 30)],
    })),
  };
  return { prisma, oauth, data, svc: new Ga4SyncService(prisma, oauth as never, data as never) };
}

describe('Ga4SyncService.syncConnection (contract §6.3, B3/B4)', () => {
  it('pulls the last 3 days (yesterday included) for the three reports and overwrites those days', async () => {
    const { svc, data, prisma } = build();
    const out = await svc.syncConnection(conn(), NOW);
    expect(out).toEqual({ status: 'synced', rows: 5 });
    expect(data.runReport.mock.calls.map((c) => c[2])).toEqual([
      { startDate: '3daysAgo', endDate: 'yesterday', dimension: 'TOTAL' },
      { startDate: '3daysAgo', endDate: 'yesterday', dimension: 'SOURCE_MEDIUM' },
      { startDate: '3daysAgo', endDate: 'yesterday', dimension: 'CAMPAIGN' },
    ]);
    expect(data.runReport.mock.calls[0].slice(0, 2)).toEqual(['ya29.live', 'properties/123']);

    // Re-pulled days are replaced wholesale, so a key that fell out of the top 50 does not linger.
    expect(prisma.ga4DailyStat.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: WS,
        propertyId: 'properties/123',
        date: { in: [new Date('2026-10-19T00:00:00.000Z'), new Date('2026-10-20T00:00:00.000Z')] },
      },
    });
    const rows = prisma.ga4DailyStat.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      workspaceId: WS,
      propertyId: 'properties/123',
      date: new Date('2026-10-19T00:00:00.000Z'),
      dimension: 'TOTAL',
      key: '',
      sessions: 100,
      totalUsers: 99,
      newUsers: 1,
      conversions: 2,
      purchaseCount: 1,
      purchaseValue: new Prisma.Decimal('6998'),
      currency: 'TRY',
    });
    expect(rows.map((x: any) => `${x.dimension}:${x.key}`)).toEqual([
      'TOTAL:',
      'TOTAL:',
      'SOURCE_MEDIUM:google / cpc',
      'SOURCE_MEDIUM:instagram / paid_social',
      'CAMPAIGN:ekim-hediye',
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.ga4Connection.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { lastSyncedAt: NOW, lastError: null },
    });
  });

  it('backfills 35 days on the first sync (the weekly report needs the previous week)', async () => {
    const { svc, data } = build();
    await svc.syncConnection(conn({ lastSyncedAt: null }), NOW);
    expect(data.runReport.mock.calls[0][2]).toMatchObject({ startDate: '35daysAgo', endDate: 'yesterday' });
  });

  it('keeps purchase value to 2 decimals', async () => {
    const { svc, data, prisma } = build();
    data.runReport.mockResolvedValue({ currency: 'TRY', rows: [r('2026-10-20', '', 1, 3499.005)] });
    await svc.syncConnection(conn(), NOW);
    expect(prisma.ga4DailyStat.createMany.mock.calls[0][0].data[0].purchaseValue.toString()).toBe('3499.01');
  });

  it('skips a connection with no property selected', async () => {
    const { svc, data } = build();
    expect(await svc.syncConnection(conn({ propertyId: null }), NOW)).toEqual({ status: 'skipped', rows: 0 });
    expect(data.runReport).not.toHaveBeenCalled();
  });

  it('401 → refreshes once and retries; succeeds on the new token', async () => {
    const { svc, data, oauth } = build();
    data.runReport.mockRejectedValueOnce(new Ga4ApiError(401, 'UNAUTHENTICATED'));
    oauth.accessToken.mockResolvedValueOnce('ya29.old').mockResolvedValueOnce('ya29.new');
    const out = await svc.syncConnection(conn(), NOW);
    expect(out.status).toBe('synced');
    expect(oauth.accessToken).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'c1' }), { forceRefresh: true });
    expect(data.runReport.mock.calls[1][0]).toBe('ya29.new');
  });

  it('401 → refresh → 401 again: disables the connection with REAUTH_REQUIRED and writes no stats', async () => {
    const { svc, data, prisma } = build();
    data.runReport.mockRejectedValue(new Ga4ApiError(401, 'UNAUTHENTICATED'));
    const out = await svc.syncConnection(conn(), NOW);
    expect(out).toEqual({ status: 'failed', rows: 0, error: 'REAUTH_REQUIRED' });
    expect(prisma.ga4Connection.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { enabled: false, lastError: 'REAUTH_REQUIRED' },
    });
    expect(prisma.ga4DailyStat.createMany).not.toHaveBeenCalled();
  });

  it('a revoked grant (refresh fails with invalid_grant) is REAUTH_REQUIRED too', async () => {
    const { svc, oauth, prisma } = build();
    oauth.accessToken.mockRejectedValue(new Error('GA4 token refresh failed: invalid_grant'));
    const out = await svc.syncConnection(conn(), NOW);
    expect(out.error).toBe('REAUTH_REQUIRED');
    expect(prisma.ga4Connection.update.mock.calls[0][0].data).toEqual({ enabled: false, lastError: 'REAUTH_REQUIRED' });
  });

  it('any other failure records lastError and leaves lastSyncedAt alone (retried next hour)', async () => {
    const { svc, data, prisma } = build();
    data.runReport.mockRejectedValue(new Ga4ApiError(429, 'RESOURCE_EXHAUSTED'));
    const out = await svc.syncConnection(conn(), NOW);
    expect(out.status).toBe('failed');
    const update = prisma.ga4Connection.update.mock.calls[0][0];
    expect(update.data).toEqual({ lastError: expect.stringContaining('429') });
    expect(update.data).not.toHaveProperty('lastSyncedAt');
    expect(update.data).not.toHaveProperty('enabled');
  });
});
