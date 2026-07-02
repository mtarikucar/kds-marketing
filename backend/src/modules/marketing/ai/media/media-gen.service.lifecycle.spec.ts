import { MediaGenService } from './media-gen.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    generatedAsset: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const credits = { reserve: jest.fn(), refund: jest.fn().mockResolvedValue(undefined) };
  const provider = { name: 'fal', isConfigured: () => true, submit: jest.fn(), getResult: jest.fn() };
  const jobs = { schedule: jest.fn() };
  const r2 = { isConfigured: () => true, deleteKeys: jest.fn().mockResolvedValue(undefined) };
  const runner = { registerHandler: jest.fn() };
  const svc = new MediaGenService(prisma, credits as any, provider as any, jobs as any, r2 as any, runner as any);
  return { svc, prisma, credits, provider, r2 };
}

describe('MediaGenService.deleteAsset', () => {
  it('refunds the reservation when deleting an in-flight (GENERATING) asset', async () => {
    const { svc, prisma, credits, r2 } = makeSvc();
    prisma.generatedAsset.findFirst.mockResolvedValue({
      id: 'a1', workspaceId: WS, status: 'GENERATING', costCreditsReserved: 15, r2Key: null, thumbnailR2Key: null,
    });
    await svc.deleteAsset(WS, 'a1');
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1', status: { notIn: ['READY', 'FAILED', 'BLOCKED'] } },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(credits.refund).toHaveBeenCalledWith(WS, 15);
    expect(r2.deleteKeys).toHaveBeenCalled();
    expect(prisma.generatedAsset.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
  });

  it('does not refund when deleting a terminal (READY) asset', async () => {
    const { svc, prisma, credits } = makeSvc();
    prisma.generatedAsset.findFirst.mockResolvedValue({
      id: 'a1', workspaceId: WS, status: 'READY', costCreditsReserved: 15, r2Key: 'k', thumbnailR2Key: null,
    });
    await svc.deleteAsset(WS, 'a1');
    expect(prisma.generatedAsset.updateMany).not.toHaveBeenCalled();
    expect(credits.refund).not.toHaveBeenCalled();
    expect(prisma.generatedAsset.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
  });
});

describe('MediaGenService.pollGeneration timeout', () => {
  it('fails + refunds an asset stuck past the max generation age (no more provider polling)', async () => {
    const { svc, prisma, credits, provider } = makeSvc();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago > MAX_GEN_AGE (1h default)
    prisma.generatedAsset.findUnique.mockResolvedValue({
      status: 'GENERATING', model: 'fal-ai/qwen-image', providerRequestId: 'req-1',
      createdAt: old, workspaceId: WS, costCreditsReserved: 3,
    });
    await svc.pollGeneration('a1', WS);
    expect(provider.getResult).not.toHaveBeenCalled();
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1', status: { notIn: ['READY', 'FAILED', 'BLOCKED'] } },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(credits.refund).toHaveBeenCalledWith(WS, 3);
  });

  it('keeps polling (reschedules) while still in progress and within the age window', async () => {
    const { svc, prisma, provider } = makeSvc();
    prisma.generatedAsset.findUnique.mockResolvedValue({
      status: 'GENERATING', model: 'fal-ai/qwen-image', providerRequestId: 'req-1',
      createdAt: new Date(), workspaceId: WS, costCreditsReserved: 3,
    });
    provider.getResult.mockResolvedValue({ status: 'IN_PROGRESS' });
    const res = await svc.pollGeneration('a1', WS);
    expect(provider.getResult).toHaveBeenCalled();
    expect(res).toEqual({ reschedule: expect.objectContaining({ runAt: expect.any(Date) }) });
  });
});
