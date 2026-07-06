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
  existingEngineCampaign?: unknown;
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
    socialAccount: {
      count: jest.fn().mockResolvedValue(over.socialAccounts ?? 0),
      findMany: jest.fn().mockResolvedValue(
        Array.from({ length: over.socialAccounts ?? 0 }, (_, i) => ({ id: `sa-${i}`, network: 'INSTAGRAM' })),
      ),
    },
    socialCampaign: {
      // Idempotency probe: default = no existing engine campaign for this account.
      findFirst: jest.fn().mockResolvedValue(over.existingEngineCampaign ?? null),
    },
  } as any;
  // socialAccount.count is shared by detectChannels + the content step.
  prisma.socialAccount.count = jest.fn().mockResolvedValue(over.socialAccounts ?? 0);
  const wallet = {
    get: jest.fn().mockResolvedValue({
      workspaceId: 'ws1',
      balance: D(over.walletBalance ?? 0),
      currency: 'TRY',
      exists: (over.walletBalance ?? 0) > 0,
    }),
  } as any;
  const socialCampaigns = {
    create: jest.fn(async () => ({ id: `sc-${Math.random().toString(36).slice(2, 7)}` })),
    activate: jest.fn().mockResolvedValue({}),
  } as any;
  const svc = new BudgetQuickstartService(prisma, wallet, socialCampaigns);
  return { prisma, wallet, socialCampaigns, svc };
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

  // Content arm: when the workspace ARMS autonomy and has connected social
  // accounts, the ONE click also provisions a fully-autonomous content campaign
  // per account (FULL_AUTO + AI_FULL) and activates it — no hand-authoring.
  describe('content arm (autonomous content per connected account)', () => {
    it('provisions a FULL_AUTO + AI_FULL campaign per social account and activates it when armed', async () => {
      process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
      const { svc, socialCampaigns } = make({ walletBalance: 300, socialAccounts: 2, providers: ['META'] });

      const m = await svc.quickStart('ws1', { arm: true, createdById: 'u1' }, NOW);

      expect(socialCampaigns.create).toHaveBeenCalledTimes(2);
      const first = socialCampaigns.create.mock.calls[0][1];
      expect(first).toMatchObject({
        automationMode: 'FULL_AUTO',
        planningMode: 'AI_FULL',
        targetAccountIds: ['sa-0'],
        engineBudgetId: 'b1',
        createdById: 'u1',
      });
      expect(first.mediaKinds).toEqual(['IMAGE']);
      // Each created campaign is activated (create alone = DRAFT).
      expect(socialCampaigns.activate).toHaveBeenCalledTimes(2);
      // Manifest reports what was set up.
      expect(m.contentCampaign).toMatchObject({ count: 2 });
      expect((m.contentCampaign as { campaignIds: string[] }).campaignIds).toHaveLength(2);
    });

    it('does NOT provision content when the flag is off (arm degrades to ASSISTED)', async () => {
      const { svc, socialCampaigns } = make({ walletBalance: 300, socialAccounts: 2, providers: ['META'] });
      const m = await svc.quickStart('ws1', { arm: true, createdById: 'u1' }, NOW);
      expect(socialCampaigns.create).not.toHaveBeenCalled();
      expect(m.contentCampaign).toBeNull();
    });

    it('does NOT provision content when armed but there are no social accounts', async () => {
      process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
      const { svc, socialCampaigns } = make({ walletBalance: 300, socialAccounts: 0, providers: ['META'] });
      const m = await svc.quickStart('ws1', { arm: true, createdById: 'u1' }, NOW);
      expect(socialCampaigns.create).not.toHaveBeenCalled();
      expect(m.contentCampaign).toBeNull();
    });

    it('is idempotent — skips an account already backed by an active engine campaign', async () => {
      process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
      const { svc, socialCampaigns, prisma } = make({ walletBalance: 300, socialAccounts: 1, providers: ['META'] });
      // The idempotency probe finds an existing engine campaign for the account.
      prisma.socialCampaign.findFirst.mockResolvedValue({ id: 'existing-sc' });

      const m = await svc.quickStart('ws1', { arm: true, createdById: 'u1' }, NOW);

      expect(socialCampaigns.create).not.toHaveBeenCalled();
      expect(socialCampaigns.activate).not.toHaveBeenCalled();
      expect((m.contentCampaign as { count: number }).count).toBe(0);
    });

    it('does NOT provision content when armed but createdById is missing (no actor)', async () => {
      process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
      const { svc, socialCampaigns } = make({ walletBalance: 300, socialAccounts: 2, providers: ['META'] });
      const m = await svc.quickStart('ws1', { arm: true }, NOW);
      expect(socialCampaigns.create).not.toHaveBeenCalled();
      expect(m.contentCampaign).toBeNull();
    });
  });
});
