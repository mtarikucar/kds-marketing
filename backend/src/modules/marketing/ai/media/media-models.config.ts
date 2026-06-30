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

export const DEFAULT_IMAGE_MODEL = 'fal-ai/bytedance/seedream/v4';
export const DEFAULT_VIDEO_MODEL = 'fal-ai/kling-video/v2.1/standard';

/**
 * fal.ai model catalog (verified at implementation time). Credits are the
 * customer-facing meter; prices are USD bookkeeping. ~1 credit ≈ $0.01 of
 * generation spend, rounded up so we never under-charge.
 */
export const MEDIA_MODELS: Record<string, MediaModel> = {
  'fal-ai/qwen-image': { id: 'fal-ai/qwen-image', type: 'IMAGE', label: 'Draft image', priceUsd: 0.02, credits: 2 },
  'fal-ai/bytedance/seedream/v4': { id: 'fal-ai/bytedance/seedream/v4', type: 'IMAGE', label: 'Final image', priceUsd: 0.03, credits: 3 },
  'fal-ai/kling-video/v2.1/standard': { id: 'fal-ai/kling-video/v2.1/standard', type: 'VIDEO', label: 'Short video', pricePerSecUsd: 0.025, creditsPerSec: 3 },
  'fal-ai/bytedance/seedance/v1/pro': { id: 'fal-ai/bytedance/seedance/v1/pro', type: 'VIDEO', label: 'Premium video', pricePerSecUsd: 0.15, creditsPerSec: 15 },
  'fal-ai/veo3/fast': { id: 'fal-ai/veo3/fast', type: 'VIDEO', label: 'Video + audio', pricePerSecUsd: 0.25, creditsPerSec: 25 },
};

const FALLBACK_IMAGE_CREDITS = 3;

export function getMediaModel(id: string): MediaModel | undefined {
  return MEDIA_MODELS[id];
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
