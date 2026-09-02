import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  ContentConceptsService,
  CONCEPT_LIST_LIMIT,
  MAX_CONCEPT_COUNT,
  MAX_SHOT_SEC,
  MIN_SHOT_SEC,
} from './content-concepts.service';
import { ConceptPromotionService } from './concept-promotion.service';
import { DEFAULT_SHOT_ASPECT, VideoPipelineService } from '../video/video-pipeline.service';
import {
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_REFERENCE_MODEL,
} from '../ai/media/media-models.config';

const IDEA =
  'Theo Jansen Strandbeest — rüzgarla yürüyen, motoru olmayan kinetik heykel. 3D baskıyla çıkardık.';

/** What a WELL-BEHAVED model returns: three genuinely different angles. */
const GOOD = [
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

/** The failure this feature exists to prevent: one script, reworded N times. */
const PARAPHRASES = [1, 2, 3].map((n) => ({
  angle: 'açı ' + n,
  hook: 'Bu Strandbeestin motoru yok ve pili de yok ' + n,
  title: 'Motorsuz ' + n,
  rationale: 'aynı',
  shots: [
    { scene: '0-3s', cameraNote: 'geniş', onScreenText: 'Motoru yok ' + n, voiceover: '', description: 'Strandbeest yürüyor geniş plan', durationSec: 3 },
    { scene: '3-6s', cameraNote: 'yakın', onScreenText: 'Pili yok ' + n, voiceover: '', description: 'pervane dönüyor yakın plan', durationSec: 3 },
  ],
}));

const submit = (concepts: unknown[]) => ({
  text: '',
  toolUses: [{ id: 'tu1', name: 'submit_concepts', input: { concepts } }],
  stopReason: 'tool_use',
  usage: { input: 100, output: 900 },
});

/** A persona with real reference frames — the identity lock in its working shape. */
const PERSONA = {
  id: 'persona-1',
  name: 'Deniz',
  status: 'ACTIVE',
  referenceImageUrls: ['https://cdn.example/deniz-1.jpg', 'https://cdn.example/deniz-2.jpg'],
  lockedSeed: 4242,
};

function deps(
  over: {
    aiEnabled?: boolean;
    completion?: unknown;
    completeImpl?: jest.Mock;
    personaRow?: unknown;
    campaignRow?: unknown;
    workspaceVideoModel?: string;
    /** The target accounts of campaign `camp-1`, for the destination preview. */
    destinations?: unknown[];
  } = {},
) {
  const complete = over.completeImpl ?? jest.fn().mockResolvedValue(over.completion ?? submit(GOOD));
  const anthropic = { isEnabled: () => over.aiEnabled ?? true, complete };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    workspace: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ productName: 'Figurunica', productDescription: '3D baskı figür', defaultLanguage: 'tr' }),
    },
    videoPersona: {
      findFirst: jest.fn().mockResolvedValue(over.personaRow === undefined ? PERSONA : over.personaRow),
    },
    contentConcept: {
      createMany: jest.fn().mockResolvedValue({ count: 3 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  // The model resolution is the REAL one, on a real catalogue: the quote a
  // reviewer approves is the whole point of it, and a stub that answers
  // "seedance lite" to every question would make every price assertion below a
  // test of the stub. Only the campaign/promote surfaces stay fakes.
  const mediaGen = {
    workspaceDefaultModel: jest
      .fn()
      .mockResolvedValue(over.workspaceVideoModel ?? DEFAULT_VIDEO_MODEL),
  };
  const realPromotion = new ConceptPromotionService(
    prisma as any,
    mediaGen as any,
    { schedule: jest.fn() } as any,
    { registerHandler: jest.fn() } as any,
    { arm: jest.fn() } as any,
  );
  const promotion = {
    requireCampaign: jest
      .fn()
      .mockResolvedValue(over.campaignRow ?? { id: 'camp-1', workspaceId: 'ws1', defaultVideoModel: null }),
    promote: jest.fn().mockResolvedValue({ item: { id: 'item-1', status: 'GENERATING' }, created: true }),
    resolveVideoModel: realPromotion.resolveVideoModel.bind(realPromotion),
    // The destination preview's account read. Defaults to "no destinations
    // known"; the tests that care supply real accounts.
    destinationAccounts: jest
      .fn()
      .mockResolvedValue(new Map<string, unknown[]>(over.destinations ? [['camp-1', over.destinations]] : [])),
  };
  const svc = new ContentConceptsService(
    prisma as any,
    anthropic as any,
    credits as any,
    new VideoPipelineService(),
    promotion as any,
  );
  return { svc, prisma, credits, complete, anthropic, promotion, mediaGen };
}

const plan = (svc: ContentConceptsService, over: Record<string, unknown> = {}) =>
  svc.planConcepts('ws1', { idea: IDEA, count: 3, createdById: 'u1', ...over });

describe('ContentConceptsService.planConcepts', () => {
  /**
   * The campaign a batch is scoped to is checked BEFORE the Opus call, not at
   * approval time.
   *
   * `socialCampaignId` used to be accepted optional and unvalidated, so a bad
   * (or unpublishable, or somebody else's) campaign id cost a full concept
   * batch — one Opus call, credits reserved and spent — and only then met
   * `requireCampaign` in `review()`, which refused. The refusal was correct and
   * arrived after the money.
   */
  it('validates the named campaign BEFORE reserving credits or calling the model', async () => {
    const { svc, credits, promotion, complete } = deps();
    promotion.requireCampaign.mockRejectedValue(
      new BadRequestException('Social campaign "Draft" is DRAFT'),
    );

    await expect(plan(svc, { socialCampaignId: 'camp-draft' })).rejects.toThrow(/DRAFT/);

    // The campaign's EXISTENCE and STATUS, and nothing about capacity: no extra
    // argument rides along, because there is no capacity refusal left to feed.
    expect(promotion.requireCampaign).toHaveBeenCalledWith('ws1', 'camp-draft');
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not read a campaign when the idea arrived unscoped', async () => {
    // Planning without a campaign is legitimate — the reviewer names one at
    // approval. A lookup with nothing to look up would be a round trip per call.
    const { svc, promotion } = deps();
    await plan(svc);
    expect(promotion.requireCampaign).not.toHaveBeenCalled();
  });

  it('turns one idea into N concepts, each carrying a real shot plan', async () => {
    const { svc } = deps();
    const res = await plan(svc);

    expect(res.concepts).toHaveLength(3);
    expect(res.sourceIdea).toBe(IDEA);
    expect(res.batchId).toEqual(expect.any(String));
    // Every concept shares the batch, and keeps the order it was proposed in.
    expect(res.concepts.map((c) => c.batchId)).toEqual([res.batchId, res.batchId, res.batchId]);
    expect(res.concepts.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(res.concepts.map((c) => c.status)).toEqual(['PROPOSED', 'PROPOSED', 'PROPOSED']);

    // The shot plan is VideoPipelineService's real output, not a passthrough of
    // the model's JSON: the per-model prompt formatting is applied on top.
    const first = res.concepts[0].shotPlan;
    expect(first.shots).toHaveLength(3);
    expect(first.shots[0].prompt).toMatch(/vertical 9:16/);
    expect(first.shots[0].prompt).toContain('Strandbeest ıslak kumda yürüyor');
    expect(first.shots.map((s) => s.durationSec)).toEqual([2, 3, 4]);
    expect(first.durationSec).toBe(9);
    expect(first.captionSuggestion).toBeTruthy();
    expect(first.qcChecklist.length).toBeGreaterThan(0);
  });

  it('keeps on-screen text and voiceover as separate channels through to the plan', async () => {
    const { svc } = deps();
    const res = await plan(svc);
    expect(res.concepts[0].shotPlan.shots[0].onScreenText).toBe('Bunun motoru yok.');
    expect(res.concepts[0].shotPlan.shots[0].voiceover).toBe('');
    // A wholly silent concept survives: the sensory angle has no words at all.
    expect(res.concepts[2].shotPlan.shots.every((s) => s.voiceover === '' && !s.onScreenText)).toBe(true);
  });

  it('persists the batch in ONE write, stamped with the workspace', async () => {
    const { svc, prisma } = deps();
    const res = await plan(svc, { socialCampaignId: 'sc1' });

    expect(prisma.contentConcept.createMany).toHaveBeenCalledTimes(1);
    const rows = prisma.contentConcept.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.workspaceId === 'ws1')).toBe(true);
    expect(rows.every((r: any) => r.createdById === 'u1')).toBe(true);
    expect(rows.every((r: any) => r.socialCampaignId === 'sc1')).toBe(true);
    expect(rows.map((r: any) => r.angle)).toEqual(['curiosity', 'engineering', 'sensory']);
    expect(rows[0].id).toBe(res.concepts[0].id);
  });

  it('feeds the workspace brand into the prompt so a concept can land somewhere', async () => {
    const { svc, complete } = deps();
    await plan(svc);
    const sent = JSON.stringify(complete.mock.calls[0][0]);
    expect(sent).toContain('Figurunica');
    expect(sent).toContain('Strandbeest');
  });

  // ─────────────────────────────────────────────── the distinctness contract

  it('REFUSES a batch of paraphrases and writes nothing', async () => {
    const { svc, prisma } = deps({ completion: submit(PARAPHRASES) });
    await expect(plan(svc)).rejects.toThrow(BadRequestException);
    await expect(plan(svc)).rejects.toThrow(/hook|angle|reworded/i);
    expect(prisma.contentConcept.createMany).not.toHaveBeenCalled();
  });

  it('names the colliding pair in the refusal so the next attempt can fix it', async () => {
    const { svc } = deps({ completion: submit(PARAPHRASES) });
    await expect(plan(svc)).rejects.toThrow(/#1 and #2|#1 and #3/);
  });

  it('refuses fewer concepts than were asked for rather than quietly returning two', async () => {
    const { svc, prisma } = deps({ completion: submit(GOOD.slice(0, 2)) });
    await expect(plan(svc, { count: 3 })).rejects.toThrow(/asked for 3/i);
    expect(prisma.contentConcept.createMany).not.toHaveBeenCalled();
  });

  it('caps the requested count instead of accepting an unbounded one', async () => {
    const { svc } = deps();
    await expect(plan(svc, { count: MAX_CONCEPT_COUNT + 1 })).rejects.toThrow(BadRequestException);
    await expect(plan(svc, { count: 1 })).rejects.toThrow(BadRequestException);
  });

  // ──────────────────────────────────── beats a generator can actually produce
  //
  // `jeeta.generate_video` accepts `.int().min(1).max(10)` and
  // `MediaGenService.requestGeneration` clamps to `MEDIA_GEN_MAX_VIDEO_SEC`
  // (10). A concept is APPROVED once and cannot be re-decided, so anything
  // outside that window would be approved and then die at generation with no
  // way back. The model's number is therefore bounded on the way in.

  /** A batch whose FIRST concept carries the given beat lengths verbatim. */
  const withDurations = (...durations: unknown[]) => [
    {
      ...GOOD[0],
      shots: durations.map((d, i) => ({
        ...GOOD[0].shots[i % GOOD[0].shots.length],
        scene: `${i}s`,
        durationSec: d,
      })),
    },
    GOOD[1],
    GOOD[2],
  ];

  const firstPlan = (res: Awaited<ReturnType<ContentConceptsService['planConcepts']>>) =>
    res.concepts[0].shotPlan;

  it('clamps a beat no generator could accept down to the ceiling', async () => {
    // Measured before this guard existed: a 1800s beat persisted whole and the
    // concept reported `durationSec: 1800`.
    const { svc } = deps({ completion: submit(withDurations(1800, 4)) });
    const plan1 = firstPlan(await plan(svc));
    expect(plan1.shots.map((s) => s.durationSec)).toEqual([MAX_SHOT_SEC, 4]);
    // The plan's total is the beats' own sum, so it is bounded by them.
    expect(plan1.durationSec).toBe(MAX_SHOT_SEC + 4);
  });

  it('lifts a beat that rounds to zero up to the shortest producible one', async () => {
    // `Math.round(0.4)` is 0 and `custom?.durationSec ?? per` treats 0 as
    // supplied, so a zero-length beat used to survive all the way to the row.
    const { svc } = deps({ completion: submit(withDurations(0.4, 3)) });
    expect(firstPlan(await plan(svc)).shots.map((s) => s.durationSec)).toEqual([MIN_SHOT_SEC, 3]);
  });

  it('bounds a negative beat instead of subtracting it from the concept', async () => {
    const { svc } = deps({ completion: submit(withDurations(-5, 3)) });
    const plan1 = firstPlan(await plan(svc));
    expect(plan1.shots.map((s) => s.durationSec)).toEqual([MIN_SHOT_SEC, 3]);
    expect(plan1.durationSec).toBe(MIN_SHOT_SEC + 3);
  });

  it('falls back to the even split when the length is not a usable number', async () => {
    // NaN/Infinity/a string are not a length the model supplied — they are the
    // absence of one, and the planner's even split is the honest answer.
    const { svc } = deps({ completion: submit(withDurations(Number.NaN, Number.POSITIVE_INFINITY, 'iki saniye')) });
    const lengths = firstPlan(await plan(svc)).shots.map((s) => s.durationSec);
    expect(lengths).toEqual([5, 5, 5]); // 15s target over 3 beats
  });

  it('PERSISTS nothing outside the window a generator accepts', async () => {
    const { svc, prisma } = deps({ completion: submit(withDurations(1800, 0.4)) });
    await plan(svc);
    const rows = prisma.contentConcept.createMany.mock.calls[0][0].data;
    const beats = rows.flatMap((r: any) => r.shotPlan.shots.map((s: any) => s.durationSec));
    // Anchored on a positive count first: an empty list would satisfy `every`.
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.every((d: number) => Number.isInteger(d) && d >= MIN_SHOT_SEC && d <= MAX_SHOT_SEC)).toBe(
      true,
    );
    expect(
      rows.every((r: any) => r.shotPlan.durationSec <= r.shotPlan.shots.length * MAX_SHOT_SEC),
    ).toBe(true);
  });

  // ───────────────────────────────────────────────── error is not emptiness

  it('says AI is unavailable rather than returning an empty batch', async () => {
    const { svc, prisma } = deps({ aiEnabled: false });
    await expect(plan(svc)).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.contentConcept.createMany).not.toHaveBeenCalled();
  });

  it('does not report "no good ideas" when the model returns nothing at all', async () => {
    const { svc } = deps({ completion: submit([]) });
    await expect(plan(svc)).rejects.toThrow(/produced no concepts/i);
  });

  it('does not report success when the model never called the submit tool', async () => {
    const { svc } = deps({
      completion: { text: 'Bence bu fikir zayıf.', toolUses: [], stopReason: 'end_turn', usage: { input: 1, output: 1 } },
    });
    await expect(plan(svc)).rejects.toThrow(/did not submit/i);
  });

  it('refunds and rethrows when the model call itself fails', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('anthropic 529'));
    const { svc, credits, prisma } = deps({ completeImpl: boom });
    await expect(plan(svc)).rejects.toThrow('anthropic 529');
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(prisma.contentConcept.createMany).not.toHaveBeenCalled();
  });

  it('keeps the charge when the call RETURNED but its output failed the contract', async () => {
    // Vendor spend that actually happened stays charged — the same rule ask-ai,
    // research and the command bar follow. Refunding it would let a workspace
    // sitting at its cap replay the call for free.
    const { svc, credits } = deps({ completion: submit(PARAPHRASES) });
    await expect(plan(svc)).rejects.toThrow(BadRequestException);
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
  });
});

