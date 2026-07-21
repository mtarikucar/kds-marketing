import { BrandAnalysisRunnerService } from './brand-analysis.runner';
import { BRAND_ANALYZE_KIND } from './brand-analysis.service';

describe('BrandAnalysisRunnerService', () => {
  it('registers the brand-brain.analyze handler on module init', () => {
    const runner: any = { registerHandler: jest.fn() };
    const analysis: any = { runAnalysis: jest.fn() };
    const prisma: any = { $executeRaw: jest.fn().mockResolvedValue(0) };
    const svc = new BrandAnalysisRunnerService(runner, analysis, prisma);

    svc.onModuleInit();

    expect(runner.registerHandler).toHaveBeenCalledWith(BRAND_ANALYZE_KIND, expect.any(Function));
  });

  it('the registered handler delegates to runAnalysis with the job payload runId', async () => {
    const runner: any = { registerHandler: jest.fn() };
    const analysis: any = { runAnalysis: jest.fn() };
    const prisma: any = { $executeRaw: jest.fn().mockResolvedValue(0) };
    const svc = new BrandAnalysisRunnerService(runner, analysis, prisma);

    svc.onModuleInit();
    const handler = runner.registerHandler.mock.calls[0][1];

    await handler({ id: 'job1', workspaceId: 'ws1', kind: BRAND_ANALYZE_KIND, payload: { runId: 'r1' }, attempts: 0 });
    expect(analysis.runAnalysis).toHaveBeenCalledWith('r1');

    analysis.runAnalysis.mockClear();
    await handler({ id: 'job2', workspaceId: 'ws1', kind: BRAND_ANALYZE_KIND, payload: {}, attempts: 0 });
    expect(analysis.runAnalysis).not.toHaveBeenCalled();
  });

  describe('reapStaleRuns', () => {
    it('flips runs stuck RUNNING past the stale threshold to FAILED via raw SQL', async () => {
      const runner: any = { registerHandler: jest.fn() };
      const analysis: any = { runAnalysis: jest.fn() };
      const prisma: any = { $executeRaw: jest.fn().mockResolvedValue(0) };
      const svc = new BrandAnalysisRunnerService(runner, analysis, prisma);

      await svc.reapStaleRuns();

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('swallows errors (best-effort) instead of throwing', async () => {
      const runner: any = { registerHandler: jest.fn() };
      const analysis: any = { runAnalysis: jest.fn() };
      const prisma: any = { $executeRaw: jest.fn().mockRejectedValueOnce(new Error('db down')) };
      const svc = new BrandAnalysisRunnerService(runner, analysis, prisma);

      await expect(svc.reapStaleRuns()).resolves.toBeUndefined();
    });
  });
});
