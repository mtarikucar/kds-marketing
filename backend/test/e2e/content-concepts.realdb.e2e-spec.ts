import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AiCreditsService } from '../../src/modules/marketing/ai/ai-credits.service';
import { VideoPipelineService } from '../../src/modules/marketing/video/video-pipeline.service';
import {
  ContentConceptsService,
  MAX_SHOT_SEC,
  MIN_SHOT_SEC,
} from '../../src/modules/marketing/content-concepts/content-concepts.service';
import { ConceptPromotionService } from '../../src/modules/marketing/content-concepts/concept-promotion.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * Idea -> concepts -> review, against REAL Postgres.
 *
 * Three things only real SQL settles here.
 *
 * 1. **Every tenant predicate on `content_concepts` is hand-written.** The table
 *    has no foreign key to `workspaces` (nor to `social_campaigns` — the link is
 *    soft on purpose, so an idea outlives a deleted campaign), so nothing in the
 *    schema refuses a cross-tenant read. A mocked Prisma accepts any `where` it
 *    is handed and would pass while testing nothing.
 * 2. **A doubly-guarded fixture hides a missing predicate.** If the neighbour's
 *    rows differed in workspace AND batch AND status, dropping `workspaceId`
 *    from the query would still return the right rows and the suite would stay
 *    green. So the probe rows below are CROSS-STAMPED: the neighbour owns a
 *    concept carrying OUR batchId, at OUR status, from OUR source idea. The
 *    workspace clause is then the only thing that can exclude it, and each
 *    predicate gets its own failing assertion.
 * 3. **The batch is written in one statement.** "All five or none" is a
 *    property of `createMany`, and asserting it means counting rows after an
 *    injected failure.
 *
 * The `AnthropicService` is the only seam cut — an LLM is not a test fixture.
 * `PrismaService`, `AiCreditsService`, `EntitlementsService` and
 * `VideoPipelineService` are all the real ones the app booted, so the credit
 * reserve, the entitlement read and the shot planning are exercised for real.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

/** Three genuinely different angles — the shape a well-behaved model returns. */
const GOOD_CONCEPTS = [
  {
    angle: 'curiosity',
    hook: 'Bunun motoru yok.',
    title: 'Motorsuz yürüyen şey',
    rationale: 'Merakla açıp mekanikle kapatıyor.',
    shots: [
      { scene: '0-2s', cameraNote: 'geniş, takip', onScreenText: 'Bunun motoru yok.', voiceover: '', description: 'Strandbeest ıslak kumda yürüyor', durationSec: 2 },
      { scene: '2-5s', cameraNote: 'pervaneye kaydırma', onScreenText: 'Pili de yok.', voiceover: '', description: 'rüzgar pervanesi dönüyor', durationSec: 3 },
      { scene: '5-9s', cameraNote: 'makro', onScreenText: 'Sadece geometri.', voiceover: 'Theo Jansen 1990ta tasarladı', description: 'bacak bağlantılarına makro', durationSec: 4 },
    ],
  },
  {
    angle: 'engineering',
    hook: 'Bir tekerleği bacağa dönüştürebilir misin?',
    title: 'Krank bacağa nasıl dönüşür',
    rationale: 'Tek bacağı elle çevirerek mekanizmayı söküyor.',
    shots: [
      { scene: '0-4s', cameraNote: 'yakın plan eller', onScreenText: '', voiceover: 'Önce bir krank, sonra bir bağlantı kolu', description: 'elle çevrilen tek bacak', durationSec: 4 },
      { scene: '4-9s', cameraNote: 'sabit tripod', onScreenText: 'On bir çubuk.', voiceover: 'On bir çubuk ve tek dönme merkezi', description: 'krankın bacağı ittiği an', durationSec: 5 },
    ],
  },
  {
    angle: 'sensory',
    hook: 'Dişliden yürüyüşe.',
    title: 'Konuşmasız montaj',
    rationale: 'Ses yok, sadece hareket ve doku.',
    shots: [
      { scene: '0-3s', cameraNote: 'makro', onScreenText: '', voiceover: '', description: 'dişli dişleri kavrıyor', durationSec: 3 },
      { scene: '3-6s', cameraNote: 'makro', onScreenText: '', voiceover: '', description: 'krank tam tur atıyor', durationSec: 3 },
      { scene: '6-10s', cameraNote: 'alçak açı', onScreenText: '', voiceover: '', description: 'altı bacak aynı anda yere basıyor', durationSec: 4 },
    ],
  },
];

