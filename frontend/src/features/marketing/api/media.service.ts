/**
 * media.service.ts — typed API for AI Content Studio media generation
 * (spec §8). Paths are relative to /marketing.
 */
import marketingApi from './marketingApi';

export type GeneratedAssetType = 'IMAGE' | 'VIDEO';
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
  aspectRatio?: '1:1' | '9:16' | '16:9' | '4:5';
  durationSec?: number;
}

export interface GenerationFilters {
  type?: GeneratedAssetType;
  status?: GeneratedAssetStatus;
  campaignId?: string;
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