/**
 * Defect 7's replacement, at the surface a human actually reads.
 *
 * Nothing is refused over destination capacity any more, so the reviewer has to
 * be TOLD what each destination will receive before they approve — approving is
 * what starts the spend, and `jeeta.list_content_concepts` plus the freshly
 * planned batch are the only two things they see first.
 */
describe('ContentConceptsService — the reviewer is told what each destination gets', () => {
  const ACCOUNTS = [
    { id: 'acc-ig', network: 'INSTAGRAM', displayName: '@figurunica', enabled: true },
    { id: 'acc-tt', network: 'TIKTOK', displayName: '@figurunica', enabled: true },
    { id: 'acc-x', network: 'TWITTER', displayName: '@figurunica', enabled: true },
  ];

  it('a freshly planned batch carries a destination line per target account', async () => {
    const { svc, promotion } = deps({ destinations: ACCOUNTS });
    const res = await plan(svc, { socialCampaignId: 'camp-1' });

    expect(promotion.destinationAccounts).toHaveBeenCalledWith('ws1', ['camp-1']);
    // Three beats in GOOD's first concept: Instagram takes all three, TikTok
    // takes the hook, X takes nothing at all — one approval, three truths.
    const first = res.concepts[0].destinations;
    expect(first.map((d) => [d.network, d.willPublish, d.willDrop])).toEqual([
      ['INSTAGRAM', 3, 0],
      ['TIKTOK', 1, 2],
      ['TWITTER', 0, 3],
    ]);
    expect(first[1].summary).toMatch(/beat 1 only/);
    expect(first[2].summary).toMatch(/cannot carry video/);
    // Every concept in the batch gets its own, computed from its own beats.
    expect(res.concepts.every((c) => c.destinations.length === 3)).toBe(true);
  });

  it('an unscoped batch has no destinations, and asks for none', async () => {
    const { svc, promotion } = deps({ destinations: ACCOUNTS });
    const res = await plan(svc);
    expect(res.concepts.every((c) => c.destinations.length === 0)).toBe(true);
    expect(promotion.destinationAccounts).not.toHaveBeenCalled();
  });

  it('the review QUEUE carries them too — that is where an approval is decided from', async () => {
    const { svc, prisma, promotion } = deps({ destinations: ACCOUNTS });
    prisma.contentConcept.findMany.mockResolvedValue([
      { id: 'c1', socialCampaignId: 'camp-1', shotPlan: { shots: [{}, {}, {}, {}, {}] } },
      { id: 'c2', socialCampaignId: null, shotPlan: { shots: [{}, {}] } },
    ]);

    const rows = await svc.list('ws1', { status: 'PROPOSED' });

    expect(promotion.destinationAccounts).toHaveBeenCalledWith('ws1', ['camp-1']);
    // Five beats, so TikTok drops four — the count is the ROW's own, not the
    // batch's.
    expect(rows[0].destinations.map((d) => [d.network, d.willPublish, d.willDrop])).toEqual([
      ['INSTAGRAM', 5, 0],
      ['TIKTOK', 1, 4],
      ['TWITTER', 0, 5],
    ]);
    // A concept with no campaign has no destination to describe.
    expect(rows[1].destinations).toEqual([]);
  });
});

