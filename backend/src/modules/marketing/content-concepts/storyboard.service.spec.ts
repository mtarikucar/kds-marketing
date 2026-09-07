import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { StoryboardService } from './storyboard.service';
import { CONCEPT_STORYBOARD_KIND, MAX_FRAME_ATTEMPTS, MAX_SHOT_TEXT, STORYBOARD_MAX_WAITS, STORYBOARD_WAIT_MS } from './storyboard-frames';
import { DEFAULT_KEYFRAME_MODEL } from '../ai/media/media-models.config';
import type { Keyframe } from '../video/video-pipeline.service';

const WS = 'ws-1';
const CONCEPT_ID = 'concept-1';
const BORN = new Date('2026-09-01T00:00:00Z');

const PLAN = {
  model: 'seedance', aspectRatio: '9:16', durationSec: 5, captionSuggestion: 'x', qcChecklist: [],
  storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 100 },
  shots: [
    { ord: 0, scene: '0-2s', voiceover: '', prompt: 'clip a', keyframePrompt: 'still a', durationSec: 2, cameraNote: 'w' },
    { ord: 1, scene: '2-5s', voiceover: '', prompt: 'clip b', keyframePrompt: 'still b', durationSec: 3, cameraNote: 'm' },
  ],
};
const LEGACY = { ...PLAN, storyboard: undefined, shots: PLAN.shots.map(({ keyframePrompt: _k, ...sh }) => sh) };
const withKeyframes = (kfs: Array<Keyframe | undefined>) => ({
  ...PLAN,
  shots: PLAN.shots.map((sh, i) => (kfs[i] ? { ...sh, keyframe: kfs[i] } : sh)),
});

/** What `request()` leaves behind: every beat stamped REQUESTED. */
const MARK = (): Keyframe => ({ assetId: '', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 0 });
const REQUESTED_PLAN = withKeyframes([MARK(), MARK()]);

function concept(over: Record<string, unknown> = {}) {
  return {
    id: CONCEPT_ID, workspaceId: WS, status: 'PROPOSED', promotedItemId: null, socialCampaignId: 'camp-1',
    createdById: 'u-owner', createdAt: BORN, shotPlan: PLAN, ...over,
  };
}

