import {
  MEDIA_MODELS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_AUDIO_MODEL,
  getMediaModel,
  isCataloguedModel,
  defaultModelFor,
  listMediaModels,
  allMediaModels,
  isMediaModelWithheld,
  estimateMediaCredits,
  estimateMediaUsd,
  RETIRED_SEEDANCE_LITE_MODEL,
  resolveMediaModelId,
  isMediaModelReplaced,
  assertCataloguedModel,
  estimateVendorUsd,
  assertModelOffersAspect,
  mediaModelAspectOptions,
  mediaModelOffersAspect,
} from './media-models.config';
import { buildFalInput } from '../providers/fal.provider';

describe('media-models config', () => {
  it('registers the spec default image + video + audio models', () => {
    expect(getMediaModel(DEFAULT_IMAGE_MODEL)?.type).toBe('IMAGE');
    expect(getMediaModel(DEFAULT_VIDEO_MODEL)?.type).toBe('VIDEO');
    expect(getMediaModel(DEFAULT_AUDIO_MODEL)?.type).toBe('AUDIO');
    expect(MEDIA_MODELS['fal-ai/bytedance/seedance/v1/pro/text-to-video'].type).toBe('VIDEO');
  });

  it('keeps every previously-catalogued id and price (old assets reference them)', () => {
    // Existing GeneratedAsset rows carry these ids; dropping or re-pricing one
    // breaks regenerate and re-meters history.
    const legacy: Record<string, number> = {
      'fal-ai/qwen-image': 2,
      'fal-ai/bytedance/seedream/v4/text-to-image': 3,
    };
    for (const [id, credits] of Object.entries(legacy)) {
      expect(MEDIA_MODELS[id].credits).toBe(credits);
    }
    expect(MEDIA_MODELS['fal-ai/bytedance/seedance/v1/lite/text-to-video'].creditsPerSec).toBe(3);
    expect(MEDIA_MODELS['fal-ai/bytedance/seedance/v1/pro/text-to-video'].creditsPerSec).toBe(15);
    expect(MEDIA_MODELS['fal-ai/veo3/fast'].creditsPerSec).toBe(25);
  });

  it('groups models by technique', () => {
    expect(listMediaModels('VOICE').map((m) => m.id)).toEqual([DEFAULT_AUDIO_MODEL]);
    expect(listMediaModels('AVATAR').map((m) => m.id)).toEqual([
      'veed/avatars/text-to-video',
    ]);
  });

  /**
   * WITHHELD entries stay in the catalogue — verified id, contract and published
   * pricing — but are not sold, because their price is a property of a file the
   * customer supplies and nothing here can measure that file yet.
   *
   * `listMediaModels` is the one place that decision is made, so it is the one
   * place it is tested. Everything customer-facing is built from it.
   */
  describe('withheld models', () => {
    // A real server-side probe (ffprobe) now measures the customer's file
    // before the reserve, which released the two whose ONLY blocker was the
    // measurement — Topaz image and LatentSync. What is left is the three whose
    // second unknown is not a measurement problem.
    const WITHHELD = [
      // Measuring the clip settles its seconds. It does not settle the 60fps
      // multiplier: fal doubles the rate for 60fps OUTPUT, target_fps is
      // deliberately not sent, and an unset target_fps means the output keeps
      // the SOURCE's frame rate — so a 1080p60 phone clip really costs $0.16/s
      // against the $0.08/s metered here.
      'fal-ai/topaz/upscale/video',
      // Measuring the source settles its megapixels. It does not settle whether
      // the OUTPUT matches the input at all, which is what those megapixels are
      // standing in for.
      'fal-ai/qwen-image-edit/inpaint',
      // Not source-metered at all — per-second with a returned duration — so
      // nothing carries the measurement into the reserve. Sizing an
      // authorisation from a measured source, for a model with no duration
      // input, is a new rule rather than a line deleted.
      'fal-ai/kling-video/ai-avatar/v2/standard',
    ];

    /** The phrase each remaining reason must still contain, so a reason cannot
     *  go stale without a test noticing. */
    const REMAINING_BLOCKER: Record<string, string> = {
      'fal-ai/topaz/upscale/video': '60fps',
      'fal-ai/qwen-image-edit/inpaint': 'whether the output',
      'fal-ai/kling-video/ai-avatar/v2/standard': 'MEDIA_GEN_MAX_VIDEO_SEC',
    };

    it('serves every catalogued model except the withheld and the fal-retired ones', () => {
      const retired = Object.values(MEDIA_MODELS).filter((m) => m.replacedBy).map((m) => m.id);
      expect(retired.length).toBeGreaterThan(0);
      expect(listMediaModels().length).toBe(Object.keys(MEDIA_MODELS).length - WITHHELD.length - retired.length);
      expect(listMediaModels().map((m) => m.id)).toEqual(
        expect.not.arrayContaining([...WITHHELD, ...retired]),
      );
    });

    it('empties the technique whose only model is still withheld', () => {
      // Topaz is the only VIDEO_UPSCALE, so that job is genuinely not on offer
      // and the studio drops a technique nothing sits under.
      expect(listMediaModels('VIDEO_UPSCALE')).toEqual([]);
    });

    it('puts LIPSYNC back on the menu now that its length can be measured', () => {
      // LatentSync was the only LIPSYNC model, and the technique disappeared
      // with it. Measuring the longer of the video and the audio is the whole
      // of what it was waiting for.
      expect(listMediaModels('LIPSYNC').map((m) => m.id)).toContain('fal-ai/latentsync');
    });

    it('keeps them catalogued, priced and flagged rather than deleting them', () => {
      // The research is the asset. `allMediaModels` is what the live endpoint
      // probe walks, so a withheld model that dies on fal still turns a test red.
      for (const id of WITHHELD) {
        const m = MEDIA_MODELS[id];
        expect(m).toBeDefined();
        expect(isMediaModelWithheld(id)).toBe(true);
        expect(allMediaModels().map((x) => x.id)).toContain(id);
        // The reason is a paragraph a human can act on, not a boolean.
        expect(m.withheld!.length).toBeGreaterThan(200);
        // And it names THIS model's own remaining blocker. They used to share
        // one ("no probe exists"); the probe exists now, so a reason that has
        // not been updated to say what is actually left is a stale reason, and
        // a stale reason is how a model stays withheld after its blocker is
        // gone — or gets released while it still has one.
        expect(m.withheld).toContain(REMAINING_BLOCKER[id]);
      }
    });

    it('marks nothing else withheld', () => {
      const flagged = allMediaModels().filter((m) => m.withheld).map((m) => m.id);
      expect(flagged.sort()).toEqual([...WITHHELD].sort());
    });
  });

  it('estimates image credits as a flat per-image cost', () => {
    expect(estimateMediaCredits(DEFAULT_IMAGE_MODEL)).toBe(
      MEDIA_MODELS[DEFAULT_IMAGE_MODEL].credits,
    );
  });

  it('estimates video credits as ceil(creditsPerSec * duration)', () => {
    const m = MEDIA_MODELS[DEFAULT_VIDEO_MODEL];
    expect(estimateMediaCredits(DEFAULT_VIDEO_MODEL, 5)).toBe(
      Math.ceil((m.creditsPerSec ?? 0) * 5),
    );
  });

  it('estimates USD for video as pricePerSec * duration (bookkeeping)', () => {
    const m = MEDIA_MODELS[DEFAULT_VIDEO_MODEL];
    expect(estimateMediaUsd(DEFAULT_VIDEO_MODEL, 5)).toBeCloseTo((m.pricePerSecUsd ?? 0) * 5, 6);
  });

  it('falls back to a safe non-zero estimate for an unknown model', () => {
    expect(estimateMediaCredits('fal-ai/unknown')).toBeGreaterThan(0);
  });

  it('bills the TOP resolution tier at its own rate, not an average', () => {
    // The reason tiers exist. Seedance 2.5 is ~2.5x more expensive at 1080p than
    // at 720p; one averaged rate would under-charge every 1080p render.
    const id = 'bytedance/seedance-2.5/text-to-video';
    expect(estimateMediaCredits(id, { durationSec: 5, resolution: '720p' })).toBe(240);
    expect(estimateMediaCredits(id, { durationSec: 5, resolution: '1080p' })).toBe(585);
    expect(estimateMediaCredits(id, { durationSec: 5, resolution: '480p' })).toBe(115);
    // An unpriced tier (and no tier at all) falls back to the model's own rate,
    // which is the rate for contract.resolution.default.
    expect(estimateMediaCredits(id, { durationSec: 5 })).toBe(240);
  });

  it('bills a flat-per-run video model per run, not per second', () => {
    // wan-flf2v and latentsync are VIDEO but priced per run — so the estimate
    // branch has to key off the RATE the model carries, not its asset type.
    expect(estimateMediaCredits('fal-ai/wan-flf2v', { durationSec: 5 })).toBe(40);
    expect(estimateMediaCredits('fal-ai/wan-flf2v', { durationSec: 5, resolution: '480p' })).toBe(20);
    expect(estimateMediaCredits('fal-ai/latentsync', { durationSec: 30 })).toBe(20);
  });

  it('bills TTS per 1000 characters of script', () => {
    expect(estimateMediaCredits(DEFAULT_AUDIO_MODEL, { textLength: 150 })).toBe(2); // ceil(1.5)
    expect(estimateMediaCredits(DEFAULT_AUDIO_MODEL, { textLength: 2000 })).toBe(20);
    expect(estimateMediaUsd(DEFAULT_AUDIO_MODEL, { textLength: 1000 })).toBeCloseTo(0.10, 6);
  });

  it('bills the length fal will RENDER, not the length that was asked for', () => {
    // The estimate and the wire duration are two views of one number. The
    // provider clamps a request into the model's published range and snaps it
    // DOWN to an offered value; billing the raw request instead is wrong in both
    // directions, and the expensive models are exactly where it bites.
    //
    // 1s on Seedance 2.5 renders a 4s clip (its floor). At 1080p that costs us
    // 4 x $1.164 = $4.66 — charging the requested second would reserve 117
    // credits ($1.17) for it and lose $3.49 on every call.
    const seedance = 'bytedance/seedance-2.5/text-to-video';
    expect(buildFalInput({ type: 'VIDEO', model: seedance, prompt: 'x', durationSec: 1 }).duration)
      .toBe('4');
    expect(estimateMediaCredits(seedance, { durationSec: 1, resolution: '1080p' })).toBe(468);
    expect(estimateMediaUsd(seedance, { durationSec: 1, resolution: '1080p' })).toBeCloseTo(4.656, 6);

    // Veo publishes an enum [4,6,8]: 5s renders 4s, so quoting five over-charges
    // the customer for a second fal never produces (and Veo returns no duration,
    // so the finalize true-up cannot correct it afterwards).
    expect(buildFalInput({ type: 'VIDEO', model: 'fal-ai/veo3.1', prompt: 'x', durationSec: 5 }).duration)
      .toBe('4s');
    expect(estimateMediaCredits('fal-ai/veo3.1', { durationSec: 5 })).toBe(160);
    expect(estimateMediaCredits('fal-ai/veo3.1', { durationSec: 1 })).toBe(160);
    expect(estimateMediaCredits('fal-ai/veo3.1', { durationSec: 10 })).toBe(320); // snapped to 8

    // A model with no duration contract is untouched: it bills flat per run.
    expect(estimateMediaCredits('fal-ai/latentsync', { durationSec: 1 })).toBe(20);
  });

  it('bills music in whole minutes, rounded up', () => {
    // ElevenLabs charges a full minute for a 30-second bed and two for a 61-second
    // one; a per-second rate would under-charge both.
    expect(estimateMediaCredits('fal-ai/elevenlabs/music', { durationSec: 30 })).toBe(60);
    expect(estimateMediaCredits('fal-ai/elevenlabs/music', { durationSec: 61 })).toBe(120);
    expect(estimateMediaUsd('fal-ai/elevenlabs/music', { durationSec: 61 })).toBeCloseTo(1.20, 6);
  });
});

