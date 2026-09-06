import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StoryboardService } from './storyboard.service';
import { CONCEPT_STORYBOARD_KIND, STORYBOARD_WAIT_MS } from './storyboard-frames';
import { DEFAULT_KEYFRAME_MODEL } from '../ai/media/media-models.config';

const WS = 'ws-1';
const CONCEPT_ID = 'concept-1';

const PLAN = {
  model: 'seedance', aspectRatio: '9:16', durationSec: 5, captionSuggestion: 'x', qcChecklist: [],
  storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 100 },
  shots: [
    { ord: 0, scene: '0-2s', voiceover: '', prompt: 'clip a', keyframePrompt: 'still a', durationSec: 2, cameraNote: 'w' },
    { ord: 1, scene: '2-5s', voiceover: '', prompt: 'clip b', keyframePrompt: 'still b', durationSec: 3, cameraNote: 'm' },
  ],
};
const LEGACY = { ...PLAN, storyboard: undefined, shots: PLAN.shots.map(({ keyframePrompt: _k, ...sh }) => sh) };

function concept(over: Record<string, unknown> = {}) {
  return {
    id: CONCEPT_ID, workspaceId: WS, status: 'PROPOSED', promotedItemId: null, socialCampaignId: 'camp-1',
    createdById: 'u-owner', shotPlan: PLAN, ...over,
  };
}

function harness(over: { concept?: unknown; assetRows?: unknown[] } = {}) {
  const prisma: any = {
    contentConcept: {
      findFirst: jest.fn().mockResolvedValue(over.concept === undefined ? concept() : over.concept),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    generatedAsset: { findMany: jest.fn().mockResolvedValue(over.assetRows ?? []) },
  };
  let n = 0;
  const mediaGen = { requestGeneration: jest.fn().mockImplementation(async () => ({ assetId: `f-${++n}` })) };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const svc = new StoryboardService(prisma, mediaGen as any, scheduledJobs as any, runner as any);
  return { svc, prisma, mediaGen, scheduledJobs, runner };
}

describe('StoryboardService.request', () => {
  it('stamps who asked and enqueues the frame job, once per concept', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    const res = await svc.request(WS, CONCEPT_ID, 'u-reviewer');
    expect(res).toEqual({ conceptId: CONCEPT_ID, shots: 2, storyboard: expect.objectContaining({ requestedById: 'u-reviewer', requestedAt: expect.any(String) }) });
    const written = prisma.contentConcept.updateMany.mock.calls[0][0];
    expect(written.where).toEqual({ id: CONCEPT_ID, workspaceId: WS });
    expect(written.data.shotPlan.storyboard.requestedById).toBe('u-reviewer');
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
  it('drops one beat frame, gives it a fresh seed, and enqueues the job', async () => {
    const withFrame = concept({ shotPlan: { ...PLAN, shots: PLAN.shots.map((sh) => ({ ...sh, keyframe: { assetId: 'old', status: 'READY', url: 'u', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 } })) } });
    const { svc, prisma, scheduledJobs } = harness({ concept: withFrame });
    const res = await svc.regenerateFrame(WS, CONCEPT_ID, 1, 'u-reviewer');
    const plan = prisma.contentConcept.updateMany.mock.calls[0][0].data.shotPlan;
    expect(plan.shots[0].keyframe.status).toBe('READY'); // untouched
    expect(plan.shots[1].keyframe).toMatchObject({ assetId: '', status: 'FAILED', attempts: 0, seed: res.seed });
    expect(res.seed).not.toBe(100);
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(1);
  });

  it('names the beats when the ord does not exist', async () => {
    await expect(harness().svc.regenerateFrame(WS, CONCEPT_ID, 7, 'u')).rejects.toThrow(/no beat 7; its beats are 0, 1/);
  });
});

describe('StoryboardService.run — the frame job', () => {
  it('requests the missing frames, records them, and comes back while they render', async () => {
    const { svc, prisma, mediaGen } = harness({ assetRows: [{ id: 'f-1', status: 'QUEUED', url: null, error: null }, { id: 'f-2', status: 'QUEUED', url: null, error: null }] });
    const res = await svc.run(CONCEPT_ID, WS, 0);
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(2);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).toMatchObject({ type: 'IMAGE', socialCampaignId: 'camp-1', createdById: 'u-owner' });
    expect(mediaGen.requestGeneration.mock.calls[0][1]).not.toHaveProperty('campaignItemId');
    expect(prisma.contentConcept.updateMany).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ reschedule: { runAt: expect.any(Date), payload: { conceptId: CONCEPT_ID, workspaceId: WS, waits: 1 } } });
    const runAt = (res as any).reschedule.runAt.getTime();
    expect(runAt - Date.now()).toBeGreaterThan(STORYBOARD_WAIT_MS - 5000);
  });

  it('stops once every frame is final, writing the outcomes onto the plan', async () => {
    const inFlight = concept({ shotPlan: { ...PLAN, shots: PLAN.shots.map((sh, i) => ({ ...sh, keyframe: { assetId: `f${i}`, status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 } })) } });
    const { svc, prisma, mediaGen } = harness({ concept: inFlight, assetRows: [
      { id: 'f0', status: 'READY', url: 'https://r2/f0.png', error: null },
      { id: 'f1', status: 'READY', url: 'https://r2/f1.png', error: null },
    ] });
    const res = await svc.run(CONCEPT_ID, WS, 3);
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
    const plan = prisma.contentConcept.updateMany.mock.calls[0][0].data.shotPlan;
    expect(plan.shots.map((sh: any) => sh.keyframe.url)).toEqual(['https://r2/f0.png', 'https://r2/f1.png']);
  });

  it('leaves a decided concept to its owner: discarded, or approved and promoted', async () => {
    for (const c of [concept({ status: 'DISCARDED' }), concept({ status: 'APPROVED', promotedItemId: 'item-1' })]) {
      const { svc, mediaGen, prisma } = harness({ concept: c });
      expect(await svc.run(CONCEPT_ID, WS, 0)).toBeUndefined();
      expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
      expect(prisma.contentConcept.updateMany).not.toHaveBeenCalled();
    }
  });

  it('registers itself as the handler for the storyboard job kind', () => {
    const { svc, runner } = harness();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(CONCEPT_STORYBOARD_KIND, expect.any(Function));
  });

  it('a refusal at request time is not a thrown error but a FAILED frame with the reason', async () => {
    const { svc, prisma, mediaGen } = harness({ assetRows: [{ id: 'f-2', status: 'QUEUED', url: null, error: null }] });
    mediaGen.requestGeneration.mockRejectedValueOnce(new BadRequestException('does not support aspect ratio 9:16')).mockResolvedValueOnce({ assetId: 'f-2' });
    await svc.run(CONCEPT_ID, WS, 0);
    const plan = prisma.contentConcept.updateMany.mock.calls[0][0].data.shotPlan;
    expect(plan.shots[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 1, error: expect.stringMatching(/aspect ratio/) });
    expect(plan.shots[1].keyframe.status).toBe('QUEUED');
  });
});
