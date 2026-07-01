import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { MediaGenService, MEDIA_GEN_POLL_KIND } from './media-gen.service';
import { DEFAULT_IMAGE_MODEL } from './media-models.config';

const WS = 'ws-1';
function makeSvc() {
  const prisma: any = {
    generatedAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const provider = { name: 'fal', isConfigured: jest.fn().mockReturnValue(true), submit: jest.fn().mockResolvedValue({ providerRequestId: 'req-9' }), getResult: jest.fn() };
  const jobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const r2 = { isConfigured: jest.fn().mockReturnValue(true) };
  const runner = { registerHandler: jest.fn() };
  const svc = new MediaGenService(prisma, credits as any, provider as any, jobs as any, r2 as any, runner as any);
  return { svc, prisma, credits, provider, jobs };
}

describe('MediaGenService.requestGeneration', () => {
  it('rejects when the provider is not configured', async () => {
    const { svc, provider } = makeSvc();
    provider.isConfigured.mockReturnValue(false);
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects over the per-workspace in-flight cap', async () => {
    const { svc, prisma } = makeSvc();
    prisma.generatedAsset.count.mockResolvedValue(4);
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('reserves credits, creates QUEUED, submits, stores requestId, schedules the poll', async () => {
    const { svc, prisma, credits, provider, jobs } = makeSvc();
    const res = await svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'a cat', createdById: 'u1' });

    expect(res).toEqual({ assetId: 'asset-1' });
    // reserve BEFORE submit, with the per-model estimate (default image model → 3)
    expect(credits.reserve).toHaveBeenCalledWith(WS, 3);
    expect(prisma.generatedAsset.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: WS, status: 'QUEUED', provider: 'fal', model: DEFAULT_IMAGE_MODEL, costCreditsReserved: 3 }),
    }));
    expect(provider.submit).toHaveBeenCalled();
    expect(prisma.generatedAsset.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asset-1' },
      data: expect.objectContaining({ status: 'GENERATING', providerRequestId: 'req-9' }),
    }));
    expect(jobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: MEDIA_GEN_POLL_KIND, workspaceId: WS,
      payload: { assetId: 'asset-1', workspaceId: WS }, dedupKey: 'media-gen-asset-1',
    }));
  });

  it('refunds and marks FAILED when provider.submit throws', async () => {
    const { svc, prisma, credits, provider } = makeSvc();
    provider.submit.mockRejectedValue(new Error('fal 500'));
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' })).rejects.toThrow('fal 500');
    expect(credits.refund).toHaveBeenCalledWith(WS, 3);
    expect(prisma.generatedAsset.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asset-1' }, data: expect.objectContaining({ status: 'FAILED' }),
    }));
  });

  it('refunds the reservation when the asset create() itself throws (no leaked credits)', async () => {
    const { svc, prisma, credits, provider } = makeSvc();
    prisma.generatedAsset.create.mockRejectedValue(new Error('DB down'));
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' })).rejects.toThrow('DB down');
    expect(credits.reserve).toHaveBeenCalledWith(WS, 3);
    expect(credits.refund).toHaveBeenCalledWith(WS, 3);
    expect(provider.submit).not.toHaveBeenCalled();
  });
});
