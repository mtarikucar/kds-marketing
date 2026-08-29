import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LeadStreamService, CAP } from '../../src/modules/marketing/services/lead-stream.service';
import { EntitlementsService } from '../../src/modules/billing/entitlements.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The person's ONE stream — messages and lead activities on a single time
 * axis — against REAL Postgres.
 *
 * Three things only real SQL can settle here.
 *
 * 1. The two sources live in unrelated tables joined by nothing: `messages`
 *    hangs off `conversations`, which carries a bare `leadId String` with NO
 *    foreign key to `leads`, while `lead_activities` has a real key to `leads`
 *    and no `workspaceId` column of its own. Every tenant predicate in this
 *    service is therefore hand-written, and a mocked Prisma accepts any `where`
 *    it is handed — `ChannelTariffService.resolve()` shipped an impossible one
 *    and threw for eight weeks behind a green suite.
 * 2. Because conversations carry no foreign key, a NEIGHBOUR's thread is free
 *    to name one of our lead ids. `spoofConvo` below is exactly that row.
 * 3. The `conversationAi` gate is read from a real subscription. A workspace
 *    with no plan must still get its activities — the design says the person
 *    list and the activity history survive without the conversation column —
 *    and must be TOLD the messages were withheld rather than shown silence.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Lead stream — messages + activities on one axis, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let svc: LeadStreamService;

  const SEED = `leadstream-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID(); // has conversationAi
  const otherWorkspaceId = randomUUID(); // no subscription at all
  const packageId = randomUUID();
  const channelId = randomUUID();
  const otherChannelId = randomUUID();
  const managerId = randomUUID();
  const agentId = randomUUID();
  const otherRepId = randomUUID();

  const richLead = randomUUID(); // messages AND activities
  const quietLead = randomUUID(); // activities only, no thread at all
  const floodLead = randomUUID(); // more activities than the cap
  const foreignLead = randomUUID(); // next door's own person

  const convo = randomUUID();
  const spoofConvo = randomUUID(); // in otherWorkspace, points at richLead
  const foreignConvo = randomUUID();

  // Frozen at load so an assertion cannot drift by the suite's own runtime.
  const BASE = Date.now();
  const t = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);
  const iso = (minutesAgo: number) => t(minutesAgo).toISOString();

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    svc = app.get(LeadStreamService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Stream A', productName: 'Stream A' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Stream B', productName: 'Stream B' },
      ],
    });

    // A real plan carrying the real gate, so the entitlement is read rather
    // than assumed. otherWorkspace deliberately gets NO subscription.
    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Stream Plan',
        dailyLeadQuota: -1,
        maxUsers: 10,
        maxResearchProfiles: 1,
        features: { conversationAi: true },
        priceMonthlyTRY: 1,
        priceMonthlyUSD: 1,
      },
    });
    await prisma.workspaceSubscription.create({
      data: {
        workspaceId,
        packageId,
        status: 'ACTIVE',
        currency: 'TRY',
        currentPeriodStart: t(60 * 24),
        currentPeriodEnd: new Date(BASE + 30 * 24 * 60 * 60_000),
      },
    });

    await prisma.channel.createMany({
      data: [
        { id: channelId, workspaceId, type: 'WHATSAPP', name: `${SEED}-ch-a`, status: 'ACTIVE' },
        {
          id: otherChannelId,
          workspaceId: otherWorkspaceId,
          type: 'WEBCHAT',
          name: `${SEED}-ch-b`,
          status: 'ACTIVE',
        },
      ],
    });

    await prisma.marketingUser.createMany({
      data: [
        { id: managerId, workspaceId, email: `${SEED}-m@example.test`, password: 'x', firstName: 'Mana', lastName: 'Ger', role: 'MANAGER' },
        { id: agentId, workspaceId, email: `${SEED}-a@example.test`, password: 'x', firstName: 'Ayse', lastName: 'Temsilci', role: 'REP' },
        { id: otherRepId, workspaceId, email: `${SEED}-r@example.test`, password: 'x', firstName: 'Baska', lastName: 'Temsilci', role: 'REP' },
      ],
    });

    const lead = (id: string, name: string, ws = workspaceId, assigned: string | null = agentId) => ({
      id,
      workspaceId: ws,
      businessName: `${SEED}-${name}`,
      contactPerson: name,
      businessType: 'CAFE',
      source: 'OTHER',
      assignedToId: assigned,
      createdAt: t(5000),
    });

    await prisma.lead.createMany({
      data: [
        lead(richLead, 'rich'),
        lead(quietLead, 'quiet'),
        lead(floodLead, 'flood'),
        lead(foreignLead, 'foreign', otherWorkspaceId, null),
      ],
    });

    await prisma.conversation.createMany({
      data: [
        { id: convo, workspaceId, channelId, leadId: richLead, status: 'OPEN', lastMessageAt: t(10) },
        // The probe: a NEIGHBOUR's thread naming OUR person. Legal — there is
        // no foreign key — so only `workspaceId` keeps its messages out.
        {
          id: spoofConvo, workspaceId: otherWorkspaceId, channelId: otherChannelId,
          leadId: richLead, status: 'OPEN', lastMessageAt: t(1),
        },
        {
          id: foreignConvo, workspaceId: otherWorkspaceId, channelId: otherChannelId,
          leadId: foreignLead, status: 'OPEN', lastMessageAt: t(1),
        },
      ],
    });

    await prisma.message.createMany({
      data: [
        { workspaceId, conversationId: convo, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'Merhaba, fiyat?', status: 'RECEIVED', createdAt: t(40) },
        { workspaceId, conversationId: convo, direction: 'OUTBOUND', authorType: 'AGENT', authorId: agentId, body: 'Merhaba, hemen donuyorum', status: 'DELIVERED', createdAt: t(30) },
        { workspaceId, conversationId: convo, direction: 'OUTBOUND', authorType: 'AI', body: 'Otomatik yanit', status: 'FAILED', error: 'provider down', createdAt: t(10) },
        // Never ours. Three rows, because there are three different ways in
        // and each one is stopped by a DIFFERENT predicate — a fixture that
        // only carries the first would let two of the three be deleted with
        // the suite still green.
        //
        // (a) neighbour's thread, neighbour's message: stopped by either the
        //     conversation scope or the message scope.
        { workspaceId: otherWorkspaceId, conversationId: spoofConvo, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'KOMSUNUN MESAJI', status: 'RECEIVED', createdAt: t(1) },
        // (b) neighbour's thread, but a message stamped with OUR workspace.
        //     `messages` has no foreign key to `conversations` either (a bare
        //     `conversationId String`), so this row is as legal as (a). ONLY
        //     the `workspaceId` on the CONVERSATION read keeps it out.
        { workspaceId, conversationId: spoofConvo, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'CAPRAZ MESAJ BIZIM WS', status: 'RECEIVED', createdAt: t(3) },
        // (c) OUR thread, but a message stamped with the neighbour's
        //     workspace. ONLY the `workspaceId` on the MESSAGE read keeps it
        //     out — the conversation scope has already let this thread in.
        { workspaceId: otherWorkspaceId, conversationId: convo, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'CAPRAZ MESAJ KOMSU WS', status: 'RECEIVED', createdAt: t(4) },
        { workspaceId: otherWorkspaceId, conversationId: foreignConvo, direction: 'INBOUND', authorType: 'CUSTOMER', body: 'yabanci mesaj', status: 'RECEIVED', createdAt: t(2) },
      ],
    });

    await prisma.leadActivity.createMany({
      data: [
        { leadId: richLead, createdById: agentId, type: 'CALL', title: 'Sales call: ANSWERED', description: 'Fiyat konusuldu', outcome: 'POSITIVE', duration: 12, createdAt: t(35) },
        { leadId: richLead, createdById: managerId, type: 'NOTE', title: 'Not', description: 'Tekrar aranacak', createdAt: t(20) },
        { leadId: richLead, createdById: managerId, type: 'STATUS_CHANGE', title: 'NEW → CONTACTED', createdAt: t(5) },
        { leadId: quietLead, createdById: managerId, type: 'NOTE', title: 'Sessiz not', createdAt: t(15) },
        { leadId: foreignLead, createdById: managerId, type: 'NOTE', title: 'Yabanci not', createdAt: t(15) },
      ],
    });

    // One more than the cap, so truncation is reported rather than implied.
    await prisma.leadActivity.createMany({
      data: Array.from({ length: CAP + 1 }, (_, i) => ({
        leadId: floodLead,
        createdById: managerId,
        type: 'NOTE',
        title: `sel-${i}`,
        createdAt: t(1000 - i),
      })),
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
          where: { leadId: { in: [richLead, quietLead, floodLead, foreignLead] } },
        }),
      );
      await del(() => prisma.message.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.conversation.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.lead.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.channel.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.workspaceSubscription.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.package.deleteMany({ where: { id: packageId } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: scope } }));
    } finally {
      await closeTestApp(app);
    }
  });

  it('merges messages and activities onto ONE ascending time axis', async () => {
    const res = await svc.forLead(workspaceId, richLead, managerId, 'MANAGER');

    expect(res.items.map((i) => [i.kind, i.at])).toEqual([
      ['message', iso(40)],
      ['call', iso(35)],
      ['message', iso(30)],
      ['note', iso(20)],
      ['message', iso(10)],
      ['status', iso(5)],
    ]);
    // Nothing lost, nothing withheld.
    expect(res.unread).toEqual([]);
    expect(res.truncated).toEqual([]);
    expect(res.gated).toEqual([]);
    expect(res.leadId).toBe(richLead);
  });

  it('carries what each kind needs to render, and nothing it does not', async () => {
    const res = await svc.forLead(workspaceId, richLead, managerId, 'MANAGER');
    const byAt = (minutesAgo: number) => res.items.find((i) => i.at === iso(minutesAgo))!;

    const inbound = byAt(40);
    expect(inbound.kind).toBe('message');
    expect(inbound.direction).toBe('INBOUND');
    expect(inbound.authorType).toBe('CUSTOMER');
    expect(inbound.authorName).toBeNull();
    expect(inbound.body).toBe('Merhaba, fiyat?');
    expect(inbound.channelType).toBe('WHATSAPP');
    expect(inbound.conversationId).toBe(convo);
    expect(inbound.deliveryStatus).toBe('RECEIVED');
    // Activity-only fields stay null on a message rather than being absent.
    expect(inbound.outcome).toBeNull();
    expect(inbound.durationMinutes).toBeNull();
    expect(inbound.activityType).toBeNull();

    const agentMsg = byAt(30);
    expect(agentMsg.authorType).toBe('AGENT');
    expect(agentMsg.authorId).toBe(agentId);
    expect(agentMsg.authorName).toBe('Ayse Temsilci');

    // A FAILED message must never read as delivered — v2.283.0's rule.
    const failed = byAt(10);
    expect(failed.authorType).toBe('AI');
    expect(failed.deliveryStatus).toBe('FAILED');

    const call = byAt(35);
    expect(call.kind).toBe('call');
    expect(call.activityType).toBe('CALL');
    expect(call.title).toBe('Sales call: ANSWERED');
    expect(call.body).toBe('Fiyat konusuldu');
    expect(call.outcome).toBe('POSITIVE');
    expect(call.durationMinutes).toBe(12);
    expect(call.authorName).toBe('Ayse Temsilci');
    // Message-only fields stay null on an activity.
    expect(call.direction).toBeNull();
    expect(call.channelType).toBeNull();
    expect(call.conversationId).toBeNull();

    expect(byAt(5).kind).toBe('status');
    expect(byAt(20).kind).toBe('note');
  });

  it('gives a person with no thread their activities, not the workspace inbox', async () => {
    const res = await svc.forLead(workspaceId, quietLead, managerId, 'MANAGER');

    expect(res.items.map((i) => i.title)).toEqual(['Sessiz not']);
    expect(res.items.every((i) => i.kind !== 'message')).toBe(true);
    expect(res.unread).toEqual([]);
  });

  it('NAMES a source it could not read instead of rendering an empty stream', async () => {
    // The rule this endpoint exists to keep: a broken source and a quiet
    // person must not look the same. The daily brief swallowed eight queries
    // into `catch(() => 0)` and reported "nothing to report" for "the query
    // threw" — fixed in v2.271.0, and not to be re-introduced here.
    //
    // The break is injected by wrapping the REAL client so that ONLY
    // `message.findMany` rejects — every other read in this call still goes to
    // Postgres. (jest.spyOn on `prisma.message` does not stick: Prisma builds
    // its delegates behind a property accessor, so the spy lands on an object
    // the service never sees. That silent no-op is worth naming, because a
    // spec written that way passes while testing nothing.)
    const broken = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'message') {
          return { findMany: () => Promise.reject(new Error('messages table on fire')) };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const svcBroken = new LeadStreamService(broken as PrismaService, app.get(EntitlementsService));

    const res = await svcBroken.forLead(workspaceId, richLead, managerId, 'MANAGER');

    expect(res.unread).toEqual(['mesajlar']);
    // The OTHER source still rendered — the stream is short, not empty.
    expect(res.items.map((i) => i.kind)).toEqual(['call', 'note', 'status']);
    expect(res.items.length).toBeGreaterThan(0);
    // A failed source is unread, never truncated: it fell back to nothing.
    expect(res.truncated).toEqual([]);
    // And not gated either — the plan is fine, the query is not.
    expect(res.gated).toEqual([]);
  });

  it('says a source was cut rather than quietly dropping the overflow', async () => {
    const res = await svc.forLead(workspaceId, floodLead, managerId, 'MANAGER');

    expect(res.truncated).toEqual(['hareketler']);
    expect(res.items).toHaveLength(CAP);
    expect(res.unread).toEqual([]);
    // The cut falls on the OLDEST rows: a stream that hid the newest events
    // would be worse than no stream. `sel-0` is the oldest of the flood.
    expect(res.items.some((i) => i.title === 'sel-0')).toBe(false);
    expect(res.items[res.items.length - 1].title).toBe(`sel-${CAP}`);
  });

  it('never crosses the tenant line, by lead id or by a spoofed thread', async () => {
    // Asking for the NEIGHBOUR's person BY ID from our workspace: the row
    // matches on id, so `workspaceId` is the only clause that can refuse it.
    await expect(svc.forLead(workspaceId, foreignLead, managerId, 'MANAGER')).rejects.toThrow(
      NotFoundException,
    );

    // And no cross-stamped row reaches this person's stream, whichever of the
    // two missing foreign keys it exploits.
    const mine = await svc.forLead(workspaceId, richLead, managerId, 'MANAGER');
    const bodies = mine.items.map((i) => i.body);
    expect(bodies).not.toContain('KOMSUNUN MESAJI'); // their thread, their message
    expect(bodies).not.toContain('CAPRAZ MESAJ BIZIM WS'); // their thread, our stamp
    expect(bodies).not.toContain('CAPRAZ MESAJ KOMSU WS'); // our thread, their stamp
    expect(mine.items).toHaveLength(6);
  });

  it('withholds the conversation column without a plan, and SAYS it withheld it', async () => {
    // otherWorkspace has no subscription, so `conversationAi` is off. The
    // design is explicit: that workspace still sees the person and their
    // activities. What it must not get is silence dressed as history.
    const res = await svc.forLead(otherWorkspaceId, foreignLead, randomUUID(), 'MANAGER');

    expect(res.gated).toEqual(['mesajlar']);
    expect(res.items.map((i) => i.title)).toEqual(['Yabanci not']);
    expect(res.items.every((i) => i.kind !== 'message')).toBe(true);
    // Gated is NOT a failure: nothing broke, so nothing is named as unread.
    expect(res.unread).toEqual([]);
  });

  it('holds a REP to their own people, as the lead detail already does', async () => {
    await expect(svc.forLead(workspaceId, richLead, otherRepId, 'REP')).rejects.toThrow(
      ForbiddenException,
    );
    // The rep the lead IS assigned to gets it.
    const own = await svc.forLead(workspaceId, richLead, agentId, 'REP');
    expect(own.items).toHaveLength(6);
  });
});
