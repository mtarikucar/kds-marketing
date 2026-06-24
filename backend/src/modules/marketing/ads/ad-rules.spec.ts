import { BadRequestException } from '@nestjs/common';
import { AdRulesService } from './ad-rules.service';

describe('AdRulesService — scaling engine', () => {
  let prisma: any;
  let mgmt: any;
  let svc: AdRulesService;

  beforeEach(() => {
    prisma = {
      adAccount: { findFirst: jest.fn() },
      adRule: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn().mockResolvedValue({}), delete: jest.fn() },
      adRuleLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
      adMetric: { findMany: jest.fn().mockResolvedValue([]) },
    };
    mgmt = { campaigns: jest.fn(), setDailyBudget: jest.fn().mockResolvedValue({}), setStatus: jest.fn().mockResolvedValue({}) };
    svc = new AdRulesService(prisma, mgmt);
  });

  const rule = (over: any = {}) => ({
    id: 'r1', workspaceId: 'ws', adAccountId: 'acc',
    metric: 'SPEND', operator: 'GT', threshold: 100, action: 'INCREASE_BUDGET',
    actionValue: 20, windowDays: 3, maxBudget: null, minBudget: null, cooldownHours: 24,
    ...over,
  });

  it('create rejects a budget action without actionValue', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ id: 'acc', provider: 'META' });
    await expect(
      svc.create('ws', { adAccountId: 'acc', name: 'x', metric: 'SPEND', operator: 'GT', threshold: 100, action: 'INCREASE_BUDGET' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('INCREASE_BUDGET raises the daily budget by the percent when the metric exceeds threshold', async () => {
    prisma.adRule.findFirst.mockResolvedValue(rule());
    mgmt.campaigns.mockResolvedValue([{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: 50 }]);
    prisma.adMetric.findMany.mockResolvedValue([{ campaignId: 'c1', spend: 150, impressions: 1000, clicks: 50, leads: 5 }]);

    const { actions } = await svc.runNow('ws', 'r1');
    expect(mgmt.setDailyBudget).toHaveBeenCalledWith('ws', 'acc', 'c1', 60); // 50 * 1.2
    expect(actions[0]).toMatchObject({ ok: true });
    expect(prisma.adRuleLog.create).toHaveBeenCalled();
  });

  it('clamps the increase to maxBudget', async () => {
    prisma.adRule.findFirst.mockResolvedValue(rule({ maxBudget: 55 }));
    mgmt.campaigns.mockResolvedValue([{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: 50 }]);
    prisma.adMetric.findMany.mockResolvedValue([{ campaignId: 'c1', spend: 150, impressions: 0, clicks: 0, leads: 0 }]);
    await svc.runNow('ws', 'r1');
    expect(mgmt.setDailyBudget).toHaveBeenCalledWith('ws', 'acc', 'c1', 55);
  });

  it('respects the per-campaign cooldown (recent ok log → no action)', async () => {
    prisma.adRule.findFirst.mockResolvedValue(rule());
    prisma.adRuleLog.findFirst.mockResolvedValue({ id: 'recent' });
    mgmt.campaigns.mockResolvedValue([{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: 50 }]);
    prisma.adMetric.findMany.mockResolvedValue([{ campaignId: 'c1', spend: 150, impressions: 0, clicks: 0, leads: 0 }]);
    const { actions } = await svc.runNow('ws', 'r1');
    expect(mgmt.setDailyBudget).not.toHaveBeenCalled();
    expect(actions).toHaveLength(0);
  });

  it('does not act when the condition is not met', async () => {
    prisma.adRule.findFirst.mockResolvedValue(rule({ threshold: 1000 }));
    mgmt.campaigns.mockResolvedValue([{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: 50 }]);
    prisma.adMetric.findMany.mockResolvedValue([{ campaignId: 'c1', spend: 150, impressions: 0, clicks: 0, leads: 0 }]);
    const { actions } = await svc.runNow('ws', 'r1');
    expect(actions).toHaveLength(0);
    expect(mgmt.setDailyBudget).not.toHaveBeenCalled();
  });

  it('PAUSE fires when CPL is high (spend with zero leads → infinite CPL)', async () => {
    prisma.adRule.findFirst.mockResolvedValue(rule({ metric: 'CPL', operator: 'GT', threshold: 50, action: 'PAUSE', actionValue: null }));
    mgmt.campaigns.mockResolvedValue([{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: 50 }]);
    prisma.adMetric.findMany.mockResolvedValue([{ campaignId: 'c1', spend: 100, impressions: 500, clicks: 10, leads: 0 }]);
    const { actions } = await svc.runNow('ws', 'r1');
    expect(mgmt.setStatus).toHaveBeenCalledWith('ws', 'acc', 'c1', 'PAUSED');
    expect(actions[0]).toMatchObject({ action: 'PAUSE', ok: true });
  });

  it('budget action on an ABO/lifetime campaign (no daily budget) is skipped + logged', async () => {
    prisma.adRule.findFirst.mockResolvedValue(rule());
    mgmt.campaigns.mockResolvedValue([{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: null }]);
    prisma.adMetric.findMany.mockResolvedValue([{ campaignId: 'c1', spend: 150, impressions: 0, clicks: 0, leads: 0 }]);
    const { actions } = await svc.runNow('ws', 'r1');
    expect(mgmt.setDailyBudget).not.toHaveBeenCalled();
    expect(actions[0]).toMatchObject({ ok: false });
    expect(actions[0].detail).toMatch(/no campaign daily budget/);
  });
});
