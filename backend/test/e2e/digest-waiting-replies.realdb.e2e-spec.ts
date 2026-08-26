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
  const leadId = randomUUID();

  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    digest = app.get(DailyDigestService);

    await prisma.workspace.create({
      data: { id: workspaceId, name: 'Digest e2e', status: 'ACTIVE' } as never,
    });
    await prisma.channel.create({
      data: { id: channelId, workspaceId, type: 'WEBCHAT', name: 'ch', status: 'ACTIVE' },
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
    ) =>
      prisma.conversation.create({
        data: { id, workspaceId: ws, channelId, leadId, status, lastInboundAt, lastMessageAt },
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
  });

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.lead.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await closeTestApp(app);
  });

  it('counts only the OPEN threads whose last message came from the customer', async () => {
    const d = await digest.build(workspaceId);

    expect(d!.needsYou.items.join(' | ')).toMatch(/2 konuşma yanıt bekliyor/);
  });

  it('does not count a thread we answered after they wrote', async () => {
    const d = await digest.build(workspaceId);

    // Three OPEN threads have an inbound; only two are still waiting. Getting
    // the comparison backwards would report 3 here, and a mocked test could not
    // tell the difference.
    expect(d!.needsYou.items.join(' | ')).not.toMatch(/3 konuşma yanıt bekliyor/);
  });
});
