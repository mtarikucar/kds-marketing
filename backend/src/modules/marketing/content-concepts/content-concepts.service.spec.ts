import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ContentConceptsService, MAX_CONCEPT_COUNT } from './content-concepts.service';
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
    },
  };
  const svc = new ContentConceptsService(
    prisma as any,
    anthropic as any,
    credits as any,
    new VideoPipelineService(),
  );
  return { svc, prisma, credits, complete, anthropic };
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
  it('records WHO decided and when, not just the new status', async () => {
    const { svc, prisma } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue({ id: 'c1', workspaceId: 'ws1', status: 'PROPOSED' });
    prisma.contentConcept.update.mockResolvedValue({ id: 'c1', status: 'APPROVED' });

    await svc.review('ws1', 'c1', { decision: 'APPROVED', reviewerId: 'u9', note: 'bu güzelmiş' });

    expect(prisma.contentConcept.findFirst.mock.calls[0][0].where).toEqual({ id: 'c1', workspaceId: 'ws1' });
    const data = prisma.contentConcept.update.mock.calls[0][0].data;
    expect(data.status).toBe('APPROVED');
    expect(data.reviewedById).toBe('u9');
    expect(data.reviewNote).toBe('bu güzelmiş');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it('refuses a concept that belongs to another workspace', async () => {
    const { svc, prisma } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue(null);
    await expect(
      svc.review('ws1', 'c-next-door', { decision: 'APPROVED', reviewerId: 'u9' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.contentConcept.update).not.toHaveBeenCalled();
  });

  it('refuses to re-decide a concept that was already decided', async () => {
    const { svc, prisma } = deps();
    prisma.contentConcept.findFirst.mockResolvedValue({ id: 'c1', workspaceId: 'ws1', status: 'APPROVED' });
    await expect(
      svc.review('ws1', 'c1', { decision: 'DISCARDED', reviewerId: 'u9' }),
    ).rejects.toThrow(/already/i);
    expect(prisma.contentConcept.update).not.toHaveBeenCalled();
  });
});
