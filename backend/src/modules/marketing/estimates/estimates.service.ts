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
import { CreateEstimateDto, UpdateEstimateDto } from '../dto/estimate.dto';

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
  ) {}

  async list(workspaceId: string) {
    return this.prisma.estimate.findMany({
      where: { workspaceId },
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
    const invoice = await this.invoices.create(workspaceId, {
      leadId: estimate.leadId ?? undefined,
      items: estimate.items as unknown as PricedItem[],
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
    if (estimate.status !== 'ACCEPTED') {
      await this.prisma.estimate.update({
        where: { id: estimate.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), declinedAt: null },
      });
    }
    return { status: 'ACCEPTED' };
  }

  async publicDecline(token: string) {
    const estimate = await this.prisma.estimate.findUnique({ where: { publicToken: token } });
    if (!estimate) throw new NotFoundException('Estimate not found');
    if (estimate.status === 'ACCEPTED') {
      throw new ConflictException('This estimate was already accepted');
    }
    if (estimate.status !== 'DECLINED') {
      await this.prisma.estimate.update({
        where: { id: estimate.id },
        data: { status: 'DECLINED', declinedAt: new Date() },
      });
    }
    return { status: 'DECLINED' };
  }
}
