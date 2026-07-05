import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BudgetQuickstartService } from './budget-quickstart.service';

const D = (n: number) => new Prisma.Decimal(n);
const NOW = new Date('2026-07-05T12:00:00.000Z');

/**
 * One-click provisioning (spec D12): a single call ensures the wallet, upserts
 * the current-period budget, seeds allocations from ACTUALLY-connected assets,
 * optionally arms AUTONOMOUS (flag-gated) and returns a manifest of everything
 * it did — the "one click → dozens of operations" surface.
 */
function make(over: {
  walletBalance?: number;
  providers?: string[];
  socialAccounts?: number;
  channelTypes?: string[];
} = {}) {
  const budgetRow = { id: 'b1', workspaceId: 'ws1', periodKey: '2026-07', totalAmount: D(500), autonomyLevel: 'ASSISTED', status: 'ACTIVE' };
  const prisma = {
    adAccount: {
      findMany: jest.fn().mockResolvedValue((over.providers ?? []).map((p, i) => ({ id: `acc-${i}`, provider: p }))),
    },
    socialAccount: { count: jest.fn().mockResolvedValue(over.socialAccounts ?? 0) },
    channel: {
      // Honors the `type: { in: [...] }` filter like the real DB would.
      findMany: jest.fn(async ({ where }: any) =>
        (over.channelTypes ?? [])
          .filter((t) => !where?.type?.in || where.type.in.includes(t))
          .map((t, i) => ({ id: `ch-${i}`, type: t })),
      ),
    },
    growthBudget: { upsert: jest.fn(async ({ create, update }: any) => ({ ...budgetRow, ...create, ...update, id: 'b1' })) },
    budgetAllocation: { upsert: jest.fn(async ({ create }: any) => ({ id: `alloc-${create.channel}`, ...create })) },
  } as any;
  const wallet = {
    get: jest.fn().mockResolvedValue({
      workspaceId: 'ws1',
      balance: D(over.walletBalance ?? 0),
      currency: 'TRY',
      exists: (over.walletBalance ?? 0) > 0,
    }),
  } as any;
  const svc = new BudgetQuickstartService(prisma, wallet);
  return { prisma, wallet, svc };
}

describe('BudgetQuickstartService', () => {
  afterEach(() => { delete process.env.GROWTH_AUTOPILOT_AUTONOMY; });

  it('provisions budget + allocations from connected assets in ONE call and reports the manifest', async () => {
    const { svc, prisma } = make({
      walletBalance: 600,
      providers: ['META', 'TIKTOK'],
      socialAccounts: 2,
      channelTypes: ['WHATSAPP', 'SMS', 'WEBCHAT'],
    });

    const m = await svc.quickStart('ws1', {}, NOW);

    // Budget upserted for the CURRENT period, funded by the wallet balance.
    const upsert = prisma.growthBudget.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ workspaceId_periodKey: { workspaceId: 'ws1', periodKey: '2026-07' } });
    expect(upsert.create.totalAmount.toString()).toBe('600');
    expect(upsert.create.scope).toBe('HOLISTIC');
    // Channels detected from real connections only (WEBCHAT is not a spend channel).
    const seeded = prisma.budgetAllocation.upsert.mock.calls.map((c: any) => c[0].create.channel).sort();
    expect(seeded).toEqual(['CONTENT', 'META', 'SMS', 'TIKTOK', 'WHATSAPP']);
    // Equal split across 5 channels of 600 = 120 each.
    expect(prisma.budgetAllocation.upsert.mock.calls[0][0].create.plannedAmount.toString()).toBe('120');
    expect(m.channels.sort()).toEqual(['CONTENT', 'META', 'SMS', 'TIKTOK', 'WHATSAPP']);
    expect(m.budget.id).toBe('b1');
    expect(m.armed).toBe(false); // no arm requested
    expect(m.contentCampaign).toBeNull(); // content arm is a later phase
  });

  it('arms AUTONOMOUS only when requested AND the env flag is on', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const { svc, prisma } = make({ walletBalance: 100, providers: ['META'] });
    const m = await svc.quickStart('ws1', { arm: true }, NOW);
    expect(prisma.growthBudget.upsert.mock.calls[0][0].create.autonomyLevel).toBe('AUTONOMOUS');
    expect(m.armed).toBe(true);
  });

  it('refuses to arm when the env flag is off (ships dark)', async () => {
    const { svc, prisma } = make({ walletBalance: 100, providers: ['META'] });
    const m = await svc.quickStart('ws1', { arm: true }, NOW);
    expect(prisma.growthBudget.upsert.mock.calls[0][0].create.autonomyLevel).toBe('ASSISTED');
    expect(m.armed).toBe(false);
  });

  it('an explicit amount overrides the wallet balance as the cap', async () => {
    const { svc, prisma } = make({ walletBalance: 600, providers: ['META'] });
    await svc.quickStart('ws1', { amount: 250 }, NOW);
    expect(prisma.growthBudget.upsert.mock.calls[0][0].create.totalAmount.toString()).toBe('250');
  });

  it('fails CLOSED with no funding at all (no credit loaded, no amount)', async () => {
    const { svc } = make({ walletBalance: 0, providers: ['META'] });
    await expect(svc.quickStart('ws1', {}, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails when NOTHING is connected (no channel to spend on)', async () => {
    const { svc } = make({ walletBalance: 100, providers: [], socialAccounts: 0, channelTypes: [] });
    await expect(svc.quickStart('ws1', {}, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps goal targets onto the budget (targetRoas / targetCac)', async () => {
    const { svc, prisma } = make({ walletBalance: 100, providers: ['META'] });
    await svc.quickStart('ws1', { targetRoas: 3, targetCac: 50 }, NOW);
    const c = prisma.growthBudget.upsert.mock.calls[0][0].create;
    expect(c.targetRoas.toString()).toBe('3');
    expect(c.targetCac.toString()).toBe('50');
  });
});
