import { BadRequestException } from '@nestjs/common';
import { BrandKitService } from './brand-kit.service';

const WS = 'ws-1';
function makeSvc(existing: any = null) {
  const prisma: any = {
    brandKit: {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockImplementation(({ create, update }) => ({ id: 'bk-1', workspaceId: WS, ...(existing ? update : create) })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'bk-1', workspaceId: WS, ...data })),
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'bk-1', ...data })),
    },
  };
  const r2 = { isConfigured: jest.fn().mockReturnValue(true), upload: jest.fn().mockResolvedValue({ url: 'https://r2/ref.png', key: 'social/ws-1/ref.png', mime: 'image/png' }) };
  return { svc: new BrandKitService(prisma, r2 as any), prisma, r2 };
}

describe('BrandKitService', () => {
  it('upserts one kit per workspace', async () => {
    const { svc, prisma } = makeSvc();
    await svc.upsert(WS, { tone: 'playful', defaultHashtags: ['#x'] });
    expect(prisma.brandKit.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS },
      create: expect.objectContaining({ workspaceId: WS, tone: 'playful' }),
    }));
  });

  it('uploads a reference image to R2 and appends it (cap 5)', async () => {
    const { svc, prisma, r2 } = makeSvc({ id: 'bk-1', workspaceId: WS, referenceImages: [] });
    const res = await svc.addReferenceImage(WS, { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 });
    expect(r2.upload).toHaveBeenCalledWith(WS, expect.objectContaining({ mimetype: 'image/png' }));
    expect(res).toEqual({ url: 'https://r2/ref.png', r2Key: 'social/ws-1/ref.png', mime: 'image/png' });
    expect(prisma.brandKit.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { referenceImages: [{ url: 'https://r2/ref.png', r2Key: 'social/ws-1/ref.png', mime: 'image/png' }] },
    }));
  });

  it('rejects a 6th reference image', async () => {
    const five = [1, 2, 3, 4, 5].map((i) => ({ url: `u${i}`, r2Key: `k${i}`, mime: 'image/png' }));
    const { svc } = makeSvc({ id: 'bk-1', workspaceId: WS, referenceImages: five });
    await expect(svc.addReferenceImage(WS, { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects upload when R2 is not configured', async () => {
    const { svc, r2 } = makeSvc({ id: 'bk-1', workspaceId: WS, referenceImages: [] });
    r2.isConfigured.mockReturnValue(false);
    await expect(svc.addReferenceImage(WS, { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
