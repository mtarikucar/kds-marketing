import { MediaGenService, MEDIA_GEN_CLEANUP_KIND } from './media-gen.service';

function makeSvc(rows: any[]) {
  const prisma: any = {
    generatedAsset: {
      findMany: jest.fn().mockResolvedValue(rows),
      deleteMany: jest.fn().mockResolvedValue({ count: rows.length }),
    },
  };
  const jobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const r2 = { isConfigured: () => true, deleteKeys: jest.fn().mockResolvedValue(undefined) };
  const runner = { registerHandler: jest.fn() };
  const svc = new MediaGenService(prisma, {} as any, { isConfigured: () => true } as any, jobs as any, r2 as any, runner as any);
  return { svc, prisma, r2, runner };
}

describe('MediaGenService.sweepOrphanAssets', () => {
  it('deletes R2 keys then the rows for old READY unattached assets', async () => {
    const { svc, prisma, r2 } = makeSvc([
      { id: 'a1', r2Key: 'social/ws/a.png', thumbnailR2Key: null },
      { id: 'a2', r2Key: 'social/ws/b.mp4', thumbnailR2Key: 'social/ws/b.jpg' },
    ]);
    const res = await svc.sweepOrphanAssets();
    expect(prisma.generatedAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'READY', socialCampaignId: null }),
    }));
    expect(r2.deleteKeys).toHaveBeenCalledWith(['social/ws/a.png', 'social/ws/b.mp4', 'social/ws/b.jpg']);
    expect(prisma.generatedAsset.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a1', 'a2'] } } });
    expect(res).toEqual({ deleted: 2 });
  });

  it('registers the cleanup kind on init', () => {
    const { svc, runner } = makeSvc([]);
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(MEDIA_GEN_CLEANUP_KIND, expect.any(Function));
  });
});
