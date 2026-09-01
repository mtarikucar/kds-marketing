import marketingApi from './marketingApi';

/**
 * The workspace's default image / video generation model, and the PRICED
 * catalogue to choose from.
 *
 * `GET`/`PATCH marketing/workspaces/media-models` — MANAGER + `settings.manage`,
 * both sides audited (a save here can multiply what every generated clip costs).
 *
 * The catalogue is SERVED, not hardcoded here, and that is the point of the
 * endpoint existing. `AiStudioPage.tsx` already carries a hand-maintained copy
 * of the model list; it has drifted from the backend's labels and it shows no
 * price at all. Video is the most expensive action in this product, so the
 * number is the decision — a second place to forget to update it is how the
 * number goes stale.
 */
export type MediaModelType = 'IMAGE' | 'VIDEO';

export interface PricedMediaModel {
  id: string;
  type: MediaModelType;
  label: string;
  /** IMAGE: flat, per image. */
  priceUsd?: number;
  credits?: number;
  /** VIDEO: per second of clip. */
  pricePerSecUsd?: number;
  creditsPerSec?: number;
  /** The model the platform falls back to when the workspace has chosen none. */
  isPlatformDefault: boolean;
}

export interface MediaModelDefaults {
  /** The workspace's CHOICE. `null` = it has not made one. */
  defaultImageModel: string | null;
  defaultVideoModel: string | null;
  /** What would actually run today: the choice, or the platform constant. */
  effectiveImageModel: string;
  effectiveVideoModel: string;
  models: PricedMediaModel[];
}

/** Absent = leave alone. `null` = clear back to the platform default. */
export interface MediaModelDefaultsPatch {
  defaultImageModel?: string | null;
  defaultVideoModel?: string | null;
}

export const getMediaModelDefaults = (): Promise<MediaModelDefaults> =>
  marketingApi.get('/workspaces/media-models').then((r) => r.data);

export const setMediaModelDefaults = (
  patch: MediaModelDefaultsPatch,
): Promise<MediaModelDefaults> =>
  marketingApi.patch('/workspaces/media-models', patch).then((r) => r.data);
