import { Prisma } from '@prisma/client';
import { GrowthWalletService, InsufficientGrowthCreditError } from './growth-wallet.service';

const D = (n: string | number) => new Prisma.Decimal(n);

/**
 * In-memory prisma mock mirroring the real semantics the service relies on:
 * upsert-by-workspaceId, conditional updateMany (balance >= amount), and a
 * UNIQUE constraint on ledger `ref` (throws code P2002 on violation).
 */
function makePrisma() {
  const wallets = new Map<string, any>();
  const entries: any[] = [];
  let seq = 0;

  const tx = {
    growthWallet: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = wallets.get(where.workspaceId);
        if (existing) return { ...existing };
        const row = {
          id: `w-${++seq}`,
          workspaceId: where.workspaceId,
          balance: D(0),
          currency: create.currency ?? 'TRY',
        };
        wallets.set(where.workspaceId, row);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = [...wallets.values()].find(
          (w) =>
            w.id === where.id &&
            w.workspaceId === where.workspaceId &&
            (where.balance?.gte === undefined || w.balance.gte(D(where.balance.gte))),
        );
        if (!row) return { count: 0 };
        row.balance = row.balance.add(D(data.balance.increment));
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = [...wallets.values()].find((w) => w.id === where.id);
        row.balance = row.balance.add(D(data.balance.increment));
        return { ...row };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = where.workspaceId
          ? wallets.get(where.workspaceId)
          : [...wallets.values()].find((w) => w.id === where.id);
        return row ? { ...row } : null;
      }),
    },
    growthWalletLedgerEntry: {
      findUnique: jest.fn(async ({ where }: any) =>
        entries.find((e) => e.ref === where.ref) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        if (data.ref != null && entries.some((e) => e.ref === data.ref)) {
          const err: any = new Error('Unique constraint failed on ref');
          err.code = 'P2002';
          throw err;
        }
        const row = { ...data, id: `e-${++seq}` };
        entries.push(row);
        return { ...row };
      }),
    },
  };

  const prisma = {
    // Emulate rollback: snapshot state, run cb, restore on throw.
    $transaction: jest.fn(async (cb: any) => {
      const walletSnap = new Map([...wallets.entries()].map(([k, v]) => [k, { ...v, balance: v.balance }]));
      const entriesSnap = entries.slice();
      try {
        return await cb(tx);
      } catch (e) {
        wallets.clear();
        for (const [k, v] of walletSnap) wallets.set(k, v);
        entries.length = 0;
        entries.push(...entriesSnap);
        throw e;
      }
    }),
    growthWallet: { findUnique: tx.growthWallet.findUnique },
    growthWalletLedgerEntry: { findUnique: tx.growthWalletLedgerEntry.findUnique },
  } as any;

  return { prisma, tx, wallets, entries };
}

