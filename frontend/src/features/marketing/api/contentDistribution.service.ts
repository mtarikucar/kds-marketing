import marketingApi from './marketingApi';

/**
 * The distribution plan for one published video: who to contact, what to tag,
 * when to cross-post — and the PREPARED, UNSENT messages a person sends one at
 * a time.
 *
 * `marketing/content-distribution/*`. Named `content-distribution` and not
 * `distribution` because `marketing/distribution-config` already exists and
 * means something entirely different (round-robin assignment of incoming
 * LEADS to reps).
 *
 * **There is no bulk send, here or anywhere.** `sendDistributionDraft` takes one
 * id, and the backend verifies that the caller is an active human of the
 * workspace before dispatching. That is the feature's whole design: automated
 * mass outreach to people who never asked to hear from us is what platform spam
 * detection catches, and the cost is a restricted account. If a future screen
 * wants a "send all" button, that is a product decision to reopen, not a loop
 * to write over this function.
 */
export type DistributionDraftStatus = 'DRAFT' | 'SENT' | 'DISMISSED' | 'FAILED';

export interface DistributionDraft {
  id: string;
  workspaceId: string;
  planId: string;
  campaignItemId: string;
  leadId: string;
  channelType: string;
  channelId: string;
  toAddress: string;
  body: string;
  status: DistributionDraftStatus;
  sentAt: string | null;
  sentById: string | null;
  conversationId: string | null;
  error: string | null;
}

export interface DistributionCrossPost {
  network: string;
  socialAccountId: string;
  accountName: string;
  runAt: string;
  note: string;
}

/** A part of the plan that could NOT be produced, and why. Never rendered as an
 *  empty list — an empty section reads as "nothing to distribute", which is the
 *  one thing this feature must never say. */
export interface DistributionGap {
  area: 'crossPost' | 'tags' | 'outreach';
  reason: string;
}

export interface DistributionPlanDocument {
  publishedNetworks: string[];
  crossPosts: DistributionCrossPost[];
  tags: {
    accounts: Array<{ socialAccountId: string; network: string; displayName: string }>;
    hashtags: string[];
  };
  outreachCount: number;
  gaps: DistributionGap[];
}

export interface DistributionPlan {
  id: string;
  campaignItemId: string;
  plan: DistributionPlanDocument;
  drafts: DistributionDraft[];
}

export const getDistributionPlan = (campaignItemId: string): Promise<DistributionPlan> =>
  marketingApi.get(`/content-distribution/${campaignItemId}`).then((r) => r.data);

export const planContentDistribution = (campaignItemId: string): Promise<DistributionPlan> =>
  marketingApi.post(`/content-distribution/${campaignItemId}/plan`).then((r) => r.data);

export const listDistributionDrafts = (
  params: { planId?: string; status?: DistributionDraftStatus } = {},
): Promise<DistributionDraft[]> =>
  marketingApi.get('/content-distribution/drafts', { params }).then((r) => r.data);

/** ONE draft, because ONE person said so. See the module docblock. */
export const sendDistributionDraft = (
  id: string,
  text?: string,
): Promise<{ draftId: string; conversationId: string; to: string; channel: string }> =>
  marketingApi.post(`/content-distribution/drafts/${id}/send`, { text }).then((r) => r.data);

export const dismissDistributionDraft = (id: string): Promise<DistributionDraft> =>
  marketingApi.post(`/content-distribution/drafts/${id}/dismiss`).then((r) => r.data);
