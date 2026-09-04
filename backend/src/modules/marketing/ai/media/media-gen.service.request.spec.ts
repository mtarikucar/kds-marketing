import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { MediaGenService, MEDIA_GEN_POLL_KIND } from './media-gen.service';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, RETIRED_SEEDANCE_LITE_MODEL } from './media-models.config';

const WS = 'ws-1';
function makeSvc(links: { campaign?: unknown; item?: unknown } = {}) {
  const prisma: any = {
    generatedAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      update: jest.fn().mockResolvedValue({}),
      // failTerminal's conditional claim: count 1 = this path won the → FAILED
      // transition (→ refund); count 0 = already terminalized (no double-refund).
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialCampaign: {
      findFirst: jest
        .fn()
        .mockResolvedValue(links.campaign === undefined ? { id: 'c1' } : links.campaign),
    },
    // Stage 3: requestGeneration now resolves the workspace-level default model
    // when the caller names none. No default set here -> the code constant, which
    // is what every assertion in this file was written against.
    workspace: { findUnique: jest.fn().mockResolvedValue({ defaultImageModel: null, defaultVideoModel: null }) },
    socialCampaignItem: {
      findFirst: jest
        .fn()
        .mockResolvedValue(links.item === undefined ? { id: 'ci-1' } : links.item),
    },
  };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const provider = { name: 'fal', isConfigured: jest.fn().mockReturnValue(true), submit: jest.fn().mockResolvedValue({ providerRequestId: 'req-9' }), getResult: jest.fn() };
  const jobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const r2 = { isConfigured: jest.fn().mockReturnValue(true) };
  const runner = { registerHandler: jest.fn() };
  const svc = new MediaGenService(prisma, credits as any, provider as any, jobs as any, r2 as any, runner as any, undefined as any, { settle: jest.fn().mockResolvedValue(null) } as any);
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

  it('refunds via the conditional claim (not unconditionally) and marks FAILED when provider.submit throws', async () => {
    const { svc, prisma, credits, provider } = makeSvc();
    provider.submit.mockRejectedValue(new Error('fal 500'));
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' })).rejects.toThrow('fal 500');
    // Terminalize via the SAME conditional claim the poll/webhook + sweep use, then
    // refund only because THIS path won it (count 1) — so the refund can't fire twice.
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asset-1', status: { notIn: ['READY', 'FAILED', 'BLOCKED'] } },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(credits.refund).toHaveBeenCalledWith(WS, 3);
  });

  it('does NOT double-refund on submit failure when the row was already terminalized (claim lost)', async () => {
    const { svc, prisma, credits, provider } = makeSvc();
    provider.submit.mockRejectedValue(new Error('fal 500'));
    // The FAILED claim matches 0 rows — another path (e.g. the orphan sweep) already
    // terminalized + refunded this reservation, so the catch must NOT refund again.
    prisma.generatedAsset.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' })).rejects.toThrow('fal 500');
    expect(credits.refund).not.toHaveBeenCalled();
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

/**
 * The campaign linkage on a generation is not decoration: `socialCampaignId`
 * exempts an asset from `sweepOrphanAssets`' 30-day delete, and
 * `campaignItemId` puts it on the ENGINE path, where an armed autonomous budget
 * pre-debits the growth wallet in REAL CASH before the provider is engaged.
 *
 * Both were previously accepted on trust, which was fine while every caller was
 * server-side code passing ids it had just read. `jeeta.generate_video` now
 * accepts them from a model, so they are checked HERE — at the write — rather
 * than in the one tool, so no future caller reopens the hole.
 */
describe('MediaGenService.requestGeneration — the campaign linkage is proven, not trusted', () => {
  const linked = { type: 'IMAGE' as const, prompt: 'x', createdById: 'u1', socialCampaignId: 'c1', campaignItemId: 'ci-1' };

  it('checks the campaign belongs to THIS workspace', async () => {
    const { svc, prisma } = makeSvc();
    await svc.requestGeneration(WS, linked);
    expect(prisma.socialCampaign.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1', workspaceId: WS } }),
    );
  });

  it('checks the campaign ITEM belongs to this workspace too', async () => {
    const { svc, prisma } = makeSvc();
    await svc.requestGeneration(WS, linked);
    expect(prisma.socialCampaignItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ci-1', workspaceId: WS } }),
    );
  });

  it('refuses a neighbour campaign id BEFORE reserving anything', async () => {
    const { svc, credits, provider } = makeSvc({ campaign: null });
    await expect(svc.requestGeneration(WS, linked)).rejects.toBeInstanceOf(BadRequestException);
    // Nothing spent, nothing submitted: an unowned id is a rejected request,
    // not a refunded one.
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('refuses a neighbour campaign ITEM id BEFORE reserving anything', async () => {
    const { svc, credits, provider } = makeSvc({ item: null });
    await expect(svc.requestGeneration(WS, linked)).rejects.toBeInstanceOf(BadRequestException);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('does not read a campaign when none was named', async () => {
    // The common case is an unlinked one-off generation. Two extra round trips
    // on every image would be a real cost for a check with nothing to check.
    const { svc, prisma } = makeSvc();
    await svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' });
    expect(prisma.socialCampaign.findFirst).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.findFirst).not.toHaveBeenCalled();
  });
});

describe('MediaGenService.requestGeneration — vendors and retired ids', () => {
  it('runs a fal-retired model on its successor and records which vendor took it', async () => {
    const { svc, prisma, provider } = makeSvc();
    (provider as any).resolveName = jest.fn().mockReturnValue('runware');
    await svc.requestGeneration(WS, { type: 'VIDEO', model: RETIRED_SEEDANCE_LITE_MODEL, prompt: 'x', createdById: 'u1' });
    const data = prisma.generatedAsset.create.mock.calls[0][0].data;
    expect(data.model).toBe(DEFAULT_VIDEO_MODEL);
    expect(data.provider).toBe('runware');
    expect((provider as any).resolveName).toHaveBeenCalledWith(DEFAULT_VIDEO_MODEL);
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_VIDEO_MODEL }));
  });

  it('falls back to provider.name when the provider cannot name a vendor per model', async () => {
    const { svc, prisma } = makeSvc();
    await svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' });
    expect(prisma.generatedAsset.create.mock.calls[0][0].data.provider).toBe('fal');
  });
});

describe('MediaGenService.regenerate — rows on a fal-retired model', () => {
  const ROW = {
    id: 'old', workspaceId: WS, type: 'VIDEO', model: RETIRED_SEEDANCE_LITE_MODEL, prompt: 'p', negativePrompt: null,
    params: { aspectRatio: '4:5' }, durationSec: 5, socialCampaignId: null,
  };

  it('drops a replayed ratio the successor does not publish instead of 400ing the re-run', async () => {
    const { svc, prisma, provider } = makeSvc();
    prisma.generatedAsset.findFirst = jest.fn().mockResolvedValue(ROW);
    await svc.regenerate(WS, 'old', 'u1');
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_VIDEO_MODEL, aspectRatio: undefined }));
  });

  it('keeps a replayed ratio the successor does publish', async () => {
    const { svc, prisma, provider } = makeSvc();
    prisma.generatedAsset.findFirst = jest.fn().mockResolvedValue({ ...ROW, params: { aspectRatio: '9:16' } });
    await svc.regenerate(WS, 'old', 'u1');
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_VIDEO_MODEL, aspectRatio: '9:16' }));
  });
});
