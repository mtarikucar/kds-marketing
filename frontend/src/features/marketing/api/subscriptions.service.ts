/**
 * subscriptions.service.ts — typed service layer for recurring customer
 * Subscriptions (GHL parity). Item `unitPrice` and `amount` are in MINOR units
 * (kuruş/cents), matching invoices/estimates.
 */

import marketingApi from './marketingApi';

export type BillingInterval = 'MONTH' | 'YEAR' | 'WEEK';
export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED';

export interface SubscriptionItem {
  description: string;
  qty: number;
  unitPrice: number; // minor units
}

export interface Subscription {
  id: string;
  name: string;
  leadId: string | null;
  amount: number; // minor units
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  status: SubscriptionStatus;
  nextBillingAt: string;
  lastBilledAt: string | null;
  invoicesGenerated: number;
  createdAt: string;
}

/**
 * Full record returned by GET /subscriptions/:id — the list endpoint omits
 * `items`, `dueDays` and `notes`, so the edit dialog must fetch this to avoid
 * replacing a plan's real line items (and its billed amount) with a blank draft.
 */
export interface SubscriptionDetail extends Subscription {
  items: SubscriptionItem[];
  dueDays: number;
  notes: string | null;
}

export interface SubscriptionPayload {
  name: string;
  items: SubscriptionItem[];
  leadId?: string;
  currency?: string;
  notes?: string;
  interval?: BillingInterval;
  intervalCount?: number;
  dueDays?: number;
  startAt?: string;
}

export const listSubscriptions = (): Promise<Subscription[]> =>
  marketingApi.get('/subscriptions').then((r) => r.data);

export const getSubscription = (id: string): Promise<SubscriptionDetail> =>
  marketingApi.get(`/subscriptions/${id}`).then((r) => r.data);

export const createSubscription = (payload: SubscriptionPayload): Promise<Subscription> =>
  marketingApi.post('/subscriptions', payload).then((r) => r.data);

export const updateSubscription = (
  id: string,
  payload: Partial<SubscriptionPayload>,
): Promise<Subscription> =>
  marketingApi.patch(`/subscriptions/${id}`, payload).then((r) => r.data);

export const pauseSubscription = (id: string): Promise<Subscription> =>
  marketingApi.post(`/subscriptions/${id}/pause`).then((r) => r.data);

export const resumeSubscription = (id: string): Promise<Subscription> =>
  marketingApi.post(`/subscriptions/${id}/resume`).then((r) => r.data);

export const cancelSubscription = (id: string): Promise<Subscription> =>
  marketingApi.post(`/subscriptions/${id}/cancel`).then((r) => r.data);
