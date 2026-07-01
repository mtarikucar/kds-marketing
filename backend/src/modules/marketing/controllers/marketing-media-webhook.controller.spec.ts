import { UnauthorizedException } from '@nestjs/common';
import { MarketingMediaWebhookController } from './marketing-media-webhook.controller';

const SECRET = 'test-webhook-secret';

function build() {
  const gen = { finalizeByRequestId: jest.fn().mockResolvedValue(undefined) };
  const ctrl = new MarketingMediaWebhookController(gen as any);
  return { ctrl, gen };
}

describe('MarketingMediaWebhookController', () => {
  const prev = process.env.FAL_WEBHOOK_SECRET;
  beforeAll(() => { process.env.FAL_WEBHOOK_SECRET = SECRET; });
  afterAll(() => { process.env.FAL_WEBHOOK_SECRET = prev; });

  it('rejects a wrong token', async () => {
    const { ctrl, gen } = build();
    await expect(ctrl.receive('nope', { request_id: 'r1' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(gen.finalizeByRequestId).not.toHaveBeenCalled();
  });

  it('rejects a token of a different length (constant-time compare is length-safe)', async () => {
    const { ctrl } = build();
    await expect(ctrl.receive(SECRET + 'x', { request_id: 'r1' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('finalizes an error webhook as FAILED', async () => {
    const { ctrl, gen } = build();
    await ctrl.receive(SECRET, { request_id: 'r1', status: 'ERROR', error: 'boom' });
    expect(gen.finalizeByRequestId).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'FAILED' }));
  });

  it('finalizes a COMPLETED webhook that carries media', async () => {
    const { ctrl, gen } = build();
    await ctrl.receive(SECRET, { request_id: 'r1', status: 'OK', payload: { images: [{ url: 'https://fal/x.png' }] } });
    expect(gen.finalizeByRequestId).toHaveBeenCalledWith('r1', expect.objectContaining({
      status: 'COMPLETED', outputs: expect.arrayContaining([expect.objectContaining({ url: 'https://fal/x.png' })]),
    }));
  });

  it('does NOT terminalize a COMPLETED webhook with no parseable output (lets the poll recover it)', async () => {
    const { ctrl, gen } = build();
    await ctrl.receive(SECRET, { request_id: 'r1', status: 'OK', payload: { somethingUnknown: true } });
    expect(gen.finalizeByRequestId).not.toHaveBeenCalled();
  });
});
