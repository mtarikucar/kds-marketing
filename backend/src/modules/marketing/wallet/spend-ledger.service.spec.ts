import { Prisma } from '@prisma/client';
import { SpendLedgerService } from './spend-ledger.service';

const D = (n: string | number) => new Prisma.Decimal(n);

/** In-memory ledger prisma mock: keeps rows and serves the latest balance. */
function makePrisma() {
  const rows: any[] = [];
  let seq = 0;
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
    spendLedger: {
      findFirst: jest.fn(async ({ where }: any) => {
        const match = rows
          .filter(
            (r) =>
              r.workspaceId === where.workspaceId &&
              r.budgetId === where.budgetId &&
              (where.ref === undefined || r.ref === where.ref),
          )
          .sort((a, b) => b._seq - a._seq)[0];
        return match ? { id: match.id, balanceAfter: match.balanceAfter } : null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const refMatch = (r: any) => {
          if (!where.OR) return true;
          return where.OR.some((cond: any) =>
            typeof cond.ref === 'object' && cond.ref?.startsWith !== undefined
              ? typeof r.ref === 'string' && r.ref.startsWith(cond.ref.startsWith)
              : r.ref === cond.ref,
          );
        };
        return rows
          .filter((r) => r.workspaceId === where.workspaceId && r.budgetId === where.budgetId && refMatch(r))
          .map((r) => ({ delta: r.delta }));
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: `row-${++seq}`, _seq: seq };
        rows.push(row);
        return { id: row.id, balanceAfter: row.balanceAfter };
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    spendLedger: {
      findFirst: tx.spendLedger.findFirst,
    },
  } as any;
  return { prisma, tx, rows };
}

describe('SpendLedgerService', () => {
  it('debits as a negative delta and accumulates balanceAfter', async () => {
    const { prisma, tx } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    const r1 = await svc.debit('ws1', { channel: 'SMS', amount: 0.9, reason: 'SMS', ref: 'msg-1' });
    expect(r1.balanceAfter.toString()).toBe('-0.9');
    const r2 = await svc.debit('ws1', { channel: 'VOICE', amount: 1.1, reason: 'VOICE' });
    expect(r2.balanceAfter.toString()).toBe('-2');
    // advisory lock taken each time
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('credits (refund) as a positive delta', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    await svc.debit('ws1', { channel: 'SMS', amount: 5, reason: 'SMS' });
    const r = await svc.credit('ws1', { channel: 'SMS', amount: 2, reason: 'REFUND' });
    expect(r.balanceAfter.toString()).toBe('-3');
  });

  it('normalizes a negative input amount to a spend (abs then sign)', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    const r = await svc.debit('ws1', { channel: 'CONTENT', amount: -4, reason: 'CONTENT_GEN' });
    expect(r.balanceAfter.toString()).toBe('-4');
  });

  it('partitions balance by budgetId', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    await svc.debit('ws1', { channel: 'META', amount: 100, reason: 'AD_WRITE', budgetId: 'b1' });
    await svc.debit('ws1', { channel: 'META', amount: 10, reason: 'AD_WRITE' }); // budget null
    expect((await svc.netSpent('ws1', 'b1')).toString()).toBe('100');
    expect((await svc.netSpent('ws1')).toString()).toBe('10');
  });

  it('netSpent returns 0 for an untouched partition', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    expect((await svc.netSpent('ws-empty')).toString()).toBe('0');
  });

  describe('debitOnce (ref-deduped debit for mirrored ad spend)', () => {
    it('records the first debit and replays the same ref without double-recording', async () => {
      const { prisma, rows, tx } = makePrisma();
      const svc = new SpendLedgerService(prisma);

      const first = await svc.debitOnce('ws1', {
        channel: 'META', amount: 120, reason: 'AD_SPEND', ref: 'admetric:c1:2026-07-04', budgetId: 'b1',
      });
      expect(first.replayed).toBe(false);
      expect(first.balanceAfter.toString()).toBe('-120');

      const replay = await svc.debitOnce('ws1', {
        channel: 'META', amount: 120, reason: 'AD_SPEND', ref: 'admetric:c1:2026-07-04', budgetId: 'b1',
      });
      expect(replay.replayed).toBe(true);
      expect(replay.id).toBe(first.id);
      expect(replay.balanceAfter.toString()).toBe('-120'); // nothing moved twice
      expect(rows.filter((r) => r.ref === 'admetric:c1:2026-07-04')).toHaveLength(1);
      // dedup happens INSIDE the advisory-locked txn (lock taken both times)
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    });

    it('requires a ref', async () => {
      const { prisma } = makePrisma();
      const svc = new SpendLedgerService(prisma);
      await expect(
        svc.debitOnce('ws1', { channel: 'META', amount: 10, reason: 'AD_SPEND' }),
      ).rejects.toThrow(/ref/);
    });

    it('dedups within the (workspace, budget) partition only', async () => {
      const { prisma, rows } = makePrisma();
      const svc = new SpendLedgerService(prisma);
      await svc.debitOnce('ws1', { channel: 'META', amount: 10, reason: 'AD_SPEND', ref: 'r1', budgetId: 'b1' });
      // Same ref, different budget partition and different workspace: both record.
      const other = await svc.debitOnce('ws1', { channel: 'META', amount: 10, reason: 'AD_SPEND', ref: 'r1', budgetId: 'b2' });
      const otherWs = await svc.debitOnce('ws2', { channel: 'META', amount: 10, reason: 'AD_SPEND', ref: 'r1', budgetId: 'b1' });
      expect(other.replayed).toBe(false);
      expect(otherWs.replayed).toBe(false);
      expect(rows.filter((r) => r.ref === 'r1')).toHaveLength(3);
    });
  });

  // Audit B3: AdMetric.spend is one GROWING day-cumulative row (overwritten by
  // every hourly pull), but the old day-keyed debitOnce was first-write-wins —
  // it froze the FIRST intraday snapshot and dropped all later accrual.
  // debitToCumulative mirrors a cumulative: each call appends only the delta
  // above what the partition has already mirrored under the ref prefix.
  describe('debitToCumulative (delta-mirroring for a growing day-cumulative)', () => {
    const ENTRY = { channel: 'META' as const, reason: 'AD_SPEND' as const, budgetId: 'b1' };
    const PREFIX = 'admetric:c1:2026-07-04';

    it('first call records the full cumulative; a later higher cumulative appends only the delta', async () => {
      const { prisma, rows } = makePrisma();
      const svc = new SpendLedgerService(prisma);

      const first = await svc.debitToCumulative('ws1', ENTRY, PREFIX, 12);
      expect(first.applied.toString()).toBe('12');
      expect(first.replayed).toBe(false);
      expect(first.balanceAfter.toString()).toBe('-12');

      const second = await svc.debitToCumulative('ws1', ENTRY, PREFIX, 200);
      expect(second.applied.toString()).toBe('188'); // only the accrual
      expect(second.balanceAfter.toString()).toBe('-200');
      expect(rows).toHaveLength(2);
      // Revision refs are unique per cumulative snapshot under the day prefix.
      expect(rows.map((r) => r.ref)).toEqual([`${PREFIX}:c12`, `${PREFIX}:c200`]);
    });

    it('an unchanged cumulative replays: nothing recorded', async () => {
      const { prisma, rows } = makePrisma();
      const svc = new SpendLedgerService(prisma);
      await svc.debitToCumulative('ws1', ENTRY, PREFIX, 40);

      const replay = await svc.debitToCumulative('ws1', ENTRY, PREFIX, 40);
      expect(replay.replayed).toBe(true);
      expect(replay.applied.toString()).toBe('0');
      expect(rows).toHaveLength(1);
    });

    it('a revised-DOWN cumulative never credits back (spend already happened)', async () => {
      const { prisma, rows } = makePrisma();
      const svc = new SpendLedgerService(prisma);
      await svc.debitToCumulative('ws1', ENTRY, PREFIX, 100);

      const down = await svc.debitToCumulative('ws1', ENTRY, PREFIX, 60);
      expect(down.replayed).toBe(true);
      expect(down.applied.toString()).toBe('0');
      expect(rows).toHaveLength(1);
    });

    it('a legacy exact-ref row (old debitOnce, no :c suffix) counts toward the mirrored total', async () => {
      const { prisma, rows } = makePrisma();
      const svc = new SpendLedgerService(prisma);
      // Old-style day entry from before the delta migration:
      await svc.debitOnce('ws1', { ...ENTRY, amount: 30, ref: PREFIX });

      const r = await svc.debitToCumulative('ws1', ENTRY, PREFIX, 50);
      expect(r.applied.toString()).toBe('20'); // 50 − 30 already mirrored
      expect(rows).toHaveLength(2);
    });

    it('scopes the prefix exactly — a sibling scope sharing a name prefix is not counted', async () => {
      const { prisma } = makePrisma();
      const svc = new SpendLedgerService(prisma);
      // camp "c1" vs camp "c10": refs must never cross-match.
      await svc.debitToCumulative('ws1', ENTRY, 'admetric:c10:2026-07-04', 500);

      const r = await svc.debitToCumulative('ws1', ENTRY, 'admetric:c1:2026-07-04', 12);
      expect(r.applied.toString()).toBe('12'); // unaffected by c10's 500
    });
  });
});
