// Shapes mirror the marketing backend (experiments / surveys / affiliate
// controllers). Decimal money values arrive as strings over JSON.

export interface ExperimentVariant {
  key: string;
  label?: string;
  weight?: number;
  blocks?: unknown;
}

export interface Experiment {
  id: string;
  workspaceId: string;
  name: string;
  pageId?: string | null;
  variants: ExperimentVariant[];
  status: 'DRAFT' | 'RUNNING' | 'STOPPED';
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentResult {
  variantKey: string;
  impressions: number;
  conversions: number;
  conversionRate: number;
}

export interface SurveyQuestion {
  key: string;
  label: string;
  type: 'TEXT' | 'TEXTAREA' | 'SINGLE' | 'MULTIPLE' | 'RATING';
  required?: boolean;
  options?: string[];
}

export interface Survey {
  id: string;
  workspaceId: string;
  name: string;
  questions: SurveyQuestion[];
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  redirectUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SurveyResponse {
  id: string;
  surveyId: string;
  workspaceId: string;
  leadId?: string | null;
  answers: Record<string, unknown>;
  createdAt: string;
}

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
