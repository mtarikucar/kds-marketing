import { Logger } from '@nestjs/common';
import { MarketingLeadsIngestService } from './marketing-leads-ingest.service';

/**
 * Quota-clipping contract of the ingest path (Phase E):
 *   - dupes are filtered BEFORE reservation and never consume quota
 *   - creates stop at the remaining daily budget; the rest is `clipped`
 *   - reserved-but-failed slots are settled back (no quota leak)
 *   - HTTP-level callers get the meter in `quota{limit,used,remaining}`
 */
describe('MarketingLeadsIngestService — daily quota clipping', () => {
  const WS = 'ws-1';

  function candidate(n: number) {
    return {
      externalRef: `instagram:@biz${n}`,
      businessName: `Biz ${n}`,
      businessType: 'CAFE',
      painPoint: 'p',
      evidence: 'e',
      pitch: 'pi',
    } as any;
  }

  let prisma: any;
  let autoAssigner: { pickAssignee: jest.Mock };
  let quotaResolver: { getDailyLeadQuota: jest.Mock };
  let svc: MarketingLeadsIngestService;
  let counterValue: number;

  beforeEach(() => {
    counterValue = 0;
    prisma = {
      marketingUser: {
        findFirst: jest.fn().mockResolvedValue({ id: 'sentinel-1' }),
      },
      lead: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: `lead-${data.externalRef}`,
          ...data,
        })),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      usageCounter: {
        findUnique: jest
          .fn()
          .mockImplementation(async () =>
            counterValue > 0 ? { value: counterValue } : null,
          ),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          if (args.update?.value?.increment !== undefined) {
            counterValue += args.update.value.increment;
          } else if (args.create?.value !== undefined && counterValue === 0) {
            counterValue = args.create.value;
          }
          return { value: counterValue };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    quotaResolver = { getDailyLeadQuota: jest.fn().mockResolvedValue(3) };
    svc = new MarketingLeadsIngestService(
      prisma,
      autoAssigner as any,
      quotaResolver as any,
    );
  });

  it('clips at the remaining budget: quota 3, batch 5 → created 3, clipped 2, remaining 0', async () => {
    const res = await svc.ingest(WS, {
      leads: [1, 2, 3, 4, 5].map(candidate),
    } as any);

    expect(res).toMatchObject({
      created: 3,
      skipped: 0,
      clipped: 2,
      quota: { limit: 3, used: 3, remaining: 0 },
    });
    expect(prisma.lead.create).toHaveBeenCalledTimes(3);
  });

  it('a second batch the same day is fully clipped (created 0)', async () => {
    await svc.ingest(WS, { leads: [1, 2, 3].map(candidate) } as any);
    const res = await svc.ingest(WS, { leads: [6, 7].map(candidate) } as any);

    expect(res).toMatchObject({
      created: 0,
      clipped: 2,
      quota: { limit: 3, used: 3, remaining: 0 },
    });
  });

  it('dupes never consume quota: 2 existing + 3 fresh under quota 3 → created 3, skipped 2', async () => {
    prisma.lead.findMany.mockResolvedValue([
      { externalRef: 'instagram:@biz1' },
      { externalRef: 'instagram:@biz2' },
    ]);
    const res = await svc.ingest(WS, {
      leads: [1, 2, 3, 4, 5].map(candidate),
    } as any);

    expect(res).toMatchObject({ created: 3, skipped: 2, clipped: 0 });
    expect(res.quota.remaining).toBe(0);
  });

  it('intra-batch duplicate refs collapse to one create', async () => {
    const dup = candidate(1);
    const res = await svc.ingest(WS, { leads: [dup, dup, candidate(2)] } as any);
    expect(res).toMatchObject({ created: 2, skipped: 1 });
  });

  it('settles reserved-but-failed slots back to the budget', async () => {
    prisma.lead.create
      .mockImplementationOnce(async ({ data }: any) => ({ id: 'ok', ...data }))
      .mockRejectedValueOnce(new Error('row exploded'));

    const res = await svc.ingest(WS, { leads: [1, 2].map(candidate) } as any);

    expect(res.created).toBe(1);
    expect(res.errors).toHaveLength(1);
    // Counter: +2 reserve, -1 settle → 1 used, 2 remaining of 3.
    expect(counterValue).toBe(1);
    expect(res.quota).toMatchObject({ used: 1, remaining: 2 });
  });

  it('refunds reserved-but-uncreated slots even when the create loop throws mid-flight', async () => {
    // First row succeeds; the second rejects with a value that throws when its
    // .code/.message are read, so the error escapes the per-row catch and exits
    // the loop. The try/finally must still settle: refund is keyed on the ACTUAL
    // created count (1), returning the 2 reserved-but-uncreated slots of 3.
    const hostile: any = {};
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('boom');
      },
    });
    prisma.lead.create
      .mockImplementationOnce(async ({ data }: any) => ({ id: 'ok', ...data }))
      .mockImplementationOnce(async () => {
        throw hostile;
      });

    await expect(
      svc.ingest(WS, { leads: [1, 2, 3].map(candidate) } as any),
    ).rejects.toBeTruthy();

    // +3 reserve, -2 settle (3 granted − 1 created) → 1 used. The refund fired
    // from the finally despite the throw, so no quota leaked.
    expect(counterValue).toBe(1);
  });

  it('quota 0 (suspended workspace / zero plan) clips everything without touching leads', async () => {
    quotaResolver.getDailyLeadQuota.mockResolvedValue(0);
    const res = await svc.ingest(WS, { leads: [1, 2].map(candidate) } as any);
    expect(res).toMatchObject({ created: 0, clipped: 2, quota: { limit: 0 } });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('unlimited (-1) admits everything and reports remaining -1', async () => {
    quotaResolver.getDailyLeadQuota.mockResolvedValue(-1);
    const res = await svc.ingest(WS, { leads: [1, 2, 3, 4].map(candidate) } as any);
    expect(res).toMatchObject({
      created: 4,
      clipped: 0,
      quota: { limit: -1, remaining: -1 },
    });
  });

  it('serializes the reservation under a per-workspace advisory xact lock', async () => {
    await svc.ingest(WS, { leads: [1].map(candidate) } as any);
    const lockCalls = prisma.$queryRawUnsafe.mock.calls.filter(([sql]: [string]) =>
      sql.includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls.length).toBe(1);
    expect(lockCalls[0][0]).toContain(`ingest:${WS}`);
  });

  it('settles the refund to the SAME UTC day it reserved on (no midnight split)', async () => {
    // Per-period-key counters so a reserve-day vs settle-day split is visible
    // (the shared mock collapses all keys into one value and would hide it).
    const counters: Record<string, number> = {};
    const keyOf = (a: any) => a.where.workspaceId_metric_periodKey.periodKey;
    const prisma2: any = {
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sentinel-1' }) },
      lead: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementationOnce(async ({ data }: any) => ({ id: 'a', ...data }))
          .mockImplementationOnce(async ({ data }: any) => ({ id: 'b', ...data }))
          .mockRejectedValueOnce(new Error('row exploded')), // 3rd fails → created 2, refund 1
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      usageCounter: {
        findUnique: jest.fn().mockImplementation(async (a: any) => {
          const k = keyOf(a);
          return counters[k] ? { value: counters[k] } : null;
        }),
        upsert: jest.fn().mockImplementation(async (a: any) => {
          const k = keyOf(a);
          if (a.update?.value?.increment !== undefined) counters[k] = (counters[k] ?? 0) + a.update.value.increment;
          else if (a.create?.value !== undefined) counters[k] = a.create.value;
          return { value: counters[k] };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (fn: any) => fn(prisma2)),
    };
    const svc2 = new MarketingLeadsIngestService(
      prisma2,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      { getDailyLeadQuota: jest.fn().mockResolvedValue(10) } as any,
    );

    // Cross midnight UTC: the FIRST new Date() (reserve / the captured key) is on
    // Jun-30; any LATER one (the old settle path) is on Jul-01.
    // Suppress the NestJS logger so its own new Date() (for timestamps) isn't
    // disturbed by the clock mock below.
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Cross midnight UTC: the FIRST new Date() (reserve / the captured key) is on
    // Jun-30; the SECOND (the old settle path) is on Jul-01; anything after gets
    // the real clock (so unrelated callers aren't frozen).
    const RealDate = Date;
    const dayN = new RealDate('2026-06-30T23:59:30Z');
    const dayN1 = new RealDate('2026-07-01T00:00:30Z');
    let n = 0;
    const spy = jest.spyOn(global, 'Date').mockImplementation(((...args: any[]) => {
      if (args.length) return new (RealDate as any)(...args);
      if (n === 0) { n++; return dayN; }
      if (n === 1) { n++; return dayN1; }
      return new RealDate();
    }) as any);
    try {
      const res = await svc2.ingest(WS, { leads: [1, 2, 3].map(candidate) } as any);
      expect(res.created).toBe(2);
      // The reserve-day counter must net to the ACTUAL created count (2), and the
      // next day must NOT be touched by a phantom negative refund.
      expect(counters['2026-06-30']).toBe(2);
      expect(counters['2026-07-01'] ?? 0).toBe(0);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