describe('ContentConceptsService.list', () => {
  it('scopes every read to the workspace', async () => {
    const { svc, prisma } = deps();
    await svc.list('ws1', {});
    expect(prisma.contentConcept.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'ws1' });
  });

  it('BOUNDS an unfiltered read — every concept ever planned is not an answer', async () => {
    // Each row carries a whole ShotPlan. Unbounded, "list the concepts" put
    // every batch this workspace has ever planned into one agent turn.
    const { svc, prisma } = deps();
    await svc.list('ws1', {});
    const args = prisma.contentConcept.findMany.mock.calls[0][0];
    expect(args.take).toBe(CONCEPT_LIST_LIMIT);
    // The cap is a whole number of maximum-size batches, so the newest five
    // batches are always complete rather than cut in half.
    expect(CONCEPT_LIST_LIMIT % MAX_CONCEPT_COUNT).toBe(0);
  });

  it('keeps the cap when a filter narrows the read', async () => {
    const { svc, prisma } = deps();
    await svc.list('ws1', { batchId: 'b1' });
    expect(prisma.contentConcept.findMany.mock.calls[0][0].take).toBe(CONCEPT_LIST_LIMIT);
    // One batch is at most MAX_CONCEPT_COUNT rows, so a batch read is never
    // truncated by it.
    expect(MAX_CONCEPT_COUNT).toBeLessThanOrEqual(CONCEPT_LIST_LIMIT);
  });

  it('refuses a status it does not recognise instead of handing it to Prisma', async () => {
    // Safe from MCP (`z.enum`), unsafe from anywhere else: the value used to be
    // cast `as never` straight into a Prisma enum, where an unknown string is a
    // runtime error from the driver rather than a stated refusal.
    const { svc, prisma } = deps();
    await expect(svc.list('ws1', { status: 'ARCHIVED' })).rejects.toThrow(BadRequestException);
    // Case matters — the column holds the enum's own spelling.
    await expect(svc.list('ws1', { status: 'proposed' })).rejects.toThrow(/PROPOSED/);
    expect(prisma.contentConcept.findMany).not.toHaveBeenCalled();
    // Anchored on the positive: the recognised value still reaches Prisma.
    await svc.list('ws1', { status: 'DISCARDED' });
    expect(prisma.contentConcept.findMany.mock.calls[0][0].where.status).toBe('DISCARDED');
  });

  it('narrows by status and batch without dropping the tenant predicate', async () => {
    const { svc, prisma } = deps();
    await svc.list('ws1', { status: 'PROPOSED', batchId: 'b1' });
    expect(prisma.contentConcept.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: 'ws1',
      status: 'PROPOSED',
      batchId: 'b1',
    });
  });
});

