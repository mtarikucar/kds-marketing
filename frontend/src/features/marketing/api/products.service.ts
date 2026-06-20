/**
 * products.service.ts — typed service layer for the Products catalog (GHL
 * parity). Thin, typed wrappers over `marketingApi`; React Query hooks call
 * these. Mirrors the leads.service / opportunities.service convention.
 */

import marketingApi from './marketingApi';
import type { PaginatedResponse } from '../types';

export type BillingType = 'ONE_TIME' | 'RECURRING';
export type BillingInterval = 'MONTH' | 'YEAR';

export interface Product {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  price: string | number;
  currency: string;
  billingType: BillingType;
  interval: BillingInterval | null;
  taxRate: string | number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductPayload {
  name: string;
  description?: string;
  sku?: string;
  price?: number;
  currency?: string;
  billingType?: BillingType;
  interval?: BillingInterval;
  taxRate?: number;
  active?: boolean;
}

export interface ProductListParams {
  search?: string;
  billingType?: string;
  active?: boolean;
  page?: number;
  limit?: number;
}

export const listProducts = (
  params: ProductListParams = {},
): Promise<PaginatedResponse<Product>> =>
  marketingApi.get('/products', { params }).then((r) => r.data);

export const createProduct = (payload: ProductPayload): Promise<Product> =>
  marketingApi.post('/products', payload).then((r) => r.data);

export const updateProduct = (id: string, payload: ProductPayload): Promise<Product> =>
  marketingApi.patch(`/products/${id}`, payload).then((r) => r.data);

export const archiveProduct = (id: string): Promise<Product> =>
  marketingApi.post(`/products/${id}/archive`).then((r) => r.data);

export const deleteProduct = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/products/${id}`).then((r) => r.data);
