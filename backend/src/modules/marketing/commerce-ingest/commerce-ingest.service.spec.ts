import { Prisma } from '@prisma/client';
import { CommerceIngestService } from './commerce-ingest.service';
import { OrderEventV1 } from './dto/order-event.dto';

const WS = 'ws-1';
const SOURCE = { id: 'src-1', slug: 'shop' };

/** Just enough of Prisma, in memory, for the ingest transaction. */
function fakePrisma() {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const orders: any[] = [];
  const events: any[] = [];
  const leads: any[] = [];
  const sources: any[] = [{ ...SOURCE, workspaceId: WS, lastEventAt: null }];
  let failNextEventCreate: unknown = null;

  const db: any = {
    externalOrderEvent: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.sourceId_eventId;
        const ev = events.find((e) => e.sourceId === k.sourceId && e.eventId === k.eventId);
        return ev ? { ...ev, order: orders.find((o) => o.id === ev.orderId) } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (failNextEventCreate) {
          const err = failNextEventCreate;
          failNextEventCreate = null;
          throw err;
        }
        const row = { id: id('ev'), receivedAt: new Date(), ...data };
        events.push(row);
        return row;
      }),
    },
    externalOrder: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.workspaceId_sourceId_externalId;
        return (
          orders.find((o) => o.workspaceId === k.workspaceId && o.sourceId === k.sourceId && o.externalId === k.externalId) ??
          null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('ord'), refundedMinor: 0, leadId: null, paidAt: null, refundedAt: null, cancelledAt: null, ...data };
        orders.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = orders.find((o) => o.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    commerceSource: {
      update: jest.fn(async ({ where, data }: any) => Object.assign(sources.find((s) => s.id === where.id), data)),
    },
    lead: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('lead'), ...data };
        leads.push(row);
        return row;
      }),
    },
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return {
    db,
    orders,
    events,
    leads,
    sources,
    failNextEventCreate: (e: unknown) => (failNextEventCreate = e),
  };
}

function build() {
  const p = fakePrisma();
  const attribution = { capture: jest.fn().mockResolvedValue(undefined) };
  const outbox = { append: jest.fn().mockResolvedValue(undefined) };
  const trace = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new CommerceIngestService(p.db, attribution as never, outbox as never, trace as never);
  return { ...p, svc, attribution, outbox, trace };
}

function event(over: Partial<OrderEventV1> & { order?: Partial<OrderEventV1['order']> } = {}): OrderEventV1 {
  const { order, ...rest } = over;
  return {
    version: 1,
    eventId: 'shop:order.paid:FIG-1',
    event: 'order.paid',
    occurredAt: '2026-10-21T09:14:03.000Z',
    order: {
      externalId: 'FIG-1',
      groupRef: null,
      createdAt: '2026-10-21T09:02:11.000Z',
      currency: 'TRY',
      amountMinor: 349900,
      refundedMinor: 0,
      paymentMethod: 'card',
      items: [{ sku: 'fig-15', name: 'Figür 15 cm', qty: 1, unitMinor: 349900 }],
      ...order,
    },
    customer: { email: 'ayse@example.com', phone: '+905321234567', name: 'Ayşe' },
    attribution: { utmSource: 'instagram', utmMedium: 'paid_social', utmCampaign: 'ekim-hediye' },
    ...rest,
  } as OrderEventV1;
}

const ingest = (b: ReturnType<typeof build>, ev: OrderEventV1, hash = `h:${ev.eventId}`) =>
  b.svc.ingest(WS, SOURCE, ev, hash);

