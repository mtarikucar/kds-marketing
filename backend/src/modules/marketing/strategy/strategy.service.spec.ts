import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUTOPILOT_ARM_KIND, StrategyService } from './strategy.service';

function deps(overrides: { strategy?: any; action?: any } = {}) {
  // ONE mutable row behind findFirst/update/updateMany, so a conditional claim
  // is testable: a mock that answers every write with success cannot tell a
  // claim from a plain write, which is the whole difference being asserted.
  let current: any = overrides.action ?? null;
  const prisma = {
    marketingStrategy: {
      findUnique: jest.fn().mockResolvedValue(overrides.strategy ?? null),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'strat1', ...data })),
    },
    strategyAction: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockImplementation(async () => (current ? { ...current } : null)),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        current = { ...(current ?? { id: where.id }), ...data };
        return { ...current };
      }),
      // Honours the `where` on purpose — see above.
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (!current) return { count: 0 };
        if (where.status !== undefined && current.status !== where.status) return { count: 0 };
        current = { ...current, ...data };
        return { count: 1 };
      }),
    },
    // Arming keys its day-claim on the workspace's own clock and hands the run
    // to the queue, so both are part of the harness now.
    workspace: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Europe/Istanbul' }) },
    usageCounter: { create: jest.fn().mockResolvedValue({}) },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const orchestrator = {
    execute: jest.fn().mockResolvedValue({ status: 'DONE', resultRef: null }),
    applyPlan: jest
      .fn()
      .mockResolvedValue({ lane: 'AUTONOMOUS', applied: 0, skipped: 0, skippedReasons: {} }),
  };
  const svc = new StrategyService(prisma as any, orchestrator as any, scheduledJobs as any);
  return { svc, prisma, orchestrator, scheduledJobs };
}

const action = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'a1',
  workspaceId: 'ws1',
  strategyId: 'strat1',
  kind: 'CONTENT',
  status: 'PROPOSED',
  priority: 'MEDIUM',
  ...over,
});

