/**
 * order-forms.service.ts — typed service layer for public payment-enabled Order
 * Forms (GHL parity). The publicToken is a shareable marketing link (safe to
 * surface), unlike the e-sign document token.
 */

import marketingApi from './marketingApi';

export interface OrderForm {
  id: string;
  name: string;
  productId: string | null;
  currency: string;
  active: boolean;
  publicToken: string;
  createdAt: string;
}

/**
 * Full record from GET /order-forms/:id — the list endpoint selects a summary
 * that omits `collectPhone`/`phoneRequired`/`notes`, so the edit dialog must
 * fetch this to avoid resetting those settings to defaults on save.
 */
export interface OrderFormDetail extends OrderForm {
  collectPhone: boolean;
  phoneRequired: boolean;
  notes: string | null;
}

export interface OrderFormPayload {
  name: string;
  productId?: string;
  currency?: string;
  collectPhone?: boolean;
  phoneRequired?: boolean;
  notes?: string;
  active?: boolean;
}

export const listOrderForms = (): Promise<OrderForm[]> =>
  marketingApi.get('/order-forms').then((r) => r.data);

export const getOrderForm = (id: string): Promise<OrderFormDetail> =>
  marketingApi.get(`/order-forms/${id}`).then((r) => r.data);

export const createOrderForm = (payload: OrderFormPayload): Promise<OrderForm> =>
  marketingApi.post('/order-forms', payload).then((r) => r.data);

export const updateOrderForm = (
  id: string,
  payload: Partial<OrderFormPayload>,
): Promise<OrderForm> =>
  marketingApi.patch(`/order-forms/${id}`, payload).then((r) => r.data);

export const deleteOrderForm = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/order-forms/${id}`).then((r) => r.data);
