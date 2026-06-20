import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { InvoicesService } from '../invoicing/invoices.service';
import { CreateEstimateDto, UpdateEstimateDto } from '../dto/estimate.dto';

interface EstimateItem {
  description: string;
  qty: number;
  unitPrice: number;
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
  ) {}

  private computeTotal(items: EstimateItem[]): number {
    return (items ?? []).reduce(
      (sum, it) =>
        sum +
        Math.max(0, Math.round(Number(it.qty) || 0)) *
          Math.max(0, Math.round(Number(it.unitPrice) || 0)),
      0,
    );
  }

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
    const items = Array.isArray(dto.items) ? dto.items : [];
    return this.prisma.estimate.create({
      data: {
        workspaceId,
        leadId: dto.leadId ?? null,
        number: `EST-${randomBytes(4).toString('hex').toUpperCase()}`,
        items: items as unknown as Prisma.InputJsonValue,
        currency: dto.currency ?? 'TRY',
        total: this.computeTotal(items),
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
      data.items = dto.items as unknown as Prisma.InputJsonValue;
      data.total = this.computeTotal(dto.items);
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
      items: estimate.items as unknown as EstimateItem[],
      currency: estimate.currency,
      notes: estimate.notes ?? undefined,
    });
    // Mark converted + accepted (a SENT estimate is implicitly accepted on convert).
    await this.prisma.estimate.updateMany({
      where: { id, workspaceId },
      data: {
        convertedInvoiceId: (invoice as { id: string }).id,
        status: 'ACCEPTED',
        acceptedAt: estimate.acceptedAt ?? new Date(),
      },
    });
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
        total: true,
        notes: true,
        status: true,
        validUntil: true,
      },
    });
    if (!estimate) throw new NotFoundException('Estimate not found');
    return estimate;
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
