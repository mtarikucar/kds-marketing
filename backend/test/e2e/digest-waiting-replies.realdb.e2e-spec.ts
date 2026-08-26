import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { DailyDigestService } from '../../src/modules/marketing/analytics/daily-digest.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * "N conversations waiting for a reply", against REAL Postgres.
 *
 * The test is a COLUMN COMPARISON — lastInboundAt >= lastMessageAt — which
 * Prisma's `where` cannot express, so it is raw SQL. A mocked Prisma returns
 * whatever the mock was told to return and proves nothing about whether the
 * comparison is right; the only thing that can is a database.
 *
 * The three states that matter are seeded explicitly, because the boundary is
 * where this would get it wrong: a thread answered AFTER the customer wrote
 * must not count, and one where the customer wrote back after our reply must.
 *
 * Opt-in via E2E_REAL_DB=1, like the other real-DB suites.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Digest waiting-reply count — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let digest: DailyDigestService;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const channelId = randomUUID();
  const agentChannelId = randomUUID();
  const agentId = randomUUID();
  const leadId = randomUUID();

  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    digest = app.get(DailyDigestService);

    // slug is @unique and productName is required — the digest reads the row
    // for the brief's title, so it has to exist.
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `digest-e2e-${workspaceId.slice(0, 8)}`,
        name: 'Digest e2e',
        productName: 'Digest e2e',
      } as never,
    });
    // Two ACTIVE channels that differ in exactly one thing: whether an agent
    // is attached. That single column is what decides whether the reply engine
    // can ever pick a thread up, and it is the difference the digest reports.
    await prisma.channel.create({
      data: { id: channelId, workspaceId, type: 'WEBCHAT', name: 'ch', status: 'ACTIVE' },
    });
    await prisma.agentProfile.create({
      data: { id: agentId, workspaceId, name: 'agent', persona: 'test', status: 'ACTIVE' },
    });
    await prisma.channel.create({
      data: {
        id: agentChannelId,
        workspaceId,
        type: 'WEBCHAT',
        name: 'ch-with-agent',
        status: 'ACTIVE',
        agentProfileId: agentId,
      },
    });
    await prisma.lead.create({
      data: {
        id: leadId,
        workspaceId,
        businessName: 'Acme',
        contactPerson: 'Test',
        businessType: 'CAFE',
        source: 'OTHER',
      },
    });

    const convo = (
      id: string,
      ws: string,
      status: string,
      lastInboundAt: Date | null,
      lastMessageAt: Date | null,
      ch: string = channelId,
    ) =>
      prisma.conversation.create({
        data: {
          id,
          workspaceId: ws,
          channelId: ch,
          leadId,
          status,
          lastInboundAt,
          lastMessageAt,
        },
      });

    // WAITING: customer wrote last.
    await convo(randomUUID(), workspaceId, 'OPEN', t(10), t(10));
    // WAITING: they wrote again after our reply.
    await convo(randomUUID(), workspaceId, 'OPEN', t(5), t(5));
    // ANSWERED: we replied after they wrote — the boundary that matters.
    await convo(randomUUID(), workspaceId, 'OPEN', t(30), t(2));
    // CLOSED: settled, not waiting on anyone.
    await convo(randomUUID(), workspaceId, 'CLOSED', t(10), t(10));
    // Never had an inbound message at all.
    await convo(randomUUID(), workspaceId, 'OPEN', null, t(10));
    // WAITING, but on the channel that HAS an agent — the AI can still take
    // this one, so it must not be counted as structurally unanswerable.
    await convo(randomUUID(), workspaceId, 'OPEN', t(8), t(8), agentChannelId);
  });

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.lead.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.agentProfile.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await closeTestApp(app);
  });

  it('counts only the OPEN threads whose last message came from the customer', async () => {
    const d = await digest.build(workspaceId);

    // Three: two on the agentless channel plus the one on the channel that has
    // an agent. Whether an agent is attached does not change who is waiting —
    // that distinction belongs to the separate line below, not to this count.
    expect(d!.needsYou.items.join(' | ')).toMatch(/3 konuşma yanıt bekliyor/);
  });

  it('does not count a thread we answered after they wrote', async () => {
    const d = await digest.build(workspaceId);

    // Four OPEN threads have an inbound; only three are still waiting, because
    // one of them we answered afterwards. Getting the comparison backwards
    // would report 4 here, and a mocked test could not tell the difference.
    expect(d!.needsYou.items.join(' | ')).not.toMatch(/4 konuşma yanıt bekliyor/);
  });

  /**
   * "Someone is waiting on a channel the AI structurally cannot answer."
   *
   * This is the other half of a month of silence on the live workspace. Every
   * customer conversation still open from June and July is on Instagram,
   * Messenger or WhatsApp, and none of those three has ever had an agent
   * attached — so the reply engine declined at that gate every time, correctly
   * and invisibly, while the inbox and the panel both looked normal.
   *
   * The query is a JOIN plus a column comparison, so a mocked Prisma proves
   * nothing about it; and the whole point is the BOUNDARY — a waiting thread on
   * a channel that does have an agent is not this problem, and counting it
   * would turn the line into noise that trains people to skip the section.
   */
  it('counts the channel with a waiting customer and no agent, and only that one', async () => {
    const d = await digest.build(workspaceId);

    // Two channels have waiting threads; only one of them has no agent.
    expect(d!.needsYou.items.join(' | ')).toMatch(/1 kanalda müşteri bekliyor/);
  });

  it('stops counting a channel once an agent is attached to it', async () => {
    await prisma.channel.update({
      where: { id: channelId },
      data: { agentProfileId: agentId },
    });

    const d = await digest.build(workspaceId);

    expect(d!.needsYou.items.join(' | ')).not.toMatch(/kanalda müşteri bekliyor/);

    await prisma.channel.update({ where: { id: channelId }, data: { agentProfileId: null } });
  });

  /**
   * A FAILED job exhausted every attempt — there is no reading of that which is
   * fine, which is why it reports unconditionally. On the live workspace these
   * rows carried the vendor's own 400 ("Your credit balance is too low") on
   * every AI reply for a day, in a column nothing read.
   */
  it('reports a background job that gave up, and windows it to the period', async () => {
    await prisma.scheduledJob.create({
      data: {
        workspaceId,
        kind: 'conversation.ai_reply',
        runAt: t(60),
        payload: {},
        status: 'FAILED',
        attempts: 5,
        lastError: '400 credit balance too low',
        completedAt: t(60),
      },
    });

    const fresh = await digest.build(workspaceId);
    expect(fresh!.needsYou.items.join(' | ')).toMatch(/1 arka plan işi/);

    // Aged out of the window: a problem that is over stops being reported.
    await prisma.scheduledJob.updateMany({
      where: { workspaceId },
      data: { completedAt: new Date(Date.now() - 5 * 24 * 3600_000) },
    });
    const later = await digest.build(workspaceId);
    expect(later!.needsYou.items.join(' | ')).not.toMatch(/arka plan işi/);

    await prisma.scheduledJob.deleteMany({ where: { workspaceId } });
  });
});
