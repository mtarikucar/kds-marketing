import { MediaGenService } from './media-gen.service';

const WS = 'ws-1';
function buf() { return Buffer.from('binary'); }

function makeSvc(asset: any) {
  const prisma: any = {
    generatedAsset: {
      findUnique: jest.fn().mockResolvedValue(asset),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const provider = { name: 'fal', isConfigured: () => true, submit: jest.fn(), getResult: jest.fn() };
  const jobs = { schedule: jest.fn() };
  const r2 = { isConfigured: () => true, upload: jest.fn().mockResolvedValue({ url: 'https://r2/cat.png', key: 'social/ws-1/x.png', mime: 'image/png' }), deleteKeys: jest.fn().mockResolvedValue(undefined) };
  const runner = { registerHandler: jest.fn() };
  const mediaSpend = { settle: jest.fn().mockResolvedValue(null) };
  const svc = new MediaGenService(prisma, credits as any, provider as any, jobs as any, r2 as any, runner as any, undefined as any, mediaSpend as any);
  // stub the server-side download so no real network call
  (svc as any).download = jest.fn().mockResolvedValue({ buffer: buf(), size: 6 });
  return { svc, prisma, credits, provider, r2, mediaSpend };
}

const QUEUED = { id: 'a1', workspaceId: WS, status: 'GENERATING', model: 'fal-ai/qwen-image', costCreditsReserved: 2, params: {}, type: 'IMAGE' };

describe('MediaGenService.finalizeAsset', () => {
  it('records what the generation cost US, on the trued-up credit count', async () => {
    // fal was the last vendor whose cost never reached the spend ledger, and
    // the gap was exactly this: nothing called a settle. Without an assertion
    // on the wiring, deleting the call again would break no test.
    const { svc, mediaSpend } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'COMPLETED', outputs: [{ url: 'https://fal/cat.png', mime: 'image/png' }] });
    expect(mediaSpend.settle).toHaveBeenCalledWith(WS, { assetId: 'a1', credits: 2 });
  });

  it('does not bill for a generation that failed', async () => {
    const { svc, mediaSpend } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'FAILED', error: 'provider said no' });
    expect(mediaSpend.settle).not.toHaveBeenCalled();
  });

  it('COMPLETED → downloads, uploads to R2, sets READY, reconciles credits', async () => {
    const { svc, prisma, r2 } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'COMPLETED', outputs: [{ url: 'https://fal/cat.png', mime: 'image/png', width: 1024, height: 1024 }] });
    expect(r2.upload).toHaveBeenCalledWith(WS, expect.objectContaining({ mimetype: 'image/png' }));
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1', status: { notIn: ['READY', 'FAILED', 'BLOCKED'] } },
      data: expect.objectContaining({ status: 'READY', url: 'https://r2/cat.png', r2Key: 'social/ws-1/x.png', costCredits: 2 }),
    }));
  });

  it('BLOCKED → refunds the reservation, no R2 upload', async () => {
    const { svc, credits, r2, prisma } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'BLOCKED', error: 'NSFW' });
    expect(r2.upload).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledWith(WS, 2);
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'BLOCKED', error: 'NSFW' }),
    }));
  });

  it('FAILED → refunds the reservation', async () => {
    const { svc, credits } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'FAILED', error: 'boom' });
    expect(credits.refund).toHaveBeenCalledWith(WS, 2);
  });

  it('is a no-op when the asset is already terminal (idempotent)', async () => {
    const { svc, credits, r2 } = makeSvc({ ...QUEUED, status: 'READY' });
    await svc.finalizeAsset('a1', { status: 'COMPLETED', outputs: [{ url: 'u', mime: 'image/png' }] });
    expect(r2.upload).not.toHaveBeenCalled();
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('does not double-refund when the claim is lost (count 0)', async () => {
    const { svc, prisma, credits } = makeSvc({ ...QUEUED });
    prisma.generatedAsset.updateMany.mockResolvedValue({ count: 0 });
    await svc.finalizeAsset('a1', { status: 'FAILED', error: 'boom' });
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('COMPLETED but download/upload fails → terminalizes FAILED + refunds (not stuck GENERATING)', async () => {
    const { svc, prisma, credits, r2 } = makeSvc({ ...QUEUED });
    (svc as any).download = jest.fn().mockRejectedValue(new Error('R2 down'));
    await svc.finalizeAsset('a1', { status: 'COMPLETED', outputs: [{ url: 'https://fal/cat.png', mime: 'image/png' }] });
    expect(r2.upload).not.toHaveBeenCalled();
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1', status: { notIn: ['READY', 'FAILED', 'BLOCKED'] } },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(credits.refund).toHaveBeenCalledWith(WS, 2);
  });

  it('COMPLETED but the finalize race is lost (count 0) → deletes the orphaned R2 object, no reconcile', async () => {
    const { svc, prisma, credits, r2 } = makeSvc({ ...QUEUED });
    prisma.generatedAsset.updateMany.mockResolvedValue({ count: 0 });
    await svc.finalizeAsset('a1', { status: 'COMPLETED', outputs: [{ url: 'https://fal/cat.png', mime: 'image/png' }] });
    expect(r2.deleteKeys).toHaveBeenCalledWith(['social/ws-1/x.png']);
    expect(credits.refund).not.toHaveBeenCalled();
  });
});