function harness(over: { concept?: unknown; assetRows?: unknown[] } = {}) {
  const prisma: any = {
    contentConcept: { findFirst: jest.fn().mockResolvedValue(over.concept === undefined ? concept() : over.concept) },
    generatedAsset: { findMany: jest.fn().mockResolvedValue(over.assetRows ?? []) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  let n = 0;
  const mediaGen = { requestGeneration: jest.fn().mockImplementation(async () => ({ assetId: `f-${++n}` })) };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const svc = new StoryboardService(prisma, mediaGen as any, scheduledJobs as any, runner as any);
  return { svc, prisma, mediaGen, scheduledJobs, runner };
}
/** Keyframe writes decoded off the tagged template (see storyboard-frames.spec). */
const kfWrites = (prisma: { $executeRaw: jest.Mock }) =>
  prisma.$executeRaw.mock.calls
    .filter((c: unknown[]) => /^\d+$/.test(String(c[1])) && (c[0] as string[]).join('?').includes("'keyframe'"))
    .map((c: unknown[]) => ({ idx: Number(c[1]), keyframe: JSON.parse(String(c[2])) as Keyframe }));
/** Shot-text merges (writeShotText), decoded the same way: the beat and the patch. */
const textWrites = (prisma: { $executeRaw: jest.Mock }) =>
  prisma.$executeRaw.mock.calls
    .filter((c: unknown[]) => (c[0] as string[]).join('?').includes('|| ?::jsonb'))
    .map((c: unknown[]) => ({ idx: Number(c[1]), patch: JSON.parse(String(c[3])) as Record<string, string> }));
const stamps = (prisma: { $executeRaw: jest.Mock }) =>
  prisma.$executeRaw.mock.calls
    .filter((c: unknown[]) => String(c[0]).includes("'{storyboard}'"))
    .map((c: unknown[]) => JSON.parse(String(c[1])));

describe('StoryboardService.request', () => {
  it('stamps who asked, marks every wanted beat REQUESTED so the hub sees it coming, and enqueues the frame job once', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    const res = await svc.request(WS, CONCEPT_ID, 'u-reviewer');
    expect(res).toEqual({ conceptId: CONCEPT_ID, shots: 2, requested: 2, storyboard: expect.objectContaining({ requestedById: 'u-reviewer', requestedAt: expect.any(String) }) });
    expect(stamps(prisma)).toEqual([expect.objectContaining({ imageModel: DEFAULT_KEYFRAME_MODEL, seed: 100, requestedById: 'u-reviewer' })]);
    expect(kfWrites(prisma).map((w) => [w.idx, w.keyframe.status, w.keyframe.assetId])).toEqual([[0, 'QUEUED', ''], [1, 'QUEUED', '']]);
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: CONCEPT_STORYBOARD_KIND, dedupKey: `content-concept-storyboard-${CONCEPT_ID}`, payload: { conceptId: CONCEPT_ID, workspaceId: WS, waits: 0 },
    }));
  });

  it('refuses a legacy plan, a discarded concept, one already in production, and one that is not ours', async () => {
    await expect(harness({ concept: concept({ shotPlan: LEGACY }) }).svc.request(WS, CONCEPT_ID, 'u')).rejects.toThrow(/planned before storyboards/);
    await expect(harness({ concept: concept({ status: 'DISCARDED' }) }).svc.request(WS, CONCEPT_ID, 'u')).rejects.toThrow(/discarded/);
    await expect(harness({ concept: concept({ status: 'APPROVED', promotedItemId: 'item-1' }) }).svc.request(WS, CONCEPT_ID, 'u')).rejects.toThrow(/already in production/);
    await expect(harness({ concept: null }).svc.request(WS, CONCEPT_ID, 'u')).rejects.toBeInstanceOf(NotFoundException);
    // Approved but never promoted is still ours to storyboard.
    await expect(harness({ concept: concept({ status: 'APPROVED' }) }).svc.request(WS, CONCEPT_ID, 'u')).resolves.toBeDefined();
  });
});

describe('StoryboardService.regenerateFrame', () => {
  const READY = (id: string): Keyframe => ({ assetId: id, status: 'READY', url: 'u', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 });

  it('drops one beat frame — that beat only, compared against what it read — gives it a fresh seed, and enqueues the job', async () => {
    const { svc, prisma, scheduledJobs } = harness({ concept: concept({ shotPlan: withKeyframes([READY('old-0'), READY('old-1')]) }) });
    const res = await svc.regenerateFrame(WS, CONCEPT_ID, 1, 'u-reviewer');
    const writes = kfWrites(prisma);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ idx: 1, keyframe: { assetId: '', status: 'QUEUED', attempts: 0, seed: res.seed } });
    expect(prisma.$executeRaw.mock.calls[0][8]).toBe('old-1');
    expect(res.seed).not.toBe(100);
    expect(stamps(prisma)[0].requestedById).toBe('u-reviewer');
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(1);
  });

  it('refuses a frame still rendering (a second request would buy it twice) and one already requested', async () => {
    const inFlight = harness({ concept: concept({ shotPlan: withKeyframes([{ assetId: 'f', status: 'GENERATING', model: 'm', attempts: 1 }, undefined]) }) });
    await expect(inFlight.svc.regenerateFrame(WS, CONCEPT_ID, 0, 'u')).rejects.toThrow(/still rendering/);
    expect(inFlight.prisma.$executeRaw).not.toHaveBeenCalled();
    const requested = harness({ concept: concept({ shotPlan: withKeyframes([{ assetId: '', status: 'QUEUED', model: 'm', attempts: 0 }, undefined]) }) });
    await expect(requested.svc.regenerateFrame(WS, CONCEPT_ID, 0, 'u')).rejects.toThrow(/already requested/);
  });

  it('names the beats when the ord does not exist, and refuses to overwrite a beat that changed meanwhile', async () => {
    await expect(harness().svc.regenerateFrame(WS, CONCEPT_ID, 7, 'u')).rejects.toThrow(/no beat 7; its beats are 0, 1/);
    const raced = harness({ concept: concept({ shotPlan: withKeyframes([READY('a'), undefined]) }) });
    raced.prisma.$executeRaw.mockResolvedValueOnce(0);
    await expect(raced.svc.regenerateFrame(WS, CONCEPT_ID, 0, 'u')).rejects.toThrow(/changed while you were looking/);
    expect(raced.scheduledJobs.schedule).not.toHaveBeenCalled();
  });
});

