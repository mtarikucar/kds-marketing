import { InvoicePaidConsumer } from './invoice-paid.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingInvoicePaidPayload } from '../events/marketing-event-types';

function makeEvent(
  id: string,
  overrides: Partial<MarketingInvoicePaidPayload> = {},
): DomainEvent<MarketingInvoicePaidPayload> {
  const payload: MarketingInvoicePaidPayload = {
    workspaceId: 'ws-1',
    invoiceId: 'inv-1',
    leadId: 'lead-1',
    total: 15000, // 150.00 TRY in kuruş
    currency: 'TRY',
    via: 'wallet',
    occurredAt: '2026-07-09T10:00:00.000Z',
    ...overrides,
  };
  return {
    id,
    type: MarketingEventTypes.InvoicePaid,
    tenantId: null,
    idempotencyKey: id,
    createdAt: new Date('2026-07-09T10:00:00.000Z'),
    payload,
  };
}

/**
 * InvoicePaidConsumer is the last missing half of the money story on a person's
 * stream: the invoice could be emailed (DocumentEmailService traces that) and
 * then PAID with nothing said about it, so someone who had just paid looked
 * identical to someone who never replied.
 *
 * The behaviors that matter:
 *  - the invoice NUMBER is not on the event, so it is read back workspace-scoped;
 *  - minor units and the payment route reach the mapper untouched;
 *  - the customer paid, so the row is attributed to the workspace SYSTEM
 *    sentinel — the consumer passes NO actor;
 *  - `event.id` dedupe guards the outbox worker's orphan-reclaim redispatch;
 *  - an invoice with no contact, or one that cannot be read, writes nothing;
 *  - a failing trace never escapes the handler — the invoice is already PAID and
 *    nothing about recording it may look like the payment failed.
 */
describe('InvoicePaidConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock; off: jest.Mock };
  let trace: { record: jest.Mock };
  let svc: InvoicePaidConsumer;

  const handle = (e: DomainEvent<MarketingInvoicePaidPayload>) => (svc as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn(), off: jest.fn() };
    trace = { record: jest.fn().mockResolvedValue(undefined) };
    svc = new InvoicePaidConsumer(prisma as any, bus as any, trace as any);
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue({ number: 'INV-1042' });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('subscribes on init and detaches the SAME handler ref on destroy', () => {
      svc.onModuleInit();
      expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.InvoicePaid, expect.any(Function));
      const registered = bus.on.mock.calls[0][1];
      svc.onModuleDestroy();
      expect(bus.off).toHaveBeenCalledWith(MarketingEventTypes.InvoicePaid, registered);
    });
  });

  describe('handle', () => {
    it('reads the invoice number back workspace-scoped (the event does not carry it)', async () => {
      await handle(makeEvent('evt-1'));
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
        where: { id: 'inv-1', workspaceId: 'ws-1' },
        select: { number: true },
      });
    });

    it('records the paid row with the number, the raw minor total and the payment route', async () => {
      await handle(makeEvent('evt-1'));

      const [workspaceId, leadId, row] = trace.record.mock.calls[0];
      expect(workspaceId).toBe('ws-1');
      expect(leadId).toBe('lead-1');
      expect(row.title).toBe('Invoice INV-1042 paid');
      // The mapper owns minor→major, so the consumer must hand it the column
      // value untouched; 150 TRY here proves it was not pre-divided.
      expect(row.description).toBe('150 TRY · wallet');
      expect(row.metadata).toMatchObject({
        kind: 'commerce',
        event: 'invoice_paid',
        docId: 'inv-1',
        number: 'INV-1042',
        totalMinor: 15000,
        currency: 'TRY',
        paidVia: 'wallet',
      });
    });

    it('attributes the row to the SYSTEM sentinel — the customer paid, not a colleague', async () => {
      await handle(makeEvent('evt-1'));
      // No actor argument at all: passing one would credit a teammate with
      // something the customer did.
      expect(trace.record.mock.calls[0]).toHaveLength(3);
    });

    it('dedupes a redispatched event.id (the outbox is at-least-once)', async () => {
      await handle(makeEvent('evt-1'));
      await handle(makeEvent('evt-1'));
      expect(trace.record).toHaveBeenCalledTimes(1);
    });

    it('still records a genuinely different event for the same invoice', async () => {
      await handle(makeEvent('evt-1'));
      await handle(makeEvent('evt-2'));
      expect(trace.record).toHaveBeenCalledTimes(2);
    });

    it('writes nothing when the invoice has no contact — and does not even look it up', async () => {
      await handle(makeEvent('evt-1', { leadId: null }));
      expect(trace.record).not.toHaveBeenCalled();
      expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
    });

    it('writes nothing when the invoice cannot be read in this workspace', async () => {
      (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(null);
      await handle(makeEvent('evt-1'));
      expect(trace.record).not.toHaveBeenCalled();
    });

    it('skips a malformed payload rather than guessing', async () => {
      await handle(makeEvent('evt-1', { workspaceId: '' as any }));
      await handle(makeEvent('evt-2', { invoiceId: '' as any }));
      expect(trace.record).not.toHaveBeenCalled();
    });

    it('never lets a trace failure escape — the invoice is already PAID', async () => {
      trace.record.mockRejectedValue(new Error('db down'));
      await expect(handle(makeEvent('evt-1'))).resolves.toBeUndefined();
    });
  });
});
