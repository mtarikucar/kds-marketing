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
