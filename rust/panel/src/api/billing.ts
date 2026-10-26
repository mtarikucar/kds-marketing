import { request } from './client';
import type { PlatformEntitlement, WorkspaceStatus } from './types';

export interface Payment {
  id: string; reported_at: string; amount_minor: number; currency: string;
  paid_at: string; confirmed: boolean;
}
export interface BillingStatus {
  workspace_status: WorkspaceStatus; entitlement: PlatformEntitlement | null;
  payment: Payment | null; price_minor: number; price_currency: string;
  bank_instructions: string; payment_reference: string;
}
export interface ReportPayment {
  reference: string; amount_minor: number; paid_at: string; request_key: string;
}
/** Reference-bearing responses belong only to the mounted page. */
export function getBilling(signal?: AbortSignal): Promise<BillingStatus> {
  return request('GET', '/api/billing', { signal });
}
export function reportPayment(input: ReportPayment, signal?: AbortSignal): Promise<Payment> {
  const { reference, amount_minor, paid_at, request_key } = input;
  return request('POST', '/api/billing/payments', { body: { reference, amount_minor, paid_at, request_key }, signal });
}
/** Call directly, never through a mutation cache: variables would retain the code. */
export function activateBilling(code: string, signal?: AbortSignal): Promise<BillingStatus> {
  return request('POST', '/api/billing/activate', { body: { code }, signal });
}
