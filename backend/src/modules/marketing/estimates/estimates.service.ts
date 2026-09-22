import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { InvoicesService } from '../invoicing/invoices.service';
import { TaxRatesService } from '../tax-rates/tax-rates.service';
import { computeMoneyTotals, PricedItem, PG_INT_MAX } from '../invoicing/money.util';
import { isQuoteExpired } from '../invoicing/priced-document.util';
import { CommerceTraceService } from '../invoicing/commerce-trace.service';
import { commerceActivity } from '../invoicing/commerce-activity';
import { notifyCommerce } from '../invoicing/commerce-notify';
import { CreateEstimateDto, UpdateEstimateDto } from '../dto/estimate.dto';

/** The public answer, and the shape the trace + the bell are built from. */
type Answer = 'ACCEPTED' | 'DECLINED';

/** The estimate columns the answer path reads back. */
interface AnsweredEstimate {
  id: string;
  workspaceId: string;
  leadId: string | null;
  number: string;
  total: number;
  currency: string;
}

/**
 * Estimates / quotes (GoHighLevel parity). A priced document of line items that
 * a customer accepts or declines; an accepted (or sent) estimate converts to an
 * Invoice via InvoicesService, recording convertedInvoiceId so it can't be
 * double-billed. Mirrors the Invoice shape (items JSON, total in minor units,
 * publicToken). Every multi-row/create query inlines `workspaceId`; id-keyed
 * update/delete go through a scoped read first.
 */
@Injectable()
export class EstimatesService {
  private readonly logger = new Logger(EstimatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly taxRates: TaxRatesService,
    private readonly trace: CommerceTraceService,
  ) {}

