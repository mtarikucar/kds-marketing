import { BadRequestException } from '@nestjs/common';
import { MediaGenService } from './media-gen.service';
import { MEDIA_MODELS, DEFAULT_VIDEO_MODEL } from './media-models.config';

const WS = 'ws-1';

interface SvcOpts {
  /** A row `getAsset`/`regenerate` should resolve to. */
  asset?: unknown;
}

function makeSvc(opts: SvcOpts = {}) {
  const prisma: any = {
    // The model is resolved `campaign override ?? workspace default ?? code
    // constant`, so every generation now reads the workspace first. A harness
    // without this row throws before the assertion it was written for.
    workspace: { findUnique: jest.fn().mockResolvedValue(null) },
    generatedAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      findFirst: jest.fn(async () => opts.asset ?? null),
    },
  };
  const credits = {
    reserve: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
    chargeOverage: jest.fn().mockResolvedValue(undefined),
  };
  const provider = {
    name: 'fal', isConfigured: () => true,
    submit: jest.fn().mockResolvedValue({ providerRequestId: 'req-9' }), getResult: jest.fn(),
  };
  const jobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const r2 = {
    isConfigured: () => true,
    upload: jest.fn().mockResolvedValue({ url: 'https://r2/a.mp4', key: 'k', mime: 'video/mp4' }),
    deleteKeys: jest.fn().mockResolvedValue(undefined),
    keyPrefix: (ws: string) => `social/${ws}/`,
  };
  const runner = { registerHandler: jest.fn() };
  const mediaSpend = { settle: jest.fn().mockResolvedValue(null) };
  const svc = new MediaGenService(
    prisma, credits as any, provider as any, jobs as any, r2 as any, runner as any,
    undefined as any, mediaSpend as any,
  );
  (svc as any).download = jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), size: 1 });
  return { svc, prisma, credits, provider, mediaSpend };
}

const base = { prompt: 'a product on marble', createdById: 'u1' } as const;

/** A row written by the PRE-catalogue code path: it stored whatever aspect ratio
 *  the old flat provider was handed, whether or not the endpoint published one. */
const legacyRow = (over: Record<string, unknown> = {}) => ({
  id: 'old-1', workspaceId: WS, status: 'READY', type: 'IMAGE',
  model: 'fal-ai/qwen-image', prompt: 'a plate of manti', negativePrompt: null,
  durationSec: null, socialCampaignId: null,
  params: { aspectRatio: '1:1', referenceImageUrls: [] },
  ...over,
});

