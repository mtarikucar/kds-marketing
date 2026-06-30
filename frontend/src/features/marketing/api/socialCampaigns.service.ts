/**
 * socialCampaigns.service.ts — Social Campaign / content-calendar engine
 * (AI Social Content Studio §8). Typed client over marketingApi; all paths
 * are relative to /marketing. Server state is consumed via react-query.
 */
import marketingApi from './marketingApi';

export type SocialCampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type SocialCampaignAutomationMode = 'APPROVAL' | 'SEMI_AUTO' | 'FULL_AUTO';
export type SocialCampaignPlanningMode = 'AI_PROPOSE' | 'AI_FULL' | 'USER_TOPICS';
export type SocialCampaignItemStatus =
  | 'PLANNED'
  | 'GENERATING'
  | 'NEEDS_APPROVAL'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'FAILED'
  | 'SKIPPED';

export interface SocialCampaignCadence {
  perWeek: number;
  daysOfWeek: number[]; // 0=Sun … 6=Sat
  timeOfDay: string;    // 'HH:mm'
  timezone: string;     // IANA tz
}

export interface SocialCampaignBrief {
  audience?: string;
  keyMessages?: string[];
  languages?: string[];
  productRefs?: string[];
}

export interface SocialCampaign {
  id: string;
  name: string;
  goal: string | null;
  theme: string | null;
  brief: SocialCampaignBrief;
  status: SocialCampaignStatus;
  automationMode: SocialCampaignAutomationMode;
  planningMode: SocialCampaignPlanningMode;
  cadence: SocialCampaignCadence;
  startDate: string;
  endDate: string | null;
  targetAccountIds: string[];
  mediaKinds: string[];
  dailyPublishCap: number;
  linkedCampaignId: string | null;
  linkedAdCampaignId: string | null;
  stats: Record<string, number> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialCampaignPayload {
  name: string;
  goal?: string;
  theme?: string;
  brief?: SocialCampaignBrief;
  automationMode: SocialCampaignAutomationMode;
  planningMode: SocialCampaignPlanningMode;
  cadence: SocialCampaignCadence;
  startDate: string;
  endDate?: string;
  targetAccountIds: string[];
  mediaKinds: string[];
  dailyPublishCap?: number;
  linkedCampaignId?: string;
}

export interface SocialCampaignItem {
  id: string;
  socialCampaignId: string;
  sequenceIndex: number;
  scheduledFor: string;
  status: SocialCampaignItemStatus;
  topic: string | null;
  socialPostId: string | null;
  generatedAssetIds: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listSocialCampaigns = (): Promise<SocialCampaign[]> =>
  marketingApi.get('/social-campaigns').then((r) => r.data);

export const getSocialCampaign = (id: string): Promise<SocialCampaign> =>
  marketingApi.get(`/social-campaigns/${id}`).then((r) => r.data);

export const createSocialCampaign = (payload: SocialCampaignPayload): Promise<SocialCampaign> =>
  marketingApi.post('/social-campaigns', payload).then((r) => r.data);

export const updateSocialCampaign = (
  id: string,
  payload: Partial<SocialCampaignPayload>,
): Promise<SocialCampaign> =>
  marketingApi.patch(`/social-campaigns/${id}`, payload).then((r) => r.data);

export const setCampaignLifecycle = (
  id: string,
  action: 'activate' | 'pause' | 'resume' | 'cancel',
): Promise<SocialCampaign> =>
  marketingApi.post(`/social-campaigns/${id}/${action}`).then((r) => r.data);

export const listSocialCampaignItems = (id: string): Promise<SocialCampaignItem[]> =>
  marketingApi.get(`/social-campaigns/${id}/items`).then((r) => r.data);

export const confirmSocialCampaignPlan = (id: string): Promise<{ message: string }> =>
  marketingApi.post(`/social-campaigns/${id}/plan/confirm`).then((r) => r.data);

export const reviewSocialCampaignItem = (
  itemId: string,
  action: 'approve' | 'reject' | 'regenerate',
): Promise<SocialCampaignItem> =>
  marketingApi.post(`/social-campaigns/items/${itemId}/${action}`).then((r) => r.data);
