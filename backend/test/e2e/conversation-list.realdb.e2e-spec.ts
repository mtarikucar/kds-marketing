import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ConversationsService } from '../../src/modules/marketing/channels/conversations.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The inbox list snippet, against REAL Postgres.
 *
 * `enrich()` used to fetch every message of every listed conversation
 * (`conversationId IN (...)`, no take), sort desc, and keep the first per
 * conversation in JS. The list caps at 100 conversations and a thread may hold
 * 500 messages, so rendering 100 snippets could pull 50,000 rows and discard
 * 49,900 — growing with conversation LENGTH, the thing that grows once the
 * inbox is actually used.
 *
 * Prisma has no per-group limit, so the fix is a DISTINCT ON. That is
 * hand-written SQL, which a mocked Prisma cannot execute: a wrong column or
 * table name would only surface in production, on the screen that renders the
 * user's inbox. Hence a real-DB test — the mocked suite structurally cannot
 * cover this one.
 *
 * Opt-in via E2E_REAL_DB=1, like the lead-lifecycle suite.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Conversation list snippet — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const channelId = randomUUID();
  const otherChannelId = randomUUID();
  const leadId = randomUUID();
  const otherLeadId = randomUUID();
  const convoA = randomUUID();
  const convoB = randomUUID();
  const convoOther = randomUUID();

  beforeAll(async () => {
    ({ app, prisma } = await createRealDbTestApp());
    conversations = app.get(ConversationsService);

    for (const [ws, ch] of [
      [workspaceId, channelId],
      [otherWorkspaceId, otherChannelId],
    ]) {
      await prisma.channel.create({
        data: { id: ch, workspaceId: ws, type: 'WEBCHAT', name: `ch-${ch.slice(0, 6)}`, status: 'ACTIVE' },
      });
    }

    // Conversation.leadId is NOT NULL, so every thread needs a real lead.
    for (const [id, ws] of [
      [leadId, workspaceId],
      [otherLeadId, otherWorkspaceId],
    ]) {
      await prisma.lead.create({
        data: {
          id,
          workspaceId: ws,
          businessName: `biz-${id.slice(0, 6)}`,
          contactPerson: 'Test',
          businessType: 'CAFE',
          source: 'OTHER',
        },
      });
    }

    const convo = (id: string, ws: string, ch: string, lead: string) =>
      prisma.conversation.create({
        data: { id, workspaceId: ws, channelId: ch, leadId: lead, status: 'OPEN', lastMessageAt: new Date() },
      });
    await convo(convoA, workspaceId, channelId, leadId);
    await convo(convoB, workspaceId, channelId, leadId);
    await convo(convoOther, otherWorkspaceId, otherChannelId, otherLeadId);

    const msg = (conversationId: string, ws: string, body: string, minutesAgo: number) =>
      prisma.message.create({
        data: {
          workspaceId: ws,
          conversationId,
          direction: 'INBOUND',
          authorType: 'CUSTOMER',
          body,
          status: 'RECEIVED',
          createdAt: new Date(Date.now() - minutesAgo * 60_000),
        },
      });

    // Deliberately inserted out of order, so passing cannot depend on insertion
    // order standing in for the ORDER BY.
    await msg(convoA, workspaceId, 'a-oldest', 30);
    await msg(convoA, workspaceId, 'a-newest', 1);
    await msg(convoA, workspaceId, 'a-middle', 10);
    await msg(convoB, workspaceId, 'b-newest', 2);
    await msg(convoB, workspaceId, 'b-oldest', 20);
    await msg(convoOther, otherWorkspaceId, 'other-newest', 1);
  });

  afterAll(async () => {
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await prisma.message.deleteMany({ where: { workspaceId: ws } });
      await prisma.conversation.deleteMany({ where: { workspaceId: ws } });
      await prisma.lead.deleteMany({ where: { workspaceId: ws } });
      await prisma.channel.deleteMany({ where: { workspaceId: ws } });
    }
    await closeTestApp(app);
  });

  it('gives each conversation its own LATEST message', async () => {
    const list = await conversations.list(workspaceId);

    const byId = new Map(list.map((c: any) => [c.id, c.lastMessage?.body]));
    expect(byId.get(convoA)).toBe('a-newest');
    expect(byId.get(convoB)).toBe('b-newest');
  });

  it('returns exactly one snippet per conversation, never a list of them', async () => {
    const list = await conversations.list(workspaceId);

    // The old shape kept the first of MANY fetched rows; this asserts the query
    // itself collapses to one per conversation.
    for (const c of list as any[]) {
      expect(Array.isArray(c.lastMessage)).toBe(false);
    }
    expect(list.length).toBe(2);
  });

  it('does not reach into another workspace', async () => {
    const list = await conversations.list(workspaceId);

    const bodies = (list as any[]).map((c) => c.lastMessage?.body);
    expect(bodies).not.toContain('other-newest');
  });
});
