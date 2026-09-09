import { ServiceUnavailableException, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_VIDEO_MODEL, DEFAULT_VIDEO_ANIMATE_MODEL, DEFAULT_VIDEO_REFERENCE_MODEL,
  DEFAULT_KEYFRAME_MODEL, DEFAULT_KEYFRAME_REFERENCE_MODEL,
} from '../ai/media/media-models.config';
import { Prisma } from '@prisma/client';
import { ConceptPromotionService, PRODUCE_MAX_WAITS, PROGRAMME_HOLD_MS } from './concept-promotion.service';
import { MAX_FRAME_ATTEMPTS, STORYBOARD_MAX_WAITS } from './storyboard-frames';
import {
  CampaignItemArmingService,
  SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
  confirmDedup,
} from '../social-campaigns/campaign-item-arming.service';
import { DEFAULT_SHOT_ASPECT } from '../video/video-pipeline.service';

const WS = 'ws-1';
const CONCEPT_ID = 'concept-1';
const CAMPAIGN_ID = 'camp-1';
const ITEM_ID = 'item-1';

/** A real ShotPlan shape — three beats, the two text channels kept apart. */
const SHOT_PLAN = {
  model: 'seedance',
  durationSec: 9,
  captionSuggestion: 'Bunun motoru yok — link in bio.',
  qcChecklist: ['aspect 9:16'],
  shots: [
    { ord: 0, scene: '0-2s', onScreenText: 'Bunun motoru yok.', voiceover: '', prompt: 'Strandbeest yürüyor, vertical 9:16', durationSec: 2, cameraNote: 'geniş' },
    { ord: 1, scene: '2-5s', onScreenText: 'Pili de yok.', voiceover: '', prompt: 'pervane dönüyor, vertical 9:16', durationSec: 3, cameraNote: 'kaydırma' },
    { ord: 2, scene: '5-9s', onScreenText: '', voiceover: 'Theo Jansen', prompt: 'bacak makro, vertical 9:16', durationSec: 4, cameraNote: 'makro' },
  ],
};

const concept = (over: Record<string, unknown> = {}) => ({
  id: CONCEPT_ID,
  workspaceId: WS,
  batchId: 'batch-1',
  sourceIdea: 'Strandbeest',
  angle: 'curiosity',
  hook: 'Bunun motoru yok.',
  title: 'Motorsuz yürüyen şey',
  rationale: null,
  ordinal: 0,
  shotPlan: SHOT_PLAN,
  status: 'APPROVED',
  socialCampaignId: CAMPAIGN_ID,
  promotedItemId: null,
  createdById: 'user-1',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) => ({
  id: CAMPAIGN_ID,
  workspaceId: WS,
  name: 'Strandbeest',
  status: 'ACTIVE',
  targetAccountIds: ['acc-1'],
  cadence: { daysOfWeek: [1, 3, 5], timeOfDay: '09:00' },
  startDate: new Date('2026-09-01T00:00:00Z'),
  endDate: null,
  defaultVideoModel: null,
  defaultImageModel: null,
  automationMode: 'APPROVAL',
  createdById: 'user-1',
  ...over,
});

function harness(
  over: {
    conceptRow?: unknown;
    campaignRow?: unknown;
    itemRow?: unknown;
    itemByConcept?: unknown;
    accountRows?: unknown[];
    createItem?: jest.Mock;
  } = {},
) {
  const createItem =
    over.createItem ??
    jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...data, id: ITEM_ID }),
    );
  const prisma: Record<string, any> = {
    // Every keyframe write is one raw jsonb_set UPDATE (storyboard-frames.ts).
    $executeRaw: jest.fn().mockResolvedValue(1),
    contentConcept: {
      findFirst: jest.fn().mockResolvedValue(over.conceptRow === undefined ? concept() : over.conceptRow),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialCampaign: {
      findFirst: jest.fn().mockResolvedValue(over.campaignRow === undefined ? campaign() : over.campaignRow),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ stats: {} }),
      update: jest.fn().mockResolvedValue({}),
    },
    socialCampaignItem: {
      // 1st call: the promotedItemId short-circuit read. Later: the P2002 recovery read.
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(over.itemRow ?? null)
        .mockResolvedValue(over.itemByConcept ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: createItem,
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialAccount: {
      // Only the DESTINATION PREVIEW reads these now — the approval path no
      // longer asks what an account can carry.
      findMany: jest
        .fn()
        .mockResolvedValue(
          over.accountRows ?? [
            { id: 'acc-1', network: 'INSTAGRAM', displayName: '@figurunica', enabled: true },
          ],
        ),
    },
    socialPost: { create: jest.fn().mockResolvedValue({ id: 'post-1' }) },
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const mediaGen = {
    requestGeneration: jest.fn().mockResolvedValue({ assetId: 'asset-x' }),
    // The workspace default, resolved by the service the producer shares with
    // every other buyer of a clip. Seedance v1 lite publishes 9:16.
    workspaceDefaultModel: jest
      .fn()
      .mockResolvedValue(DEFAULT_VIDEO_MODEL),
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  // The REAL arming service on the same fakes: the whole point of fix #2 is that
  // the concept path obeys the SAME rule as the generic generator, and a stub
  // would let a second rule back in through the test harness.
  const arming = new CampaignItemArmingService(prisma as never, scheduledJobs as never);
  const svc = new ConceptPromotionService(
    prisma as never,
    mediaGen as never,
    scheduledJobs as never,
    runner as never,
    arming,
  );
  return { svc, prisma, mediaGen, scheduledJobs, createItem };
}

describe('ConceptPromotionService.promote — an approved concept becomes exactly one item', () => {
  it('creates the item carrying the concept link, the hook as topic, and the campaign', async () => {
    const { svc, createItem, scheduledJobs } = harness();

    const res = await svc.promote(WS, CONCEPT_ID);

    expect(res.created).toBe(true);
    expect(createItem).toHaveBeenCalledTimes(1);
    const data = createItem.mock.calls[0][0].data;
    expect(data.contentConceptId).toBe(CONCEPT_ID);
    expect(data.socialCampaignId).toBe(CAMPAIGN_ID);
    expect(data.workspaceId).toBe(WS);
    expect(data.topic).toBe('Bunun motoru yok.');
    // GENERATING, not PLANNED. A PLANNED item with a topic is exactly what
    // SocialCampaignsService.confirmPlan sweeps into the GENERIC generator,
    // which would overwrite the shot plan with a stock hook/demo/proof/CTA ad.
    expect(data.status).toBe('GENERATING');
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(1);
  });

  it('records the item back on the concept in the SAME transaction as the create', async () => {
    const { svc, prisma } = harness();
    await svc.promote(WS, CONCEPT_ID);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.contentConcept.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CONCEPT_ID, workspaceId: WS }),
        data: { promotedItemId: ITEM_ID, socialCampaignId: CAMPAIGN_ID },
      }),
    );
  });

  it('writes the campaign it was produced INTO back onto the concept', async () => {
    // The reviewer may name a campaign the concept never carried. Forwarding it
    // to promote() and not recording it leaves the concept reading as unscoped
    // forever, and the documented "the item cascaded away, promote again"
    // recovery then needs the campaign named a second time — which no surface
    // does and nothing on the row hints at.
    const OTHER = 'camp-named-by-reviewer';
    const { svc, prisma } = harness({
      conceptRow: concept({ socialCampaignId: null }),
      campaignRow: campaign({ id: OTHER }),
    });

    await svc.promote(WS, CONCEPT_ID, { socialCampaignId: OTHER });

    expect(prisma.contentConcept.updateMany.mock.calls[0][0].data.socialCampaignId).toBe(OTHER);
  });

  it('a second run creates nothing and returns the item the first one made', async () => {
    const existing = { id: ITEM_ID, workspaceId: WS, contentConceptId: CONCEPT_ID, status: 'GENERATING' };
    const { svc, createItem } = harness({
      conceptRow: concept({ promotedItemId: ITEM_ID }),
      itemRow: existing,
    });

    const res = await svc.promote(WS, CONCEPT_ID);

    expect(res.created).toBe(false);
    expect(res.item.id).toBe(ITEM_ID);
    expect(createItem).not.toHaveBeenCalled();
  });

  it('a racer that lost the unique index reads the winner item back instead of throwing', async () => {
    const winner = { id: 'item-winner', workspaceId: WS, contentConceptId: CONCEPT_ID, status: 'GENERATING' };
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['contentConceptId'] },
    });
    const { svc, createItem } = harness({
      createItem: jest.fn().mockRejectedValue(p2002),
      itemByConcept: winner,
    });

    const res = await svc.promote(WS, CONCEPT_ID);

    expect(res.created).toBe(false);
    expect(res.item.id).toBe('item-winner');
    expect(createItem).toHaveBeenCalledTimes(1);
  });

  it('refuses a concept that no human has approved, and writes nothing', async () => {
    const { svc, createItem } = harness({ conceptRow: concept({ status: 'PROPOSED' }) });
    await expect(svc.promote(WS, CONCEPT_ID)).rejects.toThrow(/PROPOSED/);
    expect(createItem).not.toHaveBeenCalled();
  });

  it('refuses a concept in another workspace by finding nothing to promote', async () => {
    const { svc, createItem } = harness({ conceptRow: null });
    await expect(svc.promote(WS, CONCEPT_ID)).rejects.toThrow(NotFoundException);
    expect(createItem).not.toHaveBeenCalled();
  });

  it('says the campaign is missing rather than inventing one', async () => {
    const a = harness({ campaignRow: null });
    await expect(a.svc.promote(WS, CONCEPT_ID)).rejects.toThrow(BadRequestException);
    expect(a.createItem).not.toHaveBeenCalled();
    const b = harness({ campaignRow: null });
    await expect(b.svc.promote(WS, CONCEPT_ID)).rejects.toThrow(/campaign/i);
  });

  it('refuses an approved concept that was never scoped to a campaign, naming the fix', async () => {
    const { svc } = harness({ conceptRow: concept({ socialCampaignId: null }) });
    await expect(svc.promote(WS, CONCEPT_ID)).rejects.toThrow(/socialCampaignId/);
  });

  it('scopes the campaign read by workspace — a campaign id is not authority', async () => {
    const { svc, prisma } = harness();
    await svc.promote(WS, CONCEPT_ID);
    expect(prisma.socialCampaign.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: CAMPAIGN_ID, workspaceId: WS }) }),
    );
  });
});

