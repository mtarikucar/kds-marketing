import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';

/** The queue kind a proactive nudge waits in. */
export const FOLLOWUP_KIND = 'conversation.followup';

export interface FollowupPolicy {
  enabled: true;
  afterHours: number;
  maxFollowups: number;
}

/**
 * The half of a sale that happens when nobody writes back.
 *
 * A customer asks a question, gets a good answer, and goes quiet. Nothing in
 * an inbound-driven lane ever fires again for them: `onInbound` needs a message
 * that is never coming, and the backfill sweep only looks at threads where the
 * CUSTOMER spoke last. So the deal ends in silence, on our side, by default —
 * which is exactly the complaint that "the AI answers messages but does not
 * take the process to a sale".
 *
 * The follow-up lane already existed and was reachable from ONE place: the end
 * of the platform's own `reply()`. That made it silently conditional on the
 * platform answering. A workspace whose Claude answers through the connector —
 * the direction this product is deliberately moving in — scheduled a follow-up
 * never, for any conversation, and nothing said so.
 *
 * Pulling it out here is what lets both answerers schedule the same nudge on
 * the same policy. The scheduling decision is small; where it can be called
 * from is the whole point.
 */
@Injectable()
export class ConversationFollowupService {
  private readonly logger = new Logger(ConversationFollowupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
  ) {}

  /** The agent's own policy, clamped. `null` means this agent does not chase. */
  policyFor(agent: { followup: unknown } | null | undefined): FollowupPolicy | null {
    const f = (agent?.followup ?? null) as Partial<FollowupPolicy> | null;
    if (!f || !f.enabled) return null;
    return {
      enabled: true,
      afterHours: Math.min(Math.max(Number(f.afterHours) || 24, 1), 168),
      maxFollowups: Math.min(Math.max(Number(f.maxFollowups) || 0, 0), 5),
    };
  }

  /**
   * Queue the next nudge for this conversation, if its agent chases at all and
   * it has not been chased its full allowance already.
   *
   * Returns whether one was queued — callers log it rather than act on it, but
   * "did anything happen" is the question this lane kept failing to answer.
   *
   * The `followupCount` check lives HERE and not only in the handler on
   * purpose: a job scheduled past the cap is a row that sits in the queue for
   * hours and is then dropped on arrival, which reads as a pending nudge to
   * anyone looking at the queue and is not one.
   */
  async scheduleNext(
    workspaceId: string,
    conversationId: string,
    agent?: { followup: unknown } | null,
  ): Promise<boolean> {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { channelId: true, followupCount: true, status: true, aiPaused: true },
    });
    if (!convo || convo.status !== 'OPEN' || convo.aiPaused) return false;

    // Resolve the agent when the caller has not already got it. The connector
    // lane calls this holding only a conversation id, and requiring it to fetch
    // the channel and the profile first would put the same three queries in two
    // places and let them drift.
    let source = agent ?? null;
    if (!source) {
      const channel = await this.prisma.channel.findFirst({
        where: { id: convo.channelId, workspaceId, status: 'ACTIVE' },
        select: { agentProfileId: true },
      });
      if (!channel?.agentProfileId) return false;
      source = await this.prisma.agentProfile.findFirst({
        where: { id: channel.agentProfileId, workspaceId, status: 'ACTIVE' },
        select: { followup: true },
      });
    }

    const policy = this.policyFor(source);
    if (!policy || policy.maxFollowups <= 0) return false;
    if (convo.followupCount >= policy.maxFollowups) return false;

    try {
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: FOLLOWUP_KIND,
        runAt: new Date(Date.now() + policy.afterHours * 3600_000),
        dedupKey: conversationId,
        payload: { workspaceId, conversationId },
      });
      return true;
    } catch (e: any) {
      // A duplicate is one nudge already waiting for this conversation, which
      // is the dedup working rather than a failure.
      this.logger.debug(`follow-up not queued convo=${conversationId}: ${e?.message ?? e}`);
      return false;
    }
  }

  /** The customer wrote back. Whatever we were going to chase them about is
   *  answered by the thing they just said. */
  async cancelFor(conversationId: string): Promise<void> {
    await this.scheduledJobs.cancel(FOLLOWUP_KIND, conversationId).catch(() => undefined);
  }

  /** Raise the count that the cap is measured against. The connector lane has
   *  no other moment to do it: the platform bumps this after its own send, and
   *  a nudge sent through the connector that never counted would let the same
   *  customer be chased forever. */
  async countFollowup(workspaceId: string, conversationId: string): Promise<void> {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, workspaceId },
      data: { followupCount: { increment: 1 } },
    });
  }
}
