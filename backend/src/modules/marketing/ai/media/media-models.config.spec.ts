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
    const WITHHELD = [
      'fal-ai/topaz/upscale/video',
      'fal-ai/topaz/upscale/image',
      'fal-ai/qwen-image-edit/inpaint',
      'fal-ai/latentsync',
      // Kept when the four were withdrawn, on the strength of its returned
      // `duration` — which settles the LEDGER but not the AUTHORISATION. The
      // reserve is the only gate that can refuse, and it is sized off a
      // 5-second default because the length is never on the wire.
      'fal-ai/kling-video/ai-avatar/v2/standard',
    ];

    it('serves every catalogued model except the withheld ones', () => {
      expect(listMediaModels().length).toBe(Object.keys(MEDIA_MODELS).length - WITHHELD.length);
      expect(listMediaModels().map((m) => m.id)).toEqual(
        expect.not.arrayContaining(WITHHELD),
      );
    });

    it('empties the techniques whose only model was withheld', () => {
      // Not a bug to hide: Topaz was the only VIDEO_UPSCALE and LatentSync the
      // only LIPSYNC, so those two jobs are genuinely not on offer right now and
      // the studio drops a technique nothing sits under.
      expect(listMediaModels('VIDEO_UPSCALE')).toEqual([]);
      expect(listMediaModels('LIPSYNC')).toEqual([]);
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
        expect(m.withheld).toContain('ffprobe');
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