describe('ConceptPromotionService.produce — the clips, and what happens when they fail', () => {
  const promotedItem = (over: Record<string, unknown> = {}) => ({
    id: ITEM_ID,
    workspaceId: WS,
    socialCampaignId: CAMPAIGN_ID,
    contentConceptId: CONCEPT_ID,
    status: 'GENERATING',
    generatedAssetIds: [],
    socialPostId: null,
    scheduledFor: new Date('2026-09-02T09:00:00Z'),
    topic: 'Bunun motoru yok.',
    campaign: campaign(),
    ...over,
  });

  function prodHarness(
    over: { item?: unknown; conceptRow?: unknown; requestGeneration?: jest.Mock } = {},
  ) {
    const h = harness({ conceptRow: over.conceptRow === undefined ? concept() : over.conceptRow });
    h.prisma.socialCampaignItem.findFirst = jest
      .fn()
      .mockResolvedValue(over.item === undefined ? promotedItem() : over.item);
    if (over.requestGeneration) h.mediaGen.requestGeneration = over.requestGeneration;
    return h;
  }

  it('requests one clip per beat, with that beat own prompt and length', async () => {
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);

    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(3);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.map((c) => c.durationSec)).toEqual([2, 3, 4]);
    expect(calls.map((c) => c.prompt)).toEqual(SHOT_PLAN.shots.map((s) => s.prompt));
    expect(calls.every((c) => c.type === 'VIDEO')).toBe(true);
    // Both linkage fields, so the asset is neither orphan-reaped nor billed off
    // the armed-budget path.
    expect(calls.every((c) => c.socialCampaignId === CAMPAIGN_ID)).toBe(true);
    expect(calls.every((c) => c.campaignItemId === ITEM_ID)).toBe(true);
  });

  it('hands the finished item to the existing lifecycle at NEEDS_APPROVAL, with a post', async () => {
    const { svc, prisma } = prodHarness();
    await svc.produce(ITEM_ID, WS);

    expect(prisma.socialPost.create).toHaveBeenCalledTimes(1);
    expect(prisma.socialPost.create.mock.calls[0][0].data.content).toContain('link in bio');
    const final = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(final.data.status).toBe('NEEDS_APPROVAL');
    expect(final.data.socialPostId).toBe('post-1');
    expect(final.data.generatedAssetIds).toHaveLength(3);
  });

  it('resumes from the clips it already paid for instead of buying them twice', async () => {
    const { svc, mediaGen } = prodHarness({ item: promotedItem({ generatedAssetIds: ['a-0', 'a-1'] }) });
    await svc.produce(ITEM_ID, WS);
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
    expect(mediaGen.requestGeneration.mock.calls[0][1].durationSec).toBe(4);
  });

  it('a failed clip leaves the item FAILED with the reason, never silently back at PLANNED', async () => {
    const { svc, prisma } = prodHarness({
      requestGeneration: jest.fn().mockRejectedValue(new Error('fal.ai refused the prompt')),
    });
    await svc.produce(ITEM_ID, WS);

    const final = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(final.data.status).toBe('FAILED');
    expect(final.data.error).toMatch(/fal\.ai refused the prompt/);
    // The reason has to name WHICH beat, or "it failed" is unactionable on a
    // three-clip item.
    expect(final.data.error).toMatch(/1\s*\/\s*3/);
    expect(prisma.socialPost.create).not.toHaveBeenCalled();
  });

  it('a full generation queue is a WAIT, not a failure — the item stays GENERATING', async () => {
    const tooMany = new BadRequestException({
      code: 'MEDIA_GEN_TOO_MANY',
      message: 'Too many running generations (max 4)',
    });
    const { svc, prisma } = prodHarness({ requestGeneration: jest.fn().mockRejectedValue(tooMany) });

    const res = await svc.produce(ITEM_ID, WS);

    expect(res).toEqual({ reschedule: expect.objectContaining({ runAt: expect.any(Date) }) });
    const statuses = prisma.socialCampaignItem.update.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { status?: string } }).data.status,
    );
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('NEEDS_APPROVAL');
  });

  it('stops waiting eventually — a queue that never drains FAILS with why', async () => {
    // A reschedule directive resets the job row`s `attempts` to 0
    // (scheduled-job-runner.service.ts), so "wait for a free slot" has no
    // built-in bound and an item could spin on the queue forever, reporting
    // nothing. The wait count rides in the payload instead.
    const tooMany = new BadRequestException({
      code: 'MEDIA_GEN_TOO_MANY',
      message: 'Too many running generations (max 4)',
    });
    const { svc, prisma } = prodHarness({ requestGeneration: jest.fn().mockRejectedValue(tooMany) });

    const res = await svc.produce(ITEM_ID, WS, PRODUCE_MAX_WAITS);

    expect(res).toBeUndefined();
    const final = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(final.data.status).toBe('FAILED');
    expect(final.data.error).toMatch(/queue/i);
  });

  it('a plan with no beats FAILS by name instead of producing nothing quietly', async () => {
    const { svc, prisma } = prodHarness({ conceptRow: concept({ shotPlan: { ...SHOT_PLAN, shots: [] } }) });
    await svc.produce(ITEM_ID, WS);
    const final = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(final.data.status).toBe('FAILED');
    expect(final.data.error).toMatch(/no shots|beat/i);
  });

  it('a concept that vanished FAILS the item by name rather than leaving it hanging', async () => {
    const { svc, prisma } = prodHarness({ conceptRow: null });
    await svc.produce(ITEM_ID, WS);
    const final = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(final.data.status).toBe('FAILED');
    expect(final.data.error).toMatch(/concept/i);
  });

  it('does not touch an item that is no longer GENERATING (a duplicate job run)', async () => {
    const { svc, prisma, mediaGen } = prodHarness({
      item: promotedItem({ status: 'NEEDS_APPROVAL', generatedAssetIds: ['a', 'b', 'c'] }),
    });
    await svc.produce(ITEM_ID, WS);
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).not.toHaveBeenCalled();
  });

  it('scopes the item read by workspace — the id alone is not authority', async () => {
    const { svc, prisma } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    expect(prisma.socialCampaignItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: ITEM_ID, workspaceId: WS }) }),
    );
  });

  it('scopes the concept read by workspace too — the item cannot point across a tenant line', async () => {
    const { svc, prisma } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    expect(prisma.contentConcept.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: CONCEPT_ID, workspaceId: WS }) }),
    );
  });
});

/**
 * The campaign a concept is produced into must be one that can PUBLISH it.
 *
 * The only campaign an agent can create is a DRAFT (`jeeta.create_social_campaign`
 * says activation "is deliberately not available to agents"), and a DRAFT is
 * exactly the campaign whose publish gate never fires: `confirmItem` opens with
 * `if (c.status !== 'ACTIVE')` and, for anything that is not PAUSED, returns
 * with no reschedule and no trace. Without this guard the whole shot plan is
 * generated and PAID FOR, the item reaches NEEDS_APPROVAL, a human approves it
 * to SCHEDULED — and it parks there forever.
 *
 * PAUSED is allowed because it is the one non-ACTIVE status the gate handles:
 * it reschedules hourly, so a resume publishes the item it has been holding.
 */
