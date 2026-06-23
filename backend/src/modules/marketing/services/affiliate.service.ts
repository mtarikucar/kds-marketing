import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AFFILIATE_TOKEN_PREFIX, hashAffiliateToken } from '../guards/affiliate-portal.guard';

// ─── DTOs (inline — no separate file needed for a single-file service) ────────

export class CreateAffiliateDto {
  name: string;
  email: string;
  code: string;
  commissionType: 'PERCENT' | 'FLAT';
  commissionValue: number;
}

export class UpdateAffiliateDto {
  name?: string;
  email?: string;
  code?: string;
  commissionType?: 'PERCENT' | 'FLAT';
  commissionValue?: number;
  status?: 'ACTIVE' | 'PAUSED' | 'DISABLED';
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class AffiliateService {
  constructor(private prisma: PrismaService) {}

  // ── Affiliates ─────────────────────────────────────────────────────────────

  async createAffiliate(workspaceId: string, dto: CreateAffiliateDto) {
    // 409 on code collision within the workspace.
    const existing = await this.prisma.affiliate.findFirst({
      where: { workspaceId, code: dto.code },
    });
    if (existing) {
      throw new ConflictException(
        `Affiliate code "${dto.code}" already exists in this workspace`,
      );
    }

    return this.prisma.affiliate.create({
      data: {
        workspaceId,
        name: dto.name,
        email: dto.email,
        code: dto.code,
        commissionType: dto.commissionType,
        commissionValue: new Prisma.Decimal(dto.commissionValue).toDecimalPlaces(
          2,
          Prisma.Decimal.ROUND_HALF_UP,
        ),
      },
    });
  }

  async listAffiliates(
    workspaceId: string,
    query: { status?: string; page?: number; limit?: number },
  ) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.AffiliateWhereInput = {};
    if (query.status) where.status = query.status;

    const [data, total] = await Promise.all([
      this.prisma.affiliate.findMany({
        where: { ...where, workspaceId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.affiliate.count({ where: { ...where, workspaceId } }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getAffiliate(workspaceId: string, id: string) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { id, workspaceId },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');
    return affiliate;
  }

  // ── Self-serve portal (Epic 11a) ────────────────────────────────────────────

  /**
   * Mint (or rotate) the affiliate's portal bearer token. The raw token is
   * returned ONCE — only its sha256 is stored. A manager action.
   */
  async regeneratePortalToken(workspaceId: string, id: string) {
    await this.getAffiliate(workspaceId, id); // 404 unless in this workspace
    const token = `${AFFILIATE_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    await this.prisma.affiliate.update({
      where: { id },
      data: { portalTokenHash: hashAffiliateToken(token) },
    });
    return { token };
  }

  /** Portal dashboard: the affiliate's own profile + referral/commission rollups. */
  async portalSummary(workspaceId: string, affiliateId: string) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { id: affiliateId, workspaceId },
      select: {
        id: true, name: true, email: true, code: true, referralSlug: true,
        commissionType: true, commissionValue: true, status: true, lastLoginAt: true,
      },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');
    // Make sure the affiliate always has a shareable referral link in the portal.
    const referralSlug = affiliate.referralSlug ?? (await this.ensureReferralSlug(workspaceId, affiliateId));
    const [refGroups, commGroups] = await Promise.all([
      this.prisma.affiliateReferral.groupBy({
        by: ['status'], where: { workspaceId, affiliateId }, _count: { _all: true },
      }),
      this.prisma.affiliateCommission.groupBy({
        by: ['status'], where: { workspaceId, affiliateId }, _sum: { amount: true },
      }),
    ]);
    const referrals = Object.fromEntries(refGroups.map((g) => [g.status, g._count._all]));
    const commissions = Object.fromEntries(
      commGroups.map((g) => [g.status, (g._sum.amount ?? new Prisma.Decimal(0)).toString()]),
    );
    return { affiliate: { ...affiliate, referralSlug }, referralPath: `/api/public/r/${referralSlug}`, referrals, commissions };
  }

  async updateAffiliate(workspaceId: string, id: string, dto: UpdateAffiliateDto) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { id, workspaceId },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');

    // If code is being changed, check for collision within the workspace.
    if (dto.code && dto.code !== affiliate.code) {
      const conflict = await this.prisma.affiliate.findFirst({
        where: { workspaceId, code: dto.code },
      });
      if (conflict) {
        throw new ConflictException(
          `Affiliate code "${dto.code}" already exists in this workspace`,
        );
      }
    }

    const data: Prisma.AffiliateUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.commissionType !== undefined) data.commissionType = dto.commissionType;
    if (dto.commissionValue !== undefined) {
      data.commissionValue = new Prisma.Decimal(dto.commissionValue).toDecimalPlaces(
        2,
        Prisma.Decimal.ROUND_HALF_UP,
      );
    }
    if (dto.status !== undefined) data.status = dto.status;

    return this.prisma.affiliate.update({ where: { id }, data });
  }

  async deleteAffiliate(workspaceId: string, id: string) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { id, workspaceId },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');

    // Business rule: don't orphan commissions — block if referrals exist.
    const referralCount = await this.prisma.affiliateReferral.count({
      where: { affiliateId: id, workspaceId },
    });
    if (referralCount > 0) {
      throw new BadRequestException(
        'Cannot delete an affiliate that has referrals. Disable it instead.',
      );
    }

    return this.prisma.affiliate.delete({ where: { id } });
  }

  // ── Referrals ──────────────────────────────────────────────────────────────

  /**
   * Record a new referral for an affiliate identified by {workspaceId, code}.
   * The affiliate must be ACTIVE; PAUSED or DISABLED affiliates are rejected.
   */
  async recordReferral(
    workspaceId: string,
    code: string,
    referredLeadId?: string,
  ) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { workspaceId, code },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');
    if (affiliate.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Affiliate is ${affiliate.status.toLowerCase()} and cannot accept referrals`,
      );
    }

    return this.prisma.affiliateReferral.create({
      data: {
        workspaceId,
        affiliateId: affiliate.id,
        referredLeadId: referredLeadId ?? null,
        status: 'PENDING',
      },
    });
  }

  // ── Public referral loop (the shareable /r/:slug link) ─────────────────────

  /** Mint (once) + return the affiliate's globally-unique referral slug. */
  async ensureReferralSlug(workspaceId: string, affiliateId: string): Promise<string> {
    const aff = await this.prisma.affiliate.findFirst({
      where: { id: affiliateId, workspaceId },
      select: { referralSlug: true },
    });
    if (!aff) throw new NotFoundException('Affiliate not found');
    if (aff.referralSlug) return aff.referralSlug;
    for (let i = 0; i < 5; i++) {
      const slug = `r${randomBytes(6).toString('base64url')}`;
      try {
        await this.prisma.affiliate.update({ where: { id: affiliateId }, data: { referralSlug: slug } });
        return slug;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // slug race — retry
        throw e;
      }
    }
    throw new ConflictException('Could not allocate a referral slug');
  }

  /** Resolve a public referral slug to its affiliate (global by the unique slug). */
  async resolveReferralSlug(slug: string): Promise<{ id: string; workspaceId: string; status: string } | null> {
    if (!slug) return null;
    return this.prisma.affiliate.findUnique({
      where: { referralSlug: slug },
      select: { id: true, workspaceId: true, status: true },
    });
  }

  /**
   * Attribute a freshly-created lead to a referral slug — only if the affiliate is
   * ACTIVE and in the SAME workspace as the lead (a cookie from another tenant's
   * link must never cross-attribute). Best-effort: never throws into the form flow.
   */
  async attributeReferral(workspaceId: string, slug: string | null | undefined, leadId: string): Promise<boolean> {
    if (!slug) return false;
    try {
      const aff = await this.resolveReferralSlug(slug);
      if (!aff || aff.workspaceId !== workspaceId || aff.status !== 'ACTIVE') return false;
      await this.prisma.affiliateReferral.create({
        data: { workspaceId, affiliateId: aff.id, referredLeadId: leadId, status: 'PENDING' },
      });
      return true;
    } catch {
      return false; // attribution is best-effort — never break lead capture
    }
  }

  /** Public self-signup scoped to a referrer's workspace — creates a PENDING affiliate. */
  async selfSignup(workspaceId: string, dto: { name: string; email: string }) {
    return this.prisma.affiliate.create({
      data: {
        workspaceId,
        name: String(dto.name ?? '').slice(0, 200),
        email: String(dto.email ?? '').slice(0, 200),
        code: `aff${randomBytes(4).toString('hex')}`,
        commissionType: 'PERCENT',
        commissionValue: new Prisma.Decimal(0),
        status: 'PENDING', // staff approves → ACTIVE before it can earn
      },
    });
  }

  /**
   * Convert a PENDING referral to CONVERTED and create an OWED commission.
   * Throws 400 if the referral is already converted.
   */
  async convertReferral(
    workspaceId: string,
    referralId: string,
    conversionValue: number,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const referral = await tx.affiliateReferral.findFirst({
          where: { id: referralId, workspaceId },
          include: { affiliate: true },
        });
        if (!referral) throw new NotFoundException('Referral not found');
        if (referral.status !== 'PENDING') {
          throw new BadRequestException('Referral is already converted or rejected');
        }

        const { affiliate } = referral;
        let amount: Prisma.Decimal;
        if (affiliate.commissionType === 'PERCENT') {
          amount = new Prisma.Decimal(affiliate.commissionValue)
            .div(100)
            .mul(conversionValue)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        } else {
          // FLAT
          amount = new Prisma.Decimal(affiliate.commissionValue).toDecimalPlaces(
            2,
            Prisma.Decimal.ROUND_HALF_UP,
          );
        }

        // Compound WHERE on PENDING prevents double-conversion race.
        const claim = await tx.affiliateReferral.updateMany({
          where: { id: referralId, workspaceId, status: 'PENDING' },
          data: { status: 'CONVERTED', convertedAt: new Date() },
        });
        if (claim.count === 0) {
          throw new BadRequestException('Referral already converted');
        }

        const commission = await tx.affiliateCommission.create({
          data: {
            workspaceId,
            affiliateId: affiliate.id,
            referralId,
            amount,
            status: 'OWED',
          },
        });

        return {
          referral: await tx.affiliateReferral.findUniqueOrThrow({
            where: { id: referralId },
          }),
          commission,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listReferrals(
    workspaceId: string,
    affiliateId?: string,
    status?: string,
  ) {
    const where: Prisma.AffiliateReferralWhereInput = {};
    if (affiliateId) where.affiliateId = affiliateId;
    if (status) where.status = status;

    return this.prisma.affiliateReferral.findMany({
      where: { ...where, workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Commissions ────────────────────────────────────────────────────────────

  async listCommissions(
    workspaceId: string,
    affiliateId?: string,
    status?: string,
  ) {
    const where: Prisma.AffiliateCommissionWhereInput = {};
    if (affiliateId) where.affiliateId = affiliateId;
    if (status) where.status = status;

    return this.prisma.affiliateCommission.findMany({
      where: { ...where, workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveCommission(workspaceId: string, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const commission = await tx.affiliateCommission.findFirst({
          where: { id, workspaceId },
        });
        if (!commission) throw new NotFoundException('Commission not found');
        if (commission.status !== 'OWED') {
          throw new BadRequestException('Only OWED commissions can be approved');
        }

        const claim = await tx.affiliateCommission.updateMany({
          where: { id, workspaceId, status: 'OWED' },
          data: { status: 'APPROVED' },
        });
        if (claim.count === 0) {
          throw new BadRequestException('Commission already approved');
        }
        return tx.affiliateCommission.findUniqueOrThrow({ where: { id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async payCommission(workspaceId: string, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const commission = await tx.affiliateCommission.findFirst({
          where: { id, workspaceId },
        });
        if (!commission) throw new NotFoundException('Commission not found');
        if (commission.status !== 'APPROVED') {
          throw new BadRequestException('Only APPROVED commissions can be paid');
        }

        const claim = await tx.affiliateCommission.updateMany({
          where: { id, workspaceId, status: 'APPROVED' },
          data: { status: 'PAID' },
        });
        if (claim.count === 0) {
          throw new BadRequestException('Commission already paid');
        }
        return tx.affiliateCommission.findUniqueOrThrow({ where: { id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
