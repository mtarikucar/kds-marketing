/**
 * personas.service.ts — typed service for UGC video personas + shot-plan
 * preview (Faz 2). Thin wrappers over `marketingApi`.
 */
import marketingApi from './marketingApi';

export interface VideoPersona {
  id: string;
  name: string;
  description: string | null;
  referenceImageUrls: string[];
  lockedSeed: number | null;
  voiceId: string | null;
  status: string;
  createdAt: string;
}

export interface CreatePersonaPayload {
  name: string;
  description?: string;
  referenceImageUrls?: string[];
  lockedSeed?: number;
}

export type VideoModel = 'seedance' | 'veo' | 'kling' | 'higgsfield';

export interface Shot {
  ord: number;
  scene: string;
  voiceover: string;
  prompt: string;
  durationSec: number;
  cameraNote: string;
  reference?: { images: string[]; seed?: number };
}

export interface ShotPlan {
  model: VideoModel;
  durationSec: number;
  shots: Shot[];
  captionSuggestion: string;
  qcChecklist: string[];
}

export interface PlanShotsPayload {
  brief: { product: string; hook?: string; offer?: string; durationSec?: 15 | 30 | 45; tone?: string; audience?: string };
  model?: VideoModel;
  personaId?: string;
}

export const listPersonas = () => marketingApi.get<VideoPersona[]>('/personas').then((r) => r.data);
export const createPersona = (payload: CreatePersonaPayload) => marketingApi.post<VideoPersona>('/personas', payload).then((r) => r.data);
export const planShots = (payload: PlanShotsPayload) => marketingApi.post<ShotPlan>('/personas/plan', payload).then((r) => r.data);
