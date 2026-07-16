import { BrandAnalysisService } from './brand-analysis.service';

function makeSvc() {
  const prisma: any = {
    brandAnalysisRun: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
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
  const svc = new BrandAnalysisService(
    prisma,
    synthesis,
    spend,
    scheduledJob,
    website,
    social,
    gbp,
    upload,
  );
  return { svc, prisma, synthesis, spend, scheduledJob, website, social, gbp, upload };
}

describe('BrandAnalysisService', () => {
  describe('startAnalysis', () => {
    it('creates a QUEUED run and schedules the async analyze job (deduped per workspace)', async () => {
      const { svc, prisma, scheduledJob } = makeSvc();
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

    it('is idempotent: a non-QUEUED run is a no-op', async () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findUnique.mockResolvedValue({ id: 'run1', workspaceId: 'ws1', status: 'RUNNING' });

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
