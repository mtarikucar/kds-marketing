import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { ProductsService } from '../products/products.service';
import { InvoicesService } from '../invoicing/invoices.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { normalizeEmail, normalizePhone } from '../utils/lead-normalize';
import {
  CreateOrderFormDto,
  UpdateOrderFormDto,
  PublicOrderSubmitDto,
} from '../dto/order-form.dto';

interface OrderItem {
  description: string;
  qty: number;
  unitPrice: number;
}

/**
 * Public payment-enabled Order Forms (GoHighLevel parity). A thin, SAFE
 * orchestrator over already-audited pieces: the manager authors a form (a
 * Product or fixed line items); a buyer submits name/email/phone on the public
 * page and the server (a) creates-or-dedupes a Lead using the SAME inline
 * pattern as FormsService.submit (dedup + tombstone + auto-assign + LeadCreated
 * event — never a raw unscoped create), (b) creates an Invoice via
 * InvoicesService for the SERVER-RESOLVED price, and (c) returns the existing
 * invoice pay URL. The buyer never supplies money — the amount is resolved from
 * the form's config (resolveLineItems), so it can't be tampered. The public POST
 * is rate-limited at the controller (PUBLIC_WRITE_THROTTLE).
 */
@Injectable()
export class OrderFormsService {
  private readonly logger = new Logger(OrderFormsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly products: ProductsService,
    private readonly invoices: InvoicesService,
  ) {}

  // ─── Manager CRUD (workspace-scoped) ────────────────────────────────────────

