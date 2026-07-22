import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StrategyOrchestrator } from './strategy-orchestrator.service';

const action = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  workspaceId: 'ws1',
  strategyId: 'strat1',
  kind: 'CONTENT',
  status: 'APPROVED',
  priority: 'MEDIUM',
  payload: { title: 'Weekly clips' },
  ...over,
});

function deps(overrides: { action?: any; leadRun?: any; contentRun?: any } = {}) {
  const prisma = {
    strategyAction: {
      findFirst: jest.fn().mockResolvedValue(overrides.action === undefined ? action() : overrides.action),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => ({ ...action(), id: where.id, ...data })),
    },
  };
  const leadHunt = {
    kind: 'LEAD_HUNT' as const,
    run: jest.fn().mockResolvedValue(overrides.leadRun ?? { resultRef: 'research:run1' }),
  };
  const content = {
    kind: 'CONTENT' as const,
    run: jest.fn().mockResolvedValue(overrides.contentRun ?? { resultRef: 'post:post1' }),
  };
  const svc = new StrategyOrchestrator(prisma as any, leadHunt as any, content as any);
  return { svc, prisma, leadHunt, content };
}

describe('StrategyOrchestrator', () => {
  it('dispatches to the executor for the action kind, sets RUNNING then DONE + resultRef', async () => {
    const { svc, prisma, content, leadHunt } = deps();
    const r = await svc.execute('ws1', 'a1');

    expect(content.run).toHaveBeenCalledWith('ws1', { title: 'Weekly clips' });
    expect(leadHunt.run).not.toHaveBeenCalled();
    // RUNNING first, then DONE.
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(1, { where: { id: 'a1' }, data: { status: 'RUNNING' } });
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'DONE', resultRef: 'post:post1' },
    });
    expect(r).toEqual({ status: 'DONE', resultRef: 'post:post1' });
  });

  it('routes LEAD_HUNT actions to the lead-hunt executor', async () => {
    const { svc, leadHunt, content } = deps({ action: action({ kind: 'LEAD_HUNT', payload: { icpDescription: 'salons' } }) });
    await svc.execute('ws1', 'a1');
    expect(leadHunt.run).toHaveBeenCalledWith('ws1', { icpDescription: 'salons' });
    expect(content.run).not.toHaveBeenCalled();
  });

  it('stores a null resultRef when the executor returns none', async () => {
    const { svc, prisma } = deps({ contentRun: { resultRef: undefined } });
    const r = await svc.execute('ws1', 'a1');
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'DONE', resultRef: null },
    });
    expect(r).toEqual({ status: 'DONE', resultRef: null });
  });

  it('marks the action FAILED (and records the error) when the executor throws, without crashing', async () => {
    const { svc, prisma, content } = deps();
    content.run.mockRejectedValue(new Error('kaboom'));
    const r = await svc.execute('ws1', 'a1');
    expect(r).toEqual({ status: 'FAILED', error: 'kaboom' });
    expect(prisma.strategyAction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'a1' },
      data: { status: 'FAILED', resultRef: 'error:kaboom' },
    });
  });

  it('no-ops (skipped) for a not-yet-supported kind, leaving it APPROVED', async () => {
    const { svc, prisma, leadHunt, content } = deps({ action: action({ kind: 'AD_CAMPAIGN' }) });
    const r = await svc.execute('ws1', 'a1');
    expect(r).toEqual({ skipped: 'executor-not-available' });
    expect(leadHunt.run).not.toHaveBeenCalled();
    expect(content.run).not.toHaveBeenCalled();
    expect(prisma.strategyAction.update).not.toHaveBeenCalled();
  });

  it('guards non-APPROVED actions (BadRequest), without dispatching', async () => {
    const { svc, content } = deps({ action: action({ status: 'PROPOSED' }) });
    await expect(svc.execute('ws1', 'a1')).rejects.toThrow(BadRequestException);
    expect(content.run).not.toHaveBeenCalled();
  });

  it('throws NotFound for a missing/other-workspace action', async () => {
    const { svc } = deps({ action: null });
    await expect(svc.execute('ws1', 'nope')).rejects.toThrow(NotFoundException);
  });
});
