/**
 * inbound-webhooks.service.ts — inbound webhooks (GHL parity). A public hook URL
 * an external system POSTs JSON to; each accepted call fires a `webhook.received`
 * workflow. `url` is the public POST endpoint the operator copies; `secret` is
 * returned exactly ONCE on create/rotate and never again.
 */

import marketingApi from './marketingApi';

export interface InboundWebhook {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  lastReceivedAt: string | null;
  receivedCount: number;
  createdAt: string;
  url: string;
}

/** create() and rotateSecret() additionally return the one-time raw secret. */
export interface InboundWebhookWithSecret extends InboundWebhook {
  secret: string;
}

export const listInboundWebhooks = (): Promise<InboundWebhook[]> =>
  marketingApi.get('/inbound-webhooks').then((r) => r.data);

export const createInboundWebhook = (name: string): Promise<InboundWebhookWithSecret> =>
  marketingApi.post('/inbound-webhooks', { name }).then((r) => r.data);

export const updateInboundWebhook = (
  id: string,
  payload: { name?: string; enabled?: boolean },
): Promise<InboundWebhook> =>
  marketingApi.patch(`/inbound-webhooks/${id}`, payload).then((r) => r.data);

export const rotateInboundWebhookSecret = (id: string): Promise<InboundWebhookWithSecret> =>
  marketingApi.post(`/inbound-webhooks/${id}/rotate-secret`).then((r) => r.data);

export const deleteInboundWebhook = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/inbound-webhooks/${id}`).then((r) => r.data);