  /**
   * The workspace's estimates, newest first — optionally narrowed to ONE
   * person. The `leadId` predicate exists for the record card, which shows a
   * single contact's quotes: without it the card would fetch every estimate in
   * the workspace and sift them in the browser, an unbounded read that grows
   * with the workspace and returns nothing for most people. It NARROWS the
   * workspace scope, never replaces it — both predicates are in the same
   * `where`, so a leadId from another tenant still matches nothing.
   */
  async list(workspaceId: string, leadId?: string) {
    return this.prisma.estimate.findMany({
      where: { workspaceId, ...(leadId ? { leadId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        total: true,
        currency: true,
        status: true,
        validUntil: true,
        leadId: true,
        convertedInvoiceId: true,
        createdAt: true,
      },
    });
  }

  async get(workspaceId: string, id: string) {
    const estimate = await this.prisma.estimate.findFirst({ where: { id, workspaceId } });
    if (!estimate) throw new NotFoundException('Estimate not found');
    return estimate;
  }

  async create(workspaceId: string, dto: CreateEstimateDto) {
    const items = await this.taxRates.resolveItemTaxes(
      workspaceId,
      (Array.isArray(dto.items) ? dto.items : []) as PricedItem[],
    );
    const totals = computeMoneyTotals(items);
    if (totals.total > PG_INT_MAX) throw new BadRequestException('Amount exceeds the maximum supported total');
    return this.prisma.estimate.create({
      data: {
        workspaceId,
        leadId: dto.leadId ?? null,
        number: `EST-${randomBytes(4).toString('hex').toUpperCase()}`,
        items: items as unknown as Prisma.InputJsonValue,
        currency: dto.currency ?? 'TRY',
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        notes: dto.notes ?? null,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
        publicToken: `es_${randomBytes(18).toString('hex')}`,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateEstimateDto) {
    const estimate = await this.get(workspaceId, id);
    // Once it leaves DRAFT the figures are committed (it may already be in the
    // customer's hands), so edits are refused — clone or re-issue instead.
    if (estimate.status !== 'DRAFT') {
      throw new ConflictException('Only a draft estimate can be edited');
    }
    const data: Prisma.EstimateUpdateInput = {};
    if (dto.items !== undefined) {
      const items = await this.taxRates.resolveItemTaxes(workspaceId, dto.items as PricedItem[]);
      const totals = computeMoneyTotals(items);
    if (totals.total > PG_INT_MAX) throw new BadRequestException('Amount exceeds the maximum supported total');
      data.items = items as unknown as Prisma.InputJsonValue;
      data.subtotal = totals.subtotal;
      data.taxTotal = totals.taxTotal;
      data.total = totals.total;
    }
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.leadId !== undefined) data.leadId = dto.leadId;
    if (dto.validUntil !== undefined) {
      data.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    }
    return this.prisma.estimate.update({ where: { id }, data });
  }

  async send(workspaceId: string, id: string) {
    const estimate = await this.get(workspaceId, id);
    if (estimate.status === 'ACCEPTED' || estimate.status === 'DECLINED') {
      throw new ConflictException('Estimate already resolved');
    }
    await this.prisma.estimate.updateMany({
      where: { id, workspaceId },
      data: { status: 'SENT' },
    });
    return { status: 'SENT', publicToken: estimate.publicToken };
  }

  async accept(workspaceId: string, id: string) {
    const estimate = await this.get(workspaceId, id);
    if (estimate.status === 'ACCEPTED') return estimate;
    if (estimate.status === 'DECLINED') {
      throw new ConflictException('Estimate was declined');
    }
    return this.prisma.estimate.update({
      where: { id },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), declinedAt: null },
    });
  }

  async decline(workspaceId: string, id: string) {
    const estimate = await this.get(workspaceId, id);
    if (estimate.status === 'ACCEPTED') {
      throw new ConflictException('Estimate already accepted');
    }
    return this.prisma.estimate.update({
      where: { id },
      data: { status: 'DECLINED', declinedAt: new Date() },
    });
  }

  /** Convert a sent/accepted estimate into an invoice (exactly once). */
  async convertToInvoice(workspaceId: string, id: string) {
    const estimate = await this.get(workspaceId, id);
    if (estimate.convertedInvoiceId) {
      throw new ConflictException('Estimate already converted to an invoice');
    }
    if (estimate.status !== 'ACCEPTED' && estimate.status !== 'SENT') {
      throw new ConflictException('Only a sent or accepted estimate can be converted');
    }
    // A still-SENT (unaccepted) estimate past its validUntil is an expired quote
    // — converting it would bill the now-stale price. An ACCEPTED estimate was
    // accepted while valid (publicAccept enforces expiry), so it stays convertible.
    // ONE shared predicate with the accept and the send, so the three can never
    // disagree about which day a quote dies on.
    if (estimate.status === 'SENT' && isQuoteExpired(estimate.validUntil)) {
      throw new ConflictException('This estimate has expired');
    }
    const invoice = await this.invoices.create(workspaceId, {
      leadId: estimate.leadId ?? undefined,
      // Trust the estimate's ALREADY-SNAPSHOTTED per-line taxRatePct — the
      // customer accepted this total. Without this, invoices.create re-resolves
      // tax from the CURRENT rates, so an archived/edited rate would bill a
      // DIFFERENT amount than the accepted quote (and estimate.total would
      // permanently disagree with the linked invoice.total).
      items: estimate.items as unknown as PricedItem[],
      preResolvedItems: true,
      currency: estimate.currency,
      notes: estimate.notes ?? undefined,
    });
    // Mark converted + accepted via an ATOMIC conditional claim (convertedInvoiceId
    // still null). The pre-check above is just a fast path — two concurrent converts
    // (double-click / retry) both pass it, so without this guard each would mint a
    // separate invoice and the second would silently orphan the first. The loser
    // here voids the invoice it just minted and reports the conflict.
    const claimed = await this.prisma.estimate.updateMany({
      where: { id, workspaceId, convertedInvoiceId: null, status: { in: ['ACCEPTED', 'SENT'] } },
      data: {
        convertedInvoiceId: (invoice as { id: string }).id,
        status: 'ACCEPTED',
        acceptedAt: estimate.acceptedAt ?? new Date(),
      },
    });
    if (claimed.count === 0) {
      await this.invoices.voidInvoice(workspaceId, (invoice as { id: string }).id).catch(() => undefined);
      throw new ConflictException('Estimate already converted to an invoice');
    }
    return invoice;
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.estimate.delete({ where: { id } });
    return { message: 'Estimate deleted' };
  }

  // ─── Public (customer) flow — gated by the unguessable publicToken ──────────
  // No workspace context: the token IS the capability. findUnique on the @unique
  // publicToken (and the id-keyed update) are the sanctioned token-scoped reads,
  // mirroring the public invoice pay page.

  async publicView(token: string) {
    const estimate = await this.prisma.estimate.findUnique({
      where: { publicToken: token },
      select: {
        number: true,
        items: true,
        currency: true,
        subtotal: true,
        taxTotal: true,
        total: true,
        notes: true,
        status: true,
        validUntil: true,
      },
    });
    if (!estimate) throw new NotFoundException('Estimate not found');
    // Legacy estimates predate the breakdown columns (both 0) — show subtotal=total.
    const subtotal = estimate.subtotal || estimate.total;
    return {
      ...estimate,
      subtotal,
      taxLines: computeMoneyTotals(estimate.items as unknown as PricedItem[]).taxLines,
    };
  }

  async publicAccept(token: string) {
    const estimate = await this.prisma.estimate.findUnique({ where: { publicToken: token } });
    if (!estimate) throw new NotFoundException('Estimate not found');
    if (estimate.status === 'DECLINED') {
      throw new ConflictException('This estimate was already declined');
    }
    if (estimate.status === 'ACCEPTED') return { status: 'ACCEPTED' }; // idempotent re-accept
    // The public page renders "Valid until <date>" — enforce it: a customer must
    // not be able to accept (and lock in) a quote past its stated expiry, at the
    // now-stale price. (Sibling LeadOffers enforces the same on accept.) The
    // predicate is shared with the send and the conversion.
    if (isQuoteExpired(estimate.validUntil)) {
      throw new ConflictException('This estimate has expired');
    }
    return this.claimAnswer(token, estimate, 'ACCEPTED');
  }

  async publicDecline(token: string) {
    const estimate = await this.prisma.estimate.findUnique({ where: { publicToken: token } });
    if (!estimate) throw new NotFoundException('Estimate not found');
    if (estimate.status === 'ACCEPTED') {
      throw new ConflictException('This estimate was already accepted');
    }
    if (estimate.status === 'DECLINED') return { status: 'DECLINED' }; // idempotent re-decline
    return this.claimAnswer(token, estimate, 'DECLINED');
  }

  /**
   * The customer's answer, claimed exactly once.
   *
   * A STATUS-CONDITIONAL claim, not the read-then-update it replaces: the
   * public endpoint allows 20 POSTs a minute per IP and the old guard was
   * evaluated off a stale read, so two concurrent accepts both passed it and
   * each would write its own activity row. Only the winner records anything,
   * which is what makes "the customer answered" a single event on the person.
   * The loser is told the status that actually won, never a false 404.
   */
  private async claimAnswer(token: string, estimate: AnsweredEstimate, answer: Answer) {
    const claim = await this.prisma.estimate.updateMany({
      where: { id: estimate.id, workspaceId: estimate.workspaceId, status: { in: ['DRAFT', 'SENT'] } },
      data:
        answer === 'ACCEPTED'
          ? { status: 'ACCEPTED', acceptedAt: new Date(), declinedAt: null }
          : { status: 'DECLINED', declinedAt: new Date() },
    });
    if (claim.count === 0) {
      const fresh = await this.prisma.estimate.findUnique({
        where: { publicToken: token },
        select: { status: true },
      });
      if (!fresh) throw new NotFoundException('Estimate not found');
      if (fresh.status === 'DECLINED' && answer === 'ACCEPTED') {
        throw new ConflictException('This estimate was already declined');
      }
      if (fresh.status === 'ACCEPTED' && answer === 'DECLINED') {
        throw new ConflictException('This estimate was already accepted');
      }
      return { status: fresh.status };
    }

    await this.recordAnswer(estimate, answer);
    return { status: answer };
  }

  /**
   * `quote-answer-silent`: the answer went nowhere. An acceptance left no line
   * on the person and told nobody, so the deal stalled while the customer
   * waited.
   *
   * Best-effort on purpose — the answer is already committed, and a missing
   * timeline row must never become "Could not record your answer" on a public
   * page. No actor is passed: the CUSTOMER answered, so the row belongs to the
   * workspace SYSTEM sentinel rather than to whichever colleague was nearby.
   */
  private async recordAnswer(estimate: AnsweredEstimate, answer: Answer): Promise<void> {
    try {
      await this.trace.record(
        estimate.workspaceId,
        estimate.leadId,
        commerceActivity({
          event: 'quote_answered',
          docId: estimate.id,
          number: estimate.number,
          totalMinor: estimate.total,
          currency: estimate.currency,
          answer,
        }),
      );
    } catch (e: unknown) {
      this.logger.warn(
        `quote answer trace skipped (estimate=${estimate.id}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    await notifyCommerce(
      this.prisma,
      {
        workspaceId: estimate.workspaceId,
        leadId: estimate.leadId,
        type: 'QUOTE_ANSWERED',
        title: `Quote ${estimate.number} ${answer === 'ACCEPTED' ? 'accepted' : 'declined'}`,
        message: `The customer ${answer === 'ACCEPTED' ? 'accepted' : 'declined'} quote ${estimate.number}.`,
        metadata: { docId: estimate.id, number: estimate.number, answer },
      },
      this.logger,
    );
  }
}
