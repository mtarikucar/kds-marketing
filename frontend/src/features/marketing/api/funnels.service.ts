/**
 * funnels.service.ts — multi-step page funnels (GoHighLevel parity). A funnel is
 * an ordered sequence of SitePages served as one published flow at
 * /api/public/funnel/:ws/:slug/:step.
 */

import marketingApi from './marketingApi';

export interface FunnelStep {
  sitePageId: string;
  name?: string;
}

export interface Funnel {
  id: string;
  name: string;
  slug: string;
  steps: FunnelStep[];
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FunnelPayload {
  name: string;
  slug?: string;
  steps?: FunnelStep[];
  published?: boolean;
}

export const listFunnels = (): Promise<Funnel[]> =>
  marketingApi.get('/funnels').then((r) => r.data);

export const createFunnel = (payload: FunnelPayload): Promise<Funnel> =>
  marketingApi.post('/funnels', payload).then((r) => r.data);

export const updateFunnel = (id: string, payload: FunnelPayload): Promise<Funnel> =>
  marketingApi.patch(`/funnels/${id}`, payload).then((r) => r.data);

export const deleteFunnel = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/funnels/${id}`).then((r) => r.data);
