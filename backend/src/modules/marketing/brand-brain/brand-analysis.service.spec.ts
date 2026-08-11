import { BrandAnalysisService } from './brand-analysis.service';

function makeSvc() {
  const prisma: any = {
    brandAnalysisRun: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    workspace: { findUnique: jest.fn() },
  };
  const synthesis: any = { synthesize: jest.fn() };
  const spend: any = { settle: jest.fn().mockResolvedValue(null) };
  const scheduledJob: any = { schedule: jest.fn() };
  const website: any = { collect: jest.fn() };
  const social: any = { collect: jest.fn() };
  const gbp: any = { collect: jest.fn() };
  const upload: any = { collect: jest.fn() };
  // Strategy onboarding can flag a run autoApply — the finished draft then
  // seeds the workspace without waiting for a human review click.
  const applyService: any = { apply: jest.fn().mockResolvedValue({ applied: true }) };
  const svc = new BrandAnalysisService(
    prisma,
    synthesis,
    spend,
    scheduledJob,
    applyService,
    website,
    social,
    gbp,
    upload,
  );
  return { svc, prisma, synthesis, spend, scheduledJob, applyService, website, social, gbp, upload };
}

describe('BrandAnalysisService', () => {
  describe('startAnalysis', () => {
    it('re-attaches to an already-active run instead of creating a second one', async () => {
      const { svc, prisma, scheduledJob } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({ id: 'existing' });

      const result = await svc.startAnalysis('ws1', { websiteUrl: 'https://acme.example' });

      expect(result).toEqual({ runId: 'existing' });
      expect(prisma.brandAnalysisRun.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1', status: { in: ['QUEUED', 'RUNNING'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(prisma.brandAnalysisRun.create).not.toHaveBeenCalled();
      expect(scheduledJob.schedule).not.toHaveBeenCalled();
    });

    it('no active run: creates a QUEUED run and schedules the async analyze job (deduped per workspace)', async () => {
      const { svc, prisma, scheduledJob } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue(null);
      prisma.brandAnalysisRun.create.mockResolvedValue({ id: 'run1', workspaceId: 'ws1', status: 'QUEUED' });

      const result = await svc.startAnalysis('ws1', { websiteUrl: 'https://acme.example' });

      expect(result).toEqual({ runId: 'run1' });
      expect(prisma.brandAnalysisRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ workspaceId: 'ws1', status: 'QUEUED' }),
        }),
      );
      expect(scheduledJob.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'brand-brain.analyze',
          dedupKey: 'brand-analyze:ws1',
          payload: { runId: 'run1' },
        }),
      );
    });
  });

  describe('runAnalysis', () => {
    it('happy path: collects sources, meters billable units, synthesizes, sets READY_FOR_REVIEW', async () => {
      const { svc, prisma, synthesis, spend, website, social, gbp, upload } = makeSvc();
      prisma.brandAnalysisRun.findUnique.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'QUEUED',
        inputs: { websiteUrl: 'x' },
      });
      website.collect.mockResolvedValue({ source: 'website', status: 'ok', raw: [{ url: 'x' }], firecrawlPages: 3 });
      social.collect.mockResolvedValue({ source: 'social', status: 'ok', raw: [{}], apifyRuns: 1 });
      gbp.collect.mockResolvedValue({ source: 'gbp', status: 'inert', raw: null });
      upload.collect.mockResolvedValue({ source: 'uploads', status: 'inert', raw: null });
      const draft = { profile: {}, researchProfile: {}, brandKitHints: {}, knowledgeDocs: [] };
      synthesis.synthesize.mockResolvedValue(draft);
      prisma.workspace.findUnique.mockResolvedValue({ defaultLanguage: 'tr' });

      await svc.runAnalysis('run1');

      expect(prisma.brandAnalysisRun.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'run1' },
        data: { status: 'RUNNING' },
      });
      expect(spend.settle).toHaveBeenCalledWith('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 3, ref: 'brand:run1' });
      expect(spend.settle).toHaveBeenCalledWith('ws1', { unit: 'APIFY_RUN', quantity: 1, ref: 'brand:run1' });

      const lastCall = prisma.brandAnalysisRun.update.mock.calls[prisma.brandAnalysisRun.update.mock.calls.length - 1];
      expect(lastCall[0].where).toEqual({ id: 'run1' });
      expect(lastCall[0].data.status).toBe('READY_FOR_REVIEW');
      expect(lastCall[0].data.draft).toEqual(draft);
      expect(lastCall[0].data.sourceResults).toEqual([
        expect.objectContaining({ source: 'website' }),
        expect.objectContaining({ source: 'social' }),
        expect.objectContaining({ source: 'gbp' }),
        expect.objectContaining({ source: 'uploads' }),
      ]);
    });

    it('accrues costUsd as the sum of each spend.settle amount', async () => {
      const { svc, prisma, synthesis, spend, website, social, gbp, upload } = makeSvc();
      prisma.brandAnalysisRun.findUnique.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'QUEUED',
        inputs: { websiteUrl: 'x' },
      });
      website.collect.mockResolvedValue({ source: 'website', status: 'ok', raw: [{ url: 'x' }], firecrawlPages: 3 });
      social.collect.mockResolvedValue({ source: 'social', status: 'ok', raw: [{}], apifyRuns: 1 });
      gbp.collect.mockResolvedValue({ source: 'gbp', status: 'inert', raw: null });
      upload.collect.mockResolvedValue({ source: 'uploads', status: 'inert', raw: null });
      spend.settle.mockImplementation((_workspaceId: string, opts: { unit: string }) => {
        if (opts.unit === 'FIRECRAWL_PAGE') return Promise.resolve({ amount: 2, quantity: 3 });
        if (opts.unit === 'APIFY_RUN') return Promise.resolve({ amount: 1, quantity: 1 });
        return Promise.resolve(null);
      });
      const draft = { profile: {}, researchProfile: {}, brandKitHints: {}, knowledgeDocs: [] };
      synthesis.synthesize.mockResolvedValue(draft);
      prisma.workspace.findUnique.mockResolvedValue({ defaultLanguage: 'tr' });

      await svc.runAnalysis('run1');

      const lastCall = prisma.brandAnalysisRun.update.mock.calls[prisma.brandAnalysisRun.update.mock.calls.length - 1];
      expect(lastCall[0].data.status).toBe('READY_FOR_REVIEW');
      expect(lastCall[0].data.costUsd).toBe(3);
    });

    it('synthesis failure sets FAILED with the error', async () => {
      const { svc, prisma, synthesis, website, social, gbp, upload } = makeSvc();
      prisma.brandAnalysisRun.findUnique.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'QUEUED',
        inputs: {},
      });
      website.collect.mockResolvedValue({ source: 'website', status: 'inert', raw: null });
      social.collect.mockResolvedValue({ source: 'social', status: 'inert', raw: null });
      gbp.collect.mockResolvedValue({ source: 'gbp', status: 'inert', raw: null });
      upload.collect.mockResolvedValue({ source: 'uploads', status: 'inert', raw: null });
      synthesis.synthesize.mockRejectedValue(new Error('model exploded'));
      prisma.workspace.findUnique.mockResolvedValue({ defaultLanguage: 'tr' });

      await svc.runAnalysis('run1');

      const lastCall = prisma.brandAnalysisRun.update.mock.calls[prisma.brandAnalysisRun.update.mock.calls.length - 1];
      expect(lastCall[0].where).toEqual({ id: 'run1' });
      expect(lastCall[0].data.status).toBe('FAILED');
      expect(lastCall[0].data.error).toBe('model exploded');
    });

    it('is idempotent: a still-RUNNING run is a no-op (concurrent re-dispatch of a slow-but-alive run must not clobber it)', async () => {
      const { svc, prisma, synthesis, website, social, gbp, upload } = makeSvc();
      prisma.brandAnalysisRun.findUnique.mockResolvedValue({ id: 'run1', workspaceId: 'ws1', status: 'RUNNING' });

      await svc.runAnalysis('run1');

      expect(prisma.brandAnalysisRun.update).not.toHaveBeenCalled();
      expect(website.collect).not.toHaveBeenCalled();
      expect(social.collect).not.toHaveBeenCalled();
      expect(gbp.collect).not.toHaveBeenCalled();
      expect(upload.collect).not.toHaveBeenCalled();
      expect(synthesis.synthesize).not.toHaveBeenCalled();
    });

    it('is idempotent: a terminal (APPLIED) run is a no-op', async () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findUnique.mockResolvedValue({ id: 'run1', workspaceId: 'ws1', status: 'APPLIED' });

      await svc.runAnalysis('run1');

      expect(prisma.brandAnalysisRun.update).not.toHaveBeenCalled();
    });
  });

  describe('getRun', () => {
    it('fetches workspace-scoped by id + workspaceId', () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({ id: 'run1' });

      svc.getRun('ws1', 'run1');

      expect(prisma.brandAnalysisRun.findFirst).toHaveBeenCalledWith({ where: { id: 'run1', workspaceId: 'ws1' } });
    });
  });
});

