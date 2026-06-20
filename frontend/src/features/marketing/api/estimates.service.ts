/**
 * estimates.service.ts — typed service layer for Estimates / quotes (GHL
 * parity). Thin wrappers over `marketingApi`. Line-item `unitPrice` and `total`
 * are in MINOR units (kuruş/cents) to match the backend / invoices.
 */

import marketingApi from './marketingApi';

export type EstimateStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';

export interface EstimateItem {
  description: string;
  qty: number;
  unitPrice: number; // minor units
}

export interface Estimate {
  id: string;
  leadId: string | null;
  number: string;
  items: EstimateItem[];
  currency: string;
  total: number; // minor units
  notes: string | null;
  validUntil: string | null;
  status: EstimateStatus;
  convertedInvoiceId: string | null;
  createdAt: string;
}

export interface EstimatePayload {
  leadId?: string;
  items: EstimateItem[];
  currency?: string;
  notes?: string;
  validUntil?: string;
}

export const listEstimates = (): Promise<Estimate[]> =>
  marketingApi.get('/estimates').then((r) => r.data);

export const getEstimate = (id: string): Promise<Estimate> =>
  marketingApi.get(`/estimates/${id}`).then((r) => r.data);

export const createEstimate = (payload: EstimatePayload): Promise<Estimate> =>
  marketingApi.post('/estimates', payload).then((r) => r.data);

export const updateEstimate = (id: string, payload: EstimatePayload): Promise<Estimate> =>
  marketingApi.patch(`/estimates/${id}`, payload).then((r) => r.data);

export const sendEstimate = (id: string): Promise<{ status: string; publicToken: string }> =>
  marketingApi.post(`/estimates/${id}/send`).then((r) => r.data);

export const acceptEstimate = (id: string): Promise<Estimate> =>
  marketingApi.post(`/estimates/${id}/accept`).then((r) => r.data);

export const declineEstimate = (id: string): Promise<Estimate> =>
  marketingApi.post(`/estimates/${id}/decline`).then((r) => r.data);

export const convertEstimate = (id: string): Promise<{ id: string; number: string }> =>
  marketingApi.post(`/estimates/${id}/convert`).then((r) => r.data);

export const deleteEstimate = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/estimates/${id}`).then((r) => r.data);