describe('ContentConceptsService.review', () => {
  /** The row as it looks after a successful decision. */
  const decided = {
    id: 'c1',
    workspaceId: 'ws1',
    status: 'APPROVED',
    reviewedById: 'u9',
    // The plan the pre-flight now measures: three beats is three clips, which is
    // the number the destination has to be able to carry.
    shotPlan: { shots: [{ ord: 0 }, { ord: 1 }, { ord: 2 }] },
  };

  it('records WHO decided and when, not just the new status', async () => {
    const { svc, prisma } = deps();
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 1 });
    prisma.contentConcept.findFirst.mockResolvedValue(decided);

    const out = await svc.review('ws1', 'c1', {
      decision: 'APPROVED',
      reviewerId: 'u9',
      note: 'bu güzelmiş',
    });

    const data = prisma.contentConcept.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('APPROVED');
    expect(data.reviewedById).toBe('u9');
    expect(data.reviewNote).toBe('bu güzelmiş');
    expect(data.reviewedAt).toBeInstanceOf(Date);
    // updateMany returns a count, so the decided row is read back and returned —
    // now with the item the approval produced hung off it, which is how the
    // caller learns that anything was set in motion.
    expect(out).toMatchObject(decided);
    expect((out as { campaignItem?: { id: string } }).campaignItem).toEqual({
      id: 'item-1',
      status: 'GENERATING',
    });
  });

  it('writes through ONE predicate carrying the workspace AND the PROPOSED state', async () => {
    // Both halves of the fix live in this `where`. Without `workspaceId` the
    // write lands on a neighbour's row (the `findFirst` above it used to be the
    // only thing in the way); without `status` two concurrent reviews both pass
    // a check-then-act and both write.
    const { svc, prisma } = deps();
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 1 });
    prisma.contentConcept.findFirst.mockResolvedValue(decided);

    await svc.review('ws1', 'c1', { decision: 'APPROVED', reviewerId: 'u9' });

    expect(prisma.contentConcept.updateMany.mock.calls[0][0].where).toEqual({
      id: 'c1',
      workspaceId: 'ws1',
      status: 'PROPOSED',
    });
    expect(prisma.contentConcept.update).not.toHaveBeenCalled();
  });

  it('a DISCARD is refused by the WRITE predicate, with no preceding read to lean on', async () => {
    const { svc, prisma } = deps();
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 0 });
    prisma.contentConcept.findFirst.mockResolvedValue(null);
    await expect(
      svc.review('ws1', 'c-next-door', { decision: 'DISCARDED', reviewerId: 'u9' }),
    ).rejects.toThrow(NotFoundException);
    // Discarding costs nothing and needs no campaign, so it keeps the original
    // shape: the write was attempted and its OWN predicate refused it — nothing
    // depends on a preceding read having been done correctly.
    expect(prisma.contentConcept.updateMany.mock.calls[0][0].where.workspaceId).toBe('ws1');
  });

  it('an APPROVAL of a neighbour concept is refused before any verdict is written', async () => {
    // Approving now starts real spend, so this path acquired a pre-flight read:
    // the target campaign must exist before a verdict is recorded. That read is
    // tenant-scoped too, so a neighbour's id never even reaches the write.
    const { svc, prisma } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue(null);
    await expect(
      svc.review('ws1', 'c-next-door', { decision: 'APPROVED', reviewerId: 'u9' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.contentConcept.findFirst.mock.calls[0][0].where).toEqual({
      id: 'c-next-door',
      workspaceId: 'ws1',
    });
    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
  });

  it('approving promotes the concept into a campaign item, on one human decision', async () => {
    const { svc, prisma, promotion } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue({ ...decided, socialCampaignId: 'camp-1' });
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 1 });

    const out = await svc.review('ws1', 'c1', { decision: 'APPROVED', reviewerId: 'u9' });

    expect(promotion.promote).toHaveBeenCalledWith('ws1', 'c1', { socialCampaignId: 'camp-1' });
    expect((out as { campaignItem?: { id: string } }).campaignItem).toEqual({
      id: 'item-1',
      status: 'GENERATING',
    });
  });

  it('a DISCARD produces nothing — the gate is on approval, not on every decision', async () => {
    const { svc, prisma, promotion } = deps();
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 1 });
    prisma.contentConcept.findFirst.mockResolvedValue({ ...decided, status: 'DISCARDED' });
    await svc.review('ws1', 'c1', { decision: 'DISCARDED', reviewerId: 'u9' });
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(promotion.requireCampaign).not.toHaveBeenCalled();
  });

  it('refuses to approve into a campaign that does not exist, and records NO verdict', async () => {
    // The concept stays PROPOSED so the human can retry naming a real campaign.
    // If the verdict landed first, "decided once" would make that retry
    // impossible and leave an approved concept stranded, unproduced.
    const { svc, prisma, promotion } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue({ ...decided, socialCampaignId: 'camp-gone' });
    promotion.requireCampaign.mockRejectedValue(new BadRequestException('no such campaign'));

    await expect(svc.review('ws1', 'c1', { decision: 'APPROVED', reviewerId: 'u9' })).rejects.toThrow(
      /no such campaign/,
    );

    expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
    expect(promotion.promote).not.toHaveBeenCalled();
  });

  it('lets the reviewer name a campaign the concept was never scoped to', async () => {
    const { svc, prisma, promotion } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue({ ...decided, socialCampaignId: null });
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 1 });

    await svc.review('ws1', 'c1', {
      decision: 'APPROVED',
      reviewerId: 'u9',
      socialCampaignId: 'camp-chosen',
    });

    // The PLAN goes with it, because the pre-flight asks one question of it:
    // is the quote the reviewer is approving the one this campaign would
    // actually charge.
    expect(promotion.requireCampaign).toHaveBeenCalledWith('ws1', 'camp-chosen', {
      plan: expect.objectContaining({ shots: expect.any(Array) }),
    });
    expect(promotion.promote).toHaveBeenCalledWith('ws1', 'c1', { socialCampaignId: 'camp-chosen' });
  });

  it('does not promote a concept whose verdict lost the race', async () => {
    // count 0 means somebody else decided it first. Promoting anyway would buy
    // clips for a concept THIS call did not approve.
    const { svc, prisma, promotion } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue({ ...decided, socialCampaignId: 'camp-1' });
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.review('ws1', 'c1', { decision: 'APPROVED', reviewerId: 'u9' })).rejects.toThrow(
      /already/i,
    );
    expect(promotion.promote).not.toHaveBeenCalled();
  });

  it('refuses to re-decide a concept that was already decided, and says which way', async () => {
    // The loser of a race and a plain second click take the same path: the
    // conditional write matched nothing, so the row is re-read to say WHY.
    const { svc, prisma } = deps();
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 0 });
    prisma.contentConcept.findFirst.mockResolvedValue({ id: 'c1', workspaceId: 'ws1', status: 'APPROVED' });
    await expect(
      svc.review('ws1', 'c1', { decision: 'DISCARDED', reviewerId: 'u9' }),
    ).rejects.toThrow(/already approved/i);
  });

  it('does not report a vanished concept as "already decided"', async () => {
    // count 0 has two causes. Reading the row back is what tells them apart —
    // error is not emptiness applies to the two errors as well.
    const { svc, prisma } = deps();
    prisma.contentConcept.updateMany.mockResolvedValue({ count: 0 });
    prisma.contentConcept.findFirst.mockResolvedValue(null);
    await expect(svc.review('ws1', 'gone', { decision: 'APPROVED', reviewerId: 'u9' })).rejects.toThrow(
      NotFoundException,
    );
  });
});