describe('ConceptPromotionService.requireCampaign — the campaign has to be able to publish', () => {
  it.each(['DRAFT', 'COMPLETED', 'CANCELLED'])(
    'refuses a %s campaign BY NAME and creates no item',
    async (status) => {
      const { svc, createItem, scheduledJobs } = harness({ campaignRow: campaign({ status }) });
      await expect(svc.promote(WS, CONCEPT_ID)).rejects.toThrow(BadRequestException);
      await expect(svc.promote(WS, CONCEPT_ID)).rejects.toThrow(new RegExp(status));
      expect(createItem).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    },
  );

  it('says what to do about it, in the surface that can do it', async () => {
    const { svc } = harness({ campaignRow: campaign({ status: 'DRAFT' }) });
    await expect(svc.promote(WS, CONCEPT_ID)).rejects.toThrow(/activate/i);
  });

  it.each(['ACTIVE', 'PAUSED'])('allows a %s campaign — its gate still fires', async (status) => {
    const { svc, createItem } = harness({ campaignRow: campaign({ status }) });
    const res = await svc.promote(WS, CONCEPT_ID);
    expect(res.created).toBe(true);
    expect(createItem).toHaveBeenCalledTimes(1);
  });
});

/**
 * Blocker 2 — an APPROVED concept must never be able to strand.
 *
 * `promote()` short-circuits on `promotedItemId` and used to return the existing
 * item without touching the queue. That is right for a finished item and wrong
 * for the one state this method exists to close: an item created but never
 * enqueued (a crash, a deadlock, a DLQ'd job) sits at GENERATING, which
 * `REGENERATABLE_STATES` excludes, so nothing else in the product can reach it.
 * Re-driving the queue is free — the dedup key collapses onto a PENDING job —
 * and `produce()` itself no-ops unless the item is still GENERATING.
 */
describe('ConceptPromotionService.promote — the rescue', () => {
  it('re-queues production for an item stranded at GENERATING', async () => {
    const { svc, scheduledJobs, createItem } = harness({
      conceptRow: concept({ promotedItemId: ITEM_ID }),
      itemRow: { id: ITEM_ID, workspaceId: WS, contentConceptId: CONCEPT_ID, status: 'GENERATING' },
    });

    const res = await svc.promote(WS, CONCEPT_ID);

    expect(res.created).toBe(false);
    expect(createItem).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(1);
    expect(scheduledJobs.schedule.mock.calls[0][0]).toMatchObject({
      dedupKey: `content-concept-produce-${ITEM_ID}`,
    });
  });

  it('does NOT re-queue an item the pipeline has already moved on', async () => {
    for (const status of ['NEEDS_APPROVAL', 'SCHEDULED', 'PUBLISHED', 'FAILED']) {
      const { svc, scheduledJobs } = harness({
        conceptRow: concept({ promotedItemId: ITEM_ID }),
        itemRow: { id: ITEM_ID, workspaceId: WS, contentConceptId: CONCEPT_ID, status },
      });
      await svc.promote(WS, CONCEPT_ID);
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    }
  });
});

/**
 * Blocker 3 — a DLQ'd produce job must not leave a paid-for item looking like
 * work that never started.
 *
 * `produce()` catches generation errors, but a DB error in its opening
 * `findFirst`, in `socialPost.create` or in the closing `update` escapes: five
 * retries, then the runner DLQs the job. The item stays GENERATING with
 * `error: null` while holding assets the workspace has already been charged
 * for, and (per the rescue above) GENERATING is the state nothing else touches.
 * The runner has supported `onExhausted` all along.
 */
describe('ConceptPromotionService.onModuleInit — the DLQ hook', () => {
  it('registers an onExhausted hook alongside the handler', () => {
    const { svc, prisma } = harness();
    const runner = { registerHandler: jest.fn() };
    (svc as unknown as { runner: unknown }).runner = runner;
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledTimes(1);
    expect(typeof runner.registerHandler.mock.calls[0][2]).toBe('function');
    expect(prisma).toBeTruthy();
  });

  it('the hook FAILS the item with the DLQ reason on the row', async () => {
    const { svc, prisma } = harness();
    const runner = { registerHandler: jest.fn() };
    (svc as unknown as { runner: unknown }).runner = runner;
    svc.onModuleInit();
    const onExhausted = runner.registerHandler.mock.calls[0][2] as (
      job: unknown,
      err: string,
    ) => Promise<void>;

    await onExhausted({ payload: { itemId: ITEM_ID, workspaceId: WS } }, 'connection terminated');

    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    const { data } = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(data.error).toMatch(/connection terminated/);
    // And it says the item is not merely broken but possibly half-PAID-for, so
    // whoever reads the row knows a regenerate is not free.
    expect(data.error).toMatch(/retr|attempt/i);
  });
});


// ---------------------------------------------------------------------------
// Defect 1 — the frame nobody asked for.
// ---------------------------------------------------------------------------

/**
 * `produce()` called `requestGeneration` with NO `aspectRatio` at all, while
 * every prompt it sent ended in "vertical 9:16" and the plan's QC line said
 * "aspect 9:16". The words asked for vertical and the parameter that actually
 * decides was never sent, so each model fell to its own default (Veo 3.1 →
 * 16:9). Nothing this line has ever published was vertical.
 */
