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
    const req = await this.owned(workspaceId, id);
    if (req.status !== 'APPROVED') throw new BadRequestException(`cannot apply a ${req.status} request`);
    return this.prisma.approvalRequest.update({ where: { id }, data: { status: 'APPLIED', appliedAt: new Date() } });
  }

  private async decide(workspaceId: string, id: string, userId: string, status: 'APPROVED' | 'REJECTED') {
    const req = await this.owned(workspaceId, id);
    if (req.status !== 'PENDING') throw new BadRequestException(`request already ${req.status}`);
    if (req.expiresAt && req.expiresAt.getTime() < Date.now()) {
      await this.prisma.approvalRequest.update({ where: { id }, data: { status: 'EXPIRED' } });
      throw new BadRequestException('request has expired');
    }
    return this.prisma.approvalRequest.update({
      where: { id },
      data: { status, decidedById: userId, decidedAt: new Date() },
    });
  }

  private async owned(workspaceId: string, id: string) {
    const req = await this.prisma.approvalRequest.findFirst({ where: { id, workspaceId } });
    if (!req) throw new NotFoundException('Approval request not found');
    return req;
  }
}
