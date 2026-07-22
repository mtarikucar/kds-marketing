import { StrategyFeedbackCron } from './strategy-feedback.cron';

function makeDeps(cfg: { strategies?: any[]; sourcesEnabled?: boolean; aiEnabled?: boolean } = {}) {
  const prisma = {
    marketingStrategy: { findMany: jest.fn().mockResolvedValue(cfg.strategies ?? []) },
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
    const deps = makeDeps({ strategies: [{ workspaceId: 'ws1' }, { workspaceId: 'ws2' }] });
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

  it('keeps going past a workspace whose refresh throws', async () => {
    const deps = makeDeps({ strategies: [{ workspaceId: 'ws1' }, { workspaceId: 'ws2' }] });
    deps.feedback.refresh.mockRejectedValueOnce(new Error('boom'));
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(1); // ws1 failed, ws2 succeeded
    expect(deps.feedback.refresh).toHaveBeenCalledTimes(2);
  });
});
