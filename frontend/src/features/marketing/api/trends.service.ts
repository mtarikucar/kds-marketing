/** trends.service.ts — Trend → Remix (Faz 4). Thin wrappers over marketingApi. */
import marketingApi from './marketingApi';

export type TrendPlatform = 'TIKTOK' | 'INSTAGRAM' | 'YOUTUBE';

export interface TrendTemplate {
  id: string;
  sourcePlatform: TrendPlatform;
  sourceUrl: string | null;
  title: string | null;
  hookPattern: string | null;
  pacingNote: string | null;
  captionPattern: string | null;
  riskScore: number;
  status: string;
  createdAt: string;
}

export interface SaveTrendPayload {
  sourcePlatform: TrendPlatform;
  sourceUrl?: string;
  title?: string;
  hookPattern?: string;
  captionPattern?: string;
  riskScore?: number;
}

export interface Brand {
  name: string;
  product?: string;
  audience?: string;
  tone?: string;
  valueProps?: string[];
}

export interface RemixBrief {
  sourcePlatform: string;
  hook: string;
  scenes: { scene: string; direction: string }[];
  pacingNote?: string;
  captionDraft: string;
  complianceNote: string;
}

export const listTrends = () => marketingApi.get<TrendTemplate[]>('/trends').then((r) => r.data);
export const saveTrend = (payload: SaveTrendPayload) => marketingApi.post<TrendTemplate>('/trends', payload).then((r) => r.data);
export const remixTrend = (id: string, brand: Brand) => marketingApi.post<RemixBrief>(`/trends/${id}/remix`, { brand }).then((r) => r.data);
