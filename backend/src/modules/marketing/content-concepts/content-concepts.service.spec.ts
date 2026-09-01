import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  ContentConceptsService,
  CONCEPT_LIST_LIMIT,
  MAX_CONCEPT_COUNT,
  MAX_SHOT_SEC,
  MIN_SHOT_SEC,
} from './content-concepts.service';
import { VideoPipelineService } from '../video/video-pipeline.service';

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

function deps(over: { aiEnabled?: boolean; completion?: unknown; completeImpl?: jest.Mock } = {}) {
  const complete = over.completeImpl ?? jest.fn().mockResolvedValue(over.completion ?? submit(GOOD));
  const anthropic = { isEnabled: () => over.aiEnabled ?? true, complete };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    workspace: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ productName: 'Figurunica', productDescription: '3D baskı figür', defaultLanguage: 'tr' }),
    },
    contentConcept: {
      createMany: jest.fn().mockResolvedValue({ count: 3 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const promotion = {
    requireCampaign: jest.fn().mockResolvedValue({ id: 'camp-1', workspaceId: 'ws1' }),
    promote: jest.fn().mockResolvedValue({ item: { id: 'item-1', status: 'GENERATING' }, created: true }),
  };
  const svc = new ContentConceptsService(
    prisma as any,
    anthropic as any,
    credits as any,
    new VideoPipelineService(),
    promotion as any,
  );
  return { svc, prisma, credits, complete, anthropic, promotion };
}

const plan = (svc: ContentConceptsService, over: Record<string, unknown> = {}) =>
  svc.planConcepts('ws1', { idea: IDEA, count: 3, createdById: 'u1', ...over });

describe('ContentConceptsService.planConcepts', () => {
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

  it('refuses a status it does not recognise instead of handing it to Prisma', () => {
    // Safe from MCP (`z.enum`), unsafe from anywhere else: the value used to be
    // cast `as never` straight into a Prisma enum, where an unknown string is a
    // runtime error from the driver rather than a stated refusal.
    const { svc, prisma } = deps();
    expect(() => svc.list('ws1', { status: 'ARCHIVED' })).toThrow(BadRequestException);
    // Case matters — the column holds the enum's own spelling.
    expect(() => svc.list('ws1', { status: 'proposed' })).toThrow(/PROPOSED/);
    expect(prisma.contentConcept.findMany).not.toHaveBeenCalled();
    // Anchored on the positive: the recognised value still reaches Prisma.
    svc.list('ws1', { status: 'DISCARDED' });
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
  const decided = { id: 'c1', workspaceId: 'ws1', status: 'APPROVED', reviewedById: 'u9' };

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

    expect(promotion.requireCampaign).toHaveBeenCalledWith('ws1', 'camp-chosen');
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
