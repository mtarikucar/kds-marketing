import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { AI_REPLY_KIND } from './ai-execution';
import { AI_REPLY_CLAIMED } from './ai-reply-lease.service';

/**
 * How far back a waiting customer is still worth answering.
 *
 * Bounds the blast radius of switching this on. Without it, the first tick on
 * any workspace would enqueue every conversation that ever ended with the
 * customer speaking — including threads from months ago whose answer is now
 * irrelevant and whose sudden arrival reads as a system that lost its mind.
 * Seven days is the window in which a reply is still a reply rather than an
 * apology.
 */
const BACKFILL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Per workspace, per tick. A backlog drains over hours instead of arriving as
 *  one burst that no drainer — human or connector — can absorb. */
const BACKFILL_CAP = 20;

/**
 * Enrol conversations that were ALREADY waiting when the reply lane was
 * switched on.
 *
 * `ConversationAiEngineService.onInbound` queues a reply when a message
 * ARRIVES. That is the whole of it — which means a conversation the customer
 * had already ended, before an agent was attached or before the workspace
 * moved to a connector mode, waits for a message that will never come. It is
 * invisible to the lane forever, however long the customer sits there.
 *
 * That is not a hypothetical. It was found by a customer writing twice, being
 * answered once by a human eight hours later, and the lane never seeing either
 * message because both predated the switch. The product ALREADY KNEW: the
 * daily digest reports "N conversations awaiting a reply — the customer spoke
 * last" and has been reporting it all along. The knowledge existed and nothing
 * acted on it, which is this codebase's most familiar shape of bug.
 *
 * ## What it will not touch
 *
 * Every bound here exists because the alternative is answering someone who
 * should not be answered:
 *
 *  - The customer must have spoken LAST (`lastInboundAt == lastMessageAt`).
 *    A thread we replied to is not waiting on us.
 *  - `aiPaused` conversations are skipped. That flag means a human took over,
 *    and taking it back is not a backfill's decision to make.
 *  - The channel must have an agent attached. No agent is a deliberate choice
 *    that the channel stays manual; this must not quietly overrule it.
 *  - Anything already queued or leased is skipped, so a slow drainer does not
 *    accumulate duplicate answers to the same person.
 */
@Injectable()
export class AiReplyBackfillService {
  private readonly logger = new Logger(AiReplyBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'ai-reply-backfill' })
  async sweepDue(): Promise<void> {
    await withAdvisoryLock(this.prisma, 'ai-reply-backfill', async () => {
      await this.sweep();
    }, this.logger);
  }

  async sweep(): Promise<{ enqueued: number }> {
    const since = new Date(Date.now() - BACKFILL_LOOKBACK_MS);

    // Conversations already in the lane, in ANY non-terminal state. `schedule`
    // dedupes on (kind, dedupKey) only WHERE status = 'PENDING', so a job a
    // connector currently holds would not block a second row — and the customer
    // would be answered twice.
    const inFlight = await this.prisma.scheduledJob.findMany({
      where: { kind: AI_REPLY_KIND, status: { in: ['PENDING', AI_REPLY_CLAIMED, 'RUNNING'] } },
      select: { payload: true },
    });
    const busy = new Set(
      inFlight
        .map((j) => (j.payload as any)?.conversationId)
        .filter((id): id is string => typeof id === 'string'),
    );

    // Channels that have an agent attached. Conversation carries a SOFT
    // `channelId` with no relation, so this cannot be a join — and resolving it
    // separately is the honest read anyway: a channel with no agent is a
    // deliberate choice that it stays manual, and a backfill must not overrule
    // that quietly.
    const answering = await this.prisma.channel.findMany({
      where: { status: 'ACTIVE', agentProfileId: { not: null } },
      select: { id: true },
    });
    if (answering.length === 0) return { enqueued: 0 };

    const waiting = await this.prisma.conversation.findMany({
      where: {
        status: 'OPEN',
        aiPaused: false,
        lastInboundAt: { not: null, gte: since },
        // The customer spoke last. Prisma field references compare two columns
        // without dropping to raw SQL; a thread we already replied to has
        // lastMessageAt ahead of lastInboundAt and is not waiting on us.
        lastMessageAt: { equals: this.prisma.conversation.fields.lastInboundAt },
        channelId: { in: answering.map((c) => c.id) },
      },
      orderBy: { lastInboundAt: 'asc' },
      select: { id: true, workspaceId: true },
    });

    let enqueued = 0;
    const perWorkspace = new Map<string, number>();
    for (const convo of waiting) {
      if (busy.has(convo.id)) continue;
      const used = perWorkspace.get(convo.workspaceId) ?? 0;
      if (used >= BACKFILL_CAP) continue;
      try {
        await this.scheduledJobs.schedule({
          workspaceId: convo.workspaceId,
          kind: AI_REPLY_KIND,
          runAt: new Date(),
          dedupKey: convo.id,
          payload: { workspaceId: convo.workspaceId, conversationId: convo.id },
        });
        perWorkspace.set(convo.workspaceId, used + 1);
        enqueued++;
      } catch (e: any) {
        // A duplicate is the dedup working, not a failure worth shouting about.
        this.logger.debug(`backfill skipped convo=${convo.id}: ${e?.message ?? e}`);
      }
    }
    if (enqueued > 0) {
      this.logger.log(`ai-reply-backfill: enrolled ${enqueued} conversation(s) that were already waiting`);
    }
    return { enqueued };
  }
}
