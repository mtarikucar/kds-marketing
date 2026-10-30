import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ConversationIngressService } from '../../src/modules/marketing/channels/conversation-ingress.service';
import { AiReplyBackfillService } from '../../src/modules/marketing/ai/ai-reply-backfill.service';
import { AI_REPLY_KIND } from '../../src/modules/marketing/ai/ai-execution';
import { ScheduledJobService } from '../../src/modules/marketing/scheduling/scheduled-job.service';
import { OutboxWorkerService } from '../../src/modules/outbox/outbox-worker.service';
import { installTickingClock } from '../../src/common/test/ticking-clock';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * A customer message the ingress stamped is one the AI reply backfill finds,
 * against REAL Postgres.
 *
 * The writer and the reader have to agree on one thing: the backfill counts a
 * thread as waiting only when `lastMessageAt` EQUALS `lastInboundAt` — a
 * column-to-column comparison only the database evaluates, which is why a
 * mocked Prisma cannot show it. The ingress used to stamp the two with two
 * separate `new Date()` reads, so whenever the millisecond ticked between them
 * the thread sat 1 ms "answered" and the sweep that exists to catch dropped
 * replies skipped it for good.
 *
 * A real clock ticks there rarely, so the ingest runs under a clock that moves
 * on every read: before the fix this failed every time, not once a month.
 *
 * The outbox worker and every cron are stopped first. Otherwise the event the
 * ingest emits could reach the AI engine and queue the reply itself, and the
 * backfill would rightly skip a thread already in the lane — passing or failing
 * for a reason that has nothing to do with the stamps.
 *
 * Opt-in via E2E_REAL_DB=1, like the other real-DB suites.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('AI reply backfill sees what the ingress stamped — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ingress: ConversationIngressService;
  let backfill: AiReplyBackfillService;
  let scheduledJobs: ScheduledJobService;

  const workspaceId = randomUUID();
  const channelId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    ingress = app.get(ConversationIngressService);
    backfill = app.get(AiReplyBackfillService);
    scheduledJobs = app.get(ScheduledJobService);

    app.get(OutboxWorkerService).onModuleDestroy();
    for (const [, cron] of app.get(SchedulerRegistry).getCronJobs()) {
      try {
        (cron as { stop?: () => void }).stop?.();
      } catch {
        /* a cron that will not stop is not this spec's problem to fix */
      }
    }

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `backfill-e2e-${workspaceId.slice(0, 8)}`,
        name: 'Backfill e2e',
        productName: 'Backfill e2e',
      } as never,
    });
    await prisma.agentProfile.create({
      data: { id: agentId, workspaceId, name: 'agent', persona: 'test', status: 'ACTIVE' },
    });
    // The backfill only answers on a channel that has an agent attached.
    await prisma.channel.create({
      data: { id: channelId, workspaceId, type: 'WEBCHAT', name: 'web', status: 'ACTIVE', agentProfileId: agentId },
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { workspaceId } });
    await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.contactIdentity.deleteMany({ where: { workspaceId } });
    await prisma.scheduledJob.deleteMany({ where: { workspaceId } });
    await prisma.leadActivity.deleteMany({ where: { lead: { workspaceId } } });
    await prisma.lead.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.agentProfile.deleteMany({ where: { workspaceId } });
    // By PAYLOAD: the marketing producers leave `tenantId` null.
    await prisma.outboxEvent.deleteMany({ where: { payload: { path: ['workspaceId'], equals: workspaceId } } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await closeTestApp(app);
  });

  it('enrolls a fresh customer message, even when the clock ticks mid-stamp', async () => {
    const restoreClock = installTickingClock();
    let conversationId: string;
    try {
      const res = await ingress.ingest(
        { id: channelId, workspaceId, type: 'WEBCHAT' },
        {
          externalUserId: `visitor-${workspaceId.slice(0, 8)}`,
          kind: 'WEBCHAT',
          externalMessageId: null,
          text: 'Fiyatlarınız nedir?',
        },
      );
      conversationId = res!.conversationId;
    } finally {
      restoreClock();
    }

    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(convo.lastInboundAt!.getTime()).toBe(convo.lastMessageAt!.getTime());

    // The sweep is platform-wide, so it is observed rather than let loose: what
    // matters here is whether the QUERY picks this thread up, not a job row for
    // every other workspace's conversation in the database.
    const schedule = jest.spyOn(scheduledJobs, 'schedule').mockResolvedValue('job-id');
    try {
      await backfill.sweep();
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: AI_REPLY_KIND, workspaceId, dedupKey: conversationId }),
      );
    } finally {
      schedule.mockRestore();
    }
  });
});