describe('CommerceIngestService (contract §1.3–§1.5)', () => {
  it('records a paid order: PAID, paidAt = occurredAt, applied event, lead + attribution', async () => {
    const b = build();
    const out = await ingest(b, event());
    expect(out).toEqual({
      ok: true,
      duplicate: false,
      orderId: b.orders[0].id,
      status: 'PAID',
      leadId: b.leads[0].id,
      leadMatched: 'created',
    });
    expect(b.orders).toHaveLength(1);
    expect(b.orders[0]).toMatchObject({
      workspaceId: WS,
      sourceId: SOURCE.id,
      externalId: 'FIG-1',
      status: 'PAID',
      currency: 'TRY',
      amountMinor: 349900,
      refundedMinor: 0,
      paymentMethod: 'card',
      paidAt: new Date('2026-10-21T09:14:03.000Z'),
      orderedAt: new Date('2026-10-21T09:02:11.000Z'),
      lastEventAt: new Date('2026-10-21T09:14:03.000Z'),
      utmSource: 'instagram',
      utmMedium: 'paid_social',
      utmCampaign: 'ekim-hediye',
      leadId: b.leads[0].id,
    });
    expect(b.events).toHaveLength(1);
    expect(b.events[0]).toMatchObject({
      workspaceId: WS,
      sourceId: SOURCE.id,
      orderId: b.orders[0].id,
      eventId: 'shop:order.paid:FIG-1',
      type: 'order.paid',
      bodyHash: 'h:shop:order.paid:FIG-1',
      applied: true,
    });
    // The raw body (customer PII) is never stored on the event.
    expect(Object.keys(b.events[0])).not.toContain('body');
    expect(b.sources[0].lastEventAt).toBeInstanceOf(Date);
    expect(b.db.$transaction).toHaveBeenCalledTimes(1);
    expect(b.trace.record).toHaveBeenCalledWith(
      WS,
      b.leads[0].id,
      expect.objectContaining({ type: 'COMMERCE', metadata: expect.objectContaining({ event: 'order_paid' }) }),
    );
  });

  it('is idempotent on eventId: same body → duplicate, nothing written; different body → 409', async () => {
    const b = build();
    const first = await ingest(b, event(), 'hash-A');
    const again = await ingest(b, event(), 'hash-A');
    expect(again).toMatchObject({ ok: true, duplicate: true, orderId: first.orderId, status: 'PAID', leadId: first.leadId });
    expect(b.orders).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(b.leads).toHaveLength(1);

    await expect(ingest(b, event({ order: { amountMinor: 1 } }), 'hash-B')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ ok: false, code: 'EVENT_ID_REUSED' }),
    });
    expect(b.events).toHaveLength(1);
  });

  it('treats a concurrent insert of the same eventId as the duplicate it is', async () => {
    const b = build();
    await ingest(b, event(), 'hash-A');
    // Simulate the race: the pre-check misses, the unique index catches it.
    b.db.externalOrderEvent.findUnique.mockResolvedValueOnce(null);
    b.failNextEventCreate(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    const out = await ingest(b, event(), 'hash-A');
    expect(out).toMatchObject({ duplicate: true, status: 'PAID' });
    expect(b.events).toHaveLength(1);
  });

  it('refunds only grow: 100000 then 349900 → REFUNDED; a late 100000 does not lower it', async () => {
    const b = build();
    await ingest(b, event());
    const partial = await ingest(
      b,
      event({ eventId: 'r1', event: 'order.refunded', occurredAt: '2026-10-22T10:00:00.000Z', order: { refundedMinor: 100000 } }),
    );
    expect(partial.status).toBe('PAID');
    expect(b.orders[0].refundedMinor).toBe(100000);
    expect(b.orders[0].refundedAt).toEqual(new Date('2026-10-22T10:00:00.000Z'));

    const full = await ingest(
      b,
      event({ eventId: 'r2', event: 'order.refunded', occurredAt: '2026-10-23T10:00:00.000Z', order: { refundedMinor: 349900 } }),
    );
    expect(full.status).toBe('REFUNDED');
    expect(b.orders[0].refundedMinor).toBe(349900);

    const late = await ingest(
      b,
      event({ eventId: 'r1-late', event: 'order.refunded', occurredAt: '2026-10-22T10:00:00.000Z', order: { refundedMinor: 100000 } }),
    );
    expect(late.status).toBe('REFUNDED');
    expect(b.orders[0].refundedMinor).toBe(349900);
    expect(b.orders[0].refundedAt).toEqual(new Date('2026-10-23T10:00:00.000Z'));
    expect(b.events.find((e) => e.eventId === 'r1-late').applied).toBe(false);
    // Paid date is the sale day; refunds never move it.
    expect(b.orders[0].paidAt).toEqual(new Date('2026-10-21T09:14:03.000Z'));
    expect(b.trace.record).toHaveBeenCalledWith(
      WS,
      expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ event: 'order_refunded' }) }),
    );
  });

  it('never moves state backwards: paid then created stays PAID, the event is kept with applied=false', async () => {
    const b = build();
    await ingest(b, event());
    const out = await ingest(b, event({ eventId: 'c1', event: 'order.created', occurredAt: '2026-10-21T09:02:11.000Z' }));
    expect(out.status).toBe('PAID');
    expect(b.events).toHaveLength(2);
    expect(b.events[1]).toMatchObject({ eventId: 'c1', applied: false });
  });

  it('created → PENDING, then paid → PAID', async () => {
    const b = build();
    const created = await ingest(b, event({ eventId: 'c1', event: 'order.created', occurredAt: '2026-10-21T09:02:11.000Z' }));
    expect(created.status).toBe('PENDING');
    expect(b.orders[0].paidAt).toBeNull();
    const paid = await ingest(b, event());
    expect(paid.status).toBe('PAID');
    expect(b.orders[0].paidAt).toEqual(new Date('2026-10-21T09:14:03.000Z'));
    expect(b.events.map((e) => e.applied)).toEqual([true, true]);
  });

  it('cancelled is terminal: a later paid does not resurrect it', async () => {
    const b = build();
    await ingest(b, event());
    const c = await ingest(b, event({ eventId: 'x1', event: 'order.cancelled', occurredAt: '2026-10-22T08:00:00.000Z' }));
    expect(c.status).toBe('CANCELLED');
    expect(b.orders[0].cancelledAt).toEqual(new Date('2026-10-22T08:00:00.000Z'));
    const p = await ingest(b, event({ eventId: 'p2' }));
    expect(p.status).toBe('CANCELLED');
    expect(b.events.at(-1).applied).toBe(false);
  });

  it('rejects a currency change for the same externalId with 422 and writes nothing', async () => {
    const b = build();
    await ingest(b, event());
    await expect(ingest(b, event({ eventId: 'eur', order: { currency: 'EUR' } }))).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'CURRENCY_MISMATCH' }),
    });
    expect(b.events).toHaveLength(1);
    expect(b.orders[0].currency).toBe('TRY');
  });

  it('keeps an anonymous order without a lead, and opens none', async () => {
    const b = build();
    const out = await ingest(b, event({ customer: undefined }));
    expect(out).toMatchObject({ leadId: null, leadMatched: 'none' });
    expect(b.leads).toHaveLength(0);
    expect(b.orders[0].leadId).toBeNull();
    expect(b.trace.record).not.toHaveBeenCalled();
  });

  it('matches the lead once per order: a later event does not re-run matching', async () => {
    const b = build();
    await ingest(b, event());
    b.db.lead.findFirst.mockClear();
    const out = await ingest(
      b,
      event({ eventId: 'r1', event: 'order.refunded', occurredAt: '2026-10-22T10:00:00.000Z', order: { refundedMinor: 1 } }),
    );
    expect(b.db.lead.findFirst).not.toHaveBeenCalled();
    expect(out.leadId).toBe(b.leads[0].id);
  });

  it('links a lead on a later event when the first one was anonymous', async () => {
    const b = build();
    await ingest(b, event({ eventId: 'c1', event: 'order.created', customer: undefined }));
    expect(b.orders[0].leadId).toBeNull();
    const out = await ingest(b, event());
    expect(out.leadMatched).toBe('created');
    expect(b.orders[0].leadId).toBe(b.leads[0].id);
  });

  it('stores the attribution and flat utm columns, and the items as given', async () => {
    const b = build();
    await ingest(b, event());
    expect(b.orders[0].attribution).toEqual({ utmSource: 'instagram', utmMedium: 'paid_social', utmCampaign: 'ekim-hediye' });
    expect(b.orders[0].items).toEqual([{ sku: 'fig-15', name: 'Figür 15 cm', qty: 1, unitMinor: 349900 }]);
  });
});
