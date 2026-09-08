import { TREND_REFRESH_INTERVAL_MS, TREND_REFRESH_KIND, TrendSignalService } from './trend-signal.service';
import type { TrendCandidate, TrendProvider } from './providers/trend-provider';

const NOW = new Date('2026-09-08T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function provider(name: string, over: Partial<TrendProvider> = {}): TrendProvider & { fetch: jest.Mock; enabled: jest.Mock } {
  return { name, enabled: jest.fn().mockReturnValue(true), fetch: jest.fn().mockResolvedValue([]), ...over } as any;
}
function signal(over: Record<string, unknown> = {}) {
  return {
    id: 's', region: 'TR', network: 'GOOGLE', kind: 'TOPIC', title: 't', ref: null, score: 50, source: 'google-trends',
    observedAt: NOW, halfLifeHours: 36, raw: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function harness(providers: TrendProvider[], rows: unknown[] = []) {
  const prisma: any = {
    trendSignal: {
      upsert: jest.fn().mockImplementation(async ({ create }: any) => ({ id: 'x', ...create })),
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const svc = new TrendSignalService(prisma, scheduledJobs as any, runner as any, providers);
  return { svc, prisma, scheduledJobs, runner };
}

describe('TrendSignalService.refresh', () => {
  it('upserts every candidate on (region, network, kind, title), refreshing score/observedAt/raw on a re-sighting', async () => {
    const cand: TrendCandidate = { network: 'GOOGLE', kind: 'TOPIC', title: 'Derbi', ref: 'https://x/1', score: 43, halfLifeHours: 36, raw: { traffic: 20000 } };
    const g = provider('google-trends', { fetch: jest.fn().mockResolvedValue([cand]) });
    const { svc, prisma } = harness([g]);
    const res = await svc.refresh('TR');
    expect(g.fetch).toHaveBeenCalledWith('TR');
    expect(res).toEqual([{ provider: 'google-trends', count: 1 }]);
    expect(prisma.trendSignal.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.trendSignal.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ region_network_kind_title: { region: 'TR', network: 'GOOGLE', kind: 'TOPIC', title: 'Derbi' } });
    expect(args.create).toEqual(expect.objectContaining({
      region: 'TR', network: 'GOOGLE', kind: 'TOPIC', title: 'Derbi', ref: 'https://x/1', score: 43, halfLifeHours: 36,
      source: 'google-trends', raw: { traffic: 20000 }, observedAt: expect.any(Date),
    }));
    expect(args.update).toEqual(expect.objectContaining({ score: 43, ref: 'https://x/1', raw: { traffic: 20000 }, source: 'google-trends', halfLifeHours: 36, observedAt: expect.any(Date) }));
    expect(args.update).not.toHaveProperty('title');
  });

  it('skips disabled providers silently and defaults the half-life to 48h when a candidate has none', async () => {
    const off = provider('apify-tiktok', { enabled: jest.fn().mockReturnValue(false) });
    const yt = provider('youtube-trending', { fetch: jest.fn().mockResolvedValue([{ network: 'YOUTUBE', kind: 'TOPIC', title: 'v', score: 10 }]) });
    const { svc, prisma } = harness([off, yt]);
    const res = await svc.refresh('TR');
    expect(off.fetch).not.toHaveBeenCalled();
    expect(res).toEqual([{ provider: 'youtube-trending', count: 1 }]);
    expect(prisma.trendSignal.upsert.mock.calls[0][0].create.halfLifeHours).toBe(48);
    expect(prisma.trendSignal.upsert.mock.calls[0][0].create.ref).toBeNull();
  });

  it('isolates a failing provider: its error is reported in the result and the others still land', async () => {
    const bad = provider('google-trends', { fetch: jest.fn().mockRejectedValue(new Error('google trends rss failed (503)')) });
    const good = provider('youtube-trending', { fetch: jest.fn().mockResolvedValue([{ network: 'YOUTUBE', kind: 'TOPIC', title: 'ok', score: 1 }]) });
    const { svc, prisma } = harness([bad, good]);
    const res = await svc.refresh('TR');
    expect(res).toEqual([
      { provider: 'google-trends', count: 0, error: 'google trends rss failed (503)' },
      { provider: 'youtube-trending', count: 1 },
    ]);
    expect(prisma.trendSignal.upsert).toHaveBeenCalledTimes(1);
  });

  it('counts only the rows that were written when a single upsert fails, and drops blank titles and in-batch duplicates', async () => {
    const g = provider('google-trends', {
      fetch: jest.fn().mockResolvedValue([
        { network: 'GOOGLE', kind: 'TOPIC', title: 'a', score: 1 },
        { network: 'GOOGLE', kind: 'TOPIC', title: 'a', score: 2 },
        { network: 'GOOGLE', kind: 'TOPIC', title: '  ', score: 3 },
        { network: 'GOOGLE', kind: 'TOPIC', title: 'b', score: 4 },
      ]),
    });
    const { svc, prisma } = harness([g]);
    prisma.trendSignal.upsert.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('db down'));
    const res = await svc.refresh('TR');
    expect(prisma.trendSignal.upsert).toHaveBeenCalledTimes(2);
    expect(res).toEqual([{ provider: 'google-trends', count: 1, error: expect.stringMatching(/db down/) }]);
  });
});

describe('TrendSignalService.top', () => {
  it('reads the last 7 days for the region (and networks when given), ranks by decayed × relevance, and limits', async () => {
    const rows = [
      // hot but off-brand: 90 · 0.3 = 27
      signal({ id: 'hot', title: 'Galatasaray derbi', score: 90, observedAt: NOW }),
      // on-brand and fresh: 50 · (0.3 + 0.7·(1/3)) ≈ 26.7  — tokens {yeni,kahve,makinesi} ∩ {kahve} = 1/3
      signal({ id: 'brand', title: 'Yeni kahve makinesi', score: 50, observedAt: NOW }),
      // perfectly on-brand but a day and a half old at a 36h half-life: 40 · 0.5 · 1 = 20
      signal({ id: 'old', title: 'Kahve', score: 40, observedAt: hoursAgo(36), halfLifeHours: 36 }),
    ];
    const { svc, prisma } = harness([], rows);
    const out = await svc.top('TR', { networks: ['GOOGLE', 'YOUTUBE'], brandKeywords: ['Kahve'], limit: 2, now: NOW });
    const where = prisma.trendSignal.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ region: 'TR', observedAt: { gte: new Date(NOW.getTime() - 7 * 24 * 3_600_000) }, network: { in: ['GOOGLE', 'YOUTUBE'] } });
    expect(out.map((r) => r.signal.id)).toEqual(['hot', 'brand']);
    expect(out[0]).toEqual({ signal: rows[0], decayed: 90, relevance: 0, suggestion: expect.closeTo(27, 6) });
    expect(out[1].relevance).toBeCloseTo(1 / 3, 6);
    expect(out[1].suggestion).toBeCloseTo(50 * (0.3 + 0.7 / 3), 6);
  });

  it('omits the network filter when none is given and defaults to 10 results', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => signal({ id: `s${i}`, title: `t${i}`, score: i }));
    const { svc, prisma } = harness([], rows);
    const out = await svc.top('TR', { brandKeywords: [] });
    expect(prisma.trendSignal.findMany.mock.calls[0][0].where).not.toHaveProperty('network');
    expect(out).toHaveLength(10);
    expect(out[0].signal.id).toBe('s11');
  });
});

