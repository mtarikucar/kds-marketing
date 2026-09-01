import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AiCreditsService } from '../../src/modules/marketing/ai/ai-credits.service';
import { VideoPipelineService } from '../../src/modules/marketing/video/video-pipeline.service';
import { ContentConceptsService } from '../../src/modules/marketing/content-concepts/content-concepts.service';
import {
  ConceptPromotionService,
  CONCEPT_PRODUCE_KIND,
  produceDedup,
} from '../../src/modules/marketing/content-concepts/concept-promotion.service';
import { McpToolRegistry } from '../../src/modules/marketing/mcp/mcp-tool-registry';
import { registerContentTools } from '../../src/modules/marketing/mcp/tools/content.tools';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * APPROVED concept -> campaign item -> clips, against REAL Postgres.
 *
 * Four things only real SQL settles here.
 *
 * 1. **Idempotency is a UNIQUE INDEX, not a guard.** Promotion is
 *    read-then-create. Against a mock, two concurrent promotions both read "no
 *    item yet" and both create, and the suite goes green while the workspace
 *    pays for two sets of clips. The only mechanism that refuses the second is
 *    `social_campaign_items.contentConceptId`'s unique index, and only a real
 *    database has one. Both the sequential repeat and the simultaneous race are
 *    asserted here, by COUNTING rows.
 * 2. **Every tenant predicate on this path is hand-written.** `content_concepts`
 *    has no foreign key to `workspaces`, and `contentConceptId` /
 *    `promotedItemId` are soft references with no FK either, so nothing in the
 *    schema refuses a cross-tenant promotion. Each predicate therefore gets its
 *    OWN failing assertion against CROSS-STAMPED probe rows: the neighbour owns
 *    an APPROVED concept and an ACTIVE campaign that differ from ours in
 *    workspace and NOTHING else that a query filters on.
 * 3. **"FAILED with its reason" is a claim about a column.** Asserting it on a
 *    mock asserts that we called `update` with an object. Asserting it here
 *    reads the row back out of Postgres.
 * 4. **The clamped beat has to survive the whole chain.** Stage 1 clamps a
 *    duration on the way into JSONB; this reads it back out of the column,
 *    hands it to production, and then parses it against the ACTUAL zod schema
 *    of `jeeta.generate_video` — the thing that will shoot it.
 *
 * The seams cut are the two external vendors: `AnthropicService` (an LLM is not
 * a test fixture) and `MediaGenService` (fal.ai charges money). `PrismaService`,
 * `AiCreditsService` and `VideoPipelineService` are the real ones the app
 * booted. `ScheduledJobService` is stubbed on purpose rather than for
 * convenience: the booted app runs a real once-a-minute job runner, and a real
 * queued job could be claimed mid-suite and produce clips through the REAL
 * media service, which would make these tests flake on the clock.
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
      { scene: '0-4s', cameraNote: 'yakın plan eller', onScreenText: '', voiceover: 'Önce bir krank', description: 'elle çevrilen tek bacak', durationSec: 4 },
      { scene: '4-9s', cameraNote: 'sabit tripod', onScreenText: 'On bir çubuk.', voiceover: 'On bir çubuk', description: 'krankın bacağı ittiği an', durationSec: 5 },
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
    ],
  },
];

const submission = (concepts: unknown[]) => ({
  text: '',
  toolUses: [{ id: 'tu1', name: 'submit_concepts', input: { concepts } }],
  stopReason: 'tool_use',
  usage: { input: 100, output: 900 },
});

const PLAN_FOR = (hook: string) => ({
  model: 'seedance',
  durationSec: 9,
  captionSuggestion: `${hook} — link in bio.`,
  qcChecklist: ['aspect 9:16'],
  shots: [
    { ord: 0, scene: '0-2s', onScreenText: hook, voiceover: '', prompt: `${hook} shot one, vertical 9:16`, durationSec: 2, cameraNote: 'geniş' },
    { ord: 1, scene: '2-5s', onScreenText: '', voiceover: 'iki', prompt: `${hook} shot two, vertical 9:16`, durationSec: 3, cameraNote: 'makro' },
    { ord: 2, scene: '5-9s', onScreenText: '', voiceover: 'üç', prompt: `${hook} shot three, vertical 9:16`, durationSec: 4, cameraNote: 'alçak açı' },
  ],
});

