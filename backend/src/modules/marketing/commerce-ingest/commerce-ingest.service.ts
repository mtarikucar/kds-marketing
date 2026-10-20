import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAttributionService } from '../leads/lead-attribution.service';
import { CommerceTraceService } from '../invoicing/commerce-trace.service';
import { commerceActivity } from '../invoicing/commerce-activity';
import { OrderEventV1 } from './dto/order-event.dto';
import { LeadMatched, matchOrderLead } from './external-order-lead.matcher';

export type ExternalOrderStatus = 'PENDING' | 'PAID' | 'REFUNDED' | 'CANCELLED';

export interface IngestResult {
  ok: true;
  duplicate: boolean;
  orderId: string;
  status: ExternalOrderStatus;
  leadId: string | null;
  /**
   * How this event found the customer. Present only when matching ran — the
   * first event of an order, or a later one while it still had no lead.
   */
  leadMatched?: LeadMatched;
}

/** The error body every refusal on this endpoint uses: `{ ok:false, code, message }`. */
export class CommerceIngestError extends HttpException {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ ok: false, code, message, ...extra }, status);
  }
}

/** One-way: PENDING < PAID < {REFUNDED, CANCELLED} (contract §1.5.4). */
const RANK: Record<ExternalOrderStatus, number> = { PENDING: 0, PAID: 1, REFUNDED: 2, CANCELLED: 2 };

type OrderRow = {
  id: string;
  status: string;
  currency: string;
  amountMinor: number;
  refundedMinor: number;
  paidAt: Date | null;
  refundedAt: Date | null;
  leadId: string | null;
  lastEventAt: Date;
};

/**
 * Applies one signed order event from a workspace's store (contract §1.3–§1.5).
 *
 * Idempotency is layered: the event row (`@@unique([sourceId, eventId])`) is the
 * durable record — the same eventId with the same body is a duplicate that
 * writes nothing, with a different body a 409. The order row is upserted on
 * `(workspaceId, sourceId, externalId)`. Events that arrive out of order are
 * kept with `applied=false` rather than moving the order backwards, and the
 * refunded amount only grows. Everything for one event — the event, the order,
 * the lead and its attribution — commits in ONE transaction.
 */
@Injectable()
export class CommerceIngestService {
  private readonly logger = new Logger(CommerceIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attribution: LeadAttributionService,
    private readonly outbox: OutboxService,
    private readonly trace: CommerceTraceService,
  ) {}

  async ingest(
    workspaceId: string,
    source: { id: string; slug: string },
    ev: OrderEventV1,
    bodyHash: string,
  ): Promise<IngestResult> {
    let outcome: { result: IngestResult; traced: 'order_paid' | 'order_refunded' | null; order: OrderRow & { externalId: string } };
    try {
      outcome = await this.prisma.$transaction((tx) => this.apply(tx, workspaceId, source, ev, bodyHash));
    } catch (err) {
      // Two deliveries of the same event raced past the pre-check; the unique
      // index let exactly one in. The loser is a duplicate (or a reuse).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const settled = await this.existingEvent(this.prisma, source.id, ev.eventId, bodyHash);
        if (settled) return settled;
      }
      throw err;
    }

