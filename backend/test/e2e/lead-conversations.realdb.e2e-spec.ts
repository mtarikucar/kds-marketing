import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ConversationsService } from '../../src/modules/marketing/channels/conversations.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * `ConversationsService.list`'s filters against REAL Postgres.
 *
 * The unit spec beside the service hands `findMany` a mock, and a mock accepts
 * ANY `where` you give it — so it proves the argument we passed and nothing
 * about whether Postgres will execute it. That gap is not theoretical:
 * `ChannelTariffService.resolve()` shipped `workspaceId: { in: [id, null] }`,
 * a shape Prisma refuses, and threw on every call for eight weeks behind a
 * fully green suite. The symptom read as "no vendor spend was ever recorded",
 * not as an error.
 *
 * The new `leadId` clause is the lead detail page's whole feed, and it sits in
 * the same `where` as the tenant line. So this pins the two things only real
 * SQL can settle: the lead filter actually narrows (the workspace's OTHER lead
 * is excluded), and neither filter state ever reaches across the tenant line —
 * including the case where the caller asks for a lead that belongs to somebody
 * else, where `workspaceId` is the only thing standing between them.
 *
 * Fixtures sit ALONGSIDE whatever the migrations seeded rather than on an empty
 * table, because that is the only state production is ever in; assertions read
 * our own conversation ids rather than counting rows.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Conversation list — leadId filter, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let svc: ConversationsService;

  const SEED = `leadconv-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const channelId = randomUUID();
  const otherChannelId = randomUUID();

  // Two leads in OUR workspace. One conversation each would be enough to prove
  // exclusion, but `leadOne` gets two so a filter that silently collapsed to
  // "one row per lead" could not pass either.
  const leadOne = randomUUID();
  const leadTwo = randomUUID();
  const foreignLead = randomUUID();

  const convoOneA = randomUUID();
  const convoOneB = randomUUID();
  const convoTwo = randomUUID();
  const convoForeign = randomUUID();

  const ids = (list: unknown[]) => (list as Array<{ id: string }>).map((c) => c.id).sort();

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    svc = app.get(ConversationsService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Inbox A', productName: 'Inbox A' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Inbox B', productName: 'Inbox B' },
      ],
    });

    await prisma.channel.createMany({
      data: [
        { id: channelId, workspaceId, type: 'WEBCHAT', name: `${SEED}-ch-a`, status: 'ACTIVE' },
        {
          id: otherChannelId,
          workspaceId: otherWorkspaceId,
          type: 'WEBCHAT',
          name: `${SEED}-ch-b`,
          status: 'ACTIVE',
        },
      ],
    });

    // Conversation.leadId is NOT NULL, so every thread needs a real lead.
    await prisma.lead.createMany({
      data: [
        { id: leadOne, workspaceId, businessName: `${SEED}-lead-one`, contactPerson: 'Leyla', businessType: 'CAFE', source: 'OTHER' },
        { id: leadTwo, workspaceId, businessName: `${SEED}-lead-two`, contactPerson: 'Levent', businessType: 'CAFE', source: 'OTHER' },
        { id: foreignLead, workspaceId: otherWorkspaceId, businessName: `${SEED}-lead-foreign`, contactPerson: 'Yabanci', businessType: 'CAFE', source: 'OTHER' },
      ],
    });

    await prisma.conversation.createMany({
      data: [
        { id: convoOneA, workspaceId, channelId, leadId: leadOne, status: 'OPEN', lastMessageAt: new Date() },
        { id: convoOneB, workspaceId, channelId, leadId: leadOne, status: 'OPEN', lastMessageAt: new Date() },
        // Same workspace, same channel, same status — only the lead differs, so
        // only the leadId clause can be what excludes it.
        { id: convoTwo, workspaceId, channelId, leadId: leadTwo, status: 'OPEN', lastMessageAt: new Date() },
        {
          id: convoForeign,
          workspaceId: otherWorkspaceId,
          channelId: otherChannelId,
          leadId: foreignLead,
          status: 'OPEN',
          lastMessageAt: new Date(),
        },
      ],
    });

    // One message per thread, so `enrich()`'s DISTINCT ON runs for real too — a
    // list() that returned the right rows but threw in enrichment still fails.
    await prisma.message.createMany({
      data: [
        { workspaceId, conversationId: convoOneA, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'one-a', status: 'RECEIVED' },
        { workspaceId, conversationId: convoOneB, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'one-b', status: 'RECEIVED' },
        { workspaceId, conversationId: convoTwo, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'two', status: 'RECEIVED' },
        { workspaceId: otherWorkspaceId, conversationId: convoForeign, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'foreign', status: 'RECEIVED' },
      ],
    });
  });

  afterAll(async () => {
    if (!realDbEnabled() || !prisma) return;
    // FK-safe order: messages, then conversations, then the leads/channels they
    // name, then the workspaces.
    //
    // Tolerance here buys "teardown never throws", NOT "no rows leak". What
    // keeps a stranded run harmless is that every id — and the slug prefix — is
    // freshly minted, so leftovers can never collide with a later run.
    const scope = { in: [workspaceId, otherWorkspaceId] };
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    try {
      await del(() => prisma.message.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.conversation.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.lead.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.channel.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: scope } }));
    } finally {
      await closeTestApp(app);
    }
  });

  it('narrows to one lead, excluding the other lead in the same workspace', async () => {
    const mine = await svc.list(workspaceId, { leadId: leadOne });

    expect(ids(mine)).toEqual([convoOneA, convoOneB].sort());
    // The exclusion is the point: convoTwo is identical but for its lead.
    expect(ids(mine)).not.toContain(convoTwo);

    // And the other side of the line, so this is a filter rather than a
    // hard-coded exclusion of one id.
    expect(ids(await svc.list(workspaceId, { leadId: leadTwo }))).toEqual([convoTwo]);

    // The enriched shape survives real SQL: each row carries its own lead.
    expect((mine as any[]).map((c) => c.lead?.id)).toEqual([leadOne, leadOne]);
  });

  it('never returns another workspace conversation, filtered or not', async () => {
    // Unfiltered.
    expect(ids(await svc.list(workspaceId))).not.toContain(convoForeign);

    // Asking BY the neighbour's lead id: the row matches `leadId` exactly, so
    // `workspaceId` is the only clause that can keep it out. Drop the tenant
    // line and this is the assertion that breaks.
    expect(await svc.list(workspaceId, { leadId: foreignLead })).toEqual([]);

    // The neighbour sees its own, so the row really is there to be leaked.
    expect(ids(await svc.list(otherWorkspaceId, { leadId: foreignLead }))).toEqual([convoForeign]);
  });

  it('returns the whole workspace when no lead is given', async () => {
    const all = await svc.list(workspaceId);

    // Both leads' threads, and nothing from next door. The workspace id is
    // freshly minted, so "the whole workspace" is exactly these three.
    expect(ids(all)).toEqual([convoOneA, convoOneB, convoTwo].sort());
  });
});
