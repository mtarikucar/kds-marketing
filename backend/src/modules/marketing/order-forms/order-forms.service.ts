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
import { CouponsService } from '../coupons/coupons.service';
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
    private readonly coupons: CouponsService,
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
      // Validate the EFFECTIVE post-write pricing source — mirror the write
      // branches below (which honour an explicit null clear) instead of a
      // `dto.x ?? form.x` fallback. With the old fallback, `{ productId: null }`
      // validated against the STALE product and PASSED, yet the write cleared
      // BOTH sources — saving a form with NEITHER (resolveLineItems → [], a dud
      // that shows total 0 and 400s at submit). Compute what will actually persist.
      let effProductId: string | null = form.productId;
      let effItems: OrderItem[] | null = form.items as unknown as OrderItem[] | null;
      if (dto.productId !== undefined) {
        effProductId = dto.productId ?? null;
        effItems = null;
      }
      if (dto.items !== undefined) {
        effItems = (dto.items as unknown as OrderItem[]) ?? null;
        effProductId = null;
      }
      await this.validatePricing(workspaceId, { productId: effProductId, items: effItems });
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
      // Scale major→minor on the Decimal directly (not via a binary float) so a
      // price like 19.99 can't mis-round by a minor unit.
      const unitPrice = Math.max(
        0,
        new Prisma.Decimal(product.price).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
      );
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
  /** Public: preview a coupon's discount against the form's resolved subtotal. */
  async previewCoupon(token: string, code: string) {
    const form = await this.prisma.orderForm.findUnique({ where: { publicToken: token } });
    if (!form || !form.active) throw new NotFoundException('Order form not found');
    const { items, currency } = await this.resolveLineItems(form);
    const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
    const app = await this.coupons.validate(form.workspaceId, (code || '').trim(), subtotal, currency);
    return { code: app.code, amountOff: app.amountOff, total: Math.max(0, subtotal - app.amountOff), currency };
  }

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

    // Validate any coupon UP FRONT (side-effect-free) so an invalid code fails
    // cleanly before a lead/invoice is created. It is actually CONSUMED only on
    // the new-invoice path below (never on the idempotent reuse path).
    const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
    const couponCode = (body.couponCode || '').trim();
    if (couponCode) {
      await this.coupons.validate(workspaceId, couponCode, subtotal, currency);
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
            // Also skip soft-deleted (bulk-deleted) leads: a paying order from a
            // previously-deleted buyer must surface as a fresh, visible lead, not
            // attach (with its invoice) to a hidden record. Matches forms/booking.
            deletedAt: null,
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
        // When the buyer supplies a coupon, only reuse an ALREADY-discounted
        // invoice — otherwise a coupon-on-retry would silently reuse the earlier
        // full-price invoice and drop the discount. A fresh discounted invoice is
        // minted instead (and the coupon is consumed once, on that mint).
        ...(couponCode ? { discount: { gt: 0 } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    let invoiceId: string;
    if (recent?.id) {
      invoiceId = recent.id; // reuse — do NOT consume another coupon redemption
    } else {
      // Consume the coupon (atomic) only when actually minting an invoice. A
      // raced exhaustion between validate and redeem degrades to no discount.
      let discount = 0;
      if (couponCode) {
        const app = await this.coupons
          .redeem(workspaceId, couponCode, subtotal, currency, { leadId, orderFormId: form.id })
          .catch(() => null);
        if (app) discount = app.amountOff;
      }
      invoiceId = (
        (await this.invoices.create(workspaceId, {
          leadId,
          items,
          currency,
          discount,
          notes: orderNote,
        })) as { id: string }
      ).id;
    }
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
