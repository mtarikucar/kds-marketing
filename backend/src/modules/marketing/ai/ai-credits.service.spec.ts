import { ForbiddenException } from '@nestjs/common';
import { AiCreditsService, AI_CREDITS_METRIC } from './ai-credits.service';

/**
 * Monthly AI-credit metering — the reserve/refund contract that protects the
 * Anthropic bill. Mirrors the lead-ingest quota spec: a mocked UsageCounter
 * whose value the upsert mutates, so we exercise the read-modify-write the
 * advisory xact-lock serializes. The lock itself is asserted by call shape.
 */
describe('AiCreditsService — monthly credit metering', () => {
  const WS = 'ws-1';
  let prisma: any;
  let entitlements: { getEffective: jest.Mock };
  let svc: AiCreditsService;
  let counterValue: number;

  function withLimit(aiCreditsMonthly: number) {
    entitlements.getEffective.mockResolvedValue({ limits: { aiCreditsMonthly } });
  }

  beforeEach(() => {
    counterValue = 0;
    prisma = {
      usageCounter: {
        findUnique: jest
          .fn()
          .mockImplementation(async () =>
            counterValue > 0 ? { value: counterValue } : null,
          ),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          // Prisma upsert always sends both create+update; from 0 the
          // increment equals the create value, so applying the increment
          // reproduces both branches (same trick as the quota spec).
          if (args.update?.value?.increment !== undefined) {
            counterValue += args.update.value.increment;
          } else if (args.create?.value !== undefined && counterValue === 0) {
            counterValue = args.create.value;
          }
          return { value: counterValue };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    entitlements = { getEffective: jest.fn() };
    svc = new AiCreditsService(prisma as any, entitlements as any);
  });

  it('reserves under the cap and serializes on a per-workspace advisory xact lock', async () => {
    withLimit(100);
    await svc.reserve(WS, 3);
    expect(counterValue).toBe(3);

    const lockCalls = prisma.$queryRawUnsafe.mock.calls.filter(([sql]: [string]) =>
      sql.includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0][0]).toContain(`ai-credits:${WS}`);
  });

  it('throws AI_CREDITS_EXHAUSTED at the cap and does not over-spend', async () => {
    withLimit(5);
    await svc.reserve(WS, 4); // used=4
    await expect(svc.reserve(WS, 2)).rejects.toBeInstanceOf(ForbiddenException);
    expect(counterValue).toBe(4); // the over-cap reserve left the meter untouched
    try {
      await svc.reserve(WS, 2);
    } catch (e: any) {
      expect(e.getResponse().code).toBe('AI_CREDITS_EXHAUSTED');
    }
  });

  it('limit 0 (no AI in plan) refuses without touching the counter', async () => {
    withLimit(0);
    await expect(svc.reserve(WS, 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(counterValue).toBe(0);
  });

  it('unlimited (-1) admits the spend without the locked read-modify-write', async () => {
    withLimit(-1);
    await svc.reserve(WS, 7);
    expect(counterValue).toBe(7);
    expect(prisma.$transaction).not.toHaveBeenCalled(); // bump() path, no lock
  });

  it('cost <= 0 is a no-op (never consults entitlements)', async () => {
    await svc.reserve(WS, 0);
    expect(entitlements.getEffective).not.toHaveBeenCalled();
    expect(counterValue).toBe(0);
  });

  it('refund returns credits to the pool', async () => {
    withLimit(100);
    await svc.reserve(WS, 5);
    await svc.refund(WS, 2);
    expect(counterValue).toBe(3);
  });

  it('usage reports limit/used/remaining off the current period meter', async () => {
    withLimit(100);
    counterValue = 30;
    const u = await svc.usage(WS);
    expect(u).toEqual({ limit: 100, used: 30, remaining: 70 });
  });

  it('usage reports remaining -1 on an unlimited plan', async () => {
    withLimit(-1);
    counterValue = 999;
    const u = await svc.usage(WS);
    expect(u).toEqual({ limit: -1, used: 999, remaining: -1 });
  });

  it('meters under the canonical ai.credits metric name', () => {
    expect(AI_CREDITS_METRIC).toBe('ai.credits');
  });
});
