/**
 * tax-rates.service.ts — reusable per-workspace tax rates (GHL parity, KDV/VAT).
 * `rate` is a percentage (20 = 20%), applied exclusively on invoice/estimate lines.
 */

import marketingApi from './marketingApi';

export interface TaxRate {
  id: string;
  name: string;
  rate: string | number; // Prisma Decimal serializes as string
  isDefault: boolean;
  archived: boolean;
  createdAt: string;
}

export interface TaxRatePayload {
  name: string;
  rate: number;
  isDefault?: boolean;
}

export const listTaxRates = (): Promise<TaxRate[]> =>
  marketingApi.get('/tax-rates').then((r) => r.data);

export const createTaxRate = (payload: TaxRatePayload): Promise<TaxRate> =>
  marketingApi.post('/tax-rates', payload).then((r) => r.data);

export const updateTaxRate = (id: string, payload: Partial<TaxRatePayload>): Promise<TaxRate> =>
  marketingApi.patch(`/tax-rates/${id}`, payload).then((r) => r.data);

export const deleteTaxRate = (id: string): Promise<TaxRate> =>
  marketingApi.delete(`/tax-rates/${id}`).then((r) => r.data);
