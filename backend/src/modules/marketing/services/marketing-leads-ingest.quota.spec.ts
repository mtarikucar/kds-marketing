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
});
