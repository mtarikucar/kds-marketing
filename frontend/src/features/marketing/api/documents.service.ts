/**
 * documents.service.ts — typed service layer for e-signature Documents /
 * contracts (GHL parity). The signing token is NOT in the list/get payload (it's
 * the signing capability); it comes back only from the manager-gated send().
 */

import marketingApi from './marketingApi';

export type DocumentStatus = 'DRAFT' | 'SENT' | 'SIGNED' | 'DECLINED' | 'VOIDED';

export interface MarketingDocument {
  id: string;
  leadId: string | null;
  type: string;
  title: string;
  status: DocumentStatus;
  signerName: string | null;
  signedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  body?: string; // only on GET :id (detail)
}

export interface DocumentPayload {
  leadId?: string;
  type?: string;
  title: string;
  body: string;
}

export const listDocuments = (): Promise<MarketingDocument[]> =>
  marketingApi.get('/documents').then((r) => r.data);

export const getDocument = (id: string): Promise<MarketingDocument> =>
  marketingApi.get(`/documents/${id}`).then((r) => r.data);

export const createDocument = (payload: DocumentPayload): Promise<MarketingDocument> =>
  marketingApi.post('/documents', payload).then((r) => r.data);

export const updateDocument = (
  id: string,
  payload: Partial<DocumentPayload>,
): Promise<MarketingDocument> =>
  marketingApi.patch(`/documents/${id}`, payload).then((r) => r.data);

/** Sends (or, for an already-SENT doc, idempotently re-returns) the public token. */
export const sendDocument = (id: string): Promise<{ status: string; publicToken: string }> =>
  marketingApi.post(`/documents/${id}/send`).then((r) => r.data);

export const voidDocument = (id: string): Promise<MarketingDocument> =>
  marketingApi.post(`/documents/${id}/void`).then((r) => r.data);

export const deleteDocument = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/documents/${id}`).then((r) => r.data);
