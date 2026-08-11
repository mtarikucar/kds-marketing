import { BadRequestException } from '@nestjs/common';
import { AiCreditWalletService } from './ai-credit-wallet.service';

const WS = 'ws-1';

/**
 * The wallet holds credits a customer PAID for, so the properties that matter
 * are the money ones: a replayed webhook must credit once, a debit must never
 * drive the balance negative, and a caller that already holds a transaction
 * must be able to make the movement atomic with its own work.
 */
function makeDeps(startingBalance = 0) {
  const state = { balance: startingBalance };
  const entries: any[] = [];

  const client: any = {
    aiCreditWallet: {
      findUnique: jest.fn().mockImplementation(async () => ({ id: 'w1', balance: state.balance })),
      upsert: jest.fn().mockImplementation(async () => ({ id: 'w1', workspaceId: WS, balance: state.balance })),
      update: jest.fn().mockImplementation(async ({ data }: any) => {
        if (data.balance?.increment !== undefined) state.balance += data.balance.increment;
        if (data.balance?.decrement !== undefined) state.balance -= data.balance.decrement;
        return { id: 'w1', balance: state.balance };
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const min = where?.balance?.gte ?? 0;
        if (state.balance < min) return { count: 0 };
        state.balance -= data.balance.decrement;
        return { count: 1 };
      }),
    },
    aiCreditLedgerEntry: {
      findUnique: jest
        .fn()
        .mockImplementation(async ({ where }: any) => entries.find((e) => e.ref === where.ref) ?? null),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        entries.push(data);
        return data;
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  client.$transaction = jest.fn(async (fn: any) => fn(client));

  return { svc: new AiCreditWalletService(client as any), client, state, entries };
}

describe('AiCreditWalletService', () => {
  it('credits the balance and writes a ledger entry', async () => {
    const { svc, state, entries } = makeDeps(0);
    expect(await svc.credit(WS, { amount: 1000, kind: 'TOPUP', ref: 'order:o1' })).toBe(1000);
    expect(state.balance).toBe(1000);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ delta: 1000, balanceAfter: 1000, kind: 'TOPUP', ref: 'order:o1' });
  });

  it('is idempotent on ref — a replayed settlement webhook credits ONCE', async () => {
    const { svc, state, entries } = makeDeps(0);
    await svc.credit(WS, { amount: 1000, kind: 'TOPUP', ref: 'order:o1' });
    await svc.credit(WS, { amount: 1000, kind: 'TOPUP', ref: 'order:o1' });
    expect(state.balance).toBe(1000);
    expect(entries).toHaveLength(1);
  });

  it('rejects a non-positive or fractional-to-zero amount', async () => {
    const { svc } = makeDeps(0);
    await expect(svc.credit(WS, { amount: 0, kind: 'TOPUP' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.debitUpTo(WS, { amount: -5, kind: 'SPEND' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('debits what it can and reports the amount taken', async () => {
    const { svc, state } = makeDeps(300);
    expect(await svc.debitUpTo(WS, { amount: 120, kind: 'SPEND' })).toBe(120);
    expect(state.balance).toBe(180);
  });

  it('takes only what exists rather than going negative', async () => {
    const { svc, state } = makeDeps(50);
    expect(await svc.debitUpTo(WS, { amount: 120, kind: 'SPEND' })).toBe(50);
    expect(state.balance).toBe(0);
  });

  it('takes nothing when a concurrent spend beat it to the balance', async () => {
    const { svc, client, state } = makeDeps(100);
    // The conditional updateMany is the arbiter: it matches nothing once the
    // balance has moved below what this caller intended to take.
    client.aiCreditWallet.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await svc.debitUpTo(WS, { amount: 100, kind: 'SPEND' })).toBe(0);
    expect(state.balance).toBe(100);
  });

  it('joins an ambient transaction instead of opening its own', async () => {
    const { svc, client } = makeDeps(500);
    const tx: any = { ...client };
    tx.$transaction = jest.fn();

    await svc.debitUpTo(WS, { amount: 10, kind: 'SPEND' }, tx);

    // The caller's transaction is what commits this. Opening a second one would
    // let a debit survive an aborted caller — destroying paid-for credit.
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(tx.$transaction).not.toHaveBeenCalled();
  });

  /**
   * run() writes TWO unique columns: the ledger `ref` and, via upsert, the
   * workspace-unique wallet row. A blanket "P2002 means already applied" catch
   * turns a lost race on the WALLET row into a silent success — the settlement
   * stamps the order granted and the credits the customer paid for are gone.
   */
  it('rethrows a P2002 that is NOT the ledger ref, so a paid top-up is never lost', async () => {
    const { svc, client } = makeDeps(0);
    const err: any = new Error('Unique constraint failed');
    err.code = 'P2002';
    err.meta = { target: ['workspaceId'] }; // ai_credit_wallets_workspaceId_key
    client.aiCreditWallet.upsert.mockRejectedValueOnce(err);

    await expect(
      svc.credit(WS, { amount: 4000, kind: 'TOPUP', ref: 'order:o9' }),
    ).rejects.toThrow('Unique constraint failed');
  });

  it('still treats a genuine ref conflict as already-applied', async () => {
    const { svc, client } = makeDeps(0);
    const err: any = new Error('Unique constraint failed');
    err.code = 'P2002';
    err.meta = { target: ['ref'] };
    client.aiCreditLedgerEntry.create.mockRejectedValueOnce(err);

    await expect(svc.credit(WS, { amount: 1000, kind: 'TOPUP', ref: 'order:o1' })).resolves.toBeDefined();
  });

  it('a non-ref P2002 on debit surfaces instead of reporting "took nothing"', async () => {
    const { svc, client } = makeDeps(500);
    const err: any = new Error('Unique constraint failed');
    err.code = 'P2002';
    err.meta = { target: ['workspaceId'] };
    client.aiCreditWallet.upsert.mockRejectedValueOnce(err);

    // Returning 0 here would make reserve() tell a workspace WITH credits that
    // it is out of them.
    await expect(svc.debitUpTo(WS, { amount: 10, kind: 'SPEND', ref: 'x' })).rejects.toThrow();
  });

  it('reports 0 for a workspace that has never topped up', async () => {
    const { svc, client } = makeDeps(0);
    client.aiCreditWallet.findUnique.mockResolvedValueOnce(null);
    expect(await svc.balance(WS)).toBe(0);
  });
});
