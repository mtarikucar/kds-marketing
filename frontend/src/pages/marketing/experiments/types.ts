// Shapes mirror the marketing backend affiliate controllers. Decimal money
// values arrive as strings over JSON. (The Experiments/Surveys types that used
// to live here died with those features — 2026-07 system trim.)

export type CommissionType = 'PERCENT' | 'FLAT';
export type AffiliateStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';

export interface Affiliate {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  code: string;
  commissionType: CommissionType;
  commissionValue: string | number;
  status: AffiliateStatus;
  createdAt: string;
  updatedAt: string;
}

export type ReferralStatus = 'PENDING' | 'CONVERTED' | 'REJECTED';

export interface AffiliateReferral {
  id: string;
  workspaceId: string;
  affiliateId: string;
  referredLeadId?: string | null;
  status: ReferralStatus;
  convertedAt?: string | null;
  createdAt: string;
}

export type CommissionStatus = 'OWED' | 'APPROVED' | 'PAID';

export interface AffiliateCommission {
  id: string;
  workspaceId: string;
  affiliateId: string;
  referralId: string;
  amount: string | number;
  status: CommissionStatus;
  createdAt: string;
  updatedAt: string;
}
