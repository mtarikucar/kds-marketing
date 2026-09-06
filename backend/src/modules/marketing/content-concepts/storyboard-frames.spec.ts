import { BadRequestException } from '@nestjs/common';
import {
  MAX_FRAME_ATTEMPTS,
  frameSeed,
  frameWanted,
  framesReady,
  submitMissingFrames,
  supportsStoryboard,
  syncFrames,
} from './storyboard-frames';
import { DEFAULT_KEYFRAME_MODEL, DEFAULT_KEYFRAME_REFERENCE_MODEL } from '../ai/media/media-models.config';
import type { ShotPlan } from '../video/video-pipeline.service';

const WS = 'ws-1';
const LINK = { socialCampaignId: 'camp-1', createdById: 'u1' };

function plan(over: Partial<ShotPlan> = {}): ShotPlan {
  return {
    model: 'seedance', aspectRatio: '9:16', durationSec: 5, captionSuggestion: 'x', qcChecklist: [],
    storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 100 },
    shots: [
      { ord: 0, scene: '0-2s', voiceover: '', prompt: 'clip a', keyframePrompt: 'still a', durationSec: 2, cameraNote: 'w' },
      { ord: 1, scene: '2-5s', voiceover: '', prompt: 'clip b', keyframePrompt: 'still b', durationSec: 3, cameraNote: 'm' },
    ],
    ...over,
  };
}
const queueFull = () => new BadRequestException({ code: 'MEDIA_GEN_TOO_MANY', message: 'full' });

describe('supportsStoryboard', () => {
  it('is true only for a plan that carries the storyboard record and a prompt per beat', () => {
    expect(supportsStoryboard(plan())).toBe(true);
    expect(supportsStoryboard({ ...plan(), storyboard: undefined })).toBe(false);
    const p = plan();
    delete p.shots[1].keyframePrompt;
    expect(supportsStoryboard(p)).toBe(false);
    expect(supportsStoryboard(null)).toBe(false);
  });
});

describe('submitMissingFrames', () => {
  it('requests one IMAGE per frameless beat with the still prompt, the shared seed and the linkage', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValueOnce({ assetId: 'f0' }).mockResolvedValueOnce({ assetId: 'f1' }) };
    const res = await submitMissingFrames({ mediaGen }, WS, plan() as never, LINK);
    expect(res.submitted).toBe(2);
    expect(res.queueFull).toBe(false);
    expect(mediaGen.requestGeneration).toHaveBeenNthCalledWith(1, WS, {
      type: 'IMAGE', model: DEFAULT_KEYFRAME_MODEL, prompt: 'still a', aspectRatio: '9:16', seed: 100,
      socialCampaignId: 'camp-1', createdById: 'u1',
    });
    expect(res.plan.shots[0].keyframe).toEqual({ assetId: 'f0', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, seed: 100, attempts: 1 });
    expect(res.plan.shots[1].keyframe?.assetId).toBe('f1');
  });

  it('sends persona photos only to a frame model whose contract takes an array of them', async () => {
    const refs = ['https://cdn/p1.jpg'];
    const shots = plan().shots.map((sh) => ({ ...sh, reference: { images: refs, seed: 7 } }));
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'f' }) };
    await submitMissingFrames({ mediaGen }, WS, plan({ shots, storyboard: { imageModel: DEFAULT_KEYFRAME_REFERENCE_MODEL, seed: 7 } }) as never, LINK);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).toMatchObject({ model: DEFAULT_KEYFRAME_REFERENCE_MODEL, referenceImageUrls: refs });
    mediaGen.requestGeneration.mockClear();
    await submitMissingFrames({ mediaGen }, WS, plan({ shots }) as never, LINK);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).not.toHaveProperty('referenceImageUrls');
  });

  it('stops at a full queue and reports it, leaving the rest untouched', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockRejectedValueOnce(queueFull()) };
    const res = await submitMissingFrames({ mediaGen }, WS, plan() as never, LINK);
    expect(res).toMatchObject({ submitted: 0, queueFull: true });
    expect(res.plan.shots.every((sh) => sh.keyframe === undefined)).toBe(true);
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
  });

  it('records any other refusal as a FAILED attempt with the reason and moves on', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockRejectedValueOnce(new Error('bad ratio')).mockResolvedValueOnce({ assetId: 'f1' }) };
    const res = await submitMissingFrames({ mediaGen }, WS, plan() as never, LINK);
    expect(res.plan.shots[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 1, error: 'bad ratio' });
    expect(res.plan.shots[1].keyframe?.status).toBe('QUEUED');
  });

  it('re-requests a refused frame with a nudged seed until the attempt cap, then leaves it alone', async () => {
    const p = plan();
    p.shots[0].keyframe = { assetId: 'old', status: 'FAILED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    p.shots[1].keyframe = { assetId: 'done', status: 'READY', url: 'https://r2/b.png', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'f0b' }) };
    const res = await submitMissingFrames({ mediaGen }, WS, p as never, { ...LINK, campaignItemId: 'item-1' });
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).toMatchObject({ seed: (100 + 104729) % 2147483647, campaignItemId: 'item-1' });
    expect(res.plan.shots[0].keyframe).toMatchObject({ assetId: 'f0b', status: 'QUEUED', attempts: 2 });
    // Exhausted: not wanted any more.
    expect(frameWanted({ assetId: 'x', status: 'FAILED', model: 'm', attempts: MAX_FRAME_ATTEMPTS })).toBe(false);
    expect(frameWanted({ assetId: 'x', status: 'BLOCKED', model: 'm', attempts: 1 })).toBe(true);
  });

  it('a keyframe carrying its own seed (a human regenerate) wins over the plan seed', () => {
    expect(frameSeed({ imageModel: 'm', seed: 5 }, { assetId: '', status: 'FAILED', model: 'm', attempts: 0, seed: 999 })).toBe(999);
    expect(frameSeed({ imageModel: 'm', seed: 5 }, undefined)).toBe(5);
  });
});

