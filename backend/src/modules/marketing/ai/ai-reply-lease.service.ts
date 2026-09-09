import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AI_REPLY_KIND } from './ai-execution';

/**
 * The status a queued reply sits in while a connector holds it.
 *
 * Deliberately one the two GENERIC sweepers do not know about, exactly as
 * `RESEARCH_JOB_CLAIMED` is: `ScheduledJobRunnerService.claimBatch` takes only
 * PENDING and its `reapStuck` revives only RUNNING, so a leased reply is
 * invisible to both and this service owns its whole lifetime — including its
 * expiry — without teaching the generic runner about a lane it does not drain.
 */
export const AI_REPLY_CLAIMED = 'CLAIMED';

/**
 * How long a connector holds a reply before it returns to the queue.
 *
 * Short, because the thing waiting is a customer. A client that leases a reply
 * and dies must not park that conversation for half an hour; two minutes is
 * longer than writing one message takes and shorter than anyone notices.
 */
export const AI_REPLY_LEASE_MS = Number(process.env.AI_REPLY_LEASE_MS ?? 2 * 60 * 1000);

/** Bounded so one poll cannot spin over a large queue of contended rows. */
const MAX_CLAIM_ATTEMPTS = 5;

export interface ClaimedReply {
  jobId: string;
  conversationId: string;
  queuedAt: Date;
}

/**
 * Hand a queued reply to the workspace's own Claude, and take it back if that
 * Claude never finishes.
 *
 * This is the drainer half of `aiExecution`. Without it, `MCP_ONLY` would mean
 * "no customer is ever answered" — a queue with no consumer, which is the
 * silent-failure shape this codebase keeps having to dig out. The mode and its
 * drainer therefore ship together, always.
 *
 * It does NOT write the reply. The connector claims, composes with everything
 * it already has (`jeeta.read_conversation`, `jeeta.get_agent`,
 * `jeeta.search_brand_knowledge`), sends through `jeeta.send_message` — which
 * carries the quota, the channel resolution and the audit trail that any other
 * reply gets — and then completes the job. Keeping the send on the existing
 * path is what stops this lane becoming a second, thinner way to message a
 * customer.
 */
@Injectable()
export class AiReplyLeaseService {
  private readonly logger = new Logger(AiReplyLeaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return leases that outlived their window to the queue.
   *
   * Lazy, with exactly two callers — `claim()` and `pending()` — for the same
   * reason the research lane is lazy: a cron for it would be a second sweeper
   * over a lane that heals itself the moment anybody looks. The cost of that
   * choice is written down rather than hidden: a workspace whose connector
   * leases a reply, dies, and never polls again strands THAT reply until
   * something looks. Under `MCP` the row is beyond its grace by then, so the
   * platform takes it on the next tick; under `MCP_ONLY` it waits, and the
   * queue depth is what says so.
   */
  async releaseExpired(workspaceId: string): Promise<number> {
    const { count } = await this.prisma.scheduledJob.updateMany({
      where: {
        workspaceId,
        kind: AI_REPLY_KIND,
        status: AI_REPLY_CLAIMED,
        lockedAt: { lt: new Date(Date.now() - AI_REPLY_LEASE_MS) },
      },
      // `runAt` is left alone so the row keeps its original place in the queue
      // — a reply that has already waited should not go to the back of it.
      data: { status: 'PENDING', lockedAt: null },
    });
    if (count > 0) {
      this.logger.warn(`released ${count} expired ai-reply lease(s) for workspace=${workspaceId}`);
    }
    return count;
  }

  /**
   * Lease the oldest queued reply, or null when there is none.
   *
   * The claim is atomic by construction: `updateMany` filtered on the id AND
   * `status: 'PENDING'` updates one row or zero, so two connectors polling at
   * once cannot both win. A miss retries against the next row rather than
   * failing the poll, because losing a race is normal and returning "nothing
   * queued" when there plainly is would be a lie.
   */
  async claim(workspaceId: string): Promise<ClaimedReply | null> {
    await this.releaseExpired(workspaceId);

    const tried: string[] = [];
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const next = await this.prisma.scheduledJob.findFirst({
        where: {
          workspaceId,
          kind: AI_REPLY_KIND,
          status: 'PENDING',
          ...(tried.length ? { id: { notIn: tried } } : {}),
        },
        orderBy: { runAt: 'asc' },
        select: { id: true, payload: true, createdAt: true },
      });
      if (!next) return null;
      tried.push(next.id);

      const { count } = await this.prisma.scheduledJob.updateMany({
        where: { id: next.id, workspaceId, status: 'PENDING' },
        data: { status: AI_REPLY_CLAIMED, lockedAt: new Date() },
      });
      if (count !== 1) continue; // somebody else won it; try the next row

      const conversationId = (next.payload as any)?.conversationId;
      if (typeof conversationId !== 'string' || !conversationId) {
        // A row we cannot act on must not sit CLAIMED forever pretending to be
        // someone's work in progress.
        await this.prisma.scheduledJob.updateMany({
          where: { id: next.id, workspaceId },
          data: { status: 'FAILED', lastError: 'ai_reply job carries no conversationId' },
        });
        continue;
      }
      return { jobId: next.id, conversationId, queuedAt: next.createdAt };
    }
    return null;
  }

