import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommissionFilterDto } from '../dto/commission-filter.dto';

@Injectable()
export class MarketingCommissionsService {
  constructor(private prisma: PrismaService) {}

  async findAll(
    workspaceId: string,
    filter: CommissionFilterDto,
    userId: string,
    userRole: string,
  ) {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (userRole === 'REP') {
      where.marketingUserId = userId;
    } else if (filter.marketingUserId) {
      where.marketingUserId = filter.marketingUserId;
    }

    if (filter.status) where.status = filter.status;
    if (filter.period) where.period = filter.period;
    if (filter.type) where.type = filter.type;

    // workspaceId is spread LAST so no filter combination can ever
    // widen the query beyond the caller's workspace.
    const [commissions, total] = await Promise.all([
      this.prisma.commission.findMany({
        where: { ...where, workspaceId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          marketingUser: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.commission.count({ where: { ...where, workspaceId } }),
    ]);

    return {
      data: commissions,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * One commission with its rep + originating lead + append-only audit log, for
   * the detail modal. Workspace-scoped; a REP may only read its OWN rows (same
   * rule as findAll/getSummary). 404 when absent or out of scope.
   */
  async get(workspaceId: string, id: string, userId: string, userRole: string) {
    const commission = await this.prisma.commission.findFirst({
      // workspaceId inline (not via a variable) so the multi-tenant fitness scan
      // sees it; REP may read only its own rows.
      where: {
        id,
        workspaceId,
        ...(userRole === 'REP' ? { marketingUserId: userId } : {}),
      },
      include: {
        marketingUser: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        lead: {
          select: {
            id: true,
            businessName: true,
            contactPerson: true,
            source: true,
            status: true,
            convertedAt: true,
          },
        },
      },
    });
    if (!commission) throw new NotFoundException('Commission not found');
    return commission;
  }

  async getSummary(workspaceId: string, userId: string, userRole: string, period?: string) {
    const where: any = {};

    if (userRole === 'REP') {
      where.marketingUserId = userId;
    }

    if (period) {
      where.period = period;
    }

    const [pending, approved, paid] = await Promise.all([
      this.prisma.commission.aggregate({
        where: { ...where, status: 'PENDING', workspaceId },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.commission.aggregate({
        where: { ...where, status: 'APPROVED', workspaceId },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.commission.aggregate({
        where: { ...where, status: 'PAID', workspaceId },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    return {
      pending: {
        count: pending._count,
        total: pending._sum.amount || 0,
      },
      approved: {
        count: approved._count,
        total: approved._sum.amount || 0,
      },
      paid: {
        count: paid._count,
        total: paid._sum.amount || 0,
      },
    };
  }

  async approve(workspaceId: string, id: string, actorId: string) {
    // Serializable + read-modify-write inside one tx: two managers
    // clicking Approve at the same millisecond previously both passed
    // the status check then both wrote APPROVED + appended one audit
    // entry each from THEIR snapshot — meaning the auditLog lost the
    // loser's entry (last writer wins). With Serializable the second
    // tx retries against the now-APPROVED row and surfaces the proper
    // "already processed" error.
    return this.prisma.$transaction(async (tx) => {
      const commission = await tx.commission.findFirst({ where: { id, workspaceId } });
      if (!commission) throw new NotFoundException('Commission not found');
      if (commission.status !== 'PENDING') {
        throw new BadRequestException('Only pending commissions can be approved');
      }
      // An amount of zero usually means the auto-calculation had nothing
      // to apply (FREE-plan conversion, etc.). Require the manager to
      // set a real amount before approval so accounting has something to
      // pay out.
      if (new (commission.amount.constructor as any)(commission.amount).isZero?.() ||
          Number(commission.amount) === 0) {
        throw new BadRequestException(
          'Commission amount is zero. Set an amount before approving.',
        );
      }

      const auditLog = appendAuditEntry(commission.auditLog, {
        action: 'approve',
        actorId,
        prevStatus: commission.status,
        nextStatus: 'APPROVED',
      });

      // Compound WHERE on the original PENDING status is the belt to
      // Serializable's suspenders — even if isolation downgrades for
      // some reason, only the first writer transitions.
      const claim = await tx.commission.updateMany({
        where: { id, workspaceId, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedById: actorId,
          auditLog,
        },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Commission already approved');
      }
      return tx.commission.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Set the commission amount. Only valid while still PENDING so
   * approved/paid rows remain immutable for audit. Each call appends
   * an `amount` entry to the audit log with the old + new value so
   * the manager who flips the number is on the record.
   */
  async updateAmount(workspaceId: string, id: string, amount: number, actorId: string) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('Amount must be a non-negative number');
    }
    // Same Serializable + compound-WHERE pattern as approve(): the
    // bare update used to lose audit-log entries on a manager-race.
    return this.prisma.$transaction(async (tx) => {
      const commission = await tx.commission.findFirst({ where: { id, workspaceId } });
      if (!commission) throw new NotFoundException('Commission not found');
      if (commission.status !== 'PENDING') {
        throw new BadRequestException('Only pending commissions can be updated');
      }
      const auditLog = appendAuditEntry(commission.auditLog, {
        action: 'amount',
        actorId,
        prevAmount: commission.amount.toString(),
        nextAmount: amount.toString(),
      });
      // Normalise through Prisma.Decimal to avoid passing a JS float at the
      // edge of IEEE-754 precision into a Decimal(10,2) column. The
      // canonical create path in marketing-leads already does this.
      const claim = await tx.commission.updateMany({
        where: { id, workspaceId, status: 'PENDING' },
        data: { amount: new Prisma.Decimal(amount).toDecimalPlaces(2), auditLog },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Commission no longer pending');
      }
      return tx.commission.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async markPaid(workspaceId: string, id: string, actorId: string) {
    // Same Serializable + compound-WHERE pattern as approve().
    return this.prisma.$transaction(async (tx) => {
      const commission = await tx.commission.findFirst({ where: { id, workspaceId } });
      if (!commission) throw new NotFoundException('Commission not found');
      if (commission.status !== 'APPROVED') {
        throw new BadRequestException('Only approved commissions can be marked as paid');
      }

      const auditLog = appendAuditEntry(commission.auditLog, {
        action: 'pay',
        actorId,
        prevStatus: commission.status,
        nextStatus: 'PAID',
      });

      const claim = await tx.commission.updateMany({
        where: { id, workspaceId, status: 'APPROVED' },
        data: { status: 'PAID', paidAt: new Date(), paidById: actorId, auditLog },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Commission already marked as paid');
      }
      return tx.commission.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

/**
 * Audit-log helper: append an entry to the JSON array on a
 * commission, returning a value safe to pass directly to a Prisma
 * `data: { auditLog: ... }`. Treats null/undefined existing logs as
 * empty arrays so the first transition still creates valid JSON.
 */
type AuditEntry = {
  action: 'approve' | 'pay' | 'amount';
  actorId: string;
  prevStatus?: string;
  nextStatus?: string;
  prevAmount?: string;
  nextAmount?: string;
};

function appendAuditEntry(existing: unknown, entry: AuditEntry): Prisma.InputJsonValue {
  const arr = Array.isArray(existing) ? existing : [];
  return [...arr, { at: new Date().toISOString(), ...entry }] as unknown as Prisma.InputJsonValue;
}
