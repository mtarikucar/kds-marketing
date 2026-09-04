import { Prisma } from '@prisma/client';
import { StrategyApplyCron } from './strategy-apply.cron';

/**
 * The driver. Everything here is about the two ways a scheduled sweep on this
 * codebase has gone wrong before — a day boundary read from server-local time,
 * and a take-N reconcile that pins itself to the same rows forever — plus the
 * one thing a restart must never do, which is run a day's plan twice.
 */
function deps(cfg: { strategies?: Array<{ workspaceId: string }>; workspaces?: Array<{ id: string; timezone: string }> } = {}) {
  const claims = new Set<string>();
  const prisma = {
    marketingStrategy: {
      findMany: jest.fn().mockResolvedValue(cfg.strategies ?? [{ workspaceId: 'ws1' }]),
    },
    workspace: {
      // Honours `take` on purpose. A mock that returns everything regardless
      // makes a take-N regression invisible to the one test written to catch
      // it — which is how the window-blindness bug survived review last time.
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const rows = cfg.workspaces ?? [{ id: 'ws1', timezone: 'Europe/Istanbul' }];
        return typeof args?.take === 'number' ? rows.slice(0, args.take) : rows;
      }),
    },
    usageCounter: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const key = `${data.workspaceId}|${data.metric}|${data.periodKey}`;
        if (claims.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        claims.add(key);
        return { id: key, ...data };
      }),
    },
  };
  const orchestrator = {
    applyPlan: jest
      .fn()
      .mockResolvedValue({ lane: 'AUTONOMOUS', applied: 2, attempted: 3, noResult: 1, failed: 0, noExecutor: 0, skipped: 1, skippedReasons: {} }),
  };
  const cron = new StrategyApplyCron(prisma as never, orchestrator as never);
  return { cron, prisma, orchestrator, claims };
}

/** 05:30 Istanbul (UTC+3) on 2026-09-02 — past the apply hour, local date 09-02. */
const AT_LOCAL_0530 = new Date('2026-09-02T02:30:00Z');
/** 03:30 Istanbul, i.e. 00:30 UTC — before the apply hour LOCALLY but on the
 *  PREVIOUS day in UTC. The two failure modes in one instant. */
const AT_LOCAL_0330 = new Date('2026-09-02T00:30:00Z');

