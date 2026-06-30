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
