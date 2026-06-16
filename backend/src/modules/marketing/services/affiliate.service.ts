import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

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