describe('ConceptPromotionService.produce — the frame is SENT, not merely described', () => {
  const promotedItem = (over: Record<string, unknown> = {}) => ({
    id: ITEM_ID,
    workspaceId: WS,
    socialCampaignId: CAMPAIGN_ID,
    contentConceptId: CONCEPT_ID,
    status: 'GENERATING',
    generatedAssetIds: [],
    socialPostId: null,
    scheduledFor: new Date('2026-09-02T09:00:00Z'),
    topic: 'Bunun motoru yok.',
    campaign: campaign(),
    ...over,
  });

  function prodHarness(over: { conceptRow?: unknown; item?: unknown } = {}) {
    const h = harness({ conceptRow: over.conceptRow === undefined ? concept() : over.conceptRow });
    h.prisma.socialCampaignItem.findFirst = jest
      .fn()
      .mockResolvedValue(over.item === undefined ? promotedItem() : over.item);
    return h;
  }

  const planWith = (over: Record<string, unknown>) => ({ ...SHOT_PLAN, ...over });

  it('sends the plan aspect ratio as a PARAMETER on every clip', async () => {
    const { svc, mediaGen } = prodHarness({
      conceptRow: concept({ shotPlan: planWith({ aspectRatio: '9:16' }) }),
    });
    await svc.produce(ITEM_ID, WS);

    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.aspectRatio === '9:16')).toBe(true);
  });

  it('a plan framed 16:9 sends 16:9 — the ratio is the plan own, not a constant', async () => {
    const { svc, mediaGen } = prodHarness({
      conceptRow: concept({ shotPlan: planWith({ aspectRatio: '16:9' }) }),
    });
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.aspectRatio === '16:9')).toBe(true);
  });

  it('a plan stored before the field existed is read as the ratio its own prompts claim', async () => {
    // Every plan already in the database. Its prompts say "vertical 9:16", so
    // that is the honest reading of it — not "whatever the model defaults to".
    const legacy = { ...SHOT_PLAN };
    delete (legacy as Record<string, unknown>).aspectRatio;
    const { svc, mediaGen } = prodHarness({ conceptRow: concept({ shotPlan: legacy }) });
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.aspectRatio === DEFAULT_SHOT_ASPECT)).toBe(true);
  });

  it('does NOT fail an approved item over a frame the model cannot take — it sends no ratio and says so', async () => {
    // THE REGRESSION THIS REPLACES. The refusal used to live here, and here it
    // could only strand: the concept was already APPROVED (review() refuses a
    // second verdict) and the item already PROMOTED (regenerateItem refuses
    // one), so a plan whose model does not publish its ratio was dead with no
    // way forward. The same question is now asked at campaign create/update and
    // at the workspace defaults card — where a person is choosing the model and
    // can act on the answer.
    //
    // Veo 3.1 publishes 16:9 and 9:16. A 4:5 plan against it now buys its clips
    // with NO aspect_ratio parameter, and the plan records why.
    const { svc, mediaGen, prisma } = prodHarness({
      conceptRow: concept({ shotPlan: planWith({ aspectRatio: '4:5' }) }),
      item: promotedItem({ campaign: campaign({ defaultVideoModel: 'fal-ai/veo3.1' }) }),
    });
    await svc.produce(ITEM_ID, WS);

    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(3);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    // No ratio at all — not 4:5 (fal would reject it) and not a substituted one
    // nobody planned.
    expect(calls.every((c) => c.aspectRatio === undefined)).toBe(true);
    // The item is NOT failed.
    const statuses = prisma.socialCampaignItem.update.mock.calls.map(
      (c: [{ data: Record<string, unknown> }]) => c[0].data.status,
    );
    expect(statuses).not.toContain('FAILED');
    // And the plan says what happened, in the place a human reads the plan.
    const written = prisma.contentConcept.updateMany.mock.calls.at(-1)[0].data.shotPlan;
    expect(written.production.aspectRatio).toBeNull();
    expect(written.production.frameNote).toMatch(/4:5/);
    expect(written.production.frameNote).toMatch(/16:9/);
  });

  it('a model that takes NO aspect ratio at all is produced, not failed', async () => {
    // `veed/avatars/text-to-video` is a served VIDEO model with no aspect
    // contract whatsoever, and it is accepted as a campaign default. Reading
    // "publishes no ratio" as "cannot do 9:16" failed every concept such a
    // campaign ever approved.
    const { svc, mediaGen, prisma } = prodHarness({
      item: promotedItem({ campaign: campaign({ defaultVideoModel: 'veed/avatars/text-to-video' }) }),
    });
    await svc.produce(ITEM_ID, WS);

    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(3);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.aspectRatio === undefined)).toBe(true);
    const written = prisma.contentConcept.updateMany.mock.calls.at(-1)[0].data.shotPlan;
    expect(written.production.frameNote).toMatch(/takes no aspect ratio/);
  });

  it('resolves the workspace default when the campaign names no model, and sends it', async () => {
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    expect(mediaGen.workspaceDefaultModel).toHaveBeenCalledWith(WS, 'VIDEO');
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.model === DEFAULT_VIDEO_MODEL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — a FULL_AUTO campaign concept sitting in the queue forever.
// ---------------------------------------------------------------------------

/**
 * `produce()` wrote NEEDS_APPROVAL and scheduled nothing, whatever the campaign
 * had chosen. A workspace on FULL_AUTO therefore got a SECOND human gate on
 * every concept — the opposite of what this file documents about itself — and
 * only `approveItem` could ever arm the publish.
 *
 * The arming here is the GENERIC generator's arming, reused: same service, same
 * job kind, same dedup key, same slot. Nothing is loosened, because every guard
 * that protects the customer lives in the gate this schedules, not in this.
 */
describe('ConceptPromotionService.produce — the campaign automation mode is honoured', () => {
  const promotedItem = (over: Record<string, unknown> = {}) => ({
    id: ITEM_ID,
    workspaceId: WS,
    socialCampaignId: CAMPAIGN_ID,
    contentConceptId: CONCEPT_ID,
    status: 'GENERATING',
    generatedAssetIds: [],
    socialPostId: null,
    scheduledFor: new Date('2026-09-02T09:00:00Z'),
    topic: 'Bunun motoru yok.',
    campaign: campaign(over.campaign === undefined ? {} : (over.campaign as Record<string, unknown>)),
  });

  function prodHarness(automationMode: string) {
    const h = harness();
    h.prisma.socialCampaignItem.findFirst = jest
      .fn()
      .mockResolvedValue(promotedItem({ campaign: { automationMode } }));
    return h;
  }

  const finalUpdate = (prisma: Record<string, any>) =>
    prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
  const confirmJobs = (scheduledJobs: { schedule: jest.Mock }) =>
    scheduledJobs.schedule.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .filter((j) => j.kind === SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND);

  it('FULL_AUTO: the item goes SCHEDULED and the publish gate is armed at its slot', async () => {
    const { svc, prisma, scheduledJobs } = prodHarness('FULL_AUTO');
    await svc.produce(ITEM_ID, WS);

    expect(finalUpdate(prisma).data.status).toBe('SCHEDULED');
    expect(finalUpdate(prisma).data.socialPostId).toBe('post-1');
    const jobs = confirmJobs(scheduledJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      runAt: new Date('2026-09-02T09:00:00Z'),
      payload: { itemId: ITEM_ID, workspaceId: WS },
      dedupKey: confirmDedup(ITEM_ID),
    });
  });

  it('SEMI_AUTO: NEEDS_APPROVAL (the review window) AND armed', async () => {
    const { svc, prisma, scheduledJobs } = prodHarness('SEMI_AUTO');
    await svc.produce(ITEM_ID, WS);
    expect(finalUpdate(prisma).data.status).toBe('NEEDS_APPROVAL');
    expect(confirmJobs(scheduledJobs)).toHaveLength(1);
  });

  it('APPROVAL: NEEDS_APPROVAL with NOTHING armed — the human gate the owner asked for', async () => {
    const { svc, prisma, scheduledJobs } = prodHarness('APPROVAL');
    await svc.produce(ITEM_ID, WS);
    expect(finalUpdate(prisma).data.status).toBe('NEEDS_APPROVAL');
    expect(confirmJobs(scheduledJobs)).toHaveLength(0);
  });

  it('an unrecognised mode is NOT treated as autonomy', async () => {
    const { svc, prisma, scheduledJobs } = prodHarness('WHATEVER');
    await svc.produce(ITEM_ID, WS);
    expect(finalUpdate(prisma).data.status).toBe('NEEDS_APPROVAL');
    expect(confirmJobs(scheduledJobs)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — the persona reference built and then dropped.
// ---------------------------------------------------------------------------

/**
 * `Shot.reference` held the persona's frames and locked seed, and `produce()`
 * sent neither. The identity lock survived into the prompt string as English
 * prose and nowhere else, so five clips from one concept looked like five
 * unrelated videos.
 */
describe('ConceptPromotionService.produce — the reference images reach the generator', () => {
  const REFS = ['https://cdn/deniz-1.jpg', 'https://cdn/deniz-2.jpg'];
  const LOCKED_PLAN = {
    ...SHOT_PLAN,
    aspectRatio: '9:16',
    shots: SHOT_PLAN.shots.map((sh) => ({ ...sh, reference: { images: REFS, seed: 4242 } })),
  };

  function prodHarness(over: { plan?: unknown; campaignOver?: Record<string, unknown> } = {}) {
    const h = harness({ conceptRow: concept({ shotPlan: over.plan ?? LOCKED_PLAN }) });
    h.prisma.socialCampaignItem.findFirst = jest.fn().mockResolvedValue({
      id: ITEM_ID,
      workspaceId: WS,
      socialCampaignId: CAMPAIGN_ID,
      contentConceptId: CONCEPT_ID,
      status: 'GENERATING',
      generatedAssetIds: [],
      socialPostId: null,
      scheduledFor: new Date('2026-09-02T09:00:00Z'),
      topic: 'Bunun motoru yok.',
      campaign: campaign(over.campaignOver ?? {}),
    });
    return h;
  }

  it('sends the reference images on every clip', async () => {
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => JSON.stringify(c.referenceImageUrls) === JSON.stringify(REFS))).toBe(true);
  });

  it('routes them to a model whose contract takes an ARRAY of reference images', async () => {
    // The workspace default is a TEXT-to-video endpoint with no `image_urls`
    // parameter at all: sending references there drops them silently, which is
    // the defect itself wearing a different coat.
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.model === 'bytedance/seedance-2.5/reference-to-video')).toBe(true);
  });

  it('sends the locked seed too, because that endpoint takes one', async () => {
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.seed === 4242)).toBe(true);
  });

  it('does NOT send a seed to an endpoint that takes none as input', async () => {
    // Seedance 2.5 text-to-video RETURNS a seed and accepts none. A locked seed
    // there is an unsupported parameter, not a stronger identity lock.
    const noRefs = { ...SHOT_PLAN, aspectRatio: '9:16' };
    const { svc, mediaGen } = prodHarness({
      plan: { ...noRefs, shots: noRefs.shots.map((sh) => ({ ...sh, reference: { images: [], seed: 7 } })) },
      campaignOver: { defaultVideoModel: 'bytedance/seedance-2.5/text-to-video' },
    });
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.seed === undefined)).toBe(true);
    expect(calls.every((c) => c.referenceImageUrls === undefined)).toBe(true);
  });

  it('leaves a plan with no persona exactly as it was', async () => {
    const { svc, mediaGen } = prodHarness({ plan: { ...SHOT_PLAN, aspectRatio: '9:16' } });
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.referenceImageUrls === undefined)).toBe(true);
    expect(calls.every((c) => c.model === DEFAULT_VIDEO_MODEL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defect 7 — a blanket refusal that cost the feature, replaced by disclosure.
// ---------------------------------------------------------------------------

/**
 * `assertDestinationsCanCarry` refused any approval whose campaign targeted an
 * account that could not publish EVERY beat. Measured against the real network
 * table that is seven of the eight networks — every concept is at least
 * `MIN_SHOTS_PER_CONCEPT` (2) beats and only an Instagram FEED carousel carries
 * two — so a vertical-video feature published on all-Instagram campaigns and
 * nowhere else. Its escape hatch ("plan the concept as a single beat") did not
 * exist either: `MIN_SHOTS_PER_CONCEPT` forbids a one-beat concept two files
 * away.
 *
 * The refusal is gone. What replaces it is DISCLOSURE, before the money moves.
 */
describe('ConceptPromotionService — capacity no longer refuses an approval', () => {
  const TT = [{ id: 'acc-tt', network: 'TIKTOK', displayName: '@figurunica', enabled: true }];
  const FB = [{ id: 'acc-fb', network: 'FACEBOOK', displayName: 'Figurunica Sayfa', enabled: true }];
  const X = [{ id: 'acc-x', network: 'TWITTER', displayName: '@figurunica', enabled: true }];

  it.each([
    ['TIKTOK', TT],
    ['FACEBOOK', FB],
    ['TWITTER', X],
  ])('produces a three-beat concept into a %s campaign instead of refusing it', async (_n, rows) => {
    const { svc, createItem, scheduledJobs } = harness({ accountRows: rows });
    const res = await svc.promote(WS, CONCEPT_ID);
    expect(res.created).toBe(true);
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(scheduledJobs.schedule).toHaveBeenCalled();
  });

  it('does not read the target accounts at all on the approval path', async () => {
    // The old refusal's read. Its absence is the point: approval asks the
    // campaign's status and its quote, and nothing about capacity.
    const { svc, prisma } = harness({ accountRows: TT });
    await svc.promote(WS, CONCEPT_ID);
    expect(prisma.socialAccount.findMany).not.toHaveBeenCalled();
  });

  it('still refuses a campaign that cannot publish AT ALL — the money guard stays', async () => {
    const { svc, createItem } = harness({ campaignRow: campaign({ status: 'DRAFT' }), accountRows: TT });
    await expect(svc.promote(WS, CONCEPT_ID)).rejects.toThrow(BadRequestException);
    expect(createItem).not.toHaveBeenCalled();
  });
});

/**
 * WHAT EACH DESTINATION WILL ACTUALLY RECEIVE — the honest replacement for the
 * refusal, said before a human approves rather than after they are charged.
 */
describe('ConceptPromotionService.describeDestinations — said before approval', () => {
  const ACCOUNTS = [
    { id: 'acc-ig', network: 'INSTAGRAM', displayName: '@figurunica', enabled: true },
    { id: 'acc-tt', network: 'TIKTOK', displayName: '@figurunica', enabled: true },
    { id: 'acc-x', network: 'TWITTER', displayName: '@figurunica', enabled: true },
  ];

  function previewHarness(accountRows = ACCOUNTS, targetIds = ['acc-ig', 'acc-tt', 'acc-x']) {
    const h = harness({ accountRows });
    h.prisma.socialCampaign.findMany = jest
      .fn()
      .mockResolvedValue([{ id: CAMPAIGN_ID, targetAccountIds: targetIds }]);
    return h;
  }

  it('says all three things about one five-beat concept', async () => {
    const { svc } = previewHarness();
    const out = await svc.describeDestinations(WS, CAMPAIGN_ID, 5);

    expect(out.map((d) => [d.network, d.willPublish, d.willDrop])).toEqual([
      ['INSTAGRAM', 5, 0],
      ['TIKTOK', 1, 4],
      ['TWITTER', 0, 5],
    ]);
    expect(out[0].summary).toMatch(/all 5 clips, as a carousel/);
    expect(out[1].summary).toMatch(/beat 1 only/);
    expect(out[1].summary).toMatch(/TIKTOK carries 1 video per post/);
    expect(out[2].summary).toMatch(/nothing/);
    expect(out[2].summary).toMatch(/cannot carry video/);
    expect(out.map((d) => d.publishesNothing)).toEqual([false, false, true]);
  });

  it('names the ACCOUNT, not only the network — the human has to know which one', async () => {
    const { svc } = previewHarness();
    const out = await svc.describeDestinations(WS, CAMPAIGN_ID, 5);
    expect(out.every((d) => d.summary.includes('@figurunica'))).toBe(true);
  });

  it('shows a DISCONNECTED account, which the old refusal could not see at all', async () => {
    // `assertDestinationsCanCarry` read `enabled: true` only, so a disconnected
    // X account was invisible at approval and attached at publish. Here it is
    // named, and named as receiving nothing.
    const { svc } = previewHarness(
      [{ id: 'acc-x', network: 'TWITTER', displayName: '@figurunica', enabled: false }],
      ['acc-x'],
    );
    const out = await svc.describeDestinations(WS, CAMPAIGN_ID, 5);
    expect(out).toHaveLength(1);
    expect(out[0].publishesNothing).toBe(true);
    expect(out[0].summary).toMatch(/disconnected/);
  });

  it('scopes both reads by workspace — a target id on a campaign is not authority', async () => {
    const { svc, prisma } = previewHarness();
    await svc.describeDestinations(WS, CAMPAIGN_ID, 5);
    expect(prisma.socialCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
    expect(prisma.socialAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
  });

  it('an unscoped concept has no destinations to describe, and reads nothing', async () => {
    const { svc, prisma } = previewHarness();
    expect(await svc.describeDestinations(WS, null, 5)).toEqual([]);
    expect(prisma.socialCampaign.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Defect: the persona substitution that multiplied the bill in silence.
// ---------------------------------------------------------------------------

/**
 * A plan carries the purchase it was quoted for — the endpoint, the billed
 * seconds, the price — and production BUYS THAT. It does not re-decide.
 *
 * The regression this closes: `produce()` swapped the campaign's model for the
 * reference-to-video endpoint whenever a shot carried reference frames, at 48
 * credits per second against the platform default's 3 and with a 4-second floor
 * under beats approved at 3. A 5-beat 15-second concept went from 45 credits to
 * 960 — real cash on the engine path — and the only trace was a `logger.log`
 * written after a human had approved a plan that said otherwise.
 */
describe('ConceptPromotionService.produce — it buys what the plan was quoted for', () => {
  // Quoted on Veo 3.1 Fast, whose duration enum is 4/6/8 — so beats planned at
  // 2, 3 and 4 seconds were quoted, and will be charged, at 4, 6 and 8. The
  // campaign has since been pointed at a different (and dearer) endpoint, which
  // is the whole test: production buys the plan a human approved, not whatever
  // the campaign says today.
  const QUOTED = {
    model: 'fal-ai/veo3.1/fast',
    modelSource: 'campaign' as const,
    aspectRatio: '9:16',
    billedSecPerBeat: [4, 6, 8],
    billedSec: 18,
    credits: 270,
    usd: 2.7,
  };
  const quotedPlan = { ...SHOT_PLAN, aspectRatio: '9:16', production: QUOTED };

  const item = (over: Record<string, unknown> = {}) => ({
    id: ITEM_ID,
    workspaceId: WS,
    socialCampaignId: CAMPAIGN_ID,
    contentConceptId: CONCEPT_ID,
    status: 'GENERATING',
    generatedAssetIds: [],
    socialPostId: null,
    scheduledFor: new Date('2026-09-02T09:00:00Z'),
    topic: 'Bunun motoru yok.',
    campaign: campaign({ defaultVideoModel: 'bytedance/seedance-2.5/text-to-video' }),
    ...over,
  });

  function prodHarness(over: { plan?: unknown; itemOver?: Record<string, unknown> } = {}) {
    const h = harness({ conceptRow: concept({ shotPlan: over.plan ?? quotedPlan }) });
    h.prisma.socialCampaignItem.findFirst = jest.fn().mockResolvedValue(item(over.itemOver));
    return h;
  }

  it('runs the model ON THE PLAN, not the campaign own and not a fresh decision', async () => {
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);

    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.model === QUOTED.model)).toBe(true);
    // Emphatically not the campaign's current choice, which nobody was quoted
    // for and which costs 48 credits a second against this model's 15.
    expect(calls.every((c) => c.model !== 'bytedance/seedance-2.5/text-to-video')).toBe(true);
  });

  it('buys each beat at the length the quote named, not the raw beat', async () => {
    // The beats read 2, 3 and 4 seconds. The model's own enum makes them 4, 6
    // and 8 — which is what the quote says and what the invoice will say.
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.map((c) => c.durationSec)).toEqual([4, 6, 8]);
  });

  it('does not go looking for a model when the plan already names one', async () => {
    const { svc, mediaGen } = prodHarness();
    await svc.produce(ITEM_ID, WS);
    expect(mediaGen.workspaceDefaultModel).not.toHaveBeenCalled();
  });

  it('a plan with no quote gets one, resolved and WRITTEN BACK', async () => {
    // Every plan already in the database. It is produced (not failed), and the
    // record of what it bought lands on the plan itself, so no plan stays silent
    // about its own purchase.
    const legacy = { ...SHOT_PLAN };
    delete (legacy as Record<string, unknown>).production;
    const { svc, prisma, mediaGen } = prodHarness({
      plan: legacy,
      itemOver: { campaign: campaign({ defaultVideoModel: null }) },
    });

    await svc.produce(ITEM_ID, WS);

    expect(mediaGen.workspaceDefaultModel).toHaveBeenCalledWith(WS, 'VIDEO');
    const written = prisma.contentConcept.updateMany.mock.calls.at(-1)[0];
    expect(written.where).toEqual(expect.objectContaining({ id: CONCEPT_ID, workspaceId: WS }));
    expect(written.data.shotPlan.production).toEqual(
      expect.objectContaining({
        model: DEFAULT_VIDEO_MODEL,
        modelSource: 'platform',
        credits: 27,
      }),
    );
  });

  it('a persona plan is bought on the endpoint the plan names for it', async () => {
    // The substitution itself is decided and priced at PLANNING time (see
    // content-concepts.service.spec.ts); here it is simply obeyed.
    const REFS = ['https://cdn.example/deniz-1.jpg'];
    const personaPlan = {
      ...SHOT_PLAN,
      aspectRatio: '9:16',
      production: {
        model: 'bytedance/seedance-2.5/reference-to-video',
        modelSource: 'persona',
        replacedModel: DEFAULT_VIDEO_MODEL,
        aspectRatio: '9:16',
        billedSecPerBeat: [4, 4, 4],
        billedSec: 12,
        credits: 576,
        usd: 5.676,
      },
      shots: SHOT_PLAN.shots.map((sh) => ({ ...sh, durationSec: 4, reference: { images: REFS, seed: 4242 } })),
    };
    const { svc, mediaGen } = prodHarness({ plan: personaPlan });

    await svc.produce(ITEM_ID, WS);

    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.every((c) => c.model === 'bytedance/seedance-2.5/reference-to-video')).toBe(true);
    expect(calls.every((c) => JSON.stringify(c.referenceImageUrls) === JSON.stringify(REFS))).toBe(true);
    expect(calls.every((c) => c.seed === 4242)).toBe(true);
  });
});

/**
 * THE QUOTE HAS TO SURVIVE THE CAMPAIGN CHOICE.
 *
 * A concept is quoted against the model that will run it. A reviewer may
 * approve it into a DIFFERENT campaign, and a campaign carries its own
 * `defaultVideoModel` — 3 credits per second on the platform default, 48 on
 * Seedance 2.5. Producing under a model nobody was quoted for is the same
 * defect as the silent persona substitution, arriving through the other door.
 *
 * Refused in `requireCampaign`, which `review()` calls BEFORE the verdict — so
 * the concept stays PROPOSED and every remedy is still open.
 */
describe('ConceptPromotionService.requireCampaign — the approved price is the charged price', () => {
  const quoted = {
    model: DEFAULT_VIDEO_MODEL,
    modelSource: 'platform' as const,
    aspectRatio: '9:16',
    billedSecPerBeat: [2, 3, 4],
    billedSec: 9,
    credits: 27,
    usd: 0.225,
  };
  const planQuoted = { ...SHOT_PLAN, production: quoted };

  it('refuses a campaign whose model is not the one the reviewer was quoted, naming both prices', async () => {
    const { svc } = harness({
      campaignRow: campaign({ defaultVideoModel: 'bytedance/seedance-2.5/text-to-video' }),
    });

    await expect(
      svc.requireCampaign(WS, CAMPAIGN_ID, { plan: planQuoted as never }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.requireCampaign(WS, CAMPAIGN_ID, { plan: planQuoted as never }),
    ).rejects.toThrow(/27 credits/);
    await expect(
      svc.requireCampaign(WS, CAMPAIGN_ID, { plan: planQuoted as never }),
    ).rejects.toThrow(/bytedance\/seedance-2\.5\/text-to-video/);
  });

  it('accepts the campaign the plan was quoted against', async () => {
    const { svc } = harness({ campaignRow: campaign({ defaultVideoModel: null }) });
    await expect(
      svc.requireCampaign(WS, CAMPAIGN_ID, { plan: planQuoted as never }),
    ).resolves.toMatchObject({ id: CAMPAIGN_ID });
  });

  it('says nothing about a plan that was never quoted', async () => {
    // Plans made before the quote existed promised nobody anything, and
    // refusing them would strand approved work over a promise never made.
    const { svc } = harness({
      campaignRow: campaign({ defaultVideoModel: 'bytedance/seedance-2.5/text-to-video' }),
    });
    await expect(
      svc.requireCampaign(WS, CAMPAIGN_ID, { plan: SHOT_PLAN as never }),
    ).resolves.toMatchObject({ id: CAMPAIGN_ID });
  });

  /**
   * ...AND ONLY ON THAT SIDE OF THE VERDICT.
   *
   * The refusal is safe because `review()` asks it while the concept is still
   * PROPOSED. `promote()` runs AFTER the approval is written, and it is also the
   * only route back for an APPROVED concept whose item was never created or was
   * cascaded away with its campaign — the state `ContentConceptsService.produce`
   * exists to rescue. Asking the same question there turns a legitimate campaign
   * edit into a permanent strand: the concept cannot be decided again, so a
   * throw at this point has no remedy behind it at all.
   */
  it('does NOT re-ask the quote question on the post-approval recovery path', async () => {
    // The rescue state: APPROVED, no item, and the campaign's model has been
    // changed since the reviewer approved the quote.
    const { svc, createItem } = harness({
      conceptRow: concept({ shotPlan: planQuoted, promotedItemId: null }),
      campaignRow: campaign({ defaultVideoModel: 'bytedance/seedance-2.5/text-to-video' }),
    });

    const res = await svc.promote(WS, CONCEPT_ID);

    expect(res.created).toBe(true);
    expect(createItem).toHaveBeenCalledTimes(1);
  });

  it('still refuses the same mismatch at the PRE-VERDICT door', async () => {
    // The guarantee itself, unchanged: the check that protects the payer lives
    // where the concept is still PROPOSED and every remedy is still open.
    const { svc } = harness({
      campaignRow: campaign({ defaultVideoModel: 'bytedance/seedance-2.5/text-to-video' }),
    });
    await expect(
      svc.requireCampaign(WS, CAMPAIGN_ID, { plan: planQuoted as never }),
    ).rejects.toThrow(/a price nobody approved/);
  });
});

describe('ConceptPromotionService.resolveVideoModel — a storyboarded plan animates', () => {
  function svcWith(workspaceVideoModel: string = DEFAULT_VIDEO_MODEL) {
    return new ConceptPromotionService(
      {} as any,
      { workspaceDefaultModel: jest.fn().mockResolvedValue(workspaceVideoModel) } as any,
      { schedule: jest.fn() } as any,
      { registerHandler: jest.fn() } as any,
      { arm: jest.fn() } as any,
    );
  }

  it('swaps the platform text-to-video default for its image-to-video twin and names the frame model', async () => {
    await expect(svcWith().resolveVideoModel(WS, null, { wantsReference: false, storyboard: true })).resolves.toEqual({
      model: DEFAULT_VIDEO_ANIMATE_MODEL, modelSource: 'storyboard', replacedModel: DEFAULT_VIDEO_MODEL, keyframeModel: DEFAULT_KEYFRAME_MODEL,
    });
  });

  it('keeps a premium campaign choice in its own family', async () => {
    await expect(svcWith().resolveVideoModel(WS, 'bytedance/seedance-2.5/text-to-video', { wantsReference: false, storyboard: true })).resolves.toEqual({
      model: 'bytedance/seedance-2.5/image-to-video', modelSource: 'storyboard', replacedModel: 'bytedance/seedance-2.5/text-to-video', keyframeModel: DEFAULT_KEYFRAME_MODEL,
    });
    // A campaign that already chose an animator keeps it, and stays "campaign".
    await expect(svcWith().resolveVideoModel(WS, 'bytedance/seedance-2.5/image-to-video', { wantsReference: false, storyboard: true })).resolves.toEqual({
      model: 'bytedance/seedance-2.5/image-to-video', modelSource: 'campaign', keyframeModel: DEFAULT_KEYFRAME_MODEL,
    });
  });

  it('carries a persona through the FRAMES, not through reference-to-video', async () => {
    await expect(svcWith().resolveVideoModel(WS, null, { wantsReference: true, storyboard: true })).resolves.toEqual({
      model: DEFAULT_VIDEO_ANIMATE_MODEL, modelSource: 'storyboard', replacedModel: DEFAULT_VIDEO_MODEL, keyframeModel: DEFAULT_KEYFRAME_REFERENCE_MODEL,
    });
  });

  it('leaves the legacy answers exactly as they were', async () => {
    await expect(svcWith().resolveVideoModel(WS, null, { wantsReference: true, storyboard: false })).resolves.toEqual({
      model: DEFAULT_VIDEO_REFERENCE_MODEL, modelSource: 'persona', replacedModel: DEFAULT_VIDEO_MODEL,
    });
    await expect(svcWith().resolveVideoModel(WS, null, false)).resolves.toEqual({ model: DEFAULT_VIDEO_MODEL, modelSource: 'platform' });
  });
});

describe('ConceptPromotionService.produce — a storyboarded plan animates its frames', () => {
  const FRAMES_QUOTE = {
    model: DEFAULT_VIDEO_ANIMATE_MODEL, modelSource: 'storyboard' as const, replacedModel: DEFAULT_VIDEO_MODEL,
    aspectRatio: '9:16', billedSecPerBeat: [2, 3, 4], billedSec: 9,
    keyframes: { model: DEFAULT_KEYFRAME_MODEL, perFrameCredits: 3, credits: 9, usd: 0.09 },
    credits: 36, usd: 0.2844,
  };
  const storyboardedPlan = (keyframes?: Array<Record<string, unknown> | undefined>) => ({
    ...SHOT_PLAN,
    aspectRatio: '9:16',
    storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 11 },
    production: FRAMES_QUOTE,
    shots: SHOT_PLAN.shots.map((sh, i) => ({
      ...sh,
      description: `scene ${i}`,
      keyframePrompt: `still ${i}, single still frame, vertical 9:16`,
      ...(keyframes?.[i] ? { keyframe: keyframes[i] } : {}),
    })),
  });
  const READY = (i: number) => ({ assetId: `f${i}`, status: 'READY', url: `https://r2/f${i}.png`, model: DEFAULT_KEYFRAME_MODEL, attempts: 1 });

  function prodHarness(plan: { shots: Array<{ keyframe?: Record<string, unknown> }> }, assetRows: unknown[] = []) {
    const h = harness({ conceptRow: concept({ shotPlan: plan }) });
    // `syncFrames` re-reads READY frames too (a swept row must be noticed), so
    // every READY keyframe on the fixture has its row unless a test says otherwise.
    const readyRows = plan.shots.flatMap((sh) =>
      sh.keyframe?.status === 'READY' ? [{ id: sh.keyframe.assetId, status: 'READY', url: sh.keyframe.url, error: null }] : [],
    );
    h.prisma.socialCampaignItem.findFirst = jest.fn().mockResolvedValue({
      id: ITEM_ID, workspaceId: WS, socialCampaignId: CAMPAIGN_ID, contentConceptId: CONCEPT_ID, status: 'GENERATING',
      generatedAssetIds: [], socialPostId: null, scheduledFor: new Date('2026-09-02T09:00:00Z'), topic: 'x',
      campaign: campaign({ defaultVideoModel: null }),
    });
    h.prisma.generatedAsset = { findMany: jest.fn().mockResolvedValue([...readyRows, ...assetRows]) };
    let n = 0;
    h.mediaGen.requestGeneration = jest.fn().mockImplementation(async () => ({ assetId: `gen-${++n}` }));
    return h;
  }

  it('draws the missing frames FIRST, on the item, and waits — no clip is bought yet', async () => {
    const { svc, prisma, mediaGen } = prodHarness(storyboardedPlan(), [
      { id: 'gen-1', status: 'QUEUED', url: null, error: null },
      { id: 'gen-2', status: 'QUEUED', url: null, error: null },
      { id: 'gen-3', status: 'GENERATING', url: null, error: null },
    ]);
    const res = await svc.produce(ITEM_ID, WS);

    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.type === 'IMAGE' && c.model === DEFAULT_KEYFRAME_MODEL && c.campaignItemId === ITEM_ID && c.seed === 11)).toBe(true);
    expect(calls.map((c) => c.prompt)).toEqual(['still 0, single still frame, vertical 9:16', 'still 1, single still frame, vertical 9:16', 'still 2, single still frame, vertical 9:16']);
    // The frames are on the PLAN — written one beat at a time, as each is
    // bought — not on the item's clip list.
    // …three buys, then the sync pass moving the one already rendering.
    expect(kfWrites(prisma).map((w) => [w.idx, w.keyframe.assetId, w.keyframe.status])).toEqual([
      [0, 'gen-1', 'QUEUED'], [1, 'gen-2', 'QUEUED'], [2, 'gen-3', 'QUEUED'], [2, 'gen-3', 'GENERATING'],
    ]);
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ generatedAssetIds: expect.anything() }) }));
    // The frames' wait counter is their own; the clip phase's is untouched.
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { itemId: ITEM_ID, workspaceId: WS, waits: 0, frameWaits: 1 } }) });
  });

  it('animates each beat FROM its READY frame on the quoted animator, and the clip list holds only clips', async () => {
    const { svc, prisma, mediaGen, scheduledJobs } = prodHarness(storyboardedPlan([READY(0), READY(1), READY(2)]));
    await svc.produce(ITEM_ID, WS);

    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.type === 'VIDEO' && c.model === DEFAULT_VIDEO_ANIMATE_MODEL && c.seed === 11)).toBe(true);
    expect(calls.map((c) => c.referenceImageUrls)).toEqual([['https://r2/f0.png'], ['https://r2/f1.png'], ['https://r2/f2.png']]);
    expect(calls.map((c) => c.durationSec)).toEqual([2, 3, 4]);
    expect(calls.map((c) => c.prompt)).toEqual(SHOT_PLAN.shots.map((sh) => sh.prompt));
    const last = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(last.data.generatedAssetIds).toEqual(['gen-1', 'gen-2', 'gen-3']);
    // Handed to the lifecycle: the post exists and the item left GENERATING
    // under the campaign's own autonomy rule (APPROVAL here → NEEDS_APPROVAL).
    expect(prisma.socialPost.create).toHaveBeenCalledTimes(1);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'NEEDS_APPROVAL', generatedAssetIds: ['gen-1', 'gen-2', 'gen-3'] }),
    }));
    expect(scheduledJobs).toBeDefined();
  });

  it('fails the item BY BEAT when a frame was refused for good — no clip is bought, nothing falls back to text', async () => {
    const dead = { assetId: 'f1x', status: 'FAILED', model: DEFAULT_KEYFRAME_MODEL, attempts: 2, error: 'content policy' };
    const { svc, prisma, mediaGen } = prodHarness(storyboardedPlan([READY(0), dead, READY(2)]));
    await svc.produce(ITEM_ID, WS);

    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED', error: expect.stringMatching(/^frame 2\/3 could not be generated: content policy/) }),
    }));
  });

  it('a refused frame with an attempt left is redrawn, not fatal', async () => {
    const retry = { assetId: 'f1x', status: 'FAILED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1, error: 'hiccup' };
    const { svc, mediaGen } = prodHarness(storyboardedPlan([READY(0), retry, READY(2)]), [{ id: 'gen-1', status: 'QUEUED', url: null, error: null }]);
    const res = await svc.produce(ITEM_ID, WS);
    const calls = mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: 'IMAGE', prompt: 'still 1, single still frame, vertical 9:16' });
    expect(res).toEqual({ reschedule: expect.anything() });
  });

  it('frames still not ready at the storyboard bound FAIL the item with the minutes actually waited — its own bound, not the clip queue', async () => {
    const { svc, prisma, mediaGen } = prodHarness(storyboardedPlan([READY(0), { assetId: 'slow', status: 'GENERATING', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 }, READY(2)]), [
      { id: 'slow', status: 'GENERATING', url: null, error: null },
    ]);
    const res = await svc.produce(ITEM_ID, WS, 0, STORYBOARD_MAX_WAITS);
    expect(res).toBeUndefined();
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    const final = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(final.data.status).toBe('FAILED');
    expect(final.data.error).toMatch(/storyboard frames were still not ready after 60 minutes, so no clip was bought/);
    // Below the bound the same state merely waits again.
    const again = prodHarness(storyboardedPlan([READY(0), { assetId: 'slow', status: 'GENERATING', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 }, READY(2)]), [{ id: 'slow', status: 'GENERATING', url: null, error: null }]);
    await expect(again.svc.produce(ITEM_ID, WS, 3, STORYBOARD_MAX_WAITS - 1)).resolves.toEqual({
      reschedule: expect.objectContaining({ payload: { itemId: ITEM_ID, workspaceId: WS, waits: 3, frameWaits: STORYBOARD_MAX_WAITS } }),
    });
  });

  it('a READY frame whose asset row is GONE (swept, deleted) is redrawn — never animated from a dead URL', async () => {
    const h = harness({ conceptRow: concept({ shotPlan: storyboardedPlan([READY(0), READY(1), READY(2)]) }) });
    h.prisma.socialCampaignItem.findFirst = jest.fn().mockResolvedValue({
      id: ITEM_ID, workspaceId: WS, socialCampaignId: CAMPAIGN_ID, contentConceptId: CONCEPT_ID, status: 'GENERATING',
      generatedAssetIds: [], socialPostId: null, scheduledFor: new Date('2026-09-02T09:00:00Z'), topic: 'x',
      campaign: campaign({ defaultVideoModel: null }),
    });
    // Rows for f0 and f2 only: f1 was swept.
    h.prisma.generatedAsset = { findMany: jest.fn().mockResolvedValue([{ id: 'f0', status: 'READY', url: 'https://r2/f0.png', error: null }, { id: 'f2', status: 'READY', url: 'https://r2/f2.png', error: null }]) };
    h.mediaGen.requestGeneration = jest.fn().mockResolvedValue({ assetId: 'gen-1' });
    const res = await h.svc.produce(ITEM_ID, WS);
    const calls = h.mediaGen.requestGeneration.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(calls.map((c) => c.type)).toEqual([]);
    expect(kfWrites(h.prisma)).toEqual([{ idx: 1, keyframe: expect.objectContaining({ status: 'FAILED', attempts: 0, error: expect.stringMatching(/no longer exists/) }) }]);
    expect(res).toEqual({ reschedule: expect.anything() });
  });

  it('the weather (an outage while requesting a frame) fails the item by beat WITHOUT spending the beat attempt', async () => {
    const { svc, prisma, mediaGen } = prodHarness(storyboardedPlan([READY(0), undefined, READY(2)]));
    mediaGen.requestGeneration.mockRejectedValueOnce(new ServiceUnavailableException('Media generation is not configured'));
    await svc.produce(ITEM_ID, WS);
    const final = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(final.data).toMatchObject({ status: 'FAILED', error: 'frame 2/3 could not be requested: Media generation is not configured' });
    expect(kfWrites(prisma)).toEqual([{ idx: 1, keyframe: expect.objectContaining({ assetId: '', status: 'FAILED', attempts: 0 }) }]);
  });
});

