import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCouponDto, UpdateCouponDto } from '../dto/coupon.dto';

export interface CouponApplication {
  couponId: string;
  code: string;
  amountOff: number; // minor units, already clamped to ≤ subtotal
}

/**
 * Discount coupons (GoHighLevel parity). The discount amount is ALWAYS resolved
 * server-side from the stored coupon (a client never supplies an amount).
 * `validate` is a side-effect-free preview; `redeem` additionally consumes one
 * redemption atomically (a conditional updateMany guards maxRedemptions against
 * a race) and logs a CouponRedemption. Workspace-scoped throughout.
 */
@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.coupon.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  async create(workspaceId: string, dto: CreateCouponDto) {
    const currency = dto.currency?.toUpperCase() ?? null;
    this.assertShape(dto.kind, dto.value, currency);
    try {
      return await this.prisma.coupon.create({
        data: {
          workspaceId,
          // Stored uppercased so the case-SENSITIVE @unique(workspaceId, code)
          // index and the (now exact, uppercased) lookups can't disagree.
          code: this.norm(dto.code),
          kind: dto.kind,
          value: dto.value,
          currency,
          minSubtotal: dto.minSubtotal ?? null,
          maxRedemptions: dto.maxRedemptions ?? null,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          active: dto.active ?? true,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Coupon code "${dto.code}" already exists`);
      }
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: UpdateCouponDto) {
    const existing = await this.prisma.coupon.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Coupon not found');
    const kind = dto.kind ?? existing.kind;
    const value = dto.value ?? existing.value;
    const currency = dto.currency !== undefined ? (dto.currency?.toUpperCase() ?? null) : existing.currency;
    this.assertShape(kind, value, currency);
    return this.prisma.coupon.update({
      where: { id: existing.id },
      data: {
        ...(dto.kind !== undefined && { kind: dto.kind }),
        ...(dto.value !== undefined && { value: dto.value }),
        ...(dto.currency !== undefined && { currency: dto.currency ? dto.currency.toUpperCase() : null }),
        ...(dto.minSubtotal !== undefined && { minSubtotal: dto.minSubtotal }),
        ...(dto.maxRedemptions !== undefined && { maxRedemptions: dto.maxRedemptions }),
        ...(dto.startsAt !== undefined && { startsAt: dto.startsAt ? new Date(dto.startsAt) : null }),
        ...(dto.expiresAt !== undefined && { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.prisma.coupon.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Coupon not found');
    await this.prisma.coupon.delete({ where: { id: existing.id } }); // cascades redemptions
    return { message: 'Coupon deleted' };
  }

  /** Side-effect-free: resolve the discount for (code, subtotal) or throw. */
  async validate(
    workspaceId: string,
    code: string,
    subtotal: number,
    currency: string,
  ): Promise<CouponApplication> {
    const coupon = await this.prisma.coupon.findFirst({
      where: { workspaceId, code: this.norm(code) },
    });
    return this.resolve(coupon, subtotal, currency);
  }

  /**
   * Validate + consume one redemption atomically, then log it. The conditional
   * updateMany (timesRedeemed < maxRedemptions) makes the limit race-safe.
   */
  async redeem(
    workspaceId: string,
    code: string,
    subtotal: number,
    currency: string,
    ctx: { invoiceId?: string; orderFormId?: string; leadId?: string } = {},
  ): Promise<CouponApplication> {
    const coupon = await this.prisma.coupon.findFirst({
      where: { workspaceId, code: this.norm(code) },
    });
    const app = this.resolve(coupon, subtotal, currency); // throws if invalid
    return this.prisma.$transaction(async (tx) => {
      if (coupon!.maxRedemptions != null) {
        const res = await tx.coupon.updateMany({
          where: { id: coupon!.id, workspaceId, timesRedeemed: { lt: coupon!.maxRedemptions } },
          data: { timesRedeemed: { increment: 1 } },
        });
        if (res.count === 0) throw new BadRequestException('Coupon redemption limit reached');
      } else {
        await tx.coupon.update({ where: { id: coupon!.id }, data: { timesRedeemed: { increment: 1 } } });
      }
      await tx.couponRedemption.create({
        data: {
          workspaceId,
          couponId: coupon!.id,
          invoiceId: ctx.invoiceId ?? null,
          orderFormId: ctx.orderFormId ?? null,
          leadId: ctx.leadId ?? null,
          amountOff: app.amountOff,
        },
      });
      return app;
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private assertShape(kind: string, value: number, currency?: string | null) {
    if (kind === 'PERCENT' && (value < 1 || value > 100)) {
      throw new BadRequestException('A PERCENT coupon value must be 1–100');
    }
    // FIXED is a currency-denominated amount — it MUST carry a currency, else the
    // same value would discount a TRY / USD / EUR order indiscriminately.
    if (kind === 'FIXED' && !currency) {
      throw new BadRequestException('A FIXED coupon requires a currency');
    }
  }

  /** Canonical code form (the lookup + the @unique index agree on uppercase). */
  private norm(code: string): string {
    return (code || '').trim().toUpperCase();
  }

  /** Validate a coupon against a subtotal and compute the clamped amountOff. */
  private resolve(
    coupon: { id: string; code: string; kind: string; value: number; currency: string | null; minSubtotal: number | null; maxRedemptions: number | null; timesRedeemed: number; startsAt: Date | null; expiresAt: Date | null; active: boolean } | null,
    subtotal: number,
    currency: string,
  ): CouponApplication {
    if (!coupon || !coupon.active) throw new BadRequestException('Invalid coupon code');
    const now = Date.now();
    if (coupon.startsAt && coupon.startsAt.getTime() > now) throw new BadRequestException('Coupon is not active yet');
    if (coupon.expiresAt && coupon.expiresAt.getTime() < now) throw new BadRequestException('Coupon has expired');
    if (coupon.maxRedemptions != null && coupon.timesRedeemed >= coupon.maxRedemptions) {
      throw new BadRequestException('Coupon redemption limit reached');
    }
    if (coupon.minSubtotal != null && subtotal < coupon.minSubtotal) {
      throw new BadRequestException('Order subtotal is below the coupon minimum');
    }
    // A FIXED coupon applies ONLY to its own currency (and must have one).
    if (coupon.kind === 'FIXED' && (!coupon.currency || coupon.currency !== currency.toUpperCase())) {
      throw new BadRequestException('Coupon currency does not match the order');
    }
    const raw =
      coupon.kind === 'PERCENT' ? Math.round((subtotal * coupon.value) / 100) : coupon.value;
    const amountOff = Math.max(0, Math.min(raw, subtotal)); // never discount below 0
    return { couponId: coupon.id, code: coupon.code, amountOff };
  }
}
