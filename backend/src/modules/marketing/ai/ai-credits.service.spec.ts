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
  let wallet: { balance: jest.Mock; debitUpTo: jest.Mock; credit: jest.Mock };
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
        update: jest.fn().mockImplementation(async (args: any) => {
          if (args.data?.value !== undefined) counterValue = args.data.value;
          return { value: counterValue };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    entitlements = { getEffective: jest.fn() };
    // Prepaid credits are the release valve once the monthly allowance is
    // gone. Empty by default so these tests still assert the CAP behaviour;
    // the wallet's own interaction is covered in the block at the bottom.
    wallet = {
      balance: jest.fn().mockResolvedValue(0),
      debitUpTo: jest.fn().mockResolvedValue(0),
      credit: jest.fn().mockResolvedValue(0),
    };
    svc = new AiCreditsService(prisma as any, entitlements as any, wallet as any);
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

  it('never drives the meter negative — an over-refund floors at 0', async () => {
    withLimit(100);
    await svc.reserve(WS, 2); // 2
    await svc.refund(WS, 5); // floors to 0, not -3
    expect(counterValue).toBe(0);
  });

  it('usage reports limit/used/remaining off the current period meter', async () => {
    withLimit(100);
    counterValue = 30;
    const u = await svc.usage(WS);
    // walletBalance rides along: a gauge that ignores prepaid credit tells a
    // topped-up workspace it has nothing left.
    expect(u).toEqual({ limit: 100, used: 30, remaining: 70, walletBalance: 0 });
  });

  it('usage reports remaining -1 on an unlimited plan', async () => {
    withLimit(-1);
    counterValue = 999;
    const u = await svc.usage(WS);
    expect(u).toEqual({ limit: -1, used: 999, remaining: -1, walletBalance: 0 });
  });

  it('meters under the canonical ai.credits metric name', () => {
    expect(AI_CREDITS_METRIC).toBe('ai.credits');
  });
});

/**
 * Prepaid credits are what makes "modest included credits + top up" a real
 * model rather than a wall. The old ai_credit_boost_500 add-on raised the
 * monthly CEILING for one period, so credits a customer paid for evaporated at
 * period end; a wallet balance persists until it is spent.
 */
