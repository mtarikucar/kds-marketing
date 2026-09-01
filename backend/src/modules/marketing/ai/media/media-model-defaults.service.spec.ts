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
    const { svc } = makeSvc({ defaultImageModel: 'fal-ai/qwen-image', defaultVideoModel: 'fal-ai/veo3/fast' });
    const res = await svc.get(WS);
    expect(res.defaultVideoModel).toBe('fal-ai/veo3/fast');
    expect(res.effectiveVideoModel).toBe('fal-ai/veo3/fast');
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

    const video = res.models.find((m) => m.id === 'fal-ai/veo3/fast');
    expect(video).toMatchObject({
      type: 'VIDEO',
      label: 'Video + audio',
      pricePerSecUsd: 0.25,
      creditsPerSec: 25,
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
    await svc.set(WS, { defaultVideoModel: 'fal-ai/veo3/fast' });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: WS },
      data: { defaultVideoModel: 'fal-ai/veo3/fast' },
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
    const { svc, prisma } = makeSvc({ defaultImageModel: null, defaultVideoModel: 'fal-ai/veo3/fast' });
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
    await svc.set(WS, { defaultVideoModel: 'fal-ai/veo3/fast' });
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
    await svc.set(OTHER_WS, { defaultVideoModel: 'fal-ai/veo3/fast' });
    expect(prisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_WS } }),
    );
    expect(prisma.workspace.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WS } }),
    );
  });
});