describe('StoryboardService.run — the frame job', () => {
  it('requests the missing frames on the concept (no item), records each, and comes back while they render', async () => {
    const { svc, prisma, mediaGen } = harness({ concept: concept({ shotPlan: REQUESTED_PLAN }), assetRows: [{ id: 'f-1', status: 'QUEUED', url: null, error: null }, { id: 'f-2', status: 'QUEUED', url: null, error: null }] });
    const res = await svc.run(CONCEPT_ID, WS, 0);
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(2);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).toMatchObject({ type: 'IMAGE', socialCampaignId: 'camp-1', createdById: 'u-owner' });
    expect(mediaGen.requestGeneration.mock.calls[0][1]).not.toHaveProperty('campaignItemId');
    expect(kfWrites(prisma).map((w) => w.keyframe.assetId)).toEqual(['f-1', 'f-2']);
    expect(res).toEqual({ reschedule: { runAt: expect.any(Date), payload: { conceptId: CONCEPT_ID, workspaceId: WS, waits: 1 } } });
    const runAt = (res as any).reschedule.runAt.getTime();
    expect(runAt - Date.now()).toBeGreaterThan(STORYBOARD_WAIT_MS - 5000);
  });

  it('stops once every frame is final, writing the outcomes onto the plan', async () => {
    const inFlight = concept({ shotPlan: withKeyframes(PLAN.shots.map((_s, i): Keyframe => ({ assetId: `f${i}`, status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 }))) });
    const { svc, prisma, mediaGen } = harness({ concept: inFlight, assetRows: [
      { id: 'f0', status: 'READY', url: 'https://r2/f0.png', error: null },
      { id: 'f1', status: 'READY', url: 'https://r2/f1.png', error: null },
    ] });
    const res = await svc.run(CONCEPT_ID, WS, 3);
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
    expect(kfWrites(prisma).map((w) => w.keyframe.url)).toEqual(['https://r2/f0.png', 'https://r2/f1.png']);
  });

  it('leaves a promoted concept to the producer and a legacy plan alone; a DISCARDED one only has its in-flight frames settled', async () => {
    for (const c of [concept({ status: 'APPROVED', promotedItemId: 'item-1' }), concept({ shotPlan: LEGACY })]) {
      const { svc, mediaGen, prisma } = harness({ concept: c });
      expect(await svc.run(CONCEPT_ID, WS, 0)).toBeUndefined();
      expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    }
    const discarded = harness({
      concept: concept({ status: 'DISCARDED', shotPlan: withKeyframes([{ assetId: 'f0', status: 'QUEUED', model: 'm', attempts: 1 }, { assetId: '', status: 'QUEUED', model: 'm', attempts: 0 }]) }),
      assetRows: [{ id: 'f0', status: 'READY', url: 'u', error: null }],
    });
    expect(await discarded.svc.run(CONCEPT_ID, WS, 0)).toBeUndefined();
    expect(discarded.mediaGen.requestGeneration).not.toHaveBeenCalled();
    // …and a beat merely requested is told it will not be drawn, so nothing
    // on a discarded concept reads as rendering forever.
    expect(kfWrites(discarded.prisma)).toEqual([
      { idx: 0, keyframe: expect.objectContaining({ status: 'READY', url: 'u' }) },
      { idx: 1, keyframe: expect.objectContaining({ assetId: '', status: 'FAILED', attempts: 0, error: expect.stringMatching(/discarded/) }) },
    ]);
  });

  it('draws ONLY the beats a human asked for — a beat nobody requested is left for the producer, so a single-beat redraw buys one frame', async () => {
    const { svc, mediaGen } = harness({ concept: concept({ shotPlan: withKeyframes([undefined, MARK()]) }), assetRows: [{ id: 'f-1', status: 'QUEUED', url: null, error: null }] });
    await svc.run(CONCEPT_ID, WS, 0);
    expect(mediaGen.requestGeneration.mock.calls.map((c) => c[1].prompt)).toEqual(['still b']);
  });

  it('registers itself as the handler for the storyboard job kind', () => {
    const { svc, runner } = harness();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(CONCEPT_STORYBOARD_KIND, expect.any(Function));
  });

  it('a refusal at request time is not a thrown error but a FAILED attempt with the reason', async () => {
    const { svc, prisma, mediaGen } = harness({ concept: concept({ shotPlan: REQUESTED_PLAN }), assetRows: [{ id: 'f-2', status: 'QUEUED', url: null, error: null }] });
    mediaGen.requestGeneration.mockRejectedValueOnce(new BadRequestException('does not support aspect ratio 9:16')).mockResolvedValueOnce({ assetId: 'f-2' });
    await svc.run(CONCEPT_ID, WS, 0);
    const writes = kfWrites(prisma);
    expect(writes[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 1, error: expect.stringMatching(/aspect ratio/) });
    expect(writes[1].keyframe.status).toBe('QUEUED');
  });

  it('the weather (an outage) ends the job without a reschedule and without spending an attempt', async () => {
    const { svc, prisma, mediaGen } = harness({ concept: concept({ shotPlan: REQUESTED_PLAN }) });
    mediaGen.requestGeneration.mockRejectedValueOnce(new ServiceUnavailableException('Media generation is not configured'));
    const res = await svc.run(CONCEPT_ID, WS, 0);
    expect(res).toBeUndefined();
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
    expect(kfWrites(prisma)[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 0, error: 'Media generation is not configured' });
  });

  it('a full queue is waited out — and at the bound the beats never requested are told why, while frames rendering are left to the media poll', async () => {
    const { svc, mediaGen } = harness({ concept: concept({ shotPlan: REQUESTED_PLAN }) });
    mediaGen.requestGeneration.mockRejectedValueOnce(new BadRequestException({ code: 'MEDIA_GEN_TOO_MANY', message: 'full' }));
    const res = await svc.run(CONCEPT_ID, WS, 4);
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { conceptId: CONCEPT_ID, workspaceId: WS, waits: 5 } }) });

    const atBound = harness({
      concept: concept({ shotPlan: withKeyframes([{ assetId: '', status: 'QUEUED', model: 'm', attempts: 0 }, { assetId: 'live', status: 'GENERATING', model: 'm', attempts: 1 }]) }),
      assetRows: [{ id: 'live', status: 'GENERATING', url: null, error: null }],
    });
    atBound.mediaGen.requestGeneration.mockRejectedValueOnce(new BadRequestException({ code: 'MEDIA_GEN_TOO_MANY', message: 'full' }));
    const end = await atBound.svc.run(CONCEPT_ID, WS, STORYBOARD_MAX_WAITS);
    expect(end).toBeUndefined();
    const writes = kfWrites(atBound.prisma);
    expect(writes).toEqual([{ idx: 0, keyframe: expect.objectContaining({ assetId: '', status: 'FAILED', attempts: 0, error: expect.stringMatching(/queue stayed full/) }) }]);
  });

  it('an exhausted frame is left for a human — never re-requested by the job', async () => {
    const dead: Keyframe = { assetId: 'z', status: 'BLOCKED', model: 'm', attempts: MAX_FRAME_ATTEMPTS, error: 'policy' };
    const { svc, mediaGen } = harness({ concept: concept({ shotPlan: withKeyframes([dead, { assetId: 'ok', status: 'READY', url: 'u', model: 'm', attempts: 1 }]) }), assetRows: [{ id: 'ok', status: 'READY', url: 'u', error: null }] });
    expect(await svc.run(CONCEPT_ID, WS, 0)).toBeUndefined();
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
  });
});

