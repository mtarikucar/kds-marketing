import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  AnglePerformanceService,
  MIN_POSTS_FOR_RANKING,
} from '../../src/modules/marketing/content-concepts/angle-performance.service';
import { ContentLineService } from '../../src/modules/marketing/content-concepts/content-line.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The content line's two read models, against REAL Postgres.
 *
 * Four things only real SQL settles here.
 *
 * 1. **The walk is five levels of SOFT reference.** `contentConceptId` and
 *    `socialPostId` are plain columns, not foreign keys, so nothing in the
 *    schema refuses a cross-tenant join. `walkConceptMetrics` therefore repeats
 *    `workspaceId` at EVERY level rather than inheriting it — and a mocked
 *    Prisma accepts any `where` it is handed, so the unit tests cannot tell a
 *    correct predicate from a missing one. `ChannelTariffService.resolve()`
 *    shipped `workspaceId: { in: [id, null] }` past eight weeks of a green
 *    suite for exactly this reason.
 *
 * 2. **The neighbour is CROSS-STAMPED, and what that does and does NOT prove.**
 *    The neighbour below owns OUR batch id, OUR source idea and OUR best angle,
 *    published, with metrics three orders of magnitude larger than ours — so a
 *    leak changes the arithmetic rather than hiding inside it.
 *
 *    MEASURED, not assumed: the tenant scoping here is REDUNDANT AT FOUR
 *    LEVELS, and removing any ONE of them leaves this suite green.
 *
 *      - drop it from `contentConcept.findMany` -> still green (the item query
 *        re-scopes)
 *      - drop it from the item query -> still green (concept ids are already
 *        ours, and `contentConceptId` is globally @unique so a neighbour
 *        cannot reference our concept at all)
 *      - drop BOTH -> still green (the target query re-scopes)
 *      - drop all four -> THREE of these tests fail
 *
 *    So this suite pins the COMPOSITE behaviour and proves the fixture can
 *    detect a leak; it does not pin any individual `workspaceId` clause,
 *    because none of them is individually load-bearing. A future reader must
 *    NOT read green here as permission to delete one: the redundancy is the
 *    defence, and it only stops being redundant when someone changes the
 *    upstream query that made it so.
 *
 * 3. **Ranking is by rate, and the fixture makes reach and rate DISAGREE.**
 *    `story` out-reaches `engineering` by an order of magnitude while
 *    converting a tenth as well. A ranking that fell back to reach would invert
 *    the result rather than merely blur it.
 *
 * 4. **`null` reach is a real column state, not a JS default.** A batch that
 *    published nothing has to come back null through actual SQL, because
 *    `SUM()` over no rows is null and a service that coerced it would report a
 *    measured zero on unpublished work.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Content line read models — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let angles: AnglePerformanceService;
  let line: ContentLineService;

  const SEED = `line-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID(); // ours
  const otherWorkspaceId = randomUUID(); // the neighbour
  const ownerId = randomUUID();
  const campaignId = randomUUID();
  const otherCampaignId = randomUUID();
  const accountId = randomUUID();
  const otherAccountId = randomUUID();

  /** Cross-stamped: the neighbour publishes into OUR batch id and OUR angle. */
  const PUBLISHED_BATCH = randomUUID();
  const SHARED_IDEA = 'Theo Jansen Strandbeest — rüzgarla yürüyen kinetik heykel.';
  /** A second batch of ours that has produced nothing. Its reach must be null. */
  const UNPUBLISHED_BATCH = randomUUID();

  let sequence = 0;

  /**
   * Seeds one whole chain: a concept, the item it became, the post that item
   * published, one PUBLISHED target and a day of metrics for it.
   *
   * Everything is stamped with `ws` at every level, which is the point — a leak
   * has to be caused by a missing predicate, never by a fixture that forgot to
   * say who owns a row.
   */
  async function publishedChain(opts: {
    ws: string;
    campaign: string;
    account: string;
    batchId: string;
    angle: string;
    impressions: number;
    engagements: number;
    reach: number;
  }) {
    const conceptId = randomUUID();
    const postId = randomUUID();
    const targetId = randomUUID();

    await prisma.contentConcept.create({
      data: {
        id: conceptId,
        workspaceId: opts.ws,
        batchId: opts.batchId,
        sourceIdea: SHARED_IDEA,
        angle: opts.angle,
        hook: `${opts.angle} hook`,
        title: `${opts.angle} title`,
        ordinal: sequence,
        shotPlan: {},
        status: 'APPROVED',
        createdById: ownerId,
      },
    });

    await prisma.socialPost.create({
      data: {
        id: postId,
        workspaceId: opts.ws,
        content: 'x',
        mediaUrls: [],
        status: 'PUBLISHED',
      },
    });

    await prisma.socialCampaignItem.create({
      data: {
        workspaceId: opts.ws,
        socialCampaignId: opts.campaign,
        sequenceIndex: sequence,
        scheduledFor: new Date(),
        status: 'PUBLISHED',
        contentConceptId: conceptId,
        socialPostId: postId,
      },
    });

    await prisma.socialPostTarget.create({
      data: {
        id: targetId,
        workspaceId: opts.ws,
        postId,
        socialAccountId: opts.account,
        network: 'INSTAGRAM',
        status: 'PUBLISHED',
      },
    });

    await prisma.socialPostMetric.create({
      data: {
        workspaceId: opts.ws,
        targetId,
        date: new Date('2026-09-01T00:00:00.000Z'),
        impressions: opts.impressions,
        engagements: opts.engagements,
        reach: opts.reach,
      },
    });

    sequence += 1;
    return conceptId;
  }

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    angles = app.get(AnglePerformanceService);
    line = app.get(ContentLineService);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Line A', productName: 'Figurunica' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Line B', productName: 'Next Door' },
      ],
    });

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

    for (const [id, ws] of [
      [campaignId, workspaceId],
      [otherCampaignId, otherWorkspaceId],
    ] as const) {
      await prisma.socialCampaign.create({
        data: {
          id,
          workspaceId: ws,
          name: `${SEED} campaign`,
          startDate: new Date(),
          automationMode: 'APPROVAL',
          brief: {},
          planningMode: 'USER_TOPICS',
          cadence: {},
          createdById: ownerId,
        },
      });
    }

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
        },
      });
    }

    const ours = {
      ws: workspaceId,
      campaign: campaignId,
      account: accountId,
      batchId: PUBLISHED_BATCH,
    };

    // `engineering`: modest reach, strong conversion. Rate 0.10.
    for (let i = 0; i < MIN_POSTS_FOR_RANKING; i += 1) {
      await publishedChain({
        ...ours,
        angle: 'engineering',
        impressions: 1_000,
        engagements: 100,
        reach: 800,
      });
    }

    // `story`: ten times the reach, a tenth of the conversion. Rate 0.01.
    for (let i = 0; i < MIN_POSTS_FOR_RANKING; i += 1) {
      await publishedChain({
        ...ours,
        angle: 'story',
        impressions: 10_000,
        engagements: 100,
        reach: 9_000,
      });
    }

    // `lucky`: ONE post at the flukiest possible rate. Must never rank.
    await publishedChain({
      ...ours,
      angle: 'lucky',
      impressions: 10,
      engagements: 9,
      reach: 10,
    });

    // A batch of ours that has produced nothing at all.
    await prisma.contentConcept.createMany({
      data: [0, 1].map((i) => ({
        workspaceId,
        batchId: UNPUBLISHED_BATCH,
        sourceIdea: 'Henüz hiçbir şey üretilmemiş bir fikir',
        angle: `idle-${i}`,
        hook: 'h',
        title: 't',
        ordinal: i,
        shotPlan: {},
        status: 'PROPOSED' as const,
        createdById: ownerId,
      })),
    });

    // THE NEIGHBOUR, cross-stamped onto our batch and our best angle, with
    // metrics an order of magnitude larger than everything above.
    await publishedChain({
      ws: otherWorkspaceId,
      campaign: otherCampaignId,
      account: otherAccountId,
      batchId: PUBLISHED_BATCH,
      angle: 'engineering',
      impressions: 1_000_000,
      engagements: 900_000,
      reach: 900_000,
    });
  }, 120_000);

  afterAll(async () => {
    if (!realDbEnabled()) return;
    const both = { in: [workspaceId, otherWorkspaceId] };
    // Most-dependent first.
    await prisma.socialPostMetric.deleteMany({ where: { workspaceId: both } });
    await prisma.socialPostTarget.deleteMany({ where: { workspaceId: both } });
    await prisma.socialCampaignItem.deleteMany({ where: { workspaceId: both } });
    await prisma.socialPost.deleteMany({ where: { workspaceId: both } });
    await prisma.socialCampaign.deleteMany({ where: { workspaceId: both } });
    await prisma.socialAccount.deleteMany({ where: { workspaceId: both } });
    await prisma.contentConcept.deleteMany({ where: { workspaceId: both } });
    await prisma.marketingUser.deleteMany({ where: { id: ownerId } });
    await prisma.workspace.deleteMany({ where: { id: both } });
    await closeTestApp(app);
  }, 120_000);

  describe('angle performance', () => {
    it('ranks by conversion even when the loser out-reaches the winner', async () => {
      const res = await angles.byAngle(workspaceId);

      expect(res.cold).toBe(false);
      const ranked = res.angles.filter((a) => !a.insufficient && a.rate !== null);
      expect(ranked.map((a) => a.angle)).toEqual(['engineering', 'story']);

      const eng = res.angles.find((a) => a.angle === 'engineering')!;
      const story = res.angles.find((a) => a.angle === 'story')!;
      expect(eng.rate).toBeCloseTo(0.1);
      expect(story.rate).toBeCloseTo(0.01);
      // The point of the fixture: reach and rate disagree, and rate wins.
      expect(story.impressions).toBeGreaterThan(eng.impressions);
    });

    it('never lets the neighbour into our numbers', async () => {
      const res = await angles.byAngle(workspaceId);
      const eng = res.angles.find((a) => a.angle === 'engineering')!;

      // Exactly ours: 3 posts × 1,000. The neighbour is cross-stamped onto this
      // very angle with 1,000,000 — a leak cannot hide in this assertion.
      expect(eng.posts).toBe(MIN_POSTS_FOR_RANKING);
      expect(eng.impressions).toBe(3_000);
      expect(eng.engagements).toBe(300);
    });

    it('shows the fluke without ranking or weighting it', async () => {
      const res = await angles.byAngle(workspaceId);
      const lucky = res.angles.find((a) => a.angle === 'lucky')!;

      expect(lucky.posts).toBe(1);
      expect(lucky.insufficient).toBe(true);
      expect(res.weights['lucky']).toBeUndefined();
      // …and it did not displace the measured angle at the top.
      expect(res.angles[0].angle).toBe('engineering');
    });

    it('reads nothing at all for a workspace that has published nothing', async () => {
      const res = await angles.byAngle(randomUUID());
      expect(res.cold).toBe(true);
      expect(res.angles).toEqual([]);
    });
  });

  describe('batch summaries', () => {
    it('returns reach as null for a batch that published nothing', async () => {
      const batches = await line.batches(workspaceId);
      const idle = batches.find((b) => b.batchId === UNPUBLISHED_BATCH)!;

      expect(idle.concepts.total).toBe(2);
      expect(idle.concepts.awaitingReview).toBe(2);
      expect(idle.production.published).toBe(0);
      // SUM() over no rows is null in SQL, and it has to survive as null.
      expect(idle.reach).toBeNull();
    });

    it('sums only our reach on the published batch', async () => {
      const batches = await line.batches(workspaceId);
      const published = batches.find((b) => b.batchId === PUBLISHED_BATCH)!;

      // 3×800 + 3×9,000 + 1×10. The neighbour's 900,000 sits on this same
      // batchId and must not appear.
      expect(published.reach).toBe(29_410);
      expect(published.production.published).toBe(2 * MIN_POSTS_FOR_RANKING + 1);
    });

    it('does not hand the neighbour our batches', async () => {
      const theirs = await line.batches(otherWorkspaceId);

      // They own a row carrying OUR batch id, so the batch appears — with THEIR
      // single concept and THEIR reach, never ours.
      const crossStamped = theirs.find((b) => b.batchId === PUBLISHED_BATCH)!;
      expect(crossStamped.concepts.total).toBe(1);
      expect(crossStamped.reach).toBe(900_000);
      // And our idle batch is invisible to them entirely.
      expect(theirs.some((b) => b.batchId === UNPUBLISHED_BATCH)).toBe(false);
    });
  });
});
