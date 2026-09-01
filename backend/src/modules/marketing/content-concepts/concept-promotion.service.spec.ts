import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConceptPromotionService, PRODUCE_MAX_WAITS } from './concept-promotion.service';

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
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) => ({
  id: CAMPAIGN_ID,
  workspaceId: WS,
  name: 'Strandbeest',
  status: 'ACTIVE',
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
    createItem?: jest.Mock;
  } = {},
) {
  const createItem =
    over.createItem ??
    jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...data, id: ITEM_ID }),
    );
  const prisma: Record<string, any> = {
    contentConcept: {
      findFirst: jest.fn().mockResolvedValue(over.conceptRow === undefined ? concept() : over.conceptRow),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    socialCampaign: {
      findFirst: jest.fn().mockResolvedValue(over.campaignRow === undefined ? campaign() : over.campaignRow),
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
    socialPost: { create: jest.fn().mockResolvedValue({ id: 'post-1' }) },
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'asset-x' }) };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const svc = new ConceptPromotionService(
    prisma as never,
    mediaGen as never,
    scheduledJobs as never,
    runner as never,
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
