import { Prisma } from '@prisma/client';
import { ConversationSpendService } from './conversation-spend.service';
import { InsufficientGrowthCreditError } from '../wallet/growth-wallet.service';

const D = (n: string | number) => new Prisma.Decimal(n);

function makeDeps(pricedMap: Record<string, any>, opts: { autonomyLevel?: string } = {}) {
  const price = jest.fn(async (_ws: string, _ch: string, unitType: string) => pricedMap[unitType] ?? null);
  const debit = jest.fn().mockResolvedValue({ id: 'led-1', balanceAfter: D(0) });
  const prisma = {
    message: { update: jest.fn().mockResolvedValue({}) },
    voiceCall: { update: jest.fn().mockResolvedValue({}) },
    salesCall: { update: jest.fn().mockResolvedValue({}) },
    growthBudget: {
      findFirst: jest.fn(async () =>
        opts.autonomyLevel ? { autonomyLevel: opts.autonomyLevel } : null),
    },
  } as any;
  const tariffs = { price } as any;
  const ledger = { debit } as any;
  const wallet = {
    debit: jest.fn().mockResolvedValue({ wallet: {}, replayed: false }),
    debitUpTo: jest.fn().mockResolvedValue({ wallet: {}, replayed: false, debited: D(0), shortfall: D(0) }),
    balance: jest.fn().mockResolvedValue(D(0)),
  } as any;
  return { prisma, tariffs, ledger, wallet, price, debit };
}

const FLAG = 'GROWTH_AUTOPILOT_AUTONOMY';