  /**
   * Close a leased reply. `handled: false` returns it to the queue instead,
   * which is what a connector that decided NOT to answer should say.
   *
   * A handled reply also LIFTS `aiPaused`, and that is not a convenience —
   * without it this lane answers each conversation exactly once and then goes
   * silent on it forever.
   *
   * `ConversationsService.reply()` — the path `jeeta.send_message` takes, and
   * the one this lane is deliberately routed through so a reply carries the
   * quota, channel resolution and audit trail every other reply gets — sets
   * `aiPaused: true` on the way out. That is right for what it was written
   * for: a person typing in the panel HAS taken the thread over. It is wrong
   * for the connector, because the connector IS the AI answering. The pause its
   * own send set microseconds earlier is not a human takeover, and leaving it
   * would make `reply()` decline the next message, the backfill skip the
   * thread, and the customer's follow-up land in silence.
   *
   * Guarded on the last outbound being AI-authored, so a human who genuinely
   * stepped in WHILE the lease was held keeps their pause. That is the only
   * case where clearing would be wrong, and it is cheap to exclude.
   */
  async complete(workspaceId: string, jobId: string, handled: boolean): Promise<boolean> {
    const job = await this.prisma.scheduledJob.findFirst({
      where: { id: jobId, workspaceId, kind: AI_REPLY_KIND, status: AI_REPLY_CLAIMED },
      select: { payload: true },
    });
    const { count } = await this.prisma.scheduledJob.updateMany({
      where: { id: jobId, workspaceId, kind: AI_REPLY_KIND, status: AI_REPLY_CLAIMED },
      data: handled
        ? { status: 'DONE', completedAt: new Date() }
        : { status: 'PENDING', lockedAt: null },
    });
    if (count === 1 && handled) {
      const conversationId = (job?.payload as any)?.conversationId;
      if (typeof conversationId === 'string' && conversationId) {
        await this.resumeIfWeAnswered(workspaceId, conversationId);
      }
    }
    return count === 1;
  }

  /** Lift the pause the lane's own send left behind — but only when the last
   *  word out was in fact the AI's. */
  private async resumeIfWeAnswered(workspaceId: string, conversationId: string): Promise<void> {
    const lastOut = await this.prisma.message.findFirst({
      where: { workspaceId, conversationId, direction: 'OUTBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { authorType: true },
    });
    if (lastOut?.authorType !== 'AI') return;
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, workspaceId, aiPaused: true },
      data: { aiPaused: false },
    });
  }

  /** How many replies are waiting, and how long the oldest has waited. The
   *  number that has to be visible for `MCP_ONLY` to be an honest promise. */
  async pending(workspaceId: string): Promise<{ waiting: number; oldestQueuedAt: Date | null }> {
    await this.releaseExpired(workspaceId);
    const [waiting, oldest] = await Promise.all([
      this.prisma.scheduledJob.count({
        where: { workspaceId, kind: AI_REPLY_KIND, status: 'PENDING' },
      }),
      this.prisma.scheduledJob.findFirst({
        where: { workspaceId, kind: AI_REPLY_KIND, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return { waiting, oldestQueuedAt: oldest?.createdAt ?? null };
  }
}
