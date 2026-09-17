import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { LeadHuntExecutor } from './lead-hunt.executor';
import { StrategyOrchestrator } from '../orchestrator/strategy-orchestrator.service';

function deps(overrides: { job?: any; runResult?: any; policy?: any; legacyMode?: string } = {}) {
  const prisma = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ aiSpendPolicy: overrides.policy ?? {}, researchExecution: overrides.legacyMode ?? 'SERVER' }) },
    researchProfile: {
      create: jest.fn(async ({ data }: any) => ({ id: 'prof1', ...data })),
    },
  };
  const jobs = {
    buildJob: jest.fn().mockResolvedValue(
      overrides.job === undefined ? { workspaceId: 'ws1', profile: { id: 'prof1' } } : overrides.job,
    ),
  };
  const worker = {
    runProfile: jest.fn().mockResolvedValue(
      overrides.runResult ?? { runId: 'run1', researched: 3, staged: 2, duplicates: 0 },
    ),
  };
  const runner = { enqueueNow: jest.fn().mockResolvedValue('queued1') };
  const svc = new LeadHuntExecutor(prisma as any, jobs as any, worker as any, runner as any);
  return { svc, prisma, jobs, worker, runner };
}

const PAYLOAD = {
  icpDescription: 'Busy salons with poor online booking',
  geo: { country: 'TR', cities: ['İzmir'] },
  businessTypes: ['SALON'],
  exclusions: 'no franchises',
  productPitch: 'We fix booking',
  language: 'tr',
};

