import { NotFoundException } from '@nestjs/common';
import { NetgsmEventsController } from './netgsm-events.controller';
import { netgsmWebhookToken } from './netgsm-webhook.util';

/**
 * Unified public receiver for NetGSM santral events. Phase 0 is archive-only:
 * verify the HMAC token, upsert into NetgsmWebhookEvent keyed by
 * (workspaceId, purpose, externalId) so retries dedupe onto the same row, and
 * ack 202. Domain consumers attach in later phases.
 */
describe('NetgsmEventsController', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  let prisma: any;
  let controller: NetgsmEventsController;

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
    prisma = { netgsmWebhookEvent: { upsert: jest.fn().mockResolvedValue({ id: 'row-1' }) } };
    controller = new NetgsmEventsController(prisma);
  });

  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('archives a valid event and acks 202', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');

    const res = await controller.events('ws-1', token, { unique_id: 'evt-1', foo: 'bar' });

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.upsert).toHaveBeenCalledWith({
      where: { workspaceId_purpose_externalId: { workspaceId: 'ws-1', purpose: 'events', externalId: 'evt-1' } },
      create: { workspaceId: 'ws-1', purpose: 'events', externalId: 'evt-1', payload: { unique_id: 'evt-1', foo: 'bar' } },
      update: {},
    });
  });

  it('falls back to uniqueid, then a payload digest, when unique_id is absent', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');

    await controller.events('ws-1', token, { uniqueid: 'evt-2' });
    expect(prisma.netgsmWebhookEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_purpose_externalId: { workspaceId: 'ws-1', purpose: 'events', externalId: 'evt-2' } },
      }),
    );

    await controller.events('ws-1', token, { foo: 'no-id-here' });
    const secondCall = prisma.netgsmWebhookEvent.upsert.mock.calls[1][0];
    expect(secondCall.where.workspaceId_purpose_externalId.externalId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dedupes a duplicate delivery with the same externalId via update: {}', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');

    await controller.events('ws-1', token, { unique_id: 'evt-3' });
    await controller.events('ws-1', token, { unique_id: 'evt-3' });

    expect(prisma.netgsmWebhookEvent.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.netgsmWebhookEvent.upsert.mock.calls[1][0].update).toEqual({});
  });

  it('rejects a bad token with NotFoundException and never touches prisma', async () => {
    await expect(controller.events('ws-1', 'bad-token', { unique_id: 'evt-4' })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.netgsmWebhookEvent.upsert).not.toHaveBeenCalled();
  });

  it('rejects a token minted for a different workspace', async () => {
    const otherToken = netgsmWebhookToken('ws-2', 'events');

    await expect(controller.events('ws-1', otherToken, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.netgsmWebhookEvent.upsert).not.toHaveBeenCalled();
  });
});
