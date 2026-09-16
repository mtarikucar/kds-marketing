import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { WorkspaceMailboxService } from '../channels/workspace-mailbox.service';
import { EmailService } from '../../../common/services/email.service';
import { MessageQuotaService } from '../channels/message-quota.service';
import { CommerceTraceService } from './commerce-trace.service';
import { commerceActivity } from './commerce-activity';

type Transport = 'mailbox' | 'platform';

/**
 * Email a priced document's public link to the customer.
 *
 * The sibling of `InvoiceTextService` (SMS/WhatsApp text-to-pay), which had no
 * email twin — so the two documents that carry the money, the quote and the
 * invoice, could be "sent" without the customer ever being told. `send()` on
 * both services only flips a status and hands a URL back to the caller; the
 * invoices screen copied it to the CLIPBOARD and the estimates screen threw it
 * away. This is the delivery that was missing.
 *
 * Deliberately NOT added to `InvoicesService.send()`: that method has a second
 * caller, `OrderFormsService`, so delivery there would silently mail every
 * public order-form buyer. Status transitions stay where they are; delivery
 * lives here.
 *
 * Two orderings are load-bearing and both copy the proven sibling:
 *
 * - **Refuse before metering.** A missing PUBLIC_BASE_URL means the only thing
 *   in the mail would be a dead link, so it fails before a message is reserved.
 * - **Deliver, then flip.** The status claim runs only after the mail is
 *   accepted, and it is CONDITIONAL — an invoice paid or voided during the send
 *   must not be resurrected to SENT, which an unconditional update off the
 *   pre-send read would do.
 */
@Injectable()
export class DocumentEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mailbox: WorkspaceMailboxService,
    private readonly email: EmailService,
    private readonly quota: MessageQuotaService,
    private readonly trace: CommerceTraceService,
  ) {}

  async sendInvoice(workspaceId: string, invoiceId: string, actorId?: string | null) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, workspaceId },
      select: { id: true, publicToken: true, number: true, leadId: true, status: true, total: true, currency: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID' || inv.status === 'VOID') {
      throw new BadRequestException('Invoice is not payable');
    }

    const to = await this.reachableAddress(workspaceId, inv.leadId, 'invoice');
    const link = this.publicLink('i', inv.publicToken);
    const subject = `Invoice ${inv.number}`;
    const via = await this.deliver(workspaceId, to, subject, `${subject}\n\n${link}`);

    // CONDITIONAL claim: the send takes seconds, and an invoice paid or voided
    // in that window must match zero rows here rather than become payable again.
    await this.prisma.invoice.updateMany({
      where: { id: inv.id, workspaceId, status: 'DRAFT' },
      data: { status: 'SENT' },
    });

    await this.trace.record(
      workspaceId,
      inv.leadId,
      commerceActivity({
        event: 'invoice_sent',
        docId: inv.id,
        number: inv.number,
        totalMinor: inv.total,
        currency: inv.currency,
        to,
        via,
      }),
      { actorId: actorId ?? null },
    );

    return { sent: true, to, via, payUrl: link };
  }

  async sendEstimate(workspaceId: string, estimateId: string, actorId?: string | null) {
    const est = await this.prisma.estimate.findFirst({
      where: { id: estimateId, workspaceId },
      select: { id: true, publicToken: true, number: true, leadId: true, status: true, total: true, currency: true },
    });
    if (!est) throw new NotFoundException('Estimate not found');
    if (est.status === 'ACCEPTED' || est.status === 'DECLINED') {
      throw new BadRequestException('Estimate already resolved');
    }

    const to = await this.reachableAddress(workspaceId, est.leadId, 'estimate');
    const link = this.publicLink('e', est.publicToken);
    const subject = `Quote ${est.number}`;
    const via = await this.deliver(workspaceId, to, subject, `${subject}\n\n${link}`);

    // A quote may legitimately be re-sent, so both pre-answer states claim —
    // but a quote the customer answered mid-send keeps its answer.
    await this.prisma.estimate.updateMany({
      where: { id: est.id, workspaceId, status: { in: ['DRAFT', 'SENT'] } },
      data: { status: 'SENT' },
    });

    await this.trace.record(
      workspaceId,
      est.leadId,
      commerceActivity({
        event: 'quote_sent',
        docId: est.id,
        number: est.number,
        totalMinor: est.total,
        currency: est.currency,
        to,
        via,
      }),
      { actorId: actorId ?? null },
    );

    return { sent: true, to, via, publicUrl: link };
  }

  /**
   * The address, or a refusal naming why this document cannot be emailed.
   *
   * A hard-bounced or provably invalid address is refused rather than sent to:
   * the platform's whole outbound identity shares one sending reputation, and
   * the same guard already sits in `OutboundConversationService`.
   */
  private async reachableAddress(
    workspaceId: string,
    leadId: string | null,
    kind: 'invoice' | 'estimate',
  ): Promise<string> {
    if (!leadId) throw new BadRequestException(`This ${kind} has no contact to email`);
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { email: true, emailBouncedAt: true, emailVerifiedStatus: true },
    });
    const to = lead?.email?.trim();
    if (!to) throw new BadRequestException('Contact has no email address');
    if (lead?.emailBouncedAt) {
      throw new BadRequestException('This email address has hard-bounced and cannot be mailed');
    }
    if (lead?.emailVerifiedStatus === 'INVALID') {
      throw new BadRequestException('This email address is not deliverable');
    }
    return to;
  }

  private publicLink(segment: 'i' | 'e', token: string | null): string {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    if (!base) {
      throw new BadRequestException(
        'PUBLIC_BASE_URL is not configured — the email would carry a dead link',
      );
    }
    return `${base}/api/public/${segment}/${token}`;
  }

  /**
   * Send as the workspace when it has a verified mailbox, else on the platform
   * transport — the fallback protocol `WorkspaceMailboxService` publishes, and
   * the same one the campaign sender and the workflow engine already follow.
   *
   * `EmailService.sendPlainEmail` answers TRUE with no transporter (it logs
   * `[EMAIL MOCK]`), so `isConfigured()` is asked first: a caller that must not
   * claim a delivery it cannot make has to look before it sends.
   */
  private async deliver(
    workspaceId: string,
    to: string,
    subject: string,
    text: string,
  ): Promise<Transport> {
    await this.quota.reserve(workspaceId, 'EMAIL');
    try {
      const own = await this.mailbox.send({ workspaceId, to, subject, text });
      if (own) {
        if (!own.ok) throw new BadRequestException(own.error ?? 'Email send failed');
        return 'mailbox';
      }
      if (!this.email.isConfigured()) {
        throw new BadRequestException('No mailbox is connected and email is not configured');
      }
      const ok = await this.email.sendPlainEmail(to, subject, text);
      if (!ok) {
        throw new BadRequestException(this.email.consumeLastPlainSendError() ?? 'Email send failed');
      }
      return 'platform';
    } catch (e) {
      await this.quota.refund(workspaceId, 'EMAIL');
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException((e as Error)?.message ?? 'Email send failed');
    }
  }
}