    // The lead timeline, after commit: best-effort and never throws.
    if (outcome.traced && outcome.order.leadId) {
      const o = outcome.order;
      await this.trace.record(
        workspaceId,
        o.leadId,
        commerceActivity({
          event: outcome.traced,
          docId: o.id,
          number: o.externalId,
          totalMinor: outcome.traced === 'order_paid' ? o.amountMinor : o.refundedMinor,
          currency: o.currency,
          paidVia: outcome.traced === 'order_paid' ? ev.order.paymentMethod ?? null : null,
        }),
      );
    }
    return outcome.result;
  }

  private async apply(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    source: { id: string; slug: string },
    ev: OrderEventV1,
    bodyHash: string,
  ) {
    const dup = await this.existingEvent(tx, source.id, ev.eventId, bodyHash);
    if (dup) return { result: dup, traced: null, order: null as never };

    const at = new Date(ev.occurredAt);
    const o = ev.order;
    const existing = (await tx.externalOrder.findUnique({
      where: { workspaceId_sourceId_externalId: { workspaceId, sourceId: source.id, externalId: o.externalId } },
    })) as (OrderRow & { externalId: string }) | null;

    if (existing && existing.currency !== o.currency) {
      throw new CommerceIngestError(
        422,
        'CURRENCY_MISMATCH',
        `Order ${o.externalId} was recorded in ${existing.currency}; an event in ${o.currency} cannot change it.`,
      );
    }

    const change = transition(existing, ev, at);

    // Matched once per order: the first event that names the customer links
    // the lead, and later events leave that link alone.
    let leadId = existing?.leadId ?? null;
    let leadMatched: LeadMatched | undefined;
    if (!leadId) {
      const m = await matchOrderLead(tx, workspaceId, { customer: ev.customer, attribution: ev.attribution }, {
        attribution: this.attribution,
        outbox: this.outbox,
      });
      leadId = m.leadId;
      leadMatched = m.leadMatched;
    }

    const attribution = ev.attribution ? (JSON.parse(JSON.stringify(ev.attribution)) as Prisma.InputJsonValue) : undefined;
    let order: OrderRow & { externalId: string };
    if (!existing) {
      order = (await tx.externalOrder.create({
        data: {
          workspaceId,
          sourceId: source.id,
          externalId: o.externalId,
          groupRef: o.groupRef ?? null,
          currency: o.currency,
          amountMinor: o.amountMinor,
          paymentMethod: o.paymentMethod ?? null,
          items: o.items ? (JSON.parse(JSON.stringify(o.items)) as Prisma.InputJsonValue) : undefined,
          orderedAt: o.createdAt ? new Date(o.createdAt) : at,
          leadId,
          attribution,
          utmSource: ev.attribution?.utmSource ?? null,
          utmMedium: ev.attribution?.utmMedium ?? null,
          utmCampaign: ev.attribution?.utmCampaign ?? null,
          lastEventAt: at,
          ...change.data,
          // Every first event sets a status (see `transition`); PENDING is the floor.
          status: change.data.status ?? 'PENDING',
        },
      })) as never;
    } else {
      const data: Prisma.ExternalOrderUncheckedUpdateInput = { ...change.data };
      if (at > existing.lastEventAt) data.lastEventAt = at;
      if (!existing.leadId && leadId) data.leadId = leadId;
      // A forward move to PAID carries the store's final figures.
      if (change.applied && change.data.status === 'PAID') {
        data.amountMinor = o.amountMinor;
        if (o.paymentMethod) data.paymentMethod = o.paymentMethod;
        if (o.items) data.items = JSON.parse(JSON.stringify(o.items)) as Prisma.InputJsonValue;
      }
      order = Object.keys(data).length
        ? ((await tx.externalOrder.update({ where: { id: existing.id }, data })) as never)
        : existing;
    }

    await tx.externalOrderEvent.create({
      data: {
        workspaceId,
        sourceId: source.id,
        orderId: order.id,
        eventId: ev.eventId,
        type: ev.event,
        occurredAt: at,
        bodyHash,
        applied: change.applied,
      },
    });
    await tx.commerceSource.update({ where: { id: source.id }, data: { lastEventAt: new Date() } });

    const result: IngestResult = {
      ok: true,
      duplicate: false,
      orderId: order.id,
      status: order.status as ExternalOrderStatus,
      leadId: order.leadId ?? null,
      ...(leadMatched ? { leadMatched } : {}),
    };
    return { result, traced: change.applied ? change.traced : null, order };
  }

  private async existingEvent(
    db: Pick<Prisma.TransactionClient, 'externalOrderEvent'>,
    sourceId: string,
    eventId: string,
    bodyHash: string,
  ): Promise<IngestResult | null> {
    const prior = await db.externalOrderEvent.findUnique({
      where: { sourceId_eventId: { sourceId, eventId } },
      include: { order: { select: { id: true, status: true, leadId: true } } },
    });
    if (!prior) return null;
    if (prior.bodyHash !== bodyHash) {
      throw new CommerceIngestError(
        409,
        'EVENT_ID_REUSED',
        `eventId ${eventId} was already used for a different body. Give every distinct event its own eventId.`,
      );
    }
    return {
      ok: true,
      duplicate: true,
      orderId: prior.order.id,
      status: prior.order.status as ExternalOrderStatus,
      leadId: prior.order.leadId ?? null,
    };
  }
}

/**
 * What one event does to the order. Pure. `applied` is false when the event
 * changes nothing — out of order, already true, or a refund lower than one
 * already recorded.
 */
export function transition(
  current: Pick<OrderRow, 'status' | 'amountMinor' | 'refundedMinor' | 'paidAt' | 'refundedAt'> | null,
  ev: OrderEventV1,
  at: Date,
): {
  applied: boolean;
  traced: 'order_paid' | 'order_refunded' | null;
  data: Partial<{
    status: ExternalOrderStatus;
    paidAt: Date;
    refundedMinor: number;
    refundedAt: Date;
    cancelledAt: Date;
  }>;
} {
  const status = (current?.status ?? null) as ExternalOrderStatus | null;
  const rank = status ? RANK[status] : -1;
  const amount = current?.amountMinor ?? ev.order.amountMinor;

  switch (ev.event) {
    case 'order.created':
      return current
        ? { applied: false, traced: null, data: {} }
        : { applied: true, traced: null, data: { status: 'PENDING' } };

    case 'order.paid': {
      const data: ReturnType<typeof transition>['data'] = {};
      if (rank < RANK.PAID) data.status = 'PAID';
      // The sale date is a fact even when the status cannot move (a refund that
      // overtook its own payment); the status still never goes back.
      if (!current?.paidAt) data.paidAt = at;
      const applied = Object.keys(data).length > 0;
      return { applied, traced: data.status === 'PAID' ? 'order_paid' : null, data };
    }

    case 'order.refunded': {
      const incoming = ev.order.refundedMinor ?? 0;
      const before = current?.refundedMinor ?? 0;
      if (incoming <= before) {
        return current ? { applied: false, traced: null, data: {} } : { applied: true, traced: null, data: { status: 'PAID' } };
      }
      const data: ReturnType<typeof transition>['data'] = { refundedMinor: incoming, refundedAt: at };
      if (status !== 'CANCELLED') data.status = incoming >= amount ? 'REFUNDED' : status === 'REFUNDED' ? 'REFUNDED' : 'PAID';
      return { applied: true, traced: 'order_refunded', data };
    }

    case 'order.cancelled':
      if (status === 'CANCELLED' || status === 'REFUNDED') return { applied: false, traced: null, data: {} };
      return { applied: true, traced: null, data: { status: 'CANCELLED', cancelledAt: at } };
  }
}
