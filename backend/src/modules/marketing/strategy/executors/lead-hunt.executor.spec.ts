import { BadRequestException } from '@nestjs/common';
import { LeadHuntExecutor } from './lead-hunt.executor';

function deps(overrides: { job?: any; runResult?: any } = {}) {
  const prisma = {
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
  const svc = new LeadHuntExecutor(prisma as any, jobs as any, worker as any);
  return { svc, prisma, jobs, worker };
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