describe('AiCreditsService — prepaid credits', () => {
  const WS2 = 'ws-wallet';
  let counter: number;
  let prisma: any;
  let entitlements: any;
  let wallet: any;
  let svc: AiCreditsService;

  beforeEach(() => {
    counter = 0;
    // Metric-aware: reserve() writes BOTH the total meter and the
    // wallet-funded meter, so a single shared variable would conflate them.
    const meters: Record<string, number> = {};
    const metricOf = (args: any) => args.where.workspaceId_metric_periodKey.metric;
    prisma = {
      usageCounter: {
        findUnique: jest.fn().mockImplementation(async (args: any) => {
          const m = metricOf(args);
          if (m === AI_CREDITS_METRIC) return { value: counter };
          return meters[m] === undefined ? null : { value: meters[m] };
        }),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          const m = metricOf(args);
          const inc = args.update?.value?.increment;
          if (m === AI_CREDITS_METRIC) {
            if (inc !== undefined) counter += inc;
            else if (args.create?.value !== undefined && counter === 0) counter = args.create.value;
            return { value: counter };
          }
          meters[m] = inc !== undefined ? (meters[m] ?? 0) + inc : args.create.value;
          return { value: meters[m] };
        }),
        update: jest.fn().mockImplementation(async (args: any) => {
          const m = metricOf(args);
          const dec = args.data?.value?.decrement;
          if (m === AI_CREDITS_METRIC) {
            if (args.data?.value !== undefined && dec === undefined) counter = args.data.value;
            return { value: counter };
          }
          if (dec !== undefined) meters[m] = (meters[m] ?? 0) - dec;
          else if (args.data?.value !== undefined) meters[m] = args.data.value;
          return { value: meters[m] };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    entitlements = { getEffective: jest.fn().mockResolvedValue({ limits: { aiCreditsMonthly: 10 } }) };
    wallet = {
      balance: jest.fn().mockResolvedValue(0),
      debitUpTo: jest.fn(),
      credit: jest.fn().mockResolvedValue(0),
    };
    svc = new AiCreditsService(prisma as any, entitlements as any, wallet as any);
  });

  it('takes ONLY the shortfall from the wallet, not the whole charge', async () => {
    await svc.reserve(WS2, 8); // allowance covers it entirely
    expect(wallet.debitUpTo).not.toHaveBeenCalled();

    wallet.debitUpTo.mockResolvedValue(4);
    await svc.reserve(WS2, 6); // 2 left in the allowance → 4 short

    // Nobody should burn credits they PAID for while free ones sit unused.
    expect(wallet.debitUpTo).toHaveBeenCalledTimes(1);
    expect(wallet.debitUpTo.mock.calls[0][1]).toMatchObject({ amount: 4, kind: 'SPEND' });
    // The counter tracks TOTAL consumed, so everything above the limit is the
    // paid part — that is what makes the refund split derivable.
    expect(counter).toBe(14);
  });

  it('passes the ambient transaction so the debit cannot outlive a failed reserve', async () => {
    wallet.debitUpTo.mockResolvedValue(5);
    await svc.reserve(WS2, 15);
    // Third arg is the tx client. Without it the wallet would open its own
    // transaction and a committed debit could survive an aborted reserve —
    // silently destroying credit the customer paid for.
    expect(wallet.debitUpTo.mock.calls[0][2]).toBe(prisma);
  });

  it('refuses — and keeps the meter untouched — when the wallet cannot cover the shortfall', async () => {
    wallet.debitUpTo.mockResolvedValue(1); // only 1 available, 5 needed
    await expect(svc.reserve(WS2, 15)).rejects.toBeInstanceOf(ForbiddenException);
    expect(counter).toBe(0);
    // No compensating credit: throwing rolls the transaction back, and issuing
    // one here would hand the credits back twice.
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('refunds the PAID portion back to the wallet, not the whole cost', async () => {
    wallet.debitUpTo.mockResolvedValue(5);
    await svc.reserve(WS2, 15); // 10 from the allowance, 5 from the wallet
    expect(counter).toBe(15);

    await svc.refund(WS2, 15);

    expect(counter).toBe(0);
    expect(wallet.credit).toHaveBeenCalledTimes(1);
    expect(wallet.credit.mock.calls[0][1]).toMatchObject({ amount: 5, kind: 'REFUND' });
  });

  it('refunds nothing to the wallet when the charge never reached it', async () => {
    await svc.reserve(WS2, 6);
    await svc.refund(WS2, 6);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('surfaces the balance in usage(), so the gauge is not a lie after a top-up', async () => {
    wallet.balance.mockResolvedValue(2500);
    counter = 4;
    expect(await svc.usage(WS2)).toEqual({
      limit: 10,
      used: 4,
      remaining: 6,
      walletBalance: 2500,
    });
  });
});

/**
 * chargeOverage() bumps the counter past the monthly limit WITHOUT taking
 * anything from the wallet — deliberately, since the work was already
 * delivered. That breaks the "everything above the limit came from the wallet"
 * shortcut, so a later refund from any OTHER action in the same month would
 * read the inflated counter and credit the wallet for credits it never gave up.
 * Free credits, minted out of nothing.
 */
describe('AiCreditsService — refund cannot mint credits after an overage', () => {
  const WS3 = 'ws-overage';
  let counters: Record<string, number>;
  let prisma: any;
  let entitlements: any;
  let wallet: any;
  let svc: AiCreditsService;

  const key = (metric: string) => metric;

  beforeEach(() => {
    counters = {};
    prisma = {
      usageCounter: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          const m = where.workspaceId_metric_periodKey.metric;
          return counters[key(m)] === undefined ? null : { value: counters[key(m)] };
        }),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          const m = args.where.workspaceId_metric_periodKey.metric;
          const cur = counters[key(m)] ?? 0;
          if (args.update?.value?.increment !== undefined) counters[key(m)] = cur + args.update.value.increment;
          else counters[key(m)] = args.create.value;
          return { value: counters[key(m)] };
        }),
        update: jest.fn().mockImplementation(async (args: any) => {
          const m = args.where.workspaceId_metric_periodKey.metric;
          if (args.data?.value?.decrement !== undefined) {
            counters[key(m)] = (counters[key(m)] ?? 0) - args.data.value.decrement;
          } else if (args.data?.value !== undefined) {
            counters[key(m)] = args.data.value;
          }
          return { value: counters[key(m)] };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    entitlements = { getEffective: jest.fn().mockResolvedValue({ limits: { aiCreditsMonthly: 100 } }) };
    wallet = {
      balance: jest.fn().mockResolvedValue(0),
      debitUpTo: jest.fn().mockResolvedValue(0),
      credit: jest.fn().mockResolvedValue(0),
    };
    svc = new AiCreditsService(prisma as any, entitlements as any, wallet as any);
  });

  it('refunds NOTHING to the wallet when the over-limit usage came from an overage', async () => {
    await svc.reserve(WS3, 100); // allowance fully consumed, wallet untouched
    await svc.chargeOverage(WS3, 50); // counter 150, still nothing from the wallet

    await svc.refund(WS3, 50);

    // The derivation alone would have said "50 came from the wallet".
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('still refunds exactly what the wallet did fund', async () => {
    wallet.debitUpTo.mockResolvedValue(20);
    await svc.reserve(WS3, 120); // 100 allowance + 20 wallet
    await svc.chargeOverage(WS3, 30); // counter 150; wallet-funded total stays 20

    await svc.refund(WS3, 50);

    // Capped at the 20 the wallet actually gave up, not the 50 the counter drop
    // would suggest.
    expect(wallet.credit).toHaveBeenCalledTimes(1);
    expect(wallet.credit.mock.calls[0][1]).toMatchObject({ amount: 20, kind: 'REFUND' });
  });

  it('does not refund the same wallet credits twice across two refunds', async () => {
    wallet.debitUpTo.mockResolvedValue(20);
    await svc.reserve(WS3, 120);

    await svc.refund(WS3, 20);
    await svc.refund(WS3, 20);

    const total = wallet.credit.mock.calls.reduce((n: number, c: any) => n + c[1].amount, 0);
    expect(total).toBe(20);
  });
});
