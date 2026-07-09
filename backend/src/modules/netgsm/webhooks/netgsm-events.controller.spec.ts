import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { NetgsmEventsController } from './netgsm-events.controller';
import { netgsmWebhookToken, payloadDigest } from './netgsm-webhook.util';

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
    const body = { unique_id: 'evt-1', foo: 'bar' };

    const res = await controller.events('ws-1', token, body);

    expect(res).toEqual({ ok: true });
    // No scenario/durum/event field on this body, so the scenario token falls
    // all the way back to a payload digest (see the CRITICAL note on
    // `events()`) — the externalId is `unique_id:scenarioToken`, never bare
    // `unique_id`, so a later scenario for the same call gets its own row.
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: 'ws-1', purpose: 'events', externalId: `evt-1:${payloadDigest(body)}`, payload: body },
      ],
      skipDuplicates: true,
    });
  });

  it('falls back to uniqueid, then a payload digest, when unique_id is absent', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');

    const bodyA = { uniqueid: 'evt-2' };
    await controller.events('ws-1', token, bodyA);
    expect(prisma.netgsmWebhookEvent.createMany.mock.calls[0][0].data[0].externalId).toBe(
      `evt-2:${payloadDigest(bodyA)}`,
    );

    const bodyB = { foo: 'no-id-here' };
    await controller.events('ws-1', token, bodyB);
    const secondCall = prisma.netgsmWebhookEvent.createMany.mock.calls[1][0];
    // Both the id part and the scenario-token part fall back to the same
    // whole-element digest here (no unique_id/uniqueid AND no scenario field).
    expect(secondCall.data[0].externalId).toBe(`${payloadDigest(bodyB)}:${payloadDigest(bodyB)}`);
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

  it('rejects a bad token without touching prisma.findMany or the outbox either', async () => {
    await expect(controller.events('ws-1', 'bad-token', { unique_id: 'evt-4' })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });
});

/**
 * Phase 3 Task 1 — santral event normalizer + typed domain events. Santral
 * usually pushes a single scenario object per call leg, but the fan-out
 * dedupe (read-existing → insert-missing → publish-missing) mirrors the İYS
 * route exactly, via the shared `archiveFresh` helper, so a lone object is
 * wrapped as a one-element array to reuse the same path.
 */
describe('NetgsmEventsController — events fan-out + normalization', () => {
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

  it('a single-object body (the usual santral shape) is archived AND published as one typed call_event', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    const body = {
      scenario: 'Inbound_call',
      unique_id: 'call-1',
      customer_num: '905551112233',
      internal_num: '101',
      yon: 'INBOUND',
    };

    const res = await controller.events('ws-1', token, body);

    expect(res).toEqual({ ok: true });
    // externalId is `unique_id:scenarioToken` (scenario field lowercased/
    // trimmed), never bare unique_id — see the CRITICAL note on `events()`.
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'events', externalId: 'call-1:inbound_call', payload: body }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledWith({
      type: 'marketing.telephony.call_event.v1',
      tenantId: null,
      payload: {
        workspaceId: 'ws-1',
        kind: 'inbound_call',
        uniqueId: 'call-1',
        crmId: null,
        customerNum: '905551112233',
        internalNum: '101',
        direction: 'INBOUND',
        status: null,
        recording: null,
        durationSec: null,
        raw: body,
      },
      idempotencyKey: 'ws-1:santral:call-1:inbound_call',
    });
  });

  it('an array body fans out: archives every element, but publishes ONLY the NEW one (the other was already archived)', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    const elA = { scenario: 'Hangup', unique_id: 'evt-a', bilsec: '30' };
    const elB = { scenario: 'Answer', unique_id: 'evt-b' };
    // evt-a's Hangup scenario was already archived by a previous delivery —
    // only evt-b's Answer is new.
    prisma.netgsmWebhookEvent.findMany.mockResolvedValue([{ externalId: 'evt-a:hangup' }]);

    const res = await controller.events('ws-1', token, [elA, elB]);

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', purpose: 'events', externalId: { in: ['evt-a:hangup', 'evt-b:answer'] } },
      select: { externalId: true },
    });
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'events', externalId: 'evt-b:answer', payload: elB }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'ws-1:santral:evt-b:answer',
        payload: expect.objectContaining({ uniqueId: 'evt-b', kind: 'answer' }),
      }),
    );
  });

  it('an element that fails to normalize (unrecognized scenario) is archived but never published', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    const body = { scenario: 'SomeFutureScenario', unique_id: 'evt-x' };

    await expect(controller.events('ws-1', token, body)).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'events', externalId: 'evt-x:somefuturescenario', payload: body }],
      skipDuplicates: true,
    });
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('when every element in the batch was already archived, nothing new is inserted or published', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    const body = { scenario: 'Hangup', unique_id: 'evt-seen' };
    prisma.netgsmWebhookEvent.findMany.mockResolvedValue([{ externalId: 'evt-seen:hangup' }]);

    await expect(controller.events('ws-1', token, body)).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('rejects a bad token with NotFoundException and never touches prisma or the outbox', async () => {
    await expect(controller.events('ws-1', 'bad-token', { scenario: 'Hangup' })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });
});

