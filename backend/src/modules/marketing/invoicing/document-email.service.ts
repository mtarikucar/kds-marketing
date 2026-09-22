import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { MailCopyKey, escapeHtml, mailReasonKey, t, tHtml } from '../../../common/i18n/mail-copy';
import { OutboundMailService } from '../channels/outbound/outbound-mail.service';
import { MailClass } from '../channels/outbound/mail-class';
import { MailReceipt } from '../channels/outbound/outbound-mail.types';
import { SuppressionReason, SuppressionService } from '../compliance/suppression.service';
import { CommerceTraceService } from './commerce-trace.service';
import { commerceActivity } from './commerce-activity';
import { formatDocumentDate, formatMinorAmount, isQuoteExpired } from './priced-document.util';

type Transport = 'mailbox' | 'platform';

/** Which document a refusal is talking about. */
type DocKind = 'invoice' | 'estimate' | 'agreement';

/** The public route a document is read on: `/api/public/{i,e,d}/<token>`. */
type LinkSegment = 'i' | 'e' | 'd';

/** One paragraph of a document mail: dictionary copy, or the tenant's own words. */
type Line =
  | { key: MailCopyKey; vars?: Record<string, string>; url?: string }
  | { raw: string; url?: string };

/** What the workspace is called to a customer, and in which language. */
interface Brand {
  business: string;
  lang: string | null;
}

/** The customer this document can actually be mailed to. */
interface Recipient {
  to: string;
  leadId: string;
  name: string | null;
}

/**
 * A suppression reason in the recipient's words. The two vocabularies differ by
 * one letter in places (`ERASURE` ⇒ `SUPPRESSED_ERASED`), and a hand-built key
 * would print `mail.reason.SUPPRESSED_ERASURE` at a user (PLAN G8: a server
 * reason code is never shown raw).
 */
const SUPPRESSION_COPY: Record<SuppressionReason, MailCopyKey> = {
  ERASURE: mailReasonKey('SUPPRESSED_ERASED'),
  HARD_BOUNCE: mailReasonKey('SUPPRESSED_BOUNCE'),
  INVALID: mailReasonKey('SUPPRESSED_INVALID'),
  COMPLAINT: mailReasonKey('SUPPRESSED_COMPLAINT'),
  OPT_OUT: mailReasonKey('SUPPRESSED_OPT_OUT'),
  MANUAL: mailReasonKey('SUPPRESSED_OPT_OUT'),
};

/**
 * Email a priced document to the customer: a quote, an invoice, the receipt
 * for a payment, an agreement to sign.
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
 * ## What the customer reads
 *
 * The mail used to be an English subject and a bare link — no business name,
 * no amount, no due date — which reads like invoice phishing from a brand the
 * recipient has never heard of, and is ignored or reported
 * (`document-email-bare`). Every mail here now names the business, the sum and
 * the date, in the workspace's own language, through `common/i18n/mail-copy`.
 *
 * ## Why everything goes out through the gateway
 *
 * `OutboundMailService` owns the transport ladder, the metering, the
 * suppression gate, the ledger row and the receipt. This service's job is to
 * decide WHAT to say and WHETHER the document may be sent at all; the gateway
 * decides whether the mail can leave and says, in one receipt, what happened.
 *
 * Three orderings are load-bearing:
 *
 * - **Refuse before metering.** A missing PUBLIC_BASE_URL, an expired quote or
 *   a dead address never reaches the gateway, so no message is reserved for a
 *   mail that was never going to be sent.
 * - **Deliver, then flip.** The status claim runs only after the mail is
 *   accepted, and it is CONDITIONAL — an invoice paid or voided during the send
 *   must not be resurrected to SENT, which an unconditional update off the
 *   pre-send read would do.
 * - **The class is TRANSACTIONAL, never BULK.** Per the gate matrix that means
 *   the invoice still reaches a customer who unticked marketing mail, and it
 *   never acquires a `List-Unsubscribe` header (which would tell Gmail this
 *   business mail is a list).
 */
@Injectable()
export class DocumentEmailService {
  private readonly logger = new Logger(DocumentEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outbound: OutboundMailService,
    private readonly suppression: SuppressionService,
    private readonly trace: CommerceTraceService,
  ) {}