/**
 * Defect 3, at the planner's end.
 *
 * `planShots(brief, videoModel, undefined, scenes)` — the third argument,
 * `persona`, was the literal `undefined`, and `PlanConceptsInput` had no
 * `personaId` field, so `VideoPersona.referenceImageUrls` (created, sliced to
 * nine, stored) could not reach a shot plan from anywhere in the product. The
 * machinery that keeps a face or a product IDENTICAL across shots was built and
 * disconnected.
 */
describe('ContentConceptsService.planConcepts — the persona reaches the shot plan', () => {
  it('threads the reference frames and locked seed onto EVERY shot of EVERY concept', async () => {
    const { svc, prisma } = deps();

    await plan(svc, { personaId: 'persona-1' });

    const rows = prisma.contentConcept.createMany.mock.calls[0][0].data as any[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.shotPlan.shots.length).toBeGreaterThan(0);
      for (const shot of row.shotPlan.shots) {
        expect(shot.reference).toEqual({
          images: PERSONA.referenceImageUrls,
          seed: PERSONA.lockedSeed,
        });
        // And the identity phrasing in the prompt the generator reads.
        expect(shot.prompt).toContain('consistent identity');
      }
    }
  });

  it('names the persona in the QC checklist a human reviews', async () => {
    const { svc, prisma } = deps();
    await plan(svc, { personaId: 'persona-1' });
    const rows = prisma.contentConcept.createMany.mock.calls[0][0].data as any[];
    expect(rows[0].shotPlan.qcChecklist[0]).toMatch(/Deniz.*identity consistent/);
  });

  it('plans with NO persona exactly as before when none is named', async () => {
    const { svc, prisma } = deps();
    await plan(svc);
    const rows = prisma.contentConcept.createMany.mock.calls[0][0].data as any[];
    expect(rows[0].shotPlan.shots.every((sh: any) => sh.reference === undefined)).toBe(true);
    expect(prisma.videoPersona.findFirst).not.toHaveBeenCalled();
  });

  it('scopes the persona read by workspace — a persona id is not authority', async () => {
    const { svc, prisma } = deps();
    await plan(svc, { personaId: 'persona-1' });
    expect(prisma.videoPersona.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws1' }) }),
    );
  });

  it('refuses an unknown persona BEFORE reserving credits or calling the model', async () => {
    const { svc, credits, complete } = deps({ personaRow: null });
    await expect(plan(svc, { personaId: 'nope' })).rejects.toThrow(NotFoundException);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a persona with NO reference images, by name, before any spend', async () => {
    // An identity lock with nothing to lock onto plans exactly like no persona
    // at all — `planShots` writes no `reference` — and the difference would only
    // surface weeks later as clips that do not look like each other.
    const { svc, credits, complete } = deps({
      personaRow: { ...PERSONA, referenceImageUrls: [] },
    });
    await expect(plan(svc, { personaId: 'persona-1' })).rejects.toThrow(/no reference images/i);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a retired persona rather than quietly planning without it', async () => {
    const { svc, credits } = deps({ personaRow: { ...PERSONA, status: 'ARCHIVED' } });
    await expect(plan(svc, { personaId: 'persona-1' })).rejects.toThrow(/ARCHIVED/);
    expect(credits.reserve).not.toHaveBeenCalled();
  });
});

