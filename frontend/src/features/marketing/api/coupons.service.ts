/**
 * coupons.service.ts — discount coupons (GHL parity). PERCENT (value 1–100) or
 * FIXED (value = minor units off). The discount is always resolved server-side.
 */

import marketingApi from './marketingApi';

export interface Coupon {
  id: string;
  code: string;
  kind: 'PERCENT' | 'FIXED';
  value: number;
  currency: string | null;
  minSubtotal: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface CouponPayload {
  code: string;
  kind: 'PERCENT' | 'FIXED';
  value: number;
  currency?: string;
  minSubtotal?: number;
  maxRedemptions?: number;
  startsAt?: string;
  expiresAt?: string;
  active?: boolean;
}

export const listCoupons = (): Promise<Coupon[]> =>
  marketingApi.get('/coupons').then((r) => r.data);

export const createCoupon = (payload: CouponPayload): Promise<Coupon> =>
  marketingApi.post('/coupons', payload).then((r) => r.data);

export const updateCoupon = (id: string, payload: Partial<CouponPayload>): Promise<Coupon> =>
  marketingApi.patch(`/coupons/${id}`, payload).then((r) => r.data);

export const deleteCoupon = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/coupons/${id}`).then((r) => r.data);