/**
 * Strategy onboarding flags its run `autoApply`: the user has already
 * introduced their business once, so the finished draft seeds the workspace
 * (brand profile, knowledge docs, research profile) without a review click.
 */
describe('BrandAnalysisService — autoApply', () => {
  const RUN = { id: 'run1', workspaceId: 'ws1', status: 'QUEUED', inputs: { websiteUrl: 'https://acme.example', autoApply: true } };

  function primeHappyPath(deps: ReturnType<typeof makeSvc>) {
    deps.prisma.brandAnalysisRun.findUnique.mockResolvedValue({ ...RUN });
    deps.prisma.brandAnalysisRun.update.mockResolvedValue({});
    deps.prisma.workspace.findUnique.mockResolvedValue({ defaultLanguage: 'tr' });
    for (const src of [deps.website, deps.social, deps.gbp, deps.upload]) {
      src.collect.mockResolvedValue({ source: 'website', status: 'inert', raw: null });
    }
    deps.synthesis.synthesize.mockResolvedValue({ profile: { brandName: 'Acme' } });
  }

  it('applies the draft as soon as synthesis finishes', async () => {
    const deps = makeSvc();
    primeHappyPath(deps);

    await deps.svc.runAnalysis('run1');

    expect(deps.applyService.apply).toHaveBeenCalledWith('ws1', 'run1');
  });

  it('leaves the run READY_FOR_REVIEW when auto-apply fails (manual path still works)', async () => {
    const deps = makeSvc();
    primeHappyPath(deps);
    deps.applyService.apply.mockRejectedValue(new Error('knowledge cap'));

    await expect(deps.svc.runAnalysis('run1')).resolves.toBeUndefined();

    // The terminal status write happened BEFORE the apply attempt, so the run
    // is reviewable by hand; the failure must not mark the run FAILED.
    const statuses = deps.prisma.brandAnalysisRun.update.mock.calls.map((c: any) => c[0].data.status);
    expect(statuses).toContain('READY_FOR_REVIEW');
    expect(statuses).not.toContain('FAILED');
  });

  it('does not apply when the flag is absent (review flow unchanged)', async () => {
    const deps = makeSvc();
    primeHappyPath(deps);
    deps.prisma.brandAnalysisRun.findUnique.mockResolvedValue({ ...RUN, inputs: { websiteUrl: 'https://acme.example' } });

    await deps.svc.runAnalysis('run1');

    expect(deps.applyService.apply).not.toHaveBeenCalled();
  });
});
