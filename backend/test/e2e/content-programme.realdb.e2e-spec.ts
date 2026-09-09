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
} from '../../src/modules/marketing/content-concepts/concept-promotion.service';
import { StoryboardService } from '../../src/modules/marketing/content-concepts/storyboard.service';
import { CONCEPT_STORYBOARD_KIND } from '../../src/modules/marketing/content-concepts/storyboard-frames';
import { AnglePerformanceService } from '../../src/modules/marketing/content-concepts/angle-performance.service';
import { CampaignItemArmingService } from '../../src/modules/marketing/social-campaigns/campaign-item-arming.service';
import { SocialCampaignsService } from '../../src/modules/marketing/social-campaigns/social-campaigns.service';
import { DEFAULT_VIDEO_MODEL } from '../../src/modules/marketing/ai/media/media-models.config';
import { creditCost } from '../../src/modules/marketing/ai/ai-credit-costs';
import { ContentProgrammeService } from '../../src/modules/marketing/content-programme/content-programme.service';
import { ContentTypesService } from '../../src/modules/marketing/content-programme/content-types.service';
import { DEFAULT_CONTENT_TYPES } from '../../src/modules/marketing/content-programme/content-types.seed';
import { ProgrammeLearningService } from '../../src/modules/marketing/content-programme/programme-learning.service';
import {
  ProgrammePlannerService,
  CONTENT_SLOT_PLAN_KIND,
  CONTENT_SLOT_PRODUCE_KIND,
  slotPlanDedup,
  slotProduceDedup,
} from '../../src/modules/marketing/content-programme/programme-planner.service';
import { SlotProducerService } from '../../src/modules/marketing/content-programme/slot-producer.service';
import { SlotEditorService } from '../../src/modules/marketing/content-programme/slot-editor.service';
import { ProgrammeDashboardService } from '../../src/modules/marketing/content-programme/programme-dashboard.service';
import { TrendSignalService } from '../../src/modules/marketing/trends/trend-signal.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * İçerik Programı — the whole autonomous loop, in order, against REAL Postgres.
 *
 *   create → fill → (planTick is a no-op) → planSlot → produceSlot → cap →
 *   settle → measure → reweight → editor → dashboard → tenant → kill
 *
 * Why real SQL and not the unit suites next to each service:
 *
 * 1. **Money.** The programme is the one lane that spends credits with no
 *    human gate. What holds it is a weekly cap computed by SUMMING a column
 *    over an Istanbul week, a `decideByProgramme` that runs the campaign
 *    pre-flight with the plan's quote, and a promotion under a UNIQUE index.
 *    A mocked Prisma answers whatever the test wrote; only real rows say what
 *    the sum was, whether the item got the SLOT's time, and whether the cap
 *    refusal really left no item behind.
 * 2. **Every link in the chain is a soft reference.** slot → concept → item →
 *    post → target → metric → stat: plain id columns, no foreign keys, each
 *    read hand-scoped by `workspaceId`. The neighbour workspace below exists so
 *    `get` and `slotMetrics` are shown to refuse by predicate, not by luck.
 * 3. **The calendar's idempotency is `(programmeId, scheduledFor)`.** A second
 *    fill must create nothing, and only the unique index makes that true under
 *    two concurrent ticks.
 * 4. **The learning loop writes what the planner then READS.** `reweight`
 *    writes ContentTypeStat rows; `currentArms` reads them back, distinct per
 *    key, newest first — a Prisma `distinct` + `orderBy` that a mock cannot
 *    exercise.
 *
 * Seams cut, exactly as the sibling suites cut them: `AnthropicService` (the
 * concept batch is a fixed submission), `MediaGenService` (fal.ai charges
 * money; IMAGE requests finish as READY rows), and `ScheduledJobService` for
 * the programme's own jobs (recorded, never run — the booted app's real runner
 * must not claim a slot job mid-suite and buy clips through the real media
 * service). `ContentProgrammeService`, `ContentTypesService`,
 * `ProgrammeLearningService`, `TrendSignalService`, `SocialCampaignsService`,
 * `AiCreditsService` and `VideoPipelineService` are the app's own.
 *
 * Every assertion reads a row back through Prisma. Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

