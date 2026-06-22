import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateTaxRateDto, UpdateTaxRateDto } from '../dto/tax-rate.dto';
import { PricedItem } from '../invoicing/money.util';

/**
 * Reusable tax rates (GoHighLevel parity). Workspace-scoped CRUD; at most one
 * `isDefault`. `resolveItemTaxes` is the seam invoices/estimates/order-forms
 * call before persisting — it RE-SNAPSHOTS each line's taxRatePct from the
 * workspace's TaxRate rows (a client-supplied pct is never trusted).
 */
@Injectable()
export class TaxRatesService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string, includeArchived = false) {
    return this.prisma.taxRate.findMany({
      where: { workspaceId, ...(includeArchived ? {} : { archived: false }) },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async create(workspaceId: string, dto: CreateTaxRateDto) {
    // clearDefault + create in ONE transaction so two concurrent "make default"
    // requests can't both pass the clear and leave two defaults behind.
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await this.clearDefault(workspaceId, tx);
      return tx.taxRate.create({
        data: { workspaceId, name: dto.name, rate: dto.rate, isDefault: dto.isDefault ?? false },
      });
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateTaxRateDto) {
    const existing = await this.prisma.taxRate.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Tax rate not found');
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await this.clearDefault(workspaceId, tx);
      return tx.taxRate.update({
        where: { id: existing.id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.rate !== undefined && { rate: dto.rate }),
          ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        },
      });
    });
  }

  async archive(workspaceId: string, id: string) {
    const existing = await this.prisma.taxRate.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Tax rate not found');
    return this.prisma.taxRate.update({
      where: { id: existing.id },
      data: { archived: true, isDefault: false },
    });
  }

  private clearDefault(workspaceId: string, tx: Prisma.TransactionClient = this.prisma) {
    return tx.taxRate.updateMany({
      where: { workspaceId, isDefault: true },
      data: { isDefault: false },
    });
  }

  /**
   * Snapshot each line's taxRatePct from the workspace's tax rates by taxRateId.
   * A line with no/unknown taxRateId gets pct 0. The returned items carry both
   * the id (for the editor) and the resolved pct (the money-math source of truth).
   */
  async resolveItemTaxes(workspaceId: string, items: PricedItem[] | undefined | null): Promise<PricedItem[]> {
    const list = Array.isArray(items) ? items : [];
    const ids = [...new Set(list.map((i) => i.taxRateId).filter((x): x is string => !!x))];
    const map = new Map<string, number>();
    if (ids.length > 0) {
      const rates = await this.prisma.taxRate.findMany({
        // archived: false — an archived rate must not apply to NEW writes (it
        // falls through to pct 0, like an unknown id). Historical documents keep
        // their already-snapshotted rate because they aren't re-resolved.
        where: { workspaceId, id: { in: ids }, archived: false },
        select: { id: true, rate: true },
      });
      for (const r of rates) map.set(r.id, Number(r.rate));
    }
    return list.map((i) => ({
      ...i,
      taxRateId: i.taxRateId ?? null,
      taxRatePct: i.taxRateId ? (map.get(i.taxRateId) ?? 0) : 0,
    }));
  }
}
