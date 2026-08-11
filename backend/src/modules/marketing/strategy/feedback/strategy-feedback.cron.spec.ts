import { StrategyFeedbackCron } from './strategy-feedback.cron';

function makeDeps(
  cfg: {
    strategies?: any[];
    sourcesEnabled?: boolean;
    aiEnabled?: boolean;
    /** null = no StrategyAction has moved since the strategy was last written. */
    movedAction?: unknown;
  } = {},
) {
  const prisma = {
    marketingStrategy: { findMany: jest.fn().mockResolvedValue(cfg.strategies ?? []) },
    strategyAction: {
      findFirst: jest
        .fn()
        .mockResolvedValue('movedAction' in cfg ? cfg.movedAction : { id: 'act1' }),
    },
  } as any;
  const feedback = { refresh: jest.fn().mockResolvedValue({ strategyId: 'strat1', actionCount: 3 }) } as any;
  const sources = { isEnabled: () => cfg.sourcesEnabled ?? true } as any;
  const anthropic = { isEnabled: () => cfg.aiEnabled ?? true } as any;
  return { prisma, feedback, sources, anthropic };
}

function makeCron(d: ReturnType<typeof makeDeps>) {
  return new StrategyFeedbackCron(d.prisma, d.feedback, d.sources, d.anthropic);
}

describe('StrategyFeedbackCron', () => {
  it('is inert when research sources are unconfigured', async () => {
    const deps = makeDeps({ sourcesEnabled: false, strategies: [{ workspaceId: 'ws1' }] });
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(0);
    expect(deps.prisma.marketingStrategy.findMany).not.toHaveBeenCalled();
    expect(deps.feedback.refresh).not.toHaveBeenCalled();
  });

  it('is inert when AI is unconfigured', async () => {
    const deps = makeDeps({ aiEnabled: false, strategies: [{ workspaceId: 'ws1' }] });
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(0);
    expect(deps.feedback.refresh).not.toHaveBeenCalled();
  });

  it('iterates only ACTIVE strategies and refreshes each workspace', async () => {
    const deps = makeDeps({
      strategies: [
        { workspaceId: 'ws1', updatedAt: new Date('2026-08-01') },
        { workspaceId: 'ws2', updatedAt: new Date('2026-08-01') },
      ],
    });
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(2);
    expect(deps.prisma.marketingStrategy.findMany.mock.calls[0][0].where).toEqual({ status: 'ACTIVE' });
    expect(deps.feedback.refresh).toHaveBeenCalledWith('ws1');
    expect(deps.feedback.refresh).toHaveBeenCalledWith('ws2');
  });

  it('is a no-op when there are no active strategies (self-gating)', async () => {
    const deps = makeDeps({ strategies: [] });
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(0);
    expect(deps.feedback.refresh).not.toHaveBeenCalled();
  });

  /**
   * A re-synthesis is the most expensive action in the product — a multi-step
   * Opus tool-loop over live research — and this cron used to run it DAILY for
   * every ACTIVE strategy with no further condition. An abandoned workspace
   * therefore billed Jeeta ~30 unattended re-syntheses a month. Feedback folds
   * EXECUTION OUTCOMES back into the plan, so with no outcome to fold there is
   * nothing to learn and nothing to spend.
   */
  it('skips a workspace whose plan has not moved since the last synthesis', async () => {
    const deps = makeDeps({
      strategies: [{ workspaceId: 'ws1', updatedAt: new Date('2026-08-01') }],
      movedAction: null,
    });
    const cron = makeCron(deps);

    expect(await cron.runAll()).toBe(0);
    expect(deps.feedback.refresh).not.toHaveBeenCalled();
    // The gate compares against the strategy as we last left it.
    expect(deps.prisma.strategyAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws1', updatedAt: { gt: new Date('2026-08-01') } },
      }),
    );
  });

  it('refreshes only the workspaces whose plan actually moved', async () => {
    const deps = makeDeps({
      strategies: [
        { workspaceId: 'idle', updatedAt: new Date('2026-08-01') },
        { workspaceId: 'busy', updatedAt: new Date('2026-08-01') },
      ],
    });
    deps.prisma.strategyAction.findFirst
      .mockResolvedValueOnce(null) // idle
      .mockResolvedValueOnce({ id: 'act1' }); // busy
    const cron = makeCron(deps);

    expect(await cron.runAll()).toBe(1);
    expect(deps.feedback.refresh).toHaveBeenCalledTimes(1);
    expect(deps.feedback.refresh).toHaveBeenCalledWith('busy');
  });

  it('keeps going past a workspace whose refresh throws', async () => {
    const deps = makeDeps({
      strategies: [
        { workspaceId: 'ws1', updatedAt: new Date('2026-08-01') },
        { workspaceId: 'ws2', updatedAt: new Date('2026-08-01') },
      ],
    });
    deps.feedback.refresh.mockRejectedValueOnce(new Error('boom'));
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(1); // ws1 failed, ws2 succeeded
    expect(deps.feedback.refresh).toHaveBeenCalledTimes(2);
  });
});