describe('ContentConceptsService.planConcepts — every plan carries its frame', () => {
  it('records the aspect ratio on the stored plan, not only in the prompt prose', async () => {
    const { svc, prisma } = deps();
    await plan(svc);
    const rows = prisma.contentConcept.createMany.mock.calls[0][0].data as any[];
    expect(rows.every((r) => r.shotPlan.aspectRatio === DEFAULT_SHOT_ASPECT)).toBe(true);
  });
});

/**
 * THE COST IS SHOWN BEFORE THE COMMITMENT.
 *
 * A plan carrying persona reference frames can only run on the one contract
 * that takes an array of them — `bytedance/seedance-2.5/reference-to-video`, at
 * 48 credits per second against the platform default's 3, with a 4-second floor
 * under beats a reviewer approved at 2 and 3. That substitution was made inside
 * the producer, AFTER approval, as a log line: the concept a human approved said
 * 'seedance' and 27 credits, and the file that arrived was bought elsewhere for
 * 576 — real cash on the engine path. Nothing the payer could read said so.
 *
 * So the model, the seconds and the price are resolved where the plan is MADE
 * and written onto the plan itself.
 */
describe('ContentConceptsService.planConcepts — the plan is quoted before it is approved', () => {
  const firstPlan = (prisma: any) => prisma.contentConcept.createMany.mock.calls[0][0].data[0].shotPlan;

  it('quotes the platform default when nothing else is chosen', async () => {
    const { svc, prisma } = deps();
    await plan(svc);

    const p = firstPlan(prisma);
    expect(p.production.model).toBe(DEFAULT_VIDEO_MODEL);
    expect(p.production.modelSource).toBe('platform');
    // Seedance v1 lite: 3 credits/s, 1-10s, so the beats are untouched and the
    // quote is 3x(2+3+4).
    expect(p.production.billedSecPerBeat).toEqual([2, 3, 4]);
    expect(p.production.credits).toBe(27);
    expect(p.production.aspectRatio).toBe(DEFAULT_SHOT_ASPECT);
  });

  it('a persona plan is quoted on the model the persona FORCES, at its rate and its floor', async () => {
    const { svc, prisma } = deps();
    await plan(svc, { personaId: 'persona-1' });

    const p = firstPlan(prisma);
    // The substitution is a FACT ON THE PLAN, naming what it replaced — not a
    // logger.log written after the human decided.
    expect(p.production.model).toBe(DEFAULT_VIDEO_REFERENCE_MODEL);
    expect(p.production.modelSource).toBe('persona');
    expect(p.production.replacedModel).toBe(DEFAULT_VIDEO_MODEL);
    // Its contract floor is 4 seconds, so beats approved at 2 and 3 render — and
    // bill — 4. The plan says 4, because that is what will be bought.
    expect(p.production.billedSecPerBeat).toEqual([4, 4, 4]);
    expect(p.shots.map((sh: any) => sh.durationSec)).toEqual([4, 4, 4]);
    expect(p.durationSec).toBe(12);
    // 48 credits/s x 4s x 3 beats. Twenty-one times the platform default's 27.
    expect(p.production.credits).toBe(576);
    expect(p.production.usd).toBeCloseTo(5.676, 3);
  });

  it('a campaign that chose its own model is quoted on THAT model', async () => {
    const { svc, prisma } = deps({
      campaignRow: { id: 'camp-1', workspaceId: 'ws1', defaultVideoModel: 'fal-ai/veo3.1/fast' },
    });
    await plan(svc, { socialCampaignId: 'camp-1' });

    const p = firstPlan(prisma);
    expect(p.production.model).toBe('fal-ai/veo3.1/fast');
    expect(p.production.modelSource).toBe('campaign');
    // Veo 3.1 takes 4, 6 or 8 seconds only, so 2 and 3 second beats are bought
    // as 4-second ones at 15 credits/s.
    expect(p.production.billedSecPerBeat).toEqual([4, 4, 4]);
    expect(p.production.credits).toBe(180);
  });

  it('quotes the WORKSPACE default when that is what will run', async () => {
    const { svc, prisma } = deps({ workspaceVideoModel: 'bytedance/seedance-2.5/text-to-video' });
    await plan(svc);

    const p = firstPlan(prisma);
    expect(p.production.model).toBe('bytedance/seedance-2.5/text-to-video');
    expect(p.production.modelSource).toBe('workspace');
  });
});
