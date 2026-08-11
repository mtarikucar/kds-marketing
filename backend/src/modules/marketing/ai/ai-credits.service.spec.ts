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
    prisma = {
      usageCounter: {
        findUnique: jest.fn().mockImplementation(async () => ({ value: counter })),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          if (args.update?.value?.increment !== undefined) counter += args.update.value.increment;
          else if (args.create?.value !== undefined && counter === 0) counter = args.create.value;
          return { value: counter };
        }),
        update: jest.fn().mockImplementation(async (args: any) => {
          if (args.data?.value !== undefined) counter = args.data.value;
          return { value: counter };
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
