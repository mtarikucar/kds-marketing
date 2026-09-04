import { BadRequestException } from '@nestjs/common';
import { MediaGenService } from './media-gen.service';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from './media-models.config';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';

/**
 * İçerik üretim hattı, aşama 3 — WHERE the resolution order lives.
 *
 * The order is `explicit (a campaign override) ?? workspace default ?? code
 * constant`, and it is enforced in ONE place: `requestGeneration`. That is a
 * deliberate departure from the plan, which named
 * `concept-promotion.service.ts` as the insertion point. Two facts decided it:
 *
 *  1. There are TWO producers, not one. `concept-promotion.service.ts:441` and
 *     `social-campaigns.service.ts:499` both spend on clips, and both already
 *     pass the campaign override when it exists and pass NOTHING when it does
 *     not. Resolving inside either of them leaves the other on the code
 *     constant, and "keep them consistent" then means writing the same lookup
 *     twice and hoping the third producer copies it.
 *  2. `jeeta.generate_image` and `jeeta.generate_video` have promised
 *     "Defaults to the workspace default" in their published tool descriptions
 *     since they shipped. Until this change that sentence was false. Resolving
 *     at the shared write makes it true, rather than adding a fourth place
 *     where it is still false.
 *
 * The read is skipped entirely when the caller named a model, so the campaign
 * override still costs no query.
 */
function makeSvc(workspace: unknown = { defaultImageModel: null, defaultVideoModel: null }) {
  const prisma: any = {
    workspace: { findUnique: jest.fn().mockResolvedValue(workspace) },
    generatedAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialCampaign: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
    socialCampaignItem: { findFirst: jest.fn().mockResolvedValue({ id: 'ci-1' }) },
  };
  const credits = {
    reserve: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const provider = {
    name: 'fal',
    isConfigured: jest.fn().mockReturnValue(true),
    submit: jest.fn().mockResolvedValue({ providerRequestId: 'req-9' }),
    getResult: jest.fn(),
  };
  const jobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const r2 = { isConfigured: jest.fn().mockReturnValue(true) };
  const runner = { registerHandler: jest.fn() };
  const svc = new MediaGenService(
    prisma,
    credits as any,
    provider as any,
    jobs as any,
    r2 as any,
    runner as any,
    undefined as any,
    { settle: jest.fn().mockResolvedValue(null) } as any,
  );
  return { svc, prisma, credits };
}

/** The model actually written onto the asset row — the only answer that matters,
 *  because that row is what the provider is called with and what is billed. */
function modelWritten(prisma: any): string {
  return prisma.generatedAsset.create.mock.calls[0][0].data.model;
}

describe('MediaGenService — model resolution order', () => {
  it('uses the code constant when the workspace has set no default', async () => {
    const { svc, prisma } = makeSvc();
    await svc.requestGeneration(WS, { type: 'VIDEO', prompt: 'x', createdById: 'u1' });
    expect(modelWritten(prisma)).toBe(DEFAULT_VIDEO_MODEL);
  });

  it('uses the workspace default over the code constant', async () => {
    const { svc, prisma, credits } = makeSvc({
      defaultImageModel: 'fal-ai/qwen-image',
      defaultVideoModel: 'fal-ai/veo3.1/fast',
    });
    await svc.requestGeneration(WS, { type: 'VIDEO', prompt: 'x', durationSec: 4, createdById: 'u1' });
    expect(modelWritten(prisma)).toBe('fal-ai/veo3.1/fast');
    // And it is PRICED as that model, not as the constant: 15 credits/sec x 4.
    expect(credits.reserve).toHaveBeenCalledWith(WS, 60);
  });

  it('picks the default belonging to the kind being generated', async () => {
    const { svc, prisma } = makeSvc({
      defaultImageModel: 'fal-ai/qwen-image',
      defaultVideoModel: 'fal-ai/veo3.1/fast',
    });
    await svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' });
    expect(modelWritten(prisma)).toBe('fal-ai/qwen-image');
  });

  it('lets an explicit model (the campaign override) beat the workspace default', async () => {
    const { svc, prisma } = makeSvc({
      defaultImageModel: null,
      defaultVideoModel: 'fal-ai/veo3.1/fast',
    });
    await svc.requestGeneration(WS, {
      type: 'VIDEO',
      prompt: 'x',
      model: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
      createdById: 'u1',
    });
    expect(modelWritten(prisma)).toBe('fal-ai/bytedance/seedance/v1/pro/text-to-video');
    // The override costs no query — the workspace is not even read.
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  /**
   * Tenant isolation, with its own assertion rather than a shared one: the
   * default that is read must be THIS workspace's. A `findUnique` that dropped
   * the id would return whatever row came first and silently spend another
   * tenant's chosen (possibly ten-times-pricier) model.
   */
  it('reads the default of the CALLING workspace only', async () => {
    const { svc, prisma } = makeSvc();
    await svc.requestGeneration(OTHER_WS, { type: 'VIDEO', prompt: 'x', createdById: 'u1' });
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_WS } }),
    );
    expect(prisma.workspace.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WS } }),
    );
  });

  /**
   * Error is not silence. A stored default that has fallen out of the catalogue
   * (a model retired in code while a row still names it) must not be run — its
   * price is unknown, which is exactly what the explicit-id guard refuses. It
   * falls back to the constant so a retired catalogue entry cannot stop a
   * workspace generating at all, and it SAYS SO in the log rather than quietly
   * charging a different rate than the settings screen shows.
   */
  it('falls back to the code constant, loudly, when the stored default left the catalogue', async () => {
    const { svc, prisma } = makeSvc({
      defaultImageModel: null,
      defaultVideoModel: 'fal-ai/retired-model',
    });
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    await svc.requestGeneration(WS, { type: 'VIDEO', prompt: 'x', createdById: 'u1' });
    expect(modelWritten(prisma)).toBe(DEFAULT_VIDEO_MODEL);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fal-ai/retired-model'));
  });

  it('falls back to the code constant when a stored default is of the wrong kind', async () => {
    const { svc, prisma } = makeSvc({
      defaultImageModel: null,
      defaultVideoModel: DEFAULT_IMAGE_MODEL,
    });
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    await svc.requestGeneration(WS, { type: 'VIDEO', prompt: 'x', createdById: 'u1' });
    expect(modelWritten(prisma)).toBe(DEFAULT_VIDEO_MODEL);
  });

  /**
   * The pre-existing refusal, tightened: a catalogued id of the WRONG kind used
   * to pass, because the guard only asked whether the id was in the catalogue
   * at all. An image model on a video request would then be billed at the flat
   * per-image rate for a per-second clip.
   */
  it('refuses an explicit catalogued model of the wrong kind', async () => {
    const { svc, credits } = makeSvc();
    await expect(
      svc.requestGeneration(WS, {
        type: 'VIDEO',
        prompt: 'x',
        model: DEFAULT_IMAGE_MODEL,
        createdById: 'u1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('still refuses an explicit uncatalogued model', async () => {
    const { svc } = makeSvc();
    await expect(
      svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', model: 'fal-ai/nope', createdById: 'u1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
