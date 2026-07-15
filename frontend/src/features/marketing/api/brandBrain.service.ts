/** brandBrain.service.ts — cited retrieval over the knowledge base (Faz 1). */
import marketingApi from './marketingApi';

export interface Citation {
  chunkId: string;
  docId: string;
  docTitle: string;
  snippet: string;
  score: number;
}

export const searchBrandBrain = (query: string, k = 5) =>
  marketingApi.post<Citation[]>('/brand-brain/search', { query, k }).then((r) => r.data);

export const reindexBrandBrain = () =>
  marketingApi.post<{ docs: number; chunks: number }>('/brand-brain/reindex').then((r) => r.data);

/**
 * BrandProfile — the single consolidated brand profile that grounds every AI
 * (conversation, content, social, voice, research). Only an ACTIVE profile
 * grounds the AI; DRAFT is saved but inert.
 */
export interface BrandProfile {
  id: string;
  brandName: string;
  tagline?: string | null;
  description?: string | null;
  valueProps?: string[] | null;
  toneWords?: string[] | null;
  voiceGuide?: string | null;
  icpDescription?: string | null;
  audienceObjections?: string[] | null;
  status: 'DRAFT' | 'ACTIVE';
}

export type BrandProfilePayload = Partial<Omit<BrandProfile, 'id'>>;

export const getBrandProfile = () =>
  marketingApi.get<BrandProfile | null>('/brand-brain/profile').then((r) => r.data);

export const putBrandProfile = (p: BrandProfilePayload) =>
  marketingApi.put<BrandProfile>('/brand-brain/profile', p).then((r) => r.data);
