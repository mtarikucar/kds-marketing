import { SocialPostMetricService } from './social-post-metric.service';

function makePrisma() {
  const upsert = jest.fn().mockResolvedValue({});
  const findMany = jest.fn().mockResolvedValue([]);
  return { prisma: { socialPostMetric: { upsert, findMany } } as any, upsert, findMany };
}

describe('SocialPostMetricService', () => {
  it('normalizes any date to UTC midnight', () => {
    expect(SocialPostMetricService.utcDay('2026-07-03T15:22:00Z').toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(SocialPostMetricService.utcDay(new Date('2026-07-03T23:59:59Z')).toISOString()).toBe('2026-07-03T00:00:00.000Z');
  });

  it('upserts idempotently on (targetId, date) with clamped counts', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new SocialPostMetricService(prisma);
    await svc.upsert('ws1', 't1', '2026-07-03', { impressions: 1000, reach: 800, clicks: 12, videoViews: 300, raw: { x: 1 } });
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ targetId_date: { targetId: 't1', date: new Date('2026-07-03T00:00:00.000Z') } });
    expect(arg.create).toMatchObject({ workspaceId: 'ws1', targetId: 't1', impressions: 1000, reach: 800, clicks: 12, videoViews: 300, raw: { x: 1 } });
    // missing fields default to 0
    expect(arg.create.likes).toBe(0);
    expect(arg.update.pulledAt).toBeInstanceOf(Date);
  });

  it('clamps negative / non-numeric counts to 0 and floors decimals', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new SocialPostMetricService(prisma);
    await svc.upsert('ws1', 't1', '2026-07-03', { impressions: -5 as any, reach: 3.9 as any, likes: 'x' as any });
    const c = upsert.mock.calls[0][0].create;
    expect(c.impressions).toBe(0);
    expect(c.reach).toBe(3);
    expect(c.likes).toBe(0);
  });

  it('skips an invalid date without calling the db', async () => {
    const { prisma, upsert } = makePrisma();
    const svc = new SocialPostMetricService(prisma);
    await svc.upsert('ws1', 't1', 'not-a-date', { impressions: 1 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('ingestBatch keeps going past a failing row and counts successes', async () => {
    const { prisma, upsert } = makePrisma();
    upsert.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});
    const svc = new SocialPostMetricService(prisma);
    const n = await svc.ingestBatch('ws1', [
      { targetId: 'a', date: '2026-07-03', insights: { impressions: 1 } },
      { targetId: 'b', date: '2026-07-03', insights: { impressions: 2 } },
      { targetId: 'c', date: '2026-07-03', insights: { impressions: 3 } },
    ]);
    expect(n).toBe(2);
  });
});