/**
 * Stage 3 — the workspace-level default.
 *
 * These two helpers are the whole vocabulary the resolution order needs, and
 * they are PURE on purpose: the order itself (campaign override ?? workspace
 * default ?? code constant) is enforced at one call site in MediaGenService,
 * and putting the catalogue rules here keeps that call site readable.
 */
describe('media-models config — catalogue membership by KIND', () => {
  it('accepts a catalogued id only for its own kind', () => {
    expect(isCataloguedModel(DEFAULT_VIDEO_MODEL, 'VIDEO')).toBe(true);
    expect(isCataloguedModel(DEFAULT_IMAGE_MODEL, 'IMAGE')).toBe(true);
  });

  /**
   * The check the plain `getMediaModel(id)` guard could not make. An IMAGE model
   * accepted for a VIDEO request is not a harmless mislabel: `estimateMediaCredits`
   * would bill the flat 3-credit image rate for a clip fal charges per second for,
   * which is the exact failure the "unknown model" refusal already exists to stop.
   */
  it('refuses a catalogued id of the WRONG kind', () => {
    expect(isCataloguedModel(DEFAULT_IMAGE_MODEL, 'VIDEO')).toBe(false);
    expect(isCataloguedModel(DEFAULT_VIDEO_MODEL, 'IMAGE')).toBe(false);
  });

  it('refuses an uncatalogued id for either kind', () => {
    expect(isCataloguedModel('fal-ai/whatever', 'VIDEO')).toBe(false);
    expect(isCataloguedModel('fal-ai/whatever', 'IMAGE')).toBe(false);
  });

  it('names the code constant for each kind', () => {
    expect(defaultModelFor('VIDEO')).toBe(DEFAULT_VIDEO_MODEL);
    expect(defaultModelFor('IMAGE')).toBe(DEFAULT_IMAGE_MODEL);
  });

  /**
   * The settings card is a PRICE list, so the catalogue has to be readable as
   * one. Every entry must carry a price — an entry with no number renders as a
   * free option next to paid ones.
   *
   * What it may NOT assume is that the unit follows the asset TYPE. That held
   * while the catalogue was five text-to-something models; it stopped holding
   * when the techniques arrived. wan-flf2v and latentsync are VIDEO and billed
   * flat per run; MMAudio is VIDEO and billed per second of AUDIO; the music
   * and TTS entries bill per minute and per 1000 characters. So the assertion
   * is that SOME rate is carried and that its credit side agrees with its
   * dollar side — which is the property the card actually needs.
   */
  it('prices every catalogued model, in whichever unit that model is billed by', () => {
    const RATES: Array<[keyof MediaModel, keyof MediaModel]> = [
      ['priceUsd', 'credits'],
      ['pricePerSecUsd', 'creditsPerSec'],
      ['pricePerKCharUsd', 'creditsPerKChar'],
      ['pricePerMinuteUsd', 'creditsPerMinute'],
    ];
    for (const m of Object.values(MEDIA_MODELS)) {
      const carried = RATES.filter(([usd]) => typeof m[usd] === 'number');
      // Exactly one: two rates on one model is an ambiguity the estimator
      // would resolve by branch order rather than by intent.
      expect({ id: m.id, rates: carried.length }).toEqual({ id: m.id, rates: 1 });
      const [usdKey, creditKey] = carried[0];
      expect(m[usdKey] as number).toBeGreaterThan(0);
      expect(m[creditKey] as number).toBeGreaterThan(0);
    }
  });
});