describe('TrendSignalService job', () => {
  it('registers the 12-hourly trend.refresh handler and seeds one global dedup-keyed job', async () => {
    const g = provider('google-trends');
    const { svc, scheduledJobs, runner } = harness([g]);
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(TREND_REFRESH_KIND, expect.any(Function));
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'system', kind: TREND_REFRESH_KIND, dedupKey: 'trend-refresh', payload: {}, runAt: expect.any(Date),
    }));
    const handler = runner.registerHandler.mock.calls[0][1];
    const before = Date.now();
    const result = await handler({ id: 'j', workspaceId: 'system', kind: TREND_REFRESH_KIND, payload: {}, attempts: 0 });
    expect(g.fetch).toHaveBeenCalledWith('TR');
    expect(result.reschedule.runAt.getTime()).toBeGreaterThanOrEqual(before + TREND_REFRESH_INTERVAL_MS);
    expect(TREND_REFRESH_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('never throws out of the handler even when every provider fails, so the chain keeps rescheduling', async () => {
    const bad = provider('google-trends', { fetch: jest.fn().mockRejectedValue(new Error('boom')) });
    const { svc, runner } = harness([bad]);
    svc.onModuleInit();
    const handler = runner.registerHandler.mock.calls[0][1];
    await expect(handler({ id: 'j', workspaceId: 'system', kind: TREND_REFRESH_KIND, payload: {}, attempts: 0 })).resolves.toEqual(
      expect.objectContaining({ reschedule: expect.anything() }),
    );
  });
});