describe('MediaGenService — input contract enforcement', () => {
  it('refuses an edit whose required source image is missing, before reserving credits', async () => {
    // Reaching fal with an unsatisfiable request costs a reserve/refund round
    // trip and shows the customer a raw provider 422.
    const { svc, credits, provider } = makeSvc();
    await expect(svc.requestGeneration(WS, {
      ...base, type: 'IMAGE', model: 'fal-ai/nano-banana-pro/edit',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('refuses an avatar missing the audio track it is driven by', async () => {
    const { svc } = makeSvc();
    await expect(svc.requestGeneration(WS, {
      ...base, type: 'VIDEO', model: 'fal-ai/kling-video/ai-avatar/v2/standard',
      referenceImageUrls: ['https://cdn/face.png'],
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an aspect ratio or resolution the chosen model does not publish', async () => {
    const { svc } = makeSvc();
    // Veo 3.1 is 16:9 / 9:16 only — there is no 1:1.
    await expect(svc.requestGeneration(WS, {
      ...base, type: 'VIDEO', model: 'fal-ai/veo3.1', aspectRatio: '1:1',
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.requestGeneration(WS, {
      ...base, type: 'VIDEO', model: 'fal-ai/veo3.1', resolution: '8k',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the same request once its sources are supplied', async () => {
    const { svc, provider } = makeSvc();
    await svc.requestGeneration(WS, {
      ...base, type: 'IMAGE', model: 'fal-ai/nano-banana-pro/edit',
      referenceImageUrls: ['https://cdn/a.png'],
    });
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      sources: expect.objectContaining({ images: ['https://cdn/a.png'] }),
    }));
  });
});

describe('MediaGenService — asset typing and pricing', () => {
  it('refuses a named model whose KIND does not match the request', async () => {
    // Two guards met here and the stricter one wins. The catalogue's type is
    // authoritative when nothing else settles it (`catalogued?.type ?? dto.type`,
    // which is what keeps an mp3 from being filed as a clip on the paths that
    // name no model). But when the caller DOES name one, a kind mismatch is a
    // mistake worth saying out loud rather than silently reclassifying: the
    // caller asked for a video and would have received an audio file.
    //
    // Nothing in the studio can trigger it — the panel sends the selected
    // MODEL's own type — so this refusal is for the API and MCP callers.
    const { svc, credits, provider } = makeSvc();
    const err = await svc.requestGeneration(WS, {
      ...base, type: 'VIDEO', model: 'fal-ai/elevenlabs/tts/multilingual-v2',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err.getResponse() as { code: string }).code).toBe('MEDIA_GEN_UNKNOWN_MODEL');
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("stores an AUDIO model's output as AUDIO when the caller names no type of its own", async () => {
    const { svc, prisma } = makeSvc();
    await svc.requestGeneration(WS, {
      ...base, type: 'AUDIO', model: 'fal-ai/elevenlabs/tts/multilingual-v2',
    });
    expect(prisma.generatedAsset.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'AUDIO' }),
    }));
  });

  it('reserves the TIER rate for the requested resolution, not the base rate', async () => {
    const { svc, credits } = makeSvc();
    await svc.requestGeneration(WS, {
      ...base, type: 'VIDEO', model: 'bytedance/seedance-2.5/text-to-video',
      resolution: '1080p', durationSec: 5,
    });
    expect(credits.reserve).toHaveBeenCalledWith(WS, 585); // 117 credits/s × 5s
  });

  it('trues the meter up against the SAME tier the reservation used', async () => {
    // finalize re-runs the estimate on the provider's actual duration. If it
    // dropped the tier, a 1080p clip would settle at the 720p rate — a refund of
    // credits we genuinely spent.
    const { svc, prisma, credits, mediaSpend } = makeSvc();
    prisma.generatedAsset.findUnique.mockResolvedValue({
      id: 'a1', workspaceId: WS, status: 'GENERATING',
      model: 'bytedance/seedance-2.5/text-to-video', prompt: 'x',
      costCreditsReserved: 585, durationSec: 5, params: { resolution: '1080p' },
    });
    await svc.finalizeAsset('a1', {
      status: 'COMPLETED',
      outputs: [{ url: 'https://fal/a.mp4', mime: 'video/mp4', durationSec: 5 }],
    });
    expect(mediaSpend.settle).toHaveBeenCalledWith(WS, { assetId: 'a1', credits: 585 });
    expect(credits.refund).not.toHaveBeenCalled();
    expect(credits.chargeOverage).not.toHaveBeenCalled();
  });

  it('lets an audio generation run past the video ceiling', async () => {
    // MEDIA_GEN_MAX_VIDEO_SEC is 10; a 30-second music bed is not a 10-second one.
    const { svc, provider } = makeSvc();
    await svc.requestGeneration(WS, {
      ...base, type: 'AUDIO', model: 'fal-ai/elevenlabs/music', durationSec: 30,
    });
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({ durationSec: 30 }));
  });

  it('regenerates a legacy asset whose stored aspect ratio the model never published', async () => {
    // Rows created before the input contract existed carry an aspectRatio that
    // the old provider sent blindly. Replaying it verbatim now trips the new
    // pre-reserve check — `fal-ai/qwen-image does not take an aspect ratio` —
    // so regenerate 400s on a slice of every workspace's own history.
    const { svc, prisma, provider } = makeSvc();
    prisma.generatedAsset.findFirst = jest.fn().mockResolvedValue(legacyRow());
    await expect(svc.regenerate(WS, 'old-1', 'u1')).resolves.toEqual({ assetId: 'asset-1' });
    expect(provider.submit).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'fal-ai/qwen-image', aspectRatio: undefined }),
    );
  });

  it('regenerates a legacy asset at a ratio the model no longer offers', async () => {
    // Same class, one step subtler: Seedream v4 sizes through ImageSize presets,
    // which have no 4:5 — a ratio the old controller enum happily accepted.
    const { svc, prisma, provider } = makeSvc();
    prisma.generatedAsset.findFirst = jest.fn().mockResolvedValue(legacyRow({
      model: 'fal-ai/bytedance/seedream/v4/text-to-image',
      params: { aspectRatio: '4:5', referenceImageUrls: [] },
    }));
    await expect(svc.regenerate(WS, 'old-1', 'u1')).resolves.toEqual({ assetId: 'asset-1' });
    expect(provider.submit).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: undefined }),
    );
  });

  it('still replays an aspect ratio the model DOES publish', async () => {
    const { svc, prisma, provider } = makeSvc();
    prisma.generatedAsset.findFirst = jest.fn().mockResolvedValue(legacyRow({
      model: 'fal-ai/bytedance/seedream/v4/text-to-image',
      params: { aspectRatio: '9:16', referenceImageUrls: [] },
    }));
    await svc.regenerate(WS, 'old-1', 'u1');
    expect(provider.submit).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: '9:16' }),
    );
  });
});


