import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingInvoicePaidPayload } from '../events/marketing-event-types';
import { CommerceTraceService } from './commerce-trace.service';
import { commerceActivity } from './commerce-activity';
import { DocumentEmailService } from './document-email.service';
import { notifyCommerce } from './commerce-notify';
import { formatMinorAmount } from './priced-document.util';

/**
 * The paid half of the money story on a person's stream.
 *
 * `DocumentEmailService` records the quote and the invoice going OUT, but the
 * moment that matters most — the customer actually paying — happens far from
 * any screen: a PSP webhook, a wallet debit, a manual mark-paid. Until this
 * consumer existed none of those wrote anything on the person, so someone who
 * had just paid looked identical to someone who never replied.
 *
 * It reacts rather than being called, for one reason: the settle path already
 * emits `marketing.invoice.paid.v1` exactly once, from inside the transaction
 * that wins the conditional PAID claim. Hanging the trace off that event means
 * every settlement route — Stripe, PayTR, İyzico, wallet, manual — is covered
 * by one listener, and none of them grows a second thing it must remember to
 * do. The trace can never resurrect an invoice or fail a payment: it is
 * downstream of the claim, and `CommerceTraceService` does not throw.
 *
 * Two deliberate omissions: NO commission is credited here (that is
 * `SettlementCommissionConsumer`'s job, on a different event and a different
 * money model) and NO lead status is moved (a paid invoice is not by itself a
 * WON deal — the opportunity, not the invoice, owns that).
 *
 * IDEMPOTENCY: `DomainEvent.id` dedupe (bounded in-memory Set — the same idiom
 * as AutocallReportConsumer/VoiceReportConsumer/TelephonyEventConsumer/
 * IysWebhookConsumer) guards the outbox worker's orphan-reclaim sweep
 * re-dispatching the same row. The producer's own `invoice-paid:<id>`
 * idempotency key means a genuinely NEW event here is always a distinct
 * settlement.
 */
@Injectable()
export class InvoicePaidConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoicePaidConsumer.name);

  private static readonly MAX_SEEN_IDS = 2_000;
  private readonly seenEventIds = new Set<string>();

  private readonly invoicePaidHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<MarketingInvoicePaidPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly trace: CommerceTraceService,
    private readonly documentEmail: DocumentEmailService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.InvoicePaid, this.invoicePaidHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.InvoicePaid, this.invoicePaidHandler);
  }

  private async handle(event: DomainEvent<MarketingInvoicePaidPayload>): Promise<void> {
    if (this.seenEventIds.has(event.id)) return; // already processed (replay)
    this.remember(event.id);

    const p = event.payload ?? ({} as MarketingInvoicePaidPayload);
    if (!p.workspaceId || !p.invoiceId) {
      this.logger.warn(`invoice paid event ${event.id} missing workspaceId/invoiceId — skipping`);
      return;
    }
    // No contact ⇒ nobody to write on. A walk-in sale invoiced to nobody is a
    // normal state, not an error, so it is a quiet skip — and not even a read.
    if (!p.leadId) return;

    try {
      // The number is not on the event (see the payload's docstring). Scoped by
      // workspace as well as id: the event is trusted, but this read is what
      // keeps a mis-addressed payload from naming a neighbour's invoice.
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: p.invoiceId, workspaceId: p.workspaceId },
        select: { number: true },
      });
      if (!invoice) {
        this.logger.warn(
          `invoice paid event ${event.id}: invoice ${p.invoiceId} not readable in workspace ${p.workspaceId} — skipping`,
        );
        return;
      }

      // Minor units and the payment route go to the mapper untouched — it owns
      // the money formatting, so no second call site can render ₺150 as ₺15000.
      // No actor is passed: the CUSTOMER paid, so the row belongs to the
      // workspace SYSTEM sentinel rather than to whichever colleague happened
      // to be nearby.
      await this.trace.record(
        p.workspaceId,
        p.leadId,
        commerceActivity({
          event: 'invoice_paid',
          docId: p.invoiceId,
          number: invoice.number,
          totalMinor: p.total,
          currency: p.currency,
          paidVia: p.via,
        }),
      );

      // `no-payment-receipt`: a wallet or manual payment confirmed nothing to
      // EITHER side. Both halves are deliberately after the trace and inside
      // the same try — the money has already moved, so neither a receipt nor a
      // bell may turn into a failed payment. The receipt's own dedupe is the
      // mail ledger's durable idempotency key, not this consumer's in-memory
      // Set, which is empty after exactly the restart that makes the outbox
      // redeliver.
      await this.documentEmail.sendPaymentReceipt(p.workspaceId, p.invoiceId);

      const amount = formatMinorAmount(p.total, p.currency, null);
      await notifyCommerce(
        this.prisma,
        {
          workspaceId: p.workspaceId,
          leadId: p.leadId,
          type: 'INVOICE_PAID',
          title: `Invoice ${invoice.number} paid`,
          message: [`Invoice ${invoice.number} was paid`, amount && `(${amount})`, p.via && `via ${p.via}`]
            .filter(Boolean)
            .join(' ') + '.',
          metadata: { docId: p.invoiceId, number: invoice.number, paidVia: p.via ?? null },
        },
        this.logger,
      );
    } catch (e) {
      // The invoice is already PAID and the money has already moved. A failed
      // trace is a missing line in a story, never a failed payment.
      this.logger.warn(
        `invoice paid event ${event.id}: could not record the trace for invoice ${p.invoiceId}: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  private remember(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > InvoicePaidConsumer.MAX_SEEN_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}