/**
 * CRITICAL fix — a single call leg fans out to MULTIPLE scenario pushes
 * (Inbound_call → Answer → Hangup → cdr) that all share the SAME unique_id.
 * Keying the archive purely on unique_id let the FIRST scenario delivered
 * claim the row under `@@unique([workspaceId,purpose,externalId])` and
 * silently swallow every later scenario for that call. The archive
 * `externalId` is now `unique_id:scenarioToken`, so distinct scenarios for
 * the same call each archive + publish, while a genuine redelivery of the
 * SAME scenario still dedupes to one row.
 */
describe('NetgsmEventsController — events archive key scoped by scenario (CRITICAL fix)', () => {
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

  it('Inbound_call → Answer → Hangup for ONE unique_id, delivered as 3 separate calls, all 3 archive AND all 3 publish', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    const uniqueId = 'call-multi-1';

    await controller.events('ws-1', token, { scenario: 'Inbound_call', unique_id: uniqueId });
    await controller.events('ws-1', token, { scenario: 'Answer', unique_id: uniqueId });
    await controller.events('ws-1', token, { scenario: 'Hangup', unique_id: uniqueId, bilsec: '42' });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(3);
    const archivedIds = prisma.netgsmWebhookEvent.createMany.mock.calls.map(
      (c: any) => c[0].data[0].externalId,
    );
    expect(archivedIds).toEqual([
      `${uniqueId}:inbound_call`,
      `${uniqueId}:answer`,
      `${uniqueId}:hangup`,
    ]);
    // Every archived externalId is distinct — none collapsed onto another.
    expect(new Set(archivedIds).size).toBe(3);

    expect(outbox.append).toHaveBeenCalledTimes(3);
    expect(outbox.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: `ws-1:santral:${uniqueId}:inbound_call` }),
    );
    expect(outbox.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: `ws-1:santral:${uniqueId}:answer` }),
    );
    expect(outbox.append).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ idempotencyKey: `ws-1:santral:${uniqueId}:hangup` }),
    );
  });

  it('the SAME Hangup for the SAME unique_id delivered twice (genuine redelivery) still dedupes to ONE archived row + ONE typed event', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    const body = { scenario: 'Hangup', unique_id: 'call-redeliver-1', bilsec: '10' };
    const externalId = 'call-redeliver-1:hangup';

    // 1st delivery: genuinely new.
    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([]);
    // 2nd delivery: the same scenario+unique_id already archived by the 1st.
    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([{ externalId }]);

    await controller.events('ws-1', token, body);
    await controller.events('ws-1', token, body);

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'events', externalId, payload: body }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });

  it('an unrecognized scenario for unique_id X, followed by a recognized Hangup for the SAME X, still archives + publishes the Hangup', async () => {
    const token = netgsmWebhookToken('ws-1', 'events');
    const uniqueId = 'call-mixed-1';
    const unknownBody = { scenario: 'SomeFutureScenario', unique_id: uniqueId };
    const hangupBody = { scenario: 'Hangup', unique_id: uniqueId };

    // 1st delivery: unrecognized scenario — archived, not published.
    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([]);
    await controller.events('ws-1', token, unknownBody);
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          workspaceId: 'ws-1',
          purpose: 'events',
          externalId: `${uniqueId}:somefuturescenario`,
          payload: unknownBody,
        },
      ],
      skipDuplicates: true,
    });
    expect(outbox.append).not.toHaveBeenCalled();

    // 2nd delivery: the prior unrecognized-scenario row is "already archived"
    // for this unique_id, but the Hangup's OWN externalId is different, so it
    // must not be blocked by it.
    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([
      { externalId: `${uniqueId}:somefuturescenario` },
    ]);
    await controller.events('ws-1', token, hangupBody);

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenLastCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'events', externalId: `${uniqueId}:hangup`, payload: hangupBody }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `ws-1:santral:${uniqueId}:hangup` }),
    );
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

  it('an element missing BOTH type and status is archived but NEVER published (fails closed on missing status first)', async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const el = { transactionid: 'tx-9', recipient: '905551112233' };

    await expect(controller.iys('ws-1', token, [el])).resolves.toEqual({ ok: true });

    // Still archived for audit — the fail-closed behavior is ONLY about publishing.
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'iys', externalId: 'tx-9', payload: el }],
      skipDuplicates: true,
    });
    expect(outbox.append).not.toHaveBeenCalled();
  });

  // Final-review MUST-FIX M4: `type` used to default to 'MESAJ' when absent —
  // this defaulted an ARAMA/EPOSTA (or outright garbage) element's ONAY/RET
  // to SMS marketing consent, which was never proven. Type is now strict
  // tri-state, same fail-closed treatment as status.
  it("type tri-state — an element with a valid status but an unrecognized type is archived but NEVER published (never defaulted to MESAJ)", async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const el = { transactionid: 'tx-badtype', recipient: '905551112233', type: 'GARBAGE', status: 'ONAY', source: 'HS_WEB' };

    await expect(controller.iys('ws-1', token, [el])).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'iys', externalId: 'tx-badtype', payload: el }],
      skipDuplicates: true,
    });
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it("type tri-state — 'ARAMA' and 'EPOSTA' are recognized types and DO publish (the consumer, not this controller, decides only MESAJ is applied this phase)", async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const elArama = { transactionid: 'tx-arama', recipient: '905551112233', type: 'ARAMA', status: 'ONAY', source: 'HS_WEB' };
    const elEposta = { transactionid: 'tx-eposta', recipient: 'a@b.com', type: 'EPOSTA', status: 'RET', source: 'HS_WEB' };

    await controller.iys('ws-1', token, [elArama, elEposta]);

    expect(outbox.append).toHaveBeenCalledTimes(2);
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ type: 'ARAMA' }) }));
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ type: 'EPOSTA' }) }));
  });

  it("status tri-state — explicit 'ONAY' publishes a granted consent event", async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const el = { transactionid: 'tx-onay', recipient: '905551112233', type: 'MESAJ', status: 'ONAY', source: 'HS_WEB' };

    await controller.iys('ws-1', token, [el]);

    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ status: 'ONAY' }) }),
    );
  });

  it("status tri-state — explicit 'RET' publishes a revoked consent event", async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const el = { transactionid: 'tx-ret', recipient: '905551112233', type: 'MESAJ', status: 'RET', source: 'HS_WEB' };

    await controller.iys('ws-1', token, [el]);

    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ status: 'RET' }) }),
    );
  });

  it("status tri-state — an unrecognized/garbage status is archived but NEVER published (never fails open to ONAY)", async () => {
    const token = netgsmWebhookToken('ws-1', 'iys');
    const el = { transactionid: 'tx-garbage', recipient: '905551112233', type: 'MESAJ', status: 'garbage', source: 'HS_WEB' };

    await expect(controller.iys('ws-1', token, [el])).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'iys', externalId: 'tx-garbage', payload: el }],
      skipDuplicates: true,
    });
    expect(outbox.append).not.toHaveBeenCalled();
  });
});