  list(workspaceId: string) {
    return this.prisma.orderForm.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        name: true,
        productId: true,
        currency: true,
        active: true,
        publicToken: true,
        createdAt: true,
      },
    });
  }

  async get(workspaceId: string, id: string) {
    const form = await this.prisma.orderForm.findFirst({ where: { id, workspaceId } });
    if (!form) throw new NotFoundException('Order form not found');
    return form;
  }

  /** Pricing source is productId XOR items; in product mode the product must
   *  exist (scoped) and be sellable. */
  private async validatePricing(
    workspaceId: string,
    src: { productId?: string | null; items?: OrderItem[] | null },
  ) {
    const hasProduct = !!src.productId;
    const hasItems = Array.isArray(src.items) && src.items.length > 0;
    if (hasProduct === hasItems) {
      throw new BadRequestException('Provide exactly one of productId or items');
    }
    if (hasProduct) {
      const product = await this.products.get(workspaceId, src.productId!);
      if (!product.active) throw new BadRequestException('Product is archived');
    }
  }

  async create(workspaceId: string, dto: CreateOrderFormDto) {
    await this.validatePricing(workspaceId, { productId: dto.productId, items: dto.items });
    return this.prisma.orderForm.create({
      data: {
        workspaceId,
        name: dto.name,
        productId: dto.productId ?? null,
        items: dto.items ? (dto.items as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        currency: (dto.currency ?? 'TRY').toUpperCase(),
        collectPhone: dto.collectPhone ?? true,
        phoneRequired: dto.phoneRequired ?? false,
        notes: dto.notes ?? null,
        active: dto.active ?? true,
        publicToken: `of_${randomBytes(18).toString('hex')}`,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateOrderFormDto) {
    const form = await this.get(workspaceId, id);
    if (dto.productId !== undefined || dto.items !== undefined) {
      await this.validatePricing(workspaceId, {
        productId: dto.productId ?? (dto.items !== undefined ? null : form.productId),
        items: dto.items ?? (dto.productId !== undefined ? null : (form.items as unknown as OrderItem[] | null)),
      });
    }
    const data: Prisma.OrderFormUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.productId !== undefined) {
      data.productId = dto.productId;
      data.items = Prisma.JsonNull;
    }
    if (dto.items !== undefined) {
      data.items = dto.items as unknown as Prisma.InputJsonValue;
      data.productId = null;
    }
    if (dto.currency !== undefined) data.currency = dto.currency.toUpperCase();
    if (dto.collectPhone !== undefined) data.collectPhone = dto.collectPhone;
    if (dto.phoneRequired !== undefined) data.phoneRequired = dto.phoneRequired;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.active !== undefined) data.active = dto.active;
    return this.prisma.orderForm.update({ where: { id }, data });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.orderForm.delete({ where: { id } });
    return { message: 'Order form deleted' };
  }

  // ─── Public (buyer) flow — gated by the unguessable publicToken ─────────────

  /** THE PRICE-BINDING CHOKE POINT — items derived solely from the manager's
   *  config + the live Product price. The buyer never supplies money. */
  private async resolveLineItems(form: {
    workspaceId: string;
    productId: string | null;
    items: unknown;
    currency: string;
  }): Promise<{ items: OrderItem[]; currency: string }> {
    if (form.productId) {
      const product = await this.products.get(form.workspaceId, form.productId);
      if (!product.active) throw new NotFoundException('Order form not found');
      const unitPrice = Math.max(0, Math.round(Number(product.price) * 100)); // major→minor
      return {
        items: [{ description: product.name, qty: 1, unitPrice }],
        currency: product.currency,
      };
    }
    const raw = Array.isArray(form.items) ? (form.items as OrderItem[]) : [];
    const items = raw.map((it) => ({
      description: String(it.description).slice(0, 300),
      qty: Math.max(0, Math.round(Number(it.qty) || 0)),
      unitPrice: Math.max(0, Math.round(Number(it.unitPrice) || 0)),
    }));
    return { items, currency: form.currency };
  }

  async publicView(token: string) {
    const form = await this.prisma.orderForm.findUnique({ where: { publicToken: token } });
    if (!form || !form.active) throw new NotFoundException('Order form not found');
    const { items, currency } = await this.resolveLineItems(form);
    const total = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
    return {
      name: form.name,
      notes: form.notes,
      currency,
      items,
      total,
      collectPhone: form.collectPhone,
      phoneRequired: form.phoneRequired,
    };
  }

  /** Buyer submit → lead create-or-dedupe → invoice → pay URL. */
  async submit(
    token: string,
    body: PublicOrderSubmitDto,
    audit: { ip?: string; userAgent?: string },
  ): Promise<{ redirectUrl: string }> {
    const form = await this.prisma.orderForm.findUnique({ where: { publicToken: token } });
    if (!form || !form.active) throw new NotFoundException('Order form not found');
    const workspaceId = form.workspaceId;

    const { items, currency } = await this.resolveLineItems(form);
    if (items.length === 0 || items.every((it) => it.qty * it.unitPrice === 0)) {
      throw new BadRequestException('This order form has no payable items');
    }

    const name = (body.fullName || '').trim();
    const email = (body.email || '').trim() || null;
    const phone = (body.phone || '').trim() || null;
    if (form.phoneRequired && !phone) throw new BadRequestException('Phone is required');
    const emailNormalized = normalizeEmail(email);
    const phoneNormalized = normalizePhone(phone);
    const businessName = name || 'Order form lead';

    // (a) create-or-dedupe the LEAD — same inline pattern as FormsService.submit
    // (dedup excludes tombstoned leads; new lead emits LeadCreated; auto-assign).
    const leadId = await this.prisma.$transaction(async (tx) => {
      let existing: { id: string; status: string } | null = null;
      if (emailNormalized || phoneNormalized) {
        existing = await tx.lead.findFirst({
          where: {
            workspaceId,
            mergedIntoId: null,
            OR: [
              ...(emailNormalized ? [{ emailNormalized }] : []),
              ...(phoneNormalized ? [{ phoneNormalized }] : []),
            ],
          },
          select: { id: true, status: true },
        });
      }
      if (existing) return existing.id;

      const autoOwner = await this.autoAssigner.pickAssignee(workspaceId, tx);
      const lead = await tx.lead.create({
        data: {
          workspaceId,
          businessName,
          contactPerson: name || businessName,
          businessType: 'OTHER',
          source: 'WEBSITE',
          status: 'NEW',
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(emailNormalized ? { emailNormalized } : {}),
          ...(phoneNormalized ? { phoneNormalized } : {}),
          ...(autoOwner ? { assignedToId: autoOwner } : {}),
        },
      });
      await this.outbox.append(
        {
          type: MarketingEventTypes.LeadCreated,
          idempotencyKey: `lead-created:${lead.id}`,
          payload: {
            workspaceId,
            leadId: lead.id,
            source: 'WEBSITE',
            occurredAt: new Date().toISOString(),
          },
        },
        tx as any,
      );
      return lead.id;
    });

    // (b) create the INVOICE (server-resolved amount) + flip to SENT for a pay URL.
    // Idempotency: collapse a refresh / double-tab / retry into ONE invoice by
    // reusing a recent still-open invoice for this (lead, form) instead of minting
    // a duplicate. A genuine repeat purchase later (outside the window) makes a
    // fresh one. (The lead itself is already deduped above.)
    const orderNote = `Order: ${form.name}`;
    const recent = await this.prisma.invoice.findFirst({
      where: {
        workspaceId,
        leadId,
        notes: orderNote,
        status: { in: ['DRAFT', 'SENT'] },
        createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const invoiceId =
      recent?.id ??
      ((await this.invoices.create(workspaceId, {
        leadId,
        items,
        currency,
        notes: orderNote,
      })) as { id: string }).id;
    const { payUrl } = await this.invoices.send(workspaceId, invoiceId);

    void this.outbox
      .append({
        type: MarketingEventTypes.FormSubmitted,
        idempotencyKey: `order-form-submitted:${form.id}:${invoiceId}`,
        payload: {
          workspaceId,
          leadId,
          orderFormId: form.id,
          invoiceId,
          ip: audit.ip ?? null,
          occurredAt: new Date().toISOString(),
        },
      })
      .catch((e) =>
        this.logger.warn(`order-form FormSubmitted append failed: ${(e as Error).message}`),
      );

    // (c) buyer is redirected to the existing /api/public/i/:token pay page.
    return { redirectUrl: payUrl };
  }
}
