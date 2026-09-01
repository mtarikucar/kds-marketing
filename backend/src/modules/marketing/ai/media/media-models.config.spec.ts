import {
  MEDIA_MODELS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  getMediaModel,
  isCataloguedModel,
  defaultModelFor,
  estimateMediaCredits,
  estimateMediaUsd,
} from './media-models.config';

describe('media-models config', () => {
  it('registers the spec default image + video models', () => {
    expect(getMediaModel(DEFAULT_IMAGE_MODEL)?.type).toBe('IMAGE');
    expect(getMediaModel(DEFAULT_VIDEO_MODEL)?.type).toBe('VIDEO');
    expect(MEDIA_MODELS['fal-ai/bytedance/seedance/v1/pro/text-to-video'].type).toBe('VIDEO');
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
   * one. Every entry must carry the number its kind is billed by — an entry
   * with no price would render as a free option next to paid ones.
   */
  it('prices every catalogued model in the unit its kind is billed in', () => {
    for (const m of Object.values(MEDIA_MODELS)) {
      if (m.type === 'VIDEO') {
        expect(m.pricePerSecUsd).toBeGreaterThan(0);
        expect(m.creditsPerSec).toBeGreaterThan(0);
      } else {
        expect(m.priceUsd).toBeGreaterThan(0);
        expect(m.credits).toBeGreaterThan(0);
      }
    }
  });
});