describe('ConversationSpendService', () => {
  it('prices an SMS by segment count, debits the ledger, and stamps the message', async () => {
    const { prisma, tariffs, ledger, wallet, debit } = makeDeps({
      SMS_SEGMENT: { unitCost: D('0.9'), amount: D('1.8'), quantity: D(2), currency: 'TRY', tariffId: 't' },
    });
    const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
    const r = await svc.settleSms('ws1', { messageId: 'm1', text: 'a'.repeat(200) }); // 2 segments
    expect(r?.quantity).toBe(2);
    expect(debit).toHaveBeenCalledWith('ws1', expect.objectContaining({ channel: 'SMS', reason: 'SMS', ref: 'm1', quantity: 2 }));
    const upd = prisma.message.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'm1' });
    expect(upd.data.smsSegments).toBe(2);
    expect(upd.data.costAmount.toString()).toBe('1.8');
  });

  it('prices a WhatsApp template as one unit by category', async () => {
    const { prisma, tariffs, ledger, wallet, price } = makeDeps({
      WA_MARKETING: { unitCost: D('0.36'), amount: D('0.36'), quantity: D(1), currency: 'TRY', tariffId: 't' },
    });
    const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
    const r = await svc.settleWhatsApp('ws1', { messageId: 'm2', category: 'MARKETING' });
    expect(price).toHaveBeenCalledWith('ws1', 'WHATSAPP', 'WA_MARKETING', 1, 'TR');
    expect(r?.amount.toString()).toBe('0.36');
  });

  it('prices a voice call by ceil(minutes) and stamps billableSeconds', async () => {
    const { prisma, tariffs, ledger, wallet, debit } = makeDeps({
      VOICE_MINUTE: { unitCost: D('0.2'), amount: D('0.6'), quantity: D(3), currency: 'TRY', tariffId: 't' },
    });
    const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
    const r = await svc.settleVoice('ws1', { callId: 'c1', durationSec: 125 }); // ceil(125/60)=3
    expect(r?.quantity).toBe(3);
    expect(debit).toHaveBeenCalledWith('ws1', expect.objectContaining({ channel: 'VOICE', quantity: 3, ref: 'c1' }));
    expect(prisma.voiceCall.update.mock.calls[0][0].data.billableSeconds).toBe(125);
  });

  it('routes a salesCall settlement to the sales_calls table', async () => {
    const { prisma, tariffs, ledger, wallet } = makeDeps({
      VOICE_MINUTE: { unitCost: D('0.2'), amount: D('0.2'), quantity: D(1), currency: 'TRY', tariffId: 't' },
    });
    const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
    await svc.settleVoice('ws1', { callId: 'sc1', durationSec: 30, table: 'salesCall' });
    expect(prisma.salesCall.update).toHaveBeenCalled();
    expect(prisma.voiceCall.update).not.toHaveBeenCalled();
  });

  it('returns null and does not debit when no tariff is configured', async () => {
    const { prisma, tariffs, ledger, wallet, debit } = makeDeps({});
    const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
    const r = await svc.settleSms('ws1', { messageId: 'm1', text: 'hi' });
    expect(r).toBeNull();
    expect(debit).not.toHaveBeenCalled();
  });

  it('never throws when the ledger debit fails (best-effort)', async () => {
    const { prisma, tariffs, ledger, wallet, debit } = makeDeps({
      SMS_SEGMENT: { unitCost: D('0.9'), amount: D('0.9'), quantity: D(1), currency: 'TRY', tariffId: 't' },
    });
    debit.mockRejectedValueOnce(new Error('db down'));
    const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
    await expect(svc.settleSms('ws1', { messageId: 'm1', text: 'hi' })).resolves.toBeTruthy();
  });

  describe('engine wallet drawdown (Growth Autopilot D4)', () => {
    const SMS_PRICED = {
      SMS_SEGMENT: { unitCost: D('0.9'), amount: D('1.8'), quantity: D(2), currency: 'TRY', tariffId: 't' },
    };
    let prevFlag: string | undefined;
    beforeEach(() => { prevFlag = process.env[FLAG]; process.env[FLAG] = '1'; });
    afterEach(() => {
      if (prevFlag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prevFlag;
    });

    it('debits the growth wallet (clamped debitUpTo) for SMS settled under an armed AUTONOMOUS budget', async () => {
      const { prisma, tariffs, ledger, wallet, debit } = makeDeps(SMS_PRICED, { autonomyLevel: 'AUTONOMOUS' });
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await svc.settleSms('ws1', { messageId: 'm1', text: 'a'.repeat(200), budgetId: 'b1' });
      // budget partition: the ledger entry must carry the budgetId
      expect(debit).toHaveBeenCalledWith('ws1', expect.objectContaining({ channel: 'SMS', budgetId: 'b1' }));
      expect(wallet.debitUpTo).toHaveBeenCalledTimes(1);
      const [ws, movement] = wallet.debitUpTo.mock.calls[0];
      expect(ws).toBe('ws1');
      expect(movement.kind).toBe('ENGINE_SPEND');
      expect(movement.ref).toBe('engine:SMS:m1');
      expect(movement.amount.toString()).toBe('1.8');
    });

    it('scopes the budget lookup by workspace', async () => {
      const { prisma, tariffs, ledger, wallet } = makeDeps(SMS_PRICED, { autonomyLevel: 'AUTONOMOUS' });
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await svc.settleSms('ws1', { messageId: 'm1', text: 'hi', budgetId: 'b1' });
      expect(prisma.growthBudget.findFirst).toHaveBeenCalledWith({
        where: { id: 'b1', workspaceId: 'ws1' },
        select: { autonomyLevel: true },
      });
    });

    it('forwards the budgetId to the ledger and draws the wallet for WhatsApp', async () => {
      const { prisma, tariffs, ledger, wallet, debit } = makeDeps(
        { WA_MARKETING: { unitCost: D('0.36'), amount: D('0.36'), quantity: D(1), currency: 'TRY', tariffId: 't' } },
        { autonomyLevel: 'AUTONOMOUS' },
      );
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await svc.settleWhatsApp('ws1', { messageId: 'm2', category: 'MARKETING', budgetId: 'b1' });
      expect(debit).toHaveBeenCalledWith('ws1', expect.objectContaining({ channel: 'WHATSAPP', budgetId: 'b1' }));
      expect(wallet.debitUpTo).toHaveBeenCalledWith('ws1', expect.objectContaining({
        kind: 'ENGINE_SPEND', ref: 'engine:WHATSAPP:m2',
      }));
    });

    it('draws the wallet for an armed voice settlement (ref from callId)', async () => {
      const { prisma, tariffs, ledger, wallet } = makeDeps(
        { VOICE_MINUTE: { unitCost: D('0.2'), amount: D('0.6'), quantity: D(3), currency: 'TRY', tariffId: 't' } },
        { autonomyLevel: 'AUTONOMOUS' },
      );
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await svc.settleVoice('ws1', { callId: 'c1', durationSec: 125, budgetId: 'b1' });
      expect(wallet.debitUpTo).toHaveBeenCalledWith('ws1', expect.objectContaining({
        kind: 'ENGINE_SPEND', ref: 'engine:VOICE:c1',
      }));
    });

    it('does NOT touch the wallet when the budget is not AUTONOMOUS', async () => {
      const { prisma, tariffs, ledger, wallet } = makeDeps(SMS_PRICED, { autonomyLevel: 'ASSISTED' });
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await svc.settleSms('ws1', { messageId: 'm1', text: 'hi', budgetId: 'b1' });
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });

    it('does NOT touch the wallet (or query the budget) when the env flag is off', async () => {
      delete process.env[FLAG];
      const { prisma, tariffs, ledger, wallet } = makeDeps(SMS_PRICED, { autonomyLevel: 'AUTONOMOUS' });
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await svc.settleSms('ws1', { messageId: 'm1', text: 'hi', budgetId: 'b1' });
      expect(prisma.growthBudget.findFirst).not.toHaveBeenCalled();
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });

    it('does NOT query the budget or touch the wallet without a budgetId (manual spend untouched)', async () => {
      const { prisma, tariffs, ledger, wallet } = makeDeps(SMS_PRICED, { autonomyLevel: 'AUTONOMOUS' });
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await svc.settleSms('ws1', { messageId: 'm1', text: 'hi' });
      expect(prisma.growthBudget.findFirst).not.toHaveBeenCalled();
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });

    it('is best-effort: a wallet drawdown failure never breaks the settlement', async () => {
      const { prisma, tariffs, ledger, wallet } = makeDeps(SMS_PRICED, { autonomyLevel: 'AUTONOMOUS' });
      wallet.debitUpTo.mockRejectedValueOnce(new Error('wallet down'));
      const svc = new ConversationSpendService(prisma, tariffs, ledger, wallet);
      await expect(svc.settleSms('ws1', { messageId: 'm1', text: 'hi', budgetId: 'b1' })).resolves.toBeTruthy();
      expect(prisma.message.update).toHaveBeenCalled(); // stamp already happened
    });
  });
});
