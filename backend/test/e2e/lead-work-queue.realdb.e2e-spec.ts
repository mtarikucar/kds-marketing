import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MarketingLeadsService } from '../../src/modules/marketing/services/marketing-leads.service';
import { LeadBulkService } from '../../src/modules/marketing/inbox/lead-bulk.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The leads list's `waitingReply` filter — the "Bekleyen" work-queue chip on
 * the merged Kişiler tab — against REAL Postgres.
 *
 * Two reasons this cannot be a unit test.
 *
 * 1. The predicate is a COLUMN COMPARISON (`lastInboundAt >= lastMessageAt`),
 *    which Prisma's `where` cannot express, so it is raw SQL. A mocked Prisma
 *    returns whatever it was told and proves nothing about the comparison.
 *    DailyDigestService already carries the same predicate for the same reason
 *    and is pinned the same way (digest-waiting-replies.realdb).
 * 2. `conversations` has NO foreign key to `leads` — schema.prisma declares a
 *    bare `leadId String` with no relation — so the filter is a two-step
 *    (resolve waiting lead ids, then `id: { in: ids }`) rather than a nested
 *    `some`. The empty case of that `in` is the trap: `in: []` must select
 *    NOTHING, and a mock would happily "pass" an implementation that dropped
 *    the clause and returned the entire workspace instead.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Leads work queue — waitingReply filter, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let leads: MarketingLeadsService;
  let bulk: LeadBulkService;

  const SEED = `workqueue-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const channelId = randomUUID();
  const otherChannelId = randomUUID();
  const managerId = randomUUID();

  // Every lead below is named for the state it encodes, so a failure names the
  // rule that broke rather than a uuid.
  const waitingLead = randomUUID(); // customer wrote last, thread OPEN
  const waitingUnassignedLead = randomUUID(); // same, and nobody owns it
  const answeredLead = randomUUID(); // we replied AFTER they wrote
  const closedLead = randomUUID(); // customer wrote last but the thread is CLOSED
  const silentLead = randomUUID(); // no conversation at all — one of "the 363"
  const foreignWaitingLead = randomUUID(); // waiting, but next door

  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const ids = (res: { data: Array<{ id: string }> }) => res.data.map((l) => l.id).sort();

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    leads = app.get(MarketingLeadsService);
    bulk = app.get(LeadBulkService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Queue A', productName: 'Queue A' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Queue B', productName: 'Queue B' },
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

    const lead = (id: string, name: string, assigned: string | null, ws = workspaceId) => ({
      id,
      workspaceId: ws,
      businessName: `${SEED}-${name}`,
      contactPerson: name,
      businessType: 'CAFE',
      source: 'OTHER',
      assignedToId: assigned,
    });

    await prisma.lead.createMany({
      data: [
        lead(waitingLead, 'waiting', managerId),
        lead(waitingUnassignedLead, 'waiting-unassigned', null),
        lead(answeredLead, 'answered', managerId),
        lead(closedLead, 'closed', managerId),
        lead(silentLead, 'silent', managerId),
        lead(foreignWaitingLead, 'foreign-waiting', null, otherWorkspaceId),
      ],
    });

    await prisma.conversation.createMany({
      data: [
        // Customer wrote 5 minutes ago; our last message is older. Waiting.
        {
          id: randomUUID(), workspaceId, channelId, leadId: waitingLead,
          status: 'OPEN', lastMessageAt: t(60), lastInboundAt: t(5),
        },
        {
          id: randomUUID(), workspaceId, channelId, leadId: waitingUnassignedLead,
          status: 'OPEN', lastMessageAt: t(90), lastInboundAt: t(7),
        },
        // The boundary: we answered AFTER they wrote. Not waiting.
        {
          id: randomUUID(), workspaceId, channelId, leadId: answeredLead,
          status: 'OPEN', lastMessageAt: t(2), lastInboundAt: t(30),
        },
        // Customer wrote last, but the thread is CLOSED — nobody owes a reply.
        {
          id: randomUUID(), workspaceId, channelId, leadId: closedLead,
          status: 'CLOSED', lastMessageAt: t(120), lastInboundAt: t(10),
        },
        // Next door, and waiting. Only `workspaceId` keeps it out.
        {
          id: randomUUID(), workspaceId: otherWorkspaceId, channelId: otherChannelId,
          leadId: foreignWaitingLead, status: 'OPEN', lastMessageAt: t(60), lastInboundAt: t(5),
        },
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
      await del(() => prisma.conversation.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.lead.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.channel.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: scope } }));
    } finally {
      await closeTestApp(app);
    }
  });

  it('returns only leads whose OPEN thread is waiting on US', async () => {
    const res = await leads.findAll(workspaceId, { waitingReply: true }, managerId, 'MANAGER');

    expect(ids(res)).toEqual([waitingLead, waitingUnassignedLead].sort());
    // Each exclusion is a separate rule, so name each one:
    expect(ids(res)).not.toContain(answeredLead); // we replied after they wrote
    expect(ids(res)).not.toContain(closedLead); // the thread is closed
    expect(ids(res)).not.toContain(silentLead); // no conversation at all
    // `meta.total` drives the chip's count, so it has to narrow with the rows —
    // a filter applied to findMany but not to count would show "5" over 2 rows.
    expect(res.meta.total).toBe(2);
  });

  it('leaves the unfiltered list alone — the silent leads stay visible', async () => {
    // The whole reason the Kişiler tab exists: a conversation-first list hides
    // every lead that has never had a conversation.
    const all = await leads.findAll(workspaceId, {}, managerId, 'MANAGER');
    expect(ids(all)).toContain(silentLead);
    expect(all.meta.total).toBe(5);
  });

  it('never reaches across the tenant line', async () => {
    const mine = await leads.findAll(workspaceId, { waitingReply: true }, managerId, 'MANAGER');
    expect(ids(mine)).not.toContain(foreignWaitingLead);

    // And the neighbour sees its own, so the row really is there to be leaked.
    const theirs = await leads.findAll(
      otherWorkspaceId,
      { waitingReply: true },
      randomUUID(),
      'MANAGER',
    );
    expect(ids(theirs)).toEqual([foreignWaitingLead]);
  });

  it('selects NOTHING, not everything, when the workspace has nothing waiting', async () => {
    // The `in: []` trap. An implementation that drops the clause when the id
    // list comes back empty returns the whole workspace — and a mocked Prisma
    // cannot tell the two apart.
    const empty = randomUUID();
    await prisma.workspace.create({
      data: { id: empty, slug: `${SEED}-c`, name: 'Queue C', productName: 'Queue C' },
    });
    await prisma.lead.create({
      data: {
        id: randomUUID(), workspaceId: empty, businessName: `${SEED}-lonely`,
        contactPerson: 'Lonely', businessType: 'CAFE', source: 'OTHER',
      },
    });
    try {
      // Positive anchor: the workspace HAS a lead, so an empty waiting list
      // below is the filter working, not an empty workspace.
      expect((await leads.findAll(empty, {}, managerId, 'MANAGER')).meta.total).toBe(1);

      const res = await leads.findAll(empty, { waitingReply: true }, managerId, 'MANAGER');
      expect(res.data).toEqual([]);
      expect(res.meta.total).toBe(0);
    } finally {
      await prisma.lead.deleteMany({ where: { workspaceId: empty } });
      await prisma.workspace.deleteMany({ where: { id: empty } });
    }
  });

  it('composes with assignmentStatus instead of replacing it', async () => {
    const res = await leads.findAll(
      workspaceId,
      { waitingReply: true, assignmentStatus: 'unassigned' },
      managerId,
      'MANAGER',
    );
    expect(ids(res)).toEqual([waitingUnassignedLead]);
  });

  it('exports the SAME rows it lists', async () => {
    // The CSV button sits next to the chips. A filter honoured by the list and
    // dropped by the export is the exact bug lead-bulk.service's own comment
    // says was fixed once already ("the CSV didn't match the on-screen list").
    const csv = await bulk.exportCsv(workspaceId, { waitingReply: true }, managerId, 'MANAGER');

    expect(csv).toContain(`${SEED}-waiting`);
    expect(csv).toContain(`${SEED}-waiting-unassigned`);
    expect(csv).not.toContain(`${SEED}-answered`);
    expect(csv).not.toContain(`${SEED}-silent`);
    expect(csv).not.toContain(`${SEED}-foreign-waiting`);
  });
});
