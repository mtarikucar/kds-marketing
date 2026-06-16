/**
 * Domain event types an outbound webhook endpoint may subscribe to.
 * Mirrors `WEBHOOK_EVENTS` in backend webhook-outbound.service.ts — the backend
 * rejects any event not in this set, so the form must offer exactly these.
 */
export const WEBHOOK_EVENTS = [
  'marketing.lead.created.v1',
  'marketing.lead.converted.v1',
  'marketing.lead.merged.v1',
  'marketing.lead.customField.changed.v1',
  'marketing.lead.tag.added.v1',
  'marketing.lead.tag.removed.v1',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
