import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** An APPLYING row older than this was stranded by a crash/thrown-revert mid
 *  claimForApply/revertApply (mcp-approval-executor.service.ts) — the widest
 *  single external call any registered MCP tool makes today tops out at
 *  120s (network-adapters.ts upload timeouts), and claimForApply brackets
 *  exactly one such call, not a multi-step run. 5 minutes is a >2x margin
 *  over that, while still surfacing a stranded row within one or two ticks
 *  of the 10-minute sweep below. */
const STALE_APPLYING_MS = 5 * 60 * 1000;

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
  private readonly logger = new Logger(ApprovalRequestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Crash recovery for the claim-first apply guard (claimForApply /
   *  finishApply / revertApply): if revertApply itself throws, or the
   *  process dies between claimForApply and finishApply/revertApply, a row
   *  is stranded in APPLYING with nothing left to move it out. Sweep it
   *  back to APPROVED, mirroring AgentRunService.reapStaleRuns().
   *
   *  Reclaim to APPROVED, deliberately not APPLIED. Whether the underlying
   *  MCP tool call actually completed is exactly the unknown a stranded row
   *  represents — the process could have died before the call, during it, or
   *  after it succeeded but before finishApply committed. APPROVED puts the
   *  request back in the human queue (listPending returns PENDING ∪
   *  APPROVED, and the UI renders an Apply affordance for it — see Task 7)
   *  where an operator decides whether to retry, instead of guessing.
   *  Reclaiming to APPLIED would risk silently recording an approved
   *  customer-facing action (send/publish/reallocate) as done when it may
   *  never have happened — worse than a duplicate apply, which claimForApply
   *  already makes at-most-once-safe, this would be a silent no-op mistaken
   *  for success. */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'approval-applying-reaper' })
  async reapStaleApplying(): Promise<void> {
    try {
      const res = await this.prisma.approvalRequest.updateMany({
        where: { status: 'APPLYING', updatedAt: { lt: new Date(Date.now() - STALE_APPLYING_MS) } },
        data: { status: 'APPROVED' },
      });
      if (res.count > 0) this.logger.warn(`approval reaper: reclaimed ${res.count} stale APPLYING request(s) to APPROVED`);
    } catch (e) {
      this.logger.error(`approval reaper failed: ${(e as Error)?.message ?? e}`);
    }
  }

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

  /**
   * The operator queue: PENDING (awaiting a decision) AND APPROVED-but-not-yet-
   * APPLIED (decided, but the execute step hasn't finished). The latter matters
   * because approve and apply are two separate calls for MCP-originated
   * requests (McpApprovalExecutorService.apply) — if apply fails or the tab
   * closes between the two, the row must stay visible with a retry affordance
   * instead of vanishing. A PENDING-only filter here previously stranded such
   * a request APPROVED-unapplied and invisible, with no way for an operator to
   * ever find and retry it. APPLYING/APPLIED/REJECTED/EXPIRED are terminal or
   * mid-flight-and-owned-by-the-in-progress-caller, so they stay out.
   */
  listPending(workspaceId: string, take = 100) {
    return this.prisma.approvalRequest.findMany({
      where: { workspaceId, status: { in: ['PENDING', 'APPROVED'] } },
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

  /**
   * Claim-first execution guard (APPROVED -> APPLYING), for executors whose
   * side effect is NOT itself idempotent/atomic (an MCP tool call: send a
   * message, publish a post, push a spend change). `markApplied` above
   * guards double-MARKING — it is called AFTER the side effect runs, so two
   * concurrent callers can both pass an APPROVED read, both run the side
   * effect, and only the loser fails at markApplied, after its send already
   * happened. Claiming APPLYING BEFORE the side effect runs closes that
   * window: only the caller that wins this atomic updateMany may proceed to
   * execute; the loser is rejected here, before touching anything.
   * Pair with `finishApply` (success) or `revertApply` (failure) — never
   * leave a request stranded in APPLYING.
   */
  async claimForApply(workspaceId: string, id: string) {
    const claim = await this.prisma.approvalRequest.updateMany({
      where: { id, workspaceId, status: 'APPROVED' },
      data: { status: 'APPLYING' },
    });
    if (claim.count === 0) {
      const fresh = await this.owned(workspaceId, id); // 404 for missing/cross-workspace
      throw new BadRequestException(`cannot apply a ${fresh.status} request`);
    }
    return this.owned(workspaceId, id);
  }

  /** Completes a `claimForApply` claim after the side effect succeeded (APPLYING -> APPLIED). */
  async finishApply(workspaceId: string, id: string) {
    const claim = await this.prisma.approvalRequest.updateMany({
      where: { id, workspaceId, status: 'APPLYING' },
      data: { status: 'APPLIED', appliedAt: new Date() },
    });
    if (claim.count === 0) {
      throw new BadRequestException('request is not in an APPLYING state');
    }
    return this.owned(workspaceId, id);
  }

  /** Releases a `claimForApply` claim after the side effect failed (APPLYING -> APPROVED), so an operator can retry. */
  async revertApply(workspaceId: string, id: string): Promise<void> {
    await this.prisma.approvalRequest.updateMany({
      where: { id, workspaceId, status: 'APPLYING' },
      data: { status: 'APPROVED' },
    });
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