describe('StoryboardService.editShot — Runway-style direction: this frame shows X, then Y happens', () => {
  const READY = (id: string): Keyframe => ({ assetId: id, status: 'READY', url: 'u', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 });

  it('saves the MOTION text alone: one merge on that beat, no keyframe touched, nothing bought, no job', async () => {
    const { svc, prisma, scheduledJobs } = harness({ concept: concept({ shotPlan: withKeyframes([READY('a'), READY('b')]) }) });
    const res = await svc.editShot(WS, CONCEPT_ID, 1, { prompt: '  the bicycle rolls forward slowly  ' }, 'u-reviewer');
    expect(res).toEqual({ conceptId: CONCEPT_ID, ord: 1, changed: ['prompt'], redraw: false });
    expect(textWrites(prisma)).toEqual([{ idx: 1, patch: { prompt: 'the bicycle rolls forward slowly' } }]);
    expect(kfWrites(prisma)).toEqual([]);
    expect(stamps(prisma)).toEqual([]);
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('a FRAME text change merges the words, drops the old frame for a requested one with a fresh seed (CAS on what it read), stamps who asked, and enqueues the job', async () => {
    const { svc, prisma, scheduledJobs } = harness({ concept: concept({ shotPlan: withKeyframes([READY('old-0'), READY('old-1')]) }) });
    const res = await svc.editShot(WS, CONCEPT_ID, 1, { keyframePrompt: 'a red bicycle on a white wall', description: 'red bicycle' }, 'u-reviewer');
    expect(res).toEqual({ conceptId: CONCEPT_ID, ord: 1, changed: ['keyframePrompt', 'description'], redraw: true, seed: expect.any(Number) });
    expect(res.seed).not.toBe(100);
    expect(textWrites(prisma)).toEqual([{ idx: 1, patch: { keyframePrompt: 'a red bicycle on a white wall', description: 'red bicycle' } }]);
    const writes = kfWrites(prisma);
    expect(writes).toEqual([{ idx: 1, keyframe: { assetId: '', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, seed: res.seed, attempts: 0 } }]);
    // The text landed before the frame was dropped, and the drop compared against the READY frame it read.
    const order = prisma.$executeRaw.mock.calls.map((c: unknown[]) => (c[0] as string[]).join('?'));
    expect(order.findIndex((t: string) => t.includes('|| ?::jsonb'))).toBeLessThan(order.findIndex((t: string) => t.includes("'keyframe'")));
    const kfCall = prisma.$executeRaw.mock.calls.find((c: unknown[]) => (c[0] as string[]).join('?').includes("'keyframe'"))!;
    expect([kfCall[8], kfCall[10]]).toEqual(['old-1', 'READY']);
    expect(stamps(prisma)).toEqual([expect.objectContaining({ imageModel: DEFAULT_KEYFRAME_MODEL, seed: 100, requestedById: 'u-reviewer', requestedAt: expect.any(String) })]);
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(1);
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({ kind: CONCEPT_STORYBOARD_KIND, dedupKey: `content-concept-storyboard-${CONCEPT_ID}` }));
  });

  it('a beat with no frame yet, or one merely requested, takes new frame words too — the job has not drawn it and will use them', async () => {
    const bare = harness();
    const res = await bare.svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: 'new words' }, 'u');
    expect(res.redraw).toBe(true);
    expect(bare.prisma.$executeRaw.mock.calls.find((c: unknown[]) => (c[0] as string[]).join('?').includes("'keyframe'"))![8]).toBe('');
    const requested = harness({ concept: concept({ shotPlan: withKeyframes([{ assetId: '', status: 'QUEUED', model: 'm', attempts: 0 }, undefined]) }) });
    await expect(requested.svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: 'new words' }, 'u')).resolves.toMatchObject({ redraw: true });
  });

  it('an unchanged MOTION text is not a change and writes nothing; unchanged FRAME words still ask for the frame — sending them is the request', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    const res = await svc.editShot(WS, CONCEPT_ID, 0, { prompt: ' clip a ' }, 'u');
    expect(res).toEqual({ conceptId: CONCEPT_ID, ord: 0, changed: [], redraw: false });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    // The same frame words again: no text write, but the frame IS redrawn —
    // this is how "your words are saved, ask again" is honoured.
    const again = harness({ concept: concept({ shotPlan: withKeyframes([READY('a'), undefined]) }) });
    const r2 = await again.svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: ' still a ', prompt: 'clip a' }, 'u');
    expect(r2).toEqual({ conceptId: CONCEPT_ID, ord: 0, changed: [], redraw: true, seed: expect.any(Number) });
    expect(textWrites(again.prisma)).toEqual([]);
    expect(kfWrites(again.prisma)).toEqual([{ idx: 0, keyframe: expect.objectContaining({ assetId: '', status: 'QUEUED', attempts: 0 }) }]);
    expect(again.scheduledJobs.schedule).toHaveBeenCalledTimes(1);
    // Mixed: only the field that differs is written; the frame words, given, redraw.
    const mixed = harness();
    const r3 = await mixed.svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: 'still a', prompt: 'clip a, faster' }, 'u');
    expect(r3).toMatchObject({ conceptId: CONCEPT_ID, ord: 0, changed: ['prompt'], redraw: true });
    expect(textWrites(mixed.prisma)).toEqual([{ idx: 0, patch: { prompt: 'clip a, faster' } }]);
  });

  it('refuses an empty text, one over the ceiling, a patch that names no field, an unknown beat, and a legacy plan — without writing', async () => {
    const { svc, prisma } = harness();
    await expect(svc.editShot(WS, CONCEPT_ID, 0, { prompt: '   ' }, 'u')).rejects.toThrow(/prompt.*empty|empty.*prompt/i);
    await expect(svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: 'x'.repeat(MAX_SHOT_TEXT + 1) }, 'u')).rejects.toThrow(new RegExp(`keyframePrompt.*${MAX_SHOT_TEXT}`));
    await expect(svc.editShot(WS, CONCEPT_ID, 0, { prompt: 42 as never }, 'u')).rejects.toThrow(/prompt/);
    await expect(svc.editShot(WS, CONCEPT_ID, 0, {}, 'u')).rejects.toThrow(/keyframePrompt|nothing to edit/i);
    await expect(svc.editShot(WS, CONCEPT_ID, 7, { prompt: 'x' }, 'u')).rejects.toThrow(/no beat 7; its beats are 0, 1/);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    await expect(harness({ concept: concept({ shotPlan: LEGACY }) }).svc.editShot(WS, CONCEPT_ID, 0, { prompt: 'x' }, 'u')).rejects.toThrow(/planned before storyboards/);
    await expect(harness({ concept: concept({ status: 'APPROVED', promotedItemId: 'item-1' }) }).svc.editShot(WS, CONCEPT_ID, 0, { prompt: 'x' }, 'u')).rejects.toThrow(/already in production/);
  });

  it('refuses new FRAME words while the frame is still rendering — the motion can still be edited meanwhile', async () => {
    const inFlight = () => harness({ concept: concept({ shotPlan: withKeyframes([{ assetId: 'f', status: 'GENERATING', model: 'm', attempts: 1 }, undefined]) }) });
    const a = inFlight();
    await expect(a.svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: 'new words' }, 'u')).rejects.toThrow(/still rendering.*twice/);
    expect(a.prisma.$executeRaw).not.toHaveBeenCalled();
    const b = inFlight();
    await expect(b.svc.editShot(WS, CONCEPT_ID, 0, { prompt: 'new motion' }, 'u')).resolves.toMatchObject({ changed: ['prompt'], redraw: false });
  });

  it('a lost compare-and-set — on the text or on the frame — is a BadRequest that buys nothing', async () => {
    const text = harness();
    text.prisma.$executeRaw.mockResolvedValueOnce(0);
    await expect(text.svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: 'x' }, 'u')).rejects.toThrow(/changed while you were looking/);
    expect(text.scheduledJobs.schedule).not.toHaveBeenCalled();
    const frame = harness({ concept: concept({ shotPlan: withKeyframes([READY('a'), undefined]) }) });
    frame.prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(frame.svc.editShot(WS, CONCEPT_ID, 0, { keyframePrompt: 'x' }, 'u')).rejects.toThrow(/changed while you were looking/);
    expect(frame.scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(stamps(frame.prisma)).toEqual([]);
  });
});