describe('LeadHuntExecutor', () => {
  it.each(['research.turn', 'research.qualify'])('rejects disabled %s before creating a profile', async (action) => {
    const { svc, prisma, jobs, worker, runner } = deps({ policy: { jobs: { [action]: { enabled: false, provider: 'MCP' } } } });
    await expect(svc.run('ws1', PAYLOAD)).rejects.toThrow(ForbiddenException);
    expect(prisma.researchProfile.create).not.toHaveBeenCalled();
    expect(jobs.buildJob).not.toHaveBeenCalled();
    expect(worker.runProfile).not.toHaveBeenCalled();
    expect(runner.enqueueNow).not.toHaveBeenCalled();
  });

  it('records a disabled lead hunt as FAILED with a visible reason, never DONE', async () => {
    const { svc: leadHunt, prisma, worker } = deps({ policy: { jobs: { 'research.turn': { enabled: false } } } });
    const action = { id: 'a1', kind: 'LEAD_HUNT', status: 'APPROVED', payload: PAYLOAD };
    const strategyAction = { findFirst: jest.fn().mockResolvedValue(action), update: jest.fn().mockResolvedValue(action) };
    const executor = (kind: string) => ({ kind, run: jest.fn() });
    const orchestrator = new StrategyOrchestrator({ strategyAction } as any, leadHunt, executor('CONTENT') as any, executor('COMMUNITY_ENGAGE') as any, executor('AD_CAMPAIGN') as any);
    expect(await orchestrator.execute('ws1', 'a1')).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/research.turn|disabled/i) });
    expect(strategyAction.update).toHaveBeenLastCalledWith({ where: { id: 'a1' }, data: { status: 'FAILED', resultRef: expect.stringMatching(/^error:/) } });
    expect(prisma.researchProfile.create).not.toHaveBeenCalled();
    expect(worker.runProfile).not.toHaveBeenCalled();
  });

  it.each(['research.turn', 'research.qualify'])('inherits explicit MCP from %s and queues the created profile without running native research', async (action) => {
    const { svc, prisma, worker, runner } = deps({ policy: { jobs: { [action]: { provider: 'MCP' } } } });
    expect(await svc.run('ws1', PAYLOAD)).toEqual({ pending: true, resultRef: 'research-queued:queued1' });
    expect(prisma.researchProfile.create).toHaveBeenCalledTimes(1);
    expect(runner.enqueueNow).toHaveBeenCalledWith('ws1', 'prof1');
    expect(worker.runProfile).not.toHaveBeenCalled();
  });

  it('preserves explicit API execution even with legacy MCP mode', async () => {
    const { svc, worker, runner } = deps({ policy: { jobs: { 'research.qualify': { provider: 'API' } } }, legacyMode: 'MCP' });
    expect(await svc.run('ws1', PAYLOAD)).toEqual({ resultRef: 'research:run1' });
    expect(worker.runProfile).toHaveBeenCalledTimes(1);
    expect(runner.enqueueNow).not.toHaveBeenCalled();
  });

  it.each([
    { 'research.turn': { provider: 'MCP' }, 'research.qualify': { provider: 'API' } },
    { 'research.turn': { provider: 'LOCAL' } },
  ])('fails closed before creating a profile for incompatible research providers: %j', async (jobs) => {
    const { svc, prisma, worker, runner } = deps({ policy: { jobs } });
    await expect(svc.run('ws1', PAYLOAD)).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.researchProfile.create).not.toHaveBeenCalled();
    expect(worker.runProfile).not.toHaveBeenCalled();
    expect(runner.enqueueNow).not.toHaveBeenCalled();
  });

  it('does not report a failed enqueue as completed or fall back to the native worker', async () => {
    const { svc, worker, runner } = deps({ policy: { jobs: { 'research.turn': { provider: 'MCP' } } } });
    runner.enqueueNow.mockRejectedValue(new Error('queue unavailable'));
    await expect(svc.run('ws1', PAYLOAD)).rejects.toThrow('queue unavailable');
    expect(worker.runProfile).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'MCP'])('rechecks policy after building the API job when it changes to %s', async (change) => {
    const { svc, prisma, jobs, worker, runner } = deps();
    jobs.buildJob.mockImplementation(async () => {
      prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'research.turn': change === 'MCP' ? { provider: 'MCP' } : { enabled: false } } } } as any);
      return { workspaceId: 'ws1', profile: { id: 'prof1' } };
    });
    if (change === 'MCP') {
      expect(await svc.run('ws1', PAYLOAD)).toEqual({ pending: true, resultRef: 'research-queued:queued1' });
      expect(runner.enqueueNow).toHaveBeenCalledWith('ws1', 'prof1');
    } else {
      await expect(svc.run('ws1', PAYLOAD)).rejects.toThrow(ForbiddenException);
      expect(runner.enqueueNow).not.toHaveBeenCalled();
    }
    expect(worker.runProfile).not.toHaveBeenCalled();
  });

  it('has kind LEAD_HUNT', () => {
    expect(deps().svc.kind).toBe('LEAD_HUNT');
  });

  it('creates a ResearchProfile from the payload, runs it, and returns the run ref', async () => {
    const { svc, prisma, jobs, worker } = deps();
    const r = await svc.run('ws1', PAYLOAD);

    expect(prisma.researchProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'ws1',
          status: 'ACTIVE',
          icpDescription: 'Busy salons with poor online booking',
          geo: { country: 'TR', cities: ['İzmir'] },
          businessTypes: ['SALON'],
          exclusions: 'no franchises',
          productPitch: 'We fix booking',
          language: 'tr',
        }),
      }),
    );
    expect(jobs.buildJob).toHaveBeenCalledWith('ws1', 'prof1');
    expect(worker.runProfile).toHaveBeenCalledWith({ workspaceId: 'ws1', profile: { id: 'prof1' } });
    expect(r).toEqual({ resultRef: 'research:run1' });
  });

  it('defaults language to en and derives a profile name when not supplied', async () => {
    const { svc, prisma } = deps();
    await svc.run('ws1', { icpDescription: 'Indie coffee shops' });
    const data = prisma.researchProfile.create.mock.calls[0][0].data;
    expect(data.language).toBe('en');
    expect(typeof data.name).toBe('string');
    expect(data.name.length).toBeGreaterThan(0);
  });

  it('returns resultRef undefined (graceful) when the worker skips (sources unconfigured)', async () => {
    const { svc, worker } = deps({ runResult: { runId: null, researched: 0, staged: 0, duplicates: 0, skipped: 'sources-not-configured' } });
    const r = await svc.run('ws1', PAYLOAD);
    expect(worker.runProfile).toHaveBeenCalled();
    expect(r).toEqual({ resultRef: undefined });
  });

  it('returns resultRef undefined and does not run when no eligible job (quota/inactive)', async () => {
    const { svc, worker } = deps({ job: null });
    const r = await svc.run('ws1', PAYLOAD);
    expect(worker.runProfile).not.toHaveBeenCalled();
    expect(r).toEqual({ resultRef: undefined });
  });

  it('throws on missing icpDescription', async () => {
    const { svc, prisma } = deps();
    await expect(svc.run('ws1', {})).rejects.toThrow(BadRequestException);
    await expect(svc.run('ws1', { icpDescription: '  ' })).rejects.toThrow(BadRequestException);
    expect(prisma.researchProfile.create).not.toHaveBeenCalled();
  });

  it('throws on a non-object payload', async () => {
    const { svc } = deps();
    await expect(svc.run('ws1', null)).rejects.toThrow(BadRequestException);
    await expect(svc.run('ws1', 'nope')).rejects.toThrow(BadRequestException);
  });
});