/** The failure mode the whole feature exists to prevent. */
const PARAPHRASES = [1, 2, 3].map((n) => ({
  angle: 'açı ' + n,
  hook: 'Bu Strandbeestin motoru yok ve pili de yok ' + n,
  title: 'Motorsuz ' + n,
  shots: [
    { scene: '0-3s', cameraNote: 'geniş', onScreenText: 'Motoru yok ' + n, voiceover: '', description: 'Strandbeest yürüyor geniş plan', durationSec: 3 },
    { scene: '3-6s', cameraNote: 'yakın', onScreenText: 'Pili yok ' + n, voiceover: '', description: 'pervane dönüyor yakın plan', durationSec: 3 },
  ],
}));

const submission = (concepts: unknown[]) => ({
  text: '',
  toolUses: [{ id: 'tu1', name: 'submit_concepts', input: { concepts } }],
  stopReason: 'tool_use',
  usage: { input: 100, output: 900 },
});

describeRealDb('Content concepts — idea to reviewable concepts, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let credits: AiCreditsService;
  let pipeline: VideoPipelineService;

  const SEED = `concepts-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID(); // ours
  const otherWorkspaceId = randomUUID(); // the neighbour
  const packageId = randomUUID();
  const ownerId = randomUUID();

  /** Cross-stamped: OUR batch id, OUR status, OUR idea — in THEIR workspace. */
  const SHARED_BATCH = randomUUID();
  /** Approving now starts production, which needs a campaign to produce INTO. */
  const campaignId = randomUUID();
  const SHARED_IDEA = 'Theo Jansen Strandbeest — rüzgarla yürüyen, motoru olmayan kinetik heykel.';
  const ourSeededConcept = randomUUID();
  const neighbourProbe = randomUUID();

  /**
   * Promotion, with the two external vendors cut out. Approving a concept is
   * now the moment production starts, so `review` needs one of these; fal.ai
   * does not get called for it and no job row is written (the booted app runs a
   * real once-a-minute runner that would otherwise claim it mid-suite).
   */
  const promotion = (client: PrismaService = prisma) =>
    new ConceptPromotionService(
      client,
      { requestGeneration: jest.fn().mockResolvedValue({ assetId: randomUUID() }) } as never,
      { schedule: jest.fn().mockResolvedValue('job-1') } as never,
      { registerHandler: () => undefined } as never,
    );

  /** A service wired to a scripted model instead of a live one. */
  const svcWith = (
    completion: unknown | (() => Promise<never>),
    client: PrismaService = prisma,
  ): { svc: ContentConceptsService; complete: jest.Mock } => {
    const complete =
      typeof completion === 'function'
        ? jest.fn().mockImplementation(completion as () => Promise<never>)
        : jest.fn().mockResolvedValue(completion);
    const anthropic = { isEnabled: () => true, complete };
    return {
      svc: new ContentConceptsService(
        client,
        anthropic as never,
        credits,
        pipeline,
        promotion(client),
      ),
      complete,
    };
  };

  /** A read/review-only service — no model behind it, real everything else. */
  const reader = () =>
    new ContentConceptsService(
      prisma,
      { isEnabled: () => true, complete: jest.fn() } as never,
      credits,
      pipeline,
      promotion(),
    );

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    credits = app.get(AiCreditsService);
    pipeline = app.get(VideoPipelineService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Concepts A', productName: 'Figurunica' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Concepts B', productName: 'Next Door' },
      ],
    });

    // A real plan carrying the real feature + an unlimited AI allowance, so the
    // credit reserve is exercised rather than short-circuited.
    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Concepts Plan',
        dailyLeadQuota: -1,
        maxUsers: 10,
        maxResearchProfiles: 1,
        features: { socialCampaigns: true, mediaGen: true },
        limits: { aiCreditsMonthly: -1 },
        priceMonthlyTRY: 1,
        priceMonthlyUSD: 1,
      },
    });
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await prisma.workspaceSubscription.create({
        data: {
          workspaceId: ws,
          packageId,
          status: 'ACTIVE',
          currency: 'TRY',
          currentPeriodStart: new Date(Date.now() - 86_400_000),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      });
    }

    await prisma.marketingUser.create({
      data: {
        id: ownerId,
        workspaceId,
        email: `${SEED}-owner@example.com`,
        firstName: 'Olive',
        lastName: 'Owner',
        role: 'OWNER',
        status: 'ACTIVE',
        password: 'x',
      },
    });

    // Approving is now the moment production starts, and production needs a
    // campaign: the calendar slot, the target accounts and the model live on it.
    await prisma.socialCampaign.create({
      data: {
        id: campaignId,
        workspaceId,
        name: 'Concepts',
        brief: {},
        status: 'ACTIVE',
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        cadence: { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '09:00' },
        startDate: new Date(Date.now() - 86_400_000),
        targetAccountIds: [],
        mediaKinds: ['VIDEO'],
        createdById: ownerId,
      },
    });

    // THE PROBE PAIR. Same batch, same status, same source idea, same angle and
    // hook text — everything a query could match on EXCEPT the workspace. If a
    // `workspaceId` predicate is dropped anywhere below, this row surfaces.
    await prisma.contentConcept.createMany({
      data: [
        {
          id: ourSeededConcept,
          workspaceId,
          batchId: SHARED_BATCH,
          sourceIdea: SHARED_IDEA,
          angle: 'curiosity',
          hook: 'Bunun motoru yok.',
          title: 'Ours',
          ordinal: 0,
          shotPlan: { model: 'seedance', durationSec: 4, shots: [], captionSuggestion: '', qcChecklist: [] },
          socialCampaignId: campaignId,
          createdById: ownerId,
        },
        {
          id: neighbourProbe,
          workspaceId: otherWorkspaceId,
          batchId: SHARED_BATCH,
          sourceIdea: SHARED_IDEA,
          angle: 'curiosity',
          hook: 'Bunun motoru yok.',
          title: 'Theirs',
          ordinal: 0,
          shotPlan: { model: 'seedance', durationSec: 4, shots: [], captionSuggestion: '', qcChecklist: [] },
          createdById: ownerId,
        },
      ],
    });
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    // Baseline restore, most-dependent first.
    await prisma.socialPost.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.socialCampaignItem.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.socialCampaign.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.contentConcept.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.usageCounter.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.aiUsageLog.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.marketingUser.deleteMany({ where: { id: ownerId } });
    await prisma.workspaceSubscription.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.package.deleteMany({ where: { id: packageId } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await closeTestApp(app);
  });

  // ───────────────────────────────────────────────────── the chain, for real

  it('writes one idea out as N concepts, each carrying a real shot plan', async () => {
    const { svc } = svcWith(submission(GOOD_CONCEPTS));
    const res = await svc.planConcepts(workspaceId, {
      idea: SHARED_IDEA,
      count: 3,
      createdById: ownerId,
    });

    const rows = await prisma.contentConcept.findMany({
      where: { workspaceId, batchId: res.batchId },
      orderBy: { ordinal: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.angle)).toEqual(['curiosity', 'engineering', 'sensory']);
    expect(rows.every((r) => r.status === 'PROPOSED')).toBe(true);
    expect(rows.every((r) => r.reviewedAt === null && r.reviewedById === null)).toBe(true);

    // The shot plan survives the JSONB round trip WITH the two text channels
    // kept apart — the reason `onScreenText` was added to `Shot` at all.
    const plan = rows[0].shotPlan as unknown as {
      shots: Array<{ onScreenText?: string; voiceover: string; prompt: string; durationSec: number }>;
      durationSec: number;
    };
    expect(plan.shots).toHaveLength(3);
    expect(plan.shots[0].onScreenText).toBe('Bunun motoru yok.');
    expect(plan.shots[0].voiceover).toBe('');
    expect(plan.shots[2].voiceover).toBe('Theo Jansen 1990ta tasarladı');
    expect(plan.shots.map((s) => s.durationSec)).toEqual([2, 3, 4]);
    expect(plan.durationSec).toBe(9);
    expect(plan.shots[0].prompt).toMatch(/vertical 9:16/);

    // And the silent concept stayed silent through the round trip.
    const silent = rows[2].shotPlan as unknown as { shots: Array<{ voiceover: string }> };
    expect(silent.shots.every((s) => s.voiceover === '')).toBe(true);
  });

  it('bounds an unshootable beat BEFORE it reaches the JSONB column', async () => {
    // 1800s and 0.4s both came back from a real, well-formed batch. Neither can
    // be generated (`jeeta.generate_video` is int 1-10, MediaGenService clamps
    // to MEDIA_GEN_MAX_VIDEO_SEC), and a concept is decided once — so an
    // APPROVED row carrying one has no path back. Asserted against what
    // Postgres actually stored, not against the in-memory return value.
    const junk = [
      {
        ...GOOD_CONCEPTS[0],
        shots: [
          { ...GOOD_CONCEPTS[0].shots[0], durationSec: 1800 },
          { ...GOOD_CONCEPTS[0].shots[1], durationSec: 0.4 },
        ],
      },
      GOOD_CONCEPTS[1],
      GOOD_CONCEPTS[2],
    ];
    const { svc } = svcWith(submission(junk));
    const res = await svc.planConcepts(workspaceId, {
      idea: SHARED_IDEA,
      count: 3,
      createdById: ownerId,
    });

    const stored = await prisma.contentConcept.findFirst({
      where: { workspaceId, batchId: res.batchId, ordinal: 0 },
    });
    const plan = stored!.shotPlan as unknown as {
      shots: Array<{ durationSec: number }>;
      durationSec: number;
    };
    expect(plan.shots.map((s) => s.durationSec)).toEqual([MAX_SHOT_SEC, MIN_SHOT_SEC]);
    expect(plan.durationSec).toBe(MAX_SHOT_SEC + MIN_SHOT_SEC);
  });

  it('charges the workspace for the call it actually made', async () => {
    const before = await prisma.usageCounter.findFirst({
      where: { workspaceId, metric: 'ai.credits' },
    });
    const { svc } = svcWith(submission(GOOD_CONCEPTS));
    await svc.planConcepts(workspaceId, { idea: SHARED_IDEA, count: 3, createdById: ownerId });
    const after = await prisma.usageCounter.findFirst({
      where: { workspaceId, metric: 'ai.credits' },
    });
    expect(after).toBeTruthy();
    expect(after!.value).toBeGreaterThan(before?.value ?? 0);
  });

  // ─────────────────────────────────────────────────────── tenant isolation
  //
  // One assertion per predicate. The probe row is cross-stamped on batch,
  // status, idea, angle and hook, so ONLY the workspace clause can exclude it.

  it('list: the workspace clause is the only thing hiding the neighbour batch', async () => {
    const ours = await reader().list(workspaceId, { batchId: SHARED_BATCH });

    // Both workspaces own a row in this batch. Ours is the only one returned.
    expect(ours.map((c) => c.id)).toEqual([ourSeededConcept]);
    expect(ours.map((c) => c.id)).not.toContain(neighbourProbe);

    // Proof the probe is really there and really matches on everything else —
    // otherwise the assertion above could be passing for the wrong reason.
    const theirs = await prisma.contentConcept.findMany({ where: { batchId: SHARED_BATCH } });
    expect(theirs).toHaveLength(2);
    expect(theirs.map((c) => c.hook)).toEqual(['Bunun motoru yok.', 'Bunun motoru yok.']);
  });

  it('list by status: the workspace clause survives being narrowed further', async () => {
    const svc = reader();
    const ours = await svc.list(workspaceId, { status: 'PROPOSED' });
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((c) => c.workspaceId === workspaceId)).toBe(true);
    expect(ours.map((c) => c.id)).not.toContain(neighbourProbe);
  });

  it('review: refuses the neighbour concept BY ID and leaves it untouched', async () => {
    const svc = reader();
    // The row matches on id, so `workspaceId` is the only clause that can
    // refuse it — its own assertion, separate from the list ones above.
    await expect(
      svc.review(workspaceId, neighbourProbe, { decision: 'APPROVED', reviewerId: ownerId }),
    ).rejects.toThrow(NotFoundException);

    // Refusing to READ it is half the property; the other half is that nothing
    // was WRITTEN. A `findFirst` guard followed by an unscoped `update` would
    // pass the throw assertion and still corrupt the neighbour's row.
    const probe = await prisma.contentConcept.findUnique({ where: { id: neighbourProbe } });
    expect(probe!.status).toBe('PROPOSED');
    expect(probe!.reviewedAt).toBeNull();
    expect(probe!.reviewedById).toBeNull();
  });

  it('review: decides OUR concept, stamps the person, and refuses a second decision', async () => {
    const svc = reader();
    const decided = await svc.review(workspaceId, ourSeededConcept, {
      decision: 'APPROVED',
      reviewerId: ownerId,
      note: 'bu güzelmiş',
    });
    expect(decided.status).toBe('APPROVED');
    expect(decided.reviewedById).toBe(ownerId);
    expect(decided.reviewedAt).toBeInstanceOf(Date);
    expect(decided.reviewNote).toBe('bu güzelmiş');
    // Stage 2: the verdict and the campaign item are one decision. The item
    // chain has its own suite (concept-promotion.realdb); what is asserted here
    // is only that approving still means what it meant AND now produces.
    expect((decided as { campaignItem?: { id: string } }).campaignItem?.id).toBeTruthy();

    // The neighbour's same-batch row is still where it was.
    const probe = await prisma.contentConcept.findUnique({ where: { id: neighbourProbe } });
    expect(probe!.status).toBe('PROPOSED');

    await expect(
      svc.review(workspaceId, ourSeededConcept, { decision: 'DISCARDED', reviewerId: ownerId }),
    ).rejects.toThrow(/already/i);
  });

  it('review: two people deciding at once produce ONE verdict, not the last write', async () => {
    // Check-then-act cannot be tested against a mock — both callers pass the
    // check and both writes "succeed" there. Only real row locking settles it:
    // the conditional write's `status: 'PROPOSED'` predicate is re-checked
    // against the committed row, so the loser matches nothing.
    const racedId = randomUUID();
    await prisma.contentConcept.create({
      data: {
        id: racedId,
        workspaceId,
        batchId: randomUUID(),
        sourceIdea: SHARED_IDEA,
        angle: 'race',
        hook: 'Ayni anda iki kisi karar verirse ne olur?',
        title: 'Race',
        ordinal: 0,
        shotPlan: { model: 'seedance', durationSec: 4, shots: [], captionSuggestion: '', qcChecklist: [] },
        socialCampaignId: campaignId,
        createdById: ownerId,
      },
    });

    const svc = reader();
    const [a, b] = await Promise.allSettled([
      svc.review(workspaceId, racedId, { decision: 'APPROVED', reviewerId: ownerId, note: 'kabul' }),
      svc.review(workspaceId, racedId, { decision: 'DISCARDED', reviewerId: ownerId, note: 'ret' }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason?.message)).toMatch(/already/i);

    // And the row carries exactly the winner's verdict — not a status from one
    // decision with a note from the other.
    const row = await prisma.contentConcept.findUnique({ where: { id: racedId } });
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string; reviewNote: string | null }>)
      .value;
    expect(row!.status).toBe(winner.status);
    expect(row!.reviewNote).toBe(winner.reviewNote);
    expect(row!.reviewNote).toBe(row!.status === 'APPROVED' ? 'kabul' : 'ret');
  });

  // ────────────────────────────────────────────────── error is not emptiness

  it('refuses a paraphrase batch and leaves the table exactly as it was', async () => {
    const before = await prisma.contentConcept.count({ where: { workspaceId } });
    const { svc } = svcWith(submission(PARAPHRASES));

    await expect(
      svc.planConcepts(workspaceId, { idea: SHARED_IDEA, count: 3, createdById: ownerId }),
    ).rejects.toThrow(BadRequestException);

    expect(await prisma.contentConcept.count({ where: { workspaceId } })).toBe(before);
  });

  it('writes ALL of a batch or none of it', async () => {
    // The break is injected by wrapping the REAL client so that ONLY
    // `contentConcept.createMany` rejects — every other read in this call still
    // goes to Postgres. (jest.spyOn on `prisma.contentConcept` does not stick:
    // Prisma builds its delegates behind a property accessor, so the spy lands
    // on an object the service never sees. A spec written that way passes while
    // testing nothing.)
    const before = await prisma.contentConcept.count({ where: { workspaceId } });
    const broken = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'contentConcept') {
          const real = Reflect.get(target, prop, receiver);
          return {
            ...real,
            createMany: () => Promise.reject(new Error('content_concepts table on fire')),
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaService;

    const { svc } = svcWith(submission(GOOD_CONCEPTS), broken);
    await expect(
      svc.planConcepts(workspaceId, { idea: SHARED_IDEA, count: 3, createdById: ownerId }),
    ).rejects.toThrow(/on fire/);

    // No partial batch. A per-row loop would have left some behind.
    expect(await prisma.contentConcept.count({ where: { workspaceId } })).toBe(before);
  });

  it('says the MODEL failed, not that the idea was weak, and refunds the turn', async () => {
    const counterBefore = await prisma.usageCounter.findFirst({
      where: { workspaceId, metric: 'ai.credits' },
    });
    const { svc } = svcWith(() => Promise.reject(new Error('anthropic 529 overloaded')));

    await expect(
      svc.planConcepts(workspaceId, { idea: SHARED_IDEA, count: 3, createdById: ownerId }),
    ).rejects.toThrow(/529/);

    // A call that never returned is not vendor spend: the reserve is given back,
    // so the counter lands exactly where it started.
    const counterAfter = await prisma.usageCounter.findFirst({
      where: { workspaceId, metric: 'ai.credits' },
    });
    expect(counterAfter?.value ?? 0).toBe(counterBefore?.value ?? 0);
  });

  it('never reports an empty batch as a finished one', async () => {
    const before = await prisma.contentConcept.count({ where: { workspaceId } });
    const { svc } = svcWith(submission([]));
    await expect(
      svc.planConcepts(workspaceId, { idea: SHARED_IDEA, count: 3, createdById: ownerId }),
    ).rejects.toThrow(/produced no concepts/i);
    expect(await prisma.contentConcept.count({ where: { workspaceId } })).toBe(before);
  });
});
