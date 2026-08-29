import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MarketingLeadsService } from '../../src/modules/marketing/services/marketing-leads.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The person list's conversation fields — `lastMessageAt`,
 * `lastMessagePreview`, `unreadCount`, `lastActivityAt` — and the
 * `lastActivityAt` sort, against REAL Postgres.
 *
 * Why this cannot be a unit test, in three parts.
 *
 * 1. `conversations` has NO foreign key to `leads` (schema.prisma declares a
 *    bare `leadId String`), so the enrichment is raw SQL — a DISTINCT ON for
 *    the newest message per person and a GROUP BY for the unread sum. A mocked
 *    Prisma returns whatever it was told and proves nothing about either.
 * 2. Because there is no foreign key, a conversation row in ANOTHER workspace
 *    is free to name one of OUR lead ids. `spoofedLead` below is exactly that
 *    row. Only the `workspaceId` predicate inside the raw SQL keeps the
 *    neighbour's message off our person's row — and a mock would accept a
 *    query with that predicate deleted.
 * 3. `lastActivityAt` is not a column. It is the newest of three things
 *    (last message, newest LeadActivity, the lead's own createdAt) and the
 *    sort has to hold across the whole filtered set before the page is cut.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Leads list — conversation enrichment + lastActivityAt sort, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let leads: MarketingLeadsService;

  const SEED = `leadenrich-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const channelId = randomUUID();
  const otherChannelId = randomUUID();
  const managerId = randomUUID();

  // Named for the state each encodes, so a failure names the rule that broke.
  const chattyLead = randomUUID(); // two threads, real messages, real unread
  const activityLead = randomUUID(); // no thread; a NOTE is its newest event
  const silentLead = randomUUID(); // nothing at all — one of "the 363"
  const spoofedLead = randomUUID(); // OUR lead, named by a NEIGHBOUR's thread
  const foreignLead = randomUUID(); // next door's own lead

  const convoA = randomUUID();
  const convoB = randomUUID();
  const convoSpoof = randomUUID(); // lives in otherWorkspace, points at spoofedLead
  const convoForeign = randomUUID();

  // Frozen at module load: every fixture instant AND every assertion is
  // derived from the same base, so an assertion cannot drift by the
  // milliseconds the suite itself takes to run.
  const BASE = Date.now();
  const t = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);

  // 200 characters, so the preview has to cut it and say so.
  const LONG_BODY = `${'sipariş '.repeat(24)}son`;

  const row = (res: { data: Array<{ id: string }> }, id: string) =>
    res.data.find((l) => l.id === id) as any;
  const order = (res: { data: Array<{ id: string }> }) => res.data.map((l) => l.id);

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    leads = app.get(MarketingLeadsService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Enrich A', productName: 'Enrich A' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Enrich B', productName: 'Enrich B' },
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

    await prisma.marketingUser.create({
      data: {
        id: managerId,
        workspaceId,
        email: `${SEED}@example.test`,
        password: 'x',
        firstName: 'Mana',
        lastName: 'Ger',
        role: 'MANAGER',
      },
    });

    const lead = (id: string, name: string, createdAt: Date, ws = workspaceId) => ({
      id,
      workspaceId: ws,
      businessName: `${SEED}-${name}`,
      contactPerson: name,
      businessType: 'CAFE',
      source: 'OTHER',
      createdAt,
    });

    await prisma.lead.createMany({
      data: [
        // createdAt is OLD for the two loud leads on purpose: if the sort fell
        // back to createdAt they would land last, not first.
        lead(chattyLead, 'chatty', t(1000)),
        lead(activityLead, 'activity', t(1000)),
        lead(silentLead, 'silent', t(10)),
        lead(spoofedLead, 'spoofed', t(30)),
        lead(foreignLead, 'foreign', t(1), otherWorkspaceId),
      ],
    });

    await prisma.conversation.createMany({
      data: [
        { id: convoA, workspaceId, channelId, leadId: chattyLead, status: 'OPEN', unreadCount: 3, lastMessageAt: t(2) },
        { id: convoB, workspaceId, channelId, leadId: chattyLead, status: 'OPEN', unreadCount: 4, lastMessageAt: t(50) },
        // The probe: a NEIGHBOUR's thread naming OUR lead id. No foreign key
        // stops this row from existing, so only `workspaceId` in the
        // enrichment SQL stops it from being read.
        {
          id: convoSpoof,
          workspaceId: otherWorkspaceId,
          channelId: otherChannelId,
          leadId: spoofedLead,
          status: 'OPEN',
          unreadCount: 9,
          lastMessageAt: t(1),
        },
        {
          id: convoForeign,
          workspaceId: otherWorkspaceId,
          channelId: otherChannelId,
          leadId: foreignLead,
          status: 'OPEN',
          unreadCount: 5,
          lastMessageAt: t(1),
        },
      ],
    });

    await prisma.message.createMany({
      data: [
        // Older thread, older message — must NOT win the preview.
        { workspaceId, conversationId: convoB, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'eski mesaj', status: 'RECEIVED', createdAt: t(50) },
        { workspaceId, conversationId: convoA, direction: 'OUTBOUND', authorType: 'AGENT', body: 'orta mesaj', status: 'SENT', createdAt: t(20) },
        // Newest across BOTH threads — this is the preview, and t(2) is the
        // lead's lastActivityAt.
        { workspaceId, conversationId: convoA, direction: 'INBOUND', authorType: 'CUSTOMER', body: LONG_BODY, status: 'RECEIVED', createdAt: t(2) },
        // Next door's message on OUR lead id. Never ours.
        { workspaceId: otherWorkspaceId, conversationId: convoSpoof, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'KOMSUNUN MESAJI', status: 'RECEIVED', createdAt: t(1) },
        { workspaceId: otherWorkspaceId, conversationId: convoForeign, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'yabanci', status: 'RECEIVED', createdAt: t(1) },
      ],
    });

    await prisma.leadActivity.createMany({
      data: [
        // activityLead's only event, and newer than its createdAt.
        { leadId: activityLead, createdById: managerId, type: 'NOTE', title: 'Not', createdAt: t(5) },
        // chattyLead has an activity too, but an OLD one: the message must win.
        { leadId: chattyLead, createdById: managerId, type: 'STATUS_CHANGE', title: 'Durum', createdAt: t(900) },
      ],
    });
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    const scope = { in: [workspaceId, otherWorkspaceId] };
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    try {
      if (!prisma) return;
      await del(() =>
        prisma.leadActivity.deleteMany({
          where: { leadId: { in: [chattyLead, activityLead, silentLead, spoofedLead, foreignLead] } },
        }),
      );
      await del(() => prisma.message.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.conversation.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.lead.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.channel.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: scope } }));
    } finally {
      await closeTestApp(app);
    }
  });

  it('carries the newest message, its preview and the unread sum onto the person row', async () => {
    const res = await leads.findAll(workspaceId, {}, managerId, 'MANAGER');
    const chatty = row(res, chattyLead);

    expect(chatty.lastMessageAt).toBeInstanceOf(Date);
    expect(chatty.lastMessageAt.getTime()).toBe(t(2).getTime());
    // The newest message across BOTH threads, not the newest of one of them.
    expect(chatty.lastMessagePreview.startsWith('sipariş sipariş')).toBe(true);
    expect(chatty.lastMessagePreview).not.toContain('eski mesaj');
    // Truncated, and it SAYS it was truncated rather than silently ending.
    expect(chatty.lastMessagePreview.endsWith('…')).toBe(true);
    expect(chatty.lastMessagePreview.length).toBeLessThanOrEqual(161);
    // Summed ACROSS the person's threads (3 + 4), not taken from one of them.
    expect(chatty.unreadCount).toBe(7);
  });

  it('gives a silent person nulls and a zero — never a missing field', async () => {
    const res = await leads.findAll(workspaceId, {}, managerId, 'MANAGER');
    const silent = row(res, silentLead);

    expect(silent.lastMessageAt).toBeNull();
    expect(silent.lastMessagePreview).toBeNull();
    expect(silent.unreadCount).toBe(0);
    // Non-null always: a person with no history is as old as their record.
    expect(silent.lastActivityAt.getTime()).toBe(t(10).getTime());
  });

  it('takes lastActivityAt from whichever source is newest', async () => {
    const res = await leads.findAll(workspaceId, {}, managerId, 'MANAGER');

    // Message (t2) beats this lead's own activity (t900) and createdAt (t1000).
    expect(row(res, chattyLead).lastActivityAt.getTime()).toBe(t(2).getTime());
    // Activity (t5) beats createdAt (t1000) with no message in sight.
    expect(row(res, activityLead).lastActivityAt.getTime()).toBe(t(5).getTime());
  });

  it('sorts by lastActivityAt across the whole set, loud first and silent last', async () => {
    const res = await leads.findAll(
      workspaceId,
      { sortBy: 'lastActivityAt', sortOrder: 'desc' },
      managerId,
      'MANAGER',
    );

    // chatty t2 · activity t5 · silent t10 · spoofed t30 (its own createdAt).
    expect(order(res)).toEqual([chattyLead, activityLead, silentLead, spoofedLead]);
    expect(res.meta.total).toBe(4);

    const asc = await leads.findAll(
      workspaceId,
      { sortBy: 'lastActivityAt', sortOrder: 'asc' },
      managerId,
      'MANAGER',
    );
    expect(order(asc)).toEqual([spoofedLead, silentLead, activityLead, chattyLead]);
  });

  it('pages the lastActivityAt sort without re-sorting the page', async () => {
    const p1 = await leads.findAll(
      workspaceId,
      { sortBy: 'lastActivityAt', sortOrder: 'desc', page: 1, limit: 2 },
      managerId,
      'MANAGER',
    );
    const p2 = await leads.findAll(
      workspaceId,
      { sortBy: 'lastActivityAt', sortOrder: 'desc', page: 2, limit: 2 },
      managerId,
      'MANAGER',
    );

    expect(order(p1)).toEqual([chattyLead, activityLead]);
    expect(order(p2)).toEqual([silentLead, spoofedLead]);
    expect(p1.meta.total).toBe(4);
    expect(p1.meta.totalPages).toBe(2);
  });

  it('selects NOTHING, not everything, when the page falls past the end', async () => {
    // The `in: []` trap, on the branch that reads the page BY id list. An
    // implementation that drops the clause when the slice comes back empty
    // returns the whole workspace under a page number that says otherwise.
    const res = await leads.findAll(
      workspaceId,
      { sortBy: 'lastActivityAt', page: 99, limit: 20 },
      managerId,
      'MANAGER',
    );

    expect(res.data).toEqual([]);
    // Positive anchor: the workspace is NOT empty, so [] above is the paging
    // working rather than an empty workspace.
    expect(res.meta.total).toBe(4);
  });

  it('never reads a neighbour thread that names one of our people', async () => {
    // convoSpoof is a real row in otherWorkspace whose `leadId` is OUR
    // spoofedLead — legal, because conversations carry no foreign key. Drop
    // `workspaceId` from the enrichment and this person shows the neighbour's
    // message, their unread count, and jumps to the top of the sort.
    const res = await leads.findAll(workspaceId, {}, managerId, 'MANAGER');
    const spoofed = row(res, spoofedLead);

    expect(spoofed.lastMessageAt).toBeNull();
    expect(spoofed.lastMessagePreview).toBeNull();
    expect(spoofed.unreadCount).toBe(0);
    expect(spoofed.lastActivityAt.getTime()).toBe(t(30).getTime());

    // And nothing from next door is in the list at all.
    expect(order(res)).not.toContain(foreignLead);

    // The neighbour sees its own enriched row, so the data really is there to
    // be leaked.
    const theirs = await leads.findAll(otherWorkspaceId, {}, randomUUID(), 'MANAGER');
    expect(row(theirs, foreignLead).lastMessagePreview).toBe('yabanci');
    expect(row(theirs, foreignLead).unreadCount).toBe(5);
  });

  it('does not leak the helper rows the enrichment reads', async () => {
    // The newest-activity timestamp is fetched through a nested `activities`
    // take-1, which must not reach the wire as a half-populated relation the
    // list never had before.
    const res = await leads.findAll(workspaceId, {}, managerId, 'MANAGER');
    expect(Object.prototype.hasOwnProperty.call(row(res, chattyLead), 'activities')).toBe(false);
    // The counts the list already shipped are untouched.
    expect(row(res, chattyLead)._count.activities).toBe(1);
  });
});
