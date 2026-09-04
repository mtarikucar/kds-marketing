import { UnauthorizedException } from '@nestjs/common';
import { MarketingMediaController } from './marketing-media.controller';
import { MarketingMediaWebhookController } from './marketing-media-webhook.controller';

const user: any = { workspaceId: 'ws-1', id: 'u1' };
function makeMedia() {
  const gen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'a1' }), listAssets: jest.fn().mockResolvedValue([]), getAsset: jest.fn().mockResolvedValue({ id: 'a1' }), regenerate: jest.fn().mockResolvedValue({ assetId: 'a2' }), deleteAsset: jest.fn().mockResolvedValue({ deleted: true }) };
  const brand = { get: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({ id: 'bk-1' }), addReferenceImage: jest.fn().mockResolvedValue({ url: 'u', r2Key: 'k', mime: 'image/png' }) };
  return { ctrl: new MarketingMediaController(gen as any, brand as any), gen, brand };
}

describe('MarketingMediaController', () => {
  it('POST /generate passes workspace + createdById to the service', async () => {
    const { ctrl, gen } = makeMedia();
    const res = await ctrl.generate({ type: 'IMAGE', prompt: 'a cat' } as any, user);
    expect(res).toEqual({ assetId: 'a1' });
    expect(gen.requestGeneration).toHaveBeenCalledWith('ws-1', expect.objectContaining({ type: 'IMAGE', prompt: 'a cat', createdById: 'u1' }));
  });

  it('GET /generations/:id scopes by workspace', async () => {
    const { ctrl, gen } = makeMedia();
    await ctrl.getOne('a1', user);
    expect(gen.getAsset).toHaveBeenCalledWith('ws-1', 'a1');
  });

  it('PUT /brand-kit upserts', async () => {
    const { ctrl, brand } = makeMedia();
    await ctrl.putBrandKit({ tone: 'x' } as any, user);
    expect(brand.upsert).toHaveBeenCalledWith('ws-1', { tone: 'x' });
  });

  it('GET /models does not serve a withheld model', () => {
    // This endpoint IS the studio's catalogue: anything it lists is offerable,
    // priced and clickable. The four models priced by measuring a
    // customer-supplied file are withheld until a real server-side probe exists,
    // so they must not reach the picker at all — the service refuses them too,
    // and a UI that offers a model the API refuses is worse than one that does
    // not offer it.
    const { ctrl } = makeMedia();
    const ids = ctrl.models().models.map((m) => m.id);
    expect(ids).toEqual(expect.not.arrayContaining([
      'fal-ai/topaz/upscale/video',
      'fal-ai/qwen-image-edit/inpaint',
      'fal-ai/kling-video/ai-avatar/v2/standard',
    ]));
    // Served, though: the withdrawal is three endpoints, not a shutdown — and
    // AVATAR survives it, because this one is metered on the SCRIPT.
    expect(ids).toContain('veed/avatars/text-to-video');
    // Two came BACK when a real probe (ffprobe, server-side) could finally
    // measure the customer's file before the reserve — measuring it was their
    // only blocker. The three still held back each have a second one that is
    // not a measurement problem.
    expect(ids).toEqual(expect.arrayContaining([
      'fal-ai/topaz/upscale/image',
      'fal-ai/latentsync',
    ]));
    // 32 verified endpoints: 3 withheld, and 2 retired by fal (Seedance 1.0
    // Lite, Veo 3 Fast) that stay catalogued for old rows but are not sold.
    expect(ids.length).toBe(27);
    expect(ids).not.toContain('fal-ai/bytedance/seedance/v1/lite/text-to-video');
    expect(ids).not.toContain('fal-ai/veo3/fast');
    expect(ids).toContain('fal-ai/bytedance/seedance/v1/pro/fast/text-to-video');
  });
});

describe('MarketingMediaWebhookController', () => {
  const OLD = process.env.FAL_WEBHOOK_SECRET;
  afterEach(() => { process.env.FAL_WEBHOOK_SECRET = OLD; });

  it('rejects a wrong token', async () => {
    process.env.FAL_WEBHOOK_SECRET = 'secret';
    const gen = { finalizeByRequestId: jest.fn() };
    const ctrl = new MarketingMediaWebhookController(gen as any);
    await expect(ctrl.receive('nope', { request_id: 'r1', status: 'OK' } as any))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(gen.finalizeByRequestId).not.toHaveBeenCalled();
  });

  it('maps a fal COMPLETED webhook to finalizeByRequestId', async () => {
    process.env.FAL_WEBHOOK_SECRET = 'secret';
    const gen = { finalizeByRequestId: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new MarketingMediaWebhookController(gen as any);
    const r = await ctrl.receive('secret', { request_id: 'r1', status: 'OK', payload: { images: [{ url: 'u', content_type: 'image/png' }] } } as any);
    expect(r).toEqual({ ok: true });
    expect(gen.finalizeByRequestId).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'COMPLETED' }));
  });
});
