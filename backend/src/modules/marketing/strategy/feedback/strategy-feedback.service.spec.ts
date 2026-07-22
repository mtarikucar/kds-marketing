import { StrategyFeedbackService } from './strategy-feedback.service';

function deps(overrides: {
  strategy?: any;
  session?: any;
  doneActions?: any[];
  adAgg?: any;
  synthResult?: any;
} = {}) {
  const prisma = {
    marketingStrategy: {
      findFirst: jest.fn().mockResolvedValue(
        overrides.strategy === undefined ? { id: 'strat1', workspaceId: 'ws1', status: 'ACTIVE', version: 3 } : overrides.strategy,
      ),
    },
    strategyIntakeSession: {
      findFirst: jest.fn().mockResolvedValue(
        overrides.session === undefined ? { id: 'sess1', workspaceId: 'ws1', createdAt: new Date() } : overrides.session,
      ),
    },
    strategyAction: {
      findMany: jest.fn().mockResolvedValue(
        overrides.doneActions ?? [
          { kind: 'LEAD_HUNT', resultRef: 'research:r1' },
          { kind: 'LEAD_HUNT', resultRef: 'research:r2' },
          { kind: 'CONTENT', resultRef: 'post:p1' },
          { kind: 'COMMUNITY_ENGAGE', resultRef: 'community:c1' },
        ],
      ),
    },
    adMetric: {
      aggregate: jest.fn().mockResolvedValue(overrides.adAgg ?? { _sum: { spend: 120, revenue: 300 }, _count: 14 }),
    },
  };
  const synthesis = {
    synthesize: jest.fn().mockResolvedValue(overrides.synthResult ?? { strategyId: 'strat1', actionCount: 5 }),
  };
  const svc = new StrategyFeedbackService(prisma as any, synthesis as any);
  return { svc, prisma, synthesis };
}

describe('StrategyFeedbackService.refresh', () => {
  it('builds an outcome summary and triggers a re-synthesis with it as extra context', async () => {
    const { svc, synthesis } = deps();
    const r = await svc.refresh('ws1');

    expect(synthesis.synthesize).toHaveBeenCalledTimes(1);
    const [ws, sessionId, summary] = synthesis.synthesize.mock.calls[0];
    expect(ws).toBe('ws1');
    expect(sessionId).toBe('sess1');
    // Summary folds in completed-action counts + cheap signals.
    expect(typeof summary).toBe('string');
    expect(summary).toMatch(/LEAD_HUNT/);
    expect(summary).toMatch(/CONTENT/);
    expect(summary).toMatch(/300/); // ad revenue signal
    expect(r).toEqual({ strategyId: 'strat1', actionCount: 5 });
  });

  it('reads DONE actions for the ACTIVE strategy only', async () => {
    const { svc, prisma } = deps();
    await svc.refresh('ws1');
    expect(prisma.strategyAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws1', strategyId: 'strat1', status: 'DONE' }) }),
    );
  });

  it('skips workspaces with no ACTIVE strategy (no re-synthesis)', async () => {
    const { svc, synthesis } = deps({ strategy: null });
    const r = await svc.refresh('ws1');
    expect(r).toMatchObject({ skipped: 'no-active-strategy' });
    expect(synthesis.synthesize).not.toHaveBeenCalled();
  });

  it('skips when there is no intake session to re-synthesize from', async () => {
    const { svc, synthesis } = deps({ session: null });
    const r = await svc.refresh('ws1');
    expect(r).toMatchObject({ skipped: 'no-intake-session' });
    expect(synthesis.synthesize).not.toHaveBeenCalled();
  });

  it('tolerates absent ad metrics (null sums)', async () => {
    const { svc, synthesis } = deps({ adAgg: { _sum: { spend: null, revenue: null }, _count: 0 } });
    await svc.refresh('ws1');
    const summary = synthesis.synthesize.mock.calls[0][2];
    expect(summary).toMatch(/0 metric-day/);
  });
});
