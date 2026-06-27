import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { paginated } from '../../../common/pagination';
import {
  CreateProductDto,
  UpdateProductDto,
  ProductFilterDto,
} from '../dto/product.dto';

/**
 * Products catalog (GoHighLevel parity) — reusable priced items a workspace
 * sells. Foundation for invoices / estimates / order-forms (later epics) and
 * opportunity line items. Every row is workspace-owned: `workspaceId` is inlined
 * into every multi-row/create query; id-keyed update/delete go through a scoped
 * read first. Default-archive (active=false) is offered alongside hard delete so
 * a product referenced by historical documents can be retired without breaking
 * those references.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Keep billing coherent: a RECURRING product always carries an interval
   * (defaulting to MONTH when unspecified); a ONE_TIME product never does.
   */
  private normalizeBilling(billingType?: string, interval?: string) {
    const bt = billingType ?? 'ONE_TIME';
    return { billingType: bt, interval: bt === 'RECURRING' ? (interval ?? 'MONTH') : null };
  }

  async list(workspaceId: string, filter: ProductFilterDto) {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 50;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where: {
          workspaceId,
          ...(filter.active !== undefined ? { active: filter.active } : {}),
          ...(filter.billingType ? { billingType: filter.billingType } : {}),
          ...(filter.search
            ? { name: { contains: filter.search, mode: 'insensitive' as const } }
            : {}),
        },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({
        where: {
          workspaceId,
          ...(filter.active !== undefined ? { active: filter.active } : {}),
          ...(filter.billingType ? { billingType: filter.billingType } : {}),
          ...(filter.search
            ? { name: { contains: filter.search, mode: 'insensitive' as const } }
            : {}),
        },
      }),
    ]);
    return paginated(data, total, page, limit);
  }

  async get(workspaceId: string, id: string) {
    const product = await this.prisma.product.findFirst({ where: { id, workspaceId } });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async create(workspaceId: string, dto: CreateProductDto) {
    const billing = this.normalizeBilling(dto.billingType, dto.interval);
    return this.prisma.product.create({
      data: {
        workspaceId,
        name: dto.name,
        description: dto.description ?? null,
        sku: dto.sku ?? null,
        price: dto.price ?? 0,
        currency: dto.currency ?? 'TRY',
        billingType: billing.billingType,
        interval: billing.interval,
        taxRate: dto.taxRate ?? null,
        active: dto.active ?? true,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateProductDto) {
    const existing = await this.get(workspaceId, id);
    // Resolve the effective billing shape from the merge of existing + patch so
    // an interval is required/cleared consistently.
    const billing =
      dto.billingType !== undefined || dto.interval !== undefined
        ? this.normalizeBilling(
            dto.billingType ?? existing.billingType,
            dto.interval ?? existing.interval ?? undefined,
          )
        : null;

    return this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        sku: dto.sku,
        price: dto.price,
        currency: dto.currency,
        taxRate: dto.taxRate,
        active: dto.active,
        ...(billing ? { billingType: billing.billingType, interval: billing.interval } : {}),
      },
    });
  }

  /** Soft retire — keeps the row so historical line items still resolve. */
  async archive(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    return this.prisma.product.update({ where: { id }, data: { active: false } });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    // OrderForm.productId is a soft ref the PUBLIC checkout resolves live at
    // submit. Hard-deleting a referenced product leaves a dangling ref that 404s
    // the buyer-facing order form — irreversibly. Refuse and steer to archive
    // (active=false keeps the row, so the ref still resolves and is reversible).
    const usedByForms = await this.prisma.orderForm.count({
      where: { workspaceId, productId: id },
    });
    if (usedByForms > 0) {
      throw new ConflictException(
        'Product is used by an order form — archive it, or remove it from the order form first',
      );
    }
    await this.prisma.product.delete({ where: { id } });
    return { message: 'Product deleted' };
  }
}