describe('retired ids (replacedBy)', () => {
  it('names Seedance 1.0 Pro Fast as the platform default, pinned to 720p', () => {
    expect(DEFAULT_VIDEO_MODEL).toBe('fal-ai/bytedance/seedance/v1/pro/fast/text-to-video');
    const m = MEDIA_MODELS[DEFAULT_VIDEO_MODEL];
    expect(m.contract.resolution).toEqual({ param: 'resolution', values: ['480p', '720p', '1080p'], default: '720p' });
    expect(m.contract.duration?.encoding).toBe('digitStringSeconds');
    expect(m.contract.aspect?.values['4:5']).toBeUndefined();
    expect(m.contract.negativePrompt).toBe(false);
    // $1/M tokens: 720p 21,600 tok/s → $0.0216/s → 3 credits; 1080p → 5; 480p → 1.
    expect(m.creditsPerSec).toBe(3);
    expect(estimateMediaCredits(DEFAULT_VIDEO_MODEL, { durationSec: 5, resolution: '1080p' })).toBe(25);
    expect(estimateMediaCredits(DEFAULT_VIDEO_MODEL, { durationSec: 5, resolution: '480p' })).toBe(5);
    expect(buildFalInput({ type: 'VIDEO', model: DEFAULT_VIDEO_MODEL, prompt: 'x', durationSec: 8 }))
      .toMatchObject({ resolution: '720p', duration: '8' });
  });

  it('resolves the two fal-retired ids to their successors and stops on a live id', () => {
    expect(resolveMediaModelId(RETIRED_SEEDANCE_LITE_MODEL)).toBe(DEFAULT_VIDEO_MODEL);
    expect(resolveMediaModelId('fal-ai/veo3/fast')).toBe('fal-ai/veo3.1/fast');
    expect(resolveMediaModelId(DEFAULT_VIDEO_MODEL)).toBe(DEFAULT_VIDEO_MODEL);
    expect(resolveMediaModelId('not-a-model')).toBe('not-a-model');
    expect(isMediaModelReplaced(RETIRED_SEEDANCE_LITE_MODEL)).toBe(true);
    expect(isMediaModelReplaced(DEFAULT_VIDEO_MODEL)).toBe(false);
  });

  it('answers the aspect question for the model that will actually run', () => {
    // Lite published 4:5; its successor does not. A shot plan asking the stored
    // (retired) id must hear the successor's answer, or the plan passes here and
    // 400s at the wire.
    expect(mediaModelOffersAspect(RETIRED_SEEDANCE_LITE_MODEL, '4:5')).toBe(false);
    expect(mediaModelOffersAspect(RETIRED_SEEDANCE_LITE_MODEL, '9:16')).toBe(true);
    expect(mediaModelAspectOptions('fal-ai/veo3/fast')).toEqual(['16:9', '9:16']);
  });

  it('never chains or cycles: every successor is a live, same-kind model', () => {
    for (const m of allMediaModels().filter((x) => x.replacedBy)) {
      const successor = MEDIA_MODELS[m.replacedBy!];
      expect(successor).toBeDefined();
      expect(successor.replacedBy).toBeUndefined();
      expect(successor.withheld).toBeUndefined();
      expect(successor.type).toBe(m.type);
    }
  });

  it('keeps retired ids priced and typed (old rows reference them) but off the menu and off the write gate', () => {
    expect(isCataloguedModel(RETIRED_SEEDANCE_LITE_MODEL, 'VIDEO')).toBe(true);
    expect(MEDIA_MODELS[RETIRED_SEEDANCE_LITE_MODEL].creditsPerSec).toBe(3);
    expect(listMediaModels().map((m) => m.id)).not.toContain(RETIRED_SEEDANCE_LITE_MODEL);
    expect(listMediaModels().map((m) => m.id)).not.toContain('fal-ai/veo3/fast');
    expect(() => assertCataloguedModel('fal-ai/veo3/fast', 'VIDEO')).toThrow(/retired.*fal-ai\/veo3\.1\/fast/);
    expect(assertCataloguedModel('fal-ai/veo3.1/fast', 'VIDEO')).toBe('fal-ai/veo3.1/fast');
  });
});