describe('StrategyApplyCron', () => {
  it('drives an armed workspace once its own clock has reached the apply hour', async () => {
    const { cron, orchestrator } = deps();
    const r = await cron.runAll(AT_LOCAL_0530);
    expect(orchestrator.applyPlan).toHaveBeenCalledWith('ws1');
    // `attempted` and `applied` are summed separately on purpose: a tick that
    // ran three actions and produced two is a different fact from one that ran
    // two, and the log used to be able to say only the first number.
    expect(r).toEqual({ workspaces: 1, attempted: 3, applied: 2, skipped: 1 });
  });

  it('selects workspaces by PREDICATE — ACTIVE strategy, AUTONOMOUS lane, ACTIVE workspace', async () => {
    // Not a sorted take-N. This codebase has a recovery sweep that pinned
    // itself to the oldest N rows forever because it had no queryable not-done
    // predicate; the claim row below is that predicate here, and this is the
    // half that keeps the candidate set honest.
    const { cron, prisma } = deps();
    await cron.runAll(AT_LOCAL_0530);
    expect(prisma.marketingStrategy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE', autonomyLevel: 'AUTONOMOUS' } }),
    );
    expect(prisma.workspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['ws1'] }, status: 'ACTIVE' } }),
    );
  });

  it('is completely dormant when no workspace has armed the lane', async () => {
    const { cron, prisma, orchestrator } = deps({ strategies: [] });
    const r = await cron.runAll(AT_LOCAL_0530);
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
    expect(orchestrator.applyPlan).not.toHaveBeenCalled();
    expect(r).toEqual({ workspaces: 0, attempted: 0, applied: 0, skipped: 0 });
  });

  it('waits for the WORKSPACE clock, not the server clock', async () => {
    // 00:30 UTC is past midnight for the box and 03:30 for the customer. A
    // sweep built on server-local time would drive this workspace two hours
    // early and stamp the claim under yesterday's date.
    const { cron, orchestrator } = deps();
    await cron.runAll(AT_LOCAL_0330);
    expect(orchestrator.applyPlan).not.toHaveBeenCalled();
  });

  it('drives a workspace whose own day is ahead of both UTC and the test runner', async () => {
    // The other direction, and the one a same-timezone test cannot see. This
    // runner sits in Turkey, so "server-local" and "Istanbul" agree and a
    // regression to server-local time hides completely. Auckland is UTC+12: at
    // 00:30 UTC it is 12:30 there, long past the apply hour, while both UTC (00)
    // and the runner's own clock (03) say "not yet". Only a reading taken in
    // the WORKSPACE's timezone drives this workspace — and it must, or a
    // customer twelve hours ahead never gets a plan applied at all.
    const { cron, orchestrator, prisma } = deps({
      workspaces: [{ id: 'ws1', timezone: 'Pacific/Auckland' }],
    });
    await cron.runAll(AT_LOCAL_0330);
    expect(orchestrator.applyPlan).toHaveBeenCalledWith('ws1');
    // And the claim is stamped under THEIR date, which is already the 2nd.
    expect(prisma.usageCounter.create).toHaveBeenCalledWith({
      data: { workspaceId: 'ws1', metric: 'autopilot.apply', periodKey: '2026-09-02', value: 1 },
    });
  });

  it('claims the workspace-LOCAL day, so the same day cannot be driven twice', async () => {
    const { cron, prisma, orchestrator } = deps();
    await cron.runAll(AT_LOCAL_0530);
    expect(prisma.usageCounter.create).toHaveBeenCalledWith({
      data: { workspaceId: 'ws1', metric: 'autopilot.apply', periodKey: '2026-09-02', value: 1 },
    });
    // An hour later — a restart, a second replica, a catch-up pass. Same local
    // day, so the claim is already taken.
    const r = await cron.runAll(new Date('2026-09-02T03:30:00Z'));
    expect(orchestrator.applyPlan).toHaveBeenCalledTimes(1);
    expect(r.workspaces).toBe(0);
  });

  it('claims BEFORE driving, so a throwing apply cannot be retried hourly all day', async () => {
    const { cron, orchestrator } = deps();
    orchestrator.applyPlan.mockRejectedValue(new Error('db down'));
    const first = await cron.runAll(AT_LOCAL_0530);
    // The run is still counted as taken, and the failure does not escape.
    expect(first.workspaces).toBe(1);
    await cron.runAll(new Date('2026-09-02T04:30:00Z'));
    expect(orchestrator.applyPlan).toHaveBeenCalledTimes(1);
  });

  it('one workspace failing does not cost the others their day', async () => {
    const { cron, orchestrator } = deps({
      strategies: [{ workspaceId: 'a' }, { workspaceId: 'b' }],
      workspaces: [
        { id: 'a', timezone: 'Europe/Istanbul' },
        { id: 'b', timezone: 'Europe/Istanbul' },
      ],
    });
    orchestrator.applyPlan.mockImplementation(async (ws: string) => {
      if (ws === 'a') throw new Error('boom');
      return { lane: 'AUTONOMOUS', applied: 3, attempted: 3, noResult: 0, failed: 0, noExecutor: 0, skipped: 0, skippedReasons: {} };
    });
    const r = await cron.runAll(AT_LOCAL_0530);
    expect(orchestrator.applyPlan).toHaveBeenCalledWith('b');
    expect(r).toEqual({ workspaces: 2, attempted: 3, applied: 3, skipped: 0 });
  });

  it('caps one run, but the workspaces it pushed out run on the next tick', async () => {
    // The cap must bound a tick's work without deciding, permanently, which
    // workspaces get driven. The gate is `hour >= APPLY_HOUR`, so the tail has
    // the rest of the local day; the claim row keeps the already-driven ones
    // from re-consuming the budget.
    const ids = Array.from({ length: 60 }, (_, i) => `ws${i}`);
    const { cron, orchestrator } = deps({
      strategies: ids.map((id) => ({ workspaceId: id })),
      workspaces: ids.map((id) => ({ id, timezone: 'Europe/Istanbul' })),
    });
    const first = await cron.runAll(AT_LOCAL_0530);
    expect(first.workspaces).toBe(50);

    const second = await cron.runAll(new Date('2026-09-02T03:30:00Z'));
    expect(second.workspaces).toBe(10);
    // Every workspace driven exactly once across the two ticks.
    expect(orchestrator.applyPlan).toHaveBeenCalledTimes(60);
    expect(new Set(orchestrator.applyPlan.mock.calls.map((c: unknown[]) => c[0])).size).toBe(60);
  });

  it('tick() never lets a failure escape as an unhandled rejection', async () => {
    const { cron, prisma } = deps();
    (prisma as unknown as { $transaction: unknown }).$transaction = jest
      .fn()
      .mockRejectedValue(new Error('lock unavailable'));
    await expect(cron.tick()).resolves.toEqual({ workspaces: 0, attempted: 0, applied: 0, skipped: 0 });
  });
});

