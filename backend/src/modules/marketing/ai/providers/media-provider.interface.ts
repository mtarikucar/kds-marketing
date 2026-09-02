import { GeneratedAssetType } from '../media/media-asset.constants';

/**
 * Source media the caller supplies, keyed by ROLE rather than by wire name.
 * Which parameter each role lands in is the model's business (image_url vs
 * image_urls vs start_image_url vs video_url…), and that mapping lives in the
 * catalogue's input contract — never in the caller.
 */
export interface MediaGenSources {
  /** Reference/edit images. A model wanting one image reads images[0]. */
  images?: string[];
  /** Closing frame for a transition or an A→B animate. */
  lastImage?: string;
  video?: string;
  audio?: string;
  /** Inpainting mask. */
  mask?: string;
}

export interface MediaGenSubmit {
  type: GeneratedAssetType;
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  /** Wire resolution value ('720p', '4k', '2K', '1024x1024' — casing matters). */
  resolution?: string;
  durationSec?: number;
  /** Native synchronised audio, where the model produces it. */
  generateAudio?: boolean;
  sources?: MediaGenSources;
  /** Catalogue-declared enum choices (TTS voice/language, stock avatar id). */
  voice?: string;
  language?: string;
  avatar?: string;
  seed?: number;
  webhookUrl?: string;
}

export interface MediaGenOutput {
  url: string;
  mime: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export type MediaGenStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'BLOCKED';

export interface MediaGenResult {
  status: MediaGenStatus;
  outputs?: MediaGenOutput[];
  error?: string;
}

export interface MediaProvider {
  readonly name: string;
  isConfigured(): boolean;
  submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }>;
  getResult(requestId: string, model: string): Promise<MediaGenResult>;
}

export const MEDIA_PROVIDER = 'MEDIA_PROVIDER';