describe('runware bindings', () => {
  const BOUND: Array<[string, string]> = [
    ['bytedance/seedance-2.5/text-to-video', 'bytedance:seedance@2.5'],
    ['bytedance/seedance-2.5/image-to-video', 'bytedance:seedance@2.5'],
    [DEFAULT_VIDEO_MODEL, 'bytedance:2@2'],
    ['fal-ai/qwen-image', 'runware:108@1'],
    ['fal-ai/birefnet/v2', 'runware:112@5'],
  ];

  it('binds exactly the five v1 models', () => {
    const bound = allMediaModels().filter((m) => m.runware).map((m) => [m.id, m.runware!.model]);
    expect(bound.sort()).toEqual([...BOUND].sort());
  });

  it('prices vendor USD from the Runware rate without touching the credit meter', () => {
    // Seedance 2.5, 5s at 720p: fal $0.473/s, Runware $0.2304/s; credits stay 48/s.
    const opts = { durationSec: 5, resolution: '720p' };
    expect(estimateVendorUsd('bytedance/seedance-2.5/text-to-video', opts, 'fal')).toBeCloseTo(2.365, 6);
    expect(estimateVendorUsd('bytedance/seedance-2.5/text-to-video', opts, 'runware')).toBeCloseTo(1.152, 6);
    expect(estimateMediaCredits('bytedance/seedance-2.5/text-to-video', opts)).toBe(240);
    // Tiered Runware rate: 1080p.
    expect(estimateVendorUsd('bytedance/seedance-2.5/text-to-video', { durationSec: 5, resolution: '1080p' }, 'runware'))
      .toBeCloseTo(3.0677, 4);
    // Flat image rate; a model with no binding falls back to the fal figure.
    expect(estimateVendorUsd('fal-ai/qwen-image', {}, 'runware')).toBeCloseTo(0.0058, 6);
    expect(estimateVendorUsd('fal-ai/birefnet/v2', {}, 'runware')).toBeCloseTo(0.0006, 6);
    expect(estimateVendorUsd(DEFAULT_IMAGE_MODEL, {}, 'runware')).toBeCloseTo(0.03, 6);
    // The default video model's Runware tiers: 5s at 480p / 720p / 1080p.
    expect(estimateVendorUsd(DEFAULT_VIDEO_MODEL, { durationSec: 5, resolution: '480p' }, 'runware')).toBeCloseTo(0.03145, 6);
    expect(estimateVendorUsd(DEFAULT_VIDEO_MODEL, { durationSec: 5, resolution: '720p' }, 'runware')).toBeCloseTo(0.0668, 6);
    expect(estimateVendorUsd(DEFAULT_VIDEO_MODEL, { durationSec: 5, resolution: '1080p' }, 'runware')).toBeCloseTo(0.15885, 6);
  });
});