describe('GrowthWalletService', () => {
  it('credits a top-up, creating the wallet on first use with a TOPUP ledger entry', async () => {
    const { prisma, entries } = makePrisma();
    const svc = new GrowthWalletService(prisma);

    const r = await svc.credit('ws1', { amount: 500, kind: 'TOPUP', ref: 'order:o1', currency: 'USD' });

    expect(r.replayed).toBe(false);
    expect(r.wallet.balance.toString()).toBe('500');
    expect(r.wallet.currency).toBe('USD');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspaceId: 'ws1', kind: 'TOPUP', ref: 'order:o1' });
    expect(entries[0].delta.toString()).toBe('500');
    expect(entries[0].balanceAfter.toString()).toBe('500');
  });

  it('is idempotent on ref: a replayed top-up credits exactly once', async () => {
    const { prisma, entries } = makePrisma();
    const svc = new GrowthWalletService(prisma);

    await svc.credit('ws1', { amount: 500, kind: 'TOPUP', ref: 'order:o1' });
    const replay = await svc.credit('ws1', { amount: 500, kind: 'TOPUP', ref: 'order:o1' });

    expect(replay.replayed).toBe(true);
    expect(replay.wallet.balance.toString()).toBe('500');
    expect(entries).toHaveLength(1);
  });

  it('debits when the balance covers it and appends the ledger entry', async () => {
    const { prisma, entries } = makePrisma();
    const svc = new GrowthWalletService(prisma);
    await svc.credit('ws1', { amount: 100, kind: 'TOPUP' });

    const r = await svc.debit('ws1', { amount: 30.5, kind: 'ENGINE_SPEND', ref: 'spend:s1' });

    expect(r.wallet.balance.toString()).toBe('69.5');
    const debitRow = entries.find((e) => e.ref === 'spend:s1');
    expect(debitRow.delta.toString()).toBe('-30.5');
    expect(debitRow.balanceAfter.toString()).toBe('69.5');
    expect(debitRow.kind).toBe('ENGINE_SPEND');
  });

  it('fails CLOSED on insufficient balance: throws, no ledger entry, balance unchanged', async () => {
    const { prisma, entries, wallets } = makePrisma();
    const svc = new GrowthWalletService(prisma);
    await svc.credit('ws1', { amount: 10, kind: 'TOPUP' });

    await expect(svc.debit('ws1', { amount: 10.01, kind: 'ENGINE_SPEND' })).rejects.toBeInstanceOf(
      InsufficientGrowthCreditError,
    );
    expect(wallets.get('ws1').balance.toString()).toBe('10');
    expect(entries).toHaveLength(1); // only the top-up
  });

  it('fails CLOSED when no wallet exists at all (debit against zero shell)', async () => {
    const { prisma } = makePrisma();
    const svc = new GrowthWalletService(prisma);
    await expect(svc.debit('ws1', { amount: 1, kind: 'ENGINE_SPEND' })).rejects.toBeInstanceOf(
      InsufficientGrowthCreditError,
    );
  });

  it('treats a concurrent same-ref debit race (P2002 on ledger insert) as a replay and rolls back the double debit', async () => {
    const { prisma, entries, wallets } = makePrisma();
    const svc = new GrowthWalletService(prisma);
    await svc.credit('ws1', { amount: 100, kind: 'TOPUP' });

    // First debit lands normally.
    await svc.debit('ws1', { amount: 40, kind: 'AD_GOVERNOR', ref: 'admetric:c1:2026-07-05' });
    // "Concurrent" second debit with the same ref: the pre-check is bypassed by
    // deleting findUnique's view — simulate by calling the raw path again; the
    // unique index fires and the service must resolve it as a replay.
    const spyFind = prisma.growthWalletLedgerEntry.findUnique as jest.Mock;
    spyFind.mockResolvedValueOnce(null); // outer pre-check misses (race window)
    const r = await svc.debit('ws1', { amount: 40, kind: 'AD_GOVERNOR', ref: 'admetric:c1:2026-07-05' });

    expect(r.replayed).toBe(true);
    expect(wallets.get('ws1').balance.toString()).toBe('60'); // debited ONCE
    expect(entries.filter((e) => e.ref === 'admetric:c1:2026-07-05')).toHaveLength(1);
  });

  it('rejects non-positive amounts', async () => {
    const { prisma } = makePrisma();
    const svc = new GrowthWalletService(prisma);
    await expect(svc.credit('ws1', { amount: 0, kind: 'TOPUP' })).rejects.toThrow();
    await expect(svc.debit('ws1', { amount: -5, kind: 'ENGINE_SPEND' })).rejects.toThrow();
  });

  it('get() returns a zero-balance shell when the workspace has no wallet yet', async () => {
    const { prisma } = makePrisma();
    const svc = new GrowthWalletService(prisma);
    const w = await svc.get('ws-none');
    expect(w.balance.toString()).toBe('0');
    expect(w.exists).toBe(false);
  });

  it('balance() is workspace-scoped', async () => {
    const { prisma } = makePrisma();
    const svc = new GrowthWalletService(prisma);
    await svc.credit('ws1', { amount: 500, kind: 'TOPUP' });
    expect((await svc.balance('ws1')).toString()).toBe('500');
    expect((await svc.balance('ws2')).toString()).toBe('0');
  });

  describe('debitUpTo (clamped governor debit — never throws on shortfall)', () => {
    it('debits the full amount when the balance covers it', async () => {
      const { prisma, entries } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 100, kind: 'TOPUP' });

      const r = await svc.debitUpTo('ws1', { amount: 40, kind: 'AD_GOVERNOR', ref: 'adgov:c1:2026-07-05' });

      expect(r.replayed).toBe(false);
      expect(r.debited.toString()).toBe('40');
      expect(r.shortfall.toString()).toBe('0');
      expect(r.wallet.balance.toString()).toBe('60');
      const row = entries.find((e) => e.ref === 'adgov:c1:2026-07-05');
      expect(row.delta.toString()).toBe('-40');
      expect(row.kind).toBe('AD_GOVERNOR');
    });

    it('clamps to the remaining balance and records a shortfall note instead of throwing', async () => {
      const { prisma, entries } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 25, kind: 'TOPUP' });

      const r = await svc.debitUpTo('ws1', { amount: 40, kind: 'AD_GOVERNOR', ref: 'adgov:c1:2026-07-06' });

      expect(r.debited.toString()).toBe('25');
      expect(r.shortfall.toString()).toBe('15');
      expect(r.wallet.balance.toString()).toBe('0');
      const row = entries.find((e) => e.ref === 'adgov:c1:2026-07-06');
      expect(row.delta.toString()).toBe('-25');
      expect(row.note).toContain('shortfall');
    });

    it('records a 0-delta entry with the ref at zero balance (keeps replays idempotent)', async () => {
      const { prisma, entries } = makePrisma();
      const svc = new GrowthWalletService(prisma);

      const r = await svc.debitUpTo('ws1', { amount: 10, kind: 'AD_GOVERNOR', ref: 'adgov:c1:2026-07-07' });

      expect(r.debited.toString()).toBe('0');
      expect(r.shortfall.toString()).toBe('10');
      expect(r.wallet.balance.toString()).toBe('0');
      const row = entries.find((e) => e.ref === 'adgov:c1:2026-07-07');
      expect(row).toBeDefined();
      expect(row.delta.toString()).toBe('0');
    });

    it('is idempotent by ref: a replay moves nothing (even after a top-up)', async () => {
      const { prisma, entries } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 30, kind: 'TOPUP' });
      await svc.debitUpTo('ws1', { amount: 50, kind: 'AD_GOVERNOR', ref: 'adgov:c1:2026-07-08' }); // clamps to 30
      await svc.credit('ws1', { amount: 100, kind: 'TOPUP', ref: 'order:o2' });

      const replay = await svc.debitUpTo('ws1', { amount: 50, kind: 'AD_GOVERNOR', ref: 'adgov:c1:2026-07-08' });

      expect(replay.replayed).toBe(true);
      expect(replay.debited.toString()).toBe('30'); // what the original movement debited
      expect(replay.wallet.balance.toString()).toBe('100'); // untouched by the replay
      expect(entries.filter((e) => e.ref === 'adgov:c1:2026-07-08')).toHaveLength(1);
    });

    it('resolves a concurrent same-ref race (P2002) as a replay with the wallet debited once', async () => {
      const { prisma, entries, wallets } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 100, kind: 'TOPUP' });
      await svc.debitUpTo('ws1', { amount: 40, kind: 'AD_GOVERNOR', ref: 'adgov:r:2026-07-05' });

      const spyFind = prisma.growthWalletLedgerEntry.findUnique as jest.Mock;
      spyFind.mockResolvedValueOnce(null); // pre-check misses (race window)
      const r = await svc.debitUpTo('ws1', { amount: 40, kind: 'AD_GOVERNOR', ref: 'adgov:r:2026-07-05' });

      expect(r.replayed).toBe(true);
      expect(wallets.get('ws1').balance.toString()).toBe('60'); // debited ONCE
      expect(entries.filter((e) => e.ref === 'adgov:r:2026-07-05')).toHaveLength(1);
    });

    it('rejects non-positive amounts', async () => {
      const { prisma } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await expect(svc.debitUpTo('ws1', { amount: 0, kind: 'AD_GOVERNOR' })).rejects.toThrow();
      await expect(svc.debitUpTo('ws1', { amount: -3, kind: 'AD_GOVERNOR' })).rejects.toThrow();
    });
  });

  // Audit A2: the wallet has NO FX — a movement in a different currency than
  // the wallet's must be rejected, never credited/debited at face value (a
  // "TRY" top-up landing on a USD wallet would mint ~33x spendable value).
  describe('currency mismatch guard (no-FX invariant)', () => {
    it('rejects a credit whose currency differs from the existing wallet currency — nothing moves', async () => {
      const { prisma, wallets, entries } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 100, kind: 'TOPUP', currency: 'USD' });

      await expect(
        svc.credit('ws1', { amount: 500, kind: 'TOPUP', ref: 'order:o2', currency: 'TRY' }),
      ).rejects.toThrow(/currency/i);
      expect(wallets.get('ws1').balance.toString()).toBe('100');
      expect(entries.filter((e) => e.ref === 'order:o2')).toHaveLength(0);
    });

    it('rejects a debit whose currency differs from the wallet currency', async () => {
      const { prisma, wallets } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 100, kind: 'TOPUP', currency: 'USD' });

      await expect(
        svc.debit('ws1', { amount: 10, kind: 'ENGINE_SPEND', currency: 'TRY' }),
      ).rejects.toThrow(/currency/i);
      expect(wallets.get('ws1').balance.toString()).toBe('100');
    });

    it('rejects a mismatched debitUpTo (governor) the same way', async () => {
      const { prisma, wallets } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 100, kind: 'TOPUP', currency: 'USD' });

      await expect(
        svc.debitUpTo('ws1', { amount: 10, kind: 'AD_GOVERNOR', currency: 'TRY' }),
      ).rejects.toThrow(/currency/i);
      expect(wallets.get('ws1').balance.toString()).toBe('100');
    });

    it('accepts a matching currency and a movement that omits currency entirely', async () => {
      const { prisma, wallets } = makePrisma();
      const svc = new GrowthWalletService(prisma);
      await svc.credit('ws1', { amount: 100, kind: 'TOPUP', currency: 'USD' });

      await svc.credit('ws1', { amount: 50, kind: 'TOPUP', currency: 'USD' });
      await svc.credit('ws1', { amount: 25, kind: 'REFUND' }); // currency omitted → wallet's own
      expect(wallets.get('ws1').balance.toString()).toBe('175');
    });
  });
});
