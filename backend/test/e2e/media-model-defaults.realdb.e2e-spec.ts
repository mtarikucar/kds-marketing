import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AiCreditsService } from '../../src/modules/marketing/ai/ai-credits.service';
import { MediaGenService } from '../../src/modules/marketing/ai/media/media-gen.service';
import { MediaModelDefaultsService } from '../../src/modules/marketing/ai/media/media-model-defaults.service';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
} from '../../src/modules/marketing/ai/media/media-models.config';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * İçerik üretim hattı, aşama 3 — the workspace model default, against REAL
 * Postgres.
 *
 * Three things only real SQL settles here.
 *
 * 1. **The column round-trips.** `workspaces.defaultImageModel` /
 *    `defaultVideoModel` arrived in migration 20260901200000. A mocked Prisma
 *    accepts a write to a column that does not exist; Postgres does not.
 * 2. **The tenant predicate is real.** Both the read and the resolution are
 *    `findUnique({ where: { id: workspaceId } })` written by hand. The probe
 *    workspace below is CROSS-STAMPED — it holds a DIFFERENT and much more
 *    expensive video default than ours — so a dropped or widened predicate does
 *    not merely leak a value, it leaks a value that changes what the next clip
 *    COSTS. Each predicate gets its own failing assertion.
 * 3. **The resolution reaches the money.** The assertion is not "the service
 *    returned a string" but the `generated_assets` row: its `model` column and
 *    its `costCreditsReserved`, computed by the real `AiCreditsService` reserve
 *    against a real subscription. That row is what the provider is called with
 *    and what the customer is billed for.
 *
 * Only fal.ai, the job scheduler and R2 are seamed out — an external vendor is
 * not a test fixture, and the booted app runs a real once-a-minute job runner
 * that would otherwise claim a poll job mid-suite. `PrismaService` and
 * `AiCreditsService` are the real ones the app booted.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Workspace media model defaults, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let credits: AiCreditsService;
  let defaults: MediaModelDefaultsService;

  const SEED = `mediamodels-${randomUUID().slice(0, 8)}`;
  const workspaceId = randomUUID(); // ours
  const otherWorkspaceId = randomUUID(); // the neighbour
  const packageId = randomUUID();
  const ownerId = randomUUID();

  /** The neighbour's choice: a premium model, 15 credits/sec against the
   *  platform default's 3. Leaking it is measurable. */
  const NEIGHBOUR_VIDEO_MODEL = 'fal-ai/veo3.1/fast';
  /** Ours: the middle tier, so "ours", "theirs" and "the code constant" are
   *  three distinct answers and no assertion can pass by coincidence. */
  const OUR_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1/pro/text-to-video';

  /** MediaGen with the vendor, the queue and object storage cut out. */
  const mediaGen = () =>
    new MediaGenService(
      prisma,
      credits,
      {
        name: 'fal',
        isConfigured: () => true,
        submit: jest.fn().mockResolvedValue({ providerRequestId: randomUUID() }),
        getResult: jest.fn(),
      } as never,
      { schedule: jest.fn().mockResolvedValue('job-1') } as never,
      { isConfigured: () => false } as never,
      { registerHandler: () => undefined } as never,
      undefined as never,
      { settle: jest.fn().mockResolvedValue(null) } as never,
    );

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    credits = app.get(AiCreditsService);
    defaults = new MediaModelDefaultsService(prisma);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Models A', productName: 'Figurunica' },
        {
          id: otherWorkspaceId,
          slug: `${SEED}-b`,
          name: 'Models B',
          productName: 'Next Door',
          // The cross-stamp, written at seed time so every read below has
          // something wrong it could return.
          defaultVideoModel: NEIGHBOUR_VIDEO_MODEL,
          defaultImageModel: 'fal-ai/qwen-image',
        },
      ],
    });

    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Models Plan',
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
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    await prisma.generatedAsset.deleteMany({
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
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await closeTestApp(app);
  });

  it('starts with no choice, and says the platform constant is what runs', async () => {
    const res = await defaults.get(workspaceId);
    expect(res.defaultVideoModel).toBeNull();
    expect(res.defaultImageModel).toBeNull();
    expect(res.effectiveVideoModel).toBe(DEFAULT_VIDEO_MODEL);
    expect(res.effectiveImageModel).toBe(DEFAULT_IMAGE_MODEL);
  });

  /** The neighbour's row exists and is DIFFERENT — without this the isolation
   *  assertions below would be testing nothing. */
  it('has a neighbour whose stored choice is a different, pricier model', async () => {
    const theirs = await defaults.get(otherWorkspaceId);
    expect(theirs.defaultVideoModel).toBe(NEIGHBOUR_VIDEO_MODEL);
    expect(theirs.effectiveVideoModel).not.toBe(DEFAULT_VIDEO_MODEL);
  });

  it('persists a choice to the real column and reads it back', async () => {
    const written = await defaults.set(workspaceId, { defaultVideoModel: OUR_VIDEO_MODEL });
    expect(written.defaultVideoModel).toBe(OUR_VIDEO_MODEL);

    // Read back through a fresh query, not the write's return value.
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultVideoModel: true, defaultImageModel: true },
    });
    expect(row?.defaultVideoModel).toBe(OUR_VIDEO_MODEL);
    // The half nobody named stayed untouched.
    expect(row?.defaultImageModel).toBeNull();
  });

  it('does not touch the neighbour when we write ours', async () => {
    const theirs = await prisma.workspace.findUnique({
      where: { id: otherWorkspaceId },
      select: { defaultVideoModel: true },
    });
    expect(theirs?.defaultVideoModel).toBe(NEIGHBOUR_VIDEO_MODEL);
  });

  it('reads OUR choice, never the neighbour’s', async () => {
    const ours = await defaults.get(workspaceId);
    expect(ours.defaultVideoModel).toBe(OUR_VIDEO_MODEL);
    expect(ours.defaultVideoModel).not.toBe(NEIGHBOUR_VIDEO_MODEL);
  });

  /**
   * The one that reaches the money. Not "the resolver returned a string" — the
   * `generated_assets` row, whose `model` is what fal is called with and whose
   * `costCreditsReserved` is what the customer pays.
   */
  it('generates on OUR default, priced as OUR default', async () => {
    const { assetId } = await mediaGen().requestGeneration(workspaceId, {
      type: 'VIDEO',
      prompt: 'Strandbeest walks on wet sand',
      durationSec: 4,
      createdById: ownerId,
    });

    const asset = await prisma.generatedAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.model).toBe(OUR_VIDEO_MODEL);
    expect(asset.model).not.toBe(NEIGHBOUR_VIDEO_MODEL);
    // 15 credits/sec x 4s — the pro tier, not the neighbour's 25/sec and not the
    // constant's 3/sec. Three distinct numbers, so this cannot pass by accident.
    expect(asset.costCreditsReserved).toBe(60);
  });

  it('generates on the CODE CONSTANT for a workspace that chose nothing', async () => {
    // The neighbour chose a video model but this asserts the IMAGE side of ours,
    // which is still null — the fall-through, exercised on a real row.
    const { assetId } = await mediaGen().requestGeneration(workspaceId, {
      type: 'IMAGE',
      prompt: 'a still frame of the mechanism',
      createdById: ownerId,
    });
    const asset = await prisma.generatedAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.model).toBe(DEFAULT_IMAGE_MODEL);
  });

  it('refuses an uncatalogued id and writes nothing', async () => {
    await expect(
      defaults.set(workspaceId, { defaultVideoModel: 'fal-ai/not-a-real-model' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultVideoModel: true },
    });
    expect(row?.defaultVideoModel).toBe(OUR_VIDEO_MODEL);
  });

  it('refuses a catalogued id of the wrong kind and writes nothing', async () => {
    await expect(
      defaults.set(workspaceId, { defaultVideoModel: DEFAULT_IMAGE_MODEL }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultVideoModel: true },
    });
    expect(row?.defaultVideoModel).toBe(OUR_VIDEO_MODEL);
  });

  it('clears the choice back to the platform constant', async () => {
    const res = await defaults.set(workspaceId, { defaultVideoModel: null });
    expect(res.defaultVideoModel).toBeNull();
    expect(res.effectiveVideoModel).toBe(DEFAULT_VIDEO_MODEL);

    const { assetId } = await mediaGen().requestGeneration(workspaceId, {
      type: 'VIDEO',
      prompt: 'back on the platform default',
      durationSec: 4,
      createdById: ownerId,
    });
    const asset = await prisma.generatedAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.model).toBe(DEFAULT_VIDEO_MODEL);
    // 3 credits/sec x 4s — the cheap tier is back.
    expect(asset.costCreditsReserved).toBe(12);
  });
});
