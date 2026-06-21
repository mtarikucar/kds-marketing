/**
 * trigger-links.service.ts — standalone trigger links (GHL parity). A trackable
 * short link that 302s to a target and fires a link.clicked workflow trigger per
 * click. `url` is the public click URL (what the QR encodes and the UI copies).
 */

import marketingApi from './marketingApi';

export interface TriggerLink {
  id: string;
  name: string;
  slug: string;
  targetUrl: string;
  clickCount: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerLinkPayload {
  name: string;
  targetUrl: string;
  slug?: string;
}

export interface TriggerLinkStats extends TriggerLink {
  recent: { id: string; leadId: string | null; clickedAt: string }[];
}

export const listTriggerLinks = (): Promise<TriggerLink[]> =>
  marketingApi.get('/trigger-links').then((r) => r.data);

export const getTriggerLinkStats = (id: string): Promise<TriggerLinkStats> =>
  marketingApi.get(`/trigger-links/${id}/stats`).then((r) => r.data);

export const createTriggerLink = (payload: TriggerLinkPayload): Promise<TriggerLink> =>
  marketingApi.post('/trigger-links', payload).then((r) => r.data);

export const updateTriggerLink = (
  id: string,
  payload: Partial<TriggerLinkPayload>,
): Promise<TriggerLink> => marketingApi.patch(`/trigger-links/${id}`, payload).then((r) => r.data);

export const deleteTriggerLink = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/trigger-links/${id}`).then((r) => r.data);

/** Download the QR PNG for a link. */
export async function downloadTriggerLinkQr(id: string, slug: string): Promise<void> {
  const res = await marketingApi.get(`/trigger-links/${id}/qr.png`, { responseType: 'blob' });
  const url = URL.createObjectURL(new Blob([res.data], { type: 'image/png' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `qr-${slug}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
