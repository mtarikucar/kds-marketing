import { quoteProduction, withProduction } from './shot-production';
import {
  DEFAULT_KEYFRAME_MODEL, DEFAULT_KEYFRAME_REFERENCE_MODEL, DEFAULT_VIDEO_ANIMATE_MODEL, DEFAULT_VIDEO_MODEL,
} from '../ai/media/media-models.config';
import type { ShotPlan } from '../video/video-pipeline.service';

const PLAN: ShotPlan = {
  model: 'seedance', aspectRatio: '9:16', durationSec: 9, captionSuggestion: 'x', qcChecklist: [],
  shots: [
    { ord: 0, scene: '0-2s', voiceover: '', prompt: 'a', durationSec: 2, cameraNote: 'w' },
    { ord: 1, scene: '2-5s', voiceover: '', prompt: 'b', durationSec: 3, cameraNote: 'm' },
    { ord: 2, scene: '5-9s', voiceover: '', prompt: 'c', durationSec: 4, cameraNote: 'c' },
  ],
};

describe('quoteProduction — a storyboarded plan is priced as frames AND clips', () => {
  it('adds one keyframe per beat at the image model rate and folds it into the total', () => {
    const plan = { ...PLAN, storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 7 } };
    const q = quoteProduction(plan, {
      model: DEFAULT_VIDEO_ANIMATE_MODEL, modelSource: 'storyboard', replacedModel: DEFAULT_VIDEO_MODEL, keyframeModel: DEFAULT_KEYFRAME_MODEL,
    });
    expect(q.keyframes).toEqual({ model: DEFAULT_KEYFRAME_MODEL, perFrameCredits: 3, credits: 9, usd: expect.closeTo(0.09, 6) });
    // 3 frames + (2+3+4)s at 3 credits/s on the Pro Fast animator.
    expect(q.billedSecPerBeat).toEqual([2, 3, 4]);
    expect(q.credits).toBe(9 + 27);
    expect(q.usd).toBeCloseTo(0.09 + 9 * 0.0216, 6);
    expect(q.modelSource).toBe('storyboard');
    expect(q.replacedModel).toBe(DEFAULT_VIDEO_MODEL);
  });

  it('prices persona frames on the reference image model', () => {
    const plan = { ...PLAN, storyboard: { imageModel: DEFAULT_KEYFRAME_REFERENCE_MODEL, seed: 7 } };
    const q = quoteProduction(plan, { model: DEFAULT_VIDEO_ANIMATE_MODEL, modelSource: 'storyboard', keyframeModel: DEFAULT_KEYFRAME_REFERENCE_MODEL });
    expect(q.keyframes).toMatchObject({ model: DEFAULT_KEYFRAME_REFERENCE_MODEL, perFrameCredits: 15, credits: 45 });
    expect(q.credits).toBe(45 + 27);
  });

  it('a plan without a storyboard is quoted exactly as before — no frames line', () => {
    const q = quoteProduction(PLAN, { model: DEFAULT_VIDEO_MODEL, modelSource: 'platform' });
    expect(q.keyframes).toBeUndefined();
    expect(q.credits).toBe(27);
    expect(withProduction(PLAN, { model: DEFAULT_VIDEO_MODEL, modelSource: 'platform' }).storyboard).toBeUndefined();
  });
});
