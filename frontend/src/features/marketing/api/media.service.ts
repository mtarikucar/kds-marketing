/**
 * media.service.ts — typed API for AI Content Studio media generation
 * (spec §8). Paths are relative to /marketing.
 */
import marketingApi from './marketingApi';

export type GeneratedAssetType = 'IMAGE' | 'VIDEO' | 'AUDIO';
export type GeneratedAssetStatus = 'QUEUED' | 'GENERATING' | 'READY' | 'FAILED' | 'BLOCKED';

export interface GeneratedAsset {
  id: string;
  type: GeneratedAssetType;
  status: GeneratedAssetStatus;
  provider: string;
  model: string;
  prompt: string;
  negativePrompt?: string | null;
  params: Record<string, unknown>;
  url?: string | null;
  r2Key?: string | null;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  thumbnailUrl?: string | null;
  costCredits?: number | null;
  error?: string | null;
  socialCampaignId?: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateMediaPayload {
  type: GeneratedAssetType;
  prompt: string;
  model?: string;
  quality?: 'DRAFT' | 'FINAL';
  negativePrompt?: string;
  aspectRatio?: string;
  /** Wire resolution value — '720p', '4k', '2K', '1024x1024'. Casing matters. */
  resolution?: string;
  durationSec?: number;
  // The source measurement is deliberately NOT part of the request. A
  // source-metered model bills on a property of the FILE, and a property stated
  // by the payer is not a measurement: the server reads it off the object it
  // holds (a library row's, or an upload's) and refuses a source it cannot
  // read — which is why such a model does not accept a pasted link. The panel's
  // own probe below is for the QUOTE it shows before the click, nothing else.
  generateAudio?: boolean;
  /** Source media. The backend maps these onto the chosen model's own parameter
   *  names (`image_url` vs `image_urls` vs `start_image_url` …); the wire
   *  spelling is never this layer's business. */
  referenceImageUrls?: string[];
  lastImageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  maskUrl?: string;
  voice?: string;
  language?: string;
  avatar?: string;
  seed?: number;
}

export interface GenerationFilters {
  type?: GeneratedAssetType;
  status?: GeneratedAssetStatus;
  campaignId?: string;
}

// ---------------------------------------------------------------------------
// CATALOGUE
//
// GET /ai/media/models is the studio picker's only source of truth: the same
// module that prices and validates a generation serves the technique list and
// each model's input contract, so the picker cannot offer a control the model
// will reject. Nothing about a model is hardcoded on this side.
// ---------------------------------------------------------------------------

export type MediaTechnique =
  | 'IMAGE_CREATE' | 'IMAGE_EDIT' | 'IMAGE_CLEANUP'
  | 'VIDEO_CREATE' | 'VIDEO_ANIMATE' | 'VIDEO_REFERENCE' | 'VIDEO_TRANSITION'
  | 'VIDEO_EXTEND' | 'VIDEO_UPSCALE'
  | 'AVATAR' | 'LIPSYNC' | 'VOICE' | 'MUSIC' | 'VIDEO_SOUND';

export type MediaSourceSlot = 'images' | 'firstImage' | 'lastImage' | 'video' | 'audio' | 'mask';

export interface MediaSourceContract {
  slot: MediaSourceSlot;
  /** The provider-side parameter name. Carried because it is the only thing that
   *  separates "the source image" from "the opening frame" — both are firstImage. */
  param: string;
  arity: 'single' | 'array';
  required: boolean;
  maxCount?: number;
}

export interface MediaDurationContract {
  param: string;
  minSec: number;
  maxSec: number;
  /** When present the model takes an enum of lengths, so the panel offers only
   *  these — anything else is snapped DOWN server-side, and the estimate the
   *  user was shown would no longer describe the clip they get. */
  allowedSec?: number[];
}

export interface MediaResolutionContract {
  param: string;
  values: string[];
  default: string;
}

export interface MediaAspectContract {
  param: 'aspect_ratio' | 'image_size';
  /** canonical ratio → wire value. Only the KEYS are ours to offer. */
  values: Record<string, string>;
}

export interface MediaAudioContract {
  param: string;
  default: boolean;
}

export type MediaChoiceSlot = 'voice' | 'language' | 'avatar';

export interface MediaChoiceContract {
  param: string;
  /** Empty means free-form: the endpoint takes any string, not an enum. */
  values: string[];
  default: string;
}

export type MediaMeteredQuantity = 'durationSec' | 'megapixels';

/** One rung of a banded rate: the rung that applies is the cheapest whose
 *  `maxUnits` is at or above the measured quantity. Stated in USD only — the
 *  credit figure is derived from it (`ceil(usd * 100)`), because a second,
 *  hand-rounded credit rate is exactly what let the quote and the charge drift. */
export interface MediaRateStep {
  maxUnits: number;
  priceUsd: number;
}

/**
 * Present when the model's bill is a property of the caller's SOURCE — the
 * length of the clip handed to an upscaler, the pixels handed to Topaz, the
 * spoken length of a script — rather than of the request.
 *
 * The panel cannot price such a model, and the server will not accept it, until
 * that quantity is measured. `from` names where the measurement comes from: the
 * script, or the source slots (the LARGEST of them decides).
 */
export interface MediaSourceMeteringContract {
  quantity: MediaMeteredQuantity;
  from: 'script' | MediaSourceSlot[];
  /** Source → OUTPUT multiplier: Topaz bills output pixels at upscale_factor 2. */
  outputFactor?: number;
  /** Units the model's flat rate already covers before the per-unit rate starts. */
  freeUnits?: number;
  /** Per-unit rate past `freeUnits`, in USD. There is no `creditsPerUnit` twin:
   *  LatentSync's $0.005/s is HALF a credit, and rounding that up per second
   *  quoted a 5-minute lipsync at 280 credits for a $1.50 render. */
  pricePerUnitUsd?: number;
  ladder?: MediaRateStep[];
  /** The endpoint's published ceiling; past it the server refuses. */
  maxUnits?: number;
  charsPerSec?: number;
}

export interface MediaInputContract {
  /** null for a pure transform (upscale, matting, lipsync) that takes no prompt. */
  promptParam: string | null;
  negativePrompt: boolean;
  seedInput: boolean;
  duration?: MediaDurationContract;
  resolution?: MediaResolutionContract;
  aspect?: MediaAspectContract;
  audio?: MediaAudioContract;
  sources?: MediaSourceContract[];
  choices?: Partial<Record<MediaChoiceSlot, MediaChoiceContract>>;
  sourceMetering?: MediaSourceMeteringContract;
}

/** The customer-facing meter. Exactly one of these fields decides the branch. */
export interface MediaRate {
  credits?: number;
  creditsPerSec?: number;
  creditsPerKChar?: number;
  creditsPerMinute?: number;
}

export interface MediaModelInfo extends MediaRate {
  id: string;
  technique: MediaTechnique;
  type: GeneratedAssetType;
  label: string;
  contract: MediaInputContract;
  /** Per-resolution DEVIATIONS only; a miss falls back to the model's own rate. */
  tiers?: Record<string, MediaRate>;
  note?: string;
}

export interface MediaCatalogue {
  techniques: MediaTechnique[];
  models: MediaModelInfo[];
}

export const listMediaModels = (): Promise<MediaCatalogue> =>
  marketingApi.get('/ai/media/models').then((r) => r.data);

// The server clamps every request to these ceilings (MEDIA_GEN_MAX_VIDEO_SEC /
// MEDIA_GEN_MAX_AUDIO_SEC in media-gen.service.ts). Mirrored so the panel cannot
// offer — or price — a length the backend will silently shorten. Drifting low
// only narrows what we offer; it can never buy a longer clip than the server allows.
export const MEDIA_MAX_VIDEO_SEC = 10;
export const MEDIA_MAX_AUDIO_SEC = 60;

const FALLBACK_IMAGE_CREDITS = 3;
const DEFAULT_DURATION_SEC = 5;
const DEFAULT_TEXT_LENGTH = 500;

/** The reading pace a script-metered model is assumed to be read at when it
 *  names none. Mirrors the backend's DEFAULT_SCRIPT_CHARS_PER_SEC. */
const DEFAULT_SCRIPT_CHARS_PER_SEC = 12;

export interface MediaEstimateOpts {
  durationSec?: number;
  /** The wire resolution value — picks the tier rate where one exists. */
  resolution?: string;
  /** Script length in characters; the per-1000-character TTS models bill on it,
   *  and it is the measurement for a `from: 'script'` source-metered model. */
  textLength?: number;
}
// There is deliberately no measured-source field here. Nothing in the panel can
// honestly produce one — reading a duration or a pixel count off a customer's
// file needs a real probe, server-side, where the charge is decided — and every
// model priced that way is withheld from the catalogue until that exists, so the
// picker never sees one to price.

/**
 * The quantity a source-metered model bills on, or null when it is not there
 * yet. Mirrors the backend `meteredUnits`, including the round UP to a whole
 * second — fal bills "for every second a video".
 *
 * Only `from: 'script'` reaches this: a script is the prompt, which the panel
 * already holds, so it is the one metered quantity that can be known here. A
 * model metered from a source FILE has no price this side of the network and is
 * not served at all, so it answers null and the caller shows "no price yet"
 * rather than a base rate the server would disagree with.
 */
export function meteredUnits(model: MediaModelInfo, opts: MediaEstimateOpts): number | null {
  const sm = model.contract.sourceMetering;
  if (!sm || sm.from !== 'script') return null;
  const chars = opts.textLength ?? 0;
  return chars > 0 ? Math.ceil(chars / (sm.charsPerSec ?? DEFAULT_SCRIPT_CHARS_PER_SEC)) : null;
}

/**
 * The length the model will actually RENDER for a requested one — the backend's
 * `billableDurationSec`, mirrored. It clamps into the contract's range and snaps
 * DOWN to a published value, and the server bills against exactly this figure, so
 * quoting the raw request would show a price the reserve then disagrees with.
 */
function billableSeconds(model: MediaModelInfo, requestedSec: number): number {
  const d = model.contract.duration;
  if (!d) return requestedSec;
  const secs = Math.min(Math.max(Math.round(requestedSec), d.minSec), d.maxSec);
  if (!d.allowedSec?.length) return secs;
  const atOrBelow = d.allowedSec.filter((v) => v <= secs);
  return atOrBelow.length ? Math.max(...atOrBelow) : Math.min(...d.allowedSec);
}

/**
 * Mirror of the backend `estimateMediaCredits`, branch for branch, so the number
 * shown BEFORE the click is the number reserved after it. Seedance 2.5 at 720p is
 * ~48 credits/second — a 5-second clip is ~240 — and nobody may discover that
 * afterwards.
 *
 * The server stays authoritative (it reserves, then trues up against the
 * provider's actual duration); this is only what the user is quoted.
 */
export function estimateMediaCredits(model: MediaModelInfo, opts: MediaEstimateOpts = {}): number {
  // `tiers` carries deviations only, so a miss — including the model's own
  // default tier — correctly falls back to the model's base rate.
  const rate: MediaRate = (opts.resolution && model.tiers?.[opts.resolution]) || model;
  const units = meteredUnits(model, opts);

  // A metered model bills on the metered quantity, never on a requested length
  // it has no input for: VEED's avatar has no duration field, so its seconds are
  // its script's. With no script yet this falls through to the model's base
  // rate, which is what `meteredQuantityMissing` exists to stop the panel from
  // showing as if it were a price.
  const seconds = units !== null
    ? units
    : billableSeconds(model, Math.max(1, opts.durationSec ?? DEFAULT_DURATION_SEC));

  if (rate.creditsPerKChar !== undefined) {
    const chars = Math.max(1, opts.textLength ?? DEFAULT_TEXT_LENGTH);
    return Math.max(1, Math.ceil((rate.creditsPerKChar * chars) / 1000));
  }
  if (rate.creditsPerMinute !== undefined) {
    return Math.max(1, rate.creditsPerMinute * Math.max(1, Math.ceil(seconds / 60)));
  }
  if (rate.creditsPerSec !== undefined) return Math.max(1, Math.ceil(rate.creditsPerSec * seconds));
  return Math.max(1, rate.credits ?? FALLBACK_IMAGE_CREDITS);
}

/**
 * True when the model bills on a metered quantity that is not there yet — in
 * practice, an avatar whose script has not been written.
 *
 * `estimateMediaCredits` still returns a number in that state (the model's base
 * rate), but that number is not the price: VEED at a flat 5 credits is what a
 * one-minute read used to be quoted at against $0.35 of actual spend. The panel
 * says what is missing instead, and the server refuses the generation for the
 * same reason, so the two agree about when there is no price yet.
 */
export function meteredQuantityMissing(model: MediaModelInfo, opts: MediaEstimateOpts): boolean {
  return Boolean(model.contract.sourceMetering) && meteredUnits(model, opts) === null;
}

export const generateMedia = (p: GenerateMediaPayload): Promise<{ assetId: string }> =>
  marketingApi.post('/ai/media/generate', p).then((r) => r.data);

export const listGenerations = (f: GenerationFilters = {}): Promise<GeneratedAsset[]> =>
  marketingApi.get('/ai/media/generations', { params: f }).then((r) => r.data);

export const getGeneration = (id: string): Promise<GeneratedAsset> =>
  marketingApi.get(`/ai/media/generations/${id}`).then((r) => r.data);

export const regenerateMedia = (id: string): Promise<{ assetId: string }> =>
  marketingApi.post(`/ai/media/generations/${id}/regenerate`).then((r) => r.data);

export const deleteGeneration = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/ai/media/generations/${id}`).then((r) => r.data);

/** Polling stop condition — true once the asset will not change again. */
export const isTerminal = (s: GeneratedAssetStatus): boolean =>
  s === 'READY' || s === 'FAILED' || s === 'BLOCKED';

export interface UploadedMedia {
  url: string;
  key?: string;
  mime?: string;
}

/**
 * Upload a file to use as a SOURCE for an edit/animate/lipsync generation.
 *
 * Deliberately the planner's own media endpoint, which the post composer already
 * posts to: same R2 bucket, same 100 MB cap, same `campaigns.send` permission. A
 * second uploader would only be a second set of limits to keep in sync. It
 * accepts image/* and video/* ONLY — an audio source has to come from the library
 * (a VOICE or MUSIC generation) or from a link.
 */
export const uploadSourceMedia = (file: File): Promise<UploadedMedia> => {
  const fd = new FormData();
  fd.append('file', file);
  return marketingApi
    .post('/social-planner/media', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    .then((r) => r.data);
};
