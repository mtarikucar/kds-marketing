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

/**
 * Brand-analysis extraction pipeline (first-login wizard, Faz 3). A run
 * crawls the given sources (website / social / GBP / uploads), synthesizes a
 * draft BrandProfile + research profile + brand-kit hints + knowledge docs,
 * and waits in READY_FOR_REVIEW until the operator applies or discards it.
 */
export interface BrandAnalysisDraft {
  profile: {
    brandName?: string;
    tagline?: string;
    description?: string;
    valueProps?: string[];
    toneWords?: string[];
    voiceGuide?: string;
    icpDescription?: string;
    audienceObjections?: string[];
    offerings?: Array<{ name: string; blurb?: string; price?: string }>;
    socialHandles?: Array<{ network: string; handle: string }>;
  };
  researchProfile: { icpDescription?: string; businessTypes?: string[]; geo?: { country?: string; regions?: string[]; cities?: string[] } };
  brandKitHints: { palette?: string[]; tone?: string; hashtags?: string[]; cta?: string };
  knowledgeDocs: Array<{ title: string; content: string }>;
}

export type BrandAnalysisStatus = 'QUEUED' | 'RUNNING' | 'READY_FOR_REVIEW' | 'APPLIED' | 'FAILED';

export interface BrandAnalysisRun {
  id: string;
  status: BrandAnalysisStatus;
  inputs: unknown;
  draft: BrandAnalysisDraft | null;
  costUsd?: number | null;
  error?: string | null;
}

export interface StartAnalysisInput {
  websiteUrl?: string;
  socialHandles?: Array<{ network: 'INSTAGRAM' | 'FACEBOOK' | 'LINKEDIN'; handle: string }>;
  gbpQuery?: string;
  uploadKeys?: string[];
}

export const startBrandAnalysis = (input: StartAnalysisInput) =>
  marketingApi.post<{ runId: string }>('/brand-brain/analyze', input).then((r) => r.data);

export const getBrandAnalysisRun = (id: string) =>
  marketingApi.get<BrandAnalysisRun>(`/brand-brain/run/${id}`).then((r) => r.data);

export const applyBrandAnalysis = (runId: string, draft?: BrandAnalysisDraft) =>
  marketingApi.post<{ applied: true }>('/brand-brain/apply', { runId, draft }).then((r) => r.data);