/**
 * WITHDRAWN MODELS.
 *
 * Four endpoints price themselves by measuring a file the customer supplies.
 * There is no sound way to measure it here — a number in the request body is
 * the payer stating their own bill, and the hand-written container parser that
 * tried to read it off the bytes was wrong in both directions — so they are
 * withheld: catalogued, verified and unserved.
 *
 * Withdrawal has to hold at BOTH doors. The models endpoint dropping them stops
 * a picker offering one; this stops an API caller naming one anyway. Only the
 * second door costs money, so it is the one tested here.
 */
describe('MediaGenService — withdrawn models', () => {
  const WITHHELD = [
    ['fal-ai/topaz/upscale/video', { type: 'VIDEO', videoUrl: 'https://cdn/take.mp4' }],
    ['fal-ai/topaz/upscale/image', { type: 'IMAGE', referenceImageUrls: ['https://cdn/a.png'] }],
    ['fal-ai/latentsync', { type: 'VIDEO', videoUrl: 'https://cdn/t.mp4', audioUrl: 'https://cdn/v.mp3' }],
    ['fal-ai/qwen-image-edit/inpaint', {
      type: 'IMAGE', referenceImageUrls: ['https://cdn/a.png'], maskUrl: 'https://cdn/m.png',
    }],
    ['fal-ai/kling-video/ai-avatar/v2/standard', {
      type: 'VIDEO', referenceImageUrls: ['https://cdn/face.jpg'], audioUrl: 'https://cdn/read.mp3',
    }],
  ] as const;

  it.each(WITHHELD)('refuses %s before anything is reserved or submitted', async (model, extra) => {
    // Every one of these requests is otherwise VALID — required sources present,
    // no bad ratio — so nothing but the withdrawal itself can be doing the
    // refusing. And it happens before the reserve, so a withheld model can never
    // put a hold on a customer's credits.
    const { svc, credits, provider } = makeSvc();
    const err = await svc.requestGeneration(WS, { ...base, model, ...(extra as object) } as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err.getResponse() as { code: string }).code).toBe('MEDIA_GEN_MODEL_WITHHELD');
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('says WHY, in the reason the catalogue carries', async () => {
    // A bare "not available" sends the customer to support to be told the same
    // thing. The catalogue's own paragraph is the answer, so it is what ships.
    const { svc } = makeSvc();
    const err = await svc.requestGeneration(WS, {
      ...base, type: 'VIDEO', model: 'fal-ai/topaz/upscale/video', videoUrl: 'https://cdn/t.mp4',
    }).catch((e) => e);
    const message = String((err.getResponse() as { message: string }).message);
    expect(message).toContain('not available');
    expect(message).toContain('ffprobe');
  });

  it('refuses a REGENERATE of a row that names a withheld model', async () => {
    // A history row is the other way in: re-running one must not reach the
    // reserve either, whatever it was priced at when it was first spent.
    const { svc, credits } = makeSvc({
      asset: {
        id: 'up-1', workspaceId: WS, status: 'READY', type: 'VIDEO',
        model: 'fal-ai/topaz/upscale/video', prompt: '', negativePrompt: null,
        durationSec: 5, socialCampaignId: null,
        params: { videoUrl: 'https://cdn/take.mp4' },
      },
    });
    await expect(svc.regenerate(WS, 'up-1', 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('refuses a withheld model the caller reached by naming NO model at all', async () => {
    // The withdrawal has to be keyed on the model that will actually be
    // generated, not on the id the caller happened to type. A request with no
    // `model` still generates one — the asset type's default — and that is the
    // ordinary shape of the call: `jeeta.generate_video`'s model arg is
    // optional, and the campaign engine passes `undefined` whenever the
    // campaign has no defaultVideoModel set. Gating the check on `dto.model`
    // meant withholding a default removed it from the picker while this POST
    // went on reserving credits and submitting it to fal — the one door the
    // withdrawal exists to shut.
    const entry = MEDIA_MODELS[DEFAULT_VIDEO_MODEL];
    const before = entry.withheld;
    entry.withheld = 'withheld for this test';
    try {
      const { svc, credits, provider } = makeSvc();
      const err = await svc.requestGeneration(WS, { ...base, type: 'VIDEO' }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err.getResponse() as { code: string }).code).toBe('MEDIA_GEN_MODEL_WITHHELD');
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(provider.submit).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete entry.withheld;
      else entry.withheld = before;
    }
  });

  it('still serves the models that were never priced from a file', async () => {
    // The withdrawal is four endpoints, not a technique or a family: the same
    // request shape on a served model goes straight through.
    const { svc, credits, provider } = makeSvc();
    await svc.requestGeneration(WS, {
      ...base, type: 'VIDEO', model: 'fal-ai/pixverse/v6/extend',
      videoUrl: 'https://cdn/take.mp4', durationSec: 5,
    });
    expect(credits.reserve).toHaveBeenCalled();
    expect(provider.submit).toHaveBeenCalled();
  });
});

/**
 * THE TWO MODELS THAT STAYED, AND WHY EACH IS EXACTLY BILLABLE.
 *
 * VEED meters on the SCRIPT, which is in the request — no file is measured.
 * The Kling avatar cannot be asked for a length at all, but it REPORTS one, so
 * its reserve is provisional and finalize settles it. Both claims are load-
 * bearing, so both are tested rather than asserted in a comment.
 */
describe('MediaGenService — the metered models that ship', () => {
  it('refuses an avatar with no script to read, and prices the one it gets', async () => {
    // VEED's output length follows the SCRIPT — it has no duration input and
    // returns none — so the script IS the measurement, and it is already ours.
    const { svc, credits } = makeSvc();
    await expect(svc.requestGeneration(WS, {
      type: 'VIDEO', model: 'veed/avatars/text-to-video', prompt: '   ', createdById: 'u1',
    })).rejects.toBeInstanceOf(BadRequestException);
    await svc.requestGeneration(WS, {
      type: 'VIDEO', model: 'veed/avatars/text-to-video',
      prompt: 'x'.repeat(720), createdById: 'u1',
    });
    expect(credits.reserve).toHaveBeenCalledWith(WS, 60); // 720 chars / 12 per sec
  });

  it('trues a Kling avatar UP to the length fal says it rendered', async () => {
    // The reserve rides the service's 5-second default, because the length
    // follows the AUDIO and cannot be requested. That is only acceptable because
    // the response carries a duration: a 60-second read settles at 360 credits
    // (6/s), not at the 30 that were held. If this true-up ever stops running,
    // the reserve IS the bill and the model is silently under-charged 12x.
    const { svc, prisma, credits, mediaSpend } = makeSvc();
    prisma.generatedAsset.findUnique.mockResolvedValue({
      id: 'a1', workspaceId: WS, status: 'GENERATING',
      model: 'fal-ai/kling-video/ai-avatar/v2/standard', prompt: '.',
      costCreditsReserved: 30, durationSec: 5, params: {},
    });
    await svc.finalizeAsset('a1', {
      status: 'COMPLETED',
      outputs: [{ url: 'https://fal/a.mp4', mime: 'video/mp4', durationSec: 60 }],
    });
    expect(credits.chargeOverage).toHaveBeenCalledWith(WS, 330);
    expect(mediaSpend.settle).toHaveBeenCalledWith(WS, { assetId: 'a1', credits: 360 });
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ durationSec: 60, costCredits: 360 }),
    }));
  });

  it('trues the same avatar DOWN when the read was shorter than the hold', async () => {
    // Both directions, because "settles it correctly" is the whole reason this
    // model kept its per-second rate without a source measurement.
    const { svc, prisma, credits } = makeSvc();
    prisma.generatedAsset.findUnique.mockResolvedValue({
      id: 'a1', workspaceId: WS, status: 'GENERATING',
      model: 'fal-ai/kling-video/ai-avatar/v2/standard', prompt: '.',
      costCreditsReserved: 60, durationSec: 10, params: {},
    });
    await svc.finalizeAsset('a1', {
      status: 'COMPLETED',
      outputs: [{ url: 'https://fal/a.mp4', mime: 'video/mp4', durationSec: 3 }],
    });
    expect(credits.refund).toHaveBeenCalledWith(WS, 42); // 60 held, 18 rendered
  });

  it('keeps the REQUESTED length on a model that HAS a duration input', async () => {
    // fal bills the length we asked for and wire-encoded, so a shorter figure
    // coming back must not snap the charge down a rung of Veo's duration enum.
    const { svc, prisma } = makeSvc();
    prisma.generatedAsset.findUnique.mockResolvedValue({
      id: 'a1', workspaceId: WS, status: 'GENERATING',
      model: 'fal-ai/veo3.1', prompt: 'x',
      costCreditsReserved: 320, durationSec: 8, params: {},
    });
    await svc.finalizeAsset('a1', {
      status: 'COMPLETED', outputs: [{ url: 'https://fal/a.mp4', mime: 'video/mp4' }],
    });
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ durationSec: 8 }),
    }));
  });
});