describeRealDb('Concept promotion — approved idea to produced clips, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let credits: AiCreditsService;
  let pipeline: VideoPipelineService;

  const SEED = `promo-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID(); // ours
  const otherWorkspaceId = randomUUID(); // the neighbour
  const packageId = randomUUID();
  const ownerId = randomUUID();

  const campaignId = randomUUID(); // ours
  const otherCampaignId = randomUUID(); // theirs — cross-stamped
  const SHARED_IDEA = 'Theo Jansen Strandbeest — rüzgarla yürüyen, motoru olmayan kinetik heykel.';

  /** Every generation this suite performs, so a test can read the arguments. */
  let requests: Array<{ workspaceId: string; dto: Record<string, unknown> }> = [];
  let generationFails: Error | null = null;

  const fakeMediaGen = {
    requestGeneration: jest.fn(async (ws: string, dto: Record<string, unknown>) => {
      requests.push({ workspaceId: ws, dto });
      if (generationFails) throw generationFails;
      return { assetId: `asset-${requests.length}-${randomUUID().slice(0, 6)}` };
    }),
  };
  const scheduled: Array<Record<string, unknown>> = [];
  const fakeJobs = {
    schedule: jest.fn(async (opts: Record<string, unknown>) => {
      scheduled.push(opts);
      return 'job-1';
    }),
  };

  const promotionSvc = () =>
    new ConceptPromotionService(
      prisma,
      fakeMediaGen as never,
      fakeJobs as never,
      { registerHandler: () => undefined } as never,
    );

  const conceptsSvc = (completion?: unknown) =>
    new ContentConceptsService(
      prisma,
      {
        isEnabled: () => true,
        complete: jest.fn().mockResolvedValue(completion ?? submission(GOOD_CONCEPTS)),
      } as never,
      credits,
      pipeline,
      promotionSvc(),
    );

  /** An APPROVED concept, written straight in — the verdict is stage 1's job. */
  const seedApproved = async (over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const hook = `hook-${id.slice(0, 6)}`;
    await prisma.contentConcept.create({
      data: {
        id,
        workspaceId,
        batchId: randomUUID(),
        sourceIdea: SHARED_IDEA,
        angle: 'curiosity',
        hook,
        title: 'Seeded',
        ordinal: 0,
        shotPlan: PLAN_FOR(hook),
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedById: ownerId,
        socialCampaignId: campaignId,
        createdById: ownerId,
        ...over,
      },
    });
    return id;
  };

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    credits = app.get(AiCreditsService);
    pipeline = app.get(VideoPipelineService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Promo A', productName: 'Figurunica' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Promo B', productName: 'Next Door' },
      ],
    });

    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Promotion Plan',
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

    // THE CROSS-STAMPED CAMPAIGN PAIR. Same name, same status, same cadence,
    // same automation mode — everything except whose it is.
    for (const [id, ws] of [
      [campaignId, workspaceId],
      [otherCampaignId, otherWorkspaceId],
    ] as const) {
      await prisma.socialCampaign.create({
        data: {
          id,
          workspaceId: ws,
          name: 'Strandbeest',
          brief: { audience: 'makers' },
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
    }
  });

  beforeEach(() => {
    requests = [];
    generationFails = null;
    scheduled.length = 0;
    fakeMediaGen.requestGeneration.mockClear();
    fakeJobs.schedule.mockClear();
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    // Baseline restore, most-dependent first.
    const both = { in: [workspaceId, otherWorkspaceId] };
    await prisma.socialPost.deleteMany({ where: { workspaceId: both } });
    await prisma.socialCampaignItem.deleteMany({ where: { workspaceId: both } });
    await prisma.socialCampaign.deleteMany({ where: { workspaceId: both } });
    await prisma.contentConcept.deleteMany({ where: { workspaceId: both } });
    await prisma.usageCounter.deleteMany({ where: { workspaceId: both } });
    await prisma.aiUsageLog.deleteMany({ where: { workspaceId: both } });
    await prisma.marketingUser.deleteMany({ where: { id: ownerId } });
    await prisma.workspaceSubscription.deleteMany({ where: { workspaceId: both } });
    await prisma.package.deleteMany({ where: { id: packageId } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await closeTestApp(app);
  });

  // ───────────────────────────────────────────────────────────── idempotency

  it('promotes an approved concept into ONE item, and links both directions', async () => {
    const conceptId = await seedApproved();
    const { item, created } = await promotionSvc().promote(workspaceId, conceptId);

    expect(created).toBe(true);
    const row = await prisma.socialCampaignItem.findUnique({ where: { id: item.id } });
    expect(row!.contentConceptId).toBe(conceptId);
    expect(row!.socialCampaignId).toBe(campaignId);
    expect(row!.workspaceId).toBe(workspaceId);
    expect(row!.status).toBe('GENERATING');

    // The back-link was written in the same transaction, so it is committed too.
    const concept = await prisma.contentConcept.findUnique({ where: { id: conceptId } });
    expect(concept!.promotedItemId).toBe(item.id);

    // And production was handed to the queue under a per-item dedup key.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      kind: CONCEPT_PRODUCE_KIND,
      dedupKey: produceDedup(item.id),
      workspaceId,
    });
  });

  it('run twice, one item — the second run makes nothing and returns the first', async () => {
    const conceptId = await seedApproved();
    const svc = promotionSvc();

    const first = await svc.promote(workspaceId, conceptId);
    const second = await svc.promote(workspaceId, conceptId);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);

    // The property, counted in the table rather than inferred from a return
    // value: exactly one item names this concept, and no second production job
    // was queued to pay for a second set of clips.
    const items = await prisma.socialCampaignItem.findMany({ where: { contentConceptId: conceptId } });
    expect(items).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  it('two promotions at the SAME time still leave one item', async () => {
    // This is the case a read-then-create guard cannot pass and a mock cannot
    // detect: neither transaction can see the other's uncommitted row, so both
    // reads say "no item yet". Only the unique index refuses the second insert.
    const conceptId = await seedApproved();
    const svc = promotionSvc();

    const settled = await Promise.allSettled([
      svc.promote(workspaceId, conceptId),
      svc.promote(workspaceId, conceptId),
    ]);

    // Neither caller gets an error: the loser reads the winner's item back.
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = settled.map(
      (r) => (r as PromiseFulfilledResult<{ item: { id: string } }>).value.item.id,
    );
    expect(ids[0]).toBe(ids[1]);

    const items = await prisma.socialCampaignItem.findMany({ where: { contentConceptId: conceptId } });
    expect(items).toHaveLength(1);
  });

  it('a promotion whose item was deleted with its campaign can be produced again', async () => {
    // `promotedItemId` is a soft reference: the campaign cascade can take the
    // item away underneath it. Reporting "already promoted" then would be a
    // lie — the work no longer exists and the unique index is free again.
    const throwawayCampaign = randomUUID();
    await prisma.socialCampaign.create({
      data: {
        id: throwawayCampaign,
        workspaceId,
        name: 'Throwaway',
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
    const conceptId = await seedApproved({ socialCampaignId: throwawayCampaign });
    const svc = promotionSvc();
    const first = await svc.promote(workspaceId, conceptId);

    await prisma.socialCampaign.delete({ where: { id: throwawayCampaign } });
    expect(await prisma.socialCampaignItem.findUnique({ where: { id: first.item.id } })).toBeNull();

    // The concept still names the vanished item, and is still APPROVED.
    const stale = await prisma.contentConcept.findUnique({ where: { id: conceptId } });
    expect(stale!.promotedItemId).toBe(first.item.id);

    const second = await svc.promote(workspaceId, conceptId, { socialCampaignId: campaignId });
    expect(second.created).toBe(true);
    expect(second.item.id).not.toBe(first.item.id);
    const concept = await prisma.contentConcept.findUnique({ where: { id: conceptId } });
    expect(concept!.promotedItemId).toBe(second.item.id);
  });

  // ─────────────────────────────────────────────────────────── tenant lines
  //
  // One assertion per predicate, against rows cross-stamped on everything a
  // query could otherwise filter on.

  it('promote: the concept predicate refuses the neighbour BY ID and writes nothing', async () => {
    const theirs = randomUUID();
    await prisma.contentConcept.create({
      data: {
        id: theirs,
        workspaceId: otherWorkspaceId,
        batchId: randomUUID(),
        sourceIdea: SHARED_IDEA,
        angle: 'curiosity',
        hook: 'Bunun motoru yok.',
        title: 'Theirs',
        ordinal: 0,
        shotPlan: PLAN_FOR('theirs'),
        status: 'APPROVED',
        socialCampaignId: otherCampaignId,
        createdById: ownerId,
      },
    });

    await expect(promotionSvc().promote(workspaceId, theirs)).rejects.toThrow(NotFoundException);

    // Refusing to READ it is half of it; the other half is that nothing was
    // WRITTEN — no item for their concept, and no back-link on their row.
    expect(await prisma.socialCampaignItem.count({ where: { contentConceptId: theirs } })).toBe(0);
    const probe = await prisma.contentConcept.findUnique({ where: { id: theirs } });
    expect(probe!.promotedItemId).toBeNull();
  });

  it('promote: the CAMPAIGN predicate refuses producing our concept into their campaign', async () => {
    // Its own assertion, separate from the concept one above: the campaign id
    // is real and ACTIVE and identical to ours in every other column, so only
    // the workspace clause on the campaign read can refuse it.
    const conceptId = await seedApproved();

    await expect(
      promotionSvc().promote(workspaceId, conceptId, { socialCampaignId: otherCampaignId }),
    ).rejects.toThrow(BadRequestException);

    expect(await prisma.socialCampaignItem.count({ where: { socialCampaignId: otherCampaignId } })).toBe(0);
    const concept = await prisma.contentConcept.findUnique({ where: { id: conceptId } });
    expect(concept!.promotedItemId).toBeNull();
  });

  it('produce: the item predicate refuses the neighbour item BY ID', async () => {
    const theirConcept = randomUUID();
    await prisma.contentConcept.create({
      data: {
        id: theirConcept,
        workspaceId: otherWorkspaceId,
        batchId: randomUUID(),
        sourceIdea: SHARED_IDEA,
        angle: 'curiosity',
        hook: 'Theirs',
        title: 'Theirs',
        ordinal: 0,
        shotPlan: PLAN_FOR('theirs'),
        status: 'APPROVED',
        socialCampaignId: otherCampaignId,
        createdById: ownerId,
      },
    });
    const theirItem = await promotionSvc().promote(otherWorkspaceId, theirConcept);
    expect(theirItem.created).toBe(true);

    // OUR workspace, THEIR item id. Nothing generated, nothing written.
    await promotionSvc().produce(theirItem.item.id, workspaceId);
    expect(requests).toHaveLength(0);
    const row = await prisma.socialCampaignItem.findUnique({ where: { id: theirItem.item.id } });
    expect(row!.status).toBe('GENERATING');
    expect(row!.generatedAssetIds).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────── the clips

  it('produces one clip per beat and hands the item on at NEEDS_APPROVAL', async () => {
    const conceptId = await seedApproved();
    const svc = promotionSvc();
    const { item } = await svc.promote(workspaceId, conceptId);

    await svc.produce(item.id, workspaceId);

    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.workspaceId === workspaceId)).toBe(true);
    expect(requests.map((r) => r.dto.durationSec)).toEqual([2, 3, 4]);
    expect(requests.every((r) => r.dto.campaignItemId === item.id)).toBe(true);
    expect(requests.every((r) => r.dto.socialCampaignId === campaignId)).toBe(true);

    const row = await prisma.socialCampaignItem.findUnique({ where: { id: item.id } });
    expect(row!.status).toBe('NEEDS_APPROVAL');
    expect(row!.generatedAssetIds).toHaveLength(3);
    expect(row!.error).toBeNull();

    // The item is genuinely handed to the existing lifecycle: confirmItem
    // returns early without a socialPostId, so an item without one would stall
    // silently at the publish gate.
    expect(row!.socialPostId).toBeTruthy();
    const post = await prisma.socialPost.findUnique({ where: { id: row!.socialPostId! } });
    expect(post!.campaignItemId).toBe(item.id);
    expect(post!.socialCampaignId).toBe(campaignId);
    expect(post!.content).toContain('link in bio');
  });

  it('resumes from what Postgres says was already paid for', async () => {
    const conceptId = await seedApproved();
    const svc = promotionSvc();
    const { item } = await svc.promote(workspaceId, conceptId);

    // Two clips already bought, recorded on the row and then read back by the
    // producer — the cursor is the column, not an in-memory variable.
    await prisma.socialCampaignItem.update({
      where: { id: item.id },
      data: { generatedAssetIds: ['already-0', 'already-1'] },
    });

    await svc.produce(item.id, workspaceId);

    expect(requests).toHaveLength(1);
    expect(requests[0].dto.durationSec).toBe(4);
    const row = await prisma.socialCampaignItem.findUnique({ where: { id: item.id } });
    expect(row!.generatedAssetIds).toHaveLength(3);
    expect(row!.generatedAssetIds.slice(0, 2)).toEqual(['already-0', 'already-1']);
  });

  it('a second produce run on a finished item buys nothing', async () => {
    const conceptId = await seedApproved();
    const svc = promotionSvc();
    const { item } = await svc.promote(workspaceId, conceptId);

    await svc.produce(item.id, workspaceId);
    const afterFirst = await prisma.socialCampaignItem.findUnique({ where: { id: item.id } });
    requests = [];

    await svc.produce(item.id, workspaceId);

    expect(requests).toHaveLength(0);
    const afterSecond = await prisma.socialCampaignItem.findUnique({ where: { id: item.id } });
    expect(afterSecond!.generatedAssetIds).toEqual(afterFirst!.generatedAssetIds);
    expect(afterSecond!.socialPostId).toBe(afterFirst!.socialPostId);
    expect(await prisma.socialPost.count({ where: { campaignItemId: item.id } })).toBe(1);
  });

  // ────────────────────────────────────────────────── error is not emptiness

  it('a failed clip is FAILED IN THE COLUMN, with which beat and why', async () => {
    const conceptId = await seedApproved();
    const svc = promotionSvc();
    const { item } = await svc.promote(workspaceId, conceptId);
    generationFails = new Error('fal.ai rejected the prompt');

    await svc.produce(item.id, workspaceId);

    const row = await prisma.socialCampaignItem.findUnique({ where: { id: item.id } });
    expect(row!.status).toBe('FAILED');
    expect(row!.error).toMatch(/fal\.ai rejected the prompt/);
    expect(row!.error).toMatch(/1\/3/);
    // Not a half-finished-looking item: no post, no partial asset list posing
    // as a shorter concept.
    expect(row!.socialPostId).toBeNull();
    expect(await prisma.socialPost.count({ where: { campaignItemId: item.id } })).toBe(0);
  });

  it('a clip that fails halfway keeps the ones already paid for, and still FAILS', async () => {
    const conceptId = await seedApproved();
    const svc = promotionSvc();
    const { item } = await svc.promote(workspaceId, conceptId);
    let n = 0;
    fakeMediaGen.requestGeneration.mockImplementationOnce(async (ws: string, dto: Record<string, unknown>) => {
      requests.push({ workspaceId: ws, dto });
      n += 1;
      return { assetId: `asset-kept-${n}` };
    });
    generationFails = new Error('provider went away');

    await svc.produce(item.id, workspaceId);

    const row = await prisma.socialCampaignItem.findUnique({ where: { id: item.id } });
    expect(row!.status).toBe('FAILED');
    expect(row!.error).toMatch(/2\/3/);
    // The money already spent is still visible on the row — a FAILED item that
    // dropped its assets would orphan them and hide the spend.
    expect(row!.generatedAssetIds).toEqual(['asset-kept-1']);
  });

  it('an APPROVED concept with no campaign is refused by name, and stays approved', async () => {
    const conceptId = await seedApproved({ socialCampaignId: null });
    await expect(promotionSvc().promote(workspaceId, conceptId)).rejects.toThrow(/socialCampaignId/);
    const row = await prisma.contentConcept.findUnique({ where: { id: conceptId } });
    expect(row!.status).toBe('APPROVED');
    expect(row!.promotedItemId).toBeNull();
  });

  it('a PROPOSED concept is refused — production follows a human, not an id', async () => {
    const conceptId = await seedApproved({ status: 'PROPOSED', reviewedAt: null, reviewedById: null });
    await expect(promotionSvc().promote(workspaceId, conceptId)).rejects.toThrow(/PROPOSED/);
    expect(await prisma.socialCampaignItem.count({ where: { contentConceptId: conceptId } })).toBe(0);
  });

  // ───────────────────────────────────────────── the beat boundary, end to end

  it('an unshootable beat is clamped at planning and still shootable at generation', async () => {
    // Stage 1 clamps 1800s and 0.4s on the way INTO the JSONB column. This
    // reads what Postgres actually stored, drives the whole promotion chain
    // with it, and then parses each duration against the ACTUAL zod schema of
    // jeeta.generate_video — the contract of the thing that will shoot it.
    // Trusting the clamp is what the brief asked not to do.
    const junk = [
      {
        ...GOOD_CONCEPTS[0],
        shots: [
          { ...GOOD_CONCEPTS[0].shots[0], durationSec: 1800 },
          { ...GOOD_CONCEPTS[0].shots[1], durationSec: 0.4 },
          { ...GOOD_CONCEPTS[0].shots[2], durationSec: 10.4 },
        ],
      },
      GOOD_CONCEPTS[1],
      GOOD_CONCEPTS[2],
    ];
    const res = await conceptsSvc(submission(junk)).planConcepts(workspaceId, {
      idea: SHARED_IDEA,
      count: 3,
      createdById: ownerId,
      socialCampaignId: campaignId,
    });

    const conceptId = res.concepts[0].id;
    await prisma.contentConcept.update({
      where: { id: conceptId },
      data: { status: 'APPROVED', reviewedAt: new Date(), reviewedById: ownerId },
    });

    const svc = promotionSvc();
    const { item } = await svc.promote(workspaceId, conceptId);
    await svc.produce(item.id, workspaceId);

    const durations = requests.map((r) => r.dto.durationSec as number);
    expect(durations).toEqual([10, 1, 10]);

    // The real tool schema, not a restatement of it.
    const registry = new McpToolRegistry();
    registerContentTools(registry, {
      calendar: {} as never,
      media: {} as never,
      principals: {} as never,
      entitlements: {} as never,
    });
    const schema = registry.get('jeeta.generate_video')!.inputSchema;
    for (const durationSec of durations) {
      expect(() => schema.parse({ prompt: 'x', durationSec })).not.toThrow();
    }
    // And the guard is real: the value the model originally asked for is not.
    expect(() => schema.parse({ prompt: 'x', durationSec: 1800 })).toThrow();
  });

  // ──────────────────────────────────────────── the whole chain, from review

  it('review(APPROVED) is the only human step between an idea and its clips', async () => {
    const res = await conceptsSvc().planConcepts(workspaceId, {
      idea: SHARED_IDEA,
      count: 3,
      createdById: ownerId,
      socialCampaignId: campaignId,
    });
    const conceptId = res.concepts[1].id;

    const decided = (await conceptsSvc().review(workspaceId, conceptId, {
      decision: 'APPROVED',
      reviewerId: ownerId,
      note: 'bu güzelmiş',
    })) as { status: string; promotedItemId?: string; campaignItem?: { id: string } };

    expect(decided.status).toBe('APPROVED');
    const itemId = decided.campaignItem!.id;
    expect(decided.promotedItemId).toBe(itemId);

    const row = await prisma.socialCampaignItem.findUnique({ where: { id: itemId } });
    expect(row!.contentConceptId).toBe(conceptId);
    expect(row!.status).toBe('GENERATING');

    // The concept cannot be decided twice, so it cannot be produced twice
    // THROUGH review either — and promoting the same concept directly is still
    // a no-op, which is the property that matters if a retry ever gets here.
    await expect(
      conceptsSvc().review(workspaceId, conceptId, { decision: 'APPROVED', reviewerId: ownerId }),
    ).rejects.toThrow(/already/i);
    const again = await promotionSvc().promote(workspaceId, conceptId);
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(itemId);
    expect(await prisma.socialCampaignItem.count({ where: { contentConceptId: conceptId } })).toBe(1);

    // And the sibling concepts in the batch were not dragged along.
    const siblings = await prisma.contentConcept.findMany({
      where: { workspaceId, batchId: res.batchId, id: { not: conceptId } },
    });
    expect(siblings).toHaveLength(2);
    expect(siblings.every((c) => c.status === 'PROPOSED' && c.promotedItemId === null)).toBe(true);
  });
});