/** A fixed Monday 09:00 Istanbul (06:00Z). The Istanbul week is Sun 21:00Z → Sun 21:00Z. */
const NOW = new Date('2026-09-14T06:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** What every planSlot books before the frames: the concept batch. */
const BATCH_COST = creditCost('content.concepts');
type QuotedPlan = { shots: unknown[]; production?: { credits?: number; keyframes?: { credits: number } } };

/**
 * Three concepts under the `hook-story` type (the seed's first format, which
 * SEED round-robin picks for slot 0): four beats, 3/7/3/2 s, three genuinely
 * different angles and hooks so the distinctness contract passes and the
 * hook-Jaccard pick keeps the first.
 */
const PROGRAMME_CONCEPTS = [
  {
    angle: 'curiosity',
    hook: 'Bu kutuyu kimse açamıyordu.',
    title: 'Açılmayan kutu',
    rationale: 'Merakla açar, kilidin çözüldüğü anla kapatır.',
    shots: [
      { scene: '0-3s', cameraNote: 'yakın plan yüz', onScreenText: 'Bu kutuyu kimse açamıyordu.', voiceover: '', description: 'bir kişi tahta kutuyu zorluyor, kaşlar çatık', durationSec: 3 },
      { scene: '3-10s', cameraNote: 'omuz üstü', onScreenText: '', voiceover: 'Üç gün uğraştım', description: 'masada dağınık aletler, kutu ortada, kişi denemeler yapıyor', durationSec: 7 },
      { scene: '10-13s', cameraNote: 'makro', onScreenText: 'Tek hamle.', voiceover: '', description: 'ürün kilide dokunur, kapak açılır', durationSec: 3 },
      { scene: '13-15s', cameraNote: 'sabit', onScreenText: 'Linki bio\'da', voiceover: '', description: 'marka logosu ve ürün açık kutunun yanında', durationSec: 2 },
    ],
  },
  {
    angle: 'empathy',
    hook: 'Sabah altıda ağlayan bebek ve ben.',
    title: 'Altıdaki nöbet',
    rationale: 'Ebeveynin yorgunluğuna eşlik eder; ürün nefes aldırır.',
    shots: [
      { scene: '0-3s', cameraNote: 'el kamerası', onScreenText: 'Sabah 06:00', voiceover: '', description: 'loş oda, annenin gözleri, beşikten ses geliyor', durationSec: 3 },
      { scene: '3-10s', cameraNote: 'takip', onScreenText: '', voiceover: 'Her sabah aynı koşuşturma', description: 'mutfakta biberon hazırlığı, saat, dökülen süt', durationSec: 7 },
      { scene: '10-13s', cameraNote: 'geniş', onScreenText: 'Bir dokunuş.', voiceover: '', description: 'cihaz ısıtmayı bitirir, anne rahat nefes alır', durationSec: 3 },
      { scene: '13-15s', cameraNote: 'sabit', onScreenText: 'Deneyin', voiceover: '', description: 'ürün ve marka, sıcak ışık', durationSec: 2 },
    ],
  },
  {
    angle: 'humor',
    hook: 'Kedim benden daha düzenli.',
    title: 'Kedinin düzeni',
    rationale: 'Komik karşıtlıkla ürünün düzen fikrini taşır.',
    shots: [
      { scene: '0-3s', cameraNote: 'alçak açı', onScreenText: 'Kedim benden daha düzenli.', voiceover: '', description: 'kedi rafın üstünde oturuyor, altında dağınık çorap yığını', durationSec: 3 },
      { scene: '3-10s', cameraNote: 'hızlı kesmeler', onScreenText: '', voiceover: 'Ben mi kediye yetişemiyorum?', description: 'sahibi dolabı karıştırıyor, kedi izliyor, eşyalar düşüyor', durationSec: 7 },
      { scene: '10-13s', cameraNote: 'sabit', onScreenText: 'Sonunda.', voiceover: '', description: 'organizer takılır, çoraplar sıraya girer, kedi onaylar', durationSec: 3 },
      { scene: '13-15s', cameraNote: 'sabit', onScreenText: 'Bio linki', voiceover: '', description: 'ürün etiketi ve marka', durationSec: 2 },
    ],
  },
];

const submission = (concepts: unknown[]) => ({
  text: '',
  toolUses: [{ id: 'tu1', name: 'submit_concepts', input: { concepts } }],
  stopReason: 'tool_use',
  usage: { input: 100, output: 900 },
});

describeRealDb('Content programme — the autonomous loop on real rows (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let credits: AiCreditsService;
  let pipeline: VideoPipelineService;
  let programmes: ContentProgrammeService;
  let types: ContentTypesService;
  let learning: ProgrammeLearningService;
  let trends: TrendSignalService;
  let socialCampaigns: SocialCampaignsService;
  let anglePerformance: AnglePerformanceService;

  let planner: ProgrammePlannerService;
  let producer: SlotProducerService;
  let editor: SlotEditorService;
  let dashboard: ProgrammeDashboardService;
  let promotion: ConceptPromotionService;

  const SEED = `prog-${randomUUID().slice(0, 8)}`;
  const workspaceId = randomUUID(); // ours
  const otherWorkspaceId = randomUUID(); // the neighbour
  const packageId = randomUUID();
  const ownerId = randomUUID();
  const accountId = randomUUID();
  const otherAccountId = randomUUID();

  // Written by the chain, read by the later steps.
  let programmeId: string;
  let campaignId: string;
  let slotIds: string[] = []; // calendar order
  let chosenConceptId: string;
  let itemId: string;
  let slot1Quote: number;
  /** The frames inside slot 1's quote, booked at plan time; the clips are the rest. */
  let slot1Frames: number;
  /** What slot 2 (planned, then capped) cost the week: its batch and frames.
   *  Its clips were never bought, but its batch and frames were — and they stay counted. */
  let slot2Spent: number;

  /** Every generation this suite performs, so a test can read the arguments. */
  let requests: Array<{ workspaceId: string; dto: Record<string, unknown> }> = [];
  const fakeMediaGen = {
    requestGeneration: jest.fn(async (ws: string, dto: Record<string, unknown>) => {
      requests.push({ workspaceId: ws, dto });
      const assetId = `asset-${requests.length}-${randomUUID().slice(0, 6)}`;
      // A storyboard FRAME is read back off its row before the beat is
      // animated, so the fake finishes one instantly — READY, with a URL.
      if (dto.type === 'IMAGE') {
        await prisma.generatedAsset.create({
          data: {
            id: assetId,
            workspaceId: ws,
            type: 'IMAGE',
            status: 'READY',
            provider: 'fal',
            model: String(dto.model),
            prompt: String(dto.prompt ?? ''),
            url: `https://r2.test/${assetId}.png`,
            createdById: String(dto.createdById),
            socialCampaignId: (dto.socialCampaignId as string | undefined) ?? null,
          },
        });
      }
      return { assetId };
    }),
    workspaceDefaultModel: jest.fn().mockResolvedValue(DEFAULT_VIDEO_MODEL),
  };

  /** The programme's own queue, recorded rather than run. */
  const scheduled: Array<Record<string, unknown>> = [];
  const cancelled: Array<{ kind: string; dedupKey: string }> = [];
  const fakeJobs = {
    schedule: jest.fn(async (opts: Record<string, unknown>) => {
      scheduled.push(opts);
      return `job-${scheduled.length}`;
    }),
    cancel: jest.fn(async (kind: string, dedupKey: string) => {
      cancelled.push({ kind, dedupKey });
      return true;
    }),
  };
  const fakeRunner = { registerHandler: jest.fn() };

  const fakeAnthropic = {
    isEnabled: () => true,
    complete: jest.fn().mockResolvedValue(submission(PROGRAMME_CONCEPTS)),
  };

  const slot = (id: string) => prisma.contentSlot.findUniqueOrThrow({ where: { id } });
  const programme = () => prisma.contentProgramme.findUniqueOrThrow({ where: { id: programmeId } });
  const events = (kind: string) =>
    prisma.contentProgrammeEvent.findMany({ where: { workspaceId, programmeId, kind }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    credits = app.get(AiCreditsService);
    pipeline = app.get(VideoPipelineService);
    programmes = app.get(ContentProgrammeService);
    types = app.get(ContentTypesService);
    learning = app.get(ProgrammeLearningService);
    trends = app.get(TrendSignalService);
    socialCampaigns = app.get(SocialCampaignsService);
    anglePerformance = app.get(AnglePerformanceService);

    // The programme's services, wired to the app's real collaborators and the
    // three fakes. Construction mirrors concept-promotion.realdb exactly.
    const arming = new CampaignItemArmingService(prisma, fakeJobs as never);
    promotion = new ConceptPromotionService(prisma, fakeMediaGen as never, fakeJobs as never, fakeRunner as never, arming);
    const concepts = new ContentConceptsService(prisma, fakeAnthropic as never, credits, pipeline, promotion, anglePerformance);
    const storyboard = new StoryboardService(prisma, fakeMediaGen as never, fakeJobs as never, fakeRunner as never);
    planner = new ProgrammePlannerService(prisma, fakeJobs as never, fakeRunner as never, programmes, types, learning, trends);
    planner.rng = () => 0.42;
    producer = new SlotProducerService(prisma, fakeJobs as never, fakeRunner as never, programmes, types, concepts, storyboard, promotion);
    editor = new SlotEditorService(prisma, fakeJobs as never, programmes, socialCampaigns, arming);
    dashboard = new ProgrammeDashboardService(prisma, programmes, types, trends, producer, planner);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Programme A', productName: 'Figurunica' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Programme B', productName: 'Next Door' },
      ],
    });
    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Programme Plan',
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
          currentPeriodStart: new Date(Date.now() - DAY),
          currentPeriodEnd: new Date(Date.now() + 30 * DAY),
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
    // One connected Instagram account each — the programme publishes to ours;
    // the neighbour's exists so nothing below can pass by being the only row.
    for (const [id, ws] of [
      [accountId, workspaceId],
      [otherAccountId, otherWorkspaceId],
    ] as const) {
      await prisma.socialAccount.create({
        data: {
          id,
          workspaceId: ws,
          network: 'INSTAGRAM',
          externalId: `${SEED}-${id.slice(0, 6)}`,
          displayName: 'acct',
          accessToken: 'sealed',
          enabled: true,
        },
      });
    }
  }, 120_000);

  beforeEach(() => {
    requests = [];
    scheduled.length = 0;
    cancelled.length = 0;
    fakeMediaGen.requestGeneration.mockClear();
    fakeJobs.schedule.mockClear();
    fakeJobs.cancel.mockClear();
    fakeAnthropic.complete.mockClear();
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    const both = { in: [workspaceId, otherWorkspaceId] };
    // Most-dependent first.
    await prisma.contentProgrammeEvent.deleteMany({ where: { workspaceId: both } });
    await prisma.contentTypeStat.deleteMany({ where: { workspaceId: both } });
    await prisma.contentSlot.deleteMany({ where: { workspaceId: both } });
    await prisma.contentProgramme.deleteMany({ where: { workspaceId: both } });
    await prisma.contentType.deleteMany({ where: { workspaceId: both } });
    await prisma.socialPostMetric.deleteMany({ where: { workspaceId: both } });
    await prisma.socialPostTarget.deleteMany({ where: { workspaceId: both } });
    await prisma.socialCampaignItem.deleteMany({ where: { workspaceId: both } });
    await prisma.socialPost.deleteMany({ where: { workspaceId: both } });
    await prisma.socialCampaign.deleteMany({ where: { workspaceId: both } });
    await prisma.socialAccount.deleteMany({ where: { workspaceId: both } });
    await prisma.contentConcept.deleteMany({ where: { workspaceId: both } });
    await prisma.generatedAsset.deleteMany({ where: { workspaceId: both } });
    await prisma.scheduledJob.deleteMany({ where: { workspaceId: both } });
    await prisma.usageCounter.deleteMany({ where: { workspaceId: both } });
    await prisma.aiUsageLog.deleteMany({ where: { workspaceId: both } });
    await prisma.marketingUser.deleteMany({ where: { id: ownerId } });
    await prisma.workspaceSubscription.deleteMany({ where: { workspaceId: both } });
    await prisma.package.deleteMany({ where: { id: packageId } });
    await prisma.workspace.deleteMany({ where: { id: both } });
    await closeTestApp(app);
  }, 120_000);

  // ───────────────────────────────────────────────────────────── 1. create

  it('create: one programme row, its campaign ACTIVE + FULL_AUTO with programmeId, ten seeded types, a CREATED event', async () => {
    const created = await programmes.create(workspaceId, {
      name: 'Figurunica autopilot',
      brief: 'El yapımı figürler; koleksiyoncular ve hediye arayanlar; sıcak, esprili ton.',
      accountIds: [accountId],
      perWeek: 5,
      timeOfDay: '18:00',
      goal: 'COMPOSITE',
      weeklyCreditCap: 600,
      createdById: ownerId,
    });
    programmeId = created.id;
    campaignId = created.socialCampaignId;

    const row = await programme();
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.status).toBe('ACTIVE');
    expect(row.killSwitch).toBe(false);
    expect(row.phase).toBe('SEED');
    expect(row.perWeek).toBe(5);
    expect(row.weeklyCreditCap).toBe(600);
    expect(row.editWindowHours).toBe(2);
    expect(row.lookaheadDays).toBe(14);

    const campaign = await prisma.socialCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.workspaceId).toBe(workspaceId);
    expect(campaign.status).toBe('ACTIVE');
    expect(campaign.automationMode).toBe('FULL_AUTO');
    expect(campaign.programmeId).toBe(programmeId);
    expect(campaign.targetAccountIds).toEqual([accountId]);
    // 18:00 was typed in Turkey time; the lane runs on UTC, so the campaign
    // carries 15:00 and remembers the typed 18:00 beside it.
    expect(campaign.cadence).toMatchObject({ daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '15:00', localTimeOfDay: '18:00', timezone: 'Europe/Istanbul' });

    // The seed, copied into OUR workspace only.
    const seeded = await prisma.contentType.findMany({ where: { workspaceId }, orderBy: { ordinal: 'asc' } });
    expect(seeded).toHaveLength(DEFAULT_CONTENT_TYPES.length);
    expect(seeded).toHaveLength(10);
    expect(seeded.map((t) => t.key)).toEqual(DEFAULT_CONTENT_TYPES.map((t) => t.key));
    expect(seeded.every((t) => t.active && t.isSeed)).toBe(true);
    expect(await prisma.contentType.count({ where: { workspaceId: otherWorkspaceId } })).toBe(0);

    const createdEvents = await events('CREATED');
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0].data).toMatchObject({ socialCampaignId: campaignId, accountIds: [accountId] });

    // `get` answers with this row and nothing else.
    const got = await programmes.get(workspaceId);
    expect(got?.id).toBe(programmeId);
  });

  // ─────────────────────────────────────────────────────────────── 2. fill

  it('fill: a PLANNED slot at every cadence time inside the look-ahead, typed with a reason, edit window and two jobs each; a second fill creates nothing', async () => {
    const before = await programme();
    const { created } = await planner.fill(workspaceId, before, NOW);

    const rows = await prisma.contentSlot.findMany({ where: { workspaceId, programmeId }, orderBy: { scheduledFor: 'asc' } });
    slotIds = rows.map((r) => r.id);
    expect(created).toBe(rows.length);
    // Mon 14 → Fri 25 September at 18:00Z, inside NOW + 14 days: ten slots.
    expect(rows).toHaveLength(10);
    const horizon = new Date(NOW.getTime() + before.lookaheadDays * DAY);
    for (const r of rows) {
      expect(r.status).toBe('PLANNED');
      expect(r.scheduledFor.getTime()).toBeGreaterThan(NOW.getTime());
      expect(r.scheduledFor.getTime()).toBeLessThanOrEqual(horizon.getTime());
      expect(r.scheduledFor.getUTCHours()).toBe(15); // 18:00 Istanbul
      expect(r.scheduledFor.getUTCMinutes()).toBe(0);
      expect([1, 2, 3, 4, 5]).toContain(r.scheduledFor.getUTCDay());
      expect(r.contentTypeKey).toBeTruthy();
      expect(r.selectionReason).toMatch(/seed round-robin/);
      expect(r.editableUntil.getTime()).toBe(r.scheduledFor.getTime() - before.editWindowHours * HOUR);
      expect(r.idea).toContain('Program brief');
      const type = await prisma.contentType.findFirstOrThrow({ where: { workspaceId, key: r.contentTypeKey } });
      expect(r.contentTypeId).toBe(type.id);
    }
    // SEED walks the seed in order, so every type gets exactly one slot.
    expect(rows.map((r) => r.contentTypeKey)).toEqual(DEFAULT_CONTENT_TYPES.map((t) => t.key));
    expect(rows[0].scheduledFor.toISOString()).toBe('2026-09-14T15:00:00.000Z');

    // Two jobs per slot, under the slot's own dedup keys, at its lead times
    // (clamped to now for a slot already inside its window).
    expect(scheduled).toHaveLength(rows.length * 2);
    for (const r of rows) {
      const plan = scheduled.find((j) => j.dedupKey === slotPlanDedup(r.id));
      const produce = scheduled.find((j) => j.dedupKey === slotProduceDedup(r.id));
      expect(plan).toMatchObject({ kind: CONTENT_SLOT_PLAN_KIND, workspaceId, payload: { workspaceId, slotId: r.id, programmeId } });
      expect(produce).toMatchObject({ kind: CONTENT_SLOT_PRODUCE_KIND, workspaceId, payload: { workspaceId, slotId: r.id, programmeId } });
      expect((plan!.runAt as Date).getTime()).toBe(Math.max(NOW.getTime(), r.scheduledFor.getTime() - before.planLeadHours * HOUR));
      expect((produce!.runAt as Date).getTime()).toBe(Math.max(NOW.getTime(), r.scheduledFor.getTime() - before.produceLeadHours * HOUR));
    }

    const planned = await events('SLOT_PLANNED');
    expect(planned).toHaveLength(1);
    expect(planned[0].data).toMatchObject({ created: rows.length });
    expect((await programme()).lastPlannedAt?.toISOString()).toBe(NOW.toISOString());

    // The unique (programmeId, scheduledFor) holds: a second sweep adds nothing.
    scheduled.length = 0;
    const again = await planner.fill(workspaceId, await programme(), NOW);
    expect(again.created).toBe(0);
    expect(await prisma.contentSlot.count({ where: { workspaceId, programmeId } })).toBe(rows.length);
    expect(scheduled).toHaveLength(0);
  });

  it('fill: the unique index, not a guard, refuses a duplicate slot time', async () => {
    const first = await slot(slotIds[0]);
    await expect(
      prisma.contentSlot.create({
        data: {
          workspaceId,
          programmeId,
          scheduledFor: first.scheduledFor,
          status: 'PLANNED',
          contentTypeId: first.contentTypeId,
          contentTypeKey: first.contentTypeKey,
          selectionReason: 'duplicate probe',
          idea: 'x',
          editableUntil: first.editableUntil,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // ─────────────────────────────────────────────────── 3. planTick no-op

  it('planTick on the programme campaign creates NO campaign item and does not reschedule', async () => {
    const result = await (socialCampaigns as unknown as {
      planTick: (campaignId: string, workspaceId: string) => Promise<unknown>;
    }).planTick(campaignId, workspaceId);
    expect(result).toBeUndefined();
    expect(await prisma.socialCampaignItem.count({ where: { socialCampaignId: campaignId } })).toBe(0);
    // And the lane was not COMPLETED or otherwise touched by the tick.
    const campaign = await prisma.socialCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('ACTIVE');
  });

  // ─────────────────────────────────────────────────────────── 4. planSlot

  it('planSlot: three concepts under the type, one kept with the slot stamped on it, two DISCARDED by the programme, slot IDEATED with the quote', async () => {
    const target = await slot(slotIds[0]);
    expect(target.contentTypeKey).toBe('hook-story');

    const result = await producer.planSlot(workspaceId, target.id, NOW);
    expect(result).toBeUndefined();
    expect(fakeAnthropic.complete).toHaveBeenCalledTimes(1);

    const after = await slot(target.id);
    expect(after.status).toBe('IDEATED');
    expect(after.conceptId).toBeTruthy();
    expect(after.error).toBeNull();
    chosenConceptId = after.conceptId as string;

    const batch = await prisma.contentConcept.findMany({ where: { workspaceId, programmeId, slotId: target.id }, orderBy: { ordinal: 'asc' } });
    expect(batch).toHaveLength(3);
    expect(batch.every((c) => c.contentTypeKey === 'hook-story' && c.programmeId === programmeId && c.slotId === target.id)).toBe(true);
    expect(batch.every((c) => c.socialCampaignId === campaignId)).toBe(true);

    const chosen = batch.find((c) => c.id === chosenConceptId)!;
    expect(chosen.status).toBe('PROPOSED');
    expect(chosen.hook).toBe(PROGRAMME_CONCEPTS[0].hook);
    const plan = chosen.shotPlan as QuotedPlan;
    expect(plan.shots).toHaveLength(4);
    expect(typeof plan.production?.credits).toBe('number');
    slot1Quote = Math.round(plan.production!.credits!);
    slot1Frames = plan.production!.keyframes?.credits ?? 0;
    expect(slot1Quote).toBeGreaterThan(0);
    expect(after.quotedCredits).toBe(slot1Quote);
    // The money that is spent at plan time is on the row: the batch, and the
    // frames the storyboard job will draw. The clips are not — not yet.
    expect(after.spentCredits).toBe(BATCH_COST + slot1Frames);

    const others = batch.filter((c) => c.id !== chosenConceptId);
    expect(others).toHaveLength(2);
    for (const o of others) {
      expect(o.status).toBe('DISCARDED');
      expect(o.reviewedById).toBe(`programme:${programmeId}`);
      expect(o.reviewNote).toBe('programme: not selected');
      expect(o.reviewedAt?.toISOString()).toBe(NOW.toISOString());
    }

    // The storyboard was requested (frames are the job's to draw, nothing
    // bought here), and produce was re-armed under the slot's dedup key.
    expect(fakeMediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(scheduled.some((j) => j.kind === CONCEPT_STORYBOARD_KIND)).toBe(true);
    expect(scheduled.some((j) => j.kind === CONTENT_SLOT_PRODUCE_KIND && j.dedupKey === slotProduceDedup(target.id))).toBe(true);

    const ideated = await events('SLOT_IDEATED');
    expect(ideated).toHaveLength(1);
    expect(ideated[0].data).toMatchObject({ slotId: target.id, conceptId: chosenConceptId, quotedCredits: slot1Quote });
  });

  // ──────────────────────────────────────────────────────── 5. produceSlot

  it('produceSlot: the programme approves the concept by name, promotes it AT THE SLOT TIME, slot PRODUCING with the item', async () => {
    const target = await slot(slotIds[0]);
    await producer.produceSlot(workspaceId, target.id, NOW);

    const concept = await prisma.contentConcept.findUniqueOrThrow({ where: { id: chosenConceptId } });
    expect(concept.status).toBe('APPROVED');
    expect(concept.reviewedById).toBe(`programme:${programmeId}`);
    expect(concept.reviewNote).toBe('programme autopilot');

    const items = await prisma.socialCampaignItem.findMany({ where: { contentConceptId: chosenConceptId } });
    expect(items).toHaveLength(1);
    const item = items[0];
    itemId = item.id;
    expect(item.workspaceId).toBe(workspaceId);
    expect(item.socialCampaignId).toBe(campaignId);
    expect(item.scheduledFor.toISOString()).toBe(target.scheduledFor.toISOString());
    expect(item.status).toBe('GENERATING');
    expect(concept.promotedItemId).toBe(item.id);

    const after = await slot(target.id);
    expect(after.status).toBe('PRODUCING');
    expect(after.campaignItemId).toBe(item.id);
    expect(after.error).toBeNull();
    // The clips (quote minus the frames already booked) join the row's spend:
    // batch + frames + clips = batch + quote.
    expect(after.spentCredits).toBe(BATCH_COST + slot1Quote);

    // Production was handed to the queue — through the existing engine path,
    // under the item's dedup key — and nothing was bought synchronously.
    expect(scheduled.some((j) => j.kind === CONCEPT_PRODUCE_KIND)).toBe(true);
    expect(fakeMediaGen.requestGeneration).not.toHaveBeenCalled();

    const producing = await events('SLOT_PRODUCING');
    expect(producing).toHaveLength(1);
    expect(producing[0].data).toMatchObject({ slotId: target.id, conceptId: chosenConceptId, campaignItemId: item.id });
  });

  // ────────────────────────────────────────────────────────── 6. weekly cap

  it('weekly cap: produceSlot under a 10-credit cap SKIPs the slot by name, DISCARDS the concept, and creates no item', async () => {
    const target = await slot(slotIds[1]);
    expect(target.contentTypeKey).toBe('how-to');
    await producer.planSlot(workspaceId, target.id, NOW);
    const ideated = await slot(target.id);
    expect(ideated.status).toBe('IDEATED');
    const conceptId = ideated.conceptId as string;
    expect(ideated.quotedCredits).toBeGreaterThan(10);
    const plan2 = (await prisma.contentConcept.findUniqueOrThrow({ where: { id: conceptId } })).shotPlan as QuotedPlan;
    slot2Spent = BATCH_COST + (plan2.production?.keyframes?.credits ?? 0);
    expect(ideated.spentCredits).toBe(slot2Spent);

    // Below the service's own floor on purpose: this is the row the producer
    // reads, and the test is about what the producer does with it.
    await prisma.contentProgramme.update({ where: { id: programmeId }, data: { weeklyCreditCap: 10 } });
    scheduled.length = 0;

    await producer.produceSlot(workspaceId, target.id, NOW);

    const after = await slot(target.id);
    expect(after.status).toBe('SKIPPED');
    expect(after.error).toMatch(/weekly credit cap/);
    expect(after.campaignItemId).toBeNull();

    const concept = await prisma.contentConcept.findUniqueOrThrow({ where: { id: conceptId } });
    expect(concept.status).toBe('DISCARDED');
    expect(concept.reviewedById).toBe(`programme:${programmeId}`);
    expect(concept.reviewNote).toBe('programme: weekly credit cap');
    expect(concept.promotedItemId).toBeNull();

    expect(await prisma.socialCampaignItem.count({ where: { contentConceptId: conceptId } })).toBe(0);
    expect(await prisma.socialCampaignItem.count({ where: { socialCampaignId: campaignId } })).toBe(1);
    expect(scheduled).toHaveLength(0);
    expect(fakeMediaGen.requestGeneration).not.toHaveBeenCalled();

    const capped = await events('CAP_SKIPPED');
    expect(capped).toHaveLength(1);
    // What the job wanted to buy is the CLIPS: the quote minus the frames the
    // plan job already booked on the row.
    const slot2Clips = (ideated.quotedCredits as number) - (plan2.production?.keyframes?.credits ?? 0);
    expect(capped[0].data).toMatchObject({ slotId: target.id, cap: 10, wanted: slot2Clips });
    // The spend it refused against is the slot's WHOLE week as the rows hold
    // it: the first slot's batch, frames and clips, PLUS this slot's own batch
    // and frames — the sum the week would actually close on with the clips
    // added, so the week can never close above the cap.
    expect(capped[0].data).toMatchObject({ spent: BATCH_COST + slot1Quote + slot2Spent });
    // The capped slot keeps what it cost: the batch and the frames are not refunded.
    expect(after.spentCredits).toBe(slot2Spent);

    await prisma.contentProgramme.update({ where: { id: programmeId }, data: { weeklyCreditCap: 600 } });
  });

  // ──────────────────────────────────────────────────────────── 7. learning

  it('learning: production → reconcile READY → publish → settle PUBLISHED → measure MEASURED → reweight stats, and the planner reads them back', async () => {
    // The clips, through the real producer with the fake generator: the post
    // row is written by production, exactly as it would be in the lane.
    await promotion.produce(itemId, workspaceId);
    const produced = await prisma.socialCampaignItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(produced.status).not.toBe('FAILED');
    expect(produced.error).toBeNull();
    expect(produced.socialPostId).toBeTruthy();
    const postId = produced.socialPostId as string;
    expect(requests.filter((r) => r.dto.type === 'VIDEO')).toHaveLength(4);
    expect(requests.every((r) => r.dto.campaignItemId === itemId)).toBe(true);

    await planner.reconcile(workspaceId, await programme());
    const ready = await slot(slotIds[0]);
    expect(ready.status).toBe('READY');
    expect(ready.socialPostId).toBe(postId);
    expect(await events('SLOT_READY')).toHaveLength(1);

    // A publish, faked on the rows the publisher would write: the post is out
    // on the seeded Instagram account, 100 hours ago, with a day of metrics.
    const publishedAt = new Date(NOW.getTime() - 100 * HOUR);
    await prisma.socialPost.update({ where: { id: postId }, data: { status: 'PUBLISHED', publishedAt } });
    const target = await prisma.socialPostTarget.create({
      data: { workspaceId, postId, socialAccountId: accountId, network: 'INSTAGRAM', status: 'PUBLISHED', externalPostId: 'ig-1' },
    });
    await prisma.socialPostMetric.create({
      data: {
        workspaceId,
        targetId: target.id,
        date: new Date('2026-09-11T00:00:00.000Z'),
        impressions: 1000,
        reach: 800,
        engagements: 80,
        saves: 20,
        shares: 10,
        videoViews: 900,
      },
    });

    // settle: READY → PUBLISHED with the post's date.
    expect(await learning.settle(workspaceId, await programme())).toBe(1);
    const published = await slot(slotIds[0]);
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt?.toISOString()).toBe(publishedAt.toISOString());

    // measure: past maturity (72h < 100h) → MEASURED with a reward against the
    // network default baseline (this account has no other posts).
    expect(await learning.measureDue(workspaceId, await programme(), NOW)).toBe(1);
    const measured = await slot(slotIds[0]);
    expect(measured.status).toBe('MEASURED');
    expect(measured.measuredAt?.toISOString()).toBe(NOW.toISOString());
    expect(measured.reward).toBeGreaterThan(0);
    expect(measured.reward).toBeLessThanOrEqual(1);
    const breakdown = measured.rewardBreakdown as Record<string, Record<string, unknown>>;
    expect(breakdown.INSTAGRAM).toBeDefined();
    expect(breakdown.INSTAGRAM.engagementRate).toBeCloseTo(0.08);
    expect(breakdown.INSTAGRAM.impressions).toBe(1000);
    expect(breakdown.INSTAGRAM.baselineSource).toBe('network-default');
    expect(breakdown.INSTAGRAM.reward).toBe(measured.reward);
    expect((await programme()).lastMeasuredAt?.toISOString()).toBe(NOW.toISOString());
    expect(await events('MEASURE')).toHaveLength(1);

    // reweight: due on the first measurement; one stat row per active type
    // per network (ALL + INSTAGRAM), the measured type holding its sample.
    const result = await learning.reweight(workspaceId, await programme(), NOW);
    expect(result).not.toBeNull();
    expect(result!.folded).toBe(1);

    const stats = await prisma.contentTypeStat.findMany({ where: { workspaceId, programmeId } });
    expect(stats).toHaveLength(10 * 2);
    const forType = stats.filter((s) => s.contentTypeKey === 'hook-story');
    expect(forType.map((s) => s.network).sort()).toEqual(['ALL', 'INSTAGRAM']);
    for (const s of forType) {
      expect(s.samples).toBe(1);
      expect(s.alpha).toBeGreaterThan(1);
      expect(s.alpha).toBeCloseTo(1 + (measured.reward as number));
      expect(s.computedAt.toISOString()).toBe(NOW.toISOString());
    }
    // Every other type is still at the prior.
    for (const s of stats.filter((st) => st.contentTypeKey !== 'hook-story')) {
      expect(s.samples).toBe(0);
      expect(s.alpha).toBe(1);
      expect(s.beta).toBe(1);
    }
    const afterReweight = await programme();
    expect(afterReweight.lastReweightedAt?.toISOString()).toBe(NOW.toISOString());
    const reweights = await events('REWEIGHT');
    expect(reweights).toHaveLength(1);
    expect(reweights[0].data).toMatchObject({ folded: 1, networks: expect.arrayContaining(['ALL', 'INSTAGRAM']) });

    // What the planner will sample from next: the updated posterior, read back
    // distinct-per-type from the stat rows.
    const arms = await learning.currentArms(workspaceId, programmeId);
    const arm = arms.find((a) => a.key === 'hook-story')!;
    const allRow = forType.find((s) => s.network === 'ALL')!;
    expect(arm.alpha).toBe(allRow.alpha);
    expect(arm.beta).toBe(allRow.beta);
    expect(arm.samples).toBe(1);
    expect(arms.filter((a) => a.key !== 'hook-story').every((a) => a.alpha === 1 && a.samples === 0)).toBe(true);

    // Not due again for a week.
    expect(await learning.reweight(workspaceId, afterReweight, new Date(NOW.getTime() + DAY))).toBeNull();
  });

  // ────────────────────────────────────────────────────────────── 8. editor

  it('editor: the idea of a PLANNED slot changes; a frozen window is refused; skip cancels both slot jobs', async () => {
    const target = await slot(slotIds[2]);
    expect(target.status).toBe('PLANNED');

    const updated = await editor.updateSlot(workspaceId, target.id, { idea: 'Yeni fikir: atölyede boyama günü' }, ownerId, NOW);
    expect(updated.idea).toBe('Yeni fikir: atölyede boyama günü');
    const row = await slot(target.id);
    expect(row.idea).toBe('Yeni fikir: atölyede boyama günü');
    expect(row.status).toBe('PLANNED');
    expect(row.contentTypeKey).toBe(target.contentTypeKey);
    const edited = await events('SLOT_EDITED');
    expect(edited).toHaveLength(1);
    expect(edited[0].data).toMatchObject({ slotId: target.id, actorId: ownerId, changed: ['idea'] });

    // The window closed: the row says so and the editor refuses.
    await prisma.contentSlot.update({ where: { id: target.id }, data: { editableUntil: new Date(NOW.getTime() - HOUR) } });
    await expect(
      editor.updateSlot(workspaceId, target.id, { idea: 'Çok geç' }, ownerId, NOW),
    ).rejects.toThrow(BadRequestException);
    expect((await slot(target.id)).idea).toBe('Yeni fikir: atölyede boyama günü');

    // Skip: SKIPPED on the row, both jobs cancelled under the slot's keys.
    const skipped = await editor.skipSlot(workspaceId, target.id, ownerId, NOW);
    expect(skipped.status).toBe('SKIPPED');
    const after = await slot(target.id);
    expect(after.status).toBe('SKIPPED');
    expect(after.error).toBe(`skipped by ${ownerId}`);
    expect(cancelled).toEqual(
      expect.arrayContaining([
        { kind: CONTENT_SLOT_PLAN_KIND, dedupKey: slotPlanDedup(target.id) },
        { kind: CONTENT_SLOT_PRODUCE_KIND, dedupKey: slotProduceDedup(target.id) },
      ]),
    );
    expect(cancelled).toHaveLength(2);
    expect(await events('SLOT_SKIPPED')).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────── 9. dashboard

  it('dashboard: the slots, the types with shares summing to one over upcoming unskipped slots, the learning rows, this week\'s spend', async () => {
    const view = await dashboard.dashboard(workspaceId, await programme(), NOW);

    expect(view.status).toBe('ACTIVE');
    expect(view.killSwitch).toBe(false);
    expect(view.slots.map((s) => s.id)).toEqual(slotIds);
    const byId = new Map(view.slots.map((s) => [s.id, s]));
    expect(byId.get(slotIds[0])).toMatchObject({
      status: 'MEASURED', conceptId: chosenConceptId, campaignItemId: itemId, quotedCredits: slot1Quote, spentCredits: BATCH_COST + slot1Quote, editable: false,
    });
    expect(byId.get(slotIds[1])).toMatchObject({ status: 'SKIPPED', spentCredits: slot2Spent });
    expect(byId.get(slotIds[0])!.concept).toMatchObject({ hook: PROGRAMME_CONCEPTS[0].hook });
    expect(byId.get(slotIds[1])!.status).toBe('SKIPPED');
    expect(byId.get(slotIds[2])!.status).toBe('SKIPPED');
    expect(byId.get(slotIds[3])).toMatchObject({ status: 'PLANNED', editable: true });

    expect(view.types).toHaveLength(10);
    const total = view.types.reduce((s, t) => s + t.plannedShare, 0);
    expect(total).toBeCloseTo(1, 6);
    // Eight upcoming unskipped slots, one per type; the two skipped types have no share.
    const skippedKeys = new Set(['how-to', 'before-after']);
    for (const t of view.types) {
      expect(t.plannedShare).toBeCloseTo(skippedKeys.has(t.key) ? 0 : 1 / 8, 6);
    }
    const hookStory = view.types.find((t) => t.key === 'hook-story')!;
    expect(hookStory.samples).toBe(1);
    expect(hookStory.meanReward).not.toBeNull();

    expect(view.learning.phase).toBe((await programme()).phase);
    expect(view.learning.networks).toEqual(['ALL', 'INSTAGRAM']);
    expect(view.learning.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ typeKey: 'hook-story', network: 'ALL', samples: 1 }),
        expect.objectContaining({ typeKey: 'hook-story', network: 'INSTAGRAM', samples: 1 }),
      ]),
    );
    expect(view.learning.history).toHaveLength(1);
    expect(view.learning.history[0].computedAt).toBe(NOW.toISOString());

    expect(view.week.cap).toBe(600);
    // The week's spend is what was actually paid: the published slot's batch,
    // frames and clips, PLUS the capped slot's batch and frames — a skip does
    // not refund what was already bought. The owner-skipped slot cost nothing.
    const rows = await prisma.contentSlot.findMany({ where: { workspaceId, programmeId } });
    expect(view.week.spent).toBe(rows.reduce((n, r) => n + r.spentCredits, 0));
    expect(view.week.spent).toBe(BATCH_COST + slot1Quote + slot2Spent);
    expect(view.week.spent).toBeGreaterThan(slot1Quote);
    expect(view.events.some((e) => e.kind === 'REWEIGHT')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────── 10. tenants

  it('tenant isolation: the neighbour sees no programme and cannot read our slot', async () => {
    expect(await programmes.get(otherWorkspaceId)).toBeNull();
    await expect(programmes.getOrThrow(otherWorkspaceId, programmeId)).rejects.toThrow(NotFoundException);
    await expect(editor.slotMetrics(otherWorkspaceId, slotIds[0])).rejects.toThrow(NotFoundException);
    await expect(editor.updateSlot(otherWorkspaceId, slotIds[3], { idea: 'theirs' }, ownerId, NOW)).rejects.toThrow(NotFoundException);
    expect((await slot(slotIds[3])).idea).not.toBe('theirs');
    await expect(producer.planSlot(otherWorkspaceId, slotIds[3], NOW)).resolves.toBeUndefined();
    expect((await slot(slotIds[3])).status).toBe('PLANNED');
    expect(fakeAnthropic.complete).not.toHaveBeenCalled();

    // And the positive anchor: ours reads fine.
    const mine = await editor.slotMetrics(workspaceId, slotIds[0]);
    expect(mine.slot.id).toBe(slotIds[0]);
    expect(mine.concept?.id).toBe(chosenConceptId);
    expect(mine.item?.id).toBe(itemId);
    expect(mine.targets).toHaveLength(1);
    expect(mine.targets[0].latest?.impressions).toBe(1000);
  });

  // ─────────────────────────────────────────────────────────────── 11. kill

  it('kill: KILLED + killSwitch, campaign PAUSED, every open slot SKIPPED, and the planner then creates nothing', async () => {
    const openBefore = await prisma.contentSlot.count({ where: { workspaceId, programmeId, status: 'PLANNED' } });
    expect(openBefore).toBe(7);
    const countBefore = await prisma.contentSlot.count({ where: { workspaceId, programmeId } });

    const killed = await programmes.kill(workspaceId, programmeId);
    expect(killed.status).toBe('KILLED');

    const row = await programme();
    expect(row.status).toBe('KILLED');
    expect(row.killSwitch).toBe(true);
    const campaign = await prisma.socialCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('PAUSED');

    expect(await prisma.contentSlot.count({ where: { workspaceId, programmeId, status: 'PLANNED' } })).toBe(0);
    const swept = await prisma.contentSlot.findMany({ where: { workspaceId, programmeId, error: 'programme killed' } });
    expect(swept).toHaveLength(openBefore);
    expect(swept.every((s) => s.status === 'SKIPPED')).toBe(true);
    // The measured slot keeps its history.
    expect((await slot(slotIds[0])).status).toBe('MEASURED');
    const killEvents = await events('KILLED');
    expect(killEvents).toHaveLength(1);
    expect(killEvents[0].data).toMatchObject({ skippedSlots: openBefore });
    expect(await programmes.get(workspaceId)).toBeNull();

    // Nothing plans, produces or buys for a killed programme.
    scheduled.length = 0;
    await planner.runAll(NOW);
    expect(await prisma.contentSlot.count({ where: { workspaceId, programmeId } })).toBe(countBefore);
    expect(scheduled).toHaveLength(0);
    // The per-slot jobs read the flag themselves: a job that fires late for a
    // swept slot must not buy anything.
    await producer.planSlot(workspaceId, slotIds[3], NOW);
    await producer.produceSlot(workspaceId, slotIds[3], NOW);
    expect(fakeAnthropic.complete).not.toHaveBeenCalled();
    expect(fakeMediaGen.requestGeneration).not.toHaveBeenCalled();
    expect((await slot(slotIds[3])).status).toBe('SKIPPED');
  });
});