/**
 * Voice-campaign report push (NetGSM Phase 5 Task 3). Voice PUSHES call
 * outcomes (unlike SMS's DLR poll) — a single call can get multiple
 * distinct-state pushes, so the archive key is scoped by state (`durum`),
 * exactly like `events`' scenario-scoped externalId.
 */
describe('NetgsmEventsController — voice-report', () => {
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

  it('archives + publishes a single-object body, externalId scoped by relationid:state', async () => {
    const token = netgsmWebhookToken('ws-1', 'voice-report');
    const body = { relationid: 'recip-1', durum: '1', bilsec: '42', push_button: '1' };

    const res = await controller.voiceReport('ws-1', token, body);

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'voice-report', externalId: 'recip-1:1', payload: body }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledWith({
      type: 'marketing.voice.report.v1',
      tenantId: null,
      payload: {
        workspaceId: 'ws-1',
        relationid: 'recip-1',
        state: '1',
        bilsec: 42,
        pushButton: '1',
        recordLink: null,
      },
      idempotencyKey: 'ws-1:voice-report:recip-1:1',
    });
  });

  it('tolerates numeric JSON fields (durum/bilsec/push_button as bare numbers, not strings)', async () => {
    const token = netgsmWebhookToken('ws-1', 'voice-report');
    const body = { relationid: 'recip-2', durum: 3, bilsec: 0, push_button: 2 };

    await controller.voiceReport('ws-1', token, body);

    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ relationid: 'recip-2', state: '3', bilsec: 0, pushButton: '2' }),
      }),
    );
  });

  it('an array body fans out: archives every element, publishes ONLY the NEW one', async () => {
    const token = netgsmWebhookToken('ws-1', 'voice-report');
    const elA = { relationid: 'recip-a', durum: '3' }; // already archived by a previous delivery
    const elB = { relationid: 'recip-b', durum: '1', bilsec: '10' };
    prisma.netgsmWebhookEvent.findMany.mockResolvedValue([{ externalId: 'recip-a:3' }]);

    const res = await controller.voiceReport('ws-1', token, [elA, elB]);

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'voice-report', externalId: 'recip-b:1', payload: elB }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'ws-1:voice-report:recip-b:1' }),
    );
  });

  it('the SAME call getting a NEW distinct state (e.g. an intermediate push followed by the final outcome) archives + publishes BOTH, never colliding', async () => {
    const token = netgsmWebhookToken('ws-1', 'voice-report');
    const relationid = 'recip-multi-1';

    await controller.voiceReport('ws-1', token, { relationid, durum: '2' });
    await controller.voiceReport('ws-1', token, { relationid, durum: '1', bilsec: '15' });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(2);
    const archivedIds = prisma.netgsmWebhookEvent.createMany.mock.calls.map((c: any) => c[0].data[0].externalId);
    expect(archivedIds).toEqual([`${relationid}:2`, `${relationid}:1`]);
    expect(outbox.append).toHaveBeenCalledTimes(2);
  });

  it('the SAME call+state delivered twice (genuine redelivery) dedupes to ONE archived row + ONE publish', async () => {
    const token = netgsmWebhookToken('ws-1', 'voice-report');
    const body = { relationid: 'recip-redeliver', durum: '1', bilsec: '20' };

    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([]);
    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([{ externalId: 'recip-redeliver:1' }]);

    await controller.voiceReport('ws-1', token, body);
    await controller.voiceReport('ws-1', token, body);

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });

  it('an element with no resolvable relationid is archived but NEVER published (fails closed — this controller never guesses)', async () => {
    const token = netgsmWebhookToken('ws-1', 'voice-report');
    const body = { durum: '1', bilsec: '5' };

    await expect(controller.voiceReport('ws-1', token, body)).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(1);
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('acks ok on an empty array without touching prisma or the outbox', async () => {
    const token = netgsmWebhookToken('ws-1', 'voice-report');

    await expect(controller.voiceReport('ws-1', token, [])).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('rejects a bad token with NotFoundException and never touches prisma or the outbox', async () => {
    await expect(controller.voiceReport('ws-1', 'bad-token', { relationid: 'recip-1', durum: '1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('rejects a token minted for a different purpose (e.g. events)', async () => {
    const eventsToken = netgsmWebhookToken('ws-1', 'events');

    await expect(
      controller.voiceReport('ws-1', eventsToken, { relationid: 'recip-1', durum: '1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * Auto-dialer per-attempt report push (NetGSM Phase 5 Task 5). Unlike
 * voice-report, `unique_id` already identifies ONE attempt uniquely, so the
 * archive key is `JobID:unique_id` — no extra state-token scoping needed.
 */
describe('NetgsmEventsController — autocall-report', () => {
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

  it('archives + publishes a single-object body, externalId scoped by JobID:unique_id', async () => {
    const token = netgsmWebhookToken('ws-1', 'autocall-report');
    const body = { JobID: 'job-1', called: '905551112233', unique_id: 'u-1', status: 'ANSWERED' };

    const res = await controller.autocallReport('ws-1', token, body);

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'autocall-report', externalId: 'job-1:u-1', payload: body }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledWith({
      type: 'marketing.autocall.report.v1',
      tenantId: null,
      payload: { workspaceId: 'ws-1', jobId: 'job-1', called: '905551112233', uniqueId: 'u-1', status: 'ANSWERED' },
      idempotencyKey: 'ws-1:autocall-report:job-1:u-1',
    });
  });

  it('tolerates numeric JobID/unique_id (bare JSON numbers, not strings)', async () => {
    const token = netgsmWebhookToken('ws-1', 'autocall-report');
    const body = { JobID: 42, called: '905551112233', unique_id: 7, status: 'NO_ANSWER' };

    await controller.autocallReport('ws-1', token, body);

    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ jobId: '42', uniqueId: '7' }) }),
    );
  });

  it('an array body fans out: archives every element, publishes ONLY the NEW one', async () => {
    const token = netgsmWebhookToken('ws-1', 'autocall-report');
    const elA = { JobID: 'job-1', unique_id: 'u-a' }; // already archived by a previous delivery
    const elB = { JobID: 'job-1', unique_id: 'u-b', called: '905551112255', status: 'BUSY' };
    prisma.netgsmWebhookEvent.findMany.mockResolvedValue([{ externalId: 'job-1:u-a' }]);

    const res = await controller.autocallReport('ws-1', token, [elA, elB]);

    expect(res).toEqual({ ok: true });
    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', purpose: 'autocall-report', externalId: 'job-1:u-b', payload: elB }],
      skipDuplicates: true,
    });
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'ws-1:autocall-report:job-1:u-b' }));
  });

  it('a retry of the SAME number gets its OWN unique_id — archives + publishes both, never colliding', async () => {
    const token = netgsmWebhookToken('ws-1', 'autocall-report');
    const body1 = { JobID: 'job-1', called: '905551112233', unique_id: 'attempt-1', status: 'NO_ANSWER' };
    const body2 = { JobID: 'job-1', called: '905551112233', unique_id: 'attempt-2', status: 'ANSWERED' };

    await controller.autocallReport('ws-1', token, body1);
    await controller.autocallReport('ws-1', token, body2);

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(2);
    const archivedIds = prisma.netgsmWebhookEvent.createMany.mock.calls.map((c: any) => c[0].data[0].externalId);
    expect(archivedIds).toEqual(['job-1:attempt-1', 'job-1:attempt-2']);
    expect(outbox.append).toHaveBeenCalledTimes(2);
  });

  it('the SAME attempt delivered twice (genuine redelivery) dedupes to ONE archived row + ONE publish', async () => {
    const token = netgsmWebhookToken('ws-1', 'autocall-report');
    const body = { JobID: 'job-1', called: '905551112233', unique_id: 'attempt-redeliver', status: 'ANSWERED' };

    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([]);
    prisma.netgsmWebhookEvent.findMany.mockResolvedValueOnce([{ externalId: 'job-1:attempt-redeliver' }]);

    await controller.autocallReport('ws-1', token, body);
    await controller.autocallReport('ws-1', token, body);

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });

  it('an element with no resolvable JobID is archived but NEVER published (fails closed)', async () => {
    const token = netgsmWebhookToken('ws-1', 'autocall-report');
    const body = { called: '905551112233', unique_id: 'u-1', status: 'ANSWERED' };

    await expect(controller.autocallReport('ws-1', token, body)).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.createMany).toHaveBeenCalledTimes(1);
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('acks ok on an empty array without touching prisma or the outbox', async () => {
    const token = netgsmWebhookToken('ws-1', 'autocall-report');

    await expect(controller.autocallReport('ws-1', token, [])).resolves.toEqual({ ok: true });

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('rejects a bad token with NotFoundException and never touches prisma or the outbox', async () => {
    await expect(
      controller.autocallReport('ws-1', 'bad-token', { JobID: 'job-1', unique_id: 'u-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.netgsmWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.netgsmWebhookEvent.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('rejects a token minted for a different purpose (e.g. voice-report)', async () => {
    const voiceToken = netgsmWebhookToken('ws-1', 'voice-report');

    await expect(
      controller.autocallReport('ws-1', voiceToken, { JobID: 'job-1', unique_id: 'u-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * Throttling (NetGSM Phase 3 Task 6, Phase-0 finding): NetGSM pushes every
 * tenant's santral events AND İYS push-backs from a small, fixed set of its
 * own server IPs — the global 300 req/min PER-IP ThrottlerGuard would 429 that
 * shared IP under real cross-tenant volume. `@SkipThrottle()` records
 * `THROTTLER:SKIPdefault: true` as Reflect metadata on the handler — same
 * fitness-test idiom as `public-write-throttle.arch.spec.ts`'s own
 * `THROTTLER:LIMITdefault` check.
 */
describe('NetgsmEventsController — throttling', () => {
  const SKIP_META = 'THROTTLER:SKIPdefault';

  function skipsThrottle(method: string): unknown {
    return Reflect.getMetadata(SKIP_META, (NetgsmEventsController.prototype as Record<string, unknown>)[method] as object);
  }

  it('the events route skips the global rate limiter', () => {
    expect(skipsThrottle('events')).toBe(true);
  });

  it('the iys route also skips it (İYS push-back is NetGSM-originated too, same shared IPs)', () => {
    expect(skipsThrottle('iys')).toBe(true);
  });

  it('the voice-report route also skips it (voicesms report is NetGSM-originated too, same shared IPs)', () => {
    expect(skipsThrottle('voiceReport')).toBe(true);
  });

  it('the autocall-report route also skips it (autocall attempt report is NetGSM-originated too, same shared IPs)', () => {
    expect(skipsThrottle('autocallReport')).toBe(true);
  });
});
