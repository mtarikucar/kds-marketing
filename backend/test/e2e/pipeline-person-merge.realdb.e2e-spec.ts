import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OpportunitiesService } from '../../src/modules/marketing/opportunities/opportunities.service';
import { LeadStreamService } from '../../src/modules/marketing/services/lead-stream.service';
import { leadIdsWithOpenOpportunity } from '../../src/modules/marketing/services/not-in-pipeline-leads';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The sales pipeline as a field of the PERSON, against REAL Postgres.
 *
 * Everything here needs real SQL for the same reason the lead stream did:
 * `Opportunity.leadId` is a bare `String?` with NO foreign key and no Prisma
 * relation (schema.prisma:3931). There is nothing to `include`, no `some` to
 * nest and no `_count` to ask for — "people with no open deal" is a raw
 * statement plus a `notIn`, and the board's person hydration is a second
 * statement stitched back on. A mocked Prisma accepts any `where` it is handed,
 * so none of the three tenant predicates below can be proved anywhere but here.
 *
 * The fixture is built so each predicate fails its OWN assertion. A row refused
 * by two clauses at once proves neither: deleting one leaves the suite green and
 * ships the hole. There are exactly three, one per probe row:
 *
 *   - `leadSpoofed` is OURS and has no deal of OURS, while the NEIGHBOUR holds
 *     an OPEN deal naming it. Only `o."workspaceId"` in the exclusion query keeps
 *     that person in our column; drop it and they vanish from the one screen
 *     that exists to make them visible.
 *   - `foreignLead` is the NEIGHBOUR's own person with no deal anywhere. The
 *     exclusion list is a list of people to REMOVE, so it cannot narrow anything
 *     to a tenant: only `workspaceId` on the Prisma read keeps them out.
 *   - `spoofCard` is a deal of OURS naming the NEIGHBOUR's person. Only the
 *     workspace scope on the board's person read stops their name rendering on
 *     our board.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Pipeline ↔ person merge, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let opportunities: OpportunitiesService;
  let stream: LeadStreamService;

  const SEED = `pipeperson-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID(); // ours
  const otherWorkspaceId = randomUUID(); // the neighbour
  const fullWorkspaceId = randomUUID(); // every person already has an open deal
  const emptyWorkspaceId = randomUUID(); // people, and not one deal anywhere
  const packageId = randomUUID();

  const managerId = randomUUID();
  const repId = randomUUID();
  const otherRepId = randomUUID();

  const pipelineId = randomUUID();
  const stageNew = randomUUID();
  const stageOffer = randomUUID();
  const stageWon = randomUUID();
  const stageLost = randomUUID();
  const otherPipelineId = randomUUID();
  const otherStage = randomUUID();
  const fullPipelineId = randomUUID();
  const fullStage = randomUUID();

  // ── the people ────────────────────────────────────────────────────────────
  const leadOpen = randomUUID(); // OPEN deal → in the pipeline
  const leadWon = randomUUID(); // only a WON deal → out of the pipeline
  const leadLost = randomUUID(); // only a LOST deal → out of the pipeline
  const leadAbandoned = randomUUID(); // only an ABANDONED deal → out of the pipeline
  const leadNone = randomUUID(); // never had a deal
  const leadSpoofed = randomUUID(); // ours; the NEIGHBOUR holds an open deal naming it
  const leadMerged = randomUUID(); // tombstoned duplicate
  const leadDeleted = randomUUID(); // soft-deleted
  const leadRepOwned = randomUUID(); // assigned to `repId`, no deal
  const foreignLead = randomUUID(); // the neighbour's own person, no deal
  const fullLead = randomUUID(); // the only person in fullWorkspace, has a deal
  const emptyLeadA = randomUUID(); // emptyWorkspace, no deals exist at all
  const emptyLeadB = randomUUID();

  // ── the deals ─────────────────────────────────────────────────────────────
  const openCard = randomUUID();
  const wonCard = randomUUID();
  const lostCard = randomUUID();
  const abandonedCard = randomUUID();
  const orphanCard = randomUUID(); // no leadId at all
  const spoofCard = randomUUID(); // ours, names the NEIGHBOUR's person
  const neighbourOpenCard = randomUUID(); // theirs, names OUR leadSpoofed
  const fullCard = randomUUID();

  const MGR = { id: managerId, workspaceId, role: 'MANAGER' } as any;
  const REP = { id: repId, workspaceId, role: 'REP' } as any;

  const BASE = Date.now();
  const t = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000);

  const names = (res: { data: Array<{ name: string }> }) => res.data.map((p) => p.name);

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    ({ app, prisma } = await createRealDbTestApp());
    opportunities = app.get(OpportunitiesService);
    stream = app.get(LeadStreamService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Pipe A', productName: 'Pipe A' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Pipe B', productName: 'Pipe B' },
        { id: fullWorkspaceId, slug: `${SEED}-c`, name: 'Pipe C', productName: 'Pipe C' },
        { id: emptyWorkspaceId, slug: `${SEED}-d`, name: 'Pipe D', productName: 'Pipe D' },
      ],
    });

    // A real plan carrying the real `conversationAi` gate, so the stream
    // assertions read an entitlement rather than assuming one.
    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Pipe Plan',
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

    await prisma.marketingUser.createMany({
      data: [
        { id: managerId, workspaceId, email: `${SEED}-m@example.test`, password: 'x', firstName: 'Mana', lastName: 'Ger', role: 'MANAGER' },
        { id: repId, workspaceId, email: `${SEED}-r@example.test`, password: 'x', firstName: 'Ayse', lastName: 'Temsilci', role: 'REP' },
        { id: otherRepId, workspaceId, email: `${SEED}-r2@example.test`, password: 'x', firstName: 'Baska', lastName: 'Temsilci', role: 'REP' },
      ],
    });

    await prisma.pipeline.createMany({
      data: [
        { id: pipelineId, workspaceId, name: `${SEED}-pipe`, isDefault: true, position: 0 },
        { id: otherPipelineId, workspaceId: otherWorkspaceId, name: `${SEED}-pipe-b`, isDefault: true, position: 0 },
        { id: fullPipelineId, workspaceId: fullWorkspaceId, name: `${SEED}-pipe-c`, isDefault: true, position: 0 },
      ],
    });
    await prisma.pipelineStage.createMany({
      data: [
        { id: stageNew, workspaceId, pipelineId, name: 'Yeni', position: 0, probability: 10 },
        { id: stageOffer, workspaceId, pipelineId, name: 'Teklif gönderildi', position: 1, probability: 60 },
        { id: stageWon, workspaceId, pipelineId, name: 'Kazanıldı', position: 2, probability: 100, isWon: true },
        { id: stageLost, workspaceId, pipelineId, name: 'Kaybedildi', position: 3, probability: 0, isLost: true },
        { id: otherStage, workspaceId: otherWorkspaceId, pipelineId: otherPipelineId, name: 'Yeni', position: 0 },
        { id: fullStage, workspaceId: fullWorkspaceId, pipelineId: fullPipelineId, name: 'Yeni', position: 0 },
      ],
    });

    const lead = (
      id: string,
      person: string,
      over: Partial<{ workspaceId: string; assignedToId: string | null; mergedIntoId: string | null; deletedAt: Date | null }> = {},
    ) => ({
      id,
      workspaceId,
      businessName: `${SEED}-firma-${person}`,
      contactPerson: person,
      businessType: 'CAFE',
      source: 'OTHER',
      assignedToId: null as string | null,
      createdAt: t(5000),
      updatedAt: t(5000),
      ...over,
    });

    await prisma.lead.createMany({
      data: [
        lead(leadOpen, 'acik'),
        lead(leadWon, 'kazanildi'),
        lead(leadLost, 'kaybedildi'),
        lead(leadAbandoned, 'terk'),
        lead(leadNone, 'hicyok'),
        lead(leadSpoofed, 'sahte'),
        lead(leadRepOwned, 'repin', { assignedToId: repId }),
        lead(leadMerged, 'birlesmis', { mergedIntoId: leadNone }),
        lead(leadDeleted, 'silinmis', { deletedAt: t(1) }),
        lead(foreignLead, 'komsu', { workspaceId: otherWorkspaceId }),
        lead(fullLead, 'dolu', { workspaceId: fullWorkspaceId }),
        lead(emptyLeadA, 'bos-bir', { workspaceId: emptyWorkspaceId }),
        lead(emptyLeadB, 'bos-iki', { workspaceId: emptyWorkspaceId }),
      ],
    });

    const deal = (
      id: string,
      over: Partial<{
        workspaceId: string;
        pipelineId: string;
        stageId: string;
        leadId: string | null;
        status: string;
        name: string;
        value: number;
      }> = {},
    ) => ({
      id,
      workspaceId,
      pipelineId,
      stageId: stageNew,
      leadId: null as string | null,
      assignedToId: managerId,
      name: `${SEED}-deal`,
      value: 1000,
      currency: 'TRY',
      status: 'OPEN',
      position: 0,
      ...over,
    });

    await prisma.opportunity.createMany({
      data: [
        deal(openCard, { leadId: leadOpen, name: 'Açık anlaşma', value: 45000 }),
        deal(wonCard, { leadId: leadWon, stageId: stageWon, status: 'WON', name: 'Kazanılan' }),
        deal(lostCard, { leadId: leadLost, stageId: stageLost, status: 'LOST', name: 'Kaybedilen' }),
        deal(abandonedCard, { leadId: leadAbandoned, status: 'ABANDONED', name: 'Terk edilen' }),
        // No person behind it — the board must still render the card.
        deal(orphanCard, { leadId: null, name: 'Sahipsiz anlaşma' }),
        // OURS, naming the NEIGHBOUR's person. Legal: no foreign key.
        deal(spoofCard, { leadId: foreignLead, name: 'Sızıntı kartı' }),
        // THEIRS, naming OUR person. Also legal, and the reason the NOT EXISTS
        // carries its own workspace predicate.
        deal(neighbourOpenCard, {
          workspaceId: otherWorkspaceId,
          pipelineId: otherPipelineId,
          stageId: otherStage,
          leadId: leadSpoofed,
          assignedToId: null as any,
          name: 'Komşunun açık anlaşması',
        }),
        deal(fullCard, {
          workspaceId: fullWorkspaceId,
          pipelineId: fullPipelineId,
          stageId: fullStage,
          leadId: fullLead,
          assignedToId: null as any,
          name: 'Doluların anlaşması',
        }),
      ],
    });
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    const scope = { in: [workspaceId, otherWorkspaceId, fullWorkspaceId, emptyWorkspaceId] };
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    try {
      if (!prisma) return;
      await del(() => prisma.leadActivity.deleteMany({ where: { lead: { workspaceId: scope } } }));
      await del(() => prisma.opportunity.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.pipelineStage.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.pipeline.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.lead.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.workspaceSubscription.deleteMany({ where: { workspaceId: scope } }));
      await del(() => prisma.package.deleteMany({ where: { id: packageId } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: scope } }));
    } finally {
      await closeTestApp(app);
    }
  });

  describe('the "not in pipeline" column', () => {
    it('is everyone whose deals are all resolved — or who never had one', async () => {
      const res = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);

      // "No OPEN opportunity", stated: a person whose only deal is WON, LOST or
      // ABANDONED is not IN the pipeline. They are past it or out of it, and the
      // column exists so someone decides what happens next.
      expect(names(res).sort()).toEqual(
        ['hicyok', 'kaybedildi', 'kazanildi', 'repin', 'sahte', 'terk'].sort(),
      );
      // The one person with a live deal is on the board, not in this column.
      expect(names(res)).not.toContain('acik');
      // Tombstoned duplicates and soft-deleted people are nobody's work.
      expect(names(res)).not.toContain('birlesmis');
      expect(names(res)).not.toContain('silinmis');
      expect(res.meta.total).toBe(6);
    });

    it("keeps our person visible when the NEIGHBOUR holds the open deal on their id", async () => {
      // `leadSpoofed` has no deal of ours; the neighbour has an OPEN one naming
      // it. Only `o."workspaceId"` inside the NOT EXISTS separates the two, and
      // without it this person disappears from the only screen that shows them.
      const res = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);
      expect(names(res)).toContain('sahte');
    });

    it("never lists the neighbour's own people", async () => {
      const res = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);
      expect(names(res)).not.toContain('komsu');

      // And from the other side: their column is theirs alone.
      const theirs = await opportunities.notInPipeline(
        otherWorkspaceId,
        { limit: 50 } as any,
        { id: randomUUID(), workspaceId: otherWorkspaceId, role: 'MANAGER' } as any,
      );
      expect(names(theirs)).toEqual(['komsu']);
    });

    it('is EMPTY when everyone already has a deal — never the whole workspace', async () => {
      // The empty-list trap, half one. Every person in this workspace holds an
      // open deal, so the column has nobody in it. An implementation that treats
      // "no ids to work with" as "no filter" answers with the entire workspace
      // under a heading that says the opposite — the bug that shipped green here
      // for eight weeks once.
      const res = await opportunities.notInPipeline(
        fullWorkspaceId,
        { limit: 50 } as any,
        { id: randomUUID(), workspaceId: fullWorkspaceId, role: 'MANAGER' } as any,
      );
      expect(res.data).toEqual([]);
      expect(res.meta.total).toBe(0);
    });

    it('is EVERYONE in a workspace that has never opened a deal', async () => {
      // The empty-list trap, half two, and the half a `notIn` query gets wrong in
      // the other direction: with no open deals the exclusion list is empty, and
      // an empty exclusion list must exclude NOBODY. A brand-new workspace's
      // whole roster is exactly the case this column was built for.
      const res = await opportunities.notInPipeline(
        emptyWorkspaceId,
        { limit: 50 } as any,
        { id: randomUUID(), workspaceId: emptyWorkspaceId, role: 'MANAGER' } as any,
      );
      expect(names(res).sort()).toEqual(['bos-bir', 'bos-iki']);
      expect(res.meta.total).toBe(2);
    });

    it('survives a deal with no person on it, which would otherwise empty the column', async () => {
      // `orphanCard` is an OPEN deal with `leadId = NULL`, and it is on this
      // board right now. A NULL reaching the exclusion list is refused outright
      // by Prisma — `Expected ListStringFieldRefInput, provided (String, String,
      // Null)` — so one nameless deal takes the whole column down with a 500;
      // hand-written in SQL the same NULL is SILENT instead, because
      // `NOT IN (NULL, …)` is never true for any row. `leadId IS NOT NULL` in
      // `not-in-pipeline-leads.ts` is the ONE clause standing between the column
      // and both readings, and this is the assertion that falls when it goes.
      const orphan = await prisma.opportunity.findUniqueOrThrow({ where: { id: orphanCard } });
      expect(orphan.leadId).toBeNull();
      expect(orphan.status).toBe('OPEN');

      // The list itself, before any caller sees it: the two people our OPEN
      // deals actually name, and nothing standing in for the nameless one.
      const excluded = await leadIdsWithOpenOpportunity(prisma, workspaceId);
      expect(excluded).not.toContain(null);
      expect([...excluded].sort()).toEqual([foreignLead, leadOpen].sort());

      const res = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);
      expect(res.data.length).toBeGreaterThan(0);
    });

    it('pages, because 361 people are not one screen', async () => {
      const first = await opportunities.notInPipeline(workspaceId, { page: 1, limit: 2 } as any, MGR);
      const second = await opportunities.notInPipeline(workspaceId, { page: 2, limit: 2 } as any, MGR);
      const third = await opportunities.notInPipeline(workspaceId, { page: 3, limit: 2 } as any, MGR);

      expect(first.data).toHaveLength(2);
      expect(second.data).toHaveLength(2);
      expect(third.data).toHaveLength(2);
      // Every page carries the FULL count, so the column header can say "6"
      // while showing two.
      expect(first.meta).toMatchObject({ total: 6, page: 1, limit: 2, totalPages: 3 });
      // No person appears on two pages, and none falls between them.
      const seen = [...names(first), ...names(second), ...names(third)];
      expect(new Set(seen).size).toBe(6);

      // A page past the end is empty, not the whole column.
      const past = await opportunities.notInPipeline(workspaceId, { page: 9, limit: 2 } as any, MGR);
      expect(past.data).toEqual([]);
      expect(past.meta.total).toBe(6);
    });

    it('holds a REP to their own people, as the board already does', async () => {
      const res = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, REP);
      expect(names(res)).toEqual(['repin']);
    });

    it('carries what a card draws: the display name and the person id', async () => {
      const res = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);
      const person = res.data.find((p) => p.name === 'hicyok')!;

      expect(person).toMatchObject({
        id: leadNone,
        name: 'hicyok', // contactPerson || businessName — PeopleList's own rule
        contactPerson: 'hicyok',
        businessName: `${SEED}-firma-hicyok`,
        assignedToId: null,
      });
      expect(person).toHaveProperty('phone', null);
      expect(person).toHaveProperty('status', 'NEW');
    });

    it('searches by person or business name, still inside the column', async () => {
      const res = await opportunities.notInPipeline(
        workspaceId,
        { limit: 50, search: 'kazanildi' } as any,
        MGR,
      );
      expect(names(res)).toEqual(['kazanildi']);
      expect(res.meta.total).toBe(1);

      // A person WITH an open deal cannot be searched into this column.
      const miss = await opportunities.notInPipeline(
        workspaceId,
        { limit: 50, search: 'acik' } as any,
        MGR,
      );
      expect(miss.data).toEqual([]);
    });
  });

  describe('the board card shows the person', () => {
    it('names the human, not just a leadId', async () => {
      const board = await opportunities.board(workspaceId, pipelineId, MGR);
      const col = board.stages.find((s: any) => s.id === stageNew)!;
      const card = (col as any).opportunities.find((o: any) => o.id === openCard);

      expect(card.leadId).toBe(leadOpen);
      expect(card.lead).toMatchObject({
        id: leadOpen,
        name: 'acik',
        contactPerson: 'acik',
        businessName: `${SEED}-firma-acik`,
      });
      // The deal's own value stays — name primary, value secondary.
      expect(Number(card.value)).toBe(45000);
    });

    it('leaves `lead` null on a deal nobody is attached to', async () => {
      const board = await opportunities.board(workspaceId, pipelineId, MGR);
      const col = board.stages.find((s: any) => s.id === stageNew)!;
      const card = (col as any).opportunities.find((o: any) => o.id === orphanCard);
      expect(card.lead).toBeNull();
    });

    it("refuses to render the NEIGHBOUR's person on our board", async () => {
      // `spoofCard` is our deal naming their person — no foreign key stops it
      // being stored. The workspace scope on the person read is what stops the
      // name being shown.
      const board = await opportunities.board(workspaceId, pipelineId, MGR);
      const col = board.stages.find((s: any) => s.id === stageNew)!;
      const card = (col as any).opportunities.find((o: any) => o.id === spoofCard);

      expect(card.leadId).toBe(foreignLead); // the row is what it is
      expect(card.lead).toBeNull(); // the name is not ours to show
    });

    it('hydrates every card from ONE read, not one read per card', async () => {
      // The N+1 guard. Four cards with people on this board; a per-card lookup
      // would be four statements.
      const calls: string[] = [];
      const counting = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === 'lead') {
            const delegate = Reflect.get(target, prop, receiver) as any;
            return new Proxy(delegate, {
              get(d, m, r) {
                if (typeof m === 'string') calls.push(m);
                return Reflect.get(d, m, r);
              },
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      // jest.spyOn on a Prisma delegate does not stick — Prisma builds them
      // behind a property accessor, so the spy lands on an object the service
      // never sees. Wrapping the client is the only way to count.
      const svc = new OpportunitiesService(
        counting as PrismaService,
        (opportunities as any).pipelines,
        (opportunities as any).outbox,
      );
      await svc.board(workspaceId, pipelineId, MGR);

      expect(calls.filter((c) => c === 'findMany')).toHaveLength(1);
      expect(calls).not.toContain('findFirst');
      expect(calls).not.toContain('findUnique');
    });
  });

  describe('sales movement lands in the person stream', () => {
    it('a stage change is readable in the person timeline, by stage NAME', async () => {
      await opportunities.move(workspaceId, openCard, { stageId: stageOffer } as any, MGR);

      const res = await stream.forLead(workspaceId, leadOpen, managerId, 'MANAGER');
      const statuses = res.items.filter((i) => i.kind === 'status');

      expect(statuses.map((i) => i.title)).toEqual(['Deal stage: Yeni → Teklif gönderildi']);
      expect(statuses[0]).toMatchObject({
        kind: 'status',
        activityType: 'STATUS_CHANGE',
        body: 'Açık anlaşma · 45000 TRY',
        authorName: 'Mana Ger',
        // A deal move is not an assignment; the stream must not badge it as one.
        assignment: null,
      });
      // Nothing broke and nothing was withheld to make that happen.
      expect(res.unread).toEqual([]);
      expect(res.gated).toEqual([]);
    });

    it('winning a deal reads as WON, and takes the person out of the column', async () => {
      const before = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);
      expect(names(before)).not.toContain('acik');

      await opportunities.win(workspaceId, openCard, MGR);

      const res = await stream.forLead(workspaceId, leadOpen, managerId, 'MANAGER');
      expect(res.items.filter((i) => i.kind === 'status').map((i) => i.title)).toEqual([
        'Deal stage: Yeni → Teklif gönderildi',
        'Deal won: Açık anlaşma',
      ]);

      // The deal is resolved, so the person is out of the pipeline and back in
      // the column — the two surfaces answer the same question the same way.
      const after = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);
      expect(names(after)).toContain('acik');
      expect(after.meta.total).toBe(7);
    });

    it('opening a deal for a person writes the opening line — and only for them', async () => {
      const created = await opportunities.create(
        workspaceId,
        { leadId: leadNone, stageId: stageNew, value: 2500 } as any,
        MGR,
      );
      // Dropping a PERSON on a stage carries no deal name: theirs becomes it.
      expect(created.name).toBe('hicyok');

      const res = await stream.forLead(workspaceId, leadNone, managerId, 'MANAGER');
      expect(res.items.map((i) => [i.kind, i.title])).toEqual([
        ['status', 'Deal opened: hicyok'],
      ]);
      expect(res.items[0].body).toBe('Stage: Yeni · 2500 TRY');

      // And they are on the board now, out of the column.
      const after = await opportunities.notInPipeline(workspaceId, { limit: 50 } as any, MGR);
      expect(names(after)).not.toContain('hicyok');

      // Nobody else's stream moved.
      const untouched = await stream.forLead(workspaceId, leadRepOwned, managerId, 'MANAGER');
      expect(untouched.items).toEqual([]);
    });

    it("writes nothing when the deal's person belongs to the neighbour", async () => {
      // `spoofCard` names `foreignLead`. Writing an activity there would push our
      // deal's name into another workspace's timeline — and LeadActivity DOES
      // have a foreign key, so a dangling id would fail the move outright.
      const beforeCount = await prisma.leadActivity.count({ where: { leadId: foreignLead } });

      await opportunities.move(workspaceId, spoofCard, { stageId: stageOffer } as any, MGR);

      expect(await prisma.leadActivity.count({ where: { leadId: foreignLead } })).toBe(beforeCount);
      // The deal itself still moved: the trace is best-effort about WHO, never
      // about WHETHER.
      const moved = await prisma.opportunity.findUniqueOrThrow({ where: { id: spoofCard } });
      expect(moved.stageId).toBe(stageOffer);
    });
  });
});