/**
 * THE FRAME, REFUSED AT THE DOOR WHERE THE MODEL IS CHOSEN.
 *
 * This rule was written inside `ConceptPromotionService.produce`, which is the
 * one place it could do no good: produce runs after a human has approved the
 * concept and after the item has been promoted, and neither of those can be
 * taken back (`review()` refuses a second verdict, `regenerateItem` refuses a
 * promoted item). A campaign pointed at a model that does not publish this
 * line's frame therefore failed every concept it was ever given, permanently,
 * with the reason on an item row nobody could act on.
 *
 * The same question asked at campaign create/update and at the workspace
 * defaults card is one sentence on the screen where the choice is being made.
 */
describe('assertModelOffersAspect — the refusal belongs where the model is chosen', () => {
  it('refuses a model whose published enum does not contain the frame, and names what it does publish', () => {
    // Veo 3.1 publishes 16:9 and 9:16 and nothing else.
    expect(mediaModelAspectOptions('fal-ai/veo3.1')).toEqual(['16:9', '9:16']);
    expect(() => assertModelOffersAspect('fal-ai/veo3.1', '1:1')).toThrow(/1:1/);
    expect(() => assertModelOffersAspect('fal-ai/veo3.1', '1:1')).toThrow(/16:9, 9:16/);
  });

  it('accepts a model that publishes the frame', () => {
    expect(() => assertModelOffersAspect('fal-ai/veo3.1', '9:16')).not.toThrow();
    expect(() => assertModelOffersAspect(DEFAULT_VIDEO_MODEL, '9:16')).not.toThrow();
  });

  it('accepts a model that publishes NO aspect contract at all', () => {
    // `veed/avatars/text-to-video` is a served VIDEO model with no aspect
    // parameter — its frame comes from the avatar id, and its vertical avatars
    // are exactly what this line wants. Reading "offers no ratio" as "cannot do
    // 9:16" refused a legitimate choice AND stranded every concept produced
    // under it; the producer sends no ratio to such a model and records that on
    // the plan instead.
    expect(mediaModelAspectOptions('veed/avatars/text-to-video')).toEqual([]);
    expect(() => assertModelOffersAspect('veed/avatars/text-to-video', '9:16')).not.toThrow();
  });
});
