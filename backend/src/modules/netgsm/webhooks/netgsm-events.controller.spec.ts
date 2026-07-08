import { NotFoundException } from '@nestjs/common';
import { NetgsmEventsController } from './netgsm-events.controller';
import { netgsmWebhookToken } from './netgsm-webhook.util';

/**
 * Unified public receiver for NetGSM santral events. Phase 0 is archive-only:
 * verify the HMAC token, insert into NetgsmWebhookEvent keyed by
 * (workspaceId, purpose, externalId) with skipDuplicates so retries —
 * including CONCURRENT retries — dedupe onto the first row (native
 * ON CONFLICT DO NOTHING, no P2002 escape), and ack 202. Domain consumers
 * attach in later phases.
 */
describe('NetgsmEventsController', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  let prisma: any;
  let controller: NetgsmEventsController;

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
    prisma = { netgsmWebhookEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    controller = new NetgsmEventsController(prisma);
  });

  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('archives a valid event and acks 202', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');

    const res = await controller.events('ws-1', token, { unique_id: 'evt-1', foo: 'bar' });

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: 'ws-1', purpose: 'events', externalId: 'evt-1', payload: { unique_id: 'evt-1', foo: 'bar' } },
      ],
      skipDuplicates: true,
    });
  });

  it('falls back to uniqueid, then a payload digest, when unique_id is absent', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');

    await controller.events('ws-1', token, { uniqueid: 'evt-2' });
    expect(prisma.netgsmWebhookEvent.createMany.mock.calls[0][0].data[0].externalId).toBe('evt-2');

    await controller.events('ws-1', token, { foo: 'no-id-here' });
    const secondCall = prisma.netgsmWebhookEvent.createMany.mock.calls[1][0];
    expect(secondCall.data[0].externalId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a duplicate delivery (skipDuplicates hits, count 0) still acks ok', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    prisma.netgsmWebhookEvent.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 }); // concurrent/second retry — conflict skipped

    await expect(controller.events('ws-1', token, { unique_id: 'evt-3' })).resolves.toEqual({ ok: true });
    await expect(controller.events('ws-1', token, { unique_id: 'evt-3' })).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.netgsmWebhookEvent.createMany.mock.calls[1][0].skipDuplicates).toBe(true);
  });

  it('rejects a bad token with NotFoundException and never touches prisma', async () => {
    await expect(controller.events('ws-1', 'bad-token', { unique_id: 'evt-4' })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
  });

  it('rejects a token minted for a different workspace', async () => {
    const otherToken = netgsmWebhookToken('ws-2', 'events');

    await expect(controller.events('ws-1', otherToken, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
  });
});
