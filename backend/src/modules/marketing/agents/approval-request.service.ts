import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type ApprovalKind =
  | 'BUDGET_REALLOCATION'
  | 'PUBLISH'
  | 'SEND'
  | 'AD_SPEND'
  | 'TARGET_CHANGE'
  | 'CHANNEL_LAUNCH';

export interface EnqueueInput {
  kind: ApprovalKind;
  summary: string;
  payload: unknown;
  requestedByRunId?: string;
  resourceType?: string;
  resourceId?: string;
  expiresAt?: Date;
}

/**
 * The unified human-approval queue (Faz 3). Every high-risk action an agent or
 * the Budget Autopilot wants to take above its autonomy threshold enqueues here
 * and stays PENDING until an OWNER/MANAGER approves — the enforcement point of
 * the "generate → review → approve → execute" safety stance for money/publish/
 * send. Approve/reject are guarded against double-decision and expiry.
 */
@Injectable()
export class ApprovalRequestService {
  constructor(private readonly prisma: PrismaService) {}

  enqueue(workspaceId: string, input: EnqueueInput) {
    return this.prisma.approvalRequest.create({
      data: {
        workspaceId,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload as Prisma.InputJsonValue,
        requestedByRunId: input.requestedByRunId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        expiresAt: input.expiresAt,
      },
    });
  }

  listPending(workspaceId: string, take = 100) {
    return this.prisma.approvalRequest.findMany({
      where: { workspaceId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(take, 1), 200),
    });
  }

  async approve(workspaceId: string, id: string, userId: string) {
    return this.decide(workspaceId, id, userId, 'APPROVED');
  }

  async reject(workspaceId: string, id: string, userId: string) {
    return this.decide(workspaceId, id, userId, 'REJECTED');
  }

  /** Mark an approved request as applied (called by the executor after it runs). */
  async markApplied(workspaceId: string, id: string) {
    await this.owned(workspaceId, id); // 404 for missing/cross-workspace
    // Conditional claim, not read-check-then-update: a concurrent decide()
    // could interleave between the read and an unconditional write, letting a
    // late REJECTED overwrite an already-executed (money-moved) request.
    const claim = await this.prisma.approvalRequest.updateMany({
      where: { id, workspaceId, status: 'APPROVED' },
      data: { status: 'APPLIED', appliedAt: new Date() },
    });
    if (claim.count === 0) {
      const fresh = await this.owned(workspaceId, id);
      throw new BadRequestException(`cannot apply a ${fresh.status} request`);
    }
    return this.owned(workspaceId, id);
  }

  private async decide(workspaceId: string, id: string, userId: string, status: 'APPROVED' | 'REJECTED') {
    const req = await this.owned(workspaceId, id);
    if (req.expiresAt && req.expiresAt.getTime() < Date.now()) {
      // Only a still-PENDING row may flip to EXPIRED — never clobber a decision.
      await this.prisma.approvalRequest.updateMany({
        where: { id, workspaceId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('request has expired');
    }
    // Atomic single-winner decision: two concurrent approve/reject clicks both
    // read PENDING, but only the first conditional write claims the row — the
    // loser gets "already decided" instead of silently overwriting the winner
    // (the docblock's "guarded against double-decision" promise, now enforced
    // at the write, not just the read).
    const claim = await this.prisma.approvalRequest.updateMany({
      where: { id, workspaceId, status: 'PENDING' },
      data: { status, decidedById: userId, decidedAt: new Date() },
    });
    if (claim.count === 0) {
      const fresh = await this.owned(workspaceId, id);
      throw new BadRequestException(`request already ${fresh.status}`);
    }
    return this.owned(workspaceId, id);
  }

  private async owned(workspaceId: string, id: string) {
    const req = await this.prisma.approvalRequest.findFirst({ where: { id, workspaceId } });
    if (!req) throw new NotFoundException('Approval request not found');
    return req;
  }
}