describe('syncFrames', () => {
  const withFrames = () => {
    const p = plan();
    p.shots[0].keyframe = { assetId: 'f0', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    p.shots[1].keyframe = { assetId: 'f1', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    return p as never;
  };
  const prisma = (rows: unknown[]) => ({ generatedAsset: { findMany: jest.fn().mockResolvedValue(rows) } });

  it('brings READY frames their URL, counts the rest as pending, and reads only this workspace', async () => {
    const db = prisma([{ id: 'f0', status: 'READY', url: 'https://r2/a.png', error: null }, { id: 'f1', status: 'GENERATING', url: null, error: null }]);
    const res = await syncFrames({ prisma: db as never }, WS, withFrames());
    expect(db.generatedAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['f0', 'f1'] }, workspaceId: WS } }));
    expect(res.plan.shots[0].keyframe).toMatchObject({ status: 'READY', url: 'https://r2/a.png' });
    expect(res.plan.shots[1].keyframe?.status).toBe('GENERATING');
    expect(res.pending).toBe(1);
    expect(res.failed).toEqual([]);
    expect(res.changed).toBe(true);
    expect(framesReady(res.plan)).toBe(false);
  });

  it('marks a refused frame FAILED with the vendor reason; it fails BY NAME only once the attempts are spent', async () => {
    const first = await syncFrames({ prisma: prisma([{ id: 'f0', status: 'BLOCKED', url: null, error: 'nsfw' }, { id: 'f1', status: 'READY', url: 'u', error: null }]) as never }, WS, withFrames());
    expect(first.plan.shots[0].keyframe).toMatchObject({ status: 'BLOCKED', error: 'nsfw', attempts: 1 });
    expect(first.failed).toEqual([]); // one attempt left
    const p = first.plan;
    p.shots[0].keyframe = { ...p.shots[0].keyframe!, status: 'QUEUED', assetId: 'f0b', attempts: 2 };
    const second = await syncFrames({ prisma: prisma([{ id: 'f0b', status: 'FAILED', url: null, error: 'boom' }, { id: 'f1', status: 'READY', url: 'u', error: null }]) as never }, WS, p);
    expect(second.failed).toEqual([{ ord: 0, keyframe: expect.objectContaining({ status: 'FAILED', error: 'boom', attempts: 2 }) }]);
  });

  it('treats a vanished asset row as a refusal rather than waiting on it forever', async () => {
    const res = await syncFrames({ prisma: prisma([{ id: 'f1', status: 'READY', url: 'u', error: null }]) as never }, WS, withFrames());
    expect(res.plan.shots[0].keyframe).toMatchObject({ status: 'FAILED', error: /no longer exists/ });
    expect(res.pending).toBe(0);
  });

  it('is a no-op for a plan whose frames are all READY', async () => {
    const p = withFrames() as ShotPlan;
    p.shots.forEach((sh) => { sh.keyframe = { ...sh.keyframe!, status: 'READY', url: 'u' }; });
    const db = prisma([]);
    const res = await syncFrames({ prisma: db as never }, WS, p as never);
    expect(res.changed).toBe(false);
    expect(framesReady(res.plan)).toBe(true);
    // READY frames are final and are not re-read.
    expect(db.generatedAsset.findMany).not.toHaveBeenCalled();
  });
});
