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
  let outbox: any;
  let controller: NetgsmEventsController;

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
    prisma = {
      netgsmWebhookEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    outbox = { append: jest.fn().mockResolvedValue('outbox-id') };
    controller = new NetgsmEventsController(prisma, outbox);
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

/**
 * İYS push-back (Phase 2 Task 4). The body is a bare JSON ARRAY — unlike
 * every other NetGSM push — so fan-out + per-element dedupe is the whole
 * point of this route: `createMany`'s count can't say WHICH rows were new,
 * so existing externalIds are read first and only the genuinely-missing
 * elements are archived AND published (one `marketing.iys.consent.v1`
 * outbox event per new element).
 */
describe('NetgsmEventsController — iys', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  let prisma: any;
  let outbox: any;
  let controller: NetgsmEventsController;

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
    prisma = {
      netgsmWebhookEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    outbox = { append: jest.fn().mockResolvedValue('outbox-id') };
    controller = new NetgsmEventsController(prisma, outbox);
  });

  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('fans out an array payload: archives + publishes ONE event per NEW element, skipping the already-archived one', async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const elA = { transactionid: 'tx-1', recipient: '905551112233', type: 'MESAJ', status: 'ONAY', source: 'HS_WEB' };
    const elB = { transactionid: 'tx-2', recipient: '905551112244', type: 'MESAJ', status: 'RET', source: 'HS_MESAJ' };
    // tx-1 was already archived by a previous delivery — only tx-2 is new.
    prisma.netgsmWebhookEvent.findMany.mockResolvedValue([{ externalId: 'tx-1' }]);

    const res = await controller.iys('ws-1', token, [elA, elB]);

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', purpose: 'iys', externalId: { in: ['tx-1', 'tx-2'] } },
      select: { externalId: true },
    });
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'iys', externalId: 'tx-2', payload: elB }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledWith({
      type: 'marketing.iys.consent.v1',
      tenantId: null,
      payload: {
        workspaceId: 'ws-1',
        recipient: '905551112244',
        type: 'MESAJ',
        status: 'RET',
        source: 'HS_MESAJ',
        transactionId: 'tx-2',
      },
      idempotencyKey: 'ws-1:iys:tx-2',
    });
  });

  it('archives + publishes nothing when every element in the batch was already seen', async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const el = { transactionid: 'tx-1', recipient: '905551112233', type: 'MESAJ', status: 'ONAY', source: 'HS_WEB' };
    prisma.netgsmWebhookEvent.findMany.mockResolvedValue([{ externalId: 'tx-1' }]);

    await expect(controller.iys('ws-1', token, [el])).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('falls back to submitid, then a per-element payload digest, when transactionid is absent', async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const elSubmit = { submitid: 'sub-1', recipient: '905551112233', type: 'MESAJ', status: 'ONAY' };
    const elBare = { recipient: '905551112244', type: 'MESAJ', status: 'ONAY' };

    await controller.iys('ws-1', token, [elSubmit, elBare]);

    const findManyArgs = prisma.netgsmWebhookEvent.findMany.mock.calls[0][0];
    expect(findManyArgs.where.externalId.in[0]).toBe('sub-1');
    expect(findManyArgs.where.externalId.in[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a bad token with NotFoundException and never touches prisma or the outbox', async () => {
    const el = { transactionid: 'tx-1', recipient: '905551112233', type: 'MESAJ', status: 'ONAY' };

    await expect(controller.iys('ws-1', 'bad-token', [el])).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('acks ok on an empty array without touching prisma or the outbox', async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');

    await expect(controller.iys('ws-1', token, [])).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('defaults status to ONAY when neither ONAY nor RET is recognized, and defaults type to MESAJ', async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const el = { transactionid: 'tx-9', recipient: '905551112233' };

    await controller.iys('ws-1', token, [el]);

    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ status: 'ONAY', type: 'MESAJ' }) }),
    );
  });
});
