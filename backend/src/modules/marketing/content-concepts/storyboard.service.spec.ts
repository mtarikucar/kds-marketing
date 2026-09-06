import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { StoryboardService } from './storyboard.service';
import { CONCEPT_STORYBOARD_KIND, MAX_FRAME_ATTEMPTS, STORYBOARD_MAX_WAITS, STORYBOARD_WAIT_MS } from './storyboard-frames';
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
    .filter((c: unknown[]) => /^\d+$/.test(String(c[1])))
    .map((c: unknown[]) => ({ idx: Number(c[1]), keyframe: JSON.parse(String(c[2])) as Keyframe }));
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
    const { svc, prisma, mediaGen } = harness({ assetRows: [{ id: 'f-1', status: 'QUEUED', url: null, error: null }, { id: 'f-2', status: 'QUEUED', url: null, error: null }] });
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

  it('registers itself as the handler for the storyboard job kind', () => {
    const { svc, runner } = harness();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(CONCEPT_STORYBOARD_KIND, expect.any(Function));
  });

  it('a refusal at request time is not a thrown error but a FAILED attempt with the reason', async () => {
    const { svc, prisma, mediaGen } = harness({ assetRows: [{ id: 'f-2', status: 'QUEUED', url: null, error: null }] });
    mediaGen.requestGeneration.mockRejectedValueOnce(new BadRequestException('does not support aspect ratio 9:16')).mockResolvedValueOnce({ assetId: 'f-2' });
    await svc.run(CONCEPT_ID, WS, 0);
    const writes = kfWrites(prisma);
    expect(writes[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 1, error: expect.stringMatching(/aspect ratio/) });
    expect(writes[1].keyframe.status).toBe('QUEUED');
  });

  it('the weather (an outage) ends the job without a reschedule and without spending an attempt', async () => {
    const { svc, prisma, mediaGen } = harness();
    mediaGen.requestGeneration.mockRejectedValueOnce(new ServiceUnavailableException('Media generation is not configured'));
    const res = await svc.run(CONCEPT_ID, WS, 0);
    expect(res).toBeUndefined();
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
    expect(kfWrites(prisma)[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 0, error: 'Media generation is not configured' });
  });

  it('a full queue is waited out — and at the bound the beats never requested are told why, while frames rendering are left to the media poll', async () => {
    const { svc, mediaGen } = harness();
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
