import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaModelDefaultsService } from './media-model-defaults.service';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, MEDIA_MODELS } from './media-models.config';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';

function makeSvc(row: unknown = { defaultImageModel: null, defaultVideoModel: null }) {
  const prisma: any = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          defaultImageModel: data.defaultImageModel ?? null,
          defaultVideoModel: data.defaultVideoModel ?? null,
        }),
      ),
    },
  };
  return { svc: new MediaModelDefaultsService(prisma), prisma };
}

describe('MediaModelDefaultsService.get', () => {
  it('reports NO choice as null, and names what would actually run', async () => {
    const { svc } = makeSvc();
    const res = await svc.get(WS);
    // The distinction is the point: null is "this workspace has not chosen",
    // which keeps following the platform constant. A stored copy of the
    // constant would pin the workspace to it forever.
    expect(res.defaultImageModel).toBeNull();
    expect(res.defaultVideoModel).toBeNull();
    expect(res.effectiveImageModel).toBe(DEFAULT_IMAGE_MODEL);
    expect(res.effectiveVideoModel).toBe(DEFAULT_VIDEO_MODEL);
  });

  it('reports a stored choice as both the choice and the effective model', async () => {
    const { svc } = makeSvc({ defaultImageModel: 'fal-ai/qwen-image', defaultVideoModel: 'fal-ai/veo3.1/fast' });
    const res = await svc.get(WS);
    expect(res.defaultVideoModel).toBe('fal-ai/veo3.1/fast');
    expect(res.effectiveVideoModel).toBe('fal-ai/veo3.1/fast');
    // Nothing retired, so nothing to explain away.
    expect(res.retiredVideoModel).toBeNull();
    expect(res.retiredImageModel).toBeNull();
  });

  /**
   * A RETIRED choice: catalogued the day it was stored, gone from the catalogue
   * today. `validated()` cannot prevent this — the catalogue is a TypeScript
   * constant, and a deploy that drops a model leaves the id in every workspace
   * that picked it.
   *
   * `MediaGenService.resolveModel` already ignores it and runs the platform
   * constant, so generation is correct. The READ was the part that lied: it
   * returned the retired id as `effectiveVideoModel`, so the settings card
   * rendered a RadioGroup whose value matched no option, badged no row "In
   * use", and never said what the next video would cost.
   */
  it('falls back to the platform model when the stored choice has left the catalogue', async () => {
    const { svc } = makeSvc({
      defaultImageModel: 'fal-ai/retired-image-v1',
      defaultVideoModel: 'fal-ai/retired-video-v1',
    });
    const res = await svc.get(WS);

    // What will actually run, which is what the generator will actually do.
    expect(res.effectiveVideoModel).toBe(DEFAULT_VIDEO_MODEL);
    expect(res.effectiveImageModel).toBe(DEFAULT_IMAGE_MODEL);
    // The choice is NOT scrubbed — reporting null here would tell a manager
    // their choice never happened.
    expect(res.defaultVideoModel).toBe('fal-ai/retired-video-v1');
    // And the disagreement is REPORTED, so the card can name it.
    expect(res.retiredVideoModel).toBe('fal-ai/retired-video-v1');
    expect(res.retiredImageModel).toBe('fal-ai/retired-image-v1');
  });

  /** A catalogued id of the WRONG KIND is retired too: the two kinds bill in
   *  different units, so an image id as the video default cannot be priced as a
   *  clip any more than an unknown one can. Same rule `validated` applies at the
   *  write and `MediaGenService` applies at generation. */
  it('treats a catalogued id of the wrong kind as retired, not as a choice', async () => {
    const { svc } = makeSvc({
      defaultImageModel: null,
      defaultVideoModel: DEFAULT_IMAGE_MODEL,
    });
    const res = await svc.get(WS);
    expect(res.effectiveVideoModel).toBe(DEFAULT_VIDEO_MODEL);
    expect(res.retiredVideoModel).toBe(DEFAULT_IMAGE_MODEL);
  });

  /** The effective model is always something the card can actually show a
   *  price for — that is the entire contract this screen depends on. */
  it('always names an effective model that is IN the catalogue', async () => {
    for (const row of [
      { defaultImageModel: null, defaultVideoModel: null },
      { defaultImageModel: 'fal-ai/qwen-image', defaultVideoModel: 'fal-ai/veo3.1/fast' },
      { defaultImageModel: 'gone', defaultVideoModel: 'also-gone' },
    ]) {
      const res = await makeSvc(row).svc.get(WS);
      expect(res.models.some((m) => m.id === res.effectiveVideoModel && m.type === 'VIDEO')).toBe(true);
      expect(res.models.some((m) => m.id === res.effectiveImageModel && m.type === 'IMAGE')).toBe(true);
    }
  });

  /**
   * The card is a PRICE list. Video is the most expensive action in the product
   * and the catalogue spans a 10x range, so a picker that returns ids without
   * their cost is the wrong picker — the whole reason this endpoint exists
   * rather than a fourth hardcoded copy of the list in the client.
   */
  it('returns the whole catalogue, each entry priced in the unit its kind bills in', async () => {
    const { svc } = makeSvc();
    const res = await svc.get(WS);
    expect(res.models).toHaveLength(Object.keys(MEDIA_MODELS).length);

    const video = res.models.find((m) => m.id === 'fal-ai/veo3.1/fast');
    expect(video).toMatchObject({
      type: 'VIDEO',
      label: 'Veo 3.1 Fast — draft tier',
      pricePerSecUsd: 0.15,
      creditsPerSec: 15,
      isPlatformDefault: false,
    });

    const image = res.models.find((m) => m.id === DEFAULT_IMAGE_MODEL);
    expect(image).toMatchObject({ type: 'IMAGE', priceUsd: 0.03, credits: 3, isPlatformDefault: true });
  });

  it('reads only the calling workspace', async () => {
    const { svc, prisma } = makeSvc();
    await svc.get(OTHER_WS);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_WS } }),
    );
    expect(prisma.workspace.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WS } }),
    );
  });

  it('refuses a workspace that does not exist rather than answering with defaults', async () => {
    const { svc } = makeSvc(null);
    await expect(svc.get(WS)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MediaModelDefaultsService.set', () => {
  it('stores a catalogued id of the matching kind', async () => {
    const { svc, prisma } = makeSvc();
    await svc.set(WS, { defaultVideoModel: 'fal-ai/veo3.1/fast' });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: WS },
      data: { defaultVideoModel: 'fal-ai/veo3.1/fast' },
      select: { defaultImageModel: true, defaultVideoModel: true },
    });
  });

  /**
   * The refusal `generate_video` already performs, performed on the WRITE too.
   * Without it the settings screen is a way to store a value that the read path
   * will later refuse — the workspace would think it had chosen a model and
   * quietly generate on the platform constant instead.
   */
  it('refuses an uncatalogued id, and says why', async () => {
    const { svc, prisma } = makeSvc();
    await expect(svc.set(WS, { defaultVideoModel: 'fal-ai/some-new-thing' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.set(WS, { defaultVideoModel: 'fal-ai/some-new-thing' })).rejects.toThrow(/price/i);
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('refuses a catalogued id of the WRONG kind', async () => {
    const { svc, prisma } = makeSvc();
    await expect(svc.set(WS, { defaultVideoModel: DEFAULT_IMAGE_MODEL })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.set(WS, { defaultImageModel: DEFAULT_VIDEO_MODEL })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('clears a choice with an explicit null, back to the platform default', async () => {
    const { svc, prisma } = makeSvc({ defaultImageModel: null, defaultVideoModel: 'fal-ai/veo3.1/fast' });
    const res = await svc.set(WS, { defaultVideoModel: null });
    expect(prisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { defaultVideoModel: null } }),
    );
    expect(res.effectiveVideoModel).toBe(DEFAULT_VIDEO_MODEL);
  });

  /**
   * Absent is not null. A PATCH naming only the video model must leave the image
   * model exactly as it was — the alternative silently resets the other half of
   * the card every time one half is saved.
   */
  it('leaves an unnamed field untouched', async () => {
    const { svc, prisma } = makeSvc();
    await svc.set(WS, { defaultVideoModel: 'fal-ai/veo3.1/fast' });
    const data = prisma.workspace.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(['defaultVideoModel']);
  });

  it('refuses a patch that names nothing', async () => {
    const { svc, prisma } = makeSvc();
    await expect(svc.set(WS, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('writes only to the calling workspace', async () => {
    const { svc, prisma } = makeSvc();
    await svc.set(OTHER_WS, { defaultVideoModel: 'fal-ai/veo3.1/fast' });
    expect(prisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_WS } }),
    );
    expect(prisma.workspace.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WS } }),
    );
  });
});
