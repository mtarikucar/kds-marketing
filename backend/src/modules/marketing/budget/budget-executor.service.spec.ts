import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BudgetExecutorService } from './budget-executor.service';

/**
 * The executor is the money-moving capstone, so its guards get exhaustive unit
 * coverage: it must NEVER push a live ad-platform write unless the request is
 * APPROVED and the provider is credential-write-capable.
 */
describe('BudgetExecutorService', () => {
  const WS = 'ws1';
  const APPROVAL = 'appr1';
  const USER = 'user1';

  function make(overrides: {
    approval?: any;
    budget?: any;
    canWrite?: (p: string) => boolean;
    metaAccount?: any;
  } = {}) {
    const prisma = {
      approvalRequest: { findFirst: jest.fn().mockResolvedValue(overrides.approval ?? null) },
      growthBudget: { findFirst: jest.fn().mockResolvedValue(overrides.budget ?? null) },
      adAccount: { findFirst: jest.fn().mockResolvedValue(overrides.metaAccount ?? null) },
      budgetAllocation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      autopilotRun: { create: jest.fn().mockResolvedValue({ id: 'run1' }) },
    };
    const approvals = { markApplied: jest.fn().mockResolvedValue({}) };
    const capability = { canWriteBudget: jest.fn((p: string) => (overrides.canWrite ? overrides.canWrite(p) : false)) };
    const ads = { setDailyBudget: jest.fn().mockResolvedValue({ id: 'c1', dailyBudget: 100 }) };
    const svc = new BudgetExecutorService(prisma as any, approvals as any, capability as any, ads as any);
    return { svc, prisma, approvals, capability, ads };
  }

  const approvedReallocation = (after: any[]) => ({
    id: APPROVAL,
    workspaceId: WS,
    kind: 'BUDGET_REALLOCATION',
    status: 'APPROVED',
    payload: { budgetId: 'b1', runId: 'r1', after },
  });
  const activeBudget = { id: 'b1', workspaceId: WS, status: 'ACTIVE', killSwitch: false };

  it('rejects a non-reallocation approval', async () => {
    const { svc } = make({ approval: { id: APPROVAL, workspaceId: WS, kind: 'OTHER', status: 'APPROVED' } });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the approval is missing', async () => {
    const { svc } = make({ approval: null });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to apply a request that has not been approved', async () => {
    const { svc } = make({ approval: { ...approvedReallocation([]), status: 'PENDING' } });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent — an already-applied request short-circuits', async () => {
    const { svc, ads, approvals } = make({ approval: { ...approvedReallocation([]), status: 'APPLIED' } });
    const r = await svc.apply(WS, APPROVAL, USER);
    expect(r.status).toBe('ALREADY_APPLIED');
    expect(ads.setDailyBudget).not.toHaveBeenCalled();
    expect(approvals.markApplied).not.toHaveBeenCalled();
  });

  it('commits the internal plan but performs NO live write when no provider is write-capable', async () => {
    const after = [{ channel: 'META', campaignRef: 'c1', budget: 120 }, { channel: 'TIKTOK', campaignRef: 't1', budget: 80 }];
    const { svc, prisma, ads, approvals } = make({
      approval: approvedReallocation(after),
      budget: activeBudget,
      canWrite: () => false, // no credentials anywhere
    });
    const r = await svc.apply(WS, APPROVAL, USER);
    expect(prisma.budgetAllocation.updateMany).toHaveBeenCalledTimes(2); // plan committed for both
    expect(ads.setDailyBudget).not.toHaveBeenCalled(); // but NOTHING pushed to any platform
    expect(r.status).toBe('NO_LIVE_WRITE');
    expect(r.applied).toBe(0);
    expect(approvals.markApplied).toHaveBeenCalledWith(WS, APPROVAL);
  });

  it('pushes a live Meta write when Meta is write-capable and connected', async () => {
    const after = [{ channel: 'META', campaignRef: 'c1', budget: 150 }];
    const { svc, ads } = make({
      approval: approvedReallocation(after),
      budget: activeBudget,
      canWrite: (p) => p === 'META',
      metaAccount: { id: 'acc1' },
    });
    const r = await svc.apply(WS, APPROVAL, USER);
    expect(ads.setDailyBudget).toHaveBeenCalledWith(WS, 'acc1', 'c1', 150);
    expect(r.status).toBe('APPLIED');
    expect(r.applied).toBe(1);
  });

  it('does not write a channel-level rollup (no ad entity) even when capable', async () => {
    const after = [{ channel: 'META', campaignRef: '', budget: 150 }];
    const { svc, ads } = make({
      approval: approvedReallocation(after),
      budget: activeBudget,
      canWrite: (p) => p === 'META',
      metaAccount: { id: 'acc1' },
    });
    const r = await svc.apply(WS, APPROVAL, USER);
    expect(ads.setDailyBudget).not.toHaveBeenCalled();
    expect(r.status).toBe('NO_LIVE_WRITE');
  });

  it('rejects applying against a killed budget', async () => {
    const { svc } = make({
      approval: approvedReallocation([{ channel: 'META', campaignRef: 'c1', budget: 10 }]),
      budget: { ...activeBudget, killSwitch: true },
    });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('BudgetExecutorService.applyAutonomous (Growth Autopilot spec D6/D8)', () => {
  const WS = 'ws1';
  const AFTER = [{ channel: 'META', campaignRef: 'c1', budget: 120 }];

  function makeAuto(overrides: { budget?: any; canWrite?: (p: string) => boolean; metaAccount?: any } = {}) {
    const prisma = {
      approvalRequest: { findFirst: jest.fn() },
      growthBudget: { findFirst: jest.fn().mockResolvedValue(overrides.budget ?? null) },
      adAccount: { findFirst: jest.fn().mockResolvedValue(overrides.metaAccount ?? null) },
      budgetAllocation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      autopilotRun: { create: jest.fn().mockResolvedValue({ id: 'run-auto' }) },
    };
    const approvals = { markApplied: jest.fn(), enqueue: jest.fn() };
    const capability = { canWriteBudget: jest.fn((p: string) => (overrides.canWrite ? overrides.canWrite(p) : false)) };
    const ads = { setDailyBudget: jest.fn().mockResolvedValue({}) };
    const svc = new BudgetExecutorService(prisma as any, approvals as any, capability as any, ads as any);
    return { svc, prisma, approvals, capability, ads };
  }

  const autonomousBudget = { id: 'b1', workspaceId: WS, status: 'ACTIVE', killSwitch: false, autonomyLevel: 'AUTONOMOUS' };

  beforeEach(() => { process.env.GROWTH_AUTOPILOT_AUTONOMY = '1'; });
  afterEach(() => { delete process.env.GROWTH_AUTOPILOT_AUTONOMY; });

  it('commits the plan, pushes cred-gated live writes and records an AUTO run — with ZERO approval interaction', async () => {
    const { svc, prisma, approvals, ads } = makeAuto({
      budget: autonomousBudget,
      canWrite: (p) => p === 'META',
      metaAccount: { id: 'acc-1' },
    });

    const r = await svc.applyAutonomous(WS, 'b1', AFTER, 'shadow-run-1');

    expect(r.status).toBe('APPLIED');
    expect(prisma.budgetAllocation.updateMany).toHaveBeenCalledTimes(1);
    expect(ads.setDailyBudget).toHaveBeenCalledWith(WS, 'acc-1', 'c1', 120);
    const run = prisma.autopilotRun.create.mock.calls[0][0].data;
    expect(run).toMatchObject({ workspaceId: WS, budgetId: 'b1', autonomy: 'AUTO' });
    // The machine gate REPLACES the human gate: no approval row read, created or applied.
    expect(prisma.approvalRequest.findFirst).not.toHaveBeenCalled();
    expect(approvals.enqueue).not.toHaveBeenCalled();
    expect(approvals.markApplied).not.toHaveBeenCalled();
  });

  it('refuses when the env flag is off (ships dark) — nothing committed', async () => {
    delete process.env.GROWTH_AUTOPILOT_AUTONOMY;
    const { svc, prisma } = makeAuto({ budget: autonomousBudget });
    await expect(svc.applyAutonomous(WS, 'b1', AFTER, 'r1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.budgetAllocation.updateMany).not.toHaveBeenCalled();
  });

  it('re-checks killSwitch/status AT APPLY TIME — a killed budget never applies', async () => {
    const { svc, prisma, ads } = makeAuto({ budget: { ...autonomousBudget, killSwitch: true } });
    await expect(svc.applyAutonomous(WS, 'b1', AFTER, 'r1')).rejects.toBeInstanceOf(BadRequestException);
    const paused = makeAuto({ budget: { ...autonomousBudget, status: 'PAUSED' } });
    await expect(paused.svc.applyAutonomous(WS, 'b1', AFTER, 'r1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.budgetAllocation.updateMany).not.toHaveBeenCalled();
    expect(ads.setDailyBudget).not.toHaveBeenCalled();
  });

  it('refuses a budget that is not armed AUTONOMOUS', async () => {
    const { svc, prisma } = makeAuto({ budget: { ...autonomousBudget, autonomyLevel: 'ASSISTED' } });
    await expect(svc.applyAutonomous(WS, 'b1', AFTER, 'r1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.budgetAllocation.updateMany).not.toHaveBeenCalled();
  });
});
