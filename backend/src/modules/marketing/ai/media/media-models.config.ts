import { GeneratedAssetType } from './media-asset.constants';

export interface MediaModel {
  id: string;
  type: GeneratedAssetType;
  label: string;
  /** Flat USD per image (image models). */
  priceUsd?: number;
  /** USD per second (video models). */
  pricePerSecUsd?: number;
  /** Flat credits per image (image models). */
  credits?: number;
  /** Credits per second (video models). */
  creditsPerSec?: number;
}

export const DEFAULT_IMAGE_MODEL = 'fal-ai/bytedance/seedream/v4/text-to-image';
export const DEFAULT_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1/lite/text-to-video';

/**
 * fal.ai model catalog. IDs are the EXACT queue.fal.run/{id} endpoint path —
 * fal serves each capability under a suffixed path (…/text-to-image,
 * …/text-to-video), so bare model paths (e.g. fal-ai/bytedance/seedream/v4)
 * 404. Kling v2.1 "standard" only exposes image-to-video, so the cheap video
 * tier uses Seedance 1.0 Lite (text-to-video) instead. Credits are the
 * customer-facing meter; prices are USD bookkeeping. ~1 credit ≈ $0.01 of
 * generation spend, rounded up so we never under-charge.
 */
export const MEDIA_MODELS: Record<string, MediaModel> = {
  'fal-ai/qwen-image': { id: 'fal-ai/qwen-image', type: 'IMAGE', label: 'Draft image', priceUsd: 0.02, credits: 2 },
  'fal-ai/bytedance/seedream/v4/text-to-image': { id: 'fal-ai/bytedance/seedream/v4/text-to-image', type: 'IMAGE', label: 'Final image', priceUsd: 0.03, credits: 3 },
  'fal-ai/bytedance/seedance/v1/lite/text-to-video': { id: 'fal-ai/bytedance/seedance/v1/lite/text-to-video', type: 'VIDEO', label: 'Short video', pricePerSecUsd: 0.025, creditsPerSec: 3 },
  'fal-ai/bytedance/seedance/v1/pro/text-to-video': { id: 'fal-ai/bytedance/seedance/v1/pro/text-to-video', type: 'VIDEO', label: 'Premium video', pricePerSecUsd: 0.15, creditsPerSec: 15 },
  'fal-ai/veo3/fast': { id: 'fal-ai/veo3/fast', type: 'VIDEO', label: 'Video + audio', pricePerSecUsd: 0.25, creditsPerSec: 25 },
};

const FALLBACK_IMAGE_CREDITS = 3;

export function getMediaModel(id: string): MediaModel | undefined {
  return MEDIA_MODELS[id];
}

/**
 * Is `id` in the catalogue AS a model of this kind?
 *
 * Stricter than `getMediaModel(id) !== undefined`, and the extra strictness is
 * the point. The catalogue is what prices a generation, and it prices the two
 * kinds in different UNITS — images flat per image, video per second. So an
 * IMAGE id accepted for a VIDEO request is not a cosmetic mislabel: it bills a
 * per-second clip at the flat 3-credit image rate, which is the same
 * under-charge the "unknown model" refusal was written to stop. Membership and
 * kind are one question, so they are one function.
 */
export function isCataloguedModel(id: string, type: GeneratedAssetType): boolean {
  return MEDIA_MODELS[id]?.type === type;
}

/** The code constant for a kind — the last term of the resolution order
 *  (campaign override ?? workspace default ?? THIS). */
export function defaultModelFor(type: GeneratedAssetType): string {
  return type === 'VIDEO' ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL;
}

export function estimateMediaCredits(modelId: string, durationSec?: number): number {
  const m = MEDIA_MODELS[modelId];
  if (!m) return FALLBACK_IMAGE_CREDITS;
  if (m.type === 'VIDEO') {
    const secs = Math.max(1, durationSec ?? 5);
    return Math.max(1, Math.ceil((m.creditsPerSec ?? 0) * secs));
  }
  return Math.max(1, m.credits ?? FALLBACK_IMAGE_CREDITS);
}

export function estimateMediaUsd(modelId: string, durationSec?: number): number {
  const m = MEDIA_MODELS[modelId];
  if (!m) return 0;
  if (m.type === 'VIDEO') return (m.pricePerSecUsd ?? 0) * Math.max(1, durationSec ?? 5);
  return m.priceUsd ?? 0;
}