/**
 * The hour gate is `hour < APPLY_HOUR`, and `NaN` makes that comparison FALSE.
 * So a mistyped `STRATEGY_APPLY_HOUR` would not delay this driver, it would
 * delete its gate — every armed workspace driven at the first tick after
 * deploy, at whatever local hour that happens to be, and the "runs before the
 * 07:00 digest" ordering the morning brief is built on silently gone. The
 * digest cron's `!==` gate fails the opposite way and goes mute. Neither
 * surprise belongs on a thing that acts without a human, so an unusable value
 * falls back to the documented default.
 */
describe('StrategyApplyCron — the apply hour is validated, not just parsed', () => {
  const load = (raw: string | undefined) => {
    let mod: typeof import('./strategy-apply.cron');
    jest.isolateModules(() => {
      const prev = process.env.STRATEGY_APPLY_HOUR;
      if (raw === undefined) delete process.env.STRATEGY_APPLY_HOUR;
      else process.env.STRATEGY_APPLY_HOUR = raw;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('./strategy-apply.cron');
      if (prev === undefined) delete process.env.STRATEGY_APPLY_HOUR;
      else process.env.STRATEGY_APPLY_HOUR = prev;
    });
    return mod!;
  };

  const run = async (raw: string | undefined, now: Date) => {
    const { cron, orchestrator, prisma } = deps();
    const { StrategyApplyCron: Klass } = load(raw);
    const fresh = new Klass((prisma as never), (orchestrator as never));
    void cron;
    return { r: await fresh.runAll(now), orchestrator };
  };

  it('a garbage hour does not open the gate — 03:30 local still waits', async () => {
    const { r, orchestrator } = await run('five', AT_LOCAL_0330);
    expect(orchestrator.applyPlan).not.toHaveBeenCalled();
    expect(r.workspaces).toBe(0);
  });

  it('an out-of-range hour does not close the gate forever either', async () => {
    // `STRATEGY_APPLY_HOUR=25` would make `hour < 25` true for every hour of
    // every day: a driver that never fires and never says so.
    const { orchestrator } = await run('25', AT_LOCAL_0530);
    expect(orchestrator.applyPlan).toHaveBeenCalledWith('ws1');
  });

  it('still honours a legitimate override', async () => {
    const { orchestrator } = await run('9', AT_LOCAL_0530);
    expect(orchestrator.applyPlan).not.toHaveBeenCalled();
  });
});