/** Keyframe writes decoded off the raw UPDATE's tagged template. */
function kfWrites(prisma: { $executeRaw: jest.Mock }) {
  return prisma.$executeRaw.mock.calls
    .filter((c: unknown[]) => /^\d+$/.test(String(c[1])))
    .map((c: unknown[]) => ({ idx: Number(c[1]), keyframe: JSON.parse(String(c[2])) as Record<string, unknown> }));
}

describe('ConceptPromotionService.promote — the reviewer\'s storyboard becomes the campaign\'s', () => {
  const storyboarded = (keyframes: Array<Record<string, unknown> | undefined>) => ({
    ...SHOT_PLAN,
    storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 5 },
    shots: SHOT_PLAN.shots.map((sh, i) => ({ ...sh, keyframePrompt: `still ${i}`, ...(keyframes[i] ? { keyframe: keyframes[i] } : {}) })),
  });

  it('links the frames drawn on an unscoped concept to the campaign it was approved into, and gives a frame that failed for good a fresh start', async () => {
    const dead = { assetId: 'f1', status: 'BLOCKED', model: DEFAULT_KEYFRAME_MODEL, attempts: MAX_FRAME_ATTEMPTS, error: 'policy' };
    const plan = storyboarded([{ assetId: 'f0', status: 'READY', url: 'u', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 }, dead, undefined]);
    const h = harness({ conceptRow: concept({ shotPlan: plan, socialCampaignId: null }) });
    h.prisma.generatedAsset = { updateMany: jest.fn().mockResolvedValue({ count: 2 }) };
    await h.svc.promote(WS, CONCEPT_ID, { socialCampaignId: CAMPAIGN_ID });

    expect(h.prisma.generatedAsset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['f0', 'f1'] }, workspaceId: WS, socialCampaignId: null },
      data: { socialCampaignId: CAMPAIGN_ID },
    });
    expect(kfWrites(h.prisma)).toEqual([{ idx: 1, keyframe: expect.objectContaining({ assetId: '', status: 'QUEUED', attempts: 0 }) }]);
    expect(h.scheduledJobs.schedule).toHaveBeenCalledTimes(1);
  });

  it('a legacy plan is promoted exactly as before — nothing to link, nothing to reset', async () => {
    const h = harness();
    h.prisma.generatedAsset = { updateMany: jest.fn() };
    await h.svc.promote(WS, CONCEPT_ID);
    expect(h.prisma.generatedAsset.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('a failed adoption is logged, not fatal: the item exists and production is enqueued either way', async () => {
    const plan = storyboarded([{ assetId: 'f0', status: 'READY', url: 'u', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 }, undefined, undefined]);
    const h = harness({ conceptRow: concept({ shotPlan: plan }) });
    h.prisma.generatedAsset = { updateMany: jest.fn().mockRejectedValue(new Error('db down')) };
    const { created } = await h.svc.promote(WS, CONCEPT_ID);
    expect(created).toBe(true);
    expect(h.scheduledJobs.schedule).toHaveBeenCalledTimes(1);
  });
});

describe('ConceptPromotionService.promote — a programme names the slot', () => {
  /**
   * The programme plans its calendar AHEAD (T-36h concept, T-12h clips) and the
   * slot is already decided when the concept is promoted. The campaign's own
   * cadence would put the item at the NEXT free cadence slot, which is a
   * different moment — usually the one the programme has already filled with
   * another slot.
   */
  it('creates the item at exactly scheduledFor when the caller supplies one', async () => {
    const at = new Date('2026-09-20T15:00:00Z');
    const { svc, createItem } = harness();

    await svc.promote(WS, CONCEPT_ID, { scheduledFor: at });

    expect(createItem).toHaveBeenCalledTimes(1);
    expect(createItem.mock.calls[0][0].data.scheduledFor).toEqual(at);
  });

  it('falls back to the cadence slot when none is supplied', async () => {
    const { svc, createItem } = harness();
    await svc.promote(WS, CONCEPT_ID);
    const scheduledFor: Date = createItem.mock.calls[0][0].data.scheduledFor;
    // Monday/Wednesday/Friday at 09:00 UTC, per the harness campaign's cadence.
    expect([1, 3, 5]).toContain(scheduledFor.getUTCDay());
    expect(scheduledFor.getUTCHours()).toBe(9);
  });
});

// ---------------------------------------------------------------------------
/**
 * A PROGRAMME's item asks the programme before every purchase. This job
 * re-enters after each queue wait, so a kill or a pause can land between two
 * clips; `kill()` leaves PRODUCING slots alone on the promise that the job
 * stops itself, and this is that promise.
 */
describe('ConceptPromotionService.produce — a programme item stops for its programme', () => {
  const promotedItem = (programmeId: string | null) => ({
    id: ITEM_ID,
    workspaceId: WS,
    socialCampaignId: CAMPAIGN_ID,
    contentConceptId: CONCEPT_ID,
    status: 'GENERATING',
    generatedAssetIds: [],
    socialPostId: null,
    scheduledFor: new Date('2026-09-02T09:00:00Z'),
    topic: 'Bunun motoru yok.',
    campaign: campaign({ automationMode: 'FULL_AUTO', programmeId }),
  });

  function programmeHarness(programme: unknown, programmeId: string | null = 'prog-1') {
    const h = harness();
    h.prisma.socialCampaignItem.findFirst = jest.fn().mockResolvedValue(promotedItem(programmeId));
    h.prisma.contentProgramme = { findFirst: jest.fn().mockResolvedValue(programme) };
    return h;
  }

  it('KILLED programme: the item FAILS "the programme was killed" and NOTHING is bought', async () => {
    const { svc, prisma, mediaGen } = programmeHarness({ status: 'KILLED', killSwitch: true });
    const res = await svc.produce(ITEM_ID, WS);
    expect(res).toBeUndefined();
    expect(prisma.contentProgramme.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prog-1', workspaceId: WS } }),
    );
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith({
      where: { id: ITEM_ID },
      data: { status: 'FAILED', error: 'the programme was killed' },
    });
  });

  it('the kill FLAG alone is enough, and so is a programme that no longer exists', async () => {
    for (const programme of [{ status: 'ACTIVE', killSwitch: true }, null]) {
      const { svc, prisma, mediaGen } = programmeHarness(programme);
      await svc.produce(ITEM_ID, WS);
      expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
      expect(prisma.socialCampaignItem.update.mock.calls.at(-1)[0].data).toMatchObject({ status: 'FAILED' });
    }
  });

  it('PAUSED programme: holds an hour without buying, keeping the wait budget it came in with', async () => {
    const { svc, prisma, mediaGen } = programmeHarness({ status: 'PAUSED', killSwitch: false });
    const before = Date.now();
    const res = await svc.produce(ITEM_ID, WS, 4, 2);
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).not.toHaveBeenCalled();
    expect(res).toEqual({ reschedule: { runAt: expect.any(Date), payload: { itemId: ITEM_ID, workspaceId: WS, waits: 4, frameWaits: 2 } } });
    const runAt = (res as { reschedule: { runAt: Date } }).reschedule.runAt.getTime();
    expect(runAt - before).toBeGreaterThanOrEqual(PROGRAMME_HOLD_MS - 1000);
    expect(runAt - before).toBeLessThanOrEqual(PROGRAMME_HOLD_MS + 5000);
  });

  it('ACTIVE programme: buys as usual', async () => {
    const { svc, mediaGen } = programmeHarness({ status: 'ACTIVE', killSwitch: false });
    await svc.produce(ITEM_ID, WS);
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(3);
  });

  it('an item of a campaign with no programme never asks', async () => {
    const { svc, prisma, mediaGen } = programmeHarness({ status: 'KILLED', killSwitch: true }, null);
    await svc.produce(ITEM_ID, WS);
    expect(prisma.contentProgramme.findFirst).not.toHaveBeenCalled();
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(3);
  });
});