  async sendInvoice(workspaceId: string, invoiceId: string, actorId?: string | null) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, workspaceId },
      select: {
        id: true,
        publicToken: true,
        number: true,
        leadId: true,
        status: true,
        total: true,
        currency: true,
        notes: true,
        dueDate: true,
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID' || inv.status === 'VOID') {
      throw new BadRequestException('Invoice is not payable');
    }

    const brand = await this.brand(workspaceId);
    const who = await this.reachableAddress(workspaceId, inv.leadId, 'invoice');
    const link = this.publicLink('i', inv.publicToken);
    const amount = formatMinorAmount(inv.total, inv.currency, brand.lang);
    const subject = t(brand.lang, 'document.invoice.subject', {
      business: brand.business,
      number: inv.number,
    });
    const body = this.render(brand.lang, [
      ...this.greeting(who),
      { key: 'document.invoice.body', vars: { business: brand.business, number: inv.number } },
      ...(amount ? [{ key: 'document.invoice.amountLine' as MailCopyKey, vars: { amount } }] : []),
      ...this.dateLine('document.invoice.dueLine', brand.lang, inv.dueDate),
      ...(inv.notes?.trim() ? [{ raw: inv.notes.trim() }] : []),
      { key: 'document.invoice.payLine', vars: { url: link }, url: link },
      { key: 'document.signoff', vars: { business: brand.business } },
    ]);

    const via = await this.deliver({
      workspaceId,
      mailClass: 'TRANSACTIONAL',
      to: who.to,
      leadId: who.leadId,
      lang: brand.lang,
      subject,
      body,
      source: `invoice:${inv.id}`,
    });

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
        to: who.to,
        via,
      }),
      { actorId: actorId ?? null },
    );

    return { sent: true, to: who.to, via, payUrl: link };
  }

  async sendEstimate(workspaceId: string, estimateId: string, actorId?: string | null) {
    const est = await this.prisma.estimate.findFirst({
      where: { id: estimateId, workspaceId },
      select: {
        id: true,
        publicToken: true,
        number: true,
        leadId: true,
        status: true,
        total: true,
        currency: true,
        notes: true,
        validUntil: true,
      },
    });
    if (!est) throw new NotFoundException('Estimate not found');
    if (est.status === 'ACCEPTED' || est.status === 'DECLINED') {
      throw new BadRequestException('Estimate already resolved');
    }
    // `expired-quote-emailed`: the customer opens it, presses Accept and is
    // told "expired". Same predicate as `publicAccept` and `convertToInvoice`,
    // so the send and the accept can never disagree. The wording names the real
    // recourse: a SENT quote cannot be edited, so "extend it" is not advice the
    // user could follow.
    if (isQuoteExpired(est.validUntil)) {
      throw new BadRequestException(
        `This quote expired on ${formatDocumentDate(est.validUntil, 'en')} — issue a new quote`,
      );
    }

    const brand = await this.brand(workspaceId);
    const who = await this.reachableAddress(workspaceId, est.leadId, 'estimate');
    const link = this.publicLink('e', est.publicToken);
    const amount = formatMinorAmount(est.total, est.currency, brand.lang);
    const subject = t(brand.lang, 'document.quote.subject', {
      business: brand.business,
      number: est.number,
    });
    const body = this.render(brand.lang, [
      ...this.greeting(who),
      { key: 'document.quote.body', vars: { business: brand.business, number: est.number } },
      ...(amount ? [{ key: 'document.quote.totalLine' as MailCopyKey, vars: { amount } }] : []),
      ...this.dateLine('document.quote.validUntilLine', brand.lang, est.validUntil),
      ...(est.notes?.trim() ? [{ raw: est.notes.trim() }] : []),
      { key: 'document.quote.viewLine', vars: { url: link }, url: link },
      { key: 'document.signoff', vars: { business: brand.business } },
    ]);

    const via = await this.deliver({
      workspaceId,
      mailClass: 'TRANSACTIONAL',
      to: who.to,
      leadId: who.leadId,
      lang: brand.lang,
      subject,
      body,
      source: `estimate:${est.id}`,
    });

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
        to: who.to,
        via,
      }),
      { actorId: actorId ?? null },
    );

    return { sent: true, to: who.to, via, publicUrl: link };
  }

  /**
   * The receipt for a payment that already happened (`no-payment-receipt`).
   *
   * It is called from a domain-event consumer, so NOTHING here throws: an
   * invoice with no contact, an address that bounced, an exhausted quota and a
   * dead transport are all normal outcomes on this path — the money moved
   * regardless, and a failed receipt must never look like a failed payment.
   *
   * The dedupe is the gateway's durable ledger key, not the consumer's
   * in-memory `seenEventIds` Set: that Set is empty after a restart, which is
   * exactly when the outbox reclaims stale rows and redelivers. A trace line
   * written twice is invisible; a receipt emailed twice is not.
   */
  async sendPaymentReceipt(
    workspaceId: string,
    invoiceId: string,
  ): Promise<{ sent: boolean; to?: string; deduped?: boolean; skipped?: string; reason?: string }> {
    try {
      const inv = await this.prisma.invoice.findFirst({
        where: { id: invoiceId, workspaceId },
        select: {
          id: true,
          publicToken: true,
          number: true,
          leadId: true,
          total: true,
          currency: true,
        },
      });
      if (!inv) return { sent: false, skipped: 'not-found' };
      if (!inv.leadId) return { sent: false, skipped: 'no-contact' };

      const brand = await this.brand(workspaceId);
      let who: Recipient;
      try {
        who = await this.reachableAddress(workspaceId, inv.leadId, 'invoice');
      } catch {
        return { sent: false, skipped: 'unreachable' };
      }

      const link = this.publicLink('i', inv.publicToken);
      const amount = formatMinorAmount(inv.total, inv.currency, brand.lang);
      const receipt = await this.outbound.send({
        workspaceId,
        mailClass: 'TRANSACTIONAL',
        to: who.to,
        leadId: who.leadId,
        lang: brand.lang ?? undefined,
        subject: t(brand.lang, 'document.receipt.subject', { number: inv.number }),
        source: `invoice:${inv.id}:receipt`,
        idempotencyKey: `invoice:${inv.id}:receipt`,
        ...this.render(brand.lang, [
          ...this.greeting(who),
          { key: 'document.receipt.body', vars: { amount, number: inv.number } },
          { raw: link, url: link },
          { key: 'document.signoff', vars: { business: brand.business } },
        ]),
      });

      if (receipt.outcome === 'DEDUPED') return { sent: false, deduped: true, to: who.to };
      if (!receipt.ok) {
        return { sent: false, ...(receipt.reason ? { reason: receipt.reason } : {}) };
      }
      return { sent: true, to: who.to };
    } catch (e: unknown) {
      this.logger.warn(
        `payment receipt skipped (workspace=${workspaceId}, invoice=${invoiceId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { sent: false, skipped: 'error' };
    }
  }

  /**
   * Email an agreement for signature (`esign-not-emailed`).
   *
   * The document must already be SENT: minting the public token is what SENT
   * MEANS, and it is `DocumentsService` that freezes the body and mints it. A
   * delivery failure here therefore leaves a SENT document with a live link
   * rather than rolling anything back — the user still has "Copy signing link".
   */
  async sendAgreement(workspaceId: string, documentId: string, actorId?: string | null) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, workspaceId },
      select: { id: true, title: true, status: true, publicToken: true, leadId: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status !== 'SENT' || !doc.publicToken) {
      throw new BadRequestException(
        doc.status === 'DRAFT'
          ? 'Send the document first — signing needs a signing link'
          : `A ${doc.status.toLowerCase()} document cannot be sent for signature`,
      );
    }

    const brand = await this.brand(workspaceId);
    const who = await this.reachableAddress(workspaceId, doc.leadId, 'agreement');
    const link = this.publicLink('d', doc.publicToken);
    const via = await this.deliver({
      workspaceId,
      mailClass: 'TRANSACTIONAL',
      to: who.to,
      leadId: who.leadId,
      lang: brand.lang,
      subject: t(brand.lang, 'document.esign.subject', { title: doc.title }),
      source: `document:${doc.id}`,
      body: this.render(brand.lang, [
        ...this.greeting(who),
        { key: 'document.esign.body', vars: { business: brand.business, title: doc.title } },
        { key: 'document.esign.signLine', vars: { url: link }, url: link },
        { key: 'document.signoff', vars: { business: brand.business } },
      ]),
    });

    void actorId; // the signature, not the send, is this document's audit trail
    return { sent: true, to: who.to, via, signUrl: link };
  }

  /**
   * Both parties' copy of a signed agreement.
   *
   * Called from the public signing endpoint after the signature is already a
   * legal fact, so it NEVER throws and never reports failure upward: a throw
   * there would tell a signer whose agreement is signed to "try again".
   *
   * The signer's copy is TRANSACTIONAL (their own business with the tenant);
   * the workspace's copy is INTERNAL — one of our own users, so no tenant
   * Reply-To, no metering and no gate the tenant's own list can apply.
   */
  async sendSignedCopy(workspaceId: string, documentId: string): Promise<void> {
    try {
      const doc = await this.prisma.document.findFirst({
        where: { id: documentId, workspaceId },
        select: {
          id: true,
          title: true,
          status: true,
          publicToken: true,
          leadId: true,
          signerEmail: true,
        },
      });
      if (!doc || doc.status !== 'SIGNED' || !doc.publicToken) return;

      const brand = await this.brand(workspaceId);
      const link = this.publicLink('d', doc.publicToken);
      const body = this.render(brand.lang, [
        { key: 'document.esign.signedBody', vars: { title: doc.title } },
        { raw: link, url: link },
      ]);

      // The signer typed their own address at sign time; when they did not, the
      // contact the agreement was sent to is the same person.
      const signerAddress =
        doc.signerEmail?.trim() ||
        (await this.contactAddress(workspaceId, doc.leadId)) ||
        null;
      if (signerAddress) {
        await this.sendQuietly({
          workspaceId,
          mailClass: 'TRANSACTIONAL',
          to: signerAddress,
          leadId: doc.leadId,
          lang: brand.lang ?? undefined,
          subject: t(brand.lang, 'document.esign.signedSubject', { title: doc.title }),
          source: `document:${doc.id}:signed`,
          idempotencyKey: `document:${doc.id}:signed`,
          ...body,
        });
      }

      const owner = await this.ownerAddress(workspaceId);
      if (owner) {
        await this.sendQuietly({
          workspaceId,
          mailClass: 'INTERNAL',
          to: owner,
          leadId: null,
          lang: brand.lang ?? undefined,
          subject: t(brand.lang, 'document.esign.signedSubject', { title: doc.title }),
          source: `document:${doc.id}:signed-owner`,
          idempotencyKey: `document:${doc.id}:signed-owner`,
          ...body,
        });
      }
    } catch (e: unknown) {
      this.logger.warn(
        `signed copy skipped (workspace=${workspaceId}, document=${documentId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── who it goes to ─────────────────────────────────────────────────────────

  /**
   * The address, or a refusal naming why this document cannot be emailed.
   *
   * Two readings of the same question, on purpose. The denormalised Lead flags
   * are today's refusal and keep their exact wording; `SuppressionService`
   * adds the ledger — an erasure tombstone, a bounce recorded against the
   * ADDRESS rather than this lead row — asked as TRANSACTIONAL, which per the
   * gate matrix ignores a marketing opt-out and honours bounce / invalid /
   * erasure. That is today's behaviour exactly, plus the rows today cannot see.
   */
  private async reachableAddress(
    workspaceId: string,
    leadId: string | null,
    kind: DocKind,
  ): Promise<Recipient> {
    if (!leadId) throw new BadRequestException(`This ${kind} has no contact to email`);
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: {
        id: true,
        email: true,
        contactPerson: true,
        emailBouncedAt: true,
        emailVerifiedStatus: true,
      },
    });
    const to = lead?.email?.trim();
    if (!to) throw new BadRequestException('Contact has no email address');
    if (lead?.emailBouncedAt) {
      throw new BadRequestException('This email address has hard-bounced and cannot be mailed');
    }
    if (lead?.emailVerifiedStatus === 'INVALID') {
      throw new BadRequestException('This email address is not deliverable');
    }

    const verdict = await this.suppression.check(workspaceId, to, 'TRANSACTIONAL', {
      proactive: true,
    });
    if (verdict.suppressed) {
      const brand = await this.brand(workspaceId);
      throw new BadRequestException(t(brand.lang, SUPPRESSION_COPY[verdict.reason ?? 'ERASURE']));
    }

    return { to, leadId: lead?.id ?? leadId, name: lead?.contactPerson?.trim() || null };
  }

  /** The contact address alone — no refusal, for the best-effort copies. */
  private async contactAddress(workspaceId: string, leadId: string | null): Promise<string | null> {
    if (!leadId) return null;
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { email: true },
    });
    return lead?.email?.trim() || null;
  }

  /**
   * The workspace OWNER's address, through the MEMBERSHIP — never
   * `MarketingUser.workspaceId`, which is the user's HOME workspace: an owner
   * whose home is elsewhere owns this one just as much.
   */
  private async ownerAddress(workspaceId: string): Promise<string | null> {
    const m = await this.prisma.workspaceMembership.findFirst({
      where: { workspaceId, role: 'OWNER', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { user: { select: { email: true } } },
    });
    return m?.user?.email?.trim() || null;
  }

  private publicLink(segment: LinkSegment, token: string | null): string {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    if (!base) {
      throw new BadRequestException(
        'PUBLIC_BASE_URL is not configured — the email would carry a dead link',
      );
    }
    return `${base}/api/public/${segment}/${token}`;
  }

  // ── what it says ───────────────────────────────────────────────────────────

  /** What this workspace is called to a customer, and in which language. */
  private async brand(workspaceId: string): Promise<Brand> {
    try {
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true, defaultLanguage: true, settings: true },
      });
      const settings = (ws?.settings ?? null) as Record<string, unknown> | null;
      const fromName = typeof settings?.emailFromName === 'string' ? settings.emailFromName.trim() : '';
      return {
        business: fromName || ws?.name?.trim() || '',
        lang: ws?.defaultLanguage ?? null,
      };
    } catch (e: unknown) {
      // Never fail a send over the display name: `mail-copy` falls back to
      // English and the gateway still knows who the mail is from.
      this.logger.warn(
        `workspace read failed (workspace=${workspaceId}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return { business: '', lang: null };
    }
  }

  /** "Merhaba Ayşe," — only when the contact row actually has a name. */
  private greeting(who: Recipient): Line[] {
    return who.name ? [{ key: 'document.greeting', vars: { name: who.name } }] : [];
  }

  private dateLine(key: MailCopyKey, lang: string | null, value: Date | null): Line[] {
    const date = formatDocumentDate(value, lang);
    return date ? [{ key, vars: { date } }] : [];
  }

  /**
   * One text part and one HTML part from the same lines, so the two can never
   * say different things. Every interpolated value is escaped in the HTML —
   * the business name, the contact name and the tenant's own note are all
   * tenant- or customer-authored.
   */
  private render(lang: string | null, lines: Line[]): { text: string; html: string } {
    const rendered = lines.map((line) => ({
      text: 'raw' in line ? line.raw : t(lang, line.key, line.vars),
      html: 'raw' in line ? escapeHtml(line.raw) : tHtml(lang, line.key, line.vars),
      url: line.url,
    }));
    return {
      text: rendered
        .map((l) => l.text)
        .filter((l) => !!l.trim())
        .join('\n\n'),
      html:
        '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">' +
        rendered
          .filter((l) => !!l.html.trim())
          .map((l) =>
            l.url ? `<p><a href="${escapeHtml(l.url)}">${l.html}</a></p>` : `<p>${l.html}</p>`,
          )
          .join('') +
        '</div>',
    };
  }

  // ── how it leaves ──────────────────────────────────────────────────────────

  /**
   * Hand the mail to the gateway and turn the receipt back into this service's
   * contract: a transport name, or a refusal a human can read.
   *
   * These call sites are buttons somebody just pressed, so a failure stays an
   * exception — that is what they have always answered with. What changes is
   * the message: the gateway's machine reason becomes words in the workspace's
   * language, with the provider's own sentence appended when there is one, and
   * the document's status is never flipped on a mail that did not leave.
   */
  private async deliver(input: {
    workspaceId: string;
    mailClass: MailClass;
    to: string;
    leadId: string | null;
    lang: string | null;
    subject: string;
    source: string;
    body: { text: string; html: string };
  }): Promise<Transport> {
    const receipt = await this.outbound.send({
      workspaceId: input.workspaceId,
      mailClass: input.mailClass,
      to: input.to,
      leadId: input.leadId,
      lang: input.lang ?? undefined,
      subject: input.subject,
      source: input.source,
      text: input.body.text,
      html: input.body.html,
    });
    if (!receipt.ok) throw new BadRequestException(this.refusalMessage(receipt, input.lang));
    return receipt.transport === 'PLATFORM' ? 'platform' : 'mailbox';
  }

  /** A best-effort copy: the gateway never throws, and neither does this. */
  private async sendQuietly(mail: Parameters<OutboundMailService['send']>[0]): Promise<void> {
    try {
      await this.outbound.send(mail);
    } catch (e: unknown) {
      this.logger.warn(
        `copy not sent (source=${mail.source}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** The machine code in words, plus the provider's own sentence. */
  private refusalMessage(receipt: MailReceipt, lang: string | null): string {
    const said = receipt.reason ? t(lang, mailReasonKey(receipt.reason)) : '';
    return [said, receipt.error].filter((p) => !!p).join(' — ') || 'Email send failed';
  }
}