describe('StrategyService', () => {
  describe('getStrategy', () => {
    it('returns the workspace strategy', async () => {
      const { svc, prisma } = deps({ strategy: { id: 'strat1', workspaceId: 'ws1' } });
      expect(await svc.getStrategy('ws1')).toEqual({ id: 'strat1', workspaceId: 'ws1' });
      expect(prisma.marketingStrategy.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws1' } });
    });

    it('returns null when none exists', async () => {
      const { svc } = deps();
      expect(await svc.getStrategy('ws1')).toBeNull();
    });
  });

  describe('listActions', () => {
    it('scopes to the workspace and passes the status filter through', async () => {
      const { svc, prisma } = deps();
      await svc.listActions('ws1', { status: 'PROPOSED' });
      expect(prisma.strategyAction.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1', status: 'PROPOSED' },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('omits the status filter when not given', async () => {
      const { svc, prisma } = deps();
      await svc.listActions('ws1');
      expect(prisma.strategyAction.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1' },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('orders by priority HIGH → MEDIUM → LOW', async () => {
      const { svc, prisma } = deps();
      prisma.strategyAction.findMany.mockResolvedValue([
        action({ id: 'low', priority: 'LOW' }),
        action({ id: 'high', priority: 'HIGH' }),
        action({ id: 'med', priority: 'MEDIUM' }),
      ]);
      const r = await svc.listActions('ws1');
      expect(r.map((a) => a.id)).toEqual(['high', 'med', 'low']);
    });
  });

  describe('approveAction', () => {
    it('flips PROPOSED → APPROVED then dispatches the action to the orchestrator', async () => {
      const { svc, prisma, orchestrator } = deps({ action: action({ status: 'PROPOSED' }) });
      const r = await svc.approveAction('ws1', 'a1');
      // Narrowed by the status we read: the flip IS the claim, not a write that
      // happens to follow one. See the concurrency block at the bottom.
      expect(prisma.strategyAction.updateMany).toHaveBeenCalledWith({
        where: { id: 'a1', status: 'PROPOSED' },
        data: { status: 'APPROVED' },
      });
      expect(orchestrator.execute).toHaveBeenCalledWith('ws1', 'a1');
      expect(r.status).toBe('APPROVED');
    });

    it('still resolves (approval stands) when the orchestrator dispatch throws', async () => {
      const { svc, orchestrator } = deps({ action: action({ status: 'PROPOSED' }) });
      orchestrator.execute.mockRejectedValueOnce(new Error('dispatch boom'));
      const r = await svc.approveAction('ws1', 'a1');
      expect(r.status).toBe('APPROVED');
    });

    it('throws NotFound when the action is missing/other-workspace', async () => {
      const { svc, orchestrator } = deps({ action: null });
      await expect(svc.approveAction('ws1', 'nope')).rejects.toThrow(NotFoundException);
      expect(orchestrator.execute).not.toHaveBeenCalled();
    });

    it('throws BadRequest when the action is not PROPOSED and does not dispatch', async () => {
      const { svc, prisma, orchestrator } = deps({ action: action({ status: 'APPROVED' }) });
      await expect(svc.approveAction('ws1', 'a1')).rejects.toThrow(BadRequestException);
      expect(prisma.strategyAction.update).not.toHaveBeenCalled();
      expect(prisma.strategyAction.updateMany).not.toHaveBeenCalled();
      expect(orchestrator.execute).not.toHaveBeenCalled();
    });

    /**
     * "Can a human make an action run twice?"
     *
     * The status check is a READ, and `execute` only asserts the status it
     * finds — it claims nothing. So an unconditional `update` after that read
     * is the human half of the race `applyPlan` narrows its own update to
     * close, and it is the half that is easiest to trigger: a double-click on
     * Approve, a retried request, two open tabs. Both callers read PROPOSED,
     * both write APPROVED, both dispatch — two AI composes billed, two staged
     * drafts, and for COMMUNITY_ENGAGE on a connected Discord/Reddit channel
     * the same copy posted into a live community twice.
     *
     * It is worse against the autonomous sweep, which now runs on an hourly
     * clock and from the arming handler: the sweep claims the row and `execute`
     * moves it to RUNNING, and an unconditional write here puts it BACK to
     * APPROVED — precisely the status `execute` demands — so the second
     * dispatch walks through the guard meant to stop it while the first
     * executor is still mid-flight.
     */
    it('dispatches nothing when the claim is lost between the read and the write', async () => {
      const { svc, prisma, orchestrator } = deps({ action: action({ status: 'PROPOSED' }) });
      // The autonomous sweep (or a second click) took the row in that gap.
      prisma.strategyAction.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.strategyAction.findFirst
        .mockResolvedValueOnce(action({ status: 'PROPOSED' })) // our read
        .mockResolvedValueOnce(action({ status: 'RUNNING' })); // what it is now
      await expect(svc.approveAction('ws1', 'a1')).rejects.toThrow(BadRequestException);
      expect(orchestrator.execute).not.toHaveBeenCalled();
    });

    it('tells the loser what the action IS now, not what it was when we looked', async () => {
      const { svc, prisma } = deps({ action: action({ status: 'PROPOSED' }) });
      prisma.strategyAction.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.strategyAction.findFirst
        .mockResolvedValueOnce(action({ status: 'PROPOSED' }))
        .mockResolvedValueOnce(action({ status: 'RUNNING' }));
      await expect(svc.approveAction('ws1', 'a1')).rejects.toThrow(/action is RUNNING/);
    });

    it('two concurrent approvals dispatch the action exactly once', async () => {
      const { svc, orchestrator } = deps({ action: action({ status: 'PROPOSED' }) });
      const results = await Promise.allSettled([
        svc.approveAction('ws1', 'a1'),
        svc.approveAction('ws1', 'a1'),
      ]);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
  });

  describe('dismissAction', () => {
    it('flips a PROPOSED action → DISMISSED', async () => {
      const { svc, prisma } = deps({ action: action({ status: 'PROPOSED' }) });
      const r = await svc.dismissAction('ws1', 'a1');
      expect(prisma.strategyAction.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { status: 'DISMISSED' } });
      expect(r.status).toBe('DISMISSED');
    });

    it('dismisses an APPROVED action too', async () => {
      const { svc } = deps({ action: action({ status: 'APPROVED' }) });
      expect((await svc.dismissAction('ws1', 'a1')).status).toBe('DISMISSED');
    });

    it('throws NotFound when missing/other-workspace', async () => {
      const { svc } = deps({ action: null });
      await expect(svc.dismissAction('ws1', 'nope')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when already terminal (DONE)', async () => {
      const { svc, prisma } = deps({ action: action({ status: 'DONE' }) });
      await expect(svc.dismissAction('ws1', 'a1')).rejects.toThrow(BadRequestException);
      expect(prisma.strategyAction.update).not.toHaveBeenCalled();
    });
  });

  describe('setAutonomy', () => {
    it('updates the autonomy level for a valid enum', async () => {
      const { svc, prisma } = deps({ strategy: { id: 'strat1', workspaceId: 'ws1' } });
      const r = await svc.setAutonomy('ws1', 'AUTONOMOUS');
      expect(prisma.marketingStrategy.update).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1' },
        data: { autonomyLevel: 'AUTONOMOUS' },
      });
      expect(r.autonomyLevel).toBe('AUTONOMOUS');
    });

    it('throws BadRequest for an invalid level', async () => {
      const { svc, prisma } = deps({ strategy: { id: 'strat1' } });
      await expect(svc.setAutonomy('ws1', 'YOLO')).rejects.toThrow(BadRequestException);
      expect(prisma.marketingStrategy.update).not.toHaveBeenCalled();
    });

    it('throws NotFound when the workspace has no strategy', async () => {
      const { svc } = deps({ strategy: null });
      await expect(svc.setAutonomy('ws1', 'SHADOW')).rejects.toThrow(NotFoundException);
    });

    /**
     * Arming used to write the column and return. That made the console switch
     * a label rather than a decision: `applyPlan`'s only caller was the tail of
     * a synthesis run, synthesis is only re-run by a weekly cron that skips a
     * workspace unless an action moved, and only applyPlan or a human moves an
     * action. So flipping to AUTONOMOUS armed the lane for a synthesis that
     * could never happen, and the plan already sitting there stayed frozen —
     * nine PROPOSED actions on the live workspace, for weeks.
     */
    it('hands the first run to the queue instead of blocking the request', async () => {
      // applyPlan dispatches up to ten executors serially and one LEAD_HUNT is
      // budgeted at two minutes. Awaited inside the POST, arming a real plan
      // outlives the edge proxy: the owner gets an error toast and a control
      // still reading ASSISTED while the machine runs their plan. A settings
      // write returns; the work goes to the runner, which picks it up within
      // the minute.
      const { svc, orchestrator, scheduledJobs } = deps({
        strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'ASSISTED' },
      });
      const r = await svc.setAutonomy('ws1', 'AUTONOMOUS');
      expect(orchestrator.applyPlan).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: AUTOPILOT_ARM_KIND, payload: { workspaceId: 'ws1' } }),
      );
      expect(r).toMatchObject({ autonomyLevel: 'AUTONOMOUS', applyPlan: { queued: true } });
    });

    it('claims the day it just armed, so the next tick does not run the plan again', async () => {
      // Without this the hourly tick finds the local day unclaimed and drives
      // the same workspace a second time — day one runs twice the per-run cap.
      const { svc, prisma } = deps({
        strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'ASSISTED' },
      });
      await svc.setAutonomy('ws1', 'AUTONOMOUS');
      expect(prisma.usageCounter.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ workspaceId: 'ws1', metric: 'autopilot.apply' }),
      });
    });

    it('does not queue a second run when today has already been claimed', async () => {
      const { svc, prisma, scheduledJobs } = deps({
        strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'ASSISTED' },
      });
      const dup: any = new Error('dup');
      dup.code = 'P2002';
      Object.setPrototypeOf(dup, Prisma.PrismaClientKnownRequestError.prototype);
      prisma.usageCounter.create.mockRejectedValue(dup);
      const r = await svc.setAutonomy('ws1', 'AUTONOMOUS');
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
      expect(r).toMatchObject({ applyPlan: { queued: false, reason: 'already-run-today' } });
    });

    it('does NOT re-apply on a re-save of the same level', async () => {
      // A settings screen writes the current value every time someone presses
      // Save. Re-driving the plan on that is a second run nobody asked for; the
      // daily tick owns the cadence, this owns the moment of consent.
      const { svc, orchestrator } = deps({
        strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'AUTONOMOUS' },
      });
      await svc.setAutonomy('ws1', 'AUTONOMOUS');
      expect(orchestrator.applyPlan).not.toHaveBeenCalled();
    });

    it('does not apply when arming a lane that is not AUTONOMOUS', async () => {
      const { svc, orchestrator } = deps({
        strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'AUTONOMOUS' },
      });
      await svc.setAutonomy('ws1', 'ASSISTED');
      expect(orchestrator.applyPlan).not.toHaveBeenCalled();
    });

    it('keeps the autonomy write even when the first run cannot be queued', async () => {
      // The column is the owner's recorded decision. Rolling it back because a
      // queue write failed would leave the panel showing ASSISTED after the
      // owner chose AUTONOMOUS — the one thing a consent surface may never do.
      const { svc, prisma, scheduledJobs } = deps({
        strategy: { id: 'strat1', workspaceId: 'ws1', autonomyLevel: 'SHADOW' },
      });
      scheduledJobs.schedule.mockRejectedValue(new Error('queue down'));
      const r = await svc.setAutonomy('ws1', 'AUTONOMOUS');
      expect(prisma.marketingStrategy.update).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1' },
        data: { autonomyLevel: 'AUTONOMOUS' },
      });
      expect(r).toMatchObject({ autonomyLevel: 'AUTONOMOUS' });
    });
  });
});
